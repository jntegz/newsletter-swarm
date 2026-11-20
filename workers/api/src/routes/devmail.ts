import { idPattern } from '@swarm/domain';
import { compileCircle } from '@swarm/engine';
import { escapeHtml } from '@swarm/mail';
import { ApiError, localRequest } from '@swarm/runtime';
import { Hono } from 'hono';
import { isLocal } from '../env';
import { circlePreviewQueries } from '../lib/circle-preview';
import { env, type AppEnv } from '../lib/context';
import { devMailbox } from '../lib/mail';

/**
 * Local development mailbox viewer. Answers 404 unless ENVIRONMENT is development or test and the
 * request came in on a local host name (localRequest), so it can never expose mail in staging or
 * production, nor on a script deployed with development settings by mistake.
 */
export const devmail = new Hono<AppEnv>();

devmail.use('/__dev/*', async (c, next) => {
  const e = env(c);
  if (!isLocal(e) || !devMailbox(e) || !localRequest(c.req.url)) {
    throw new ApiError('not_found', 'Not found.');
  }
  // Rendered mail is untrusted HTML: never let it run script or load anything.
  c.header(
    'content-security-policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src * data:; frame-src 'self'",
  );
  await next();
});

// EXPLAIN QUERY PLAN of a live count's queries, for scripts/load/circle-counts.mjs.
devmail.post('/__dev/circles/explain', async (c) => {
  const { channelId, rule } = await c.req.json<{ channelId: string; rule: unknown }>();
  if (!idPattern('channel').test(channelId))
    throw new ApiError('invalid_input', 'Bad publication.');
  const db = env(c).DB;
  const queries = circlePreviewQueries(await compileCircle(db, rule, channelId), channelId);
  const statements = await Promise.all(
    Object.values(queries).map(async ({ sql, params }) => {
      const { results } = await db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...params)
        .all<{ detail: string }>();
      return { sql, plan: results.map((r) => r.detail) };
    }),
  );
  return c.json({ data: { statements } });
});

devmail.get('/__dev/mail/latest.json', async (c) => {
  const to = c.req.query('to');
  const [message] = await devMailbox(env(c))!.list({ ...(to ? { to } : {}), limit: 1 });
  if (!message) throw new ApiError('not_found', 'No mail yet.');
  return c.json({ data: message });
});

devmail.get('/__dev/mail', async (c) => {
  const messages = await devMailbox(env(c))!.list({ limit: 50 });
  const rows = messages
    .map(
      (m) =>
        `<li><a href="/__dev/mail/${m.id}"><b>${escapeHtml(m.subject)}</b></a><br><small>${escapeHtml(m.to)} · ${escapeHtml(m.sentAt)} · ${escapeHtml(m.category)}</small></li>`,
    )
    .join('');
  return c.html(
    page(
      'Dev mailbox',
      `<h1>Dev mailbox</h1><p>Mail sent locally is kept here instead of being delivered.</p><ul>${rows || '<li>No mail yet.</li>'}</ul>`,
    ),
  );
});

devmail.get('/__dev/mail/:id', async (c) => {
  const message = await devMailbox(env(c))!.get(c.req.param('id'));
  if (!message) throw new ApiError('not_found', 'Message not found.');
  const links = [...message.text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]);
  return c.html(
    page(
      message.subject,
      `<p><a href="/__dev/mail">All mail</a></p><h1>${escapeHtml(message.subject)}</h1>
<p><small>To ${escapeHtml(message.to)} · ${escapeHtml(message.sentAt)}</small></p>
${links.map((link) => `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`).join('')}
<iframe sandbox title="Message" srcdoc="${escapeHtml(message.html)}" style="width:100%;height:520px;border:1px solid #efedf6;border-radius:12px"></iframe>
<pre style="white-space:pre-wrap">${escapeHtml(message.text)}</pre>`,
    ),
  );
});

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;color:#0f0f12}a{color:#5636e8}li{margin:10px 0}</style>
</head><body>${body}</body></html>`;
}
