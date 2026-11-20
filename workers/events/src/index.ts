// Mail provider feedback.
// - POST /sns/ses   SES events through SNS: signature-verified, topic-allowlisted, then applied
//                   (hard bounce → suppress, complaint → suppress and unsubscribe, delivery);
//                   each MessageId works once. 404 when SNS_TOPIC_ARNS is not set.
// - POST /resend    Resend webhooks (Svix-signed with RESEND_WEBHOOK_SECRET; each svix-id works
//                   once), mapped onto the same SES events; 404 when the secret is not set.
// - POST /mailgun   Mailgun webhooks (signed with MAILGUN_WEBHOOK_SIGNING_KEY; each token works
//                   once), mapped the same way; 404 when the key is not set.
// - POST /postmark  Postmark webhooks (HTTP Basic auth with POSTMARK_WEBHOOK_SECRET; each bounce
//                   or complaint ID works once), mapped the same way; 404 when the secret is not set.
// - POST /smtp-feedback  Reports from a person's own mail server (Svix-signed with
//                   SMTP_FEEDBACK_SECRET; each svix-id works once), mapped the same way; 404 when
//                   the secret is not set.
// - email()        Email Routing for unsub+<code>@<UNSUBSCRIBE_MAIL_DOMAIN>, the mailto half
//                   of List-Unsubscribe, and DMARC aggregate reports to
//                   dmarc+<sendingDomainId>@<DMARC_MAIL_DOMAIN> (Phase 7): parsed into
//                   dmarc_reports, the raw file kept in R2 REPORTS.
import {
  checkLinkEnv,
  DMARC_LIMITS,
  EngineEnvFields,
  LinkEnvFields,
  MailEnvFields,
  applySesEvent,
  authenticatedDomains,
  bounceCodeFromAddress,
  bounceIsAuthenticated,
  bounceMessageToSesEvent,
  claimMailgunToken,
  corroborateEvent,
  mailgunEventHash,
  claimSvixId,
  claimWebhookId,
  dmarcDomainIdFromAddress,
  ingestDmarcMessage,
  isPlainEnvelopeSender,
  isSnsHost,
  mailgunToSesEvent,
  parseSnsMessage,
  POSTMARK_EVENT_ID_LIFETIME_MS,
  readAnyBounceCode,
  SNS_MESSAGE_ID_LIFETIME_MS,
  postmarkEventKey,
  postmarkToSesEvent,
  postmarkUnsubscribedDelivery,
  queueChannelChanged,
  readUnsubscribeCode,
  releaseMailgunToken,
  releaseSvixId,
  releaseWebhookId,
  resendToSesEvent,
  smtpFeedbackToSesEvent,
  unsubscribeDelivery,
  verifyMailgunSignature,
  verifyPostmarkAuth,
  verifySnsMessage,
  verifySvix,
  type PublicMessage,
  type SesEvent,
  type SvixScope,
} from '@swarm/engine';
import {
  BaseEnvSchema,
  binding,
  createLogger,
  defineEnv,
  errorResponse,
  redact,
  useRuntime,
  type RuntimeVariables,
} from '@swarm/runtime';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { linkModeFromEnv } from '@swarm/tokens';

const parseEnv = defineEnv(
  BaseEnvSchema.extend({
    DB: binding<D1Database>(),
    /**
     * The public queue, the only one this worker can write to: Circles re-evaluate when a bounce
     * or complaint changes a Member.
     */
    PUBLIC_QUEUE: binding<Queue<PublicMessage>>(),
    /** Raw DMARC aggregate report files (private). */
    REPORTS: binding<R2Bucket>(),
    UNSUBSCRIBE_KEYS: EngineEnvFields.UNSUBSCRIBE_KEYS,
    /** Verifies bounce codes, which only the send worker signs (since the link cutover). */
    BOUNCE_KEYS: EngineEnvFields.BOUNCE_KEYS,
    /** When the link cutover was: bounce codes under UNSUBSCRIBE_KEYS count for 14 days after. */
    LINK_SIGNING_MODE: LinkEnvFields.LINK_SIGNING_MODE,
    LINK_LEGACY_CUTOFF: LinkEnvFields.LINK_LEGACY_CUTOFF,
    /** Domain whose Email Routing receives dmarc+<sendingDomainId>@ reports. */
    DMARC_MAIL_DOMAIN: z.string().min(3),
    /** Comma-separated SNS topic ARNs whose messages are accepted (SES installs). */
    SNS_TOPIC_ARNS: z
      .string()
      .min(1)
      .transform((value) =>
        value
          .split(',')
          .map((arn) => arn.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().regex(/^arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]+$/)).min(1))
      .optional(),
    /** Signing secret of the Resend webhook (Resend installs). */
    RESEND_WEBHOOK_SECRET: z
      .string()
      .regex(/^whsec_[A-Za-z0-9+/=]+$/, 'a Svix signing secret starts with whsec_')
      .optional(),
    /** The Mailgun account's webhook signing key, not its API key (Mailgun installs). */
    MAILGUN_WEBHOOK_SIGNING_KEY: z.string().min(16).optional(),
    /** The password Postmark sends on its webhooks, which aren't signed (Postmark installs). */
    POSTMARK_WEBHOOK_SECRET: z.string().min(16).optional(),
    /**
     * The SMTP relay the send worker uses (SMTP installs): a bounce it signs counts as hard.
     * Without it, only bounces from the reader's own mail provider do.
     */
    SMTP_HOST: MailEnvFields.SMTP_HOST,
    /**
     * Comma-separated domains the relay's own bounces authenticate as, when that isn't the
     * domain of SMTP_HOST (SMTP installs). The common relays are known without it.
     */
    SMTP_BOUNCE_DOMAINS: z
      .string()
      .transform((value) =>
        value
          .split(',')
          .map((domain) => domain.trim().toLowerCase())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().regex(/^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/, 'a domain')))
      .optional(),
    /** Signs reports from a person's own mail server (SMTP installs). */
    SMTP_FEEDBACK_SECRET: z
      .string()
      .regex(/^whsec_[A-Za-z0-9+/=]+$/, 'a signing secret starts with whsec_')
      .optional(),
  }).superRefine((env, ctx) => checkLinkEnv(env, ctx, { signs: false })),
);

export const app = new Hono<{ Variables: RuntimeVariables }>();
useRuntime(app, { service: 'events', parseEnv });

const log = createLogger({ service: 'events' });

/**
 * Applies the event of a verified Svix webhook once per svix-id. A repeat is answered 200, which
 * stops the sender retrying; an id whose event fails is released so the retry is applied.
 */
async function applySvixEvent(
  c: Context<{ Variables: RuntimeVariables }>,
  env: ReturnType<typeof parseEnv>,
  scope: SvixScope,
  event: SesEvent,
) {
  const id = c.req.header('svix-id') as string;
  if (!(await claimSvixId(env.DB, scope, id))) {
    return c.json({ data: { handled: false, kind: 'replay' } });
  }
  try {
    return c.json({ data: await applyEvent(env, event, c.executionCtx) });
  } catch (error) {
    await releaseSvixId(env.DB, scope, id).catch(() => {});
    throw error;
  }
}

/** The same as applySvixEvent, for a provider whose event key isn't a svix-id. */
async function applyEventOnce(
  c: Context<{ Variables: RuntimeVariables }>,
  env: ReturnType<typeof parseEnv>,
  key: string,
  lifetimeMs: number,
  event: SesEvent,
) {
  if (!(await claimWebhookId(env.DB, key, lifetimeMs))) {
    return c.json({ data: { handled: false, kind: 'replay' } });
  }
  try {
    return c.json({ data: await applyEvent(env, event, c.executionCtx) });
  } catch (error) {
    await releaseWebhookId(env.DB, key).catch(() => {});
    throw error;
  }
}

/** Applies a provider event. Unknown deliveries are acknowledged too: retrying would never find them. */
async function applyEvent(
  env: ReturnType<typeof parseEnv>,
  event: SesEvent,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  options: { corroborate?: boolean } = {},
) {
  const { memberChangedIn, ...result } = await applySesEvent(env.DB, event, Date.now(), options);
  if (result.rampPaused) log.warn('reputation ramp paused', { reason: result.rampPaused });
  if (memberChangedIn) {
    ctx.waitUntil(queueChannelChanged(env.PUBLIC_QUEUE, memberChangedIn));
  }
  return result;
}

app.post('/sns/ses', async (c) => {
  const env = parseEnv(c.env);
  if (!env.SNS_TOPIC_ARNS) return errorResponse(c, 'not_found', 'Not found.');
  const allowedTopics = env.SNS_TOPIC_ARNS;
  const body = await c.req.text();
  if (body.length > 256 * 1024) return errorResponse(c, 'invalid_input', 'Message too large.');
  const message = parseSnsMessage(body);
  if (!message) return errorResponse(c, 'invalid_input', 'Not an SNS message.');

  const verified = await verifySnsMessage(message, { allowedTopics });
  if (!verified.ok) {
    log.warn('rejected SNS message', { reason: verified.reason, topic: message.TopicArn });
    return errorResponse(c, 'forbidden', 'Signature check failed.');
  }

  if (message.Type === 'SubscriptionConfirmation') {
    // Only confirm on SNS's own host, for an allowlisted topic (checked above).
    if (!message.SubscribeURL || !isSnsHost(message.SubscribeURL)) {
      return errorResponse(c, 'invalid_input', 'Unexpected subscribe URL.');
    }
    const res = await fetch(message.SubscribeURL);
    log.info('confirmed SNS subscription', { topic: message.TopicArn, status: res.status });
    return c.json({ data: { confirmed: res.ok } });
  }
  if (message.Type === 'UnsubscribeConfirmation') return c.json({ data: { ok: true } });

  let event: SesEvent;
  try {
    event = JSON.parse(message.Message) as SesEvent;
  } catch {
    return errorResponse(c, 'invalid_input', 'Notification body is not JSON.');
  }
  // MessageId is signed, so a captured notification resent within the hour is a replay.
  const key = `sns:${message.MessageId}`;
  return applyEventOnce(c, env, key, SNS_MESSAGE_ID_LIFETIME_MS, event);
});

app.post('/resend', async (c) => {
  const env = parseEnv(c.env);
  if (!env.RESEND_WEBHOOK_SECRET) return errorResponse(c, 'not_found', 'Not found.');
  const body = await c.req.text();
  if (body.length > 256 * 1024) return errorResponse(c, 'invalid_input', 'Message too large.');
  const verified = await verifySvix(
    env.RESEND_WEBHOOK_SECRET,
    {
      id: c.req.header('svix-id'),
      timestamp: c.req.header('svix-timestamp'),
      signature: c.req.header('svix-signature'),
    },
    body,
  );
  if (!verified.ok) {
    log.warn('rejected Resend webhook', { reason: verified.reason });
    return errorResponse(c, 'unauthorized', 'Signature check failed.');
  }
  let payload: { type?: unknown; data?: { email_id?: unknown; failed?: unknown } };
  try {
    payload = JSON.parse(body) as typeof payload;
  } catch {
    return errorResponse(c, 'invalid_input', 'Webhook body is not JSON.');
  }
  const event = resendToSesEvent(payload);
  if (!event) {
    if (payload.type === 'email.failed') {
      // Resend could not send it at all (e.g. the daily quota); the send already counted it.
      log.warn('Resend could not send an email', {
        emailId: String(payload.data?.email_id ?? '').slice(0, 100),
        // Redacted before it is cut short: a cut can leave an address the redactor can't see.
        failed: redact(JSON.stringify(payload.data?.failed ?? null)).slice(0, 300),
      });
    }
    return c.json({ data: { handled: false, kind: 'ignored' } });
  }
  return applySvixEvent(c, env, 'resend', event);
});

app.post('/mailgun', async (c) => {
  const env = parseEnv(c.env);
  if (!env.MAILGUN_WEBHOOK_SIGNING_KEY) return errorResponse(c, 'not_found', 'Not found.');
  const raw = await c.req.text();
  if (raw.length > 256 * 1024) return errorResponse(c, 'invalid_input', 'Message too large.');
  let body: { signature?: unknown; 'event-data'?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return errorResponse(c, 'invalid_input', 'Webhook body is not JSON.');
  }
  const verified = await verifyMailgunSignature(env.MAILGUN_WEBHOOK_SIGNING_KEY, body?.signature);
  if (!verified.ok) {
    log.warn('rejected Mailgun webhook', { reason: verified.reason });
    return errorResponse(c, 'unauthorized', 'Signature check failed.');
  }
  // Mailgun's docs show the event both inside "event-data" and at the top level.
  const eventBody = body['event-data'] ?? body;
  const event = mailgunToSesEvent(eventBody);
  if (!event) return c.json({ data: { handled: false, kind: 'ignored' } });
  // The signature doesn't cover the event, so one that disagrees with Swarm's record of the send
  // it names changes nothing, and doesn't use up the token the genuine event will come with.
  if ((await corroborateEvent(env.DB, event)) === 'mismatch') {
    log.warn('Mailgun event disagrees with the send it names');
    return c.json({ data: { handled: false, kind: 'ignored' } });
  }
  // Answering 200 stops Mailgun retrying, which is right for a token already applied.
  if (
    !(await claimMailgunToken(
      env.DB,
      verified.token,
      Date.now(),
      await mailgunEventHash(eventBody),
    ))
  ) {
    return c.json({ data: { handled: false, kind: 'replay' } });
  }
  try {
    return c.json({ data: await applyEvent(env, event, c.executionCtx, { corroborate: true }) });
  } catch (error) {
    await releaseMailgunToken(env.DB, verified.token).catch(() => {});
    throw error;
  }
});

app.post('/postmark', async (c) => {
  const env = parseEnv(c.env);
  if (!env.POSTMARK_WEBHOOK_SECRET) return errorResponse(c, 'not_found', 'Not found.');
  if (!(await verifyPostmarkAuth(c.req.header('authorization'), env.POSTMARK_WEBHOOK_SECRET))) {
    log.warn('rejected Postmark webhook');
    return errorResponse(c, 'unauthorized', 'Wrong credentials.');
  }
  const raw = await c.req.text();
  if (raw.length > 256 * 1024) return errorResponse(c, 'invalid_input', 'Message too large.');
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return errorResponse(c, 'invalid_input', 'Webhook body is not JSON.');
  }
  // A reader who used Postmark's own unsubscribe link must be unsubscribed here too.
  const unsubscribed = postmarkUnsubscribedDelivery(payload);
  if (unsubscribed) {
    const result = await unsubscribeDelivery(env.DB, unsubscribed);
    return c.json({ data: { handled: result !== null, kind: 'unsubscribe' } });
  }
  const event = postmarkToSesEvent(payload);
  if (!event) return c.json({ data: { handled: false, kind: 'ignored' } });
  const key = await postmarkEventKey(payload, raw);
  return applyEventOnce(c, env, key, POSTMARK_EVENT_ID_LIFETIME_MS, event);
});

app.post('/smtp-feedback', async (c) => {
  const env = parseEnv(c.env);
  if (!env.SMTP_FEEDBACK_SECRET) return errorResponse(c, 'not_found', 'Not found.');
  const body = await c.req.text();
  if (body.length > 64 * 1024) return errorResponse(c, 'invalid_input', 'Message too large.');
  const verified = await verifySvix(
    env.SMTP_FEEDBACK_SECRET,
    {
      id: c.req.header('svix-id'),
      timestamp: c.req.header('svix-timestamp'),
      signature: c.req.header('svix-signature'),
    },
    body,
  );
  if (!verified.ok) {
    log.warn('rejected mail server report', { reason: verified.reason });
    return errorResponse(c, 'unauthorized', 'Signature check failed.');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return errorResponse(c, 'invalid_input', 'Report is not JSON.');
  }
  const event = smtpFeedbackToSesEvent(payload);
  if (!event) return errorResponse(c, 'invalid_input', 'Report needs a type and a messageId.');
  return applySvixEvent(c, env, 'smtp-feedback', event);
});

/** unsub+<code>@domain → the code, or null. */
export function codeFromAddress(address: string): string | null {
  const match = /^unsub\+([0-9a-f]{32}-[0-9a-f]{20})@/i.exec(address.trim());
  return match?.[1]?.toLowerCase() ?? null;
}

/** Bounces can quote the whole email; the status comes first, so a larger one isn't needed. */
const BOUNCE_MESSAGE_BYTES = 1024 * 1024;
/**
 * Each delivery counts once as a hard and once as a soft bounce, however often its return path is
 * mailed. Longer than the 7-day soft bounce window, so one email can't add up to a suppression.
 */
const BOUNCE_REPLAY_LIFETIME_MS = 8 * 24 * 60 * 60 * 1000;
// Mail servers give up retrying within about five days. The return path is in the delivered
// copy's headers, so a bounce for an older email is more likely someone with the raw message.
const BOUNCE_ACCEPT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What Email Routing authenticated about a message. Nothing, when the envelope sender has
 * characters that could reshape the header Email Routing echoes it into.
 */
function authenticatedSender(message: ForwardableEmailMessage) {
  return isPlainEnvelopeSender(message.from) ? authenticatedDomains(message.headers) : { dkim: [] };
}

/** The raw message, or null past `limit` bytes (the stream is canceled there). */
async function readRaw(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const raw = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return raw;
}

/**
 * A DMARC aggregate report. Bad input is logged and dropped, never rejected: a bounce would only
 * make the reporter try again. Storage errors throw, so Email Routing retries later.
 */
async function handleDmarcReport(
  message: ForwardableEmailMessage,
  env: ReturnType<typeof parseEnv>,
  sendingDomainId: string,
): Promise<void> {
  const from = message.from.slice(0, 200);
  if (message.rawSize > DMARC_LIMITS.messageBytes) {
    log.warn('dropped DMARC report', { sendingDomainId, from, reason: 'message is too large' });
    return;
  }
  const raw = await readRaw(message.raw, DMARC_LIMITS.messageBytes);
  if (!raw) {
    log.warn('dropped DMARC report', { sendingDomainId, from, reason: 'message is too large' });
    return;
  }
  const result = await ingestDmarcMessage(
    { db: env.DB, reports: env.REPORTS },
    // The reporter is keyed on what Email Routing verified, not on the envelope sender's claim.
    { sendingDomainId, authenticated: authenticatedSender(message), raw },
  );
  if (result.status === 'dropped') {
    log.warn('dropped DMARC report', { sendingDomainId, from, reason: result.reason });
  } else {
    log.info('DMARC report', { sendingDomainId, from, ...result });
  }
}

/**
 * A bounce for an email Swarm sent over SMTP. Bad input is logged and dropped, never rejected:
 * rejecting a bounce would only make the server bounce the bounce.
 */
async function handleBounceMessage(
  message: ForwardableEmailMessage,
  env: ReturnType<typeof parseEnv>,
  code: string,
  ctx?: { waitUntil(promise: Promise<unknown>): void },
): Promise<void> {
  // Only the return path's own code: the unsubscribe code is in every forwarded copy.
  // BOUNCE_KEYS, or for a while after the link cutover UNSUBSCRIBE_KEYS, which signed it before.
  const deliveryId = await readAnyBounceCode(
    {
      bounceKeys: env.BOUNCE_KEYS,
      unsubscribeKeys: env.UNSUBSCRIBE_KEYS,
      mode: linkModeFromEnv(env),
    },
    code,
  );
  if (!deliveryId) {
    log.warn('dropped a bounce with an unknown code');
    return;
  }
  const sent = await env.DB.prepare('SELECT sent_at, email FROM deliveries WHERE id = ?1')
    .bind(deliveryId)
    .first<{ sent_at: number; email: string }>();
  if (!sent || sent.sent_at < Date.now() - BOUNCE_ACCEPT_WINDOW_MS) {
    log.info('dropped a bounce for an email sent too long ago', { deliveryId });
    return;
  }
  const raw = await readRaw(message.raw, BOUNCE_MESSAGE_BYTES);
  const event = raw && bounceMessageToSesEvent(deliveryId, new TextDecoder().decode(raw));
  if (!event) {
    log.info('dropped mail to the bounce address that is not a bounce', { deliveryId });
    return;
  }
  // Anyone with the delivered copy can mail its return path. A permanent failure that doesn't
  // authenticate as the reader's mail server or the relay only counts as soft, which suppresses
  // after three in seven days.
  if (
    event.bounce?.bounceType === 'Permanent' &&
    !bounceIsAuthenticated({
      authenticated: authenticatedSender(message),
      envelopeFrom: message.from,
      recipient: sent.email,
      relayHost: env.SMTP_HOST,
      relayBounceDomains: env.SMTP_BOUNCE_DOMAINS,
    })
  ) {
    log.info('counted an unauthenticated hard bounce as soft', { deliveryId });
    event.bounce.bounceType = 'Transient';
  }
  const key = `smtp-bounce:${deliveryId}:${event.bounce?.bounceType ?? ''}`;
  if (!(await claimWebhookId(env.DB, key, BOUNCE_REPLAY_LIFETIME_MS))) {
    log.info('dropped a repeated bounce', { deliveryId });
    return;
  }
  try {
    await applyEvent(env, event, ctx ?? { waitUntil: () => {} });
  } catch (error) {
    await releaseWebhookId(env.DB, key).catch(() => {});
    throw error;
  }
}

export async function handleEmail(
  message: ForwardableEmailMessage,
  rawEnv: unknown,
  ctx?: { waitUntil(promise: Promise<unknown>): void },
): Promise<void> {
  const env = parseEnv(rawEnv);
  const sendingDomainId = dmarcDomainIdFromAddress(message.to, env.DMARC_MAIL_DOMAIN);
  if (sendingDomainId) return handleDmarcReport(message, env, sendingDomainId);
  if (message.to.trim().toLowerCase().endsWith(`@${env.DMARC_MAIL_DOMAIN.toLowerCase()}`)) {
    // Anything else on the report domain (a malformed dmarc+ address, a stray message).
    log.warn('dropped mail to the DMARC domain', { to: redact(message.to).slice(0, 200) });
    return;
  }
  const bounceCode = bounceCodeFromAddress(message.to);
  if (bounceCode) return handleBounceMessage(message, env, bounceCode, ctx);
  const code = codeFromAddress(message.to);
  const deliveryId = code ? await readUnsubscribeCode(env.UNSUBSCRIBE_KEYS, code) : null;
  if (!deliveryId) {
    message.setReject('Unknown address');
    return;
  }
  const result = await unsubscribeDelivery(env.DB, deliveryId);
  if (!result) message.setReject('Unknown address');
  else log.info('unsubscribed by email', { deliveryId });
}

export default {
  fetch: app.fetch,
  email: handleEmail,
} satisfies ExportedHandler;
