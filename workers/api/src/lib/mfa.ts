// Second factors: TOTP (RFC 6238), recovery codes, attempt limits, step-up checks and the status
// the dashboard reads. Sessions and the pending rule are in session.ts; routes in routes/security.ts.
import { first, run, toIso } from '@swarm/db';
import {
  MFA_ATTEMPTS_PER_OPERATOR,
  MFA_ATTEMPTS_PER_SESSION,
  MFA_ATTEMPTS_SESSION_WINDOW_MINUTES,
  MFA_STEP_UP_MINUTES,
  RECOVERY_CODE_COUNT,
  newId,
  type SecondFactorStatus,
} from '@swarm/domain';
import { ApiError } from '@swarm/runtime';
import type { ApiEnv } from '../env';
import type { AuthContext } from './context';
import { sha256Hex } from './crypto';
import {
  MFA_GRACE_MS,
  provedOwnFactor,
  secondFactorState,
  sessionFacts,
  type SessionFacts,
} from './session';

// ---------------------------------------------------------------------------------------------
// TOTP: the codes themselves are in @swarm/engine (totp.ts), shared with the vault.

export { base32Decode, hotp, totpStep } from '@swarm/engine';

// ---------------------------------------------------------------------------------------------
// Recovery codes

// 32 symbols without 0/o and 1/l: 12 characters carry 60 bits.
const RECOVERY_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

const recoveryHash = (operatorId: string, code: string) => sha256Hex(`${operatorId}:${code}`);

function newRecoveryCode(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((b) => RECOVERY_ALPHABET[b & 31]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

/** Replaces the operator's recovery codes. Returns the new ones; they are never shown again. */
export async function issueRecoveryCodes(e: ApiEnv, operatorId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  const now = Date.now();
  const statements = [
    e.DB.prepare('DELETE FROM recovery_codes WHERE operator_id = ?1').bind(operatorId),
  ];
  for (const code of codes) {
    statements.push(
      e.DB.prepare(
        'INSERT INTO recovery_codes (id, operator_id, code_hash, created_at) VALUES (?1, ?2, ?3, ?4)',
      ).bind(
        newId('recoveryCode'),
        operatorId,
        await recoveryHash(operatorId, code.replaceAll('-', '')),
        now,
      ),
    );
  }
  await e.DB.batch(statements);
  return codes;
}

/** Spends one recovery code atomically. `code` is normalised (no dashes, lowercase). */
export async function spendRecoveryCode(
  e: ApiEnv,
  operatorId: string,
  code: string,
): Promise<boolean> {
  const row = await first(
    e.DB,
    `UPDATE recovery_codes SET used_at = ?1
      WHERE operator_id = ?2 AND code_hash = ?3 AND used_at IS NULL RETURNING id`,
    Date.now(),
    operatorId,
    await recoveryHash(operatorId, code),
  );
  return !!row;
}

// ---------------------------------------------------------------------------------------------
// Attempts

/**
 * Reserves one second-factor attempt before the factor is checked, or refuses once the session or
 * the operator has used its attempts. The count and the insert are one statement, so requests
 * sent at the same time can't all pass a count read before any of them was recorded. A failed
 * attempt keeps its row; releaseAttempt gives a successful one back.
 */
export async function reserveAttempt(
  e: ApiEnv,
  auth: AuthContext,
  method: 'passkey' | 'totp' | 'recovery',
): Promise<number> {
  const now = Date.now();
  const row = await first<{ id: number }>(
    e.DB,
    `INSERT INTO mfa_attempts (operator_id, session_id, method, created_at)
       SELECT ?1, ?2, ?3, ?4
        WHERE (SELECT COUNT(*) FROM mfa_attempts WHERE session_id = ?2 AND created_at > ?5) < ?6
          AND (SELECT COUNT(*) FROM mfa_attempts WHERE operator_id = ?1 AND created_at > ?7) < ?8
     RETURNING id`,
    auth.operatorId,
    auth.sessionId,
    method,
    now,
    now - MFA_ATTEMPTS_SESSION_WINDOW_MINUTES * 60_000,
    MFA_ATTEMPTS_PER_SESSION,
    now - 60 * 60_000,
    MFA_ATTEMPTS_PER_OPERATOR,
  );
  if (!row) {
    throw new ApiError('rate_limited', 'Too many attempts. Wait a few minutes and try again.');
  }
  await run(
    e.DB,
    'DELETE FROM mfa_attempts WHERE operator_id = ?1 AND created_at < ?2',
    auth.operatorId,
    now - 24 * 60 * 60_000,
  );
  return row.id;
}

/** Only failures count against the limits, so a verified attempt gives its row back. */
export async function releaseAttempt(e: ApiEnv, attemptId: number): Promise<void> {
  await run(e.DB, 'DELETE FROM mfa_attempts WHERE id = ?1', attemptId);
}

// ---------------------------------------------------------------------------------------------
// Status, step-up and policy

interface Factors {
  passkeys: number;
  totp: boolean;
  recoveryLeft: number;
}

export async function loadFactors(e: ApiEnv, operatorId: string): Promise<Factors> {
  const row = await first<{ passkeys: number; totp: number; recoveryLeft: number }>(
    e.DB,
    `SELECT (SELECT COUNT(*) FROM passkeys WHERE operator_id = ?1) AS passkeys,
            (SELECT COUNT(*) FROM totp_secrets WHERE operator_id = ?1 AND confirmed_at IS NOT NULL) AS totp,
            (SELECT COUNT(*) FROM recovery_codes WHERE operator_id = ?1 AND used_at IS NULL) AS recoveryLeft`,
    operatorId,
  );
  return {
    passkeys: row?.passkeys ?? 0,
    totp: (row?.totp ?? 0) > 0,
    recoveryLeft: row?.recoveryLeft ?? 0,
  };
}

export const factorCount = (f: Factors) => f.passkeys + (f.totp ? 1 : 0);

function statusFrom(facts: SessionFacts, factors: Factors, now = Date.now()) {
  const methods: SecondFactorStatus['methods'] = [];
  if (factors.passkeys) methods.push('passkey');
  if (factors.totp) methods.push('totp');
  if (factors.recoveryLeft && factorCount(factors)) methods.push('recovery');
  const inGrace = !!facts.required && facts.factors === 0 && facts.requiredSince !== null;
  return {
    state: secondFactorState(facts, now),
    methods,
    required: !!facts.required,
    enrollBy: inGrace ? toIso((facts.requiredSince as number) + MFA_GRACE_MS) : null,
    verifiedWith: facts.mfaMethod,
  } satisfies SecondFactorStatus;
}

/** The second-factor status of one session, read fresh (not from the session cache). */
export async function secondFactorStatus(
  e: ApiEnv,
  operatorId: string,
  sessionId: string,
): Promise<SecondFactorStatus> {
  const [facts, factors] = await Promise.all([
    sessionFacts(e, sessionId),
    loadFactors(e, operatorId),
  ]);
  if (!facts) throw new Error('session vanished');
  return statusFrom(facts, factors);
}

/**
 * Sensitive changes (adding a factor when one exists, removing one, new recovery codes) need a
 * factor of the operator's own proved on this session within MFA_STEP_UP_MINUTES. An identity
 * provider's MFA claim can let a session sign in, but never stands in for a factor the operator
 * holds when account control changes. The dashboard reads the `secondFactor` detail, asks for a
 * check and retries.
 */
export function requireStepUp(auth: AuthContext, factors: Factors, now = Date.now()): void {
  if (factorCount(factors) === 0) return;
  if (freshOwnFactor(auth, now)) return;
  throw stepUpRequired();
}

/**
 * For changes that set up standing access to a workspace's data (an export destination, a
 * webhook endpoint, an API key): a fresh check with a factor of the operator's own, and an
 * operator with no factor can't make them at all (docs/security.md "Standing feeds").
 */
export function requireFreshFactor(auth: AuthContext, factors: Factors, now = Date.now()): void {
  if (factorCount(factors) === 0) {
    throw new ApiError(
      'forbidden',
      'Add a passkey or an authenticator app to your account before setting this up.',
      [{ path: 'secondFactor', message: 'factor_required' }],
    );
  }
  if (!freshOwnFactor(auth, now)) throw stepUpRequired();
}

/** Signing out other sessions: an identity provider's claim alone can't do it for an operator
 *  who holds a factor of their own. */
export function requireOwnFactor(auth: AuthContext, factors: Factors): void {
  if (factorCount(factors) > 0 && !provedOwnFactor(auth.mfaMethod)) throw stepUpRequired();
}

const freshOwnFactor = (auth: AuthContext, now: number) =>
  provedOwnFactor(auth.mfaMethod) &&
  auth.mfaVerifiedAt !== null &&
  now - auth.mfaVerifiedAt <= MFA_STEP_UP_MINUTES * 60_000;

const stepUpRequired = () =>
  new ApiError('forbidden', 'Confirm it is you with your second factor first.', [
    { path: 'secondFactor', message: 'step_up_required' },
  ]);

/** True when any of the operator's seats requires a second factor (the strictest seat wins). */
async function secondFactorRequired(e: ApiEnv, operatorId: string): Promise<boolean> {
  const row = await first(
    e.DB,
    `SELECT 1 FROM seats st JOIN workspaces w ON w.id = st.workspace_id
      WHERE st.operator_id = ?1 AND (st.role IN ('owner', 'admin') OR w.require_2fa = 'all')
     UNION ALL SELECT 1 FROM instance_admins WHERE operator_id = ?1 LIMIT 1`,
    operatorId,
  );
  return !!row;
}

/** Refuses removing the last factor while one is required. */
export async function guardLastFactor(e: ApiEnv, operatorId: string, factors: Factors) {
  if (factorCount(factors) <= 1 && (await secondFactorRequired(e, operatorId))) {
    throw new ApiError(
      'conflict',
      'Your role needs a second factor. Add another one before removing this one.',
    );
  }
}

/** After the last factor goes, recovery codes go too: they only back up a factor. */
export async function dropRecoveryIfNoFactor(e: ApiEnv, operatorId: string): Promise<void> {
  if (factorCount(await loadFactors(e, operatorId)) === 0) {
    await run(e.DB, 'DELETE FROM recovery_codes WHERE operator_id = ?1', operatorId);
  }
}
