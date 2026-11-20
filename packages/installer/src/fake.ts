import { basename, isAbsolute, relative } from 'node:path';
import type {
  AwsRequest,
  ExecRequest,
  ExecResult,
  HttpRequest,
  HttpResponse,
  Transport,
} from './transport';
import { REPO_ROOT } from './paths';

/**
 * A stand-in for the world: Cloudflare, Resend, Stripe, AWS and the local tools. Used by
 * --dry-run (to print the plan) and by the tests. Every call is recorded in `actions` as one
 * readable line; secrets never appear in it. State is kept in memory, so a second run sees what
 * the first one "created".
 */
export interface FakeOptions {
  /** The zone the person picks; the fake account owns it. */
  zone?: string | undefined;
  environment?: string;
  onAction?: (line: string) => void;
  /** Answers D1 queries in tests; the default returns no rows. */
  d1?: (sql: string, params: unknown[]) => Record<string, unknown>[];
}

interface Named {
  id: string;
  name: string;
}

let counter = 0;
const fakeId = (prefix: string) => `${prefix}-dry-run-${String(++counter).padStart(4, '0')}`;
const ok = (result: unknown, extra: Record<string, unknown> = {}): HttpResponse => ({
  status: 200,
  text: JSON.stringify({ success: true, errors: [], messages: [], result, ...extra }),
});
const json = (body: unknown, status = 200): HttpResponse => ({
  status,
  text: JSON.stringify(body),
});

class AwsFakeError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

export class FakeTransport implements Transport {
  readonly dryRun = true;
  readonly actions: string[] = [];
  readonly files = new Map<string, string>();
  readonly environment: string;

  account = { id: 'account-dry-run', name: 'Your Cloudflare account' };
  zones: Named[];
  d1: { uuid: string; name: string }[] = [];
  kv: { id: string; title: string }[] = [];
  r2: { name: string }[] = [];
  queues: { queue_id: string; queue_name: string }[] = [];
  widgets: { sitekey: string; secret: string; name: string; domains: string[] }[] = [];
  dns: {
    id: string;
    type: string;
    name: string;
    content: string;
    proxied: boolean;
    priority?: number;
  }[] = [];
  routes: { id: string; pattern: string; script?: string }[] = [];
  emailRules: { id: string; name: string }[] = [];
  resendDomains: { id: string; name: string; status: string; region: string }[] = [];
  resendWebhooks: { id: string; endpoint: string; signing_secret: string }[] = [];
  /** Workers uploaded through the API, with what the upload asked for. */
  scripts = new Map<string, { name: string; tag?: string; metadata: Record<string, unknown> }>();
  schedules = new Map<string, string[]>();
  /** Each uploaded script's default-hostname (workers.dev) and preview URL settings. */
  subdomains = new Map<string, { enabled: boolean; previews_enabled: boolean }>();
  consumers = new Map<string, { script_name: string }[]>();
  workerRoutes: { id: string; pattern: string; script: string }[] = [];
  uploadedAssets = 0;
  mailgunDomains = new Map<string, string>();
  mailgunWebhooks = new Map<string, string[]>();
  postmarkServers: { ID: number; Name: string; ApiTokens: string[] }[] = [];
  postmarkStreams: { ID: string; handling: string }[] = [];
  postmarkDomains: { ID: number; Name: string; ReturnPathDomain: string; DKIMVerified: boolean }[] =
    [];
  postmarkWebhooks: { Url: string; MessageStream: string; Triggers: Record<string, unknown> }[] =
    [];
  /** When true, creating a stream with custom unsubscribes is refused, as for an unapproved account. */
  postmarkRefusesCustom = false;
  stripeWebhooks: { id: string; url: string }[] = [];
  /** Worker secret names by script. */
  secrets = new Map<string, string[]>();
  /** The vault doesn't answer: the workers bound to it fail /healthz with 503, as deployed ones do. */
  vaultDown = false;
  /**
   * The jobs worker's row in worker_heartbeats. Unset: its minute cron has just run, answered by
   * the vault unless vaultDown (and then never answered before). Null: no row at all.
   */
  jobsHeartbeat?: { checked_at: number; ok: number; ok_at: number | null } | null | undefined;
  /** Worker bindings by script, as the settings API holds them. */
  settings = new Map<
    string,
    { type: string; name: string; text?: string; queue_name?: string }[]
  >();
  /** SQL the database was asked to run that the model below doesn't act on, for tests to read. */
  sqlLog: { sql: string; params: unknown[] }[] = [];
  sendingDomains: Record<string, unknown>[] = [];
  /** A tiny model of the rows the installer writes and reads back. */
  db = {
    operators: new Map<string, string>(), // email -> id
    ownerWorkspace: new Map<string, string>(), // operator id -> workspace id
    channels: new Map<string, { id: string; workspace_id: string }>(), // slug -> channel
    signup: undefined as string | undefined,
    signupBy: null as string | null,
    features: new Map<string, number>(), // platform-scope feature_flags: key -> enabled
  };
  awsState = {
    topics: new Set<string>(),
    configSets: new Set<string>(),
    destinations: new Set<string>(),
    users: new Set<string>(),
    workerPolicy: '',
    accessKeys: [] as { AccessKeyId: string }[],
    identities: new Set<string>(),
    /** Identities AWS has verified: DKIM records seen for a domain, the link clicked for an address. */
    verifiedIdentities: new Set<string>(),
    productionAccess: false,
    /** The account-level suppression list's reasons; new SES accounts start with both. */
    suppressedReasons: ['BOUNCE', 'COMPLAINT'] as string[],
    sentEmails: [] as Record<string, unknown>[],
    identityKeyLengths: new Map<string, unknown>(),
    topicAttributes: new Map<string, Record<string, string>>(),
    subscriptions: [] as { Endpoint: string; SubscriptionArn: string }[],
  };

  constructor(private readonly options: FakeOptions = {}) {
    this.environment = options.environment ?? 'production';
    this.zones = [{ id: 'zone-dry-run', name: options.zone ?? 'example.com' }];
  }

  private record(line: string) {
    this.actions.push(line);
    this.options.onAction?.(line);
  }

  // --- processes -----------------------------------------------------------------------------

  async exec(request: ExecRequest): Promise<ExecResult> {
    const shown = request.args.map((arg) => (isAbsolute(arg) ? shortPath(arg) : arg));
    const where = shortPath(request.cwd);
    this.record(`${request.command} ${shown.join(' ')}${where ? `  (in ${where})` : ''}`);
    const [first, second] = request.args;
    if (request.command !== 'wrangler') return { code: 0, stdout: '', stderr: '' };
    if (first === 'whoami') {
      return {
        code: 0,
        stdout: JSON.stringify({
          loggedIn: true,
          authType: 'OAuth Token',
          email: 'you@example.com',
          accounts: [this.account],
        }),
        stderr: '',
      };
    }
    if (first === 'auth' && second === 'token') {
      return {
        code: 0,
        stdout: JSON.stringify({ type: 'oauth', token: 'oauth-token-dry-run' }),
        stderr: '',
      };
    }
    if (first === 'd1' && second === 'migrations' && request.args[2] === 'list') {
      return { code: 0, stdout: 'No migrations to apply!', stderr: '' };
    }
    if (first === 'd1' && second === 'execute') return { code: 0, stdout: '[]', stderr: '' };
    if (first === 'deploy') {
      // Remember the uploaded secret names, as Cloudflare would.
      const arg = (flag: string) => request.args[request.args.indexOf(flag) + 1];
      const worker = /workers[\\/](\w+)[\\/]/.exec(arg('--config') ?? '')?.[1] ?? 'unknown';
      const script = arg('--env') === 'production' ? `swarm-${worker}` : `swarm-${worker}-staging`;
      const file = request.args.includes('--secrets-file')
        ? this.files.get(arg('--secrets-file') ?? '')
        : undefined;
      const names = file ? Object.keys(JSON.parse(file) as Record<string, string>) : [];
      this.secrets.set(script, [...new Set([...(this.secrets.get(script) ?? []), ...names])]);
    }
    return { code: 0, stdout: '', stderr: '' };
  }

  // --- files ---------------------------------------------------------------------------------

  async writeFile(path: string, content: string, options?: { secret?: boolean }) {
    this.files.set(path, content);
    this.record(`write ${shortPath(path)}${options?.secret ? ' (secret, removed after use)' : ''}`);
  }

  async readFile(path: string) {
    return this.files.get(path) ?? null;
  }

  async removeFile(path: string) {
    this.files.delete(path);
  }

  async sleep() {}

  // --- AWS -----------------------------------------------------------------------------------

  async aws<T>(request: AwsRequest): Promise<T> {
    const input = request.input;
    const name = [
      'Name',
      'TopicArn',
      'ConfigurationSetName',
      'EventDestinationName',
      'UserName',
      'PolicyName',
      'EmailIdentity',
      'MailFromDomain',
      'Endpoint',
    ]
      .map((key) => input[key])
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
    this.record(`aws ${request.service} ${request.operation}${name ? ` ${name}` : ''}`);
    const a = this.awsState;
    const accountId = '123456789012';
    const s = (key: string) => String(input[key]);
    const result = ((): unknown => {
      switch (`${request.service}:${request.operation}`) {
        case 'sts:GetCallerIdentity':
          return { Account: accountId, Arn: `arn:aws:iam::${accountId}:user/admin` };
        case 'sns:CreateTopic': {
          const arn = `arn:aws:sns:${request.region}:${accountId}:${s('Name')}`;
          a.topics.add(arn);
          return { TopicArn: arn };
        }
        case 'sns:SetTopicAttributes':
          a.topicAttributes.set(s('TopicArn'), {
            ...a.topicAttributes.get(s('TopicArn')),
            [s('AttributeName')]: s('AttributeValue'),
          });
          return {};
        case 'sns:ListSubscriptionsByTopic':
          return { Subscriptions: a.subscriptions };
        case 'sns:Subscribe': {
          // As on real SNS: a topic signs with version 1 unless told otherwise, and the events
          // worker refuses that, so the subscription stays pending. Asking again re-sends the
          // confirmation for the same subscription instead of adding a second one.
          const signed = a.topicAttributes.get(s('TopicArn'))?.SignatureVersion === '2';
          const arn = signed ? `${s('TopicArn')}:subscription-dry-run` : 'PendingConfirmation';
          const existing = a.subscriptions.find((sub) => sub.Endpoint === s('Endpoint'));
          if (existing) existing.SubscriptionArn = arn;
          else a.subscriptions.push({ Endpoint: s('Endpoint'), SubscriptionArn: arn });
          return { SubscriptionArn: arn };
        }
        case 'sesv2:GetConfigurationSet':
          if (!a.configSets.has(s('ConfigurationSetName'))) {
            throw new AwsFakeError('NotFoundException', 'Configuration set does not exist');
          }
          return {};
        case 'sesv2:CreateConfigurationSet':
          a.configSets.add(s('ConfigurationSetName'));
          return {};
        case 'sesv2:GetConfigurationSetEventDestinations': {
          const set = s('ConfigurationSetName');
          return {
            EventDestinations: [...a.destinations]
              .filter((d) => d.startsWith(`${set}/`))
              .map((d) => ({ Name: d.split('/')[1] })),
          };
        }
        case 'sesv2:CreateConfigurationSetEventDestination':
          a.destinations.add(`${s('ConfigurationSetName')}/${s('EventDestinationName')}`);
          return {};
        case 'iam:GetUser':
          if (!a.users.has(s('UserName')))
            throw new AwsFakeError('NoSuchEntityException', 'no user');
          return { User: { UserName: s('UserName') } };
        case 'iam:CreateUser':
          a.users.add(s('UserName'));
          return {};
        case 'iam:PutUserPolicy':
          a.workerPolicy = s('PolicyDocument');
          return {};
        case 'iam:ListAccessKeys':
          return { AccessKeyMetadata: a.accessKeys };
        case 'iam:CreateAccessKey': {
          const key = { AccessKeyId: 'AKIADRYRUN0000000001' };
          a.accessKeys.push(key);
          return {
            AccessKey: { ...key, SecretAccessKey: 'dry-run-secret-access-key-0000000000000000' },
          };
        }
        case 'sesv2:GetEmailIdentity':
          if (!a.identities.has(s('EmailIdentity'))) {
            throw new AwsFakeError('NotFoundException', 'identity does not exist');
          }
          return {
            VerifiedForSendingStatus: a.verifiedIdentities.has(s('EmailIdentity')),
            DkimAttributes: { Tokens: ['dkimtokenone', 'dkimtokentwo', 'dkimtokenthree'] },
          };
        case 'sesv2:CreateEmailIdentity':
          a.identities.add(s('EmailIdentity'));
          a.identityKeyLengths.set(
            s('EmailIdentity'),
            (input.DkimSigningAttributes as { NextSigningKeyLength?: unknown } | undefined)
              ?.NextSigningKeyLength,
          );
          return { DkimAttributes: { Tokens: ['dkimtokenone', 'dkimtokentwo', 'dkimtokenthree'] } };
        case 'sesv2:PutEmailIdentityMailFromAttributes':
          return {};
        case 'sesv2:GetAccount':
          return {
            ProductionAccessEnabled: a.productionAccess,
            SendingEnabled: true,
            SuppressionAttributes: { SuppressedReasons: [...a.suppressedReasons] },
          };
        case 'sesv2:PutAccountSuppressionAttributes':
          a.suppressedReasons = [...((input.SuppressedReasons as string[] | undefined) ?? [])];
          return {};
        case 'sesv2:SendEmail':
          a.sentEmails.push(input);
          return { MessageId: 'dry-run-ses-message' };
        case 'sesv2:PutAccountDetails':
          return {};
        default:
          return {};
      }
    })();
    return result as T;
  }

  // --- HTTP ----------------------------------------------------------------------------------

  async http(request: HttpRequest): Promise<HttpResponse> {
    const url = new URL(request.url);
    const body = request.body ? (safeJson(request.body) as Record<string, unknown>) : {};
    const upload = /\/accounts\/[^/]+\/workers\/scripts\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'PUT' && upload && request.body)
      return this.uploadScript(upload[1] as string, request.body);
    const patched = /\/accounts\/[^/]+\/workers\/scripts\/([^/]+)\/settings$/.exec(url.pathname);
    if (request.method === 'PATCH' && patched && request.body) {
      this.record(`PATCH settings of ${patched[1]}`);
      const form = /\r\n\r\n([\s\S]*?)\r\n--/.exec(request.body)?.[1] ?? '{}';
      const { bindings } = JSON.parse(form) as {
        bindings: { type: string; name: string; text?: string }[];
      };
      this.settings.set(patched[1] as string, bindings);
      return json({ success: true, result: {} });
    }
    if (url.pathname.endsWith('/workers/assets/upload')) {
      this.uploadedAssets += (request.body ?? '').match(/Content-Disposition/g)?.length ?? 0;
      return json({ success: true, result: { jwt: 'completion-jwt' } });
    }
    this.record(`${request.method} ${url.host}${url.pathname}${describeBody(url, body)}`);
    if (url.host === 'api.cloudflare.com') return this.cloudflare(request.method, url, body);
    if (url.host === 'api.resend.com') return this.resend(request.method, url, body);
    if (url.host === 'api.postmarkapp.com') return this.postmark(request.method, url, body);
    if (url.host === 'api.mailgun.net' || url.host === 'api.eu.mailgun.net') {
      return this.mailgun(request.method, url, formFields(request.body));
    }
    if (url.host === 'api.stripe.com') return this.stripe(request.method, url);
    if (url.host === 'cloudflare-dns.com') {
      // Answers from the fake zone, so doctor can check what the install wrote.
      const name = url.searchParams.get('name');
      const type = url.searchParams.get('type');
      const answers = this.dns
        .filter((r) => r.name === name && r.type === type)
        .map((r) => ({
          type: { A: 1, CNAME: 5, MX: 15, TXT: 16 }[r.type as string] ?? 0,
          data:
            r.type === 'MX'
              ? `${r.priority ?? 10} ${r.content}.`
              : r.type === 'CNAME'
                ? `${r.content}.`
                : `"${r.content.replace(/^"|"$/g, '')}"`,
        }));
      return json({ Status: 0, Answer: answers });
    }
    if (url.pathname === '/healthz') {
      const label = url.host.split('.')[0]?.replace(/^staging-/, '') ?? '';
      const service =
        { app: 'api', forms: 'capture', link: 'track', media: 'site', events: 'events' }[label] ??
        'site';
      if (this.vaultDown && ['api', 'capture', 'site'].includes(service)) {
        return json(
          {
            error: {
              code: 'unavailable',
              message: 'The vault does not answer through this worker.',
            },
          },
          503,
        );
      }
      return json({ data: { ok: true, service, environment: this.environment } });
    }
    return json({});
  }

  private cloudflare(method: string, url: URL, body: Record<string, unknown>): HttpResponse {
    const path = url.pathname.replace(/^\/client\/v4/, '');
    const route = `${method} ${path}`;
    const match = (pattern: RegExp) => pattern.exec(route);
    const q = (key: string) => url.searchParams.get(key);

    if (route === 'GET /user/tokens/verify') return ok({ id: 'token-dry-run', status: 'active' });
    if (route === 'GET /accounts') return ok([this.account]);
    if (route === 'GET /zones') return ok(this.zones.map((z) => ({ ...z, status: 'active' })));

    if (match(/^GET \/accounts\/[^/]+\/d1\/database$/)) {
      const name = q('name');
      return ok(name ? this.d1.filter((d) => d.name === name) : this.d1);
    }
    if (match(/^POST \/accounts\/[^/]+\/d1\/database$/)) {
      const db = { uuid: fakeId('d1'), name: String(body.name) };
      this.d1.push(db);
      return ok(db);
    }
    // What the browser setup uses in place of wrangler.
    if (match(/^GET \/accounts\/[^/]+\/workers\/scripts$/)) {
      return ok([...this.scripts.values()].map((x) => ({ id: x.name, migration_tag: x.tag })));
    }
    if (match(/\/workers\/scripts\/[^/]+\/assets-upload-session$/)) {
      const manifest = (body.manifest ?? {}) as Record<string, { hash: string }>;
      const hashes = Object.values(manifest).map((m) => m.hash);
      return ok({ jwt: 'upload-jwt', buckets: hashes.length ? [hashes] : [] });
    }
    const subdomain = match(/^POST \/accounts\/[^/]+\/workers\/scripts\/([^/]+)\/subdomain$/);
    if (subdomain) {
      this.subdomains.set(subdomain[1] as string, {
        enabled: body.enabled === true,
        previews_enabled: body.previews_enabled === true,
      });
      return ok({ enabled: body.enabled, previews_enabled: body.previews_enabled });
    }
    const schedules = match(/^PUT \/accounts\/[^/]+\/workers\/scripts\/([^/]+)\/schedules$/);
    if (schedules) {
      this.schedules.set(
        schedules[1] as string,
        (body as unknown as { cron: string }[]).map((c) => c.cron),
      );
      return ok({});
    }
    const consumers = match(/^(GET|POST) \/accounts\/[^/]+\/queues\/([^/]+)\/consumers$/);
    if (consumers) {
      const queue = consumers[2] as string;
      const list = this.consumers.get(queue) ?? [];
      if (consumers[1] === 'GET') return ok(list);
      list.push(body as { script_name: string });
      this.consumers.set(queue, list);
      return ok({ consumer_id: 'consumer' });
    }
    const zoneRoutes = match(/^(GET|POST) \/zones\/[^/]+\/workers\/routes$/);
    if (zoneRoutes) {
      if (zoneRoutes[1] === 'GET') return ok(this.workerRoutes);
      const route = {
        id: fakeId('route'),
        pattern: String(body.pattern),
        script: String(body.script),
      };
      this.workerRoutes.push(route);
      return ok(route);
    }
    if (match(/^POST \/accounts\/[^/]+\/d1\/database\/[^/]+\/query$/)) {
      const statements = (Array.isArray(body.batch) ? body.batch : [body]) as {
        sql: string;
        params?: unknown[];
      }[];
      return ok(
        statements.map((s) => {
          // ON CONFLICT DO NOTHING on an existing sign-up setting changes nothing, and only an
          // invite-only row nobody has claimed yet can be claimed.
          const noop =
            (/INSERT INTO instance_settings/i.test(s.sql) && this.db.signup !== undefined) ||
            (/UPDATE instance_settings/i.test(s.sql) &&
              (this.db.signup !== 'invite_only' || this.db.signupBy !== null)) ||
            (/INSERT INTO feature_flags[\s\S]*DO NOTHING/i.test(s.sql) &&
              this.db.features.has(String(s.params?.[1])));
          const results = this.queryD1(s.sql, s.params ?? []);
          const write = /^\s*(INSERT|UPDATE|DELETE)/i.test(s.sql);
          return { results, success: true, meta: { changes: write && !noop ? 1 : 0 } };
        }),
      );
    }
    if (match(/^GET \/accounts\/[^/]+\/storage\/kv\/namespaces$/)) return ok(this.kv);
    if (match(/^POST \/accounts\/[^/]+\/storage\/kv\/namespaces$/)) {
      const ns = { id: fakeId('kv'), title: String(body.title) };
      this.kv.push(ns);
      return ok(ns);
    }
    if (match(/^GET \/accounts\/[^/]+\/r2\/buckets$/)) return ok({ buckets: this.r2 });
    if (match(/^POST \/accounts\/[^/]+\/r2\/buckets$/)) {
      this.r2.push({ name: String(body.name) });
      return ok({ name: body.name });
    }
    if (match(/^GET \/accounts\/[^/]+\/queues$/)) return ok(this.queues);
    if (match(/^POST \/accounts\/[^/]+\/queues$/)) {
      const queue = { queue_id: fakeId('queue'), queue_name: String(body.queue_name) };
      this.queues.push(queue);
      return ok(queue);
    }
    if (match(/^GET \/accounts\/[^/]+\/challenges\/widgets$/)) {
      return ok(this.widgets.map(({ secret: _secret, ...w }) => w));
    }
    const widget = match(/^GET \/accounts\/[^/]+\/challenges\/widgets\/([^/]+)$/);
    if (widget) return ok(this.widgets.find((w) => w.sitekey === widget[1]) ?? null);
    if (match(/^POST \/accounts\/[^/]+\/challenges\/widgets$/)) {
      const w = {
        sitekey: '0x4AAAAAAADryRunSiteKey',
        secret: '0x4AAAAAAADryRunSecretKey0000000000',
        name: String(body.name),
        domains: body.domains as string[],
      };
      this.widgets.push(w);
      return ok(w);
    }
    const putSecret = match(/^PUT \/accounts\/[^/]+\/workers\/scripts\/([^/]+)\/secrets$/);
    if (putSecret) {
      const script = putSecret[1] as string;
      const name = String(body.name);
      this.secrets.set(script, [...new Set([...(this.secrets.get(script) ?? []), name])]);
      return ok({ name, type: 'secret_text' });
    }
    const deleteSecret = match(
      /^DELETE \/accounts\/[^/]+\/workers\/scripts\/([^/]+)\/secrets\/([^/]+)$/,
    );
    if (deleteSecret) {
      const script = deleteSecret[1] as string;
      this.secrets.set(
        script,
        (this.secrets.get(script) ?? []).filter((name) => name !== deleteSecret[2]),
      );
      return ok({});
    }
    const settings = match(/^GET \/accounts\/[^/]+\/workers\/scripts\/([^/]+)\/settings$/);
    if (settings) return ok({ bindings: this.settings.get(settings[1] as string) ?? [] });
    const deleteDns = match(/^DELETE \/zones\/[^/]+\/dns_records\/([^/]+)$/);
    if (deleteDns) {
      this.dns = this.dns.filter((record) => record.id !== deleteDns[1]);
      return ok({ id: deleteDns[1] });
    }
    const secrets = match(/^GET \/accounts\/[^/]+\/workers\/scripts\/([^/]+)\/secrets$/);
    if (secrets) {
      return ok(
        (this.secrets.get(secrets[1] as string) ?? []).map((name) => ({
          name,
          type: 'secret_text',
        })),
      );
    }

    if (match(/^GET \/zones\/[^/]+\/dns_records$/)) {
      const name = q('name');
      const type = q('type');
      const found = this.dns.filter(
        (r) => (!name || r.name === name) && (!type || r.type === type),
      );
      return ok(found, {
        result_info: { page: 1, total_pages: 1 },
      });
    }
    if (match(/^POST \/zones\/[^/]+\/dns_records$/)) {
      const record = {
        id: fakeId('dns'),
        type: String(body.type),
        name: String(body.name),
        content: String(body.content),
        proxied: body.proxied === true,
        ...(typeof body.comment === 'string' ? { comment: body.comment } : {}),
        ...(typeof body.priority === 'number' ? { priority: body.priority } : {}),
      };
      this.dns.push(record);
      return ok(record);
    }
    const patch = match(/^PATCH \/zones\/[^/]+\/dns_records\/([^/]+)$/);
    if (patch) {
      const record = this.dns.find((r) => r.id === patch[1]);
      if (record) Object.assign(record, body);
      return ok(record);
    }
    if (match(/^GET \/zones\/[^/]+\/workers\/routes$/)) return ok(this.routes);
    if (match(/^POST \/zones\/[^/]+\/workers\/routes$/)) {
      const r = { id: fakeId('route'), pattern: String(body.pattern) };
      this.routes.push(r);
      return ok(r);
    }
    if (match(/^POST \/zones\/[^/]+\/email\/routing\/dns$/)) return ok({ name: body.name });
    if (match(/^GET \/zones\/[^/]+\/email\/routing\/rules$/)) return ok(this.emailRules);
    if (match(/^POST \/zones\/[^/]+\/email\/routing\/rules$/)) {
      const rule = { id: fakeId('rule'), name: String(body.name) };
      this.emailRules.push(rule);
      return ok(rule);
    }
    if (match(/^PUT \/zones\/[^/]+\/custom_hostnames\/fallback_origin$/)) {
      return ok({ origin: body.origin, status: 'pending_deployment' });
    }
    return ok({});
  }

  private queryD1(sql: string, params: unknown[]): Record<string, unknown>[] {
    if (this.options.d1) return this.options.d1(sql, params);
    const db = this.db;
    const p = (i: number) => String(params[i]);
    if (/FROM sending_domains/i.test(sql) && /^\s*SELECT/i.test(sql)) return this.sendingDomains;
    if (/^\s*UPDATE sending_domains\s+SET pending_provider = \?1/i.test(sql)) {
      const row = this.sendingDomains.find((d) => d.id === params[4]);
      if (row) {
        row.pending_provider = params[0];
        row.pending_records_json = params[1];
        row.pending_provider_ref = params[2];
      }
      return [];
    }
    if (/mail_service_changes|sending_domains|reputation_ramps|dispatches/i.test(sql)) {
      this.sqlLog.push({ sql, params });
      if (/SELECT state FROM mail_service_changes/i.test(sql)) {
        const state = [...this.sqlLog]
          .reverse()
          .find((s) => /^\s*(INSERT|UPDATE)[\s\S]*mail_service_changes/i.test(s.sql));
        const value = !state
          ? null
          : /state = 'cut_over'/.test(state.sql)
            ? 'cut_over'
            : /state = 'rolled_back'/.test(state.sql)
              ? 'rolled_back'
              : 'prepared';
        return value ? [{ state: value }] : [];
      }
      if (/SELECT count\(\*\) AS n FROM dispatches/i.test(sql)) return [{ n: 0 }];
      return [];
    }
    if (/FROM worker_heartbeats/i.test(sql)) {
      if (this.jobsHeartbeat === null) return [];
      const now = Date.now();
      return [
        this.jobsHeartbeat ??
          (this.vaultDown
            ? { checked_at: now, ok: 0, ok_at: null }
            : { checked_at: now, ok: 1, ok_at: now }),
      ];
    }
    if (/FROM sqlite_master/i.test(sql)) {
      return [{ name: 'instance_admins' }, { name: 'instance_settings' }].filter((t) =>
        sql.includes(`'${t.name}'`),
      );
    }
    if (/^\s*SELECT id FROM operators WHERE email/i.test(sql)) {
      const id = db.operators.get(p(0));
      return id ? [{ id }] : [];
    }
    if (/^\s*INSERT INTO operators/i.test(sql)) db.operators.set(p(1), p(0));
    if (/FROM seats s JOIN workspaces/i.test(sql)) {
      const id = db.ownerWorkspace.get(p(0));
      return id ? [{ id }] : [];
    }
    if (/^\s*INSERT INTO seats/i.test(sql)) db.ownerWorkspace.set(p(2), p(1));
    if (/^\s*SELECT id, workspace_id FROM channels/i.test(sql)) {
      const channel = db.channels.get(p(0));
      return channel ? [channel] : [];
    }
    if (/^\s*INSERT INTO channels/i.test(sql))
      db.channels.set(p(2), { id: p(0), workspace_id: p(1) });
    if (/^\s*INSERT INTO instance_settings/i.test(sql) && db.signup === undefined) {
      db.signup = 'invite_only';
      db.signupBy = /'invite_only', NULL/.test(sql) ? null : p(0);
    }
    if (/^\s*UPDATE instance_settings/i.test(sql) && db.signup === 'invite_only') {
      db.signupBy ??= p(0);
    }
    if (/^\s*SELECT value FROM instance_settings/i.test(sql))
      return db.signup ? [{ value: db.signup }] : [];
    if (/^\s*INSERT INTO feature_flags/i.test(sql)) {
      if (/DO UPDATE/i.test(sql) || !db.features.has(p(1))) {
        db.features.set(p(1), Number(params[2]));
      }
    }
    if (/^\s*SELECT key, enabled[\s\S]*FROM feature_flags/i.test(sql)) {
      return [...db.features].map(([key, enabled]) => ({
        key,
        enabled,
        updatedBy: null,
        updatedAt: 1,
      }));
    }
    return [];
  }

  private resend(method: string, url: URL, body: Record<string, unknown>): HttpResponse {
    const route = `${method} ${url.pathname}`;
    if (route === 'GET /domains') return json({ data: this.resendDomains });
    if (route === 'POST /domains') {
      const name = String(body.name);
      const domain = {
        id: fakeId('resend-domain'),
        name,
        status: 'not_started',
        region: String(body.region),
      };
      this.resendDomains.push(domain);
      return json({ ...domain, records: resendRecords(name) }, 201);
    }
    const get = /^GET \/domains\/([^/]+)$/.exec(route);
    if (get) {
      const domain = this.resendDomains.find((d) => d.id === get[1]);
      return domain ? json({ ...domain, records: resendRecords(domain.name) }) : json({}, 404);
    }
    const verify = /^POST \/domains\/([^/]+)\/verify$/.exec(route);
    if (verify) {
      const domain = this.resendDomains.find((d) => d.id === verify[1]);
      if (domain) domain.status = 'verified';
      return json({ object: 'domain', id: verify[1] });
    }
    if (route === 'GET /webhooks') return json({ data: this.resendWebhooks });
    const hookById = /^(GET|DELETE) \/webhooks\/([^/]+)$/.exec(route);
    if (hookById) {
      const index = this.resendWebhooks.findIndex((w) => w.id === hookById[2]);
      if (index === -1) return json({}, 404);
      if (hookById[1] === 'GET') return json(this.resendWebhooks[index]);
      this.resendWebhooks.splice(index, 1);
      return json({ object: 'webhook', id: hookById[2], deleted: true });
    }
    if (route === 'POST /webhooks') {
      const hook = {
        id: fakeId('resend-webhook'),
        endpoint: String(body.endpoint),
        signing_secret: 'whsec_dryrun0000000000',
      };
      this.resendWebhooks.push(hook);
      return json(hook, 201);
    }
    return json({});
  }

  private mailgun(method: string, url: URL, form: Record<string, string[]>): HttpResponse {
    const route = `${method} ${url.pathname}`;
    const domainJson = (name: string) => ({
      domain: { name, state: this.mailgunDomains.get(name) },
      sending_dns_records: mailgunRecords(name),
    });
    if (route === 'GET /v5/accounts/http_signing_key') {
      return json({ http_signing_key: 'key-dryrun0000000000000000' });
    }
    if (route === 'POST /v4/domains') {
      const name = form.name?.[0] ?? '';
      this.mailgunDomains.set(name, 'unverified');
      return json(domainJson(name));
    }
    const verify = /^PUT \/v4\/domains\/([^/]+)\/verify$/.exec(route);
    if (verify) {
      this.mailgunDomains.set(verify[1] as string, 'active');
      return json(domainJson(verify[1] as string));
    }
    const get = /^GET \/v4\/domains\/([^/]+)$/.exec(route);
    if (get) {
      return this.mailgunDomains.has(get[1] as string)
        ? json(domainJson(get[1] as string))
        : json({ message: 'Domain not found' }, 404);
    }
    if (/^GET \/v3\/domains\/[^/]+\/webhooks$/.test(route)) {
      return json({
        webhooks: Object.fromEntries([...this.mailgunWebhooks].map(([id, urls]) => [id, { urls }])),
      });
    }
    if (/^POST \/v3\/domains\/[^/]+\/webhooks$/.test(route)) {
      this.mailgunWebhooks.set(form.id?.[0] ?? '', form.url ?? []);
      return json({ message: 'Webhook has been created' });
    }
    const update = /^PUT \/v3\/domains\/[^/]+\/webhooks\/([^/]+)$/.exec(route);
    if (update) {
      this.mailgunWebhooks.set(update[1] as string, form.url ?? []);
      return json({ message: 'Webhook has been updated' });
    }
    return json({});
  }

  private uploadScript(name: string, body: string): HttpResponse {
    const part =
      /name="metadata"[^\r]*\r\nContent-Type: application\/json\r\n\r\n([^\r]*)\r\n/.exec(body);
    const metadata = JSON.parse(part?.[1] ?? '{}') as Record<string, unknown>;
    // As Cloudflare does: a queue binding to a queue that doesn't exist fails the upload.
    const bindings = (metadata.bindings ?? []) as { type: string; queue_name?: string }[];
    const missing = bindings.find(
      (b) => b.type === 'queue' && !this.queues.some((q) => q.queue_name === b.queue_name),
    );
    // And so does a service binding to a script that doesn't exist (the vault, before its callers).
    const unbound = (bindings as { type: string; service?: string }[]).find(
      (b) => b.type === 'service' && !this.scripts.has(b.service ?? ''),
    );
    if (unbound) {
      this.record(`upload ${name} refused`);
      return json(
        {
          success: false,
          errors: [{ code: 10143, message: `Service ${unbound.service} does not exist.` }],
        },
        400,
      );
    }
    if (missing) {
      this.record(`upload ${name} refused`);
      return json(
        {
          success: false,
          errors: [{ code: 11000, message: `Queue ${missing.queue_name} does not exist.` }],
        },
        400,
      );
    }
    const migrations = metadata.migrations as { new_tag?: string } | undefined;
    const tag = migrations?.new_tag ?? this.scripts.get(name)?.tag;
    this.scripts.set(name, { name, ...(tag ? { tag } : {}), metadata });
    this.record(`upload ${name}`);
    return json({ success: true, result: { id: name } });
  }

  private postmark(method: string, url: URL, body: Record<string, unknown>): HttpResponse {
    const route = `${method} ${url.pathname}`;
    const domainJson = (d: FakeTransport['postmarkDomains'][number]) => ({
      ...d,
      DKIMPendingHost: `dry._domainkey.${d.Name}`,
      DKIMPendingTextValue: 'k=rsa;p=DRYRUN',
      ReturnPathDomainCNAMEValue: 'pm.mtasv.net',
      ReturnPathDomainVerified: d.DKIMVerified,
    });
    if (route === 'GET /servers') return json({ Servers: this.postmarkServers });
    if (route === 'POST /servers') {
      const server = {
        ID: this.postmarkServers.length + 1,
        Name: String(body.Name),
        ApiTokens: ['server-token-dryrun-0000000000'],
      };
      this.postmarkServers.push(server);
      return json(server);
    }
    if (route === 'GET /message-streams') {
      return json({
        MessageStreams: this.postmarkStreams.map((s) => ({
          ID: s.ID,
          SubscriptionManagementConfiguration: { UnsubscribeHandlingType: s.handling },
        })),
      });
    }
    if (route === 'POST /message-streams') {
      const config = body.SubscriptionManagementConfiguration as
        { UnsubscribeHandlingType?: string } | undefined;
      if (this.postmarkRefusesCustom && config?.UnsubscribeHandlingType === 'Custom') {
        return json({ ErrorCode: 1238, Message: 'No permission for Custom' }, 422);
      }
      this.postmarkStreams.push({
        ID: String(body.ID),
        handling: config?.UnsubscribeHandlingType ?? 'Postmark',
      });
      return json({ ID: body.ID });
    }
    if (route === 'GET /domains') return json({ Domains: this.postmarkDomains });
    if (route === 'POST /domains') {
      const domain = {
        ID: this.postmarkDomains.length + 1,
        Name: String(body.Name),
        ReturnPathDomain: String(body.ReturnPathDomain),
        DKIMVerified: false,
      };
      this.postmarkDomains.push(domain);
      return json(domainJson(domain));
    }
    const domain = /^(GET|PUT) \/domains\/(\d+)(\/verifyDkim|\/verifyReturnPath)?$/.exec(route);
    if (domain) {
      const found = this.postmarkDomains.find((d) => d.ID === Number(domain[2]));
      if (!found) return json({ ErrorCode: 510, Message: 'Not found' }, 404);
      if (domain[3]) found.DKIMVerified = true;
      return json(domainJson(found));
    }
    if (route === 'GET /webhooks') {
      const stream = url.searchParams.get('MessageStream');
      return json({ Webhooks: this.postmarkWebhooks.filter((w) => w.MessageStream === stream) });
    }
    if (route === 'POST /webhooks') {
      this.postmarkWebhooks.push({
        Url: String(body.Url),
        MessageStream: String(body.MessageStream),
        Triggers: body.Triggers as Record<string, unknown>,
      });
      return json({ ID: this.postmarkWebhooks.length });
    }
    return json({});
  }

  private stripe(method: string, url: URL): HttpResponse {
    if (method === 'GET' && url.pathname === '/v1/webhook_endpoints') {
      return json({ data: this.stripeWebhooks });
    }
    if (method === 'POST' && url.pathname === '/v1/webhook_endpoints') {
      const hook = { id: fakeId('we'), url: 'dry-run' };
      this.stripeWebhooks.push(hook);
      return json({ ...hook, secret: 'whsec_dryrunstripe000000' });
    }
    return json({});
  }
}

/** The fields of a multipart/form-data body, as the installer writes them. */
function formFields(body: string | undefined): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const match of (body ?? '').matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)\r\n/g)) {
    (fields[match[1] as string] ??= []).push(match[2] as string);
  }
  return fields;
}

function mailgunRecords(domain: string) {
  return [
    {
      record_type: 'TXT',
      name: domain,
      value: 'v=spf1 include:mailgun.org ~all',
      valid: 'unknown',
    },
    {
      record_type: 'TXT',
      name: `k1._domainkey.${domain}`,
      value: 'k=rsa; p=DRYRUN',
      valid: 'unknown',
    },
    { record_type: 'CNAME', name: `email.${domain}`, value: 'mailgun.org', valid: 'unknown' },
  ];
}

/** Names as real Resend gives them: relative to the root domain, seen on a real install. */
function resendRecords(domain: string) {
  const under = domain.split('.').slice(0, -2).join('.');
  const relative = (name: string) => (under ? `${name}.${under}` : name);
  return [
    {
      record: 'DKIM',
      name: relative('resend._domainkey'),
      type: 'TXT',
      ttl: 'Auto',
      status: 'not_started',
      value: 'p=MIGfMA0GCSqDRYRUN',
    },
    // Real Resend also sends this CNAME, seen on the first real install.
    {
      record: 'SPF',
      name: relative('rbounce'),
      type: 'CNAME',
      ttl: 'Auto',
      status: 'not_started',
      value: 'send.forge.rmta.net',
    },
    {
      record: 'SPF',
      name: relative('bounce'),
      type: 'MX',
      ttl: 'Auto',
      status: 'not_started',
      value: 'feedback-smtp.us-east-1.amazonses.com',
      priority: 10,
    },
    {
      record: 'SPF',
      name: relative('bounce'),
      type: 'TXT',
      ttl: 'Auto',
      status: 'not_started',
      value: 'v=spf1 include:amazonses.com ~all',
    },
  ];
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function shortPath(path: string): string {
  const rel = relative(REPO_ROOT, path).replaceAll('\\', '/');
  return rel.startsWith('..') || isAbsolute(rel) ? `<temp>/${basename(path)}` : rel;
}

/** A short, secret-free summary of a request body for the action log. */
function describeBody(url: URL, body: Record<string, unknown>): string {
  const parts: string[] = [];
  if (url.host === 'api.cloudflare.com' && url.pathname.endsWith('/query')) {
    const statements = (Array.isArray(body.batch) ? body.batch : [body]) as { sql?: string }[];
    const shown = statements.map((s) => (s.sql ?? '').trim().split(/\s+/).slice(0, 4).join(' '));
    return `  ${[...new Set(shown)].join(' | ')}`;
  }
  for (const key of [
    'name',
    'title',
    'queue_name',
    'pattern',
    'type',
    'content',
    'endpoint',
    'origin',
    'url',
  ]) {
    const value = body[key];
    if (typeof value === 'string' && value.length < 120) parts.push(value);
  }
  const name = url.searchParams.get('name');
  if (name) parts.push(`name=${name}`);
  return parts.length ? `  ${parts.join(' ')}` : '';
}
