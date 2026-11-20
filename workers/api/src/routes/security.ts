// Account security: passkeys, TOTP, recovery codes, 2FA policy, sign out everywhere (Phase 7).
// The second-factor steps after a first factor live here too. Contract: docs/security.md.
import { createRoute } from '@hono/zod-openapi';
import { all, first, run, toIso } from '@swarm/db';
import {
  FIRST_FACTOR_UNDO_DAYS,
  FactorAddedSchema,
  FirstFactorUndoneSchema,
  MeSchema,
  PRODUCT_NAME,
  PasskeyAssertionSchema,
  PasskeySchema,
  RecoveryCodesSchema,
  RecoveryVerifySchema,
  RegisterPasskeySchema,
  RenamePasskeySchema,
  SecurityOverviewSchema,
  SignOutEverywhereResultSchema,
  SignOutEverywhereSchema,
  TotpEnrollmentSchema,
  TotpVerifySchema,
  UndoFirstFactorSchema,
  UpdateWorkspaceSecuritySchema,
  WEBAUTHN_CHALLENGE_TTL_SECONDS,
  WebAuthnOptionsSchema,
  WorkspaceSecuritySchema,
  idPattern,
  newId,
  type MfaMethod,
  type Passkey,
  type Require2fa,
} from '@swarm/domain';
import { ApiError } from '@swarm/runtime';
import { vaultValue } from '@swarm/vault';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { base64UrlDecode, base64UrlEncode } from '@swarm/tokens';
import type { ApiEnv } from '../env';
import { requireAuth, requireSignedIn, requireWorkspace } from '../lib/access';
import { appendAudit } from '../lib/audit';
import { clientIp, createRouter, env, type AppContext, type AuthContext } from '../lib/context';
import { ipPrefix, randomToken, sha256Hex } from '../lib/crypto';
import { accountActivity, recordAccountEvent } from '../lib/account-events';
import { mailer } from '../lib/mail';
import {
  dropRecoveryIfNoFactor,
  factorCount,
  guardLastFactor,
  issueRecoveryCodes,
  loadFactors,
  releaseAttempt,
  requireOwnFactor,
  requireStepUp,
  reserveAttempt,
  secondFactorStatus,
  spendRecoveryCode,
} from '../lib/mfa';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { accountChangeMail, recoveryCodeUsedMail, type AccountChange } from '../lib/security-mail';
import {
  clearSessionCookie,
  forgetCachedSessions,
  holdOtherSessions,
  markSecondFactor,
  revokeAllSessions,
  sessionToken,
} from '../lib/session';
import { loadMe } from '../lib/signin';
import { apiVault } from '../lib/vault';
import { NO_STORE } from '../v2/idempotency';

export const security = createRouter();

const passkeyParam = idParam('passkeyId', idPattern('passkey'));
const workspaceParam = idParam('workspaceId', idPattern('workspace'));

// ---------------------------------------------------------------------------------------------
// WebAuthn plumbing

function relyingParty(e: ApiEnv) {
  const origin = new URL(e.APP_ORIGIN);
  return { rpID: origin.hostname, origin: origin.origin, rpName: PRODUCT_NAME };
}

async function storeChallenge(
  e: ApiEnv,
  operatorId: string,
  purpose: 'register' | 'authenticate',
  challenge: string,
): Promise<void> {
  const now = Date.now();
  await e.DB.batch([
    // Expired and spent challenges are only kept until the operator asks for a new one.
    e.DB.prepare(
      'DELETE FROM webauthn_challenges WHERE operator_id = ?1 AND (expires_at <= ?2 OR consumed_at IS NOT NULL)',
    ).bind(operatorId, now),
    e.DB.prepare(
      `INSERT INTO webauthn_challenges (id, operator_id, purpose, challenge, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(
      newId('webauthnChallenge'),
      operatorId,
      purpose,
      challenge,
      now + WEBAUTHN_CHALLENGE_TTL_SECONDS * 1000,
    ),
  ]);
}

/** Spends a challenge exactly once: the library calls this with the challenge in clientDataJSON. */
function consumeChallenge(e: ApiEnv, operatorId: string, purpose: 'register' | 'authenticate') {
  return async (challenge: string) => {
    const now = Date.now();
    const row = await first(
      e.DB,
      `UPDATE webauthn_challenges SET consumed_at = ?1
        WHERE operator_id = ?2 AND purpose = ?3 AND challenge = ?4
          AND consumed_at IS NULL AND expires_at > ?1
       RETURNING id`,
      now,
      operatorId,
      purpose,
      challenge,
    );
    return !!row;
  };
}

interface PasskeyRow {
  id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports_json: string | null;
  name: string;
  backed_up: number;
  created_at: number;
  last_used_at: number | null;
}

const toPasskey = (row: PasskeyRow): Passkey => ({
  id: row.id,
  name: row.name,
  backedUp: row.backed_up === 1,
  createdAt: toIso(row.created_at),
  lastUsedAt: row.last_used_at === null ? null : toIso(row.last_used_at),
});

/** The credential as allow/exclude lists and the verifier take it. */
const credentialRef = (row: PasskeyRow): { id: string; transports?: string[] } =>
  row.transports_json
    ? { id: row.credential_id, transports: JSON.parse(row.transports_json) as string[] }
    : { id: row.credential_id };

const meResponse = async (c: AppContext, auth: AuthContext) =>
  c.json({ data: await loadMe(env(c), auth.operatorId, auth.sessionId) }, 200);

/** A wrong code or assertion (its reserved attempt stays counted), answered as a field error. */
function refuse(method: 'passkey' | 'totp' | 'recovery', message: string): never {
  throw new ApiError('invalid_input', message, [
    { path: method === 'passkey' ? 'response' : 'code', message },
  ]);
}

/** Tells the operator by mail that control of their account changed. A mail outage stops nothing. */
async function notifyAccountChange(
  c: AppContext,
  auth: Pick<AuthContext, 'email'>,
  kind: AccountChange,
  first = false,
  undoUrl?: string,
): Promise<void> {
  try {
    await mailer(env(c)).send(
      accountChangeMail(env(c), auth.email, {
        kind,
        at: Date.now(),
        first,
        ...(undoUrl ? { undoUrl } : {}),
      }),
    );
  } catch (error) {
    c.get('log').warn('account change mail failed', { kind, error: (error as Error).message });
  }
}

/**
 * The first factor's way back: a single-use "This wasn't me" link for the mail, valid
 * FIRST_FACTOR_UNDO_DAYS, stored as a hash. It covers every factor added from a minute before now.
 */
async function issueFirstFactorUndo(e: ApiEnv, operatorId: string): Promise<string> {
  const token = randomToken(32);
  const now = Date.now();
  await run(
    e.DB,
    `INSERT INTO factor_undo_tokens (token_hash, operator_id, window_start, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
    await sha256Hex(token),
    operatorId,
    now - 60_000,
    now,
    now + FIRST_FACTOR_UNDO_DAYS * 86_400_000,
  );
  // In the fragment, so the token stays out of server and proxy logs.
  return `${e.APP_ORIGIN}/sign-in/undo-factor#token=${token}`;
}

/**
 * After a factor is added. The first one also issues recovery codes (shown once), counts as this
 * session's second factor (the token rotates) and holds every other unverified session.
 */
async function factorAdded(
  c: AppContext,
  auth: AuthContext,
  method: Extract<MfaMethod, 'passkey' | 'totp'>,
  wasFirst: boolean,
): Promise<{ recoveryCodes: string[] | null }> {
  const e = env(c);
  await recordAccountEvent(
    c,
    auth.operatorId,
    method === 'passkey' ? 'operator.passkey_added' : 'operator.totp_enabled',
    { method },
  );
  await notifyAccountChange(
    c,
    auth,
    method === 'passkey' ? 'passkey_added' : 'totp_enabled',
    wasFirst,
    wasFirst ? await issueFirstFactorUndo(e, auth.operatorId) : undefined,
  );
  if (!wasFirst) return { recoveryCodes: null };
  const recoveryCodes = await issueRecoveryCodes(e, auth.operatorId);
  await markSecondFactor(c, auth, method);
  await holdOtherSessions(e, auth.operatorId, auth.sessionId);
  return { recoveryCodes };
}

// ---------------------------------------------------------------------------------------------
// The second-factor step after a first factor (also used to confirm a sensitive change)

security.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/auth/second-factor/passkey/options',
    tags: ['Auth'],
    summary: 'Start a passkey check',
    description:
      'Returns WebAuthn request options for the passkeys on this account. The challenge works once, for 5 minutes. Open to a session that still owes its second factor.',
    responses: {
      200: ok(WebAuthnOptionsSchema, 'Options for navigator.credentials.get'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const auth = requireSignedIn(c);
    const e = env(c);
    const rows = await all<PasskeyRow>(
      e.DB,
      'SELECT * FROM passkeys WHERE operator_id = ?1',
      auth.operatorId,
    );
    if (!rows.length) throw new ApiError('not_found', 'No passkey is set up on this account.');
    const options = await generateAuthenticationOptions({
      rpID: relyingParty(e).rpID,
      allowCredentials: rows.map(credentialRef),
      userVerification: 'preferred',
      timeout: WEBAUTHN_CHALLENGE_TTL_SECONDS * 1000,
    });
    await storeChallenge(e, auth.operatorId, 'authenticate', options.challenge);
    return c.json({ data: options as unknown as Record<string, unknown> }, 200);
  },
);

security.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/auth/second-factor/passkey',
    tags: ['Auth'],
    summary: 'Finish a passkey check',
    description:
      'Verifies the assertion (signature, challenge, origin, RP ID and signature counter). On success the session counts as verified and its cookie is replaced.',
    request: { body: jsonBody(PasskeyAssertionSchema) },
    responses: {
      200: ok(MeSchema, 'Verified'),
      ...errors('invalid_input', 'unauthorized', 'rate_limited'),
    },
  }),
  async (c) => {
    const auth = requireSignedIn(c);
    const e = env(c);
    const attempt = await reserveAttempt(e, auth, 'passkey');
    const response = c.req.valid('json').response as unknown as AuthenticationResponseJSON;
    const row =
      typeof response.id === 'string'
        ? await first<PasskeyRow>(
            e.DB,
            'SELECT * FROM passkeys WHERE credential_id = ?1 AND operator_id = ?2',
            response.id,
            auth.operatorId,
          )
        : null;
    if (!row) return refuse('passkey', 'That passkey is not registered on this account.');

    const rp = relyingParty(e);
    let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verified = await verifyAuthenticationResponse({
        response,
        expectedChallenge: consumeChallenge(e, auth.operatorId, 'authenticate'),
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        credential: {
          ...credentialRef(row),
          publicKey: new Uint8Array(base64UrlDecode(row.public_key)),
          counter: row.counter,
        },
        requireUserVerification: false,
      });
    } catch {
      return refuse('passkey', 'The passkey could not be verified. Try again.');
    }
    if (!verified.verified) {
      return refuse('passkey', 'The passkey could not be verified. Try again.');
    }

    // The counter must move forward (a cloned authenticator would repeat or go back); an
    // authenticator that keeps no counter reports 0 every time. Conditional, so racing
    // assertions can't both pass.
    const { newCounter, credentialBackedUp } = verified.authenticationInfo;
    const updated = await first(
      e.DB,
      `UPDATE passkeys SET counter = ?1, backed_up = ?2, last_used_at = ?3
        WHERE id = ?4 AND (counter < ?1 OR (counter = 0 AND ?1 = 0)) RETURNING id`,
      newCounter,
      credentialBackedUp ? 1 : 0,
      Date.now(),
      row.id,
    );
    if (!updated) {
      c.get('log').warn('passkey counter did not advance', { passkeyId: row.id });
      return refuse('passkey', 'The passkey could not be verified. Try again.');
    }
    await releaseAttempt(e, attempt);
    await markSecondFactor(c, auth, 'passkey');
    return meResponse(c, auth);
  },
);

/**
 * Accepts a TOTP code for the session's confirmed secret once (last_step only moves forward).
 * The vault opens the secret and checks the code; a vault that is down is a 503, not a refusal.
 */
async function acceptTotp(c: AppContext, code: string): Promise<boolean> {
  const token = sessionToken(c);
  if (!token) return false;
  const result = await apiVault(c).verifyTotp({ sessionToken: token, code });
  if (result.ok) return true;
  if (result.reason === 'unavailable' || result.reason === 'rate_limited') vaultValue(result);
  return false;
}

security.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/auth/second-factor/totp',
    tags: ['Auth'],
    summary: 'Verify with an authenticator app code',
    description:
      'Accepts a code from one time step either side of now, and never the same step twice. Failed attempts are limited per session and per operator.',
    request: { body: jsonBody(TotpVerifySchema) },
    responses: {
      200: ok(MeSchema, 'Verified'),
      ...errors('invalid_input', 'unauthorized', 'rate_limited'),
    },
  }),
  async (c) => {
    const auth = requireSignedIn(c);
    const e = env(c);
    const attempt = await reserveAttempt(e, auth, 'totp');
    if (!(await acceptTotp(c, c.req.valid('json').code))) {
      return refuse('totp', 'That code did not work. Wait for a new one and try again.');
    }
    await releaseAttempt(e, attempt);
    await markSecondFactor(c, auth, 'totp');
    return meResponse(c, auth);
  },
);

security.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/auth/second-factor/recovery',
    tags: ['Auth'],
    summary: 'Verify with a recovery code',
    description:
      'Each code works once. Using one is audited and emails the operator, with the number of codes left.',
    request: { body: jsonBody(RecoveryVerifySchema) },
    responses: {
      200: ok(MeSchema, 'Verified'),
      ...errors('invalid_input', 'unauthorized', 'rate_limited'),
    },
  }),
  async (c) => {
    const auth = requireSignedIn(c);
    const e = env(c);
    const attempt = await reserveAttempt(e, auth, 'recovery');
    if (!(await spendRecoveryCode(e, auth.operatorId, c.req.valid('json').code))) {
      return refuse('recovery', 'That recovery code did not work, or was already used.');
    }
    await releaseAttempt(e, attempt);
    await markSecondFactor(c, auth, 'recovery');
    const { recoveryLeft } = await loadFactors(e, auth.operatorId);
    await recordAccountEvent(c, auth.operatorId, 'operator.recovery_code_used', {
      method: 'recovery',
      metadata: { remaining: recoveryLeft },
    });
    try {
      await mailer(e).send(
        recoveryCodeUsedMail(e, auth.email, { remaining: recoveryLeft, at: Date.now() }),
      );
    } catch (error) {
      c.get('log').warn('recovery code mail failed', { error: (error as Error).message });
    }
    return meResponse(c, auth);
  },
);

security.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/auth/undo-first-factor',
    tags: ['Security'],
    summary: 'Undo a first second factor (“This wasn’t me”)',
    description:
      'Needs no session: the token from the link in the mail about an account’s first second factor, valid 7 days and usable once. Removes every passkey and authenticator app added since that factor (and the recovery codes once none is left), signs out every session, and requires the next sign-in to be an email link. Audited and emailed.',
    request: { body: jsonBody(UndoFirstFactorSchema) },
    responses: {
      200: ok(FirstFactorUndoneSchema, 'Undone'),
      ...errors('invalid_input', 'unauthorized'),
    },
  }),
  async (c) => {
    const e = env(c);
    const { token } = c.req.valid('json');
    const now = Date.now();
    const used = await first<{ operator_id: string; window_start: number }>(
      e.DB,
      `UPDATE factor_undo_tokens SET used_at = ?2
        WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2
       RETURNING operator_id, window_start`,
      await sha256Hex(token),
      now,
    );
    if (!used) {
      throw new ApiError('unauthorized', 'This link has expired or was already used.');
    }
    const operatorId = used.operator_id;
    const operator = await first<{ email: string }>(
      e.DB,
      'SELECT email FROM operators WHERE id = ?1',
      operatorId,
    );
    const removed = await e.DB.batch([
      e.DB.prepare('DELETE FROM passkeys WHERE operator_id = ?1 AND created_at >= ?2').bind(
        operatorId,
        used.window_start,
      ),
      e.DB.prepare(
        `DELETE FROM totp_secrets WHERE operator_id = ?1
          AND (confirmed_at IS NULL OR confirmed_at >= ?2 OR created_at >= ?2)`,
      ).bind(operatorId, used.window_start),
      // Any other link from the same window is spent too, and the next sign-in is by email.
      e.DB.prepare(
        'UPDATE factor_undo_tokens SET used_at = ?2 WHERE operator_id = ?1 AND used_at IS NULL',
      ).bind(operatorId, now),
      e.DB.prepare('UPDATE operators SET email_signin_required_at = ?2 WHERE id = ?1').bind(
        operatorId,
        now,
      ),
    ]);
    await dropRecoveryIfNoFactor(e, operatorId);
    const sessionsEnded = await revokeAllSessions(e, operatorId, null);
    clearSessionCookie(c);
    const result = {
      passkeysRemoved: removed[0]?.meta.changes ?? 0,
      authenticatorRemoved: (removed[1]?.meta.changes ?? 0) > 0,
      sessionsEnded,
    };
    await recordAccountEvent(c, operatorId, 'operator.first_factor_undone', { metadata: result });
    if (operator) await notifyAccountChange(c, operator, 'first_factor_undone');
    return c.json({ data: result }, 200);
  },
);

// ---------------------------------------------------------------------------------------------
// Settings → Security

security.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/security',
    tags: ['Security'],
    summary: 'Your second factors and recovery codes',
    description:
      'Open to a session that must set up a second factor before it can do anything else.',
    responses: { 200: ok(SecurityOverviewSchema, 'Security overview'), ...errors('unauthorized') },
  }),
  async (c) => {
    const auth = requireSignedIn(c, ['ok', 'enroll']);
    const e = env(c);
    const [passkeys, totp, codes, secondFactor, activity] = await Promise.all([
      all<PasskeyRow>(
        e.DB,
        'SELECT * FROM passkeys WHERE operator_id = ?1 ORDER BY created_at',
        auth.operatorId,
      ),
      first<{ confirmed_at: number | null }>(
        e.DB,
        'SELECT confirmed_at FROM totp_secrets WHERE operator_id = ?1',
        auth.operatorId,
      ),
      first<{ remaining: number; created_at: number | null }>(
        e.DB,
        `SELECT COUNT(*) FILTER (WHERE used_at IS NULL) AS remaining, MIN(created_at) AS created_at
           FROM recovery_codes WHERE operator_id = ?1`,
        auth.operatorId,
      ),
      secondFactorStatus(e, auth.operatorId, auth.sessionId),
      accountActivity(c, auth.operatorId),
    ]);
    return c.json(
      {
        data: {
          passkeys: passkeys.map(toPasskey),
          totp: {
            enabled: !!totp?.confirmed_at,
            confirmedAt: totp?.confirmed_at ? toIso(totp.confirmed_at) : null,
          },
          recoveryCodes: {
            remaining: codes?.remaining ?? 0,
            createdAt: codes?.created_at ? toIso(codes.created_at) : null,
          },
          secondFactor,
          activity,
        },
      },
      200,
    );
  },
);

security.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/security/passkeys/options',
    tags: ['Security'],
    summary: 'Start adding a passkey',
    description:
      'Returns WebAuthn creation options (attestation none). With a second factor already set up, this needs one proved on this session in the last 10 minutes.',
    responses: {
      200: ok(WebAuthnOptionsSchema, 'Options for navigator.credentials.create'),
      ...errors('unauthorized', 'forbidden'),
    },
  }),
  async (c) => {
    const auth = requireSignedIn(c, ['ok', 'enroll']);
    const e = env(c);
    requireStepUp(auth, await loadFactors(e, auth.operatorId));
    const existing = await all<PasskeyRow>(
      e.DB,
      'SELECT * FROM passkeys WHERE operator_id = ?1',
      auth.operatorId,
    );
    const rp = relyingParty(e);
    const options = await generateRegistrationOptions({
      rpName: rp.rpName,
      rpID: rp.rpID,
      userName: auth.email,
      userID: new Uint8Array(new TextEncoder().encode(auth.operatorId)),
      attestationType: 'none',
      excludeCredentials: existing.map(credentialRef),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      timeout: WEBAUTHN_CHALLENGE_TTL_SECONDS * 1000,
    });
    await storeChallenge(e, auth.operatorId, 'register', options.challenge);
    return c.json({ data: options as unknown as Record<string, unknown> }, 200);
  },
);

security.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/security/passkeys',
    tags: ['Security'],
    summary: 'Finish adding a passkey',
    description:
      'Verifies the attestation against the challenge, origin and RP ID. The first second factor on an account also returns recovery codes, once.',
    request: { body: jsonBody(RegisterPasskeySchema) },
    responses: {
      201: ok(FactorAddedSchema, 'Passkey added'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'conflict'),
    },
  }),
  async (c) => {
    const auth = requireSignedIn(c, ['ok', 'enroll']);
    const e = env(c);
    const factors = await loadFactors(e, auth.operatorId);
    requireStepUp(auth, factors);
    const { response, name } = c.req.valid('json');
    const rp = relyingParty(e);
    const fail = () => {
      throw new ApiError('invalid_input', 'The passkey could not be added. Try again.', [
        { path: 'response', message: 'The passkey could not be added. Try again.' },
      ]);
    };
    let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>> | null = null;
    try {
      verified = await verifyRegistrationResponse({
        response: response as unknown as RegistrationResponseJSON,
        expectedChallenge: consumeChallenge(e, auth.operatorId, 'register'),
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserVerification: false,
      });
    } catch {
      fail();
    }
    if (!verified?.verified) return fail();

    const { credential, credentialBackedUp } = verified.registrationInfo;
    const now = Date.now();
    try {
      await run(
        e.DB,
        `INSERT INTO passkeys (id, operator_id, credential_id, public_key, counter, transports_json,
                               name, backed_up, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        newId('passkey'),
        auth.operatorId,
        credential.id,
        base64UrlEncode(credential.publicKey),
        credential.counter,
        credential.transports?.length ? JSON.stringify(credential.transports) : null,
        name,
        credentialBackedUp ? 1 : 0,
        now,
      );
    } catch {
      throw new ApiError('conflict', 'This passkey is already registered.');
    }
    return c.json(
      { data: await factorAdded(c, auth, 'passkey', factorCount(factors) === 0) },
      201,
      NO_STORE,
    );
  },
);

security.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/security/passkeys/{passkeyId}',
    tags: ['Security'],
    summary: 'Rename a passkey',
    request: { params: passkeyParam, body: jsonBody(RenamePasskeySchema) },
    responses: {
      200: ok(PasskeySchema, 'Renamed'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const auth = requireAuth(c);
    const row = await first<PasskeyRow>(
      env(c).DB,
      'UPDATE passkeys SET name = ?1 WHERE id = ?2 AND operator_id = ?3 RETURNING *',
      c.req.valid('json').name,
      c.req.valid('param').passkeyId,
      auth.operatorId,
    );
    if (!row) throw new ApiError('not_found', 'Passkey not found.');
    return c.json({ data: toPasskey(row) }, 200);
  },
);

security.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/security/passkeys/{passkeyId}',
    tags: ['Security'],
    summary: 'Remove a passkey',
    description:
      'Needs a second factor proved in the last 10 minutes. Refused when it is the last factor and your role requires one.',
    request: { params: passkeyParam },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found', 'conflict') },
  }),
  async (c) => {
    const auth = requireAuth(c);
    const e = env(c);
    const { passkeyId } = c.req.valid('param');
    const row = await first<{ id: string }>(
      e.DB,
      'SELECT id FROM passkeys WHERE id = ?1 AND operator_id = ?2',
      passkeyId,
      auth.operatorId,
    );
    if (!row) throw new ApiError('not_found', 'Passkey not found.');
    const factors = await loadFactors(e, auth.operatorId);
    requireStepUp(auth, factors);
    await guardLastFactor(e, auth.operatorId, factors);
    await run(e.DB, 'DELETE FROM passkeys WHERE id = ?1', passkeyId);
    await dropRecoveryIfNoFactor(e, auth.operatorId);
    await recordAccountEvent(c, auth.operatorId, 'operator.passkey_removed', { method: 'passkey' });
    await forgetCachedSessions(e, auth.operatorId);
    await notifyAccountChange(c, auth, 'passkey_removed');
    return c.body(null, 204);
  },
);

/** The session as the vault's principal (TOTP enrolment is the session's own operator's). */
function sessionPrincipal(c: AppContext) {
  const token = sessionToken(c);
  if (!token) throw new ApiError('unauthorized', 'Sign in first.');
  return { kind: 'operator-session' as const, sessionToken: token };
}

security.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/security/totp',
    tags: ['Security'],
    summary: 'Start setting up an authenticator app',
    description:
      'Creates a new secret (made and sealed by the vault) and returns it with an otpauth:// URI. Nothing is enabled until a code is confirmed. Starting again replaces an unconfirmed secret.',
    responses: {
      200: ok(TotpEnrollmentSchema, 'Secret to scan or type'),
      ...errors('unauthorized', 'forbidden', 'conflict'),
    },
  }),
  async (c) => {
    const auth = requireSignedIn(c, ['ok', 'enroll']);
    const e = env(c);
    const factors = await loadFactors(e, auth.operatorId);
    if (factors.totp) {
      throw new ApiError('conflict', 'An authenticator app is already set up. Remove it first.');
    }
    requireStepUp(auth, factors);
    // The vault makes the secret and stores it sealed; it is shown here once.
    const enrolment = await apiVault(c).beginTotp(sessionPrincipal(c));
    if (!enrolment.ok && enrolment.reason === 'refused') {
      throw new ApiError('conflict', 'An authenticator app is already set up. Remove it first.');
    }
    const { secretOnce: secret, otpauthUri: uri } = vaultValue(enrolment);
    return c.json({ data: { secret, uri } }, 200, NO_STORE);
  },
);

security.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/security/totp/confirm',
    tags: ['Security'],
    summary: 'Finish setting up an authenticator app',
    description:
      'Turns the app on once a current code matches. The first second factor on an account also returns recovery codes, once.',
    request: { body: jsonBody(TotpVerifySchema) },
    responses: {
      200: ok(FactorAddedSchema, 'Authenticator app on'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const auth = requireSignedIn(c, ['ok', 'enroll']);
    const e = env(c);
    const factors = await loadFactors(e, auth.operatorId);
    requireStepUp(auth, factors);
    // The vault checks the code against the unconfirmed secret and turns it on.
    const result = await apiVault(c).confirmTotp(sessionPrincipal(c), {
      code: c.req.valid('json').code,
    });
    if (!result.ok && result.reason === 'not_found') {
      throw new ApiError('not_found', 'Start setting up the authenticator app first.');
    }
    if (!result.ok && result.reason !== 'refused') vaultValue(result);
    if (!result.ok) {
      throw new ApiError(
        'invalid_input',
        'That code did not match. Check the time on your phone.',
        [{ path: 'code', message: 'That code did not match. Check the time on your phone.' }],
      );
    }
    return c.json(
      { data: await factorAdded(c, auth, 'totp', factorCount(factors) === 0) },
      200,
      NO_STORE,
    );
  },
);

security.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/security/totp',
    tags: ['Security'],
    summary: 'Turn off the authenticator app',
    description:
      'Needs a second factor proved in the last 10 minutes. Refused when it is the last factor and your role requires one.',
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found', 'conflict') },
  }),
  async (c) => {
    const auth = requireAuth(c);
    const e = env(c);
    const factors = await loadFactors(e, auth.operatorId);
    if (!factors.totp) {
      // An unconfirmed secret is just discarded.
      await run(e.DB, 'DELETE FROM totp_secrets WHERE operator_id = ?1', auth.operatorId);
      throw new ApiError('not_found', 'No authenticator app is set up.');
    }
    requireStepUp(auth, factors);
    await guardLastFactor(e, auth.operatorId, factors);
    await run(e.DB, 'DELETE FROM totp_secrets WHERE operator_id = ?1', auth.operatorId);
    await dropRecoveryIfNoFactor(e, auth.operatorId);
    await recordAccountEvent(c, auth.operatorId, 'operator.totp_disabled', { method: 'totp' });
    await forgetCachedSessions(e, auth.operatorId);
    await notifyAccountChange(c, auth, 'totp_disabled');
    return c.body(null, 204);
  },
);

security.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/security/recovery-codes',
    tags: ['Security'],
    summary: 'Create new recovery codes',
    description:
      'Replaces every recovery code (the old ones stop working) and returns the new ones, once. Needs a second factor proved in the last 10 minutes.',
    responses: {
      200: ok(RecoveryCodesSchema, 'New recovery codes'),
      ...errors('unauthorized', 'forbidden', 'conflict'),
    },
  }),
  async (c) => {
    const auth = requireAuth(c);
    const e = env(c);
    const factors = await loadFactors(e, auth.operatorId);
    if (factorCount(factors) === 0) {
      throw new ApiError('conflict', 'Set up a passkey or an authenticator app first.');
    }
    requireStepUp(auth, factors);
    const recoveryCodes = await issueRecoveryCodes(e, auth.operatorId);
    await recordAccountEvent(c, auth.operatorId, 'operator.recovery_codes_regenerated');
    await notifyAccountChange(c, auth, 'recovery_codes_regenerated');
    return c.json({ data: { recoveryCodes } }, 200, NO_STORE);
  },
);

// ---------------------------------------------------------------------------------------------
// Sessions

security.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/auth/sessions/sign-out-everywhere',
    tags: ['Auth'],
    summary: 'Sign out everywhere',
    description:
      'Revokes every session of this account, including their cached copies, so they stop working at once. keepCurrent (default true) keeps this device signed in. A session whose only second factor is an identity provider’s MFA claim must first prove a factor of the operator’s own (403 `secondFactor: step_up_required`). Emails the operator.',
    request: { body: jsonBody(SignOutEverywhereSchema) },
    responses: {
      200: ok(SignOutEverywhereResultSchema, 'Sessions revoked'),
      ...errors('unauthorized', 'forbidden'),
    },
  }),
  async (c) => {
    const auth = requireAuth(c);
    const e = env(c);
    // An identity provider's MFA claim can't sign the operator's own devices out.
    requireOwnFactor(auth, await loadFactors(e, auth.operatorId));
    const { keepCurrent } = c.req.valid('json');
    const revoked = await revokeAllSessions(
      e,
      auth.operatorId,
      keepCurrent ? auth.sessionId : null,
    );
    if (!keepCurrent) clearSessionCookie(c);
    await recordAccountEvent(c, auth.operatorId, 'operator.signed_out_everywhere', {
      metadata: { revoked },
    });
    if (revoked > 0) await notifyAccountChange(c, auth, 'signed_out_everywhere');
    return c.json({ data: { revoked } }, 200);
  },
);

// ---------------------------------------------------------------------------------------------
// Workspace policy

async function workspaceSecurity(e: ApiEnv, workspaceId: string, withCount: boolean) {
  const row = await first<{ require_2fa: Require2fa; missing: number | null }>(
    e.DB,
    `SELECT w.require_2fa,
            CASE WHEN ?2 THEN (
              SELECT COUNT(*) FROM seats st
               WHERE st.workspace_id = w.id
                 AND (w.require_2fa = 'all' OR st.role IN ('owner', 'admin'))
                 AND NOT EXISTS (SELECT 1 FROM passkeys p WHERE p.operator_id = st.operator_id)
                 AND NOT EXISTS (SELECT 1 FROM totp_secrets t
                                  WHERE t.operator_id = st.operator_id AND t.confirmed_at IS NOT NULL)
            ) END AS missing
       FROM workspaces w WHERE w.id = ?1`,
    workspaceId,
    withCount ? 1 : 0,
  );
  if (!row) throw new ApiError('not_found', 'Workspace not found.');
  return { require2fa: row.require_2fa, seatsWithoutSecondFactor: row.missing };
}

security.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/security',
    tags: ['Security'],
    summary: 'The workspace second-factor policy',
    description: 'Admins and owners also see how many seats still need to set up a second factor.',
    request: { params: workspaceParam },
    responses: {
      200: ok(WorkspaceSecuritySchema, 'Policy'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId, role } = await requireWorkspace(
      c,
      c.req.valid('param').workspaceId,
      'viewer',
    );
    const admin = role === 'owner' || role === 'admin';
    return c.json({ data: await workspaceSecurity(env(c), workspaceId, admin) }, 200);
  },
);

security.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/workspaces/{workspaceId}/security',
    tags: ['Security'],
    summary: 'Change who must use a second factor',
    description:
      "Owners only, audited. 'admins': owners and admins (always). 'all': every seat. Newly covered teammates get the grace period to set one up.",
    request: { params: workspaceParam, body: jsonBody(UpdateWorkspaceSecuritySchema) },
    responses: {
      200: ok(WorkspaceSecuritySchema, 'Policy changed'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId, auth } = await requireWorkspace(
      c,
      c.req.valid('param').workspaceId,
      'owner',
    );
    const e = env(c);
    const { require2fa } = c.req.valid('json');
    const before = await first<{ require_2fa: Require2fa }>(
      e.DB,
      'SELECT require_2fa FROM workspaces WHERE id = ?1',
      workspaceId,
    );
    await run(
      e.DB,
      'UPDATE workspaces SET require_2fa = ?1, updated_at = ?2 WHERE id = ?3',
      require2fa,
      Date.now(),
      workspaceId,
    );
    await appendAudit(e.DB, {
      workspaceId,
      actorId: auth.operatorId,
      action: 'workspace.require_2fa_changed',
      targetType: 'workspace',
      targetId: workspaceId,
      metadata: { from: before?.require_2fa ?? null, to: require2fa },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.json({ data: await workspaceSecurity(e, workspaceId, true) }, 200);
  },
);
