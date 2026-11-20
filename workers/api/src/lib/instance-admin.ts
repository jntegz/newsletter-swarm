// Who may run this Swarm (docs/security.md "Instance admins"). Platform-wide authority needs at
// least what platform staff need: a factor of the operator's own (passkey, TOTP or recovery code)
// proved on this session, never an identity provider's MFA claim and no grace period, whatever
// seats the person holds. Changing an install-wide setting also needs that proof to be fresh,
// and every other instance admin is emailed about it. If the only instance admin loses their
// factor, the command line (`pnpm swarm`, run with the install's Cloudflare credentials) still
// changes these settings: that is the recovery path.
import { all, appendInstanceAudit } from '@swarm/db';
import { PRODUCT_NAME } from '@swarm/domain';
import { ApiError } from '@swarm/runtime';
import type { MiddlewareHandler } from 'hono';
import { requireAuth } from './access';
import { clientIp, env, type AppContext, type AppEnv, type AuthContext } from './context';
import { ipPrefix } from './crypto';
import { isInstanceAdmin } from './instance';
import { mailer, teamMail } from './mail';
import { factorCount, loadFactors, requireFreshFactor } from './mfa';
import { provedOwnFactor } from './session';

/** Requests whose instance change the guard allowed, for the notice after it succeeds. */
const changes = new WeakMap<Request, { auth: AuthContext }>();

export async function requireInstanceAdmin(
  c: AppContext,
  options: { change?: boolean } = {},
): Promise<AuthContext> {
  const auth = requireAuth(c);
  const e = env(c);
  if (!(await isInstanceAdmin(e, auth.operatorId))) {
    throw new ApiError('forbidden', 'Only the owner of this Swarm can change its settings.');
  }
  const factors = await loadFactors(e, auth.operatorId);
  if (!factorCount(factors)) {
    throw new ApiError(
      'forbidden',
      'Running this Swarm needs a passkey or an authenticator app on your account. Add one in Settings → Security first.',
      [{ path: 'secondFactor', message: 'factor_required' }],
    );
  }
  if (!provedOwnFactor(auth.mfaMethod)) {
    throw new ApiError('forbidden', 'Confirm it is you with your own second factor first.', [
      { path: 'secondFactor', message: 'step_up_required' },
    ]);
  }
  if (options.change) {
    requireFreshFactor(auth, factors);
    changes.set(c.req.raw, { auth });
  }
  return auth;
}

/** Field names whose values never go into the instance audit log. */
const SECRET_FIELD = /secret|password|token|key|credential/i;

/** What a change asked for, for the audit log: values of secret-looking fields are left out. */
function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' ? value.slice(0, 200) : value;
  }
  if (depth > 3) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      SECRET_FIELD.test(k) ? '[not recorded]' : redact(v, depth + 1),
    ]),
  );
}

/**
 * After an instance change succeeds: an entry in the install's hash-chained audit log
 * (instance_audit_events, 0113) and one email to every other instance admin, naming who changed
 * what, so a change made with a stolen session doesn't go unseen.
 */
export const noticeInstanceChange: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const change = changes.get(c.req.raw);
  if (!change || c.res.status >= 300) return;
  const e = env(c);
  let body: unknown = null;
  try {
    body = await c.req.json();
  } catch {
    // No JSON body.
  }
  await appendInstanceAudit(e.DB, {
    actorId: change.auth.operatorId,
    action: 'instance.setting_changed',
    metadata: { method: c.req.method, path: new URL(c.req.url).pathname, request: redact(body) },
    ipPrefix: ipPrefix(clientIp(c)),
  });
  const others = await all<{ email: string }>(
    e.DB,
    `SELECT o.email FROM instance_admins ia JOIN operators o ON o.id = ia.operator_id
      WHERE ia.operator_id <> ?1`,
    change.auth.operatorId,
  );
  const what = `${c.req.method} ${new URL(c.req.url).pathname}`;
  const subject = `An instance setting of your ${PRODUCT_NAME} was changed`;
  const url = new URL('/settings/instance', e.APP_ORIGIN).toString();
  const line = `${change.auth.email} changed an install-wide setting (${what}) on ${new Date().toISOString()}.`;
  for (const { email } of others) {
    try {
      await mailer(e).send({
        category: 'instance_setting_changed',
        from: { name: PRODUCT_NAME, address: e.MAIL_FROM },
        to: email,
        subject,
        text: `${line}\n\nIf you did not expect this, review Settings > Instance:\n${url}`,
        html: teamMail(subject, {
          heading: 'Instance setting changed',
          paragraphs: [line, 'If you did not expect this, review Settings > Instance.'],
          button: { url, label: 'Open Settings > Instance' },
          footnote: 'The button opens the dashboard. It changes nothing by itself.',
        }),
      });
    } catch (error) {
      c.get('log').warn('instance change mail failed', { error: (error as Error).message });
    }
  }
  c.get('log').info('instance setting changed', { by: change.auth.operatorId, what });
};
