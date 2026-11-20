import { randomBytes } from 'node:crypto';
import {
  base64UrlEncode,
  FAMILIES,
  KEYRING_ALGS,
  newEd25519Secret,
  publicKeyring,
  verifyKeysName,
  type KeyringName,
} from '@swarm/tokens';
import { DEPLOY_ORDER, WORKERS, type Worker } from './paths';
import type { Features, MailProvider, Secrets, State } from './state';
import { InstallError } from './ui';

export type { KeyringName };

/** A Worker that can hold a key (the vault among them). */
export type KeyHolder = Worker;

/**
 * One keyring: who signs (holds the private or shared key), who verifies (holds the public key for
 * Ed25519, else the shared key), and how it rotates. The installer gives each worker exactly the
 * keyrings this says, `pnpm swarm rotate-keys` pushes them to the same workers, and the prune step
 * removes any it no longer should have.
 */
interface KeyringEntry {
  name: KeyringName;
  alg: (typeof KEYRING_ALGS)[KeyringName];
  signers: readonly KeyHolder[];
  verifiers: readonly KeyHolder[];
  /** How long after a rotation the old key must still verify: the longest life of what it signs. */
  maxLinkLifetimeDays: number | null;
  /**
   * two-phase: the new key reaches every holder before it signs. reseal: stored values are sealed
   * again with the new key before the old one goes (FIELD_KEYS).
   */
  rotation: 'two-phase' | 'reseal';
  /**
   * MEMBER_KEYS only: who held it before the cutover. After it, nothing signs with it, and each
   * verifier keeps it until the last v1 link it may accept has expired (linkKeyWindows).
   */
  legacyHolders?: readonly Worker[];
}

const ring = (entry: KeyringEntry): KeyringEntry => {
  if (KEYRING_ALGS[entry.name] !== entry.alg) throw new Error(`${entry.name}: wrong algorithm`);
  return entry;
};

/** Every keyring, in the order keys are generated and listed. */
export const KEY_REGISTRY: readonly KeyringEntry[] = [
  // Unchanged: api-internal state and download links; reader sign-in; opens and clicks.
  ring({
    name: 'AUTH_KEYS',
    alg: 'hmac-sha256',
    signers: ['api'],
    verifiers: ['api'],
    maxLinkLifetimeDays: 1,
    rotation: 'two-phase',
  }),
  ring({
    name: 'TRACK_KEYS',
    alg: 'hmac-sha256',
    signers: ['send'],
    verifiers: ['track'],
    maxLinkLifetimeDays: 400,
    rotation: 'two-phase',
  }),
  // Unsubscribe codes carry no key id and never expire; bounce codes are good for 7 days at events.
  ring({
    name: 'UNSUBSCRIBE_KEYS',
    alg: 'hmac-sha256',
    signers: ['send', 'api'],
    verifiers: ['track', 'events'],
    maxLinkLifetimeDays: null,
    rotation: 'two-phase',
  }),
  ring({
    name: 'BOUNCE_KEYS',
    alg: 'hmac-sha256',
    signers: ['send'],
    verifiers: ['events'],
    maxLinkLifetimeDays: 7,
    rotation: 'two-phase',
  }),
  ring({
    name: 'READER_KEYS',
    alg: 'hmac-sha256',
    signers: ['site'],
    verifiers: ['site'],
    maxLinkLifetimeDays: 90,
    rotation: 'two-phase',
  }),
  ring({
    name: 'CONFIRM_KEYS',
    alg: 'hmac-sha256',
    signers: ['api', 'capture', 'site'],
    verifiers: ['capture'],
    maxLinkLifetimeDays: 30,
    rotation: 'two-phase',
  }),
  ring({
    name: 'CAPTURE_KEYS',
    alg: 'hmac-sha256',
    signers: ['capture'],
    verifiers: ['capture'],
    maxLinkLifetimeDays: 1,
    rotation: 'two-phase',
  }),
  ring({
    name: 'FORM_STAMP_KEYS',
    alg: 'hmac-sha256',
    signers: ['capture', 'site'],
    verifiers: ['capture'],
    maxLinkLifetimeDays: 90,
    rotation: 'two-phase',
  }),
  ring({
    name: 'SIGNUP_KEYS',
    alg: 'hmac-sha256',
    signers: ['vault'],
    verifiers: ['vault'],
    maxLinkLifetimeDays: 1,
    rotation: 'two-phase',
  }),
  // The vault's alone. Join and journey links carry values sealed with it for a day; stored values
  // are sealed again by the vault's cron.
  ring({
    name: 'FIELD_KEYS',
    alg: 'aes-256-gcm',
    signers: ['vault'],
    verifiers: ['vault'],
    maxLinkLifetimeDays: 1,
    rotation: 'reseal',
  }),
  ring({
    name: 'MEMBER_SIGNING_KEYS',
    alg: 'ed25519',
    signers: ['send', 'jobs', 'vault'],
    verifiers: ['capture', 'vault'],
    maxLinkLifetimeDays: 30,
    rotation: 'two-phase',
  }),
  ring({
    name: 'ASK_SIGNING_KEYS',
    alg: 'ed25519',
    signers: ['send'],
    verifiers: ['capture'],
    maxLinkLifetimeDays: 90,
    rotation: 'two-phase',
  }),
  ring({
    name: 'ASK_PAGE_SIGNING_KEYS',
    alg: 'ed25519',
    signers: ['capture'],
    verifiers: ['site'],
    maxLinkLifetimeDays: 7,
    rotation: 'two-phase',
  }),
  ring({
    name: 'DSR_EXPORT_SIGNING_KEYS',
    alg: 'ed25519',
    signers: ['jobs'],
    verifiers: ['capture'],
    maxLinkLifetimeDays: 7,
    rotation: 'two-phase',
  }),
  ring({
    name: 'GOODS_SIGNING_KEYS',
    alg: 'ed25519',
    signers: ['vault'],
    verifiers: ['site'],
    maxLinkLifetimeDays: 90,
    rotation: 'two-phase',
  }),
  ring({
    name: 'CHECKOUT_SIGNING_KEYS',
    alg: 'ed25519',
    signers: ['site'],
    verifiers: ['api'],
    maxLinkLifetimeDays: 30,
    rotation: 'two-phase',
  }),
  // Design previews: the api signs, the site verifies.
  ring({
    name: 'SITE_LINK_SIGNING_KEYS',
    alg: 'ed25519',
    signers: ['api'],
    verifiers: ['site'],
    maxLinkLifetimeDays: 90,
    rotation: 'two-phase',
  }),
  // Sponsor reports: the api signs, and jobs emails sponsors new report links once the 365-day
  // ones from before the cutover stop working (90 days after it). Their own ring, so jobs holds no
  // preview key; reports signed with SITE_LINK_SIGNING_KEYS before keep verifying for 90 days.
  ring({
    name: 'SPONSOR_REPORT_SIGNING_KEYS',
    alg: 'ed25519',
    signers: ['api', 'jobs'],
    verifiers: ['site'],
    maxLinkLifetimeDays: 90,
    rotation: 'two-phase',
  }),
  // Before the cutover it signs every link family; sponsor reports lived 365 days.
  ring({
    name: 'MEMBER_KEYS',
    alg: 'hmac-sha256',
    signers: [],
    verifiers: [],
    // The vault signs Member Center and goods links with it until the cutover, as the workers it
    // signs for did; after it, it checks v1 member links for their 30 days.
    legacyHolders: ['api', 'send', 'jobs', 'capture', 'site', 'vault'],
    maxLinkLifetimeDays: 365,
    rotation: 'two-phase',
  }),
];

export const KEYRING_NAMES: readonly KeyringName[] = KEY_REGISTRY.map((entry) => entry.name);

export function keyringEntry(name: KeyringName): KeyringEntry {
  const entry = KEY_REGISTRY.find((e) => e.name === name);
  if (!entry) throw new Error(`no keyring ${name}`);
  return entry;
}

/** The cutover from MEMBER_KEYS to per-family keyrings, as state.linkKeys records it. */
export type LinkKeys = NonNullable<State['linkKeys']>;

const signsWith = (entry: KeyringEntry, holder: KeyHolder) => entry.signers.includes(holder);
const verifiesWith = (entry: KeyringEntry, holder: KeyHolder) => entry.verifiers.includes(holder);

/**
 * When each holder may let go of MEMBER_KEYS after a cutover at `cutoffAt`: once no v1 link a
 * family of its verifies can still be accepted (@swarm/tokens verifyLink). Holders that only
 * signed are not listed: they let go at the cutover.
 */
export function linkKeyWindows(cutoffAt: number): Partial<Record<KeyHolder, number>> {
  const until: Partial<Record<KeyHolder, number>> = {};
  for (const spec of Object.values(FAMILIES)) {
    if (!spec.legacy) continue;
    const entry = keyringEntry(spec.keyring);
    const end = cutoffAt + spec.legacy.acceptForSeconds * 1000;
    for (const holder of entry.verifiers) {
      until[holder] = Math.max(until[holder] ?? 0, end);
    }
  }
  return until;
}

/** The keyrings a worker holds, by secret name, in registry order. */
export function keySecretNames(worker: Worker, linkKeys: LinkKeys | undefined, now: number) {
  const names: string[] = [];
  for (const entry of KEY_REGISTRY) {
    if (entry.legacyHolders) {
      const holds =
        linkKeys?.mode === 'v2'
          ? (linkKeys.legacyUntil?.[worker] ?? 0) > now
          : entry.legacyHolders.includes(worker);
      if (holds) names.push(entry.name);
      continue;
    }
    const signs = signsWith(entry, worker);
    const verifies = verifiesWith(entry, worker);
    if (entry.alg === 'ed25519') {
      if (signs) names.push(entry.name);
      if (verifies) names.push(verifyKeysName(entry.name));
    } else if (signs || verifies) {
      names.push(entry.name);
    }
  }
  return names;
}

/** Every secret name the key registry manages: only these does the prune step ever remove. */
export const KEY_SECRET_NAMES: ReadonlySet<string> = new Set(
  KEY_REGISTRY.flatMap((entry) =>
    entry.alg === 'ed25519' ? [entry.name, verifyKeysName(entry.name)] : [entry.name],
  ),
);

/** The workers that hold an Ed25519 keyring's public keys, or a shared keyring, to verify. */
export function verifierWorkers(name: KeyringName): Worker[] {
  const entry = keyringEntry(name);
  return WORKERS.filter((worker) => verifiesWith(entry, worker));
}

/**
 * Where a new install or one from before per-family keys starts: a fresh one goes straight to v2
 * when the code can sign it (no link is in anyone's inbox yet), anything else verifies v2 first.
 */
export function initialLinkKeys(fresh: boolean, v2Ready: boolean, now: number): LinkKeys {
  return fresh && v2Ready ? { mode: 'v2', cutoffAt: now, legacyUntil: {} } : { mode: 'verify-v2' };
}

/** The second pass: signers switch to v2 now, and each verifier's MEMBER_KEYS window starts. */
export function cutOverLinkKeys(now: number): LinkKeys {
  const windows = linkKeyWindows(now);
  const legacyUntil: Record<string, number> = {};
  for (const worker of WORKERS) {
    const until = windows[worker];
    if (until) legacyUntil[worker] = until;
  }
  return { mode: 'v2', cutoffAt: now, legacyUntil };
}

/** The workers whose secrets or LINK_* vars the cutover changes: they deploy in the second pass. */
export const LINK_WORKERS: readonly Worker[] = WORKERS.filter((worker) =>
  KEY_REGISTRY.some(
    (entry) =>
      !['AUTH_KEYS', 'TRACK_KEYS', 'UNSUBSCRIBE_KEYS', 'READER_KEYS'].includes(entry.name) &&
      (signsWith(entry, worker) ||
        verifiesWith(entry, worker) ||
        !!entry.legacyHolders?.includes(worker)),
  ),
);

/** `k<yyyymmdd>:<base64url of 48 random bytes>`: one key, valid for @swarm/tokens parseKeyring. */
export function newKeyring(now: Date = new Date()): string {
  return `${kidFor(now)}:${newSymmetricSecret()}`;
}

const kidFor = (now: Date) => `k${now.toISOString().slice(0, 10).replaceAll('-', '')}`;
const newSymmetricSecret = () => base64UrlEncode(new Uint8Array(randomBytes(48)));

/** A new key's secret for a keyring: 48 random bytes, or an Ed25519 private key (PKCS#8). */
export async function newSecretFor(name: KeyringName): Promise<string> {
  return KEYRING_ALGS[name] === 'ed25519' ? newEd25519Secret() : newSymmetricSecret();
}

/**
 * Adds any keyring that is missing. Existing keyrings are never replaced. MEMBER_KEYS only while
 * the install still uses it (`legacy`): a fresh install on v2 never has one.
 */
export async function ensureKeyrings(
  secrets: Secrets,
  options: { now?: Date; legacy?: boolean } = {},
): Promise<KeyringName[]> {
  const created: KeyringName[] = [];
  for (const entry of KEY_REGISTRY) {
    if (secrets.keys[entry.name]) continue;
    if (entry.legacyHolders && options.legacy === false) continue;
    secrets.keys[entry.name] =
      `${kidFor(options.now ?? new Date())}:${await newSecretFor(entry.name)}`;
    created.push(entry.name);
  }
  return created;
}

/** Secrets other than keyrings that a worker needs whatever is configured. */
const BASE_SECRETS: Record<Worker, readonly string[]> = {
  // Only keyrings: FIELD_KEYS and the link keys it signs for others (KEY_REGISTRY).
  vault: [],
  api: ['TURNSTILE_SECRET_KEY'],
  send: [],
  jobs: [],
  capture: ['TURNSTILE_SECRET_KEY'],
  site: ['TURNSTILE_SECRET_KEY'],
  track: [],
  events: [],
  realtime: [],
};

/**
 * Secrets each worker needs whatever is configured, before the link cutover: what local
 * development runs with (each workers/*\/.dev.vars.example), cross-checked against the workers'
 * env schemas (workers/*\/src/env.ts, events and track in src/index.ts) and docs/deployment.md.
 * Mail credentials are added per provider by secretNames(); MEMBER_KEYS follows state.linkKeys.
 */
export const SECRET_MATRIX: Record<Worker, readonly string[]> = Object.fromEntries(
  WORKERS.map((worker) => [
    worker,
    [...keySecretNames(worker, undefined, 0), ...BASE_SECRETS[worker]],
  ]),
) as unknown as Record<Worker, readonly string[]>;

/** Workers that send mail, so they carry the provider's credentials. */
export const MAIL_WORKERS: readonly Worker[] = ['api', 'send', 'jobs', 'capture', 'site'];

export const MAIL_SECRETS: Record<MailProvider, readonly string[]> = {
  ses: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
  resend: ['RESEND_API_KEY'],
  mailgun: ['MAILGUN_API_KEY'],
  postmark: ['POSTMARK_SERVER_TOKEN', 'POSTMARK_ACCOUNT_TOKEN'],
  smtp: ['SMTP_USERNAME', 'SMTP_PASSWORD'],
};

/** Optional features and the secrets they add, per worker. */
const FEATURE_SECRETS: Record<keyof Features, Partial<Record<Worker, readonly string[]>>> = {
  customDomains: {
    api: ['CF_ZONE_ID', 'CF_API_TOKEN'],
    send: ['CF_ZONE_ID', 'CF_API_TOKEN'],
    jobs: ['CF_ZONE_ID', 'CF_API_TOKEN'],
  },
  payments: {
    api: ['STRIPE_SECRET_KEY', 'STRIPE_CONNECT_CLIENT_ID', 'STRIPE_WEBHOOK_SECRETS'],
    jobs: ['STRIPE_SECRET_KEY'],
    // The provider proxy: Checkout and the Member Center's billing for Channels without their own
    // key. capture and site make those calls through the vault and hold no Stripe key.
    vault: ['STRIPE_SECRET_KEY'],
  },
  google: { api: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] },
  // Email checks: the api shows the balance and plans checks, jobs runs the checks of lists and
  // imports, and the vault the signup check capture asks for through its proxy.
  debounce: {
    api: ['DEBOUNCE_API_KEY'],
    jobs: ['DEBOUNCE_API_KEY'],
    vault: ['DEBOUNCE_API_KEY'],
  },
};

/** The workers that hold a feature's secrets, in deploy order: what turning it on redeploys. */
export function featureWorkers(feature: keyof Features): Worker[] {
  return DEPLOY_ORDER.filter((worker) => !!FEATURE_SECRETS[feature][worker]?.length);
}

interface SecretContext {
  provider: MailProvider;
  /** The service being left. Its reports still count for a while, so its webhook secret stays. */
  draining?: MailProvider | undefined;
  features: Features;
  /** RESEND_WEBHOOK_SECRET exists only once the webhook has been created (after deploy). */
  resendWebhookSecret: boolean;
  /** Where the link cutover is; absent: before it, as an install from before per-family keys. */
  linkKeys?: LinkKeys | undefined;
  /** For the MEMBER_KEYS windows; defaults to the clock. */
  now?: number;
}

/** The names of every secret a worker should have, in a stable order. */
export function secretNames(worker: Worker, ctx: SecretContext): string[] {
  const names = [
    ...keySecretNames(worker, ctx.linkKeys, ctx.now ?? Date.now()),
    ...BASE_SECRETS[worker],
  ];
  if (MAIL_WORKERS.includes(worker)) names.push(...MAIL_SECRETS[ctx.provider]);
  const reporting = (provider: MailProvider) =>
    worker === 'events' && (ctx.provider === provider || ctx.draining === provider);
  if (reporting('resend') && ctx.resendWebhookSecret) names.push('RESEND_WEBHOOK_SECRET');
  if (reporting('mailgun')) names.push('MAILGUN_WEBHOOK_SIGNING_KEY');
  if (reporting('postmark')) names.push('POSTMARK_WEBHOOK_SECRET');
  if (reporting('smtp')) names.push('SMTP_FEEDBACK_SECRET');
  for (const feature of Object.keys(FEATURE_SECRETS) as (keyof Features)[]) {
    if (ctx.features[feature]) names.push(...(FEATURE_SECRETS[feature][worker] ?? []));
  }
  return names;
}

export function secretValueFor(name: string, state: State, secrets: Secrets): string | undefined {
  if ((KEYRING_NAMES as readonly string[]).includes(name)) return secrets.keys[name];
  switch (name) {
    case 'TURNSTILE_SECRET_KEY':
      return secrets.turnstileSecret;
    case 'AWS_ACCESS_KEY_ID':
      return secrets.aws?.accessKeyId;
    case 'AWS_SECRET_ACCESS_KEY':
      return secrets.aws?.secretAccessKey;
    case 'RESEND_API_KEY':
      return secrets.resendApiKey;
    case 'RESEND_WEBHOOK_SECRET':
      return secrets.resendWebhookSecret;
    case 'MAILGUN_API_KEY':
      return secrets.mailgunApiKey;
    case 'MAILGUN_WEBHOOK_SIGNING_KEY':
      return secrets.mailgunWebhookSigningKey;
    case 'POSTMARK_SERVER_TOKEN':
      return secrets.postmarkServerToken;
    case 'POSTMARK_ACCOUNT_TOKEN':
      return secrets.postmarkAccountToken;
    case 'POSTMARK_WEBHOOK_SECRET':
      return secrets.postmarkWebhookSecret;
    case 'SMTP_USERNAME':
      return secrets.smtp?.username;
    case 'SMTP_PASSWORD':
      return secrets.smtp?.password;
    case 'SMTP_FEEDBACK_SECRET':
      return secrets.smtpFeedbackSecret;
    case 'CF_ZONE_ID':
      return state.zone?.id;
    case 'CF_API_TOKEN':
      return secrets.cfApiToken;
    case 'STRIPE_SECRET_KEY':
      return secrets.stripe?.secretKey;
    case 'STRIPE_CONNECT_CLIENT_ID':
      return secrets.stripe?.connectClientId;
    case 'STRIPE_WEBHOOK_SECRETS':
      return secrets.stripe?.webhookSecrets;
    case 'GOOGLE_CLIENT_ID':
      return secrets.google?.clientId;
    case 'GOOGLE_CLIENT_SECRET':
      return secrets.google?.clientSecret;
    case 'DEBOUNCE_API_KEY':
      return secrets.debounceApiKey;
    default:
      return undefined;
  }
}

export function secretContext(state: State, secrets: Secrets): SecretContext {
  const change = state.mailChange;
  const moving = change?.phase === 'cutting_over' || change?.phase === 'cut_over';
  return {
    provider: state.choices?.mail.provider ?? 'resend',
    draining: moving ? change.from.provider : undefined,
    features: state.features,
    resendWebhookSecret: !!secrets.resendWebhookSecret,
    linkKeys: state.linkKeys,
  };
}

/** The keyring an Ed25519 `<NAME>_VERIFY_KEYS` secret is derived from, or undefined. */
function signingRingOf(name: string): KeyringName | undefined {
  return KEY_REGISTRY.find((e) => e.alg === 'ed25519' && verifyKeysName(e.name) === name)?.name;
}

/**
 * The secrets file wrangler deploy uploads for one worker. Fails if any value is missing. Public
 * keys (`<NAME>_VERIFY_KEYS`) are derived from the private keyring each time, so they never drift.
 */
export async function secretValues(
  worker: Worker,
  state: State,
  secrets: Secrets,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of secretNames(worker, secretContext(state, secrets))) {
    const ring = signingRingOf(name);
    const source = ring ? secrets.keys[ring] : undefined;
    const value = ring
      ? source && (await publicKeyring(ring, source))
      : secretValueFor(name, state, secrets);
    if (value) out[name] = value;
    else missing.push(name);
  }
  if (missing.length > 0) {
    throw new InstallError(
      `The ${worker} worker needs ${missing.join(', ')}, which the installer does not have yet.`,
      'Run `pnpm swarm` again so the earlier steps can create them.',
    );
  }
  return out;
}
