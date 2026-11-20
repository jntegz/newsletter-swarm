// Account security events: sign-ins, factor changes, recovery codes, signing out everywhere.
// The full record (network prefix and browser included) is the operator's own, in
// account_events (0110), shown under Settings > Security > Account activity. Every workspace the
// operator has a seat in gets a reduced copy in its hash-chained audit log: the action, the method
// and the time, with no network prefix, browser or other detail. A workspace admin learns that
// someone who can reach their data signed in or changed a factor, and nothing about where from.
import { all, run, toIso } from '@swarm/db';
import { newId, type AccountEvent } from '@swarm/domain';
import { appendAudit } from './audit';
import { clientIp, env, type AppContext } from './context';
import { ipPrefix } from './crypto';

/** How many of their own events the Security page lists. */
const ACCOUNT_ACTIVITY_LIMIT = 30;

type AccountEventMethod = 'quickpass' | 'google' | 'sso' | 'passkey' | 'totp' | 'recovery';

export async function recordAccountEvent(
  c: AppContext,
  operatorId: string,
  action: string,
  details: { method?: AccountEventMethod | null; metadata?: Record<string, unknown> } = {},
): Promise<void> {
  const e = env(c);
  const method = details.method ?? null;
  await run(
    e.DB,
    `INSERT INTO account_events (id, operator_id, action, method, ip_prefix, user_agent, metadata_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    newId('accountEvent'),
    operatorId,
    action,
    method,
    ipPrefix(clientIp(c)),
    c.req.header('user-agent')?.slice(0, 300) ?? null,
    JSON.stringify(details.metadata ?? {}),
    Date.now(),
  );
  const seats = await all<{ workspace_id: string }>(
    e.DB,
    'SELECT workspace_id FROM seats WHERE operator_id = ?1',
    operatorId,
  );
  for (const seat of seats) {
    await appendAudit(e.DB, {
      workspaceId: seat.workspace_id,
      actorId: operatorId,
      action,
      targetType: 'operator',
      targetId: operatorId,
      metadata: method ? { method } : {},
      ipPrefix: null,
    });
  }
}

interface AccountEventRow {
  action: string;
  method: string | null;
  ip_prefix: string | null;
  user_agent: string | null;
  created_at: number;
}

/** The operator's own most recent account events, newest first. */
export async function accountActivity(c: AppContext, operatorId: string): Promise<AccountEvent[]> {
  const rows = await all<AccountEventRow>(
    env(c).DB,
    `SELECT action, method, ip_prefix, user_agent, created_at FROM account_events
      WHERE operator_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ${ACCOUNT_ACTIVITY_LIMIT}`,
    operatorId,
  );
  return rows.map((row) => ({
    action: row.action,
    method: row.method,
    ipPrefix: row.ip_prefix,
    userAgent: row.user_agent,
    at: toIso(row.created_at),
  }));
}
