import { checkRecord, dohLookup, type DnsLookup } from '@swarm/mail/dns-check';
import { LINK_V2_SIGNING_READY } from '@swarm/tokens';
import { VAULT_ENTRYPOINTS, type VaultCaller } from '@swarm/vault/api';
import { describeVault, nextVaultStep, vaultStatus } from './vault';
import { accountId, database, oauthApi, type Ctx } from '../context';
import { debounceBalance } from './enable';
import { hostnamesFor } from '../hostnames';
import { KEY_SECRET_NAMES, secretContext, secretNames, type LinkKeys } from '../keys';
import { generatedPath, scriptName, WORKERS } from '../paths';
import { MailgunRest } from '../mailgun';
import { PostmarkRest } from '../postmark';
import { ResendRest } from '../resend';
import { sesSuppressionOutdated, sesTopicOutdated } from '../ses-policy';
import { PUBLIC_QUEUE_PRODUCERS, resourceNames } from '../steps/resources';
import { renderAll } from '../steps/render';
import { checkHealth } from '../steps/postdeploy';
import { healthHosts, heartbeatProblem, readJobsHeartbeat } from '../steps/health';
import { pendingMigrations } from '../steps/migrations';
import { signIn } from '../steps/login';
import type { DnsRecordSpec } from '../state';
import { InstallError } from '../ui';

interface Finding {
  ok: boolean;
  detail?: string;
  fix?: string;
}

const pass = (detail?: string): Finding => ({ ok: true, ...(detail ? { detail } : {}) });
const problem = (detail: string, fix: string): Finding => ({ ok: false, detail, fix });

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

export function resolve(ctx: Ctx, name: string, type: 'TXT' | 'CNAME' | 'MX'): Promise<string[]> {
  return dns(ctx).lookup(name, type);
}

/** The DKIM records the install wrote, against what DNS says. */
async function dkimProblems(ctx: Ctx, records: DnsRecordSpec[]): Promise<string[]> {
  const out: string[] = [];
  for (const record of records) {
    const { state } = await checkRecord(
      { type: record.type as 'TXT' | 'CNAME', name: record.name, value: record.content },
      dns(ctx),
    );
    if (state !== 'ok') out.push(`${record.name} is ${state}`);
  }
  return out;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Where the move from MEMBER_KEYS to per-family link keys is, and whether an update is due. */
export function linkKeysFinding(
  linkKeys: LinkKeys | undefined,
  now: number,
  v2Ready: boolean = LINK_V2_SIGNING_READY,
): Finding {
  if (!linkKeys) {
    return problem(
      'this install has not been given its per-link keys yet',
      'Run `pnpm swarm update`; it creates them and gives each worker its own.',
    );
  }
  if (linkKeys.mode === 'verify-v2') {
    return v2Ready
      ? problem(
          'every worker accepts the new links, but the signers have not switched to them',
          'Run `pnpm swarm update` to finish the switch.',
        )
      : pass('every worker has them; links are still signed with MEMBER_KEYS');
  }
  const open = Object.entries(linkKeys.legacyUntil ?? {})
    .filter(([, until]) => until > now)
    .map(([worker, until]) => `${worker} until ${day(until)}`);
  return pass(
    open.length
      ? `since ${day(linkKeys.cutoffAt ?? 0)}; older links still work on ${open.join(', ')}`
      : `since ${day(linkKeys.cutoffAt ?? 0)}; MEMBER_KEYS is retired`,
  );
}

export async function doctor(ctx: Ctx): Promise<boolean> {
  const failures: { title: string; finding: Finding }[] = [];
  const check = async (title: string, run: () => Promise<Finding>) => {
    let finding: Finding;
    try {
      finding = await run();
    } catch (error) {
      finding =
        error instanceof InstallError
          ? problem(error.message, error.fix ?? 'See the message above.')
          : problem(
              (error as Error).message,
              'Check the message, then run `pnpm swarm doctor` again.',
            );
    }
    await ctx.ui.task(
      title,
      async () => finding,
      (f) => (f.ok ? (f.detail ? `ok (${f.detail})` : 'ok') : `problem: ${f.detail}`),
    );
    if (!finding.ok) failures.push({ title, finding });
    return finding.ok;
  };

  const state = ctx.state;
  if (!state.zone || !state.choices) {
    throw new InstallError(
      `There is no ${ctx.env} install recorded in .swarm/.`,
      'Run `pnpm swarm` to install, or restore .swarm/ from your backup.',
    );
  }
  const zone = state.zone.name;
  const h = hostnamesFor(zone, ctx.env, ctx.state.choices?.addresses);
  const provider = state.choices.mail.provider;

  ctx.ui.section('Configuration');
  await check('Worker configs match a fresh render', async () => {
    const rendered = await renderAll(ctx);
    const stale: string[] = [];
    for (const [worker, text] of rendered) {
      if ((await ctx.t.readFile(generatedPath(ctx.root, worker, ctx.env))) !== text)
        stale.push(worker);
    }
    return stale.length
      ? problem(
          `out of date: ${stale.join(', ')}`,
          'Run `pnpm swarm update` to render and deploy them.',
        )
      : pass();
  });

  await check('Per-link keys', async () => linkKeysFinding(state.linkKeys, Date.now()));

  ctx.ui.section('Cloudflare');
  await signIn(ctx);
  const cf = oauthApi(ctx);
  const account = `/accounts/${accountId(ctx)}`;
  const names = resourceNames(ctx.env);
  await check('Resources exist', async () => {
    const missing: string[] = [];
    const d1 = await cf.get<{ name: string }[]>(`${account}/d1/database`, { name: names.d1 });
    if (!d1.some((d) => d.name === names.d1)) missing.push(names.d1);
    const kv = await cf.list<{ title: string }>(`${account}/storage/kv/namespaces`);
    if (!kv.some((k) => k.title === names.kv)) missing.push(names.kv);
    const r2 = new Set(
      ((await cf.get<{ buckets?: { name: string }[] }>(`${account}/r2/buckets`)).buckets ?? []).map(
        (b) => b.name,
      ),
    );
    missing.push(...names.r2.filter((b) => !r2.has(b)));
    const queues = new Set(
      (await cf.list<{ queue_name: string }>(`${account}/queues`)).map((q) => q.queue_name),
    );
    missing.push(...names.queues.filter((q) => !queues.has(q)));
    return missing.length
      ? problem(`missing: ${missing.join(', ')}`, 'Run `pnpm swarm update` to create them.')
      : pass();
  });
  for (const worker of WORKERS) {
    await check(`Secrets of ${scriptName(worker, ctx.env)}`, async () => {
      const wanted = secretNames(worker, secretContext(state, ctx.secrets));
      const have = new Set(
        (
          await cf.get<{ name: string }[]>(
            `${account}/workers/scripts/${scriptName(worker, ctx.env)}/secrets`,
          )
        ).map((s) => s.name),
      );
      const missing = wanted.filter((n) => !have.has(n));
      // A keyring the worker should no longer hold, such as MEMBER_KEYS after its window.
      const extra = [...have].filter((n) => KEY_SECRET_NAMES.has(n) && !wanted.includes(n));
      if (missing.length) {
        return problem(
          `missing ${missing.join(', ')}`,
          'Run `pnpm swarm update`; deploys upload every secret.',
        );
      }
      return extra.length
        ? problem(
            `still holds ${extra.join(', ')}, which it no longer needs`,
            'Run `pnpm swarm update`; it removes them.',
          )
        : pass();
    });
  }
  await check('Queues of the public Workers', async () => {
    // Capture and events answer the internet, so they may write only to the public queue: the jobs
    // worker refuses there anything they don't legitimately send (docs/security.md).
    const publicQueue = `swarm-${ctx.env}-public`;
    const wrong: string[] = [];
    for (const worker of PUBLIC_QUEUE_PRODUCERS) {
      const script = scriptName(worker, ctx.env);
      const settings = await cf.get<{
        bindings?: { type: string; name: string; queue_name?: string }[];
      }>(`${account}/workers/scripts/${script}/settings`);
      for (const binding of settings.bindings ?? []) {
        if (binding.type === 'queue' && binding.queue_name !== publicQueue) {
          wrong.push(`${script} writes to ${binding.queue_name ?? binding.name}`);
        }
      }
    }
    return wrong.length
      ? problem(
          wrong.join('; '),
          'Run `pnpm swarm update` to deploy them with the public queue only.',
        )
      : pass();
  });
  await check('Bindings to the vault', async () => {
    // Each caller reaches the vault only through its own entrypoint, and no other Worker binds to
    // it at all (docs/security.md "The vault"). A missing binding shows in Health as a 503.
    const vault = scriptName('vault', ctx.env);
    const wrong: string[] = [];
    for (const worker of WORKERS) {
      const script = scriptName(worker, ctx.env);
      const settings = await cf.get<{
        bindings?: { type: string; name: string; service?: string; entrypoint?: string }[];
      }>(`${account}/workers/scripts/${script}/settings`);
      const expected = VAULT_ENTRYPOINTS[worker as VaultCaller] as string | undefined;
      for (const binding of settings.bindings ?? []) {
        if (binding.type !== 'service' || binding.service !== vault) continue;
        if (!expected) wrong.push(`${script} binds to the vault`);
        else if (binding.entrypoint !== expected) {
          wrong.push(
            `${script} binds to ${binding.entrypoint ?? 'its default entrypoint'}, not ${expected}`,
          );
        }
      }
    }
    return wrong.length
      ? problem(
          wrong.join('; '),
          'Run `pnpm swarm update` to deploy every Worker with its own binding.',
        )
      : pass();
  });
  await check('The vault', async () => {
    // How it seals, whether it still opens the older formats, and how far its re-seal got.
    const status = await vaultStatus(ctx);
    const detail = describeVault(status, Date.now());
    if (status.reseal && status.reseal.unreadable > 0) {
      return problem(
        detail,
        'Some stored values open with no key in FIELD_KEYS: put back the key they were sealed with (docs/self-hosting.md "Rotate keys"), or accept losing them before `pnpm swarm vault --legacy-open off`.',
      );
    }
    const next = nextVaultStep(status, Date.now());
    return pass(next ? `${detail}. Next: ${next}` : detail);
  });
  const migrations = await check('Database migrations', async () => {
    const pending = await pendingMigrations(ctx);
    return pending.length
      ? problem(`${pending.length} pending (${pending.join(', ')})`, 'Run `pnpm swarm update`.')
      : pass('up to date');
  });

  ctx.ui.section('Health');
  for (const host of healthHosts(ctx)) {
    await check(`https://${host}/healthz`, async () => {
      const r = await checkHealth(ctx, host);
      return r.ok
        ? pass()
        : problem(
            r.problem ?? 'no answer',
            `Check the DNS record for ${host} (proxied AAAA 100::) and the worker's route; \`pnpm swarm update\` redeploys.`,
          );
    });
  }
  await check('The jobs worker reaches the vault', async () => {
    // jobs has no public host: its minute cron pings the vault and records the answer in D1.
    const heartbeat = await readJobsHeartbeat(ctx).catch(() => null);
    const now = Date.now();
    const trouble = heartbeatProblem(heartbeat, now);
    return trouble
      ? problem(
          trouble,
          "Check the jobs worker's VAULT binding and its cron triggers (`pnpm swarm update` redeploys it). Keys the workers no longer need are removed only once it reaches the vault.",
        )
      : pass(`last answered ${Math.round((now - (heartbeat?.okAt ?? now)) / 60_000)} min ago`);
  });

  ctx.ui.section('Mail');
  await check(`DKIM for ${h.mail}`, async () => {
    if (provider === 'smtp') {
      const selector = state.choices?.mail.smtp?.dkimSelector ?? '';
      const answers = await resolve(ctx, `${selector}._domainkey.${h.mail}`, 'TXT');
      return answers.some((a) => /(^|;)\s*"?p=/.test(a))
        ? pass()
        : problem(
            `no DKIM record at ${selector}._domainkey.${h.mail}`,
            'Publish the record your mail server gives you. Swarm will not send until it is there.',
          );
    }
    const records = (state.mailRecords ?? []).filter((r) => r.name.includes('._domainkey'));
    const problems = await dkimProblems(ctx, records);
    if (records.length === 0) problems.push('no DKIM records are recorded');
    return problems.length
      ? problem(problems.join('; '), 'Run `pnpm swarm` with the DNS token to write them.')
      : pass();
  });
  await check(
    provider === 'mailgun' || provider === 'smtp' ? `SPF for ${h.mail}` : `MAIL FROM ${h.bounce}`,
    async () => {
      if (provider === 'mailgun' || provider === 'smtp') {
        const txt = await resolve(ctx, h.mail, 'TXT');
        return txt.some((t) => /^"?v=spf1\b/i.test(t))
          ? pass()
          : problem('no SPF record', 'Run `pnpm swarm` with the DNS token to write it.');
      }
      if (provider === 'postmark') {
        const cname = await resolve(ctx, h.bounce, 'CNAME');
        return cname.length
          ? pass()
          : problem('no return-path record', 'Run `pnpm swarm` with the DNS token to write it.');
      }
      const mx = await resolve(ctx, h.bounce, 'MX');
      return mx.length
        ? pass()
        : problem('no MX record', 'Run `pnpm swarm` with the DNS token to write it.');
    },
  );
  await check(`DMARC for ${h.mail}`, async () => {
    const txt = await resolve(ctx, `_dmarc.${h.mail}`, 'TXT');
    const record = txt.find((t) => /^v=DMARC1/i.test(t));
    if (!record)
      return problem('no DMARC record', 'Run `pnpm swarm` with the DNS token to write it.');
    return /p=(quarantine|reject)/i.test(record)
      ? pass(record)
      : problem(
          `the policy is weaker than quarantine: ${record}`,
          'Set p=quarantine on _dmarc.' + h.mail,
        );
  });
  const service = {
    ses: 'Amazon SES',
    resend: 'Resend',
    mailgun: 'Mailgun',
    postmark: 'Postmark',
    smtp: 'Mail server',
  }[provider];
  await check(`${service} status`, async () => {
    if (provider === 'smtp') {
      return pass('not checked from this computer; send a test email from the dashboard');
    }
    if (provider === 'postmark') {
      const account = ctx.secrets.postmarkAccountToken;
      const id = state.postmark?.domainId;
      if (!account || !id)
        return problem('the Postmark domain is not recorded', 'Run `pnpm swarm`.');
      const domain = await new PostmarkRest(ctx.t, { account }).getDomain(id);
      return domain.DKIMVerified
        ? pass('verified')
        : problem(
            'domain not verified',
            'Check the records in the Postmark dashboard (Sender Signatures); DNS can take a while.',
          );
    }
    if (provider === 'mailgun') {
      const key = ctx.secrets.mailgunApiKey;
      const name = state.mailgun?.domain;
      if (!key || !name) return problem('the Mailgun domain is not recorded', 'Run `pnpm swarm`.');
      const region = state.choices?.mail.region as 'us' | 'eu';
      const found = await new MailgunRest(ctx.t, key, region).getDomain(name);
      return found?.domain?.state === 'active'
        ? pass('verified')
        : problem(
            `domain ${found?.domain?.state ?? 'not found'}`,
            'Check the records in the Mailgun dashboard (Domains); DNS can take a while.',
          );
    }
    if (provider === 'resend') {
      const key = ctx.secrets.resendApiKey;
      const id = state.resend?.domainId;
      if (!key || !id) return problem('the Resend domain is not recorded', 'Run `pnpm swarm`.');
      const domain = await new ResendRest(ctx.t, key).getDomain(id);
      return domain.status === 'verified'
        ? pass('verified')
        : problem(
            `domain ${domain.status}`,
            'Check the records in the Resend dashboard (Domains); DNS can take a while.',
          );
    }
    const aws = ctx.secrets.aws;
    if (!aws)
      return problem("the workers' AWS key is missing", 'Run `pnpm swarm` with an AWS admin key.');
    const identity = await ctx.t.aws<{ VerifiedForSendingStatus?: boolean }>({
      service: 'sesv2',
      operation: 'GetEmailIdentity',
      input: { EmailIdentity: h.mail },
      region: state.choices?.mail.region ?? '',
      credentials: aws,
    });
    const notes = [identity.VerifiedForSendingStatus ? 'domain verified' : 'domain not verified'];
    if (state.ses?.productionAccess === false) notes.push('sandbox');
    return identity.VerifiedForSendingStatus
      ? pass(notes.join(', '))
      : problem(
          notes.join(', '),
          'Check that the DKIM records exist; SES re-checks them for 72 hours.',
        );
  });
  if (provider === 'ses') {
    await check('SES suppression list', async () => {
      const aws = ctx.secrets.aws;
      if (!aws)
        return problem(
          "the workers' AWS key is missing",
          'Run `pnpm swarm` with an AWS admin key.',
        );
      const account = await ctx.t.aws<{ SuppressionAttributes?: { SuppressedReasons?: string[] } }>(
        {
          service: 'sesv2',
          operation: 'GetAccount',
          input: {},
          region: state.choices?.mail.region ?? '',
          credentials: aws,
        },
      );
      const reasons = account.SuppressionAttributes?.SuppressedReasons ?? [];
      return sesSuppressionOutdated(reasons)
        ? problem(
            reasons.includes('COMPLAINT')
              ? 'adds addresses for complaints too, so one workspace’s complaint stops every workspace’s sends'
              : reasons.length
                ? `adds addresses for ${reasons.join(', ')}, not bounces only`
                : 'off, so SES does not add hard-bounced addresses itself',
            'Run `pnpm swarm` with an AWS admin key, or `aws sesv2 put-account-suppression-attributes --suppressed-reasons BOUNCE`.',
          )
        : pass('bounces only');
    });
    await check('SES bounce and complaint reports', async () => {
      const ses = state.ses;
      if (!ses || sesTopicOutdated(ses)) {
        return problem(
          'Swarm refuses the reports this SES topic sends',
          'Run `pnpm swarm` with an AWS admin key to fix the topic.',
        );
      }
      return ses.subscriptionConfirmed
        ? pass('connected')
        : problem(
            'the events worker has not confirmed its subscription',
            'Run `pnpm swarm` with an AWS admin key to subscribe again.',
          );
    });
  }

  ctx.ui.section('Email checks');
  await check('DeBounce (DEBOUNCE_API_KEY)', async () => {
    const key = ctx.secrets.debounceApiKey;
    if (!state.features.debounce || !key) {
      return pass('not set: addresses are not checked; `pnpm swarm enable debounce` sets it up');
    }
    if (ctx.dryRun) return pass('set; not asked in a dry run');
    const balance = await debounceBalance(ctx, key);
    return pass(`set, ${balance.toLocaleString('en-US')} credits left`);
  });

  ctx.ui.section('Owner');
  if (migrations) {
    await check('Owner account and sign-up mode', async () => {
      const db = database(ctx);
      const [owner] = await db.run([
        { sql: 'SELECT id FROM operators WHERE email = ?1', params: [state.choices?.owner.email] },
      ]);
      if (!owner?.results.length)
        return problem(
          `no account for ${state.choices?.owner.email}`,
          'Run `pnpm swarm` to create it.',
        );
      const [tables] = await db.run([
        {
          sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'instance_settings'",
          params: [],
        },
      ]);
      if (!tables?.results.length)
        return pass('sign-up is open (no instance settings in this version)');
      const [mode] = await db.run([
        { sql: "SELECT value FROM instance_settings WHERE key = 'signup'", params: [] },
      ]);
      const value = (mode?.results[0]?.value as string | undefined) ?? 'open';
      return pass(`sign-up is ${value === 'invite_only' ? 'invite-only' : value}`);
    });
  }

  if (failures.length) {
    ctx.ui.section(`${failures.length} problem${failures.length === 1 ? '' : 's'} found`);
    for (const { title, finding } of failures)
      ctx.ui.error(`${title}: ${finding.detail}`, finding.fix);
    return false;
  }
  ctx.ui.info('\nEverything checks out.');
  return true;
}
