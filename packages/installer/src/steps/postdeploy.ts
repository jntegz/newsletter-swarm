import { CloudflareError } from '../cloudflare';
import { dnsApi, oauthApi, save, saveSecrets, zoneId, type Ctx } from '../context';
import { hostnamesFor } from '../hostnames';
import { MAILGUN_WEBHOOKS, MailgunRest } from '../mailgun';
import { scriptName } from '../paths';
import {
  POSTMARK_BROADCAST_STREAM,
  POSTMARK_TRANSACTIONAL_STREAM,
  PostmarkRest,
} from '../postmark';
import { RESEND_EVENTS, ResendRest } from '../resend';
import { InstallError } from '../ui';
import { deployWorker } from './deploy';
import type { Step } from './step';

interface Health {
  ok: boolean;
  status: number;
  environment?: string;
  service?: string;
  problem?: string;
}

export async function checkHealth(ctx: Ctx, host: string): Promise<Health> {
  try {
    const response = await ctx.t.http({ method: 'GET', url: `https://${host}/healthz` });
    let data: { ok?: boolean; environment?: string; service?: string } = {};
    let message: string | undefined;
    try {
      const body = JSON.parse(response.text) as {
        data?: typeof data;
        error?: { message?: string };
      };
      data = body.data ?? {};
      // A worker bound to the vault answers 503 with this when the vault does not answer it.
      message = body.error?.message;
    } catch {
      data = {};
    }
    const environmentOk = data.environment === ctx.env;
    return {
      ok: response.status === 200 && data.ok === true && environmentOk,
      status: response.status,
      ...(data.environment ? { environment: data.environment } : {}),
      ...(data.service ? { service: data.service } : {}),
      ...(response.status !== 200
        ? { problem: `answered ${response.status}${message ? `: ${message}` : ''}` }
        : !environmentOk
          ? {
              problem: `reports environment "${data.environment ?? 'unknown'}", expected "${ctx.env}"`,
            }
          : {}),
    };
  } catch (error) {
    return { ok: false, status: 0, problem: (error as Error).message };
  }
}

/** Polls /healthz until it answers, for new hostnames whose certificate is still being issued. */
export async function waitForHealth(ctx: Ctx, host: string, timeoutMs = 180_000): Promise<Health> {
  const started = Date.now();
  let last: Health = { ok: false, status: 0 };
  for (let attempt = 0; ; attempt++) {
    last = await checkHealth(ctx, host);
    if (last.ok || Date.now() - started > timeoutMs || attempt > 60) return last;
    await ctx.t.sleep(5_000);
  }
}

export async function subscribeSns(ctx: Ctx, endpoint: string) {
  const ses = ctx.state.ses;
  const region = ctx.state.choices?.mail.region;
  if (!ses || !region) return;
  if (!ctx.session.awsAdmin) {
    if (!ses.subscriptionConfirmed) {
      ctx.ui.warn(
        'The SNS subscription could not be checked without the AWS admin key. Run `pnpm swarm` with the key to finish it.',
      );
    }
    return;
  }
  const credentials = ctx.session.awsAdmin;
  const aws = <T>(operation: string, input: Record<string, unknown>) =>
    ctx.t.aws<T>({ service: 'sns', operation, input, region, credentials });
  type Subs = { Subscriptions?: { Endpoint?: string; SubscriptionArn?: string }[] };
  const find = async () =>
    (
      (await aws<Subs>('ListSubscriptionsByTopic', { TopicArn: ses.topicArn })).Subscriptions ?? []
    ).find((s) => s.Endpoint === endpoint);
  const confirmed = await ctx.ui.task(
    `Subscribing ${endpoint} to SES events`,
    async () => {
      let sub = await find();
      // A pending subscription is asked again: its first confirmation may have been refused, and
      // subscribing again re-sends it without adding a second subscription.
      if (!sub?.SubscriptionArn?.startsWith('arn:')) {
        await aws('Subscribe', { TopicArn: ses.topicArn, Protocol: 'https', Endpoint: endpoint });
        for (let i = 0; i < 12; i++) {
          sub = await find();
          if (sub?.SubscriptionArn && sub.SubscriptionArn.startsWith('arn:')) break;
          await ctx.t.sleep(5_000);
        }
      }
      return !!sub?.SubscriptionArn?.startsWith('arn:');
    },
    (ok) => (ok ? 'done' : 'waiting for the events worker to confirm'),
  );
  ses.subscriptionConfirmed = confirmed;
  await save(ctx);
}

async function resendFinish(ctx: Ctx, endpoint: string) {
  const key = ctx.secrets.resendApiKey;
  const domainId = ctx.state.resend?.domainId;
  if (!key || !domainId || !ctx.state.resend) return;
  const api = new ResendRest(ctx.t, key);

  const status = await ctx.ui.task(
    'Asking Resend to verify the sending domain',
    async () => {
      await api.verifyDomain(domainId);
      let current = 'pending';
      for (let i = 0; i < 12; i++) {
        current = (await api.getDomain(domainId)).status;
        if (current === 'verified' || current === 'failed') break;
        await ctx.t.sleep(10_000);
      }
      return current;
    },
    (s) => (s === 'verified' ? 'verified' : `${s} (DNS can take a while; Resend keeps checking)`),
  );
  ctx.state.resend.status = status;

  const hook = await ctx.ui.task(`Creating the Resend webhook ${endpoint}`, async () => {
    const existing = (await api.listWebhooks()).find((w) => w.endpoint === endpoint);
    if (!existing) return api.createWebhook(endpoint, RESEND_EVENTS);
    if (existing.signing_secret) return existing;
    const full = await api.getWebhook(existing.id);
    if (full.signing_secret || ctx.secrets.resendWebhookSecret) return full;
    // No secret anywhere: replace the webhook, since creating one always returns its secret.
    await api.deleteWebhook(existing.id);
    return api.createWebhook(endpoint, RESEND_EVENTS);
  });
  ctx.state.resend.webhookId = hook.id;
  await save(ctx);
  if (!hook.signing_secret) return;
  if (hook.signing_secret !== ctx.secrets.resendWebhookSecret) {
    ctx.secrets.resendWebhookSecret = hook.signing_secret;
    await saveSecrets(ctx);
    // The events worker verifies Resend's signatures with it.
    await deployWorker(ctx, 'events');
  }
}

async function mailgunFinish(ctx: Ctx, endpoint: string) {
  const key = ctx.secrets.mailgunApiKey;
  const domain = ctx.state.mailgun?.domain;
  const region = ctx.state.choices?.mail.region;
  if (!key || !domain || !ctx.state.mailgun) return;
  const api = new MailgunRest(ctx.t, key, region as 'us' | 'eu');

  const status = await ctx.ui.task(
    'Asking Mailgun to verify the sending domain',
    async () => {
      let current = 'unverified';
      for (let i = 0; i < 12; i++) {
        current = (await api.verifyDomain(domain)).domain?.state ?? current;
        if (current === 'active') break;
        await ctx.t.sleep(10_000);
      }
      return current;
    },
    (s) => (s === 'active' ? 'verified' : `${s} (DNS can take a while; Swarm keeps checking)`),
  );
  ctx.state.mailgun.status = status;
  await save(ctx);

  await ctx.ui.task(`Connecting Mailgun's webhooks to ${endpoint}`, async () => {
    const existing = await api.listWebhooks(domain);
    for (const id of MAILGUN_WEBHOOKS) {
      const urls = existing[id] ?? [];
      if (urls.includes(endpoint)) continue;
      if (urls.length) await api.updateWebhook(domain, id, [...urls, endpoint]);
      else await api.createWebhook(domain, id, endpoint);
    }
  });
}

async function postmarkFinish(ctx: Ctx, endpoint: string) {
  const { postmarkAccountToken: account, postmarkServerToken: server } = ctx.secrets;
  const secret = ctx.secrets.postmarkWebhookSecret;
  const state = ctx.state.postmark;
  if (!account || !server || !secret || !state) return;
  const api = new PostmarkRest(ctx.t, { account, server });

  const verified = await ctx.ui.task(
    'Asking Postmark to verify the sending domain',
    async () => {
      for (let i = 0; i < 12; i++) {
        const domain = await api.verifyDkim(state.domainId);
        if (domain.DKIMVerified) {
          await api.verifyReturnPath(state.domainId);
          return true;
        }
        await ctx.t.sleep(10_000);
      }
      return false;
    },
    (ok) => (ok ? 'verified' : 'not yet (DNS can take a while; Swarm keeps checking)'),
  );
  state.dkimVerified = verified;
  await save(ctx);

  await ctx.ui.task(`Connecting Postmark's webhooks to ${endpoint}`, async () => {
    await api.ensureWebhook(POSTMARK_TRANSACTIONAL_STREAM, endpoint, secret, false);
    // Only the stream with Postmark's unsubscribe link needs subscription changes.
    await api.ensureWebhook(POSTMARK_BROADCAST_STREAM, endpoint, secret, true);
  });
}

/**
 * Email Routing for unsubscribe.D and dmarc.D. Only the subdomains are added (never the apex,
 * whose mail stays as it is), and only literal rules: the catch-all is zone-wide. Optional:
 * one-click HTTPS unsubscribe works without it.
 */
async function emailRouting(ctx: Ctx) {
  const h = hostnamesFor(ctx.state.zone?.name ?? '', ctx.env, ctx.state.choices?.addresses);
  const zone = zoneId(ctx);
  const worker = scriptName('events', ctx.env);
  const apis = [oauthApi(ctx), dnsApi(ctx)].filter((a) => a !== null);
  const targets = [
    {
      domain: h.unsubscribe,
      address: `unsub@${h.unsubscribe}`,
      name: `swarm-${ctx.env}-unsubscribe`,
    },
    // A person's own server sends bounces back here.
    ...(ctx.state.choices?.mail.provider === 'smtp'
      ? [
          {
            domain: h.unsubscribe,
            address: `bounce@${h.unsubscribe}`,
            name: `swarm-${ctx.env}-bounce`,
          },
        ]
      : []),
    { domain: h.dmarc, address: `dmarc@${h.dmarc}`, name: `swarm-${ctx.env}-dmarc` },
  ];
  for (const target of targets) {
    try {
      await ctx.ui.task(
        `Routing mail for ${target.domain} to the events worker`,
        async () => {
          let lastError: unknown;
          for (const cf of apis) {
            try {
              await cf
                .post(`/zones/${zone}/email/routing/dns`, { name: target.domain })
                .catch((error: unknown) => {
                  // Already added is fine.
                  if (!(error instanceof CloudflareError) || error.forbidden) throw error;
                });
              const rules = await cf.list<{ name?: string }>(
                `/zones/${zone}/email/routing/rules`,
                {},
                50,
              );
              if (rules.some((r) => r.name === target.name)) return 'already there';
              await cf.post(`/zones/${zone}/email/routing/rules`, {
                name: target.name,
                enabled: true,
                priority: 0,
                matchers: [{ type: 'literal', field: 'to', value: target.address }],
                actions: [{ type: 'worker', value: [worker] }],
              });
              return 'done';
            } catch (error) {
              lastError = error;
            }
          }
          throw lastError;
        },
        (s) => s,
      );
    } catch (error) {
      ctx.ui.warn(
        `Email Routing for ${target.domain} could not be set up (${(error as Error).message.split('\n')[0]}). ` +
          'Unsubscribe links still work. To finish it by hand: Cloudflare dashboard > Email > Email Routing > Settings, ' +
          `add the subdomain ${target.domain}, then add a rule for ${target.address} that sends to the Worker ${worker}.`,
      );
    }
  }
}

export async function afterDeploy(ctx: Ctx) {
  const h = hostnamesFor(ctx.state.zone?.name ?? '', ctx.env, ctx.state.choices?.addresses);
  const health = await ctx.ui.task(
    `Waiting for ${h.events} to answer`,
    () => waitForHealth(ctx, h.events),
    (r) => (r.ok ? 'done' : `not yet (${r.problem ?? 'no answer'})`),
  );
  const provider = ctx.state.choices?.mail.provider;
  const endpoint =
    provider === 'ses'
      ? `https://${h.events}/sns/ses`
      : provider === 'mailgun'
        ? `https://${h.events}/mailgun`
        : provider === 'postmark'
          ? `https://${h.events}/postmark`
          : `https://${h.events}/resend`;
  if (!health.ok) {
    ctx.ui.warn(
      `${h.events} does not answer yet, so mail events are not connected. Run \`pnpm swarm\` again in a few minutes.`,
    );
  } else if (provider === 'ses') {
    await subscribeSns(ctx, endpoint);
  } else if (provider === 'mailgun') {
    await mailgunFinish(ctx, endpoint);
  } else if (provider === 'postmark') {
    await postmarkFinish(ctx, endpoint);
  } else if (provider !== 'smtp') {
    await resendFinish(ctx, endpoint);
  }
  await emailRouting(ctx);
}

export const postDeploy: Step = {
  id: 'post-deploy',
  title: 'Connecting mail events',
  run: afterDeploy,
};

export function requireChoices(ctx: Ctx) {
  if (!ctx.state.choices) throw new InstallError('Answers are missing.', 'Run `pnpm swarm` first.');
  return ctx.state.choices;
}
