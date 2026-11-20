// Branded links, the open pixel and unsubscribe pages, on the platform link domain and on
// Channels' verified link domains.
//
// - /c/<token>  302 to a server-side link target. A bad token never redirects anywhere, and a
//               publication's verified link domain redirects only for that publication's emails.
// - /o/<token>  a 1×1 GIF, never cached.
// - /u/<code>   GET shows a confirm page (link scanners prefetch GETs, so nothing changes);
//               POST unsubscribes, including the RFC 8058 One-Click POST from mailbox providers.
//               A Roster-targeted Broadcast leaves its Rosters; `scope=all` leaves everything.
//               The code is in every copy of the email, forwarded ones too, so the answer names
//               only the publication, never the address.
// Recording happens in waitUntil, so the response never waits on the database.
import {
  EngineEnvFields,
  linkFor,
  linkHostServes,
  readTrackToken,
  readUnsubscribeCode,
  recordClick,
  recordOpen,
  rosterUnsubscribePlan,
  unsubscribeDelivery,
  unsubscribeTarget,
  type TrackSignals,
} from '@swarm/engine';
import { escapeHtml } from '@swarm/mail';
import {
  BaseEnvSchema,
  binding,
  createLogger,
  defineEnv,
  useRuntime,
  type RuntimeVariables,
} from '@swarm/runtime';
import { Hono, type Context } from 'hono';

const parseEnv = defineEnv(
  BaseEnvSchema.extend({
    DB: binding<D1Database>(),
    TRACK_KEYS: EngineEnvFields.TRACK_KEYS,
    UNSUBSCRIBE_KEYS: EngineEnvFields.UNSUBSCRIBE_KEYS,
  }),
);

type AppEnv = { Variables: RuntimeVariables };
export const app = new Hono<AppEnv>();
useRuntime(app, { service: 'track', parseEnv, securityTxt: true });

const log = createLogger({ service: 'track' });

// Transparent 1×1 GIF.
const PIXEL = Uint8Array.from(
  atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
  (c) => c.charCodeAt(0),
);

function signals(c: Context<AppEnv>): TrackSignals {
  const cf = (c.req.raw as Request & { cf?: { asn?: number; asOrganization?: string } }).cf;
  return {
    method: c.req.method,
    userAgent: c.req.header('user-agent') ?? null,
    asn: typeof cf?.asn === 'number' ? cf.asn : null,
    asOrganization: cf?.asOrganization ?? null,
    ip: c.req.header('cf-connecting-ip') ?? null,
  };
}

/** Runs work after the response, logging instead of failing the request. */
function later(c: Context<AppEnv>, work: Promise<unknown>) {
  const guarded = work.catch((error: Error) =>
    log.error('tracking write failed', { error: error.message }),
  );
  try {
    c.executionCtx.waitUntil(guarded);
  } catch {
    // No execution context (unit tests): the promise still runs.
  }
}

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>body{margin:0;font-family:-apple-system,'Segoe UI',system-ui,sans-serif;background:#fbfbfd;color:#0f0f12}main{max-width:440px;margin:12vh auto;padding:32px;background:#fff;border:1px solid #efedf6;border-radius:18px}h1{font-size:22px;letter-spacing:-0.02em;margin:0 0 12px}p{font-size:15px;line-height:1.55;color:#3a3a44;margin:0 0 20px}button{font:inherit;font-weight:600;color:#fff;background:#6c4cf1;border:0;border-radius:999px;padding:12px 22px;cursor:pointer}button:focus-visible{outline:3px solid #b9a9fb;outline-offset:2px}form+form{margin-top:12px}@media (prefers-color-scheme:dark){body{background:#0f0f12;color:#f4f3f8}main{background:#17171c;border-color:#2a2a33}p{color:#c9c8d3}}</style>
</head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

const brokenLink = () =>
  page(
    'This link does not work',
    '<h1>This link does not work</h1><p>It may be incomplete or too old. Open the email again and use the link from there.</p>',
    404,
  );

/**
 * A real unsubscribe code whose email no longer finds anyone (past engagement retention and the
 * unsubscribe reference, or the person was erased or deleted). No button that can't work: the
 * page says so and how to stop the emails instead. 410, so a one-click POST is not reported as
 * done.
 */
const tooOld = () =>
  page(
    'This unsubscribe link is too old',
    '<h1>This unsubscribe link is too old</h1><p>This email is too old for its unsubscribe link to find your subscription, so nothing was changed.</p><p>To stop these emails, use the unsubscribe link in a more recent email from this publication, or open “Manage your subscription” in any recent email. You can also reply to a recent email and ask to be removed.</p>',
    410,
  );

const clickHandler = async (c: Context<AppEnv>) => {
  const env = parseEnv(c.env);
  const claims = await readTrackToken(env.TRACK_KEYS, c.req.param('token') ?? '');
  if (!claims?.l) return brokenLink();
  const target = await linkFor(env.DB, claims.d, claims.l);
  if (!target) return brokenLink();
  // A publication's own link domain redirects only for that publication's emails.
  if (!(await linkHostServes(env.DB, new URL(c.req.url).host, target.channelId))) {
    return brokenLink();
  }
  later(
    c,
    recordClick(
      env.DB,
      {
        deliveryId: claims.d,
        linkTargetId: claims.l,
        broadcastId: target.broadcastId,
        sentAt: target.sentAt,
      },
      signals(c),
    ),
  );
  return new Response(null, {
    status: 302,
    headers: {
      location: target.url,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
};
app.on(['GET', 'HEAD'], '/c/:token', clickHandler);

app.on(['GET', 'HEAD'], '/o/:token', async (c) => {
  const env = parseEnv(c.env);
  const claims = await readTrackToken(env.TRACK_KEYS, c.req.param('token'));
  if (claims && !claims.l) later(c, recordOpen(env.DB, claims.d, signals(c)));
  // Always a pixel, valid token or not, so the image never shows as broken.
  return new Response(c.req.method === 'HEAD' ? null : PIXEL, {
    headers: { 'content-type': 'image/gif', 'cache-control': 'no-store, max-age=0' },
  });
});

const names = (rosters: string[]) => rosters.map((name) => `“${escapeHtml(name)}”`).join(', ');

app.get('/u/:code', async (c) => {
  const env = parseEnv(c.env);
  const deliveryId = await readUnsubscribeCode(env.UNSUBSCRIBE_KEYS, c.req.param('code'));
  if (!deliveryId) return brokenLink();
  if (!(await unsubscribeTarget(env.DB, deliveryId))) return tooOld();
  // A Broadcast sent to Rosters (docs/rosters.md): leave those Rosters, or everything.
  const plan = await rosterUnsubscribePlan(env.DB, deliveryId);
  if (plan) {
    const rosters = plan.rosters.map((r) => r.name);
    const list = `Roster${rosters.length === 1 ? '' : 's'} ${names(rosters)}`;
    return page(
      'Unsubscribe',
      `<h1>Unsubscribe</h1><p>This email went to the ${list}. Leave ${rosters.length === 1 ? 'it' : 'them'}, or stop every email from this publication. You can join again at any time.</p>
<form method="post"><button type="submit">Leave the ${list}</button></form>
<form method="post"><input type="hidden" name="scope" value="all"><button type="submit">Unsubscribe from everything</button></form>`,
    );
  }
  return page(
    'Unsubscribe',
    `<h1>Unsubscribe</h1><p>Stop receiving these emails? You can join again at any time.</p>
<form method="post"><button type="submit">Unsubscribe</button></form>`,
  );
});

app.post('/u/:code', async (c) => {
  const env = parseEnv(c.env);
  const deliveryId = await readUnsubscribeCode(env.UNSUBSCRIBE_KEYS, c.req.param('code'));
  if (!deliveryId) return brokenLink();
  const body = await c.req.text();
  const scope = new URLSearchParams(body).get('scope') === 'all' ? 'all' : 'auto';
  const result = await unsubscribeDelivery(env.DB, deliveryId, Date.now(), { scope });
  if (!result) return tooOld();
  // Mailbox providers POST "List-Unsubscribe=One-Click" and only look at the status.
  if (/(^|&)List-Unsubscribe=One-Click(&|$)/.test(body)) {
    return c.text('Unsubscribed', 200, { 'cache-control': 'no-store' });
  }
  if (result.rosters) {
    const list = `Roster${result.rosters.length === 1 ? '' : 's'} ${names(result.rosters)}`;
    return page(
      'You left the Roster',
      `<h1>You left the ${list}</h1><p>This address will no longer receive emails sent to ${result.rosters.length === 1 ? 'it' : 'them'} from ${escapeHtml(result.channelName)}.</p>
<form method="post"><input type="hidden" name="scope" value="all"><button type="submit">Unsubscribe from everything</button></form>`,
    );
  }
  return page(
    'You are unsubscribed',
    `<h1>You are unsubscribed</h1><p>This address will no longer receive emails from ${escapeHtml(result.channelName)}.</p>`,
  );
});

export default app;
