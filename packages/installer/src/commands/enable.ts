import { DEBOUNCE_API_SETTINGS_URL, DEBOUNCE_SIGNUP_URL } from '@swarm/domain';
import { CloudflareApi, dnsTokenLink, upsertRecord, verifyToken } from '../cloudflare';
import { dnsApi, save, saveSecrets, zoneId, type Ctx } from '../context';
import { hostnamesFor } from '../hostnames';
import { featureWorkers } from '../keys';
import type { Worker } from '../paths';
import { deployAll } from '../steps/deploy';
import { keys } from '../steps/keys';
import { signIn } from '../steps/login';
import { writeConfigs } from '../steps/render';
import { InstallError } from '../ui';

export const FEATURES = ['custom-domains', 'payments', 'google', 'debounce'] as const;
export type FeatureName = (typeof FEATURES)[number];

/** Stripe API version and Connect events, as docs/deployment.md (Payments §3) lists them. */
const STRIPE_API_VERSION = '2025-09-30.clover';
const STRIPE_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.trial_will_end',
  'invoice.paid',
  'invoice.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
  'account.updated',
];

function requireInstall(ctx: Ctx) {
  if (!ctx.state.zone || !ctx.state.choices) {
    throw new InstallError(
      `There is no ${ctx.env} install recorded in .swarm/.`,
      'Run `pnpm swarm` to install first.',
    );
  }
  return {
    zone: ctx.state.zone,
    h: hostnamesFor(ctx.state.zone.name, ctx.env, ctx.state.choices?.addresses),
  };
}

async function secret(
  ctx: Ctx,
  given: string | undefined,
  message: string,
  validate?: (v: string) => string | undefined,
) {
  if (given) return given;
  if (!ctx.interactive)
    throw new InstallError(`Missing answer: ${message}`, 'Add it to the answers file.');
  return ctx.ui.prompts.password({ message, ...(validate ? { validate } : {}) });
}

async function finish(ctx: Ctx, workers: readonly Worker[]) {
  await save(ctx);
  await saveSecrets(ctx);
  // An install the latest `update` hasn't reached yet may lack keyrings these workers now hold.
  await keys.run(ctx);
  ctx.ui.section('Deploying');
  await writeConfigs(ctx);
  await deployAll(ctx, workers);
}

async function customDomains(ctx: Ctx) {
  const { h } = requireInstall(ctx);
  if (ctx.env === 'staging') {
    ctx.ui.warn(
      'On staging, custom domains need their own zone: the */* route belongs to production on this one.',
    );
  }
  ctx.ui.note(
    'Custom domains (Cloudflare for SaaS)',
    [
      'Publications can then use their own domains, and their links their own link domains.',
      'Cloudflare for SaaS must be turned on for the zone (SSL/TLS > Custom Hostnames).',
      'Create a token with Zone > SSL and Certificates > Edit for the zone. The api, send and',
      'jobs workers keep it as CF_API_TOKEN.',
    ].join('\n'),
  );
  const token = await secret(
    ctx,
    ctx.answers.cfApiToken ?? ctx.secrets.cfApiToken,
    'Paste the SSL and Certificates token',
  );
  const cf = new CloudflareApi(ctx.t, token, 'SSL token');
  await ctx.ui.task('Checking the token', () => verifyToken(cf));
  ctx.secrets.cfApiToken = token;
  ctx.state.features.customDomains = true;

  if (!dnsApi(ctx) && ctx.interactive) {
    ctx.ui.info(
      `Adding ${h.sites} needs the DNS token again. Create one here if you no longer have it:\n${dnsTokenLink()}`,
    );
    ctx.session.dnsToken = await ctx.ui.prompts.password({ message: 'Paste the DNS token' });
  }
  const dns = dnsApi(ctx);
  if (!dns)
    throw new InstallError(
      'Adding the fallback hostname needs the DNS token.',
      'Add "dnsToken" to the answers file, or run this command in a terminal to paste it.',
    );
  await ctx.ui.task('Checking the DNS token', () => verifyToken(dns));
  await ctx.ui.task(`Pointing ${h.sites} at Swarm`, () =>
    upsertRecord(dns, zoneId(ctx), {
      type: 'AAAA',
      name: h.sites,
      content: '100::',
      proxied: true,
    }),
  );
  await ctx.ui.task(`Setting the fallback origin to ${h.sites}`, () =>
    cf.put(`/zones/${zoneId(ctx)}/custom_hostnames/fallback_origin`, { origin: h.sites }),
  );
  await finish(ctx, ['site', 'send', 'jobs', 'api']);
}

function form(fields: [string, string][]) {
  return fields.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

async function payments(ctx: Ctx) {
  const { h } = requireInstall(ctx);
  ctx.ui.note(
    'Payments (Stripe Connect)',
    [
      "Use the platform account's full secret key (sk_live_… or sk_test_…); a restricted key is not enough.",
      'Connect must be on with Standard accounts and OAuth (Connect > Settings).',
    ].join('\n'),
  );
  const answer = ctx.answers.stripe;
  const secretKey = await secret(
    ctx,
    answer?.secretKey ?? ctx.secrets.stripe?.secretKey,
    'Stripe secret key',
    (v) =>
      /^sk_(live|test)_/.test(v)
        ? undefined
        : 'Stripe secret keys start with sk_live_ or sk_test_.',
  );
  const connectClientId =
    answer?.connectClientId ??
    ctx.secrets.stripe?.connectClientId ??
    (ctx.interactive
      ? await ctx.ui.prompts.text({
          message: 'Connect client id (ca_…, under Connect > Settings > OAuth)',
          validate: (v) => (v.startsWith('ca_') ? undefined : 'It starts with ca_.'),
        })
      : undefined);
  if (!connectClientId)
    throw new InstallError(
      'Missing answer: the Stripe Connect client id.',
      'Add stripe.connectClientId to the answers file.',
    );

  const url = `https://${h.app}/api/v1/stripe/webhook`;
  const stripe = async <T>(method: 'GET' | 'POST', path: string, body?: string): Promise<T> => {
    const response = await ctx.t.http({
      method,
      url: `https://api.stripe.com${path}`,
      headers: {
        authorization: `Bearer ${secretKey}`,
        'stripe-version': STRIPE_API_VERSION,
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(body ? { body } : {}),
    });
    const parsed = JSON.parse(response.text || '{}') as T & { error?: { message?: string } };
    if (response.status >= 400) {
      throw new InstallError(
        `Stripe answered ${response.status}: ${parsed.error?.message ?? 'no details'}`,
        'Check the secret key and that Connect is on.',
      );
    }
    return parsed;
  };

  let webhookSecrets = ctx.secrets.stripe?.webhookSecrets;
  let webhookId = ctx.secrets.stripe?.webhookId;
  await ctx.ui.task(
    `Creating the Stripe Connect webhook ${url}`,
    async () => {
      const { data = [] } = await stripe<{ data?: { id: string; url: string }[] }>(
        'GET',
        '/v1/webhook_endpoints?limit=100',
      );
      const existing = data.find((w) => w.url === url);
      if (existing && webhookSecrets) {
        webhookId = existing.id;
        return 'already there';
      }
      if (existing) {
        throw new InstallError(
          `Stripe already has a webhook for ${url}, and its signing secret is not saved here.`,
          'Delete that endpoint in the Stripe dashboard (Developers > Webhooks) and run this again.',
        );
      }
      const created = await stripe<{ id: string; secret?: string }>(
        'POST',
        '/v1/webhook_endpoints',
        form([
          ['url', url],
          ['connect', 'true'],
          ['api_version', STRIPE_API_VERSION],
          ...STRIPE_EVENTS.map((e): [string, string] => ['enabled_events[]', e]),
        ]),
      );
      if (!created.secret)
        throw new InstallError('Stripe did not return the webhook signing secret.');
      webhookSecrets = created.secret;
      webhookId = created.id;
      return 'done';
    },
    (s) => s,
  );
  if (!webhookSecrets) throw new InstallError('The Stripe webhook secret is missing.');
  ctx.secrets.stripe = {
    secretKey,
    connectClientId,
    webhookSecrets,
    ...(webhookId ? { webhookId } : {}),
  };
  ctx.state.features.payments = true;
  await finish(ctx, featureWorkers('payments'));
  ctx.ui.note(
    'One step left in Stripe',
    `Add this redirect URI under Connect > Settings > OAuth:\nhttps://${h.app}/api/v1/payments/connect/callback`,
  );
}

async function google(ctx: Ctx) {
  const { h } = requireInstall(ctx);
  ctx.ui.note(
    'Google sign-in',
    `Create an OAuth client (type: Web application) in Google Cloud Console > APIs & Services > Credentials,\nwith this redirect URI:\nhttps://${h.app}/api/v1/auth/google/callback`,
  );
  const answer = ctx.answers.google;
  const clientId =
    answer?.clientId ??
    (ctx.interactive
      ? await ctx.ui.prompts.text({
          message: 'Client id',
          validate: (v) => (v.length > 10 ? undefined : 'Paste the client id.'),
        })
      : undefined);
  if (!clientId)
    throw new InstallError(
      'Missing answer: the Google client id.',
      'Add google.clientId to the answers file.',
    );
  const clientSecret = await secret(ctx, answer?.clientSecret, 'Client secret');
  ctx.secrets.google = { clientId, clientSecret };
  ctx.state.features.google = true;
  await finish(ctx, ['api']);
}

/** Credits left on a DeBounce account, through this run's transport; throws with the fix. */
export async function debounceBalance(ctx: Ctx, apiKey: string): Promise<number> {
  const response = await ctx.t.http({
    method: 'GET',
    url: `https://api.debounce.io/v1/balance/?api=${encodeURIComponent(apiKey)}`,
    headers: { accept: 'application/json' },
  });
  const body = JSON.parse(response.text || '{}') as { balance?: unknown };
  const balance = Number(body.balance);
  if (response.status === 401 || response.status === 403) {
    throw new InstallError(
      'DeBounce did not accept this API key.',
      `Copy the key again from ${DEBOUNCE_API_SETTINGS_URL} and run \`pnpm swarm enable debounce\`.`,
    );
  }
  if (response.status >= 400 || !Number.isFinite(balance)) {
    throw new InstallError(
      `DeBounce answered ${response.status} without a balance.`,
      'Try again in a minute; check https://debounce.com for an outage.',
    );
  }
  return balance;
}

async function debounce(ctx: Ctx) {
  requireInstall(ctx);
  ctx.ui.note(
    'Email checks with DeBounce',
    [
      "Swarm can check subscribers' addresses with DeBounce, at signup, on import and across the list.",
      `1. Create a DeBounce account: ${DEBOUNCE_SIGNUP_URL}`,
      `2. Open API settings in DeBounce (${DEBOUNCE_API_SETTINGS_URL}) and copy the API key.`,
      '3. Paste it below. The api, capture, jobs and vault workers keep it as DEBOUNCE_API_KEY.',
      'Credits are yours: workspaces of instance admins use them; others only once you allow them',
      '(DeBounce card on the Apps page).',
    ].join('\n'),
  );
  const apiKey = (
    await secret(
      ctx,
      ctx.answers.debounceApiKey ?? ctx.secrets.debounceApiKey,
      'DeBounce API key',
      (v) =>
        /^\S{8,100}$/.test(v.trim()) ? undefined : "Paste the key from DeBounce's API settings.",
    )
  ).trim();
  if (ctx.dryRun) {
    ctx.ui.info('> Checking the key with DeBounce (skipped in a dry run)');
  } else {
    const balance = await ctx.ui.task(
      'Checking the key with DeBounce',
      () => debounceBalance(ctx, apiKey),
      (n) => `${n.toLocaleString('en-US')} credits`,
    );
    if (balance === 0)
      ctx.ui.warn('The account has no credits yet: checks pause until you add some.');
  }
  ctx.secrets.debounceApiKey = apiKey;
  ctx.state.features.debounce = true;
  await finish(ctx, featureWorkers('debounce'));
}

export async function enable(ctx: Ctx, feature: FeatureName) {
  await signIn(ctx);
  if (feature === 'custom-domains') await customDomains(ctx);
  else if (feature === 'payments') await payments(ctx);
  else if (feature === 'debounce') await debounce(ctx);
  else await google(ctx);
  ctx.ui.info(`\n${feature} is on.`);
}
