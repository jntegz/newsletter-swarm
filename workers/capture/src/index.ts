// Capture Forms, confirm opt-in and the Member Center, on the forms origin.
//
//   /v1/<formId>.js         the embed loader (versioned for SRI, long cache when pinned)
//   /v1/<formId>/frame      the form iframe
//   /v1/<formId>/subscribe  JSON from the frame, or the no-JS form post
//   /v1/attr.js             site-wide first-touch attribution
//   /v1/confirm/<token>     GET page, POST confirm
//   /v1/leave/<token>       List-Unsubscribe for confirmation mail
//   /m, /m/<token>          the Member Center
//   /v1/j/<token>/<step>    Signup Journey steps after a sign-up (GET page, POST next)
//   /a/<token>              one-tap email poll answers (GET page, POST record)
// Cron: Gentle Reminders.
//
// CORS: only the two scripts send Access-Control-Allow-Origin (*, without credentials, which SRI
// needs). Every other endpoint is same-origin only: the frame posts to its own origin and the
// no-JS form is a plain navigation.
import { sendGentleReminders } from '@swarm/engine';
import { createLogger, useRuntime } from '@swarm/runtime';
import { Hono } from 'hono';
import { audienceDeps, type AppEnv } from './context';
import { parseCaptureEnv } from './env';
import { askRoutes } from './routes/ask';
import { confirmRoutes } from './routes/confirm';
import { embedRoutes } from './routes/embed';
import { journeyRoutes } from './routes/journey';
import { memberRoutes } from './routes/member';
import { privacyRoutes } from './routes/privacy';
import { subscribeRoutes } from './routes/subscribe';

export const app = new Hono<AppEnv>();

// Registered before the shared runtime, so it runs after its security headers on the way out:
// the frame must drop X-Frame-Options (its CSP frame-ancestors carries the allowlist instead)
// and the scripts must be loadable cross-origin.
// Pages here carry tokens in their URLs, so no URL of this origin is ever sent to another site.
app.use('*', async (c, next) => {
  await next();
  c.res.headers.set('referrer-policy', 'same-origin');
  const overrides = c.get('headerOverrides');
  if (!overrides) return;
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) c.res.headers.delete(name);
    else c.res.headers.set(name, value);
  }
});

useRuntime(app, { service: 'capture', parseEnv: parseCaptureEnv, securityTxt: true });

embedRoutes(app);
subscribeRoutes(app);
confirmRoutes(app);
memberRoutes(app);
privacyRoutes(app);
journeyRoutes(app);
askRoutes(app);

const log = createLogger({ service: 'capture' });

export async function remind(rawEnv: unknown, now?: number): Promise<number> {
  const env = parseCaptureEnv(rawEnv);
  const deps = audienceDeps(env);
  return sendGentleReminders(now === undefined ? deps : { ...deps, now: () => now });
}

/**
 * Every GET here only reads, so a 500 from a moment's D1 failure gets another try before a visitor
 * sees a broken form or Member Center. Writes are never run twice.
 */
export async function retryingFetch(request: Request, env: unknown, ctx: ExecutionContext) {
  for (let attempt = 1; ; attempt++) {
    const response = await app.fetch(request, env as Record<string, unknown>, ctx);
    if (request.method !== 'GET' || response.status !== 500 || attempt >= 3) return response;
    await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
  }
}

export default {
  fetch: retryingFetch,
  async scheduled(_controller: ScheduledController, rawEnv: unknown, ctx: ExecutionContext) {
    ctx.waitUntil(
      remind(rawEnv).then(
        (sent) => sent && log.info('gentle reminders sent', { sent }),
        (error: Error) => log.error('gentle reminders failed', { error: error.message }),
      ),
    );
  },
} satisfies ExportedHandler;
