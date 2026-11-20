/**
 * Changing the email service on a running install, in stages a person controls:
 *
 *   prepare   Sets up the new service, and asks it for each sending domain's records. The old
 *             service keeps sending, so people have as long as they need to publish them.
 *   cut over  Connects the new service's reports, moves the domains, starts warm-up again, then
 *             points the Workers at it. Reports from the old service still arrive for 14 days,
 *             because a complaint can come in long after the email went out.
 *   finish    After those 14 days, removes the old service's keys and DNS records.
 *   roll back Until then, goes back to the old service.
 *
 * It only touches what mail needs. It never makes new keyrings, runs migrations, uploads code or
 * creates accounts, and tests/mail-switch.test.ts holds it to that. New keyrings in particular
 * would make every encrypted subscriber field unreadable.
 */
import { randomBytes } from 'node:crypto';
import { checkRecord, dohLookup, type DnsLookup, type RecordState } from '@swarm/mail/dns-check';
import { HOLD_UNREGISTERED_SQL, REWARM_SQL, SWAP_DOMAINS_SQL } from '@swarm/mail/service-change';
import { varsFor, renderInput } from '../config/render';
import { upsertRecord, type WantedRecord } from '../cloudflare';
import {
  accountId,
  database,
  dnsApi,
  oauthApi,
  save,
  saveSecrets,
  zoneId,
  type Ctx,
} from '../context';
import { MAIL_SECRETS, MAIL_WORKERS, secretContext, secretNames, secretValueFor } from '../keys';
import { MailgunRest, mailgunZoneRecords } from '../mailgun';
import { scriptName, type Worker } from '../paths';
import { PostmarkRest, postmarkZoneRecords } from '../postmark';
import { ResendRest, resendZoneRecords } from '../resend';
import type { DnsRecordSpec, MailProvider, State } from '../state';
import { mail } from '../steps/mail';
import { afterDeploy } from '../steps/postdeploy';
import { mailChoice } from '../steps/prompts';
import { writeConfigs } from '../steps/render';
import { InstallError } from '../ui';

const DRAIN_MS = 14 * 86_400_000;

type MailChoice = NonNullable<State['choices']>['mail'];

/** A record as a sending domain keeps it, from the shape the DNS step writes. */
function asDomainRecord(record: WantedRecord) {
  const purpose = record.name.includes('._domainkey')
    ? 'dkim'
    : record.type === 'TXT'
      ? 'mail_from_spf'
      : 'mail_from_mx';
  return {
    purpose,
    type: record.type,
    name: record.name,
    value: record.content,
    ...(record.priority === undefined ? {} : { priority: record.priority }),
  };
}

/** Adds a domain to the new service, or finds it there, and says what it wants published. */
async function addToService(ctx: Ctx, choice: MailChoice, domain: string, mailFrom: string) {
  const { secrets } = ctx;
  if (choice.provider === 'ses') {
    const credentials = secrets.aws;
    if (!credentials) throw new InstallError('The Amazon SES key is missing.');
    const aws = <T>(operation: string, input: Record<string, unknown>) =>
      ctx.t.aws<T>({ service: 'sesv2', operation, input, region: choice.region, credentials });
    type Identity = { DkimAttributes?: { Tokens?: string[] } };
    const identity = await aws<Identity>('GetEmailIdentity', { EmailIdentity: domain }).catch(
      (error: Error) => {
        if (!/NotFound/.test(error.name)) throw error;
        return aws<Identity>('CreateEmailIdentity', {
          EmailIdentity: domain,
          DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' },
        });
      },
    );
    await aws('PutEmailIdentityMailFromAttributes', {
      EmailIdentity: domain,
      MailFromDomain: mailFrom,
      BehaviorOnMxFailure: 'USE_DEFAULT_VALUE',
    });
    const records: WantedRecord[] = [
      ...(identity.DkimAttributes?.Tokens ?? []).map((token) => ({
        type: 'CNAME' as const,
        name: `${token}._domainkey.${domain}`,
        content: `${token}.dkim.amazonses.com`,
      })),
      {
        type: 'MX',
        name: mailFrom,
        content: `feedback-smtp.${choice.region}.amazonses.com`,
        priority: 10,
      },
      { type: 'TXT', name: mailFrom, content: 'v=spf1 include:amazonses.com ~all' },
    ];
    return { records, providerRef: null as string | null };
  }
  if (choice.provider === 'resend') {
    if (!secrets.resendApiKey) throw new InstallError('The Resend key is missing.');
    const api = new ResendRest(ctx.t, secrets.resendApiKey);
    const existing = (await api.listDomains()).find((found) => found.name === domain);
    const suffix = `.${domain}`;
    const label = mailFrom.endsWith(suffix) ? mailFrom.slice(0, -suffix.length) : 'bounce';
    const found = existing
      ? await api.getDomain(existing.id)
      : await api.createDomain(domain, choice.region, label);
    return {
      records: resendZoneRecords(domain, found.records ?? []),
      providerRef: found.id as string | null,
    };
  }
  if (choice.provider === 'mailgun') {
    if (!secrets.mailgunApiKey) throw new InstallError('The Mailgun key is missing.');
    const api = new MailgunRest(ctx.t, secrets.mailgunApiKey, choice.region as 'us' | 'eu');
    const found = (await api.getDomain(domain)) ?? (await api.createDomain(domain));
    return {
      records: mailgunZoneRecords(domain, found),
      providerRef: null as string | null,
    };
  }
  if (choice.provider === 'postmark') {
    const account = secrets.postmarkAccountToken;
    if (!account) throw new InstallError('The Postmark token is missing.');
    const found = await new PostmarkRest(ctx.t, { account }).ensureDomain(domain, mailFrom);
    return {
      records: postmarkZoneRecords(found),
      providerRef: (found.ID === undefined ? null : String(found.ID)) as string | null,
    };
  }
  // A person's own server has nothing to register. Their records come from the server.
  return { records: [] as WantedRecord[], providerRef: null as string | null };
}

function change(ctx: Ctx) {
  const open = ctx.state.mailChange;
  if (!open) {
    throw new InstallError(
      'No change of email service is under way.',
      'Start one with `pnpm swarm mail switch <service>`.',
    );
  }
  return open;
}

/** Back to the service in use, whatever a stopped run left behind. */
function restoreCurrent(ctx: Ctx) {
  const open = ctx.state.mailChange;
  const choices = ctx.state.choices;
  if (open && choices && open.phase === 'preparing') {
    choices.mail = open.from;
    ctx.state.mailRecords = open.fromRecords;
  }
}

/** The lookups the workers use, through this run's transport. */
function dns(ctx: Ctx): DnsLookup {
  return dohLookup(async (url, init) => {
    const response = await ctx.t.http({
      method: 'GET',
      url,
      headers: init.headers as Record<string, string>,
    });
    return {
      ok: response.status < 400,
      status: response.status,
      json: async () => JSON.parse(response.text) as unknown,
    };
  });
}

interface DomainRow {
  id: string;
  domain: string;
  channel_id: string;
  mail_from_domain: string | null;
  records_json: string;
  pending_provider: string | null;
  pending_records_json: string | null;
}

async function emailDomains(ctx: Ctx): Promise<DomainRow[]> {
  const [result] = await database(ctx).run([
    {
      sql: `SELECT id, domain, channel_id, mail_from_domain, records_json, pending_provider, pending_records_json
              FROM sending_domains WHERE kind = 'email' ORDER BY domain`,
      params: [],
    },
  ]);
  return (result?.results ?? []) as unknown as DomainRow[];
}

/** Asks the new service about every domain it doesn't have yet. A failure doesn't stop the rest. */
async function registerDomains(ctx: Ctx, target: MailChoice): Promise<string[]> {
  const failed: string[] = [];
  for (const row of await emailDomains(ctx)) {
    if (row.pending_provider === target.provider && row.pending_records_json) continue;
    try {
      const created = await addToService(
        ctx,
        target,
        row.domain,
        row.mail_from_domain ?? `bounce.${row.domain}`,
      );
      // The DMARC record is Swarm's own, and stays as it is on any service.
      const dmarc = (JSON.parse(row.records_json) as { purpose?: string }[]).filter(
        (record) => record.purpose === 'dmarc',
      );
      await database(ctx).run([
        {
          sql: `UPDATE sending_domains
                   SET pending_provider = ?1, pending_records_json = ?2, pending_provider_ref = ?3, updated_at = ?4
                 WHERE id = ?5`,
          params: [
            target.provider,
            JSON.stringify([...created.records.map(asDomainRecord), ...dmarc]),
            created.providerRef,
            Date.now(),
            row.id,
          ],
        },
      ]);
    } catch (error) {
      failed.push(`${row.domain}: ${(error as Error).message}`);
    }
  }
  return failed;
}

async function writeRecords(ctx: Ctx, records: DnsRecordSpec[]) {
  const cf = dnsApi(ctx);
  if (!cf) {
    ctx.ui.warn(
      'This run has no DNS token, so publish the new records yourself. See `mail status`.',
    );
    return;
  }
  const zone = zoneId(ctx);
  for (const record of records) await upsertRecord(cf, zone, record);
}

/** Removes records of the old service that the new one doesn't use. Others' records stay. */
async function removeRecords(ctx: Ctx, records: DnsRecordSpec[]) {
  const cf = dnsApi(ctx);
  if (!cf) return;
  const zone = zoneId(ctx);
  for (const record of records) {
    const found = await cf.get<{ id: string; type: string; content: string; comment?: string }[]>(
      `/zones/${zone}/dns_records`,
      { name: record.name, type: record.type },
    );
    for (const row of found ?? []) {
      // Only ever what the installer itself wrote: a name can hold someone else's records too.
      const same = row.content.replace(/^"|"$/g, '') === record.content.replace(/^"|"$/g, '');
      if (same && row.comment === 'Added by the Swarm installer') {
        await cf.request('DELETE', `/zones/${zone}/dns_records/${row.id}`);
      }
    }
  }
}

/**
 * Changes a Worker's mail settings without uploading code, so nothing newer than its migrations can
 * ship by accident. Secrets go first, because a Worker refuses to start on settings it lacks the
 * keys for. Bindings it doesn't own are sent back as they came, and secrets are inherited.
 */
export async function applyMailBindings(ctx: Ctx, worker: Worker) {
  const cf = oauthApi(ctx);
  const script = scriptName(worker, ctx.env);
  const base = `/accounts/${accountId(ctx)}/workers/scripts/${script}`;
  for (const name of secretNames(worker, secretContext(ctx.state, ctx.secrets))) {
    if (!isMailSecret(name)) continue;
    const text = secretValueFor(name, ctx.state, ctx.secrets);
    if (!text) throw new InstallError(`The secret ${name} is missing for ${script}.`);
    await cf.put(`${base}/secrets`, { name, text, type: 'secret_text' });
  }
  const current = await cf.get<{ bindings?: { type: string; name: string; text?: string }[] }>(
    `${base}/settings`,
  );
  const vars = varsFor(worker, renderInput(ctx.state));
  const bindings = (current?.bindings ?? [])
    .filter((binding) => !(binding.type === 'plain_text' && binding.name in vars))
    .map((binding) =>
      binding.type === 'secret_text' ? { type: 'inherit', name: binding.name } : binding,
    );
  for (const [name, text] of Object.entries(vars)) {
    if (text !== undefined) bindings.push({ type: 'plain_text', name, text });
  }
  await cf.patchSettings(`${base}/settings`, { bindings });
}

const MAIL_SECRET_NAMES: ReadonlySet<string> = new Set([
  ...Object.values(MAIL_SECRETS).flat(),
  'RESEND_WEBHOOK_SECRET',
  'MAILGUN_WEBHOOK_SIGNING_KEY',
  'POSTMARK_WEBHOOK_SECRET',
  'SMTP_FEEDBACK_SECRET',
]);
const isMailSecret = (name: string) => MAIL_SECRET_NAMES.has(name);

async function applyEverywhere(ctx: Ctx, workers: readonly Worker[]) {
  for (const worker of workers) {
    await ctx.ui.task(`Updating ${scriptName(worker, ctx.env)}`, () =>
      applyMailBindings(ctx, worker),
    );
  }
}

/** Keeps the terminal installer's rendered configs in step, so `doctor` agrees with what's live. */
async function renderIfLocal(ctx: Ctx) {
  if (!ctx.deployer) await writeConfigs(ctx);
}

/** Sets up the new service and asks it for every domain's records. The old service keeps sending. */
export async function prepareSwitch(ctx: Ctx, provider: MailProvider) {
  const choices = ctx.state.choices;
  if (!choices) throw new InstallError('There is no install recorded.', 'Run `pnpm swarm` first.');
  restoreCurrent(ctx);
  const open = ctx.state.mailChange;
  if (open?.phase === 'cut_over' || open?.phase === 'cutting_over') {
    throw new InstallError(
      `Email is already moving to ${open.to?.provider}.`,
      'Finish it with `pnpm swarm mail finish`, or go back with `pnpm swarm mail rollback`.',
    );
  }
  if (open?.to && open.to.provider !== provider) {
    throw new InstallError(
      `A change to ${open.to.provider} is already prepared.`,
      'Drop it with `pnpm swarm mail cancel` first.',
    );
  }
  const from = open?.from ?? choices.mail;
  if (provider === from.provider) {
    throw new InstallError(`This Swarm already sends through ${provider}.`);
  }
  const fromRecords = open?.fromRecords ?? ctx.state.mailRecords ?? [];
  const id = open?.id ?? `msc_${randomBytes(16).toString('hex')}`;
  const startedAt = open?.startedAt ?? Date.now();
  ctx.state.mailChange = { id, phase: 'preparing', from, fromRecords, startedAt };
  await save(ctx);

  // The installer's own steps set a service up from `choices`, so it's borrowed just for them.
  ctx.answers.mail = { ...ctx.answers.mail, provider };
  choices.mail = { provider, region: '' };
  let to: MailChoice;
  let toRecords: DnsRecordSpec[];
  try {
    choices.mail = await mailChoice(ctx);
    await mail.run(ctx);
    to = choices.mail;
    toRecords = ctx.state.mailRecords ?? [];
  } catch (error) {
    choices.mail = from;
    ctx.state.mailRecords = fromRecords;
    await save(ctx);
    throw error;
  }
  choices.mail = from;
  ctx.state.mailRecords = fromRecords;
  ctx.state.mailChange = { id, phase: 'prepared', from, fromRecords, startedAt, to, toRecords };
  await save(ctx);
  await saveSecrets(ctx);

  const failed = await ctx.ui.task('Asking the new service about your sending domains', () =>
    registerDomains(ctx, to),
  );
  // Records under names the old service also uses wait for the cut-over: they can't hold both.
  const taken = new Set(fromRecords.map((record) => record.name));
  await writeRecords(
    ctx,
    toRecords.filter((record) => !taken.has(record.name)),
  );
  await database(ctx).run([
    {
      sql: `INSERT OR IGNORE INTO mail_service_changes (id, from_provider, to_provider, state, started_at)
            VALUES (?1, ?2, ?3, 'prepared', ?4)`,
      params: [id, from.provider, to.provider, startedAt],
    },
  ]);
  for (const line of failed) ctx.ui.warn(`Couldn't add a domain to the new service. ${line}`);
  ctx.ui.note(
    'Prepared. Your current service is still sending.',
    [
      'Each publication can now see its new records under Sending & delivery.',
      'See what is missing with `pnpm swarm mail status`.',
      'When they are published, move over with `pnpm swarm mail cutover`.',
    ].join('\n'),
  );
}

export interface SwitchReadiness {
  platform: { name: string; state: RecordState }[];
  domains: { domain: string; registered: boolean; waiting: string[] }[];
  scheduled: number;
}

/** What's published so far, and what's still missing. Changes nothing. */
export async function switchStatus(ctx: Ctx): Promise<SwitchReadiness> {
  const open = change(ctx);
  const lookup = dns(ctx);
  const verify = async (record: { type: string; name: string; value: string }) =>
    checkRecord(
      { type: record.type as 'TXT' | 'CNAME' | 'MX', name: record.name, value: record.value },
      lookup,
    );
  const platform = await Promise.all(
    (open.toRecords ?? []).map(async (record) => ({
      name: `${record.type} ${record.name}`,
      state: (await verify({ type: record.type, name: record.name, value: record.content })).state,
    })),
  );
  const rows = await emailDomains(ctx);
  const domains = await Promise.all(
    rows.map(async (row) => {
      const records = JSON.parse(row.pending_records_json ?? '[]') as {
        purpose?: string;
        type: string;
        name: string;
        value: string;
      }[];
      const checks = await Promise.all(
        records.map(async (record) => ({ record, check: await verify(record) })),
      );
      return {
        domain: row.domain,
        registered: !!row.pending_records_json,
        waiting: checks
          .filter(({ check }) => check.state !== 'ok')
          .map(({ record, check }) => `${record.type} ${record.name} (${check.state})`),
      };
    }),
  );
  const notReady = rows
    .filter((row) => {
      const domain = domains.find((d) => d.domain === row.domain);
      return !domain?.registered || domain.waiting.length > 0;
    })
    .map((row) => row.channel_id);
  let scheduled = 0;
  if (notReady.length) {
    const marks = notReady.map((_, i) => `?${i + 1}`).join(', ');
    const [result] = await database(ctx).run([
      {
        sql: `SELECT count(*) AS n FROM dispatches WHERE status = 'scheduled' AND channel_id IN (${marks})`,
        params: notReady,
      },
    ]);
    scheduled = Number((result?.results[0] as { n?: number } | undefined)?.n ?? 0);
  }
  return { platform, domains, scheduled };
}

/** Why cutting over now would hurt, in words a person can weigh up. Empty when nothing would. */
export function cutOverWarnings(readiness: SwitchReadiness): string[] {
  const warnings: string[] = [];
  const platform = readiness.platform.filter((record) => record.state !== 'ok');
  // Records sharing a name with the old service's can't be published until the cut-over itself.
  if (platform.length) {
    warnings.push(
      `${platform.length} of Swarm's own records aren't in place yet. Swarm writes what it can during the move, but sign-in email may fail until they are.`,
    );
  }
  const waiting = readiness.domains.filter((d) => !d.registered || d.waiting.length > 0);
  for (const domain of waiting) {
    warnings.push(
      domain.registered
        ? `${domain.domain} can't send until its new records are published: ${domain.waiting.join(', ')}.`
        : `The new service doesn't have ${domain.domain} yet, so it can't send until you run this again.`,
    );
  }
  if (readiness.scheduled) {
    warnings.push(
      `${readiness.scheduled} scheduled ${readiness.scheduled === 1 ? 'post uses' : 'posts use'} these domains. A post due while its domain isn't ready goes back to being a draft.`,
    );
  }
  return warnings;
}

/** Moves email to the new service. Safe to run again if something stops it partway. */
export async function cutOver(ctx: Ctx, options: { acknowledged: boolean }) {
  const open = change(ctx);
  const choices = ctx.state.choices;
  if (!choices) throw new InstallError('There is no install recorded.');
  if (open.phase === 'cut_over') throw new InstallError('Email has already moved.');
  if (open.phase === 'preparing' || !open.to || !open.toRecords) {
    throw new InstallError('The new service isn’t ready.', 'Run `pnpm swarm mail switch` again.');
  }
  const { to, toRecords, from } = open;

  if (open.phase === 'prepared') {
    const failed = await registerDomains(ctx, to);
    for (const line of failed) ctx.ui.warn(`Couldn't add a domain to the new service. ${line}`);
    const warnings = cutOverWarnings(await switchStatus(ctx));
    if (warnings.length && !options.acknowledged) {
      throw new InstallError(
        `Moving now would stop some email:\n- ${warnings.join('\n- ')}`,
        'Publish the records and check again with `pnpm swarm mail status`. To move anyway, run this with --yes.',
      );
    }
  }

  // Reports first, so nothing the new service sends goes unseen. The old service's stay connected.
  const now = Date.now();
  const drainUntil = open.drainUntil ?? now + DRAIN_MS;
  ctx.state.mailChange = { ...open, phase: 'cutting_over', drainUntil };
  choices.mail = to;
  ctx.state.mailRecords = toRecords;
  await save(ctx);
  // Resend's webhook secret arrives here and has to reach the events Worker. This does that alone,
  // without the code upload an ordinary deploy would make.
  const deployer = ctx.deployer;
  ctx.deployer = (context, worker) => applyMailBindings(context, worker);
  try {
    await applyMailBindings(ctx, 'events');
    await afterDeploy(ctx);
  } finally {
    if (deployer) ctx.deployer = deployer;
    else delete ctx.deployer;
  }
  await writeRecords(ctx, toRecords);

  const db = database(ctx);
  const [row] = await db.run([
    { sql: 'SELECT state FROM mail_service_changes WHERE id = ?1', params: [open.id] },
  ]);
  // Swapped once only: a second swap would be a rollback.
  if ((row?.results[0] as { state?: string } | undefined)?.state === 'prepared') {
    await db.run([
      { sql: HOLD_UNREGISTERED_SQL, params: [now] },
      { sql: SWAP_DOMAINS_SQL, params: [now] },
      { sql: REWARM_SQL, params: [now] },
      {
        sql: `UPDATE mail_service_changes SET state = 'cut_over', cut_over_at = ?1, drain_until = ?2 WHERE id = ?3`,
        params: [now, drainUntil, open.id],
      },
    ]);
  }
  await applyEverywhere(ctx, MAIL_WORKERS);
  await renderIfLocal(ctx);
  ctx.state.mailChange = { ...open, phase: 'cut_over', drainUntil };
  await save(ctx);
  ctx.ui.note(
    `Email now goes through ${to.provider}`,
    [
      `Reports from ${from.provider} keep arriving until ${new Date(drainUntil).toISOString().slice(0, 10)}.`,
      'Warm-up has started again, so large lists take a while to reach everyone.',
      `Changed your mind? \`pnpm swarm mail rollback\`. After that date, \`pnpm swarm mail finish\` removes ${from.provider}'s keys and DNS records.`,
    ].join('\n'),
  );
}

/** Goes back to the old service, for as long as it hasn't been finished. */
export async function rollBack(ctx: Ctx) {
  const open = change(ctx);
  const choices = ctx.state.choices;
  if (!choices) throw new InstallError('There is no install recorded.');
  if (open.phase === 'prepared' || open.phase === 'preparing') {
    throw new InstallError('Email hasn’t moved yet.', 'To drop the change, use `mail cancel`.');
  }
  const now = Date.now();
  choices.mail = open.from;
  ctx.state.mailRecords = open.fromRecords;
  await save(ctx);
  await writeRecords(ctx, open.fromRecords);
  const db = database(ctx);
  const [row] = await db.run([
    { sql: 'SELECT state FROM mail_service_changes WHERE id = ?1', params: [open.id] },
  ]);
  if ((row?.results[0] as { state?: string } | undefined)?.state === 'cut_over') {
    await db.run([
      { sql: SWAP_DOMAINS_SQL, params: [now] },
      {
        sql: `UPDATE mail_service_changes SET state = 'rolled_back', finished_at = ?1 WHERE id = ?2`,
        params: [now, open.id],
      },
    ]);
  }
  await applyEverywhere(ctx, ['events', ...MAIL_WORKERS]);
  await renderIfLocal(ctx);
  delete ctx.state.mailChange;
  await save(ctx);
  ctx.ui.info(`Back on ${open.from.provider}. Warm-up carries on from where it restarted.`);
}

/** Drops a prepared change that never cut over. Nothing has moved, so nothing moves back. */
export async function cancelSwitch(ctx: Ctx) {
  const open = change(ctx);
  if (open.phase === 'cut_over' || open.phase === 'cutting_over') {
    throw new InstallError('Email has already moved.', 'Use `pnpm swarm mail rollback`.');
  }
  restoreCurrent(ctx);
  await database(ctx).run([
    {
      sql: `UPDATE sending_domains SET pending_provider = NULL, pending_records_json = NULL, pending_provider_ref = NULL`,
      params: [],
    },
    {
      sql: `UPDATE mail_service_changes SET state = 'rolled_back', finished_at = ?1 WHERE id = ?2`,
      params: [Date.now(), open.id],
    },
  ]);
  const taken = new Set(open.fromRecords.map((record) => record.name));
  await removeRecords(
    ctx,
    (open.toRecords ?? []).filter((record) => !taken.has(record.name)),
  );
  delete ctx.state.mailChange;
  await save(ctx);
  ctx.ui.info('Dropped. Nothing about how email is sent has changed.');
}

/** Removes the old service's keys and DNS records, once its reports have stopped mattering. */
export async function finishSwitch(ctx: Ctx, options: { force: boolean }) {
  const open = change(ctx);
  if (open.phase !== 'cut_over' || !open.to) {
    throw new InstallError('Email hasn’t moved yet.', 'Run `pnpm swarm mail cutover` first.');
  }
  const until = open.drainUntil ?? 0;
  if (Date.now() < until && !options.force) {
    throw new InstallError(
      `Reports from ${open.from.provider} can still arrive until ${new Date(until).toISOString().slice(0, 10)}. Removing its keys now would lose them.`,
      'Run this again after that date, or with --yes to remove them anyway.',
    );
  }
  const stale = open.from.provider;
  // Off the state first, so a redeploy from here on wouldn't try to send the keys again.
  delete ctx.state.mailChange;
  await save(ctx);
  const cf = oauthApi(ctx);
  const account = accountId(ctx);
  for (const worker of ['events', ...MAIL_WORKERS] as Worker[]) {
    const keep = new Set(secretNames(worker, secretContext(ctx.state, ctx.secrets)));
    const script = scriptName(worker, ctx.env);
    const have = await cf.get<{ name: string }[]>(
      `/accounts/${account}/workers/scripts/${script}/secrets`,
    );
    for (const { name } of have ?? []) {
      if (isMailSecret(name) && !keep.has(name)) {
        await cf.request(
          'DELETE',
          `/accounts/${account}/workers/scripts/${script}/secrets/${name}`,
        );
      }
    }
  }
  await applyMailBindings(ctx, 'events');
  await renderIfLocal(ctx);
  const inUse = new Set((open.toRecords ?? []).map((r) => `${r.type} ${r.name}`));
  await removeRecords(
    ctx,
    open.fromRecords.filter((record) => !inUse.has(`${record.type} ${record.name}`)),
  );
  await database(ctx).run([
    {
      sql: `UPDATE sending_domains SET pending_provider = NULL, pending_records_json = NULL, pending_provider_ref = NULL`,
      params: [],
    },
    {
      sql: `UPDATE mail_service_changes SET state = 'finished', finished_at = ?1 WHERE id = ?2`,
      params: [Date.now(), open.id],
    },
  ]);
  forgetService(ctx, stale);
  await save(ctx);
  await saveSecrets(ctx);
  ctx.ui.info(
    `Done. ${stale} is no longer connected. You can now close that account, or delete the domains there.`,
  );
}

function forgetService(ctx: Ctx, provider: MailProvider) {
  const { secrets, state } = ctx;
  if (provider === 'ses') {
    delete secrets.aws;
    delete state.ses;
  } else if (provider === 'resend') {
    delete secrets.resendApiKey;
    delete secrets.resendWebhookSecret;
    delete state.resend;
  } else if (provider === 'mailgun') {
    delete secrets.mailgunApiKey;
    delete secrets.mailgunWebhookSigningKey;
    delete state.mailgun;
  } else if (provider === 'postmark') {
    delete secrets.postmarkServerToken;
    delete secrets.postmarkAccountToken;
    delete secrets.postmarkWebhookSecret;
    delete state.postmark;
  } else {
    delete secrets.smtp;
    delete secrets.smtpFeedbackSecret;
  }
}
