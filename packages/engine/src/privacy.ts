/**
 * The Privacy Center (Phase 7): data-subject requests (export and erasure) and the erased-address
 * check. Tables: dsr_requests and suppressions.email_hash (0012), the run columns (0016).
 *
 * CONTRACT
 * - A request is about one address across the whole workspace: every Member with that address,
 *   in every Channel, is exported or erased, and so is every row that holds the address without
 *   a Member: a request needs no Member. The address is sealed on the request (email_enc, under
 *   its own derived key: sealDsrAddress) while it is open, and cleared when it completes, or once
 *   the person was told of a rejection (sendRequestOutcomeNotices); email_hash, a marker keyed
 *   with FIELD_KEYS and the workspace (addressMarker), stays. FIELD_KEYS is the vault's alone:
 *   callers pass the vault's operations (vault-ports.ts PrivacyVault) where this takes `keys`.
 * - Statuses: `pending` waits for an admin (operator and API requests, and Member Center
 *   erasures that nothing proved: source `member_center_unverified`); `processing` is queued for
 *   the jobs worker (Member Center exports start here, Member Center erasures once confirmed from
 *   the inbox, approved ones move here); then `completed`, `rejected` or, after DSR_MAX_ATTEMPTS
 *   runs, `failed` (an admin can retry).
 * - A Member Center erasure is two steps: the settings page (its link is in every email footer,
 *   so a forwarded email opens it) only mails a single-use confirmation link
 *   (dsr_confirmations, DSR_CONFIRM_LINK_HOURS); the POST from that link files the request. An
 *   address Swarm can't mail can't confirm that way: its erasure always waits for an admin.
 * - An export for an address Swarm can't mail (bounced, complained) is built but not emailed;
 *   an admin downloads it from the Privacy Center.
 * - `eraseAddress` is the only erasure. It hard-deletes the Members (foreign keys cascade to
 *   their fields, tags, Circles, recipients, events, runs, answers, sessions, subscriptions…),
 *   anonymises what aggregate stats read (deliveries keep their counts and timestamps with the
 *   address replaced and the Member reference nulled; opens and clicks lose their network
 *   prefix; funnel rows credited to the Member as a Champion are folded into the "none" cut), scrubs
 *   the address and ids from the rows that hold them as text (gifts, checkouts, import reports,
 *   bulk selections, cursors, webhook deliveries, idempotent replays), and keeps the suppression
 *   as a keyed marker: the row's email becomes `erased+<suppression id>@invalid`. Every request
 *   about the address loses its note, error and sealed address (ERASED_REQUEST_NOTE).
 * - `member.deleted` is appended to platform_events per erased Member with ids only. The audit
 *   log keeps Member ids it already holds (the chain can't be rewritten) and never an address.
 * - `isErasedAddress` / `erasedAddresses` are the one check every path that adds a Member or an
 *   address must make: subscribe, import, operator create, checkout and Gift Pass claims (and
 *   /v2 when it adds Members).
 * - R2: a Member's own data exports are deleted on erasure; operator bulk exports (deleted
 *   EXPORT_TTL_HOURS, 72, after they finish) and import files (deleted 7 days after an import ends) are not
 *   rewritten. See docs/architecture.md "Privacy Center".
 */
import {
  DSR_CONFIRM_LINK_HOURS,
  DSR_CONFIRM_RESEND_MINUTES,
  DSR_CONFIRM_TOKEN_PURPOSE,
  DSR_DUE_HOURS,
  DSR_EXPORT_LINK_DAYS,
  DSR_EXPORT_TOKEN_PURPOSE,
  DSR_MAX_ATTEMPTS,
  ERASED_EMAIL_DOMAIN,
  type DsrKind,
  type DsrSource,
  type DsrStatus,
  type FieldValue,
} from '@swarm/domain';
import { appendAudit, sha256Hex } from '@swarm/db';
import { base64UrlEncode, type Keyring } from '@swarm/tokens';
import type { EngineConfig } from './config';
import type { AudienceDeps } from './confirm';
import { composeMessage, memberMail } from './messages';
import { all, first, newIdFor, run, toIso } from './db';
import { decryptFor, encryptFor, fromStored, macFor, sealedKeyId } from './fields';
import { isPrivacyVault, VaultPortMissing, type PrivacyKeys } from './vault-ports';
import { redactAddresses } from './app-directory';
import { channelAdminEmails, sendOperatorNotice } from './flows-notify';
import type { LinkSigner, LinkVerifier } from './links';
import { toFieldDef, type FieldRow } from './members';
import { platformEventStatement } from './platform-events';
import { resolveSender } from './start';
import { webhookErasureStatements } from './webhooks';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** How long one run may hold a request before another run may take it over. */
const LEASE_MS = 10 * 60_000;
/** What an anonymised delivery, gift or import sample says instead of the address. */
export const ERASED_TEXT = 'erased';
/**
 * On an erasure whose address hard-bounced: where it may still be held in clear, and why it
 * stays there (owner decision, docs/gdpr.md "What Swarm does not do for you").
 */
export const PROVIDER_LIST_NOTE =
  'The address hard-bounced, so if this install sends with Amazon SES it may stay on the account-level suppression list, in clear. It is kept there on purpose: being suppressed is what stops this address being mailed again. Swarm does not remove it.';
/**
 * Payment-provider references an erasure keeps, with why (docs/gdpr.md; legal obligation to keep
 * accounting records): the rows stay for the publisher's books without the person, and these ids
 * let a refund, dispute or reconciliation find the payment at the provider. They go too once the
 * workspace's paymentRecordYears have passed since the payment (lifetimes.ts
 * expirePaymentReferences). Everything else is removed at once.
 */
export const RETAINED_PROVIDER_REFERENCES = {
  'payments.stripe_object_id': 'Matching a payment to Stripe for refunds, disputes and accounts.',
  'checkout_sessions.stripe_session_id': 'Matching a finished checkout to its Stripe session.',
} as const;
/** The only note a request about an erased address keeps. */
export const ERASED_REQUEST_NOTE = 'The address was erased.';
/**
 * Rows of history per kind in a data export; older rows are left out and the export names the
 * kinds that were cut (`truncated`). Read in pages, so a long history costs several small reads.
 */
export const EXPORT_ROW_LIMIT = 25_000;
const EXPORT_PAGE_ROWS = 5000;

// ---- Addresses ------------------------------------------------------------------------------

const normal = (email: string) => email.trim().toLowerCase();

/**
 * sha256 of the lowercased address, hex. The unkeyed digest: markers written before 0107 are this,
 * and it is the inner step of `addressMarker`. Never stored or returned on its own any more.
 */
export const emailHash = (email: string) => sha256Hex(normal(email));

/** The salted form of an erasure or departure marker, written from 0107, and still without FIELD_KEYS. */
const MARKER_PREFIX = 'k1:';
/**
 * The install-keyed form (`k2`): `k2.<key id>:<hex>`, an HMAC under a key derived from FIELD_KEYS
 * for MARKER_PURPOSE alone, over the workspace id and the salted form. The salt is in the
 * database; the key is not, so someone holding only the database can't test an address.
 */
const MARKER_KEYED_PREFIX = 'k2.';
const MARKER_PURPOSE = 'erasure-marker';

/**
 * The workspace's marker salt (0107): random, per workspace, never returned by the API. A
 * workspace made after the migration gets one the first time it is needed.
 */
export async function markerSalt(db: D1Database, workspaceId: string): Promise<string> {
  const row = await first<{ marker_salt: string | null }>(
    db,
    'SELECT marker_salt FROM workspaces WHERE id = ?1',
    workspaceId,
  );
  if (row?.marker_salt) return row.marker_salt;
  const made = await first<{ marker_salt: string }>(
    db,
    `UPDATE workspaces SET marker_salt = coalesce(marker_salt, lower(hex(randomblob(32))))
      WHERE id = ?1 RETURNING marker_salt`,
    workspaceId,
  );
  // An unknown workspace has nothing to match; a fixed value keeps the lookup harmless.
  return made?.marker_salt ?? 'unknown-workspace';
}

/** The salted marker for a stored unkeyed digest (or a fresh one): what 0107 rewrites rows to. */
export const keyedMarker = async (salt: string, digest: string) =>
  `${MARKER_PREFIX}${await sha256Hex(`${salt}:${digest}`)}`;

/** The install-keyed marker of a salted one under FIELD_KEYS key `kid`, or null without it. */
async function installMarker(
  keys: Keyring,
  kid: string,
  workspaceId: string,
  salted: string,
): Promise<string | null> {
  const mac = await macFor(keys, MARKER_PURPOSE, kid, `${workspaceId}\n${salted}`);
  return mac === null ? null : `${MARKER_KEYED_PREFIX}${kid}:${mac}`;
}

export interface AddressMarkers {
  /** The form to write: install-keyed under the current key, or salted without FIELD_KEYS. */
  keyed: string;
  /** The unkeyed digest (before 0107). */
  legacy: string;
  /** Every form a stored marker of this address can take here, for lookups. */
  forms: string[];
}

async function markerForms(
  keys: Keyring | undefined,
  workspaceId: string,
  legacy: string,
  salted: string,
): Promise<AddressMarkers> {
  const forms = [legacy, salted];
  let keyed = salted;
  if (keys) {
    // Every key of the keyring: a marker written before a key rotation still matches.
    for (const kid of Object.keys(keys.keys)) {
      const marker = await installMarker(keys, kid, workspaceId, salted);
      if (!marker) continue;
      forms.push(marker);
      if (kid === keys.current) keyed = marker;
    }
  }
  return { keyed, legacy, forms };
}

/**
 * Every form an address's marker can take in this workspace: install-keyed (`k2`) under each
 * key of FIELD_KEYS, salted (0107) and the unkeyed digest. Lookups accept any, so no re-entry
 * check misses while upgradeAddressMarkers rewrites old rows; `keyed` is the form to write.
 * Without FIELD_KEYS (`keys` undefined) only the salted form is written and matched.
 */
export async function addressMarkers(
  db: D1Database,
  workspaceId: string,
  email: string,
  keys: PrivacyKeys,
  salt?: string,
): Promise<AddressMarkers> {
  if (isPrivacyVault(keys)) return keys.addressMarkers(workspaceId, normal(email));
  const legacy = await emailHash(email);
  const salted = await keyedMarker(salt ?? (await markerSalt(db, workspaceId)), legacy);
  return markerForms(keys, workspaceId, legacy, salted);
}

/** The marker an erased address keeps in this workspace. */
export const addressMarker = async (
  db: D1Database,
  workspaceId: string,
  email: string,
  keys: PrivacyKeys,
) => (await addressMarkers(db, workspaceId, email, keys)).keyed;

/**
 * What the API shows of a stored marker: the first 12 hex digits of its keyed form, enough to
 * tell requests apart, too short and too workspace-bound to test a guessed address with. A
 * marker's label changes once when it is upgraded to the install-keyed form.
 */
export async function markerLabel(
  db: D1Database,
  workspaceId: string,
  stored: string,
  salt?: string,
): Promise<string> {
  if (stored.startsWith(MARKER_KEYED_PREFIX)) {
    const hex = stored.slice(stored.indexOf(':') + 1);
    return hex.slice(0, 12);
  }
  const keyed = stored.startsWith(MARKER_PREFIX)
    ? stored
    : await keyedMarker(salt ?? (await markerSalt(db, workspaceId)), stored);
  return keyed.slice(MARKER_PREFIX.length, MARKER_PREFIX.length + 12);
}

/** The address an erased suppression row carries, so UNIQUE (workspace_id, email) still holds. */
export const erasedAddress = (suppressionId: string) =>
  `erased+${suppressionId}@${ERASED_EMAIL_DOMAIN}`;

/** Rewrites matched suppression markers of an older form to the current one, in place. */
async function upgradeSuppressionMarkers(
  db: D1Database,
  workspaceId: string,
  pairs: [stored: string, keyed: string][],
) {
  const stale = pairs.filter(([stored, keyed]) => stored !== keyed);
  if (!stale.length) return;
  await db.batch(
    stale.map(([stored, keyed]) =>
      db
        .prepare(
          'UPDATE suppressions SET email_hash = ?1 WHERE workspace_id = ?2 AND email_hash = ?3',
        )
        .bind(keyed, workspaceId, stored),
    ),
  );
}

/**
 * True when this address was erased in the workspace; it must never be added again. A marker
 * found in an older form is rewritten to the install-keyed one on the way (with `keys`).
 */
export async function isErasedAddress(
  db: D1Database,
  workspaceId: string,
  email: string,
  keys: PrivacyKeys,
): Promise<boolean> {
  const { keyed, forms } = await addressMarkers(db, workspaceId, email, keys);
  const row = await first<{ email_hash: string }>(
    db,
    `SELECT email_hash FROM suppressions
      WHERE workspace_id = ?1 AND email_hash IN (SELECT value FROM json_each(?2)) LIMIT 1`,
    workspaceId,
    JSON.stringify(forms),
  );
  if (!row) return false;
  if (keys) await upgradeSuppressionMarkers(db, workspaceId, [[row.email_hash, keyed]]);
  return true;
}

const channelWorkspace = async (db: D1Database, channelId: string) =>
  (
    await first<{ workspace_id: string }>(
      db,
      'SELECT workspace_id FROM channels WHERE id = ?1',
      channelId,
    )
  )?.workspace_id ?? '';

/**
 * Statements that remember the unsubscribed ones among Members about to be deleted, as keyed
 * markers. Run them in the same batch as the delete.
 */
export async function rememberLeftStatements(
  db: D1Database,
  channelId: string,
  memberIds: string[],
  now: number,
  keys: PrivacyKeys,
): Promise<D1PreparedStatement[]> {
  const rows = await all<{ email: string }>(
    db,
    `SELECT email FROM members WHERE channel_id = ?1 AND status = 'unsubscribed'
        AND id IN (SELECT value FROM json_each(?2))`,
    channelId,
    JSON.stringify(memberIds),
  );
  if (!rows.length) return [];
  const workspaceId = await channelWorkspace(db, channelId);
  const { keyedOf } = await markerMap(
    db,
    workspaceId,
    keys,
    rows.map((r) => r.email),
  );
  const hashes = [...keyedOf.values()];
  return [
    db
      .prepare(
        `INSERT INTO left_addresses (channel_id, email_hash, left_at)
         SELECT ?1, value, ?2 FROM json_each(?3) WHERE true
         ON CONFLICT (channel_id, email_hash) DO UPDATE SET left_at = excluded.left_at`,
      )
      .bind(channelId, now, JSON.stringify(hashes)),
  ];
}

/** Each address's marker forms, for a batch lookup: marker → address, and address → keyed. */
async function markerMap(
  db: D1Database,
  workspaceId: string,
  keys: PrivacyKeys,
  emails: string[],
): Promise<{ byHash: Map<string, string>; keyedOf: Map<string, string> }> {
  const byHash = new Map<string, string>();
  const keyedOf = new Map<string, string>();
  const unique = [...new Set(emails.map(normal))];
  const add = (email: string, markers: AddressMarkers) => {
    for (const form of markers.forms) byHash.set(form, email);
    keyedOf.set(email, markers.keyed);
  };
  if (isPrivacyVault(keys) && keys.addressMarkersMany) {
    // One vault call per batch, not one per address.
    for (let i = 0; i < unique.length; i += MARKERS_PER_CALL) {
      const part = unique.slice(i, i + MARKERS_PER_CALL);
      const found = await keys.addressMarkersMany(workspaceId, part);
      for (const email of part) {
        const markers = found[email];
        if (!markers) throw new Error('The vault answered without an address marker.');
        add(email, markers);
      }
    }
    return { byHash, keyedOf };
  }
  const salt = isPrivacyVault(keys) ? undefined : await markerSalt(db, workspaceId);
  for (const email of unique) add(email, await addressMarkers(db, workspaceId, email, keys, salt));
  return { byHash, keyedOf };
}

/** Addresses per vault marker call (@swarm/vault addressMarkersBulk). */
const MARKERS_PER_CALL = 500;

/**
 * The ones among `emails` who unsubscribed here and were then deleted: they come back as pending,
 * however they are added, and only their own confirmation makes them active.
 */
export async function leftAddresses(
  db: D1Database,
  channelId: string,
  emails: string[],
  keys: PrivacyKeys,
): Promise<Set<string>> {
  if (!emails.length) return new Set();
  const { byHash, keyedOf } = await markerMap(
    db,
    await channelWorkspace(db, channelId),
    keys,
    emails,
  );
  const rows = await all<{ email_hash: string }>(
    db,
    `SELECT email_hash FROM left_addresses WHERE channel_id = ?1
        AND email_hash IN (SELECT value FROM json_each(?2))`,
    channelId,
    JSON.stringify([...byHash.keys()]),
  );
  const found = new Set(rows.map((r) => byHash.get(r.email_hash) as string));
  // Older forms move to the current one (a keyed row already there wins).
  const stale = keys
    ? rows.filter((r) => r.email_hash !== keyedOf.get(byHash.get(r.email_hash) as string))
    : [];
  if (stale.length) {
    await db.batch(
      stale.flatMap((r) => [
        db
          .prepare(
            'UPDATE OR IGNORE left_addresses SET email_hash = ?1 WHERE channel_id = ?2 AND email_hash = ?3',
          )
          .bind(keyedOf.get(byHash.get(r.email_hash) as string), channelId, r.email_hash),
        db
          .prepare('DELETE FROM left_addresses WHERE channel_id = ?1 AND email_hash = ?2')
          .bind(channelId, r.email_hash),
      ]),
    );
  }
  return found;
}

/** The erased ones among `emails` (lowercased), for imports and other batches. */
export async function erasedAddresses(
  db: D1Database,
  workspaceId: string,
  emails: string[],
  keys: PrivacyKeys,
): Promise<Set<string>> {
  if (!emails.length) return new Set();
  const { byHash, keyedOf } = await markerMap(db, workspaceId, keys, emails);
  const rows = await all<{ email_hash: string }>(
    db,
    `SELECT email_hash FROM suppressions WHERE workspace_id = ?1
        AND email_hash IN (SELECT value FROM json_each(?2))`,
    workspaceId,
    JSON.stringify([...byHash.keys()]),
  );
  if (keys) {
    await upgradeSuppressionMarkers(
      db,
      workspaceId,
      rows.map((r) => [r.email_hash, keyedOf.get(byHash.get(r.email_hash) as string) as string]),
    );
  }
  return new Set(rows.map((r) => byHash.get(r.email_hash) as string));
}

/** Markers rewritten per table and run. */
const MARKER_BATCH = 200;

/**
 * Rewrites markers of older forms, from the stored value alone: unkeyed digests (before 0107)
 * and salted markers (`k1`) become install-keyed under the current FIELD_KEYS key, or
 * salted when there is no FIELD_KEYS. Bounded per run; returns how many rows changed. Safe to
 * run any time: lookups accept every form meanwhile. An install-keyed marker under an older
 * key can't be rewritten (the salted form is gone); it keeps matching while that key stays in
 * FIELD_KEYS, and moves to the current key when the address is next looked up.
 */
export async function upgradeAddressMarkers(
  db: D1Database,
  keys: Keyring | undefined,
): Promise<number> {
  let changed = 0;
  const salts = new Map<string, string>();
  const saltOf = async (workspaceId: string) => {
    let salt = salts.get(workspaceId);
    if (!salt) {
      salt = await markerSalt(db, workspaceId);
      salts.set(workspaceId, salt);
    }
    return salt;
  };
  // The form a stored value becomes, without the address.
  const target = async (workspaceId: string, stored: string) => {
    const salted = stored.startsWith(MARKER_PREFIX)
      ? stored
      : await keyedMarker(await saltOf(workspaceId), stored);
    if (!keys) return salted;
    return (await installMarker(keys, keys.current, workspaceId, salted)) ?? salted;
  };
  // Rows not yet in the form this install writes.
  const pending = keys
    ? `email_hash NOT LIKE '${MARKER_KEYED_PREFIX}%'`
    : `email_hash NOT LIKE '${MARKER_PREFIX}%' AND email_hash NOT LIKE '${MARKER_KEYED_PREFIX}%'`;
  for (const table of ['suppressions', 'dsr_requests'] as const) {
    const rows = await all<{ id: string; workspace_id: string; email_hash: string }>(
      db,
      `SELECT id, workspace_id, email_hash FROM ${table}
        WHERE email_hash IS NOT NULL AND ${pending} LIMIT ${MARKER_BATCH}`,
    );
    const updates = [];
    for (const row of rows) {
      updates.push(
        db
          .prepare(`UPDATE ${table} SET email_hash = ?1 WHERE id = ?2 AND email_hash = ?3`)
          .bind(await target(row.workspace_id, row.email_hash), row.id, row.email_hash),
      );
    }
    if (updates.length) await db.batch(updates);
    changed += rows.length;
  }
  const left = await all<{ channel_id: string; workspace_id: string; email_hash: string }>(
    db,
    `SELECT l.channel_id, c.workspace_id, l.email_hash FROM left_addresses l
       JOIN channels c ON c.id = l.channel_id
      WHERE l.${pending} LIMIT ${MARKER_BATCH}`,
  );
  const updates = [];
  for (const row of left) {
    const keyed = await target(row.workspace_id, row.email_hash);
    // The keyed row may exist already (the person left again since): keep that one.
    updates.push(
      db
        .prepare(
          'UPDATE OR IGNORE left_addresses SET email_hash = ?1 WHERE channel_id = ?2 AND email_hash = ?3',
        )
        .bind(keyed, row.channel_id, row.email_hash),
      db
        .prepare('DELETE FROM left_addresses WHERE channel_id = ?1 AND email_hash = ?2')
        .bind(row.channel_id, row.email_hash),
    );
  }
  if (updates.length) await db.batch(updates);
  return changed + left.length;
}

// ---- Requests -------------------------------------------------------------------------------

/**
 * A request's address is sealed under its own derived key (fields.ts encryptFor), so the key that
 * opens profile fields or service secrets does not open it, nor the other way round. Requests
 * sealed before keep opening.
 */
const DSR_SEAL_PURPOSE = 'dsr-address';
export const sealDsrAddress = (keys: Keyring, email: string) =>
  encryptFor(keys, DSR_SEAL_PURPOSE, email);
export const openDsrAddress = (keys: Keyring, sealed: string) =>
  decryptFor(keys, DSR_SEAL_PURPOSE, sealed);

export const dsrDueAt = (kind: DsrKind, now: number) => now + DSR_DUE_HOURS[kind] * HOUR_MS;

/** Statuses of a request that is still open: a second one of the same kind is refused. */
export const OPEN_DSR_STATUSES: DsrStatus[] = ['pending', 'processing'];

export interface NewDsrRequest {
  workspaceId: string;
  channelId: string | null;
  memberId: string | null;
  email: string;
  kind: DsrKind;
  source: DsrSource;
  status: 'pending' | 'processing';
  note?: string | null;
  handledBy?: string | null;
  /** The id to insert under, when the address was sealed for it already (sealedEmail). */
  id?: string;
  /** The address sealed for this request by the vault. */
  sealedEmail?: string;
}

/** Seals a request's address for its row: locally with FIELD_KEYS, or through the vault. */
async function sealRequestAddress(
  keys: PrivacyKeys,
  workspaceId: string,
  requestId: string,
  email: string,
): Promise<string> {
  if (isPrivacyVault(keys)) {
    if (!keys.sealRequestAddress) throw new VaultPortMissing('sealRequestAddress');
    return keys.sealRequestAddress(workspaceId, requestId, normal(email));
  }
  if (!keys) throw new Error('FIELD_KEYS is required to seal a request address');
  return sealDsrAddress(keys, normal(email));
}

/** Opens a request's address: locally with FIELD_KEYS, or through the vault. Null: unreadable. */
async function openRequestAddress(
  keys: PrivacyKeys,
  row: { id: string; email_enc: string | null },
): Promise<string | null> {
  if (!row.email_enc) return null;
  if (isPrivacyVault(keys)) {
    if (!keys.openRequestAddress) throw new VaultPortMissing('openRequestAddress');
    return keys.openRequestAddress(row.id);
  }
  return keys ? openDsrAddress(keys, row.email_enc) : null;
}

/** The open request of this kind for this address, if there is one. */
export async function openDsrRequest(
  db: D1Database,
  workspaceId: string,
  email: string,
  kind: DsrKind,
  keys: PrivacyKeys,
): Promise<string | null> {
  const { forms } = await addressMarkers(db, workspaceId, email, keys);
  const row = await first<{ id: string }>(
    db,
    `SELECT id FROM dsr_requests WHERE workspace_id = ?1
        AND email_hash IN (SELECT value FROM json_each(?2)) AND kind = ?3
        AND status IN ('pending', 'processing') LIMIT 1`,
    workspaceId,
    JSON.stringify(forms),
    kind,
  );
  return row?.id ?? null;
}

export async function createDsrRequest(
  db: D1Database,
  fieldKeys: PrivacyKeys,
  input: NewDsrRequest,
  now: number = Date.now(),
): Promise<string> {
  const id = input.id ?? newIdFor('dsrRequest', now);
  await run(
    db,
    `INSERT INTO dsr_requests (id, workspace_id, channel_id, member_id, email_hash, email_enc, kind,
       source, status, due_at, note, handled_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)`,
    id,
    input.workspaceId,
    input.channelId,
    input.memberId,
    await addressMarker(db, input.workspaceId, input.email, fieldKeys),
    input.sealedEmail ?? (await sealRequestAddress(fieldKeys, input.workspaceId, id, input.email)),
    input.kind,
    input.source,
    input.status,
    dsrDueAt(input.kind, now),
    input.note ?? null,
    input.handledBy ?? null,
    now,
  );
  return id;
}

/**
 * A live Stripe subscription that would keep charging after the Member is gone. Erasure waits
 * until it is canceled (or set to end), because nothing could cancel it afterwards.
 */
export async function hasLivePaidSubscription(
  db: D1Database,
  workspaceId: string,
  email: string,
): Promise<boolean> {
  return !!(await first(
    db,
    `SELECT 1 FROM member_subscriptions s
       JOIN members m ON m.id = s.member_id
       JOIN channels c ON c.id = m.channel_id
      WHERE c.workspace_id = ?1 AND m.email = ?2 AND s.source = 'stripe'
        AND s.status IN ('trialing', 'active', 'past_due', 'unpaid', 'paused')
        AND s.cancel_at_period_end = 0 AND s.revoked_at IS NULL
      LIMIT 1`,
    workspaceId,
    normal(email),
  ));
}

export type MemberCenterRequestOutcome = 'created' | 'open' | 'paid' | 'unavailable';

/**
 * A request from the Member Center, for the token's Member. One open request per kind.
 *
 * An export goes straight to `processing`: the file's link is mailed to the address, so only the
 * inbox gets it. An erasure is filed here only once the subscriber confirmed it from their inbox
 * (`confirmErasure`), or, for an address Swarm can't mail, by `startEraseConfirmation`. With
 * `review`, a link that doesn't prove who holds it, it waits as `pending` for an admin to approve.
 * A verified request that finds a `pending` one filed from a forwarded link runs that one, so it
 * can't hold the person's own request back. One an admin or the API filed and left pending stays
 * for the admin. `status` is the request's status afterwards. The operator queue shows every one.
 */
export async function requestFromMemberCenter(
  db: D1Database,
  fieldKeys: PrivacyKeys,
  memberId: string,
  kind: DsrKind,
  now: number = Date.now(),
  review = false,
): Promise<{
  outcome: MemberCenterRequestOutcome;
  requestId: string | null;
  status: 'pending' | 'processing' | null;
}> {
  const member = await first<{ email: string; channel_id: string; workspace_id: string }>(
    db,
    `SELECT m.email, m.channel_id, c.workspace_id FROM members m JOIN channels c ON c.id = m.channel_id
      WHERE m.id = ?1 AND c.deleted_at IS NULL`,
    memberId,
  );
  if (!member) return { outcome: 'unavailable', requestId: null, status: null };
  const { forms } = await addressMarkers(db, member.workspace_id, member.email, fieldKeys);
  const openOne = () =>
    first<{ id: string; status: 'pending' | 'processing'; source: DsrSource }>(
      db,
      `SELECT id, status, source FROM dsr_requests
        WHERE workspace_id = ?1 AND email_hash IN (SELECT value FROM json_each(?2)) AND kind = ?3
          AND status IN ('pending', 'processing') ORDER BY status = 'processing' DESC LIMIT 1`,
      member.workspace_id,
      JSON.stringify(forms),
      kind,
    );
  let open = await openOne();
  if (open && (review || open.status === 'processing')) {
    return { outcome: 'open', requestId: open.id, status: open.status };
  }
  if (kind === 'erase' && (await hasLivePaidSubscription(db, member.workspace_id, member.email))) {
    return { outcome: 'paid', requestId: null, status: null };
  }
  // Only the forwarded-link case is the person's own request; one an admin or the API filed and
  // left pending is the admin's to approve.
  if (open && open.source !== 'member_center_unverified') {
    return { outcome: 'open', requestId: open.id, status: open.status };
  }
  if (open) {
    const promoted = await first(
      db,
      `UPDATE dsr_requests SET status = 'processing', member_id = ?1, attempts = 0, error = NULL,
          source = 'member_center', updated_at = ?2
        WHERE id = ?3 AND status = 'pending' AND source = 'member_center_unverified' RETURNING id`,
      memberId,
      now,
      open.id,
    );
    if (promoted) {
      await appendAudit(db, {
        workspaceId: member.workspace_id,
        actorId: null,
        action: 'privacy.request_verified',
        targetType: 'dsr_request',
        targetId: open.id,
        metadata: { kind, verifiedBy: 'member' },
      });
      return { outcome: 'open', requestId: open.id, status: 'processing' };
    }
    // An admin approved or rejected it meanwhile: what is open now answers, or a new one is filed.
    open = await openOne();
    if (open) return { outcome: 'open', requestId: open.id, status: open.status };
  }
  const requestId = await createDsrRequest(
    db,
    fieldKeys,
    {
      workspaceId: member.workspace_id,
      channelId: member.channel_id,
      memberId,
      email: member.email,
      kind,
      // An admin approving it must know the link proved nothing about who holds it.
      source: review ? 'member_center_unverified' : 'member_center',
      status: review ? 'pending' : 'processing',
      ...(review
        ? {
            note: 'Asked for from subscriber settings. Swarm could not email the address to confirm it.',
          }
        : {}),
    },
    now,
  );
  return { outcome: 'created', requestId, status: review ? 'pending' : 'processing' };
}

// ---- Erasure confirmed from the inbox ---------------------------------------------------------

/**
 * Whether email to the address can arrive: false when it is suppressed workspace-wide for a hard
 * bounce or a complaint, or every Member of it bounced or complained. Soft bounces and manual
 * suppressions don't stop a message the person asked for.
 */
export async function canMailAddress(
  db: D1Database,
  workspaceId: string,
  email: string,
): Promise<boolean> {
  const row = await first<{ suppressed: number; reachable: number }>(
    db,
    `SELECT EXISTS (SELECT 1 FROM suppressions WHERE workspace_id = ?1 AND email = ?2
                     AND channel_id IS NULL AND reason IN ('hard_bounce', 'complaint')) AS suppressed,
            EXISTS (SELECT 1 FROM members m JOIN channels c ON c.id = m.channel_id
                     WHERE c.workspace_id = ?1 AND m.email = ?2
                       AND m.status NOT IN ('bounced', 'complained')) AS reachable`,
    workspaceId,
    normal(email),
  );
  return !!row && !row.suppressed && !!row.reachable;
}

export type EraseConfirmationOutcome =
  /** The confirmation email is on its way (or one was sent a moment ago). */
  | 'sent'
  /** The address can't be mailed, so the request waits for an admin instead. */
  | 'review'
  /** An erasure is already queued or waiting. */
  | 'open'
  /** A paid subscription still renews; nothing was sent. */
  | 'paid'
  | 'unavailable';

const CONFIRMATION_ID = /^[1-9][0-9]{0,15}$/;

/** A confirmation row id nobody can predict: 52 random bits, in [2^52, 2^53). */
function randomConfirmationId(): number {
  const [high = 0, low = 0] = crypto.getRandomValues(new Uint32Array(2));
  return 2 ** 52 + (high % 2 ** 20) * 2 ** 32 + low;
}

/**
 * A confirmation's nonce: 128 random bits that only the emailed link carries. The row keeps its
 * sha256, so neither a signing key nor a read of the database is enough to confirm it.
 */
export const newConfirmationNonce = (): string =>
  base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));

const NONCE = /^[A-Za-z0-9_-]{22}$/;

/** The nonce claim of a verified link: absent only in links from before nonces (null). */
function nonceOf(n: unknown): string | null | undefined {
  if (n === undefined) return null;
  return typeof n === 'string' && NONCE.test(n) ? n : undefined;
}

export function eraseConfirmationToken(
  links: LinkSigner,
  link: { confirmationId: number; memberId: string; nonce: string },
  now?: number,
) {
  return links.sign(
    DSR_CONFIRM_TOKEN_PURPOSE,
    { c: String(link.confirmationId), m: link.memberId, n: link.nonce },
    { expiresInSeconds: DSR_CONFIRM_LINK_HOURS * 3600, ...(now === undefined ? {} : { now }) },
  );
}

export interface EraseConfirmationLink {
  confirmationId: number;
  memberId: string;
  /** Null in a link from before nonces: it confirms only a row made before them. */
  nonce: string | null;
}

/** The confirmation id, Member id and nonce from a confirmation link, or null. */
export async function readEraseConfirmationToken(
  links: LinkVerifier,
  token: string,
  now?: number,
): Promise<EraseConfirmationLink | null> {
  if (token.length > 512) return null;
  const result = await links.verify<{ c?: unknown; m?: unknown; n?: unknown }>(
    DSR_CONFIRM_TOKEN_PURPOSE,
    token,
    now ? { now } : {},
  );
  if (!result.ok) return null;
  const { c, m } = result.payload;
  const nonce = nonceOf(result.payload.n);
  return typeof c === 'string' &&
    CONFIRMATION_ID.test(c) &&
    typeof m === 'string' &&
    /^mb_[0-9a-f]{32}$/.test(m) &&
    nonce !== undefined
    ? { confirmationId: Number(c), memberId: m, nonce }
    : null;
}

/** The hash a link's nonce must match: null for a link without one, which matches no new row. */
const nonceHash = async (nonce: string | null) => (nonce === null ? null : sha256Hex(nonce));

/** True while the link can still be used: not used, not expired, its Member still there. */
export async function eraseConfirmationOpen(
  db: D1Database,
  link: EraseConfirmationLink,
  now: number = Date.now(),
): Promise<boolean> {
  // A row made before nonces has none, and only such a row takes a link without one.
  return !!(await first(
    db,
    `SELECT 1 FROM dsr_confirmations WHERE id = ?1 AND member_id = ?2 AND kind = 'erase'
        AND used_at IS NULL AND expires_at > ?3 AND coalesce(nonce_hash, '') = coalesce(?4, '')`,
    link.confirmationId,
    link.memberId,
    now,
    await nonceHash(link.nonce),
  ));
}

/**
 * Step one of an erasure from subscriber settings: emails the address a link that confirms it.
 * Nothing is queued yet. Refused while a paid subscription renews. A second request within
 * DSR_CONFIRM_RESEND_MINUTES sends nothing more. An address Swarm can't mail can't confirm: its
 * erasure always waits for an admin (`review`). Nothing a link carries proves who holds it, so a
 * link emailed a moment ago counts for no more than a forwarded one: whoever holds the member
 * signing key could forge either. `open` means it is already running.
 */
export async function startEraseConfirmation(
  deps: AudienceDeps & { fieldKeys: PrivacyKeys },
  memberId: string,
  now: number = Date.now(),
): Promise<EraseConfirmationOutcome> {
  const { db } = deps;
  const member = await first<{ email: string; channel_id: string; workspace_id: string }>(
    db,
    `SELECT m.email, m.channel_id, c.workspace_id FROM members m JOIN channels c ON c.id = m.channel_id
      WHERE m.id = ?1 AND c.deleted_at IS NULL`,
    memberId,
  );
  if (!member) return 'unavailable';
  if (!(await canMailAddress(db, member.workspace_id, member.email))) {
    const filed = await requestFromMemberCenter(db, deps.fieldKeys, memberId, 'erase', now, true);
    if (filed.outcome === 'paid' || filed.outcome === 'unavailable') return filed.outcome;
    return filed.status === 'processing' ? 'open' : 'review';
  }
  // One filed from a forwarded link doesn't stop the person: confirming from the inbox runs it.
  const markers = await addressMarkers(db, member.workspace_id, member.email, deps.fieldKeys);
  const open = await first<{ status: 'pending' | 'processing'; source: DsrSource }>(
    db,
    `SELECT status, source FROM dsr_requests
      WHERE workspace_id = ?1 AND email_hash IN (SELECT value FROM json_each(?2)) AND kind = 'erase'
        AND status IN ('pending', 'processing') ORDER BY status = 'processing' DESC LIMIT 1`,
    member.workspace_id,
    JSON.stringify(markers.forms),
  );
  if (open?.status === 'processing') return 'open';
  if (open && open.source !== 'member_center_unverified') return 'review';
  if (await hasLivePaidSubscription(db, member.workspace_id, member.email)) return 'paid';
  const recent = await first(
    db,
    `SELECT 1 FROM dsr_confirmations WHERE member_id = ?1 AND kind = 'erase' AND used_at IS NULL
        AND created_at > ?2`,
    memberId,
    now - DSR_CONFIRM_RESEND_MINUTES * 60_000,
  );
  if (recent) return 'sent';
  // The row's id is random, not the next number, and the link carries a nonce the row keeps only
  // hashed: only the inbox learns them. Holding the signing key is then not enough to confirm
  // someone else's erasure (a forged settings link starts one), nor is a read of this table.
  const nonce = newConfirmationNonce();
  const row = await first<{ id: number }>(
    db,
    `INSERT INTO dsr_confirmations (id, member_id, kind, created_at, expires_at, nonce_hash)
     VALUES (?4, ?1, 'erase', ?2, ?3, ?5) RETURNING id`,
    memberId,
    now,
    now + DSR_CONFIRM_LINK_HOURS * HOUR_MS,
    randomConfirmationId(),
    await sha256Hex(nonce),
  );
  if (!row) return 'unavailable';
  const token = await eraseConfirmationToken(
    deps.links,
    { confirmationId: row.id, memberId, nonce },
    now,
  );
  const url = `${deps.captureOrigin}/m/erase/${token}`;
  const { name, accent, from, replyTo } = await privacySender(
    deps,
    member.workspace_id,
    member.channel_id,
  );
  const body = memberMail({
    channelName: name,
    accent,
    heading: 'Confirm that you want your data deleted',
    paragraphs: [
      `Someone asked ${name} to delete everything held about this address. If that was you, use the button to confirm. Nothing is deleted until you do.`,
      `Deleting covers ${name} and any other newsletter run by the same publisher, and it can’t be undone.`,
      `The link works once, for ${DSR_CONFIRM_LINK_HOURS} hours.`,
    ],
    button: { label: 'Confirm and delete my data', url },
    footnote:
      'If you did not ask for this, ignore this email. Your data stays as it is, and nobody can confirm without this email.',
  });
  await deps.mail.send({
    category: 'privacy_confirm',
    from,
    to: member.email,
    replyTo: replyTo ?? from.address,
    subject: `Confirm that you want your data deleted from ${name}`,
    html: body.html,
    text: body.text,
    tags: { workspace: member.workspace_id },
  });
  return 'sent';
}

export type ConfirmErasureOutcome = 'queued' | 'open' | 'review' | 'paid' | 'expired';

/**
 * Step two, the POST from the emailed link: uses the link (once) and queues the erasure for the
 * jobs worker. A renewing paid subscription refuses it without using the link up.
 */
export async function confirmErasure(
  db: D1Database,
  fieldKeys: PrivacyKeys,
  link: EraseConfirmationLink,
  now: number = Date.now(),
): Promise<ConfirmErasureOutcome> {
  if (!(await eraseConfirmationOpen(db, link, now))) return 'expired';
  const member = await first<{ email: string; workspace_id: string }>(
    db,
    `SELECT m.email, c.workspace_id FROM members m JOIN channels c ON c.id = m.channel_id
      WHERE m.id = ?1 AND c.deleted_at IS NULL`,
    link.memberId,
  );
  if (!member) return 'expired';
  if (await hasLivePaidSubscription(db, member.workspace_id, member.email)) return 'paid';
  const used = await first(
    db,
    `UPDATE dsr_confirmations SET used_at = ?1
      WHERE id = ?2 AND member_id = ?3 AND used_at IS NULL AND expires_at > ?1
        AND coalesce(nonce_hash, '') = coalesce(?4, '') RETURNING id`,
    now,
    link.confirmationId,
    link.memberId,
    await nonceHash(link.nonce),
  );
  if (!used) return 'expired';
  const result = await requestFromMemberCenter(db, fieldKeys, link.memberId, 'erase', now);
  if (result.outcome === 'paid') return 'paid';
  if (result.outcome === 'unavailable') return 'expired';
  // One an admin or the API filed and left pending is still theirs to approve.
  if (result.status === 'pending') return 'review';
  return result.outcome === 'open' ? 'open' : 'queued';
}

// ---- Requests from people who are not subscribers ------------------------------------------

/**
 * The link a request from the public page waits for: purpose 'dsr-address-confirm', payload
 * `{ c: address_confirmations.id, w: workspaceId, n: nonce }`, DSR_CONFIRM_LINK_HOURS, signed with
 * CAPTURE_KEYS (MEMBER_KEYS before the cutover) and mailed to the address. The row keeps the
 * nonce's sha256 only, as an erasure confirmation does.
 */
const ADDRESS_CONFIRM_PURPOSE = 'dsr-address-confirm';

export interface AddressRequestDeps extends AudienceDeps {
  fieldKeys: PrivacyKeys;
}

/**
 * Step one of a request from the publication's public page, by someone who need not be a
 * subscriber: a buyer, a gift purchaser or recipient, a sponsor contact, someone whose subscriber
 * row was deleted. Nothing is looked up that the answer could reveal: the caller answers the same
 * whatever happens here. The address is mailed a single-use link, unless the workspace may not
 * mail it (it bounced, complained or was erased), or a link for the same request went out within
 * DSR_CONFIRM_RESEND_MINUTES. Returns whether an email was sent, for tests and logs only.
 */
export async function startAddressRequest(
  deps: AddressRequestDeps,
  input: { channelId: string; email: string; kind: DsrKind },
  now: number = Date.now(),
): Promise<boolean> {
  const { db } = deps;
  const email = normal(input.email);
  const channel = await first<{ workspace_id: string }>(
    db,
    'SELECT workspace_id FROM channels WHERE id = ?1 AND deleted_at IS NULL',
    input.channelId,
  );
  if (!channel) return false;
  const workspaceId = channel.workspace_id;
  const { keyed, forms } = await addressMarkers(db, workspaceId, email, deps.fieldKeys);
  const blocked = await first(
    db,
    `SELECT 1 FROM suppressions WHERE workspace_id = ?1
        AND ((email = ?2 AND channel_id IS NULL AND reason IN ('hard_bounce', 'complaint'))
             OR email_hash IN (SELECT value FROM json_each(?3)))`,
    workspaceId,
    email,
    JSON.stringify(forms),
  );
  if (blocked) return false;
  const recent = await first(
    db,
    `SELECT 1 FROM address_confirmations WHERE workspace_id = ?1 AND email_hash = ?2 AND kind = ?3
        AND used_at IS NULL AND created_at > ?4`,
    workspaceId,
    keyed,
    input.kind,
    now - DSR_CONFIRM_RESEND_MINUTES * 60_000,
  );
  if (recent) return false;
  const nonce = newConfirmationNonce();
  const sealed = await sealConfirmationAddress(deps.fieldKeys, input.channelId, email);
  // Bound to the marker it was sealed with: the row keeps that one.
  const emailHash = sealed.emailHash ?? keyed;
  const row = await first<{ id: number }>(
    db,
    `INSERT INTO address_confirmations (id, workspace_id, channel_id, kind, email_enc, email_hash,
       created_at, expires_at, nonce_hash)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) RETURNING id`,
    randomConfirmationId(),
    workspaceId,
    input.channelId,
    input.kind,
    sealed.sealed,
    emailHash,
    now,
    now + DSR_CONFIRM_LINK_HOURS * HOUR_MS,
    await sha256Hex(nonce),
  );
  if (!row) return false;
  const token = await deps.links.sign(
    ADDRESS_CONFIRM_PURPOSE,
    { c: String(row.id), w: workspaceId, n: nonce },
    { expiresInSeconds: DSR_CONFIRM_LINK_HOURS * 3600, now },
  );
  const url = `${deps.captureOrigin}/privacy/confirm/${token}`;
  const { name, accent, from, replyTo } = await privacySender(deps, workspaceId, input.channelId);
  const what = input.kind === 'export' ? 'a copy of the data' : 'the deletion of the data';
  const body = memberMail({
    channelName: name,
    accent,
    heading:
      input.kind === 'export'
        ? 'Confirm your request for your data'
        : 'Confirm that you want your data deleted',
    paragraphs: [
      `Someone asked ${name} for ${what} it holds about this address. If that was you, use the button to confirm. Nothing happens until you do.`,
      input.kind === 'export'
        ? 'You will then get an email with a link to download a copy, also if nothing is held about this address.'
        : `Deleting covers ${name} and any other newsletter run by the same publisher, and it can’t be undone.`,
      `The link works once, for ${DSR_CONFIRM_LINK_HOURS} hours.`,
    ],
    button: {
      label: input.kind === 'export' ? 'Confirm my request' : 'Confirm and delete my data',
      url,
    },
    footnote:
      'If you did not ask for this, ignore this email. Nothing changes, and nobody can confirm without this email.',
  });
  await deps.mail.send({
    category: 'privacy_confirm',
    from,
    to: email,
    replyTo: replyTo ?? from.address,
    subject:
      input.kind === 'export'
        ? `Confirm your request for your data from ${name}`
        : `Confirm that you want your data deleted from ${name}`,
    html: body.html,
    text: body.text,
    tags: { workspace: workspaceId },
  });
  return true;
}

/** Seals a typed address for its confirmation row: locally, or through the vault. */
async function sealConfirmationAddress(
  keys: PrivacyKeys,
  channelId: string,
  email: string,
): Promise<{ sealed: string; emailHash?: string }> {
  if (isPrivacyVault(keys)) {
    if (!keys.sealAddressConfirmation) throw new VaultPortMissing('sealAddressConfirmation');
    return keys.sealAddressConfirmation(channelId, email);
  }
  if (!keys) throw new Error('FIELD_KEYS is required to seal an address');
  return { sealed: await sealDsrAddress(keys, email) };
}

export interface AddressRequestLink {
  confirmationId: number;
  workspaceId: string;
  /** Null in a link from before nonces: it opens only a row made before them. */
  nonce: string | null;
}

/** The confirmation id, workspace and nonce a link names, or null. */
export async function readAddressRequestToken(
  links: LinkVerifier,
  token: string,
  now?: number,
): Promise<AddressRequestLink | null> {
  if (token.length > 512) return null;
  const result = await links.verify<{ c?: unknown; w?: unknown; n?: unknown }>(
    ADDRESS_CONFIRM_PURPOSE,
    token,
    now ? { now } : {},
  );
  if (!result.ok) return null;
  const { c, w } = result.payload;
  const nonce = nonceOf(result.payload.n);
  return typeof c === 'string' &&
    CONFIRMATION_ID.test(c) &&
    typeof w === 'string' &&
    nonce !== undefined
    ? { confirmationId: Number(c), workspaceId: w, nonce }
    : null;
}

/** What an unused, unexpired link asks for, for its page. */
export async function addressRequestOpen(
  db: D1Database,
  link: AddressRequestLink,
  now: number = Date.now(),
): Promise<{ kind: DsrKind; channelId: string } | null> {
  const row = await first<{ kind: DsrKind; channel_id: string }>(
    db,
    `SELECT a.kind, a.channel_id FROM address_confirmations a JOIN channels c ON c.id = a.channel_id
      WHERE a.id = ?1 AND a.workspace_id = ?2 AND a.used_at IS NULL AND a.expires_at > ?3
        AND c.deleted_at IS NULL AND coalesce(a.nonce_hash, '') = coalesce(?4, '')`,
    link.confirmationId,
    link.workspaceId,
    now,
    await nonceHash(link.nonce),
  );
  return row ? { kind: row.kind, channelId: row.channel_id } : null;
}

export type ConfirmAddressOutcome = 'queued' | 'open' | 'review' | 'paid' | 'expired';

/**
 * Step two, the POST from the emailed link's page: uses the link (once) and files the request for
 * the address (source 'address_form'), like any request: one open request per kind, and an
 * erasure waits while a Stripe subscription still renews (the link is then not used up). Proven
 * by the inbox, it runs without waiting for an admin, as a confirmed request from subscriber
 * settings does; one an admin filed and left pending stays theirs.
 */
export async function confirmAddressRequest(
  db: D1Database,
  fieldKeys: PrivacyKeys,
  link: AddressRequestLink,
  now: number = Date.now(),
): Promise<ConfirmAddressOutcome> {
  const hash = await nonceHash(link.nonce);
  const row = await first<{ kind: DsrKind; channel_id: string; email_enc: string }>(
    db,
    `SELECT a.kind, a.channel_id, a.email_enc FROM address_confirmations a
       JOIN channels c ON c.id = a.channel_id
      WHERE a.id = ?1 AND a.workspace_id = ?2 AND a.used_at IS NULL AND a.expires_at > ?3
        AND c.deleted_at IS NULL AND coalesce(a.nonce_hash, '') = coalesce(?4, '')`,
    link.confirmationId,
    link.workspaceId,
    now,
    hash,
  );
  if (!row) return 'expired';
  let email: string | null;
  if (isPrivacyVault(fieldKeys)) {
    if (!fieldKeys.openAddressConfirmation) throw new VaultPortMissing('openAddressConfirmation');
    email = await fieldKeys.openAddressConfirmation(link.confirmationId, link.workspaceId);
  } else {
    email = fieldKeys ? await openDsrAddress(fieldKeys, row.email_enc) : null;
  }
  if (!email) return 'expired';
  if (row.kind === 'erase' && (await hasLivePaidSubscription(db, link.workspaceId, email))) {
    return 'paid';
  }
  // Sealed for the request before the confirmation is used: the vault seals it from that row.
  const requestId = newIdFor('dsrRequest', now);
  let sealedEmail: string | undefined;
  if (isPrivacyVault(fieldKeys)) {
    if (!fieldKeys.sealConfirmedAddress) throw new VaultPortMissing('sealConfirmedAddress');
    sealedEmail = await fieldKeys.sealConfirmedAddress(
      link.confirmationId,
      link.workspaceId,
      requestId,
    );
  }
  const used = await first(
    db,
    `UPDATE address_confirmations SET used_at = ?1
      WHERE id = ?2 AND workspace_id = ?3 AND used_at IS NULL AND expires_at > ?1
        AND coalesce(nonce_hash, '') = coalesce(?4, '') RETURNING id`,
    now,
    link.confirmationId,
    link.workspaceId,
    hash,
  );
  if (!used) return 'expired';
  const { forms } = await addressMarkers(db, link.workspaceId, email, fieldKeys);
  const open = await first<{ status: 'pending' | 'processing' }>(
    db,
    `SELECT status FROM dsr_requests WHERE workspace_id = ?1
        AND email_hash IN (SELECT value FROM json_each(?2)) AND kind = ?3
        AND status IN ('pending', 'processing') ORDER BY status = 'processing' DESC LIMIT 1`,
    link.workspaceId,
    JSON.stringify(forms),
    row.kind,
  );
  if (open) return open.status === 'processing' ? 'open' : 'review';
  await createDsrRequest(
    db,
    fieldKeys,
    {
      id: requestId,
      ...(sealedEmail ? { sealedEmail } : {}),
      workspaceId: link.workspaceId,
      channelId: row.channel_id,
      memberId: null,
      email,
      kind: row.kind,
      source: 'address_form',
      status: 'processing',
    },
    now,
  );
  await appendAudit(db, {
    workspaceId: link.workspaceId,
    actorId: null,
    action: 'privacy.request_created',
    targetType: 'dsr_request',
    targetId: requestId,
    metadata: { kind: row.kind, source: 'address_form', channelId: row.channel_id },
  });
  return 'queued';
}

/** Used and expired public-page confirmations, a day on: they hold a sealed address. */
export async function pruneAddressConfirmations(db: D1Database, now: number): Promise<number> {
  const result = await run(
    db,
    `DELETE FROM address_confirmations WHERE id IN (SELECT id FROM address_confirmations
        WHERE coalesce(used_at, expires_at) < ?1 LIMIT 1000)`,
    now - DAY_MS,
  );
  return result.meta.changes ?? 0;
}

// ---- Erasure --------------------------------------------------------------------------------

/**
 * The id just below `id` (the same prefix, the hex minus one). A cursor that pointed at an erased
 * Member points here instead: `id > cursor` selects exactly the same rows, since the erased one
 * is gone, and the stored value no longer names anyone.
 */
export function predecessorId(id: string): string {
  const [prefix, hex] = id.split('_') as [string, string];
  const value = BigInt(`0x${hex}`);
  return `${prefix}_${(value > 0n ? value - 1n : 0n).toString(16).padStart(hex.length, '0')}`;
}

/** Replaces every string equal to one of `needles` (case-insensitively) in a JSON value. */
function scrub(value: unknown, needles: Set<string>): unknown {
  if (typeof value === 'string') return needles.has(value.toLowerCase()) ? ERASED_TEXT : value;
  if (Array.isArray(value)) {
    return value
      .filter((v) => !(typeof v === 'string' && needles.has(v.toLowerCase())))
      .map((v) => scrub(v, needles));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, needles)]));
  }
  return value;
}

/**
 * Common characters that end an address in text (quotes, backslashes, brackets, separators,
 * whitespace), whose %XX and \u00XX escapes `decoded` reads back, so the apostrophe rules in
 * `mentions` see them too.
 */
const ADDRESS_DELIMITERS = [...`"'\\<>()[]{},;:=&?/|`, '\t', '\n', '\r'];

/** A SQL string literal; one with control characters is spelled with char() instead. */
function sqlText(text: string): string {
  if ([...text].some((ch) => ch < ' ')) {
    return `char(${[...text].map((ch) => ch.codePointAt(0)).join(', ')})`;
  }
  return `'${text.replace(/'/g, "''")}'`;
}

const hex = (ch: string) => ch.charCodeAt(0).toString(16).padStart(2, '0');

/** SQL: `sql` with each `[from, to]` replaced in order. */
function rewrite(sql: string, pairs: [string, string][]): string {
  return pairs.reduce(
    (out, [from, to]) => `replace(${out}, ${sqlText(from)}, ${sqlText(to)})`,
    sql,
  );
}

/** Stands for the address in the text, so only the characters next to it are tested. */
const MARK = '\u0001';

/**
 * How many copies of the address `mentions` looks at in one text. Each step copies the rest of the
 * text, so a large text full of longer addresses (joann@, leeann@ for ann@) would take long enough
 * to fail the erasure. A text with more copies than this counts as a mention: erasing too much is
 * the safer mistake.
 */
const MAX_COPIES = 64;

/**
 * MAX_COPIES for agent_approvals, where a mention cancels a pending approval rather than deleting
 * a log row, so a bulk request that lists many longer addresses (joann@, leeann@ for ann@) must
 * not count as one. A body is at most one MCP message (MCP_MAX_BODY_BYTES), and each credential
 * holds at most 50 pending, so even a body that size full of copies takes about a second.
 */
const APPROVAL_MAX_COPIES = 512;

/**
 * SQL: the two hex digits in `h` (lower case) name a character that can be in an address: any of
 * [a-z0-9.+_'-], in either case, or only [a-z0-9.-] with `domain`.
 */
function addressHex(h: string, domain: boolean): string {
  const marks = domain ? `'2d', '2e'` : `'27', '2b', '2d', '2e', '5f'`;
  return `(${h} IN (${marks}) OR ${h} GLOB '3[0-9]' OR ${h} GLOB '[46][1-9a-f]' OR ${h} GLOB '[57][0-9a]')`;
}

/**
 * Lower-cased text as the characters it stands for. A JSON escape becomes a space before the
 * backslashes do, or its letter stays glued to the address (`\nana@b.co`). Percent-encoding and
 * `\u00XX` are read as what they stand for, `%25` first so a twice-encoded address is read too. In
 * a form body a `+` is a space, but then a literal `+` is `%2b`, so `formEncoded` keeps `%40` and
 * `%2b` as they are and the address is looked for encoded the same way.
 */
function decoded(sql: string, formEncoded: boolean): string {
  const encodedDelimiters = [' ', ...ADDRESS_DELIMITERS].flatMap((ch): [string, string][] => [
    [`\\u00${hex(ch)}`, ch],
    [`%${hex(ch)}`, ch],
  ]);
  const plusAndAt: [string, string][] = formEncoded
    ? [['+', ' ']]
    : [
        ['%40', '@'],
        ['%2b', '+'],
      ];
  return rewrite(sql, [
    [MARK, ''],
    ...[...'bfnrt'].map((letter): [string, string] => [`\\${letter}`, ' ']),
    ['%25', '%'],
    ...plusAndAt,
    ...encodedDelimiters,
  ]);
}

/**
 * SQL: `column` mentions the address in `param` (already lower case) as a whole token, not inside
 * a longer address, so erasing a@b.co leaves rows about xa@b.co, x+a@b.co, x'a@b.co or a@b.com.
 * The text is read as plain, JSON-escaped or percent-encoded (see `decoded`), each copy of the
 * address becomes MARK, and the characters on either side of some copy must be boundaries: any
 * character that cannot be in an address (punctuation, an em dash, a curly quote, the start or end
 * of the text), or an escape (%XX, \uXXXX) that stands for one. Before the address that is anything
 * outside [a-z0-9.+_'-]; after it, anything outside [a-z0-9.-] once full stops, plain or escaped,
 * are skipped (the end of a sentence, so a longer domain still is not: a@b.co.uk). An apostrophe
 * can be inside an address, so before it (one or two, read as one) it is a boundary only as a
 * quote: after whitespace (say 'a@b.co), or after another boundary when an apostrophe also follows
 * the address ("'a@b.co'"). Otherwise it starts a longer address ("'a@b.co", x'a@b.co). After the
 * address one always is a boundary (a@b.co's), as the domain cannot hold one.
 * The first test, on the domain, is a cheap filter that every form passes. A recursive CTE visits
 * every copy (up to `maxCopies`), since one inside a longer address can come first. D1 caps GLOB
 * patterns at 50 bytes and expressions at a depth of 100, most of which the replace() calls in
 * `decoded` use: so the characters are classed with GLOB on substr() of the CTE's text, not with
 * more replace() calls.
 */
function mentions(column: string, param: string, maxCopies = MAX_COPIES): string {
  const mark = sqlText(MARK);
  // Six characters of padding, so substr() before the first copy never starts before the text.
  const marked = (formEncoded: boolean) => {
    const address = formEncoded ? `replace(replace(${param}, '+', '%2b'), '@', '%40')` : param;
    return `printf('""""""%s ', replace(${decoded(`lower(${column})`, formEncoded)}, ${address}, ${mark}))`;
  };
  const local = `'[a-z0-9.+_''-]'`;
  // `decoded` leaves an escaped full stop as it is, as an address can hold one; after the copy it
  // can also end a sentence, so there it is read as one.
  const stops = (sql: string) =>
    rewrite(sql, [
      ['%2e', '.'],
      ['\\u002e', '.'],
    ]);
  // `b`: the six characters before the copy; `q`: the one before its apostrophes, if it has any;
  // `a1`: the one after it; `a`: what follows, full stops skipped.
  const last = 'substr(b, 6)';
  const before = `((substr(b, 4) GLOB '%[0-9a-f][0-9a-f]' AND NOT ${addressHex('substr(b, 5)', false)})
      OR (b GLOB '\\u[0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          AND (substr(b, 3, 2) <> '00' OR NOT ${addressHex('substr(b, 5)', false)}))
      OR CASE WHEN ${last} <> '''' THEN ${last} NOT GLOB ${local} AND ${last} <> ${mark}
              ELSE q IN (' ', char(9), char(10), char(13))
                   OR (q NOT GLOB ${local} AND q <> ${mark} AND a1 = '''') END)`;
  const after = `(substr(a, 1, 1) NOT GLOB '[a-z0-9-]' AND substr(a, 1, 1) <> ${mark}
      AND NOT (a GLOB '%[0-9a-f][0-9a-f]*' AND ${addressHex('substr(a, 2, 2)', true)})
      AND NOT (a GLOB '\\u00[0-9a-f][0-9a-f]*' AND ${addressHex('substr(a, 5, 2)', true)}))`;
  return `(instr(lower(${column}), substr(${param}, instr(${param}, '@') + 1)) > 0
    AND EXISTS (WITH RECURSIVE
      forms(t) AS (SELECT ${marked(false)} UNION ALL SELECT ${marked(true)}),
      copies(t, p, n) AS (
        SELECT t, instr(t, ${mark}), 1 FROM forms WHERE instr(t, ${mark}) > 0
        UNION ALL
        SELECT t, p + instr(substr(t, p + 1), ${mark}), n + 1 FROM copies
         WHERE n < ${maxCopies} AND instr(substr(t, p + 1), ${mark}) > 0),
      sides(b, q, a1, a, more) AS (
        SELECT substr(t, p - 6, 6),
               CASE WHEN substr(t, p - 2, 1) = '''' THEN substr(t, p - 3, 1) ELSE substr(t, p - 2, 1) END,
               substr(t, p + 1, 1), ltrim(${stops('substr(t, p + 1, 64)')}, '.'),
               n = ${maxCopies} AND instr(substr(t, p + 1), ${mark}) > 0
          FROM copies)
      SELECT 1 FROM sides WHERE more OR (${before} AND ${after})))`;
}

export interface ErasureResult {
  memberIds: string[];
  channelIds: string[];
  suppressionId: string;
}

/**
 * Erases one address from a workspace. Idempotent: a second run finds no Members and only
 * re-checks the suppression and the address-only rows.
 */
export async function eraseAddress(
  db: D1Database,
  input: {
    workspaceId: string;
    email: string;
    exceptRequestId?: string | null;
    /** FIELD_KEYS or the vault: the marker is written install-keyed (`k2`). */
    keys: PrivacyKeys;
  },
  now: number = Date.now(),
): Promise<ErasureResult> {
  const email = normal(input.email);
  const ws = input.workspaceId;
  const { keyed: hash, forms } = await addressMarkers(db, ws, email, input.keys);
  const markerForms = JSON.stringify(forms);
  const members = await all<{ id: string; channel_id: string }>(
    db,
    `SELECT m.id, m.channel_id FROM members m JOIN channels c ON c.id = m.channel_id
      WHERE c.workspace_id = ?1 AND m.email = ?2`,
    ws,
    email,
  );
  const memberIds = members.map((m) => m.id);
  const channelIds = [...new Set(members.map((m) => m.channel_id))];
  const ids = JSON.stringify(memberIds);
  const needles = new Set([email, ...memberIds]);

  // The suppression, kept as a keyed marker. A row found by marker (either form) wins; a newer one
  // by address merges in.
  const existing = await all<{ id: string; email_hash: string | null }>(
    db,
    `SELECT id, email_hash FROM suppressions
      WHERE workspace_id = ?1 AND (email = ?2 OR email_hash IN (SELECT value FROM json_each(?3)))`,
    ws,
    email,
    markerForms,
  );
  const kept =
    existing.find((s) => s.email_hash !== null && forms.includes(s.email_hash)) ??
    existing[0] ??
    null;
  const suppressionId = kept?.id ?? newIdFor('suppression', now);
  const statements: D1PreparedStatement[] = [];
  const add = (sql: string, ...params: unknown[]) =>
    statements.push(db.prepare(sql).bind(...params));

  for (const other of existing) {
    if (other.id !== suppressionId) add('DELETE FROM suppressions WHERE id = ?1', other.id);
  }
  // A request from the public page still waiting for its link: it holds the sealed address.
  add(
    `DELETE FROM address_confirmations WHERE workspace_id = ?1
        AND email_hash IN (SELECT value FROM json_each(?2))`,
    ws,
    markerForms,
  );
  // The suppression below keeps the address out from now on, so this hash isn't needed.
  add(
    `DELETE FROM left_addresses WHERE email_hash IN (SELECT value FROM json_each(?1))
        AND channel_id IN (SELECT id FROM channels WHERE workspace_id = ?2)`,
    markerForms,
    ws,
  );
  if (kept) {
    add(
      `UPDATE suppressions SET email = ?1, email_hash = ?2, detail = ?3, channel_id = NULL
        WHERE id = ?4`,
      erasedAddress(suppressionId),
      hash,
      ERASED_TEXT,
      suppressionId,
    );
  } else {
    add(
      `INSERT INTO suppressions (id, workspace_id, email, email_hash, reason, detail, created_at)
       VALUES (?1, ?2, ?3, ?4, 'manual', ?5, ?6)`,
      suppressionId,
      ws,
      erasedAddress(suppressionId),
      hash,
      ERASED_TEXT,
      now,
    );
  }

  // Engagement keeps its counts and timestamps; the network prefix, network and browser family go
  // (before the Member reference is nulled by the delete below), the same as retention removes.
  const theirDeliveries = `SELECT id FROM deliveries WHERE member_id IN (SELECT value FROM json_each(?1))`;
  add(
    `UPDATE opens SET ip_prefix = NULL, asn = NULL, ua_family = NULL
      WHERE delivery_id IN (${theirDeliveries})`,
    ids,
  );
  add(
    `UPDATE clicks SET ip_prefix = NULL, asn = NULL, ua_family = NULL
      WHERE delivery_id IN (${theirDeliveries})`,
    ids,
  );
  add(
    `UPDATE deliveries SET email = ?2, error = NULL, provider_message_id = NULL
      WHERE member_id IN (SELECT value FROM json_each(?1))`,
    ids,
    ERASED_TEXT,
  );
  add(
    `UPDATE direct_sends SET provider_message_id = NULL, error = NULL
      WHERE member_id IN (SELECT value FROM json_each(?1))`,
    ids,
  );

  // Rows that name the Member or the address as text, without a foreign key.
  const wsChannels = 'SELECT id FROM channels WHERE workspace_id = ?2';
  add('DELETE FROM gate_meter_reads WHERE reader_key IN (SELECT value FROM json_each(?1))', ids);
  add('DELETE FROM platform_events WHERE member_id IN (SELECT value FROM json_each(?1))', ids);
  add(
    `UPDATE checkout_sessions SET email = NULL, member_id = NULL,
            detached_at = coalesce(detached_at, ?4)
      WHERE member_id IN (SELECT value FROM json_each(?1))
         OR (channel_id IN (${wsChannels}) AND email = ?3)`,
    ids,
    ws,
    email,
    now,
  );
  // Payments stay for the books; their provider id goes paymentRecordYears after the payment
  // (lifetimes.ts expirePaymentReferences). The Member delete below nulls member_id.
  add(
    `UPDATE payments SET detached_at = coalesce(detached_at, ?2)
      WHERE member_id IN (SELECT value FROM json_each(?1))`,
    ids,
    now,
  );
  // Good orders keep their amounts for the publisher's books, without the buyer. License keys go.
  add(
    `DELETE FROM good_license_keys WHERE order_id IN (SELECT id FROM good_orders
        WHERE channel_id IN (${wsChannels})
          AND (member_id IN (SELECT value FROM json_each(?1)) OR email = ?3))`,
    ids,
    ws,
    email,
  );
  add(
    `UPDATE good_orders SET email = ?4, member_id = NULL, stripe_session_id = NULL, payment_intent_id = NULL
      WHERE channel_id IN (${wsChannels})
        AND (member_id IN (SELECT value FROM json_each(?1)) OR email = ?3)`,
    ids,
    ws,
    email,
    ERASED_TEXT,
  );
  // A sponsor's contact address. The booking and its numbers stay for the publisher's books.
  add(
    `UPDATE sponsor_bookings SET sponsor_email = ?4, sponsor_name = ?4
      WHERE channel_id IN (${wsChannels}) AND sponsor_email = ?3 AND (?1 IS NOT NULL)`,
    ids,
    ws,
    email,
    ERASED_TEXT,
  );
  // A buyer who was never a Member: these events hold the address, not a Member id.
  add(
    `DELETE FROM platform_events WHERE type IN ('good.purchased', 'good.refunded')
        AND workspace_id = ?2 AND ${mentions('payload_json', '?3')}
        AND (?1 IS NOT NULL)`,
    ids,
    ws,
    email,
  );
  add(
    `UPDATE gift_passes SET purchaser_email = ?4, purchaser_member_id = NULL, message = NULL
      WHERE channel_id IN (${wsChannels})
        AND (purchaser_member_id IN (SELECT value FROM json_each(?1)) OR purchaser_email = ?3)`,
    ids,
    ws,
    email,
    ERASED_TEXT,
  );
  add(
    `UPDATE gift_passes SET recipient_email = NULL, claimed_member_id = NULL, message = NULL
      WHERE channel_id IN (${wsChannels})
        AND (claimed_member_id IN (SELECT value FROM json_each(?1)) OR recipient_email = ?3)`,
    ids,
    ws,
    email,
  );
  add(
    'DELETE FROM trial_claims WHERE channel_id IN (SELECT id FROM channels WHERE workspace_id = ?1) AND email = ?2',
    ws,
    email,
  );
  add('DELETE FROM soft_bounces WHERE workspace_id = ?1 AND email = ?2', ws, email);
  // Email checks (0068): the address's result, and its place in a check that is still running.
  add('DELETE FROM email_checks WHERE workspace_id = ?1 AND email = ?2', ws, email);
  add(
    `DELETE FROM email_check_items WHERE email = ?2
        AND run_id IN (SELECT id FROM email_check_runs WHERE workspace_id = ?1)`,
    ws,
    email,
  );
  // Bounce history and counters hold the address and what the receiving server said about it.
  add('DELETE FROM bounce_events WHERE workspace_id = ?1 AND email = ?2', ws, email);
  add('DELETE FROM bounce_states WHERE workspace_id = ?1 AND email = ?2', ws, email);
  // A queued SES suppression-list change names the address. The list is shared by every
  // workspace, so the row goes only when no other workspace still holds the address.
  add(
    `DELETE FROM provider_suppression_sync WHERE email = ?1
        AND NOT EXISTS (SELECT 1 FROM suppressions WHERE email = ?1 AND workspace_id <> ?2)`,
    email,
    ws,
  );
  // Deliveries name their Member (webhooks.ts); the text match below also catches older rows and
  // payloads that mention the address without it. Attempts cascade with their delivery.
  for (const memberId of memberIds) statements.push(...webhookErasureStatements(db, memberId));
  add(
    `DELETE FROM webhook_deliveries WHERE workspace_id = ?2
        AND (${mentions('payload_json', '?3')}
             OR EXISTS (SELECT 1 FROM json_each(?1) j WHERE instr(payload_json, j.value) > 0))`,
    ids,
    ws,
    email,
  );
  // Open Operator: held agent calls that mention the address or a Member id lose their stored
  // request (path included), summary and result; a pending one is canceled. The chained agent_actions log keeps
  // only masked summaries (no addresses), like audit_events.
  add(
    `UPDATE agent_approvals SET body_json = NULL, arguments_json = '{}', result_json = NULL,
        path = 'erased',
        status = CASE WHEN status = 'pending' THEN 'canceled' ELSE status END
      WHERE workspace_id = ?2
        AND (${mentions("coalesce(body_json, '')", '?3', APPROVAL_MAX_COPIES)}
             OR EXISTS (SELECT 1 FROM json_each(?1) j
                         WHERE instr(coalesce(body_json, '') || path || arguments_json
                                     || coalesce(result_json, ''), j.value) > 0))`,
    ids,
    ws,
    email,
  );
  // Idempotency-Key replays are shared by every workspace and keyed by principal
  // (v2/idempotency.ts). Member ids are unique, so a row quoting one goes wherever it is; a row
  // that only mentions the address goes when its principal belongs to this workspace: one of its
  // keys or grants, or an operator seated here (an operator's rows are not per workspace). The
  // principal is tested first, so other workspaces' rows don't pay for the text match.
  add(
    `DELETE FROM api_idempotency
      WHERE EXISTS (SELECT 1 FROM json_each(?1) j WHERE instr(response_json, j.value) > 0)
         OR (principal IN (SELECT 'key:' || id FROM api_keys WHERE workspace_id = ?3
                           UNION ALL
                           SELECT 'oauth:' || id FROM oauth_grants WHERE workspace_id = ?3
                           UNION ALL
                           SELECT 'operator:' || operator_id FROM seats WHERE workspace_id = ?3
                           UNION ALL
                           SELECT 'copilot:' || operator_id FROM seats WHERE workspace_id = ?3)
             AND ${mentions('response_json', '?2')})`,
    ids,
    email,
    ws,
  );

  // A saved view of the Member list can hold a search a teammate typed, such as this address.
  // The search goes; the view and its other filters stay.
  add(
    `UPDATE member_views SET filters_json = json_remove(filters_json, '$.q'), updated_at = ?3
      WHERE channel_id IN (SELECT id FROM channels WHERE workspace_id = ?1)
        AND instr(lower(coalesce(json_extract(filters_json, '$.q'), '')), ?2) > 0`,
    ws,
    email,
    Date.now(),
  );

  // Funnel rows credited to the Member as a Champion fold into the "no Champion" cut, so the
  // totals stay the same.
  add(
    `INSERT INTO funnel_daily (channel_id, day, source, utm_source, utm_medium, utm_campaign, form_id,
        champion_id, visits, form_views, subscribes, confirms, first_opens, paid)
     SELECT channel_id, day, source, utm_source, utm_medium, utm_campaign, form_id, '',
            visits, form_views, subscribes, confirms, first_opens, paid
       FROM funnel_daily WHERE champion_id IN (SELECT value FROM json_each(?1))
     ON CONFLICT (channel_id, day, source, utm_source, utm_medium, utm_campaign, form_id, champion_id)
     DO UPDATE SET visits = visits + excluded.visits, form_views = form_views + excluded.form_views,
       subscribes = subscribes + excluded.subscribes, confirms = confirms + excluded.confirms,
       first_opens = first_opens + excluded.first_opens, paid = paid + excluded.paid`,
    ids,
  );
  add('DELETE FROM funnel_daily WHERE champion_id IN (SELECT value FROM json_each(?1))', ids);

  // Resume cursors that point at the Member move to the id just below (same rows selected).
  for (const id of memberIds) {
    const below = predecessorId(id);
    add('UPDATE broadcasts SET snapshot_cursor = ?2 WHERE snapshot_cursor = ?1', id, below);
    add('UPDATE broadcasts SET fanout_cursor = ?2 WHERE fanout_cursor = ?1', id, below);
    add('UPDATE export_jobs SET cursor = ?2 WHERE cursor = ?1', id, below);
    add('UPDATE bulk_jobs SET cursor = ?2 WHERE cursor = ?1', id, below);
    add(
      `UPDATE export_destinations SET cursor_json = json_set(cursor_json, '$.membersId', ?2)
        WHERE json_extract(cursor_json, '$.membersId') = ?1`,
      id,
      below,
    );
  }

  // Every other request about this address, whatever its status, keeps nothing that could
  // identify the person: open and failed ones end here, and on all of them the sealed address,
  // the operator's note and any error text are replaced by a neutral outcome. The marker moves to
  // the keyed form. (The request running this erasure is finished by runOne.)
  add(
    `UPDATE dsr_requests SET
        status = CASE WHEN status IN ('pending', 'processing', 'failed') THEN 'rejected' ELSE status END,
        note = ?5, error = NULL, email_enc = NULL, claimed_until = NULL, email_hash = ?2,
        updated_at = ?3
      WHERE workspace_id = ?1 AND email_hash IN (SELECT value FROM json_each(?6)) AND id <> ?4`,
    ws,
    hash,
    now,
    input.exceptRequestId ?? '',
    ERASED_REQUEST_NOTE,
    markerForms,
  );

  // The Members themselves; everything with a foreign key to them cascades or is set null.
  add('DELETE FROM members WHERE id IN (SELECT value FROM json_each(?1))', ids);
  for (const member of members) {
    statements.push(
      platformEventStatement(
        db,
        {
          type: 'member.deleted',
          workspaceId: ws,
          channelId: member.channel_id,
          memberId: member.id,
          payload: { id: member.id, channelId: member.channel_id, deletedAt: toIso(now) },
        },
        now,
      ),
    );
  }
  await db.batch(statements);

  // JSON columns that may quote the address or the ids: rewritten in place.
  const scrubRows = async (table: string, column: string, where: string, ...params: unknown[]) => {
    const rows = await all<{ id: string; value: string }>(
      db,
      `SELECT id, ${column} AS value FROM ${table} WHERE ${where}`,
      ...params,
    );
    const updates = rows.map((row) =>
      db
        .prepare(`UPDATE ${table} SET ${column} = ?1 WHERE id = ?2`)
        .bind(JSON.stringify(scrub(JSON.parse(row.value), needles)), row.id),
    );
    if (updates.length) await db.batch(updates);
  };
  await scrubRows(
    'import_jobs',
    'report_json',
    'workspace_id = ?1 AND report_json IS NOT NULL AND instr(lower(report_json), ?2) > 0',
    ws,
    email,
  );
  if (memberIds.length) {
    await scrubRows(
      'bulk_jobs',
      'selection_json',
      'workspace_id = ?1 AND EXISTS (SELECT 1 FROM json_each(?2) j WHERE instr(selection_json, j.value) > 0)',
      ws,
      ids,
    );
  }
  return { memberIds, channelIds, suppressionId };
}

// ---- Data export ----------------------------------------------------------------------------

type Row = Record<string, unknown>;

const isoOrNull = (ms: unknown) => (typeof ms === 'number' ? toIso(ms) : null);

/** Every *_at column (ms) as an ISO string; *_json columns parsed. */
function present(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.endsWith('_json')) {
      out[key.slice(0, -5)] = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
    } else if (/_(at|until|end|by)$/.test(key) && typeof value === 'number') {
      out[key] = isoOrNull(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Up to EXPORT_ROW_LIMIT rows of `sql`, page by page. Kinds that can grow past one page order by
 * a unique key last, so pages neither repeat nor skip rows.
 */
async function pagedRows(
  db: D1Database,
  sql: string,
  params: unknown[],
): Promise<{ rows: Row[]; truncated: boolean }> {
  const out: Row[] = [];
  for (let offset = 0; offset < EXPORT_ROW_LIMIT; offset += EXPORT_PAGE_ROWS) {
    const page = await all<Row>(db, `${sql} LIMIT ${EXPORT_PAGE_ROWS} OFFSET ${offset}`, ...params);
    out.push(...page.map(present));
    if (page.length < EXPORT_PAGE_ROWS) return { rows: out, truncated: false };
  }
  // One more row means the history is longer than the limit.
  const more = await all<Row>(db, `${sql} LIMIT 1 OFFSET ${EXPORT_ROW_LIMIT}`, ...params);
  return { rows: out, truncated: more.length > 0 };
}

/**
 * Everything the workspace holds about one address, as one JSON document: per Member (one per
 * Channel), the profile with decrypted fields, tags and Circles, consent and confirmation
 * history, delivery, open and click history, Ask answers, referrals and Champion awards,
 * memberships, payments, comp grants, pledges and Gift Passes (amounts and dates only; Swarm
 * never holds card details), Flow runs and enrolment decisions, website sign-ins and the
 * suppression, if any.
 */
export async function buildMemberExport(
  db: D1Database,
  fieldKeys: Keyring,
  workspaceId: string,
  address: string,
  now: number = Date.now(),
): Promise<Record<string, unknown>> {
  const email = normal(address);
  const workspace = await first<{ name: string }>(
    db,
    'SELECT name FROM workspaces WHERE id = ?1',
    workspaceId,
  );
  const members = await all<Row & { id: string; channel_id: string }>(
    db,
    `SELECT m.id, m.channel_id, c.name AS channel_name, m.email, m.first_name, m.last_name, m.status,
            m.digest, m.source_json, m.form_id, m.import_id, m.referred_by, m.champion_code,
            m.consent_at, m.confirmed_at, m.paused_until, m.unsubscribe_reason, m.unsubscribed_at,
            m.tracking_opt_out_at, m.emails_off_at, m.sunset_notice_at, m.sunset_kept_at, m.created_at,
            m.updated_at
       FROM members m JOIN channels c ON c.id = m.channel_id
      WHERE c.workspace_id = ?1 AND m.email = ?2 ORDER BY m.created_at`,
    workspaceId,
    email,
  );

  const memberships = [];
  const truncated = new Set<string>();
  for (const member of members) {
    const id = member.id;
    /** One kind of history for this Member, noting when it was cut at the limit. */
    const rows = async (kind: string, sql: string, ...params: unknown[]) => {
      const result = await pagedRows(db, sql, params);
      if (result.truncated) truncated.add(kind);
      return result.rows;
    };
    const fields: Record<string, { label: string; value: FieldValue }> = {};
    const valueRows = await all<
      FieldRow & { value_text: string | null; value_num: number | null; value_enc: string | null }
    >(
      db,
      `SELECT f.id, f.channel_id, f.key, f.label, f.type, f.options_json, f.encrypted, f.position,
              f.created_at, v.value_text, v.value_num, v.value_enc
         FROM member_field_values v JOIN member_fields f ON f.id = v.field_id
        WHERE v.member_id = ?1 ORDER BY f.position`,
      id,
    );
    for (const row of valueRows) {
      fields[row.key] = {
        label: row.label,
        value: await fromStored(toFieldDef(row), row, fieldKeys),
      };
    }
    const deliveries = await rows(
      'deliveries',
      `SELECT d.id, d.broadcast_id, b.subject, d.status, d.bounce_type, d.sent_at, d.delivered_at,
              d.bounced_at, d.complained_at, d.opened_at, d.clicked_at, d.unsubscribed_at
         FROM deliveries d JOIN broadcasts b ON b.id = d.broadcast_id
        WHERE d.member_id = ?1 ORDER BY d.sent_at DESC, d.id`,
      id,
    );
    memberships.push({
      member: present({
        id,
        channel_id: member.channel_id,
        channel_name: member.channel_name,
        email: member.email,
        first_name: member.first_name,
        last_name: member.last_name,
        status: member.status,
        digest: member.digest,
        source_json: member.source_json,
        form_id: member.form_id,
        import_id: member.import_id,
        referred_by: member.referred_by,
        champion_code: member.champion_code,
        consent_at: member.consent_at,
        confirmed_at: member.confirmed_at,
        paused_until: member.paused_until,
        unsubscribe_reason: member.unsubscribe_reason,
        unsubscribed_at: member.unsubscribed_at,
        tracking_opt_out_at: member.tracking_opt_out_at,
        emails_off_at: member.emails_off_at,
        sunset_notice_at: member.sunset_notice_at,
        sunset_kept_at: member.sunset_kept_at,
        created_at: member.created_at,
        updated_at: member.updated_at,
      }),
      fields,
      tags: (
        await all<{ name: string }>(
          db,
          'SELECT t.name FROM member_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.member_id = ?1 ORDER BY t.name',
          id,
        )
      ).map((t) => t.name),
      circles: (
        await all<{ name: string }>(
          db,
          `SELECT c.name FROM circle_members cm JOIN circles c ON c.id = cm.circle_id
            WHERE cm.member_id = ?1 AND c.deleted_at IS NULL ORDER BY c.name`,
          id,
        )
      ).map((c) => c.name),
      // Rosters (Phase 8): every Roster the Member joined, with its status.
      rosters: await rows(
        'rosters',
        `SELECT r.name, rm.status, rm.source, rm.subscribed_at, rm.unsubscribed_at
           FROM roster_members rm JOIN rosters r ON r.id = rm.roster_id
          WHERE rm.member_id = ?1 AND r.deleted_at IS NULL ORDER BY r.name`,
        id,
      ),
      confirmations: await rows(
        'confirmations',
        `SELECT kind, sent_count, last_sent_at, reminded_at, confirmed_at, expires_at, created_at
           FROM confirm_requests WHERE member_id = ?1 ORDER BY created_at`,
        id,
      ),
      consents: await rows(
        'consents',
        `SELECT source, form_id, form_version, version_claimed, stamped_at, wording, ticked, must_confirm, attested_by,
                verified_host, claimed_origin, created_at
           FROM member_consents WHERE member_id = ?1 ORDER BY created_at, id`,
        id,
      ),
      events: await rows(
        'events',
        'SELECT type, payload_json, created_at FROM member_events WHERE member_id = ?1 ORDER BY seq',
        id,
      ),
      deliveries,
      engagement: await rows(
        'engagement',
        `SELECT score, band, sent_count, opened_count, clicked_count, last_engaged_at, computed_at
           FROM member_engagement WHERE member_id = ?1`,
        id,
      ),
      bestSendHour: await rows(
        'bestSendHour',
        'SELECT best_hour_utc, samples, computed_at FROM member_send_hours WHERE member_id = ?1',
        id,
      ),
      opens: await rows(
        'opens',
        `SELECT o.delivery_id, o.classification, o.ip_prefix, o.asn, o.ua_family, o.created_at FROM opens o
           JOIN deliveries d ON d.id = o.delivery_id WHERE d.member_id = ?1 ORDER BY o.created_at DESC, o.id`,
        id,
      ),
      clicks: await rows(
        'clicks',
        `SELECT k.delivery_id, l.url, k.classification, k.ip_prefix, k.asn, k.ua_family, k.created_at
           FROM clicks k
           JOIN deliveries d ON d.id = k.delivery_id JOIN link_targets l ON l.id = k.link_target_id
          WHERE d.member_id = ?1 ORDER BY k.created_at DESC, k.id`,
        id,
      ),
      askResponses: await rows(
        'askResponses',
        `SELECT a.title AS ask, q.prompt AS question, o.label AS option, r.text, r.surface, r.created_at
           FROM ask_responses r JOIN asks a ON a.id = r.ask_id JOIN ask_questions q ON q.id = r.question_id
           LEFT JOIN ask_options o ON o.id = r.option_id
          WHERE r.member_id = ?1 ORDER BY r.created_at`,
        id,
      ),
      referrals: await rows(
        'referrals',
        `SELECT CASE WHEN referrer_id = ?1 THEN 'referred_someone' ELSE 'was_referred' END AS role,
                status, created_at, counted_at,
                -- The network prefix is the referred person's own signup: theirs only.
                CASE WHEN referred_id = ?1 THEN ip_prefix ELSE NULL END AS ip_prefix
           FROM referrals WHERE referrer_id = ?1 OR referred_id = ?1 ORDER BY created_at`,
        id,
      ),
      championAwards: await rows(
        'championAwards',
        `SELECT m.name AS milestone, a.status, a.created_at, a.fulfilled_at FROM champion_awards a
           JOIN champion_milestones m ON m.id = a.milestone_id WHERE a.member_id = ?1`,
        id,
      ),
      memberships: await rows(
        'memberships',
        `SELECT l.name AS level, s.source, s.status, s.interval, s.currency, s.amount,
                s.current_period_end, s.trial_end, s.cancel_at, s.canceled_at, s.created_at
           FROM member_subscriptions s LEFT JOIN membership_levels l ON l.id = s.level_id
          WHERE s.member_id = ?1 ORDER BY s.created_at`,
        id,
      ),
      payments: await rows(
        'payments',
        `SELECT kind, stripe_object_id AS payment_reference, currency, amount, occurred_at FROM payments
          WHERE member_id = ?1 ORDER BY occurred_at, id`,
        id,
      ),
      paymentCustomer: await rows(
        'paymentCustomer',
        'SELECT stripe_customer_id AS customer_reference, created_at FROM stripe_customers WHERE member_id = ?1',
        id,
      ),
      access: await rows(
        'access',
        `SELECT kind, source, starts_at, expires_at FROM member_entitlements WHERE member_id = ?1
          ORDER BY starts_at`,
        id,
      ),
      meteredReads: await rows(
        'meteredReads',
        `SELECT r.period, d.subject AS post, r.read_at FROM gate_meter_reads r
           JOIN dispatches d ON d.id = r.dispatch_id
          WHERE r.reader_key = ?1 ORDER BY r.read_at, r.dispatch_id`,
        id,
      ),
      extraReads: await rows(
        'extraReads',
        'SELECT period, extra, created_at FROM gate_meter_grants WHERE member_id = ?1 ORDER BY created_at',
        id,
      ),
      giftedArticles: await rows(
        'giftedArticles',
        `SELECT d.subject AS post, g.period, g.created_at, g.expires_at FROM gift_article_links g
           JOIN dispatches d ON d.id = g.dispatch_id WHERE g.member_id = ?1 ORDER BY g.created_at`,
        id,
      ),
      signupJourney: await rows(
        'signupJourney',
        'SELECT joined_at, confirmed, first_opened, paid FROM funnel_members WHERE member_id = ?1',
        id,
      ),
      sendCopies: await rows(
        'sendCopies',
        `SELECT b.subject, r.email, r.first_name, r.last_name, r.status, r.claimed_at
           FROM broadcast_recipients r JOIN broadcasts b ON b.id = r.broadcast_id
          WHERE r.member_id = ?1 ORDER BY r.claimed_at DESC, r.broadcast_id`,
        id,
      ),
      automationEmails: await rows(
        'automationEmails',
        `SELECT b.subject, l.sent_at FROM flow_email_ledger l JOIN broadcasts b ON b.id = l.broadcast_id
          WHERE l.member_id = ?1 ORDER BY l.sent_at DESC, l.broadcast_id`,
        id,
      ),
      directEmails: await rows(
        'directEmails',
        `SELECT kind, status, created_at, sent_at FROM direct_sends WHERE member_id = ?1
          ORDER BY created_at DESC, id`,
        id,
      ),
      websiteLinks: await rows(
        'websiteLinks',
        'SELECT created_at, expires_at, consumed_at FROM reader_tokens WHERE member_id = ?1',
        id,
      ),
      compGrants: await rows(
        'compGrants',
        `SELECT l.name AS level, g.note, g.expires_at, g.created_at, g.revoked_at FROM comp_grants g
           LEFT JOIN membership_levels l ON l.id = g.level_id WHERE g.member_id = ?1`,
        id,
      ),
      pledges: await rows(
        'pledges',
        `SELECT l.name AS level, p.interval, p.currency, p.amount, p.status, p.created_at
           FROM pledges p LEFT JOIN membership_levels l ON l.id = p.level_id WHERE p.member_id = ?1`,
        id,
      ),
      goodOrders: await rows(
        'goodOrders',
        `SELECT g.name AS good, o.amount, o.currency, o.status, o.created_at, o.paid_at, k.license_key
           FROM good_orders o JOIN goods g ON g.id = o.good_id
           LEFT JOIN good_license_keys k ON k.order_id = o.id
          WHERE o.channel_id = ?1 AND (o.member_id = ?2 OR o.email = ?3)`,
        member.channel_id,
        id,
        email,
      ),
      giftPasses: await rows(
        'giftPasses',
        `SELECT CASE WHEN purchaser_member_id = ?1 OR purchaser_email = ?2 THEN 'bought' ELSE 'received' END AS role,
                l.name AS level, g.months, g.status, g.message, g.created_at, g.claimed_at
           FROM gift_passes g LEFT JOIN membership_levels l ON l.id = g.level_id
          WHERE g.channel_id = ?3 AND (g.purchaser_member_id = ?1 OR g.claimed_member_id = ?1
                OR g.purchaser_email = ?2 OR g.recipient_email = ?2)`,
        id,
        email,
        member.channel_id,
      ),
      flowRuns: await rows(
        'flowRuns',
        `SELECT f.name AS flow, r.status, r.exit_reason, r.started_at, r.ended_at FROM flow_runs r
           JOIN flows f ON f.id = r.flow_id WHERE r.member_id = ?1 AND r.test = 0 ORDER BY r.started_at`,
        id,
      ),
      flowDecisions: await rows(
        'flowDecisions',
        `SELECT f.name AS flow, d.version, d.reason, d.trigger_event, d.decided_at
           FROM flow_enrol_decisions d JOIN flows f ON f.id = d.flow_id
          WHERE d.member_id = ?1 ORDER BY d.decided_at`,
        id,
      ),
      flowHolds: await rows(
        'flowHolds',
        `SELECT f.name AS flow, h.version, h.reason, h.until, h.held_at, h.released_at, h.outcome
           FROM flow_holds h JOIN flows f ON f.id = h.flow_id
          WHERE h.member_id = ?1 ORDER BY h.held_at`,
        id,
      ),
      websiteSignIns: await rows(
        'websiteSignIns',
        'SELECT created_at, last_seen_at, expires_at FROM reader_sessions WHERE member_id = ?1',
        id,
      ),
    });
  }

  const markers = await addressMarkers(db, workspaceId, email, fieldKeys);
  const suppression = await first<Row>(
    db,
    `SELECT reason, created_at FROM suppressions
      WHERE workspace_id = ?1 AND (email = ?2 OR email_hash IN (SELECT value FROM json_each(?3)))`,
    workspaceId,
    email,
    JSON.stringify(markers.forms),
  );
  // Bounces of the address in the workspace (the last 90 days), with what the server said.
  const bounces = await all<Row>(
    db,
    `SELECT kind, cause, code, detail, created_at FROM bounce_events
      WHERE workspace_id = ?1 AND email = ?2 ORDER BY created_at DESC LIMIT ${EXPORT_ROW_LIMIT}`,
    workspaceId,
    email,
  );
  // Rows anywhere in the workspace that hold the address without a Member (a buyer, gift sender or
  // recipient, sponsor contact or trial claimant who never subscribed, or one an operator deleted).
  const wsChannels = 'SELECT id FROM channels WHERE workspace_id = ?1';
  const addressRows = async (kind: string, sql: string) => {
    const result = await pagedRows(db, sql, [workspaceId, email]);
    if (result.truncated) truncated.add(kind);
    return result.rows;
  };
  const addressOnly = {
    checkouts: await addressRows(
      'checkouts',
      `SELECT c.name AS publication, s.intent, s.status, s.stripe_session_id AS payment_reference,
              s.created_at, s.completed_at
         FROM checkout_sessions s JOIN channels c ON c.id = s.channel_id
        WHERE s.channel_id IN (${wsChannels}) AND s.email = ?2 ORDER BY s.created_at, s.reference`,
    ),
    orders: await addressRows(
      'orders',
      `SELECT c.name AS publication, g.name AS good, o.amount, o.currency, o.status, o.created_at, o.paid_at
         FROM good_orders o JOIN goods g ON g.id = o.good_id JOIN channels c ON c.id = o.channel_id
        WHERE o.channel_id IN (${wsChannels}) AND o.email = ?2 AND o.member_id IS NULL
        ORDER BY o.created_at, o.id`,
    ),
    giftPasses: await addressRows(
      'giftPasses',
      `SELECT c.name AS publication, CASE WHEN g.purchaser_email = ?2 THEN 'bought' ELSE 'received' END AS role,
              g.months, g.status, g.message, g.created_at, g.claimed_at
         FROM gift_passes g JOIN channels c ON c.id = g.channel_id
        WHERE g.channel_id IN (${wsChannels}) AND (g.purchaser_email = ?2 OR g.recipient_email = ?2)
          AND g.purchaser_member_id IS NULL AND g.claimed_member_id IS NULL
        ORDER BY g.created_at, g.id`,
    ),
    trialClaims: await addressRows(
      'trialClaims',
      `SELECT c.name AS publication, t.created_at FROM trial_claims t JOIN channels c ON c.id = t.channel_id
        WHERE t.channel_id IN (${wsChannels}) AND t.email = ?2 ORDER BY t.created_at`,
    ),
    sponsorBookings: await addressRows(
      'sponsorBookings',
      `SELECT c.name AS publication, b.sponsor_name, b.run_on, b.ad_title, b.ad_url, b.status, b.created_at
         FROM sponsor_bookings b JOIN channels c ON c.id = b.channel_id
        WHERE b.channel_id IN (${wsChannels}) AND b.sponsor_email = ?2 ORDER BY b.created_at, b.id`,
    ),
    bounceCounters: await addressRows(
      'bounceCounters',
      `SELECT soft_streak, last_kind, last_cause, last_code, last_detail, last_bounced_at, held_at
         FROM bounce_states WHERE workspace_id = ?1 AND email = ?2`,
    ),
  };
  // Email checks (0068): the address's result with DeBounce or Swarm's own check.
  const emailCheck = await first<Row>(
    db,
    `SELECT state, code, reason, did_you_mean, source, checked_at FROM email_checks
      WHERE workspace_id = ?1 AND email = ?2`,
    workspaceId,
    email,
  );
  return {
    format: 'swarm-member-data/1',
    generatedAt: toIso(now),
    workspace: workspace?.name ?? null,
    email,
    note: `What this workspace holds about ${email}: one entry per publication you subscribe to, including the network prefix (the first part of the IP address), network and browser family recorded with opens and clicks, then the rows that hold the address without a subscription ("addressOnly"). "excluded" names what is kept but not in this file, and why. History lists keep the newest ${EXPORT_ROW_LIMIT} rows of each kind; "truncated" names the kinds that had more. Card details are never stored.`,
    truncated: [...truncated].sort(),
    excluded: Object.entries(EXPORT_INVENTORY)
      .filter((entry): entry is [string, { excluded: string }] => typeof entry[1] === 'object')
      .map(([table, { excluded }]) => ({ table, reason: excluded })),
    channels: memberships,
    addressOnly,
    suppression: suppression ? present(suppression) : null,
    bounces: bounces.map(present),
    emailCheck: emailCheck ? present(emailCheck) : null,
  };
}

/**
 * Every table that can hold data about a person, and whether a data export includes it
 * (`exported`) or leaves it out on purpose, with the reason the file states. The jobs worker's
 * privacy test fails on a person-linked table missing here, so a new table can't ship
 * unclassified.
 */
export const EXPORT_INVENTORY: Record<string, 'exported' | { excluded: string }> = {
  members: 'exported',
  member_field_values: 'exported',
  member_tags: 'exported',
  circle_members: 'exported',
  roster_members: 'exported',
  confirm_requests: 'exported',
  member_consents: 'exported',
  member_events: 'exported',
  deliveries: 'exported',
  opens: 'exported',
  clicks: 'exported',
  member_engagement: 'exported',
  member_send_hours: 'exported',
  ask_responses: 'exported',
  referrals: 'exported',
  champion_awards: 'exported',
  member_subscriptions: 'exported',
  payments: 'exported',
  stripe_customers: 'exported',
  member_entitlements: 'exported',
  comp_grants: 'exported',
  pledges: 'exported',
  good_orders: 'exported',
  good_license_keys: 'exported',
  gift_passes: 'exported',
  gate_meter_reads: 'exported',
  gate_meter_grants: 'exported',
  gift_article_links: 'exported',
  funnel_members: 'exported',
  broadcast_recipients: 'exported',
  flow_email_ledger: 'exported',
  flow_runs: 'exported',
  flow_enrol_decisions: 'exported',
  flow_holds: 'exported',
  reader_sessions: 'exported',
  reader_tokens: 'exported',
  direct_sends: 'exported',
  checkout_sessions: 'exported',
  trial_claims: 'exported',
  sponsor_bookings: 'exported',
  suppressions: 'exported',
  bounce_events: 'exported',
  bounce_states: 'exported',
  email_checks: 'exported',
  flow_run_steps: {
    excluded: 'Internal steps of automation runs; the runs themselves are included.',
  },
  soft_bounces: { excluded: 'No longer written; older rows are deleted after 30 days.' },
  email_check_items: {
    excluded: 'A place in a list check that is still running; the result is included.',
  },
  email_check_requests: {
    excluded: 'A pending "Check again" on the address, deleted once it runs or after a day.',
  },
  provider_suppression_sync: {
    excluded: 'A queued change to the mail provider’s list; the block itself is included.',
  },
  left_addresses: {
    excluded: 'A one-way marker that keeps a deleted, unsubscribed address from being re-added.',
  },
  unsubscribe_refs: {
    excluded: 'Which old email’s unsubscribe link stops this subscription; ids only.',
  },
  dsr_confirmations: { excluded: 'Single-use confirmation links for a deletion request.' },
  address_confirmations: {
    excluded: 'Single-use confirmation links for a request from the request page, sealed.',
  },
  dsr_requests: { excluded: 'Records of data requests themselves.' },
  member_views: {
    excluded: 'Teammates’ saved list views, which may hold a search for the address.',
  },
  funnel_daily: { excluded: 'Daily totals; only rows credited to a Champion name them.' },
  broadcasts: {
    excluded: 'Posts and their sending state; only resume cursors can name a subscriber.',
  },
  import_jobs: { excluded: 'Teammates’ import reports, which may quote the address.' },
  export_jobs: { excluded: 'Teammates’ bulk exports; only a resume cursor names a subscriber.' },
  bulk_jobs: { excluded: 'Teammates’ bulk changes; the selection can list subscribers.' },
  export_destinations: { excluded: 'Export settings; only a resume cursor names a subscriber.' },
  api_idempotency: { excluded: 'Short-lived replays of API answers.' },
  webhook_deliveries: {
    excluded: 'Copies of events sent to the publisher’s own systems, kept 30 days.',
  },
  webhook_attempts: { excluded: 'Delivery attempts of those events.' },
  platform_events: { excluded: 'The outbox those events are sent from.' },
  audit_events: {
    excluded: 'The workspace’s tamper-evident audit log, which names subscribers by id only.',
  },
  agent_actions: { excluded: 'The AI assistant’s log, with masked summaries and ids only.' },
  agent_approvals: { excluded: 'Assistant actions waiting for a teammate’s approval.' },
};

// ---- Export links ---------------------------------------------------------------------------

const REQUEST_ID = /^pr_[0-9a-f]{32}$/;

export function exportLinkToken(
  links: LinkSigner,
  request: { requestId: string; workspaceId: string },
  now?: number,
) {
  return links.sign(
    DSR_EXPORT_TOKEN_PURPOSE,
    { r: request.requestId, w: request.workspaceId },
    { expiresInSeconds: DSR_EXPORT_LINK_DAYS * 86_400, ...(now === undefined ? {} : { now }) },
  );
}

/**
 * The request id and workspace (null in a link from before the cutover) from an export link, or
 * null. The caller checks the workspace against the request (exportDownload).
 */
export async function readExportLinkToken(
  links: LinkVerifier,
  token: string,
  now?: number,
): Promise<{ requestId: string; workspaceId: string | null } | null> {
  if (token.length > 512) return null;
  const result = await links.verify<{ r?: unknown; w?: unknown }>(
    DSR_EXPORT_TOKEN_PURPOSE,
    token,
    now ? { now } : {},
  );
  if (!result.ok) return null;
  const { r, w } = result.payload;
  if (w !== undefined && typeof w !== 'string') return null;
  return typeof r === 'string' && REQUEST_ID.test(r)
    ? { requestId: r, workspaceId: w ?? null }
    : null;
}

export interface ExportDownload {
  requestId: string;
  key: string;
  channelName: string | null;
  accent: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * A finished export that can still be downloaded. `workspaceId` is the link's tenant claim (null
 * for a link from before the cutover): a request of another workspace is not found.
 */
export async function exportDownload(
  db: D1Database,
  requestId: string,
  now: number = Date.now(),
  workspaceId: string | null = null,
): Promise<ExportDownload | null> {
  const row = await first<{
    export_key: string | null;
    export_expires_at: number | null;
    created_at: number;
    channel_name: string | null;
    branding_json: string | null;
  }>(
    db,
    `SELECT r.export_key, r.export_expires_at, r.created_at, c.name AS channel_name, c.branding_json
       FROM dsr_requests r LEFT JOIN channels c ON c.id = r.channel_id
      WHERE r.id = ?1 AND r.kind = 'export' AND r.status = 'completed'
        AND (?2 IS NULL OR r.workspace_id = ?2)`,
    requestId,
    workspaceId,
  );
  if (!row?.export_key || (row.export_expires_at ?? 0) <= now) return null;
  return {
    requestId,
    key: row.export_key,
    channelName: row.channel_name,
    accent: accentOf(row.branding_json),
    createdAt: row.created_at,
    expiresAt: row.export_expires_at as number,
  };
}

function accentOf(brandingJson: string | null): string {
  const accent = brandingJson
    ? (JSON.parse(brandingJson) as { accentColor?: unknown }).accentColor
    : null;
  return typeof accent === 'string' && /^#[0-9a-f]{6}$/i.test(accent) ? accent : '#6c4cf1';
}

// ---- Running requests (jobs worker) ---------------------------------------------------------

export interface PrivacyDeps extends AudienceDeps {
  /** FIELD_KEYS (tests), or the jobs worker's vault: markers, the address, the export. */
  fieldKeys: PrivacyKeys;
  /** The private EXPORTS bucket. */
  exports: R2Bucket;
}

interface RunnableRow {
  id: string;
  workspace_id: string;
  channel_id: string | null;
  kind: DsrKind;
  email_enc: string | null;
  email_hash: string;
  attempts: number;
  handled_by: string | null;
}

/** The note on a finished export that was not emailed. */
export const EXPORT_NOT_MAILED_NOTE =
  'Not emailed: this address can’t receive email. Download the file here and send it another way.';

export const dsrExportKey = (workspaceId: string, requestId: string) =>
  `dsr/${workspaceId}/${requestId}.json`;

/** Who privacy emails come from: the Channel's sender, or the platform's privacy address. */
async function privacySender(
  deps: AudienceDeps,
  workspaceId: string,
  channelId: string | null,
): Promise<{
  channel: { id: string; branding_json: string } | null;
  name: string;
  accent: string;
  from: { name: string; address: string };
  replyTo: string | null;
}> {
  const { db } = deps;
  const channel = await first<{ id: string; slug: string; name: string; branding_json: string }>(
    db,
    `SELECT id, slug, name, branding_json FROM channels
      WHERE workspace_id = ?1 AND (id = ?2 OR ?2 IS NULL) ORDER BY id = ?2 DESC, created_at LIMIT 1`,
    workspaceId,
    channelId,
  );
  const name = channel?.name ?? 'Your newsletter';
  let from = { name, address: `privacy@${deps.platformMailDomain}` };
  let replyTo: string | null = null;
  if (channel) {
    // resolveSender reads only the platform mail domain from the engine config.
    const config = { platformMailDomain: deps.platformMailDomain } as EngineConfig;
    const sender = await resolveSender(db, config, channel, null);
    from = {
      name: sender.name,
      address: sender.problems.length
        ? `${channel.slug}@${deps.platformMailDomain}`
        : sender.address,
    };
    replyTo = sender.problems.length ? null : sender.replyTo;
  }
  return { channel, name, accent: accentOf(channel?.branding_json ?? null), from, replyTo };
}

async function mailExportLink(deps: PrivacyDeps, row: RunnableRow, email: string, now: number) {
  const { db } = deps;
  const token = await exportLinkToken(
    deps.links,
    { requestId: row.id, workspaceId: row.workspace_id },
    now,
  );
  const url = `${deps.captureOrigin}/m/data/${token}`;
  const { channel, name, accent, from, replyTo } = await privacySender(
    deps,
    row.workspace_id,
    row.channel_id,
  );
  const body = memberMail({
    channelName: name,
    accent,
    heading: 'Your data is ready',
    paragraphs: [
      `You asked for a copy of the data ${name} holds about this address. It is one JSON file.`,
      `The link works for ${DSR_EXPORT_LINK_DAYS} days.`,
    ],
    button: { label: 'Download my data', url },
    footnote:
      'If you did not ask for this, nobody else can open the link without this email. You can ignore it.',
  });
  const fallback = { subject: `Your data from ${name}`, ...body };
  const message = channel
    ? await composeMessage(db, {
        key: 'data_export',
        channelId: channel.id,
        workspaceId: row.workspace_id,
        channelName: name,
        accent,
        variables: { channel_name: name, days: String(DSR_EXPORT_LINK_DAYS), download_url: url },
        fallback,
      })
    : fallback;
  await deps.mail.send({
    category: 'privacy_export',
    from,
    to: email,
    replyTo: replyTo ?? from.address,
    subject: message.subject,
    html: message.html,
    text: message.text,
    tags: { workspace: row.workspace_id },
  });
}

/** Deletes the R2 files of every finished export of this address in the workspace. */
async function purgeExports(deps: PrivacyDeps, workspaceId: string, email: string) {
  const { forms } = await addressMarkers(deps.db, workspaceId, email, deps.fieldKeys);
  const exported = await all<{ id: string; export_key: string }>(
    deps.db,
    `SELECT id, export_key FROM dsr_requests
      WHERE workspace_id = ?1 AND email_hash IN (SELECT value FROM json_each(?2))
        AND export_key IS NOT NULL`,
    workspaceId,
    JSON.stringify(forms),
  );
  if (!exported.length) return;
  await deps.exports.delete(exported.map((r) => r.export_key));
  await run(
    deps.db,
    `UPDATE dsr_requests SET export_key = NULL WHERE id IN (SELECT value FROM json_each(?1))`,
    JSON.stringify(exported.map((r) => r.id)),
  );
}

/**
 * The request's sealed address can't be opened with the keys this worker has (FIELD_KEYS lost or
 * rotated without keeping the old key). Retrying with the same keys can't help, so the request
 * fails at once, with this recovery note for the admin, instead of after DSR_MAX_ATTEMPTS.
 */
export class UnreadableRequestAddress extends Error {
  constructor(keyId: string | null) {
    super(
      `The address on this request can't be opened with the current FIELD_KEYS${keyId ? ` (it was sealed with key "${keyId}")` : ''}. Put that key back in FIELD_KEYS and retry, or reject this request and file it again with the person's address.`,
    );
  }
}

/**
 * Where earlier copies of the erased Members may still be, which Swarm can only signal to: export
 * destinations of their Channels (they get an id-only deletions/ line, earlier objects stay) and
 * Event Webhook endpoints (member.deleted; receivers keep what they got). Named on the request so
 * the admin knows whom to ask. No address or name.
 */
async function outstandingCopies(
  db: D1Database,
  workspaceId: string,
  channelIds: string[],
): Promise<string[]> {
  if (!channelIds.length) return [];
  const ids = JSON.stringify(channelIds);
  const destinations = await all<{ kind: string; bucket: string | null; prefix: string | null }>(
    db,
    `SELECT kind, json_extract(config_json, '$.bucket') AS bucket,
            json_extract(config_json, '$.prefix') AS prefix
       FROM export_destinations
      WHERE workspace_id = ?1 AND channel_id IN (SELECT value FROM json_each(?2))
        AND last_run_at IS NOT NULL`,
    workspaceId,
    ids,
  );
  const hooks = await all<{ url: string }>(
    db,
    `SELECT url FROM webhook_endpoints WHERE workspace_id = ?1
        AND (channel_id IS NULL OR channel_id IN (SELECT value FROM json_each(?2)))`,
    workspaceId,
    ids,
  );
  const out: string[] = [];
  if (destinations.length) {
    out.push(
      `Earlier copies may remain at export destinations: ${destinations
        .map((d) => `${d.kind} ${d.bucket ?? ''}/${d.prefix ?? ''}`.trim())
        .join(', ')}. They were sent a deletion line; remove earlier objects there.`,
    );
  }
  if (hooks.length) {
    out.push(
      `Event webhook receivers may keep earlier events: ${hooks.map((h) => new URL(h.url).host).join(', ')}.`,
    );
  }
  return out;
}

async function runOne(deps: PrivacyDeps, row: RunnableRow, now: number): Promise<string[]> {
  if (!row.email_enc) throw new UnreadableRequestAddress(null);
  const email = await openRequestAddress(deps.fieldKeys, row);
  if (!email) throw new UnreadableRequestAddress(sealedKeyId(row.email_enc));
  if (row.kind === 'export') {
    let data: Record<string, unknown>;
    if (isPrivacyVault(deps.fieldKeys)) {
      // The vault builds it: encrypted fields are opened there, bound to their rows.
      if (!deps.fieldKeys.buildRequestExport) throw new VaultPortMissing('buildRequestExport');
      data = await deps.fieldKeys.buildRequestExport(row.id);
    } else {
      if (!deps.fieldKeys) throw new UnreadableRequestAddress(null);
      data = await buildMemberExport(deps.db, deps.fieldKeys, row.workspace_id, email, now);
    }
    const key = dsrExportKey(row.workspace_id, row.id);
    await deps.exports.put(key, JSON.stringify(data, null, 2), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { workspace: row.workspace_id },
    });
    // A bounced or complained address gets no email: an admin downloads the file from the
    // Privacy Center and hands it over another way.
    const mailed = await canMailAddress(deps.db, row.workspace_id, email);
    if (mailed) await mailExportLink(deps, row, email, now);
    await run(
      deps.db,
      `UPDATE dsr_requests SET status = 'completed', export_key = ?1, export_expires_at = ?2,
          email_enc = NULL, claimed_until = NULL, error = NULL, completed_at = ?3, updated_at = ?3,
          note = CASE WHEN ?5 = 1 THEN note ELSE trim(coalesce(note, '') || ' ' || ?6) END
        WHERE id = ?4`,
      key,
      now + DSR_EXPORT_LINK_DAYS * DAY_MS,
      now,
      row.id,
      mailed ? 1 : 0,
      EXPORT_NOT_MAILED_NOTE,
    );
    await appendAudit(deps.db, {
      workspaceId: row.workspace_id,
      actorId: null,
      action: 'privacy.export_completed',
      targetType: 'dsr_request',
      targetId: row.id,
      metadata: { channels: (data.channels as unknown[]).length, mailed },
    });
    return [];
  }
  const result = await eraseAddress(
    deps.db,
    { workspaceId: row.workspace_id, email, exceptRequestId: row.id, keys: deps.fieldKeys },
    now,
  );
  await purgeExports(deps, row.workspace_id, email);
  const outstanding = await outstandingCopies(deps.db, row.workspace_id, result.channelIds);
  // A hard bounce may have reached the mail provider's account-level list (SES), which keeps the
  // address in clear. It stays there by decision (docs/gdpr.md): suppression is what keeps an
  // erased person from being mailed again. The request says so.
  const blocked = await first<{ reason: string }>(
    deps.db,
    'SELECT reason FROM suppressions WHERE id = ?1',
    result.suppressionId,
  );
  if (blocked?.reason === 'hard_bounce') outstanding.push(PROVIDER_LIST_NOTE);
  // Nothing on the finished request can identify the person: the operator's note goes too.
  await run(
    deps.db,
    `UPDATE dsr_requests SET status = 'completed', member_id = NULL, email_enc = NULL,
        email_hash = ?3, note = ?4, claimed_until = NULL, error = NULL, completed_at = ?1,
        updated_at = ?1
      WHERE id = ?2`,
    now,
    row.id,
    await addressMarker(deps.db, row.workspace_id, email, deps.fieldKeys),
    [ERASED_REQUEST_NOTE, ...outstanding].join(' ').slice(0, 1000),
  );
  await appendAudit(deps.db, {
    workspaceId: row.workspace_id,
    actorId: null,
    action: 'privacy.erased',
    targetType: 'dsr_request',
    targetId: row.id,
    metadata: { members: result.memberIds.length, channels: result.channelIds.length },
  });
  return result.channelIds;
}

export interface PrivacyRunResult {
  completed: string[];
  failed: string[];
  /** Channels that lost Members: their Circles need a refresh. */
  channelIds: string[];
}

/**
 * Runs the requests that are `processing` (Member Center requests and approved ones), oldest
 * first. A run claims a request with a lease; a failure is retried on a later run with a growing
 * delay, and after DSR_MAX_ATTEMPTS runs the request is `failed` with the error.
 */
export async function runPrivacyRequests(
  deps: PrivacyDeps,
  now: number = Date.now(),
  limit = 5,
): Promise<PrivacyRunResult> {
  const result: PrivacyRunResult = { completed: [], failed: [], channelIds: [] };
  const due = await all<{ id: string }>(
    deps.db,
    `SELECT id FROM dsr_requests WHERE status = 'processing'
        AND (claimed_until IS NULL OR claimed_until < ?1) ORDER BY created_at LIMIT ?2`,
    now,
    limit,
  );
  for (const { id } of due) {
    const row = await first<RunnableRow>(
      deps.db,
      `UPDATE dsr_requests SET claimed_until = ?1, attempts = attempts + 1, updated_at = ?2
        WHERE id = ?3 AND status = 'processing' AND (claimed_until IS NULL OR claimed_until < ?2)
        RETURNING id, workspace_id, channel_id, kind, email_enc, email_hash, attempts, handled_by`,
      now + LEASE_MS,
      now,
      id,
    );
    if (!row) continue;
    try {
      result.channelIds.push(...(await runOne(deps, row, now)));
      result.completed.push(id);
    } catch (error) {
      // Never an address, which provider and database errors may quote.
      const message = redactAddresses((error as Error).message).slice(0, 500);
      // An unreadable address won't become readable on a retry with the same keys.
      const last = row.attempts >= DSR_MAX_ATTEMPTS || error instanceof UnreadableRequestAddress;
      await run(
        deps.db,
        `UPDATE dsr_requests SET status = ?1, error = ?2, claimed_until = ?3, updated_at = ?4
          WHERE id = ?5`,
        last ? 'failed' : 'processing',
        message,
        last ? null : now + row.attempts * 5 * 60_000,
        now,
        id,
      );
      if (last) result.failed.push(id);
    }
  }
  result.channelIds = [...new Set(result.channelIds)];
  return result;
}

// ---- Request outcomes -----------------------------------------------------------------------

/** A failed request is put in front of the workspace's admins again this often until resolved. */
export const DSR_FAILED_REMINDER_DAYS = 3;
const OUTCOME_BATCH = 20;

export interface OutcomeNoticeDeps extends PrivacyDeps {
  /** Operator notices: notifications@<PLATFORM_MAIL_DOMAIN>. */
  notices: { mail: PrivacyDeps['mail']; from: string };
  /** The dashboard origin, for the Privacy Center link. */
  appOrigin: string;
}

/**
 * Tells people what became of a request that did not go through, and keeps failed ones in front
 * of an admin:
 * - A rejected request (status `rejected` with its sealed address still on it; erasure clears
 *   the address of the requests it ends, so an erased address is never mailed) and a request that
 *   reached `failed` get one email at the requesting address. It says, in general terms only, that
 *   the request was declined or could not be completed yet and what the person can do; never why,
 *   never anything held, never the operator's note. A rejected request's address is then cleared.
 * - Every DSR_FAILED_REMINDER_DAYS while a request stays `failed`, the workspace's owners and
 *   admins get a notice with a link to the Privacy Center.
 */
export async function sendRequestOutcomeNotices(
  deps: OutcomeNoticeDeps,
  now: number = Date.now(),
): Promise<{ people: number; admins: number }> {
  const { db } = deps;
  const result = { people: 0, admins: 0 };
  const due = await all<{
    id: string;
    workspace_id: string;
    channel_id: string | null;
    kind: DsrKind;
    status: 'rejected' | 'failed';
    email_enc: string;
  }>(
    db,
    `SELECT id, workspace_id, channel_id, kind, status, email_enc FROM dsr_requests
      WHERE status IN ('rejected', 'failed') AND outcome_noticed_at IS NULL
        AND email_enc IS NOT NULL
      ORDER BY updated_at LIMIT ${OUTCOME_BATCH}`,
  );
  for (const row of due) {
    // Opened before the claim: the vault opens it only while no notice has gone out.
    const email = await openRequestAddress(deps.fieldKeys, row);
    // Claim first, so overlapping runs never mail twice.
    const claimed = await first(
      db,
      `UPDATE dsr_requests SET outcome_noticed_at = ?1
        WHERE id = ?2 AND outcome_noticed_at IS NULL RETURNING id`,
      now,
      row.id,
    );
    if (!claimed) continue;
    if (email && !(await isErasedAddress(db, row.workspace_id, email, deps.fieldKeys))) {
      const { name, accent, from, replyTo } = await privacySender(
        deps,
        row.workspace_id,
        row.channel_id,
      );
      const what = row.kind === 'export' ? 'a copy of the data' : 'deletion of the data';
      const paragraphs =
        row.status === 'rejected'
          ? [
              `We received a request for ${what} ${name} holds about this address. It was declined, and nothing was changed.`,
              'If you made the request and want to know why, or want to ask again, reply to this email.',
            ]
          : [
              `We received a request for ${what} ${name} holds about this address. We could not complete it yet.`,
              'The publisher has been told and will follow up. You do not need to do anything. If you hear nothing within a month, reply to this email.',
            ];
      const body = memberMail({
        channelName: name,
        accent,
        heading: row.status === 'rejected' ? 'Your data request' : 'Your data request is delayed',
        paragraphs,
        footnote: 'If you did not make this request, you can ignore this email.',
      });
      await deps.mail.send({
        category: 'privacy_outcome',
        from,
        to: email,
        replyTo: replyTo ?? from.address,
        subject: `Your data request to ${name}`,
        html: body.html,
        text: body.text,
        tags: { workspace: row.workspace_id },
      });
      result.people += 1;
    }
    // A rejected request needs its address no longer; a failed one keeps it for a retry.
    if (row.status === 'rejected') {
      await run(db, 'UPDATE dsr_requests SET email_enc = NULL WHERE id = ?1', row.id);
    }
  }

  const failed = await all<{ id: string; workspace_id: string; channel_id: string | null }>(
    db,
    `SELECT id, workspace_id, channel_id FROM dsr_requests
      WHERE status = 'failed' AND (admin_reminded_at IS NULL OR admin_reminded_at < ?1)
      ORDER BY updated_at LIMIT ${OUTCOME_BATCH}`,
    now - DSR_FAILED_REMINDER_DAYS * DAY_MS,
  );
  for (const row of failed) {
    const claimed = await first(
      db,
      `UPDATE dsr_requests SET admin_reminded_at = ?1
        WHERE id = ?2 AND status = 'failed' AND (admin_reminded_at IS NULL OR admin_reminded_at < ?3)
        RETURNING id`,
      now,
      row.id,
      now - DSR_FAILED_REMINDER_DAYS * DAY_MS,
    );
    if (!claimed) continue;
    const to = row.channel_id
      ? await channelAdminEmails(db, row.channel_id)
      : (
          await all<{ email: string }>(
            db,
            `SELECT DISTINCT o.email FROM operators o JOIN seats s ON s.operator_id = o.id
              WHERE s.workspace_id = ?1 AND s.role IN ('owner', 'admin') ORDER BY o.email LIMIT 50`,
            row.workspace_id,
          )
        ).map((r) => r.email);
    result.admins += await sendOperatorNotice(deps.notices, {
      to,
      subject: 'A data request failed and needs you',
      lines: [
        'A data request (a copy or a deletion) could not be completed. The person has been told it is delayed.',
        `Open the Privacy Center to see the error, then retry or reject it. You will be reminded every ${DSR_FAILED_REMINDER_DAYS} days until it is resolved.`,
        `${deps.appOrigin.replace(/\/$/, '')}/settings/privacy`,
      ],
      category: 'privacy_failed',
      tags: { workspace: row.workspace_id },
    });
  }
  return result;
}

/** Export files past their link's expiry are deleted; the request row stays for the queue. */
export async function purgeExpiredExports(
  db: D1Database,
  bucket: R2Bucket,
  now: number = Date.now(),
): Promise<number> {
  const expired = await all<{ id: string; export_key: string }>(
    db,
    `SELECT id, export_key FROM dsr_requests WHERE export_key IS NOT NULL AND export_expires_at <= ?1
      LIMIT 100`,
    now,
  );
  if (!expired.length) return 0;
  await bucket.delete(expired.map((r) => r.export_key));
  await run(
    db,
    'UPDATE dsr_requests SET export_key = NULL WHERE id IN (SELECT value FROM json_each(?1))',
    JSON.stringify(expired.map((r) => r.id)),
  );
  return expired.length;
}
