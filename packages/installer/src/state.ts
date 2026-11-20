import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isSealedSecretsFile,
  newSecretsKey,
  openSecretsFile,
  sealSecretsFile,
  type SealingKey,
} from './kit';
import { stateDir, type EnvName } from './paths';
import {
  array,
  bool,
  num,
  object,
  oneOf,
  optional,
  record,
  str,
  ShapeError,
  type Check,
} from './validate';

export type MailProvider = 'ses' | 'resend' | 'mailgun' | 'postmark' | 'smtp';

export const RESEND_REGIONS = ['us-east-1', 'eu-west-1', 'sa-east-1', 'ap-northeast-1'] as const;

export const MAILGUN_REGIONS = ['us', 'eu'] as const;

const dnsRecord = object({
  type: oneOf('TXT', 'CNAME', 'MX', 'AAAA'),
  name: str,
  content: str,
  priority: optional(num),
  proxied: optional(bool),
});
export type DnsRecordSpec = ReturnType<typeof dnsRecord>;

const features = object({
  customDomains: bool,
  payments: bool,
  google: bool,
  /** Email checks with DeBounce (`enable debounce`). Older installs have no key. */
  debounce: optional(bool),
});
export type Features = ReturnType<typeof features>;

const mailChoice = object({
  provider: oneOf('ses', 'resend', 'mailgun', 'postmark', 'smtp'),
  region: str,
  /** A person's own mail server. The login is in the secrets file. */
  smtp: optional(object({ host: str, port: str, dkimSelector: str, bounceDomains: optional(str) })),
});

const choices = object({
  owner: object({ name: str, email: str }),
  publication: object({ name: str, slug: str }),
  mail: mailChoice,
  /** Where the dashboard and the first publication live. Left out means the defaults. */
  addresses: optional(object({ dashboard: optional(str), publicationAtRoot: optional(bool) })),
  /** Proxied subdomains the person keeps away from the *.D/* Channel-site route. */
  excludeHosts: array(str),
});
const stateShape = object({
  version: oneOf(1),
  env: oneOf('production', 'staging'),
  account: optional(object({ id: str, name: str })),
  zone: optional(object({ id: str, name: str })),
  choices: optional(choices),
  features,
  resources: object({
    d1: optional(object({ id: str, name: str })),
    kv: optional(object({ id: str, title: str })),
    r2: array(str),
    queues: array(str),
  }),
  turnstile: optional(object({ sitekey: str })),
  /** A change of email service under way. `choices.mail` stays the old one until the cut-over. */
  mailChange: optional(
    object({
      id: str,
      phase: oneOf('preparing', 'prepared', 'cutting_over', 'cut_over'),
      from: mailChoice,
      fromRecords: array(dnsRecord),
      startedAt: num,
      to: optional(mailChoice),
      toRecords: optional(array(dnsRecord)),
      /** Reports from the old service still count until then, so its keys stay on the events Worker. */
      drainUntil: optional(num),
    }),
  ),
  ses: optional(
    object({
      awsAccountId: str,
      topicArn: str,
      iamUser: str,
      dkimTokens: array(str),
      productionAccess: optional(bool),
      subscriptionConfirmed: optional(bool),
      /** The topic's SNS signature version; older installs have none, and it was never set. */
      topicSignatureVersion: optional(str),
      /** The IAM actions last applied to the workers' policy; older installs have none. */
      workerActions: optional(array(str)),
    }),
  ),
  resend: optional(object({ domainId: str, status: optional(str), webhookId: optional(str) })),
  mailgun: optional(object({ domain: str, status: optional(str) })),
  postmark: optional(
    object({
      serverId: num,
      domainId: num,
      dkimVerified: optional(bool),
      /** Who handles unsubscribes on the broadcast stream: Custom (Swarm) or Postmark. */
      unsubscribeHandling: optional(str),
    }),
  ),
  /** Mail records the provider asked for; the dns step writes them into the zone. */
  mailRecords: optional(array(dnsRecord)),
  bootstrap: optional(object({ operatorId: str, workspaceId: str, channelId: optional(str) })),
  /**
   * The last `rotate-keys` of each keyring: the new key's id, when, and whether every worker has
   * it yet. Key ids are not secret; the keys are in the secrets file.
   */
  keyRotations: optional(record(object({ kid: str, at: num, pushed: bool }))),
  /**
   * The move from MEMBER_KEYS to per-family link keyrings (docs/security.md "Keys"). verify-v2:
   * every worker has the new keyrings and accepts v2 links, signers still issue v1 (pass one). v2:
   * signers issue v2 since `cutoffAt` (pass two), and each worker keeps MEMBER_KEYS until its
   * `legacyUntil` to verify v1 links issued before. Older installs have none: before the move.
   */
  linkKeys: optional(
    object({
      mode: oneOf('verify-v2', 'v2'),
      cutoffAt: optional(num),
      legacyUntil: optional(record(num)),
    }),
  ),
  /**
   * How the vault seals (docs/security.md "The vault"): VAULT_WRITE_FORMAT and VAULT_LEGACY_OPEN.
   * Absent: legacy writes, legacy opening on, which every caller still holding FIELD_KEYS reads.
   * v3 only once no caller holds FIELD_KEYS; legacy opening off only once the re-seal is done
   * (`pnpm swarm vault`). `since`: when the vault was first deployed here.
   */
  vault: optional(
    object({ writeFormat: oneOf('legacy', 'v3'), legacyOpen: bool, since: optional(num) }),
  ),
  deployedAt: optional(record(num)),
});
export type State = ReturnType<typeof stateShape>;

const secretsShape = object({
  version: oneOf(1),
  /** Keyrings by worker secret name (AUTH_KEYS, …). Generated once; only `rotate-keys` changes them. */
  keys: record(str),
  turnstileSecret: optional(str),
  /** The least-privilege IAM user's key that the workers send with (not the admin key). */
  aws: optional(object({ accessKeyId: str, secretAccessKey: str })),
  resendApiKey: optional(str),
  resendWebhookSecret: optional(str),
  mailgunApiKey: optional(str),
  mailgunWebhookSigningKey: optional(str),
  /** Manages domains; the workers also use it. */
  postmarkAccountToken: optional(str),
  postmarkServerToken: optional(str),
  /** The password Postmark sends on its webhooks. Generated once. */
  postmarkWebhookSecret: optional(str),
  smtp: optional(object({ username: str, password: str })),
  /** Signs reports from the person's own mail server. Generated once. */
  smtpFeedbackSecret: optional(str),
  google: optional(object({ clientId: str, clientSecret: str })),
  stripe: optional(
    object({ secretKey: str, connectClientId: str, webhookSecrets: str, webhookId: optional(str) }),
  ),
  /** The install owner's DeBounce key (DEBOUNCE_API_KEY on api, capture, jobs). */
  debounceApiKey: optional(str),
  /** SSL and Certificates: Edit token for custom domains (CF_API_TOKEN on api, send, jobs). */
  cfApiToken: optional(str),
  /** The scoped DNS token, only when the person agreed to keep it for update and doctor. */
  dnsToken: optional(str),
});
export type Secrets = ReturnType<typeof secretsShape>;

export function emptyState(env: EnvName): State {
  return {
    version: 1,
    env,
    features: { customDomains: false, payments: false, google: false },
    resources: { r2: [], queues: [] },
  };
}

export const emptySecrets = (): Secrets => ({ version: 1, keys: {} });

function parse<T>(check: Check<T>, text: string, file: string): T {
  try {
    return check(JSON.parse(text), '');
  } catch (error) {
    const reason = error instanceof ShapeError ? error.message : 'it is not valid JSON';
    throw new Error(
      `${file} could not be read: ${reason}. Restore it from your backup of .swarm/, or fix it by hand.`,
    );
  }
}

export const parseState = (text: string, file = 'state') => parse(stateShape, text, file);
export const parseSecrets = (text: string, file = 'secrets') => parse(secretsShape, text, file);

export interface StateStore {
  /** Where the files live, for messages. */
  readonly location: string;
  /** False when nothing can be written to disk (dry runs, tests). */
  readonly persistent: boolean;
  load(env: EnvName): Promise<{ state: State | null; secrets: Secrets | null }>;
  save(state: State): Promise<void>;
  saveSecrets(env: EnvName, secrets: Secrets): Promise<void>;
}

const stable = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Writes to a temporary file and renames it over the old one, so a crash never leaves half a file. */
async function atomicWrite(path: string, content: string, secret: boolean) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: secret ? 0o600 : 0o644 });
  await rename(temporary, path);
  if (secret && process.platform !== 'win32') await chmod(path, 0o600);
}

/**
 * Gets the passphrase that seals .swarm/<env>.secrets.json: `open` for a file that is already
 * sealed, `choose` for a new one or one an older installer wrote in plain JSON.
 */
export type SecretsPassphrase = (mode: 'open' | 'choose', file: string) => Promise<string>;

interface FileStoreOptions {
  passphrase: SecretsPassphrase;
  /** Limits a written secrets file to the current user where file modes can't (Windows). */
  restrict?: (path: string) => Promise<void>;
  /** Where a problem that doesn't stop the run is said. */
  warn?: (message: string) => void;
}

export class FileStateStore implements StateStore {
  readonly persistent = true;
  readonly location: string;
  /** The key each environment's secrets file was opened or first sealed with, for this run. */
  private readonly sealing = new Map<EnvName, SealingKey>();

  constructor(
    root: string,
    private readonly options: FileStoreOptions,
  ) {
    this.location = stateDir(root);
  }

  private file(env: EnvName, secrets = false) {
    return join(this.location, secrets ? `${env}.secrets.json` : `${env}.json`);
  }

  async load(env: EnvName) {
    const stateFile = this.file(env);
    const secretsFile = this.file(env, true);
    const state = existsSync(stateFile)
      ? parseState(await readFile(stateFile, 'utf8'), stateFile)
      : null;
    const secrets = existsSync(secretsFile) ? await this.readSecrets(env, secretsFile) : null;
    return { state, secrets };
  }

  /** A sealed file opens with the passphrase; a plain one from an older installer is read as is. */
  private async readSecrets(env: EnvName, path: string): Promise<Secrets> {
    const text = await readFile(path, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return parseSecrets(text, path);
    }
    if (!isSealedSecretsFile(parsed)) return parseSecrets(text, path);
    const passphrase = await this.options.passphrase('open', path);
    const opened = await openSecretsFile(parsed, passphrase, env, path);
    this.sealing.set(env, opened.sealing);
    return parseSecrets(JSON.stringify(opened.secrets), path);
  }

  private async ensureDir() {
    await mkdir(this.location, { recursive: true, mode: 0o700 });
  }

  async save(state: State) {
    await this.ensureDir();
    await atomicWrite(this.file(state.env), stable(state), false);
  }

  async saveSecrets(env: EnvName, secrets: Secrets) {
    const path = this.file(env, true);
    let sealing = this.sealing.get(env);
    if (!sealing) {
      sealing = await newSecretsKey(await this.options.passphrase('choose', path));
      this.sealing.set(env, sealing);
    }
    const sealed = await sealSecretsFile(sealing, env, secrets);
    await this.ensureDir();
    await atomicWrite(path, stable(sealed), true);
    if (this.options.restrict) {
      try {
        await this.options.restrict(path);
      } catch (error) {
        this.options.warn?.(
          `Could not limit ${path} to your user (${error instanceof Error ? error.message : String(error)}). ` +
            'It is encrypted under your passphrase, but keep the .swarm folder private.',
        );
      }
    }
  }
}

/** Keeps everything in memory. Dry runs start from the files on disk but never write them. */
export class MemoryStateStore implements StateStore {
  readonly persistent = false;
  readonly location = '.swarm (in memory)';
  states = new Map<EnvName, State>();
  secrets = new Map<EnvName, Secrets>();

  constructor(initial?: { state?: State | null; secrets?: Secrets | null }) {
    if (initial?.state) this.states.set(initial.state.env, structuredClone(initial.state));
    if (initial?.secrets && initial.state) {
      this.secrets.set(initial.state.env, structuredClone(initial.secrets));
    }
  }

  async load(env: EnvName) {
    const state = this.states.get(env);
    const secrets = this.secrets.get(env);
    return {
      state: state ? structuredClone(state) : null,
      secrets: secrets ? structuredClone(secrets) : null,
    };
  }

  async save(state: State) {
    this.states.set(state.env, structuredClone(state));
  }

  async saveSecrets(env: EnvName, secrets: Secrets) {
    this.secrets.set(env, structuredClone(secrets));
  }
}

export const WINDOWS_PERMISSIONS_NOTE =
  'On Windows the installer limits the secrets file in .swarm/ to your user with icacls, and says so if it cannot. Keep the folder private.';

export const BACKUP_WARNING =
  'Back up the .swarm/ folder somewhere safe, and keep its passphrase apart from it. The secrets file holds the keys that ' +
  'encrypt subscriber fields (FIELD_KEYS), sealed under that passphrase: without the file and the passphrase, encrypted ' +
  'fields can never be read again. It is not in git.';
