// One install, in one Durable Object: its state, its secrets, and which step is next. Being a single
// object means only one thing happens at a time, and a closed browser tab loses nothing.
import { DurableObject } from 'cloudflare:workers';
import {
  CloudflareApi,
  InstallError,
  PROJECT_RELEASE_KEYS,
  WITHDRAWN_RELEASES,
  WorkerTransport,
  emptySecrets,
  openRelease,
  sealKit,
  withdrawnList,
  wizardContext,
  wizardSteps,
  type Answers,
  type Report,
  type Secrets,
  type State,
  type StateStore,
} from '@swarm/installer/wizard';

export interface SetupEnv {
  SETUP: DurableObjectNamespace<SetupRun>;
  SETUP_PASSWORD?: string;
  RELEASE_URL: string;
  RELEASE_PUBLIC_KEY: string;
  /**
   * The oldest release version to install. Required: without it the page refuses to open any
   * release, unless RELEASE_ACCEPT_ANY_VERSION is "true".
   */
  RELEASE_MIN_VERSION?: string;
  /** "true" lets an install with no RELEASE_MIN_VERSION take any release ever signed. */
  RELEASE_ACCEPT_ANY_VERSION?: string;
  /** Withdrawn release versions, manifest digests or key ids, separated by commas or spaces. */
  RELEASE_WITHDRAWN?: string;
}

/** A release as offered for approval: what the person compares with what the project publishes. */
interface Offer {
  version: string;
  /** The sha256 of its signed manifest, which names it exactly. */
  digest: string;
  /** The id of the key RELEASE_PUBLIC_KEY holds and the manifest names. */
  keyId: string;
  /** Whether that key is one the Swarm project publishes (PROJECT_RELEASE_KEYS). */
  projectKey: boolean;
}

/** The release an install keeps to, once the person has approved it. */
type Pinned = { digest: string; version: string; keyId?: string };

interface Progress {
  /** expired: left unfinished past SECRETS_IDLE_MS, so the token and every key were forgotten. */
  phase: 'answers' | 'installing' | 'save-kit' | 'finished' | 'expired';
  steps: { id: string; title: string; done: boolean }[];
  failed: { step: string; message: string; hint?: string } | null;
  log: string[];
  signInLink: string | null;
  testEmailTo: string | null;
  mailNote: string | null;
  publicationUrl: string | null;
  /** The install stopped on Amazon SES, and the page has already forgotten the AWS key. */
  needsAwsKey: boolean;
  /** The version of the release this install uses, once the person has approved it. */
  release: string | null;
  /** Recovery kit downloads left (MAX_KIT_DOWNLOADS in all). */
  kitDownloadsLeft: number;
  /** The release on offer, opened and checked, waiting for the person's approval. */
  offer: Offer | null;
  /** Whether the person approved this install's release. No step runs before. */
  approved: boolean;
  /** The approved release has been withdrawn since: the page offers to move to its replacement. */
  withdrawn: boolean;
}

type AwsKey = { accessKeyId: string; secretAccessKey: string };

/** Wrong passwords counted since `since`, and when a lock ends, if there is one. */
type Tally = { count: number; since: number; until: number };

/** A tally that has gone LOCK_MS without a lock starts again. */
const current = (tally: Tally | undefined, now: number): Tally =>
  tally && (tally.until > now || now - tally.since < LOCK_MS)
    ? tally
    : { count: 0, since: now, until: 0 };

const counted = (tally: Tally, max: number, now: number): Tally =>
  tally.count + 1 >= max
    ? { count: 0, since: now, until: now + LOCK_MS }
    : { ...tally, count: tally.count + 1 };

/** An IPv6 address's groups, without leading zeros. */
function groups(client: string): string[] {
  const [head = '', tail] = client.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const gap = tail === undefined ? [] : Array<string>(Math.max(0, 8 - left.length - right.length));
  return [...left, ...gap.fill('0'), ...right].map((g) => g.replace(/^0+(?=.)/, ''));
}

/**
 * Whom a client address counts as. An IPv6 address counts as its /64, the block one connection
 * is usually given, since a machine can pick any address in it.
 */
function network(client: string): string {
  if (!client.includes(':')) return client.slice(0, 64);
  return `${groups(client).slice(0, 4).join(':')}::/64`.slice(0, 64);
}

/**
 * The wider block an address is in: an IPv6 /48, which a tunnel broker hands out for free, or an
 * IPv4 /24. While the total holds, each gets one wrong guess, so many need many such blocks.
 */
function block(client: string): string {
  if (client.includes(':')) return `${groups(client).slice(0, 3).join(':')}::/48`.slice(0, 64);
  const octets = client.split('.');
  return octets.length === 4 ? `${octets.slice(0, 3).join('.')}.0/24` : network(client);
}

/** Hides what must never reach the page, whatever an error or a log line happens to quote. */
export function scrub(text: string, secrets: (string | undefined)[]): string {
  // Longest first, so a secret that contains another is hidden whole.
  return [...secrets]
    .filter((secret): secret is string => !!secret && secret.length >= 6)
    .sort((a, b) => b.length - a.length)
    .reduce<string>((out, secret) => out.split(secret).join('[hidden]'), text);
}

/** Every string inside a value, at any depth (the generated keys, a mail provider's settings). */
function strings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out, depth + 1);
  else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) strings(item, out, depth + 1);
  }
  return out;
}

/**
 * Every secret value the install holds, for scrubbing: the Cloudflare token, the AWS key, the mail
 * provider's key or SMTP password, and every key the install generated. Treated alike, whichever
 * step or provider an error came from.
 */
export function secretValues(input: {
  token?: string | undefined;
  awsKey?: AwsKey | null | undefined;
  answers?: Answers | null | undefined;
  secrets?: Secrets | null | undefined;
}): string[] {
  const mail = (input.answers?.mail ?? {}) as Record<string, unknown>;
  const smtp = (mail.smtp ?? {}) as Record<string, unknown>;
  const fromMail = [
    ...Object.entries(mail)
      .filter(([key]) => /key|secret|token|password/i.test(key))
      .flatMap(([, value]) => strings(value)),
    ...strings([smtp.password, smtp.username]),
  ];
  return [
    input.token,
    input.awsKey?.accessKeyId,
    input.awsKey?.secretAccessKey,
    ...fromMail,
    ...strings(input.secrets?.keys ?? {}),
  ].filter((value): value is string => typeof value === 'string' && value.length >= 6);
}

/** Takes the AWS key out of the answers, so it can be forgotten sooner than they are. */
function withoutAwsKey(answers: Answers): { answers: Answers; awsKey: AwsKey | null } {
  if (!answers.mail) return { answers, awsKey: null };
  const { awsAccessKeyId, awsSecretAccessKey, ...mail } = answers.mail;
  return {
    answers: { ...answers, mail },
    awsKey:
      awsAccessKeyId && awsSecretAccessKey
        ? { accessKeyId: awsAccessKeyId, secretAccessKey: awsSecretAccessKey }
        : null,
  };
}

const MAX_LOG_LINES = 300;
/** Wrong passwords from one address before it waits LOCK_MS. */
const MAX_ATTEMPTS = 5;
/** Wrong passwords from all addresses together before everyone waits, for guessers with many. */
const MAX_TOTAL_ATTEMPTS = 50;
/** Guesses from all addresses together while that total holds, before nobody may guess. */
const MAX_HELD_ATTEMPTS = 50;
const LOCK_MS = 15 * 60 * 1000;
/** Cloudflare's limit on the keys one storage call may name. */
const MAX_KEYS_PER_CALL = 128;
/** A step that died without finishing stops counting as running after this long. */
const RUNNING_MS = 10 * 60 * 1000;
/** The AWS key can create IAM users, so an abandoned install doesn't get to keep it. */
const AWS_KEY_MS = 2 * 60 * 60 * 1000;
/**
 * An install left alone this long (no step, no new token) forgets the Cloudflare token, the
 * answers (mail keys included) and the keys it generated. The setup session lasts as long, so a
 * person still at the page is never cut off by it.
 */
export const SECRETS_IDLE_MS = 8 * 60 * 60 * 1000;
/** How many times the recovery kit can be downloaded before the person finishes. */
export const MAX_KIT_DOWNLOADS = 3;
/** Phases that hold the token or keys. */
const HOLDING = new Set<Progress['phase']>(['installing', 'save-kit']);

/** Cloudflare's own words for a token that may not do something. */
const permissionProblem = (message: string) =>
  /\b403\b|Authentication error|\b10000\b/.test(message);
const PERMISSION_HINT =
  'Your Cloudflare token is missing a permission. On Cloudflare, open the token, click Edit, add the permission for what was refused above, and save. Then try this step again.';

export class SetupRun extends DurableObject<SetupEnv> {
  private get storage() {
    return this.ctx.storage;
  }

  private store(): StateStore {
    return {
      location: 'the setup page',
      persistent: true,
      load: async () => ({
        state: (await this.storage.get<State>('state')) ?? null,
        secrets: (await this.storage.get<Secrets>('secrets')) ?? null,
      }),
      save: async (state) => {
        await this.storage.put('state', state);
      },
      saveSecrets: async (_env, secrets) => {
        await this.storage.put('secrets', secrets);
      },
    };
  }

  /**
   * Counts wrong passwords, so a stranger who finds the address can't keep guessing. Per client
   * address, so that stranger can't lock the person setting up out too, and in total as well.
   * The total only holds back addresses that have guessed wrong themselves: one that hasn't can
   * still sign in, but while it holds each wider block (an IPv6 /48 or IPv4 /24) gets a single
   * wrong guess. Those guesses count too, and after MAX_HELD_ATTEMPTS of them nobody may guess
   * until the window ends. So in no window can all addresses together make more than
   * MAX_TOTAL_ATTEMPTS + MAX_HELD_ATTEMPTS guesses, however many they have, and only someone with
   * that many wider blocks can keep the person setting up out. It also bounds the tallies kept.
   */
  async attempt(correct: boolean, client = 'unknown'): Promise<'ok' | 'wrong' | 'locked'> {
    const now = Date.now();
    const key = `attempts:${network(client)}`;
    const mine = current(await this.storage.get<Tally>(key), now);
    const all = current(await this.storage.get<Tally>('attempts'), now);
    // While the total holds, its count starts again and counts the guesses made meanwhile.
    const ceiling = all.until > now;
    const wide = `attempts:${block(client)}`;
    const held = ceiling && ((await this.storage.get<Tally>(wide))?.until ?? 0) > now;
    if (
      mine.until > now ||
      (ceiling && (mine.count > 0 || held || all.count >= MAX_HELD_ATTEMPTS))
    ) {
      return 'locked';
    }
    if (ceiling) await this.storage.put('attempts', { ...all, count: all.count + 1 });
    if (correct) {
      await this.storage.delete(key);
      return 'ok';
    }
    if (ceiling) {
      // Holds its whole /48 or /24 until the total ends, so one block can't spend the cap alone.
      await this.storage.put(wide, { count: 0, since: now, until: all.until });
      return 'wrong';
    }
    // Counted first, so nothing that goes wrong below can let a guess go uncounted.
    await this.storage.put({
      [key]: counted(mine, MAX_ATTEMPTS, now),
      attempts: counted(all, MAX_TOTAL_ATTEMPTS, now),
    });
    if (all.count === 0) await this.forgetOldTallies(now);
    return 'wrong';
  }

  /**
   * At the start of a window, forgets the addresses whose own tallies have run out, so they don't
   * pile up. Cloudflare takes at most 128 keys per delete. Only housekeeping, so a failure is
   * logged and the next window tries again.
   */
  private async forgetOldTallies(now: number) {
    try {
      const old = await this.storage.list<Tally>({ prefix: 'attempts:' });
      const stale = [...old].filter(([, tally]) => current(tally, now) !== tally).map(([k]) => k);
      for (let i = 0; i < stale.length; i += MAX_KEYS_PER_CALL) {
        await this.storage.delete(stale.slice(i, i + MAX_KEYS_PER_CALL));
      }
    } catch (error) {
      console.warn(
        `Could not clear old password tallies: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * What the token can reach, and which permissions it lacks, so a missing one shows up here and
   * not halfway through the install. These are all reads, so they can't tell Read from Edit.
   */
  async lookUp(token: string) {
    const transport = new WorkerTransport();
    const cf = new CloudflareApi(transport, token, 'setup token');
    const accounts = await cf.list<{ id: string; name: string }>('/accounts');
    const zones = await cf.list<{ id: string; name: string; account?: { id?: string } }>('/zones');
    const account = zones[0]?.account?.id ?? accounts[0]?.id;
    const refused = async (path: string) => {
      const { status } = await transport.http({
        method: 'GET',
        url: `https://api.cloudflare.com/client/v4${path}`,
        headers: { authorization: `Bearer ${token}` },
      });
      return status === 401 || status === 403;
    };
    const checks: { label: string; path: string }[] = [
      ...(account
        ? [
            { label: 'Account > Workers Scripts > Edit', path: `/workers/scripts` },
            { label: 'Account > Workers KV Storage > Edit', path: `/storage/kv/namespaces` },
            { label: 'Account > Workers R2 Storage > Edit', path: `/r2/buckets` },
            { label: 'Account > D1 > Edit', path: `/d1/database` },
            { label: 'Account > Queues > Edit', path: `/queues` },
            { label: 'Account > Turnstile > Edit', path: `/challenges/widgets` },
          ].map((c) => ({ ...c, path: `/accounts/${account}${c.path}` }))
        : []),
      ...(zones[0]
        ? [
            { label: 'Zone > DNS > Edit', path: `/dns_records` },
            { label: 'Zone > Workers Routes > Edit', path: `/workers/routes` },
            { label: 'Zone > Zone Settings > Edit', path: `/settings/ssl` },
            { label: 'Zone > Email Routing Rules > Edit', path: `/email/routing/rules` },
          ].map((c) => ({ ...c, path: `/zones/${zones[0]?.id}${c.path}` }))
        : []),
    ];
    const results = await Promise.all(
      checks.map(async (c) => ({ label: c.label, refused: await refused(c.path) })),
    );
    return {
      accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
      zones: zones.map((z) => ({ name: z.name, account: z.account?.id ?? null })),
      missing: results.filter((r) => r.refused).map((r) => r.label),
    };
  }

  /** For a step that failed on the token's permissions, when the person made a new one. */
  async replaceToken(token: string): Promise<Progress> {
    if ((await this.storage.get<Progress['phase']>('phase')) === 'installing') {
      await this.storage.put('token', token);
      await this.storage.delete('failed');
      await this.touch();
    }
    return this.progress();
  }

  /**
   * Starts an install. Only once: a second begin (another tab, or someone with a session) while
   * an install holds a token, after it finished or after it expired changes nothing, so it can't
   * swap the token or the answers of a running install.
   */
  async begin(token: string, given: Answers): Promise<Progress> {
    const phase = (await this.storage.get<Progress['phase']>('phase')) ?? 'answers';
    if (phase !== 'answers') return this.progress();
    const { answers, awsKey } = withoutAwsKey(given);
    await this.storage.put({ token, answers, phase: 'installing' });
    if (awsKey) await this.keepAwsKey(awsKey);
    await this.touch();
    // Opened now, so the page can show the release and ask for approval before any step runs.
    try {
      await this.offer();
    } catch (error) {
      await this.recordFailure(error, secretValues({ token, awsKey, answers }));
    }
    return this.progress();
  }

  private async keepAwsKey(key: AwsKey) {
    await this.storage.put({ awsKey: key, awsKeyUntil: Date.now() + AWS_KEY_MS });
    await this.schedule();
  }

  private async forgetAwsKey() {
    await this.storage.delete(['awsKey', 'awsKeyUntil']);
    await this.schedule();
  }

  /** Something happened in the install: the idle clock starts again. */
  private async touch() {
    await this.storage.put('touched', Date.now());
    await this.schedule();
  }

  /** One alarm: the AWS key's end, or the end of the idle bound, whichever is first. */
  private async schedule() {
    const phase = (await this.storage.get<Progress['phase']>('phase')) ?? 'answers';
    const awsUntil = (await this.storage.get<AwsKey>('awsKey'))
      ? ((await this.storage.get<number>('awsKeyUntil')) ?? Date.now() + AWS_KEY_MS)
      : null;
    const touched = await this.storage.get<number>('touched');
    const idleUntil = HOLDING.has(phase) && touched ? touched + SECRETS_IDLE_MS : null;
    const next = [awsUntil, idleUntil].filter((t): t is number => t !== null);
    if (next.length) await this.storage.setAlarm(Math.min(...next));
    else await this.storage.deleteAlarm();
  }

  /** For an install that outlived the AWS key: it's only needed until the reports are connected. */
  async replaceAwsKey(key: AwsKey): Promise<Progress> {
    if ((await this.storage.get<Progress['phase']>('phase')) === 'installing') {
      await this.keepAwsKey(key);
      await this.storage.delete('failed');
      await this.touch();
    }
    return this.progress();
  }

  /**
   * The AWS key's time is always up when the alarm rings (it is the earliest end). An install
   * idle for SECRETS_IDLE_MS forgets everything that grants access as well.
   */
  override async alarm() {
    await this.storage.delete(['awsKey', 'awsKeyUntil']);
    const touched = (await this.storage.get<number>('touched')) ?? 0;
    const phase = (await this.storage.get<Progress['phase']>('phase')) ?? 'answers';
    if (HOLDING.has(phase) && Date.now() - touched >= SECRETS_IDLE_MS) await this.expire();
    await this.schedule();
  }

  /**
   * Forgets the token, the answers and every generated key of an abandoned install, and the
   * sign-in link. With no step done it starts again from the answers; otherwise it stays
   * `expired` with its step list and log for diagnosis (the person deletes what it made and
   * deploys this Worker again).
   */
  async expire(): Promise<Progress> {
    const done = (await this.storage.get<string[]>('done')) ?? [];
    await this.storage.delete([
      'token',
      'answers',
      'secrets',
      'awsKey',
      'awsKeyUntil',
      'kitDownloads',
    ]);
    await this.forgetSignInLink();
    if (done.length === 0) {
      await this.storage.delete(['state', 'release', 'failed', 'touched', 'report']);
      await this.storage.put('phase', 'answers');
    } else {
      await this.storage.put('phase', 'expired');
    }
    return this.progress();
  }

  private async forgetSignInLink(): Promise<string | null> {
    const report = await this.storage.get<Report>('report');
    if (!report?.signInLink) return null;
    const { signInLink, ...rest } = report;
    await this.storage.put('report', rest as Report);
    return signInLink;
  }

  /** The session generation: bumping it ends every setup session at once. */
  async sessionEpoch(): Promise<number> {
    return (await this.storage.get<number>('sessionEpoch')) ?? 0;
  }

  async endSessions(): Promise<number> {
    const next = (await this.sessionEpoch()) + 1;
    await this.storage.put('sessionEpoch', next);
    return next;
  }

  /**
   * How every open is checked: the floor, which is required, and what has been withdrawn, by the
   * project (WITHDRAWN_RELEASES, in this source) or by the operator (RELEASE_WITHDRAWN).
   */
  private openOptions() {
    const floor = this.env.RELEASE_MIN_VERSION?.trim();
    if (!floor && this.env.RELEASE_ACCEPT_ANY_VERSION !== 'true') {
      throw new InstallError(
        'RELEASE_MIN_VERSION is not set, so this page would accept any release ever signed, and nothing was installed.',
        'Set RELEASE_MIN_VERSION to the release you mean to install, the current one the Swarm project lists (docs/releasing.md), and deploy this Worker again.',
      );
    }
    return {
      baseUrl: this.env.RELEASE_URL,
      publicKeyPem: this.env.RELEASE_PUBLIC_KEY,
      ...(floor ? { minimumVersion: floor } : {}),
      withdrawn: withdrawnList(WITHDRAWN_RELEASES, this.env.RELEASE_WITHDRAWN),
    };
  }

  private withdrawn(release: Pinned): boolean {
    const list = withdrawnList(WITHDRAWN_RELEASES, this.env.RELEASE_WITHDRAWN);
    return [release.version, release.digest, release.keyId ?? ''].some((entry) =>
      list.includes(entry.toLowerCase()),
    );
  }

  /** Opens what RELEASE_URL serves, checked, and keeps it as the offer the person approves. */
  private async offer(): Promise<Offer> {
    const release = await openRelease(this.openOptions());
    const offer: Offer = {
      version: release.version,
      digest: release.digest,
      keyId: release.keyId,
      projectKey: PROJECT_RELEASE_KEYS.includes(release.keyId),
    };
    await this.storage.put('offer', offer);
    return offer;
  }

  /**
   * The person approves the exact release they were shown, by version and manifest digest. Only
   * then is it pinned, and an approval for one release never carries over to another.
   */
  async approve(version: string, digest: string): Promise<Progress | { refused: string }> {
    if ((await this.storage.get<Progress['phase']>('phase')) !== 'installing') {
      return { refused: 'There is no install waiting for its release to be approved.' };
    }
    const pinned = await this.storage.get<Pinned>('release');
    if (pinned) {
      return pinned.digest === digest && pinned.version === version
        ? this.progress()
        : { refused: 'This install already keeps to another release.' };
    }
    const offer = await this.storage.get<Offer>('offer');
    if (!offer || offer.version !== version || offer.digest !== digest) {
      return {
        refused:
          'The release on offer changed after this page showed it, so nothing was approved. Check the release shown now.',
      };
    }
    await this.storage.put('release', { digest, version, keyId: offer.keyId });
    await this.storage.delete('failed');
    return this.progress();
  }

  /**
   * The release this install keeps to. Every step and retry must get that same manifest back: any
   * release ever signed would pass the signature check, so otherwise RELEASE_URL could hand one
   * step an older release, or mix two in one install.
   */
  private async release() {
    const pinned = await this.storage.get<Pinned>('release');
    if (!pinned) throw new InstallError('Approve the release first.');
    return openRelease({
      ...this.openOptions(),
      expected: { digest: pinned.digest, version: pinned.version },
    });
  }

  /**
   * For an install whose approved release was withdrawn part way. The replacement is offered for
   * approval, and the database and Worker steps run again from it, so nothing deployed from the
   * withdrawn release is left in place and no two releases are mixed.
   */
  async replaceRelease(): Promise<Progress> {
    const phase = await this.storage.get<Progress['phase']>('phase');
    const pinned = await this.storage.get<Pinned>('release');
    if (phase === 'installing' && pinned && this.withdrawn(pinned)) {
      const done = (await this.storage.get<string[]>('done')) ?? [];
      await this.storage.put(
        'done',
        done.filter((id) => id !== 'migrations' && !id.startsWith('deploy-')),
      );
      await this.storage.delete(['release', 'offer', 'failed']);
      try {
        await this.offer();
      } catch (error) {
        await this.recordFailure(
          error,
          secretValues({
            token: await this.storage.get<string>('token'),
            answers: await this.storage.get<Answers>('answers'),
            secrets: await this.storage.get<Secrets>('secrets'),
          }),
        );
      }
    }
    return this.progress();
  }

  /** Step titles need the release's step list, which doesn't need the release to be read yet. */
  private stepList() {
    return wizardSteps({
      version: '',
      files: [],
      linkSigning: 'v1',
      text: async () => '',
      bytes: async () => new Uint8Array(),
    }).map((step) => ({ id: step.id, title: step.title }));
  }

  async progress(): Promise<Progress> {
    const done = (await this.storage.get<string[]>('done')) ?? [];
    const report = await this.storage.get<Report>('report');
    const phase = (await this.storage.get<Progress['phase']>('phase')) ?? 'answers';
    const failed = (await this.storage.get<Progress['failed']>('failed')) ?? null;
    const pinned = await this.storage.get<Pinned>('release');
    return {
      phase,
      steps: this.stepList().map((step) => ({ ...step, done: done.includes(step.id) })),
      failed,
      log: (await this.storage.get<string[]>('log')) ?? [],
      signInLink: report?.signInLink ?? null,
      testEmailTo: report?.testEmailTo ?? null,
      mailNote: report?.mailNote ?? null,
      publicationUrl: await this.publicationUrl(),
      needsAwsKey: phase === 'installing' && !!failed && (await this.awsKeyStillNeeded()),
      release: pinned?.version ?? null,
      offer: (await this.storage.get<Offer>('offer')) ?? null,
      approved: !!pinned,
      withdrawn: !!pinned && this.withdrawn(pinned),
      kitDownloadsLeft: Math.max(
        0,
        MAX_KIT_DOWNLOADS - ((await this.storage.get<number>('kitDownloads')) ?? 0),
      ),
    };
  }

  private async awsKeyStillNeeded(): Promise<boolean> {
    const answers = await this.storage.get<Answers>('answers');
    if (answers?.mail?.provider !== 'ses' || (await this.storage.get<AwsKey>('awsKey'))) {
      return false;
    }
    return !(await this.storage.get<State>('state'))?.ses?.subscriptionConfirmed;
  }

  private async publicationUrl(): Promise<string | null> {
    const state = await this.storage.get<State>('state');
    const choices = state?.choices;
    if (!state?.zone || !choices) return null;
    return choices.addresses?.publicationAtRoot
      ? `https://${state.zone.name}`
      : `https://${choices.publication.slug}.${state.zone.name}`;
  }

  /** Runs the next step. A failed step stays next, so asking again retries it. */
  async runNext(): Promise<Progress> {
    const running = await this.storage.get<number>('running');
    if (running && Date.now() - running < RUNNING_MS) return this.progress();
    const token = await this.storage.get<string>('token');
    const answers = await this.storage.get<Answers>('answers');
    if (!token || !answers) return this.progress();

    await this.storage.put('running', Date.now());
    await this.touch();
    const log = (await this.storage.get<string[]>('log')) ?? [];
    const awsKey = await this.storage.get<AwsKey>('awsKey');
    const hidden = secretValues({
      token,
      awsKey,
      answers,
      secrets: await this.storage.get<Secrets>('secrets'),
    });
    try {
      if (!(await this.storage.get<Pinned>('release'))) {
        // Nothing runs before the person has approved a release: this only refreshes the offer.
        await this.offer();
        await this.storage.delete('failed');
        return await this.progress();
      }
      const release = await this.release();
      const done = (await this.storage.get<string[]>('done')) ?? [];
      const step = wizardSteps(release).find((s) => !done.includes(s.id));
      if (!step) {
        await this.storage.put('phase', 'save-kit');
        return await this.progress();
      }
      const store = this.store();
      const { state, secrets } = await store.load('production');
      const report = (await this.storage.get<Report>('report')) ?? { unhealthy: [] };
      const accountId = await this.storage.get<string>('accountId');
      const ctx = wizardContext({
        transport: new WorkerTransport(),
        store,
        state,
        secrets,
        answers,
        token,
        ...(accountId ? { accountId } : {}),
        ...(awsKey ? { awsAdmin: awsKey } : {}),
        report,
        release,
        log: (text) => {
          for (const line of text.split('\n')) if (line.trim()) log.push(scrub(line, hidden));
        },
      });
      try {
        await step.run(ctx);
      } finally {
        // Keys this step generated are hidden from its own error text too.
        hidden.push(...secretValues({ secrets: ctx.secrets }));
      }
      await store.save(ctx.state);
      await store.saveSecrets('production', ctx.secrets);
      // Nothing later needs it: the Workers send with their own key from here on.
      if (ctx.state.ses?.subscriptionConfirmed) await this.forgetAwsKey();
      await this.storage.put({
        done: [...done, step.id],
        report: ctx.report,
        ...(ctx.session.accountId ? { accountId: ctx.session.accountId } : {}),
      });
      await this.storage.delete('failed');
    } catch (error) {
      await this.recordFailure(error, hidden);
    } finally {
      await this.storage.put(
        'log',
        log.slice(-MAX_LOG_LINES).map((line) => scrub(line, hidden)),
      );
      await this.storage.delete('running');
    }
    return this.progress();
  }

  /** Keeps the next step's failure for the page, which offers to try that step again. */
  private async recordFailure(error: unknown, hidden: string[]) {
    const message = error instanceof Error ? error.message : String(error);
    const done = (await this.storage.get<string[]>('done')) ?? [];
    const next = this.stepList().find((s) => !done.includes(s.id));
    await this.storage.put('failed', {
      step: next?.title ?? '',
      message: scrub(message, hidden).slice(0, 1000),
      ...(permissionProblem(message)
        ? { hint: PERMISSION_HINT }
        : error instanceof InstallError && error.fix
          ? { hint: scrub(error.fix, hidden) }
          : {}),
    });
  }

  /**
   * The keys, once the install is done, sealed under a passphrase the person chooses here, so the
   * file alone yields no key. Losing FIELD_KEYS loses encrypted subscriber fields (on Cloudflare
   * the vault worker holds them, and it has no route), and losing the passphrase loses the kit:
   * the page says so. The passphrase is used for this answer only.
   * Handed over at most MAX_KIT_DOWNLOADS times (a failed download can be tried again, but a
   * session can't keep copying every secret).
   */
  async recoveryKit(passphrase: string) {
    const phase = await this.storage.get<Progress['phase']>('phase');
    if (phase !== 'save-kit') return null;
    const downloads = (await this.storage.get<number>('kitDownloads')) ?? 0;
    if (downloads >= MAX_KIT_DOWNLOADS) return null;
    await this.storage.put('kitDownloads', downloads + 1);
    const state = await this.storage.get<State>('state');
    const secrets = (await this.storage.get<Secrets>('secrets')) ?? emptySecrets();
    return sealKit({ state, secrets }, passphrase, {
      what: 'The recovery kit for your Swarm install, encrypted under the passphrase you chose. Keep the file and the passphrase apart. See the setup guide for when you need it.',
      createdAt: new Date().toISOString(),
      domain: state?.zone?.name ?? null,
    });
  }

  /**
   * Forgets the Cloudflare token and every key, now that the person has saved the kit, and the
   * failure text and log of the steps. The sign-in link is in this answer only: it is not kept,
   * so a later session can't read it.
   */
  async finish(): Promise<Progress> {
    if ((await this.storage.get<Progress['phase']>('phase')) === 'save-kit') {
      await this.storage.delete(['token', 'secrets', 'answers', 'failed', 'log', 'kitDownloads']);
      await this.storage.put('phase', 'finished');
      await this.forgetAwsKey();
      const signInLink = await this.forgetSignInLink();
      return { ...(await this.progress()), signInLink };
    }
    return this.progress();
  }
}
