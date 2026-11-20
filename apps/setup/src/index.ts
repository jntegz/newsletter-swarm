// The setup page and its small API. Everything but the page itself needs the setup password, which
// the person chose when they deployed this Worker, so a stranger who finds the address can't
// take over the install.
import {
  InstallError,
  MIN_KIT_PASSPHRASE,
  WorkerTransport,
  cutOverWarnings,
  dashboardProblem,
  emptySecrets,
  parseSecrets,
  parseState,
  runChange,
  slugProblem,
  suggestSlug,
  type Answers,
  type ChangeAction,
  type MailProvider,
  type Secrets,
  type State,
} from '@swarm/installer/wizard';
import { APP_JS, PAGE_HTML, STYLES } from './page';
import { SetupRun, scrub, secretValues, type SetupEnv } from './run';

export { SetupRun };

const SESSION_HOURS = 8;
const COOKIE = 'swarm_setup';

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...SECURITY_HEADERS, ...headers },
  });

const fail = (message: string, status: number) => json({ error: message }, status);

const asset = (body: string, type: string) =>
  new Response(body, { headers: { 'content-type': type, ...SECURITY_HEADERS } });

async function hmac(key: string, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(
    await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message)),
  );
}

const toHex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Compares by HMAC, so the time taken says nothing about the secret. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([hmac('compare', a), hmac('compare', b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * The session cookie: its expiry and an HMAC over it and the session generation kept by the
 * install, so ending all sessions (a new generation) invalidates every cookie without changing
 * the password.
 */
const sessionValue = async (password: string, expires: number, epoch: number) =>
  `${expires}.${toHex(await hmac(password, epoch === 0 ? `session:${expires}` : `session:${epoch}:${expires}`))}`;

async function signedIn(request: Request, password: string, epoch: number): Promise<boolean> {
  const cookie = request.headers.get('cookie') ?? '';
  const value = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(cookie)?.[1];
  const expires = Number(value?.split('.')[0]);
  if (!value || !Number.isFinite(expires) || expires < Date.now()) return false;
  return sameSecret(value, await sessionValue(password, expires, epoch));
}

/** Only this page may call the API, so another site can't act with the person's cookie. */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  return origin === new URL(request.url).origin;
}

const bad = (value: unknown, max = 200) =>
  typeof value !== 'string' || value.trim() === '' || value.length > max;

/** What is wrong with a pasted AWS key, if anything. */
function awsKeyProblem(accessKeyId: unknown, secretAccessKey: unknown): string | null {
  if (bad(accessKeyId) || !/^A[A-Z0-9]{15,}$/.test(String(accessKeyId).trim())) {
    return 'Paste your AWS access key ID. It looks like AKIA followed by letters and numbers.';
  }
  if (bad(secretAccessKey) || String(secretAccessKey).trim().length < 30) {
    return 'Paste your AWS secret access key.';
  }
  return null;
}

/** The form's answers, or what is wrong with them. */
export function readAnswers(body: Record<string, unknown>): Answers | string {
  const {
    zone,
    account,
    ownerName,
    ownerEmail,
    publicationName,
    publicationSlug,
    publicationAt,
    dashboard,
    mail,
  } = body;
  if (bad(zone)) return 'Choose a domain.';
  if (bad(ownerName, 80)) return 'Enter your name.';
  if (bad(ownerEmail) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(ownerEmail))) {
    return 'Enter your email address.';
  }
  if (bad(publicationName, 80)) return 'Enter a name for your publication.';
  const atRoot = publicationAt !== 'subdomain';
  let slug = String(publicationSlug ?? '').trim();
  if (atRoot) {
    // It still needs an internal address, which nobody has to choose or see.
    slug = suggestSlug(String(publicationName));
    if (slugProblem(slug)) slug = 'my-publication';
  } else {
    if (!slug) return 'Enter a subdomain for your publication.';
    const problem = slugProblem(slug);
    if (problem) return `The publication's subdomain: ${problem}`;
  }
  const label = String(dashboard ?? '').trim() || 'app';
  const labelProblem = dashboardProblem(label);
  if (labelProblem) return `The dashboard's subdomain: ${labelProblem}`;
  if (!atRoot && label === slug)
    return 'The dashboard and the publication need different subdomains.';
  const service = (mail ?? {}) as Record<string, string>;
  const common = {
    zone: String(zone),
    ...(typeof account === 'string' && account ? { account } : {}),
    owner: { name: String(ownerName), email: String(ownerEmail) },
    // Left unset on purpose: the installer then keeps every existing subdomain as it is.
    publication: { name: String(publicationName), slug },
    addresses: { dashboard: label, publicationAtRoot: atRoot },
  };
  const mailAnswers = readMail(service, mail);
  return typeof mailAnswers === 'string' ? mailAnswers : { ...common, mail: mailAnswers };
}

/** The email service part of a form, or what is wrong with it. */
function readMail(
  service: Record<string, string>,
  mail: unknown,
): NonNullable<Answers['mail']> | string {
  switch (service.provider) {
    case 'resend':
      if (bad(service.apiKey)) return 'Paste your Resend API key.';
      return {
        provider: 'resend',
        region: service.region || 'us-east-1',
        resendApiKey: String(service.apiKey),
      };
    case 'mailgun':
      if (bad(service.apiKey)) return 'Paste your Mailgun API key.';
      return {
        provider: 'mailgun',
        region: service.region || 'us',
        mailgunApiKey: String(service.apiKey),
      };
    case 'postmark':
      if (bad(service.apiKey)) return 'Paste your Postmark account token.';
      return { provider: 'postmark', postmarkAccountToken: String(service.apiKey) };
    case 'ses': {
      const problem = awsKeyProblem(service.accessKeyId, service.secretAccessKey);
      if (problem) return problem;
      if (!/^[a-z]{2}-[a-z]+-\d$/.test(String(service.region))) {
        return 'Choose an AWS region for Amazon SES.';
      }
      return {
        provider: 'ses',
        region: String(service.region),
        awsAccessKeyId: String(service.accessKeyId).trim(),
        awsSecretAccessKey: String(service.secretAccessKey).trim(),
        // A checkbox's value arrives as a real boolean, unlike the text fields beside it.
        requestProductionAccess:
          (mail as { requestProductionAccess?: unknown }).requestProductionAccess === true,
      };
    }
    case 'smtp':
      for (const key of ['host', 'port', 'username', 'password', 'dkimSelector']) {
        if (bad(service[key], 500)) return 'Fill in every mail server field.';
      }
      return {
        provider: 'smtp',
        smtp: {
          host: String(service.host),
          port: String(service.port),
          username: String(service.username),
          password: String(service.password),
          dkimSelector: String(service.dkimSelector),
        },
      };
    default:
      return 'Choose an email service.';
  }
}

const CHANGE_ACTIONS: readonly ChangeAction[] = [
  'prepare',
  'status',
  'cutover',
  'rollback',
  'cancel',
  'finish',
];

/**
 * Changing the email service. It keeps nothing: the kit's settings and mail keys arrive with each
 * request and go back with the answer, and its encryption keys stay in the person's browser.
 */
async function handleChange(data: Record<string, unknown>): Promise<Response> {
  if (bad(data.token, 500)) return fail('Paste your Cloudflare token.', 400);
  const action = data.action as ChangeAction;
  if (!CHANGE_ACTIONS.includes(action)) return fail('Unknown action.', 400);
  let state: State;
  let secrets: Secrets;
  try {
    state = parseState(JSON.stringify(data.state), 'your recovery kit');
    secrets = parseSecrets(
      JSON.stringify({ ...emptySecrets(), ...(data.secrets as object), keys: {} }),
      'your recovery kit',
    );
  } catch {
    return fail(
      "This doesn't look like a recovery kit. Use the file the setup page gave you.",
      400,
    );
  }
  let mail: Answers['mail'] | undefined;
  let provider: MailProvider | undefined;
  let awsAdmin: { accessKeyId: string; secretAccessKey: string } | undefined;
  const service = data.mail as Record<string, string> | undefined;
  if (action === 'prepare') {
    if (!service) return fail('Choose an email service.', 400);
    const read = readMail(service, service);
    if (typeof read === 'string') return fail(read, 400);
    const { awsAccessKeyId, awsSecretAccessKey, ...rest } = read;
    mail = rest;
    provider = read.provider;
    if (awsAccessKeyId && awsSecretAccessKey) {
      awsAdmin = { accessKeyId: awsAccessKeyId, secretAccessKey: awsSecretAccessKey };
    }
  } else if (action === 'cutover' && data.accessKeyId) {
    const problem = awsKeyProblem(data.accessKeyId, data.secretAccessKey);
    if (problem) return fail(problem, 400);
    awsAdmin = {
      accessKeyId: String(data.accessKeyId).trim(),
      secretAccessKey: String(data.secretAccessKey).trim(),
    };
  }
  const token = String(data.token);
  const hidden = secretValues({
    token,
    awsKey: awsAdmin ?? null,
    answers: mail ? ({ mail } as Answers) : null,
    secrets,
  });
  const log: string[] = [];
  try {
    const result = await runChange({
      action,
      transport: new WorkerTransport(),
      token,
      state,
      secrets,
      ...(provider ? { provider } : {}),
      ...(mail ? { mail } : {}),
      ...(awsAdmin ? { awsAdmin } : {}),
      acknowledged: data.acknowledged === true,
      log: (text) => {
        for (const line of text.split('\n')) if (line.trim()) log.push(scrub(line, hidden));
      },
    });
    const warnings = result.readiness ? cutOverWarnings(result.readiness) : [];
    return json({ state: result.state, secrets: result.secrets, warnings, log });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = error instanceof InstallError ? error.fix : undefined;
    return json(
      { error: scrub(message, hidden).slice(0, 2000), hint: scrub(hint ?? '', hidden), log },
      422,
    );
  }
}

async function handleApi(request: Request, env: SetupEnv, path: string): Promise<Response> {
  const password = env.SETUP_PASSWORD;
  if (!password || password.length < 12) {
    return fail('This setup page has no password yet, so it stays locked.', 503);
  }
  if (request.method === 'POST' && !sameOrigin(request)) return fail('Wrong origin.', 403);
  const run = env.SETUP.get(env.SETUP.idFromName('install'));
  const body = async () => {
    const parsed = await request.json().catch(() => null);
    return (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  };

  if (path === '/api/login' && request.method === 'POST') {
    const { password: given } = await body();
    const correct = typeof given === 'string' && (await sameSecret(given, password));
    // Cloudflare sets this header itself, so a client can't choose its own.
    const client = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const verdict = await run.attempt(correct, client);
    if (verdict === 'locked') return fail('Too many wrong passwords. Wait 15 minutes.', 429);
    if (verdict === 'wrong') return fail('That password is not right.', 401);
    const expires = Date.now() + SESSION_HOURS * 3600_000;
    return json({ ok: true }, 200, {
      'set-cookie': `${COOKIE}=${await sessionValue(password, expires, await run.sessionEpoch())}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`,
    });
  }
  if (!(await signedIn(request, password, await run.sessionEpoch()))) {
    return fail('Enter the setup password.', 401);
  }
  if (path === '/api/sessions/end' && request.method === 'POST') {
    // Every signed-in browser, this one included, has to enter the password again.
    await run.endSessions();
    return json({ ok: true }, 200, {
      'set-cookie': `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
    });
  }

  if (path === '/api/status' && request.method === 'GET') return json(await run.progress());
  if (path === '/api/connect' && request.method === 'POST') {
    const { token } = await body();
    if (bad(token, 500)) return fail('Paste your Cloudflare token.', 400);
    try {
      return json(await run.lookUp(String(token)));
    } catch {
      return fail(
        'Cloudflare did not accept that token. Create it again with the link above.',
        400,
      );
    }
  }
  if (path === '/api/begin' && request.method === 'POST') {
    const data = await body();
    if (bad(data.token, 500)) return fail('Paste your Cloudflare token.', 400);
    const answers = readAnswers(data);
    if (typeof answers === 'string') return fail(answers, 400);
    return json(await run.begin(String(data.token), answers));
  }
  if (path === '/api/approve' && request.method === 'POST') {
    const { version, digest } = await body();
    if (bad(version, 64) || bad(digest, 64)) return fail('Say which release to approve.', 400);
    const result = await run.approve(String(version), String(digest));
    return 'refused' in result ? fail(result.refused, 409) : json(result);
  }
  if (path === '/api/replace-release' && request.method === 'POST') {
    return json(await run.replaceRelease());
  }
  if (path === '/api/step' && request.method === 'POST') return json(await run.runNext());
  if (path === '/api/token' && request.method === 'POST') {
    const { token } = await body();
    if (bad(token, 500)) return fail('Paste your Cloudflare token.', 400);
    return json(await run.replaceToken(String(token)));
  }
  if (path === '/api/aws-key' && request.method === 'POST') {
    const { accessKeyId, secretAccessKey } = await body();
    const problem = awsKeyProblem(accessKeyId, secretAccessKey);
    if (problem) return fail(problem, 400);
    return json(
      await run.replaceAwsKey({
        accessKeyId: String(accessKeyId).trim(),
        secretAccessKey: String(secretAccessKey).trim(),
      }),
    );
  }
  if (path === '/api/change' && request.method === 'POST') return handleChange(await body());
  if (path === '/api/recovery-kit' && request.method === 'POST') {
    const { passphrase } = await body();
    if (typeof passphrase !== 'string' || passphrase.length < MIN_KIT_PASSPHRASE) {
      return fail(
        `Choose a passphrase of at least ${MIN_KIT_PASSPHRASE} characters for the kit.`,
        400,
      );
    }
    if (passphrase.length > 1000) return fail('That passphrase is too long.', 400);
    const kit = await run.recoveryKit(passphrase);
    if (!kit) {
      return fail(
        'The recovery kit is not ready, has been removed, or was already downloaded the most times allowed.',
        404,
      );
    }
    return json(kit, 200, {
      'content-disposition': 'attachment; filename="swarm-recovery-kit.json"',
    });
  }
  if (path === '/api/finish' && request.method === 'POST') return json(await run.finish());
  return fail('Not found.', 404);
}

export default {
  async fetch(request: Request, env: SetupEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/')) return handleApi(request, env, pathname);
    if (request.method !== 'GET') return fail('Not found.', 404);
    if (pathname === '/') return asset(PAGE_HTML, 'text/html; charset=utf-8');
    if (pathname === '/app.js') return asset(APP_JS, 'text/javascript; charset=utf-8');
    if (pathname === '/styles.css') return asset(STYLES, 'text/css; charset=utf-8');
    return fail('Not found.', 404);
  },
} satisfies ExportedHandler<SetupEnv>;
