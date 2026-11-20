/**
 * Incremental exports to the operator's own R2 or S3 bucket (Phase 7, paid plans).
 *
 * CONTRACT
 * - `export_destinations.config_json` is ExportDestinationConfig (p7-privacy.ts);
 *   `credentials_enc` is `{w, d, accessKeyId, secretAccessKey}` as JSON sealed with FIELD_KEYS:
 *   `w` and `d` are the workspace and destination it was sealed for, so a value copied to another
 *   row doesn't open (like Copilot keys). Only the vault opens it: a run's requests are signed
 *   there (@swarm/vault signDestinationRequest) and the credentials never leave it; the vault's
 *   re-seal cron moves older values onto the current format.
 * - Each run writes JSON Lines objects under the prefix, in three streams, each following its own
 *   cursor in `cursor_json`:
 *     members/<updated_at, 13 digits>-<member id>.jsonl   Members changed since the last run
 *                                                          (by updated_at, then id), with tags
 *                                                          and the decrypted profile fields the
 *                                                          scope picks
 *     events/<seq, 12 digits>.jsonl                        new member_events
 *     deletions/<seq, 12 digits>.jsonl                     member.deleted (erasures), ids only;
 *                                                          `memberId` matches `id` in members/
 *   What is sent follows the destination's scope (`scope_json`, ExportScope in p7-privacy.ts). With
 *   members 'active', only subscribed Members get a full line; anyone else changed since the last
 *   run gets a reduced line (id, status and dates, `reduced: true`) so the copy learns of the
 *   departure, and events of people who are not subscribed are skipped. Only the fields the scope
 *   names are read and decrypted. Destinations from before scopes keep 'all' and 'all'.
 *   A member line carries `trackingOptOutAt` once the person objected to tracking, so a recipient
 *   can drop their earlier events. Objects already written are never deleted or rewritten (the
 *   credentials allow writes only); an erasure lists the destinations that may still hold earlier
 *   copies on its request (privacy.ts). A deleted Channel's destinations don't run.
 *   An object's name is the cursor it starts from, so a retried run rewrites the same objects.
 *   The cursor moves after each object is written. Rows newer than EXPORT_SETTLE_MS are left for
 *   the next run.
 * - A failed run sets `failing` with the error and is retried on the next due run; a success sets
 *   `active` again. Paused destinations are skipped.
 */
import {
  EXPORT_SETTLE_MS,
  type ExportScope,
  type ExportDestinationConfig,
  type ExportDestinationTest,
  type FieldValue,
} from '@swarm/domain';
import { sha256Hex } from '@swarm/db';
import { signRequest } from '@swarm/mail';
import type { Keyring } from '@swarm/tokens';
import { FEED_AUTHORITY_SQL } from './feed-authority';
import { all, first, run, toIso } from './db';
import { decrypt, encrypt } from './fields';
import { channelFields, readFieldValues } from './members';
import { outboundUrlProblem } from './outbound-url';

export interface ExportCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/** An object request for the vault to sign with a destination's stored keys. */
export interface DestinationObjectRequest {
  method: 'PUT' | 'DELETE';
  key: string;
  contentSha256: string;
  contentType?: string;
}

/** Signs an object request with the stored keys (the vault): the URL and the headers to send. */
export type DestinationSigner = (
  request: DestinationObjectRequest,
) => Promise<{ url: string; headers: [string, string][] }>;

/**
 * Where objects go: with the keys at hand (a connection test of keys just typed), or signed by
 * the vault with the stored ones.
 */
export type ExportTarget = ExportDestinationConfig &
  (ExportCredentials | { sign: DestinationSigner });

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

/** The cursor in export_destinations.cursor_json. */
export interface ExportCursor {
  /** updated_at (ms) and id of the last Member written. */
  members?: number;
  membersId?: string;
  /** member_events.seq of the last event written. */
  events?: number;
  /** platform_events.seq of the last member.deleted written. */
  deletions?: number;
}

const CHUNK = 1000;
const MAX_OBJECTS_PER_STREAM = 10;
const SCHEDULE_MS = { hourly: 3_600_000, daily: 86_400_000 } as const;
/** The 5-minute cron fires a little after the hour; a run this early still counts as due. */
const DUE_SLACK_MS = 5 * 60_000;

/** The row a sealed value belongs to. */
export interface CredentialsOwner {
  workspaceId: string;
  destinationId: string;
}

/** Sealed with FIELD_KEYS together with its workspace and destination. */
export const sealCredentials = (
  keys: Keyring,
  owner: CredentialsOwner,
  credentials: ExportCredentials,
) =>
  encrypt(
    keys,
    JSON.stringify({
      w: owner.workspaceId,
      d: owner.destinationId,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    }),
  );

export interface OpenedCredentials extends ExportCredentials {
  /** Sealed before values were bound to their row: seal it again with `sealCredentials`. */
  legacy: boolean;
}

/**
 * The credentials, or null when the value can't be opened or was sealed for another workspace or
 * destination. A value from before binding (no `w`) still opens, marked `legacy`.
 */
export async function openCredentials(
  keys: Keyring,
  owner: CredentialsOwner,
  sealed: string,
): Promise<OpenedCredentials | null> {
  const plain = await decrypt(keys, sealed);
  if (!plain) return null;
  let value: Partial<ExportCredentials> & { w?: unknown; d?: unknown };
  try {
    value = JSON.parse(plain) as typeof value;
  } catch {
    return null;
  }
  if (!value.accessKeyId || !value.secretAccessKey) return null;
  const legacy = value.w === undefined && value.d === undefined;
  if (!legacy && (value.w !== owner.workspaceId || value.d !== owner.destinationId)) return null;
  return { accessKeyId: value.accessKeyId, secretAccessKey: value.secretAccessKey, legacy };
}

/** Virtual-hosted style on AWS (path style for dotted bucket names); path style elsewhere. */
export function objectUrl(target: ExportDestinationConfig, key: string): string {
  const path = key.split('/').map(encodeURIComponent).join('/');
  if (target.endpoint) return `${target.endpoint.replace(/\/$/, '')}/${target.bucket}/${path}`;
  return target.bucket.includes('.')
    ? `https://s3.${target.region}.amazonaws.com/${target.bucket}/${path}`
    : `https://${target.bucket}.s3.${target.region}.amazonaws.com/${path}`;
}

export class ExportTargetError extends Error {}

/**
 * One signed S3 API call on an object. The URL is checked again here, so a row saved before (or
 * around) the save-time check never reaches a private host, and a redirect is never followed: it
 * would resend the signed headers to wherever the Location points.
 */
export async function s3Object(
  target: ExportTarget,
  method: 'PUT' | 'DELETE',
  key: string,
  body: string | undefined,
  fetcher: Fetcher,
): Promise<Response> {
  let url = objectUrl(target, key);
  if (outboundUrlProblem(url)) {
    throw new ExportTargetError('The endpoint is not a public https endpoint. Change it and save.');
  }
  const contentSha256 = await sha256Hex(body ?? '');
  const headers: Record<string, string> = { 'x-amz-content-sha256': contentSha256 };
  if (body !== undefined) headers['content-type'] = 'application/x-ndjson';
  let signed: Record<string, string>;
  if ('sign' in target) {
    const answer = await target.sign({
      method,
      key,
      contentSha256,
      ...(body !== undefined ? { contentType: 'application/x-ndjson' } : {}),
    });
    url = answer.url;
    if (outboundUrlProblem(url)) {
      throw new ExportTargetError(
        'The endpoint is not a public https endpoint. Change it and save.',
      );
    }
    signed = Object.fromEntries(answer.headers);
  } else {
    signed = await signRequest({
      method,
      url,
      headers,
      ...(body !== undefined ? { body } : {}),
      service: 's3',
      region: target.region,
      credentials: { accessKeyId: target.accessKeyId, secretAccessKey: target.secretAccessKey },
    });
  }
  const res = await fetcher(url, {
    method,
    headers: signed,
    redirect: 'manual',
    ...(body !== undefined ? { body } : {}),
  });
  if (res.status >= 300 && res.status < 400) {
    throw new ExportTargetError(
      `The bucket answered with a redirect (HTTP ${res.status}), which Swarm does not follow. Use the bucket's own regional endpoint.`,
    );
  }
  return res;
}

/** The S3 error code and message from an XML error body, for the operator. */
async function s3Problem(res: Response): Promise<string> {
  const text = (await res.text().catch(() => '')).slice(0, 2000);
  const code = /<Code>([^<]{1,80})<\/Code>/.exec(text)?.[1];
  const message = /<Message>([^<]{1,200})<\/Message>/.exec(text)?.[1];
  return [`HTTP ${res.status}`, code, message].filter(Boolean).join(': ');
}

async function put(target: ExportTarget, key: string, body: string, fetcher: Fetcher) {
  let res: Response;
  try {
    res = await s3Object(target, 'PUT', key, body, fetcher);
  } catch (error) {
    if (error instanceof ExportTargetError) throw error;
    throw new ExportTargetError(`The bucket could not be reached: ${(error as Error).message}`);
  }
  if (!res.ok) throw new ExportTargetError(`Writing ${key} failed (${await s3Problem(res)})`);
}

/** "Test connection": writes a small object under the prefix, then deletes it. */
export async function testExportTarget(
  target: ExportTarget,
  fetcher: Fetcher,
  now: number = Date.now(),
): Promise<ExportDestinationTest> {
  const key = `${target.prefix}swarm-connection-test-${now}.txt`;
  let res: Response;
  try {
    res = await s3Object(target, 'PUT', key, 'Swarm connection test. Safe to delete.\n', fetcher);
  } catch (error) {
    return {
      ok: false,
      status: null,
      message:
        error instanceof ExportTargetError
          ? error.message
          : `The bucket could not be reached: ${(error as Error).message}`,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: `Writing a test file failed (${await s3Problem(res)}).`,
    };
  }
  const removed = await s3Object(target, 'DELETE', key, undefined, fetcher).catch(() => null);
  if (!removed?.ok) {
    return {
      ok: false,
      status: removed?.status ?? null,
      message: `Swarm could write but not delete ${key}. Deleting is not required for exports; check the key’s permissions.`,
    };
  }
  return { ok: true, status: res.status, message: 'Swarm wrote and deleted a test file.' };
}

// ---- Runs -----------------------------------------------------------------------------------

/** The Channel's fields the scope includes. */
function scopedFields<T>(all: Map<string, T>, scope: ExportScope): Map<string, T> {
  if (scope.fields === 'all') return all;
  const picked = new Set(scope.fields);
  return new Map([...all].filter(([key]) => picked.has(key)));
}

export interface DestinationRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  config_json: string;
  credentials_enc: string;
  schedule: 'hourly' | 'daily';
  cursor_json: string;
  status: 'active' | 'paused' | 'failing';
  failure_count: number;
  scope_json: string;
}

export const DESTINATION_COLUMNS =
  'id, workspace_id, channel_id, config_json, credentials_enc, schedule, cursor_json, status, failure_count, scope_json';

/**
 * The jobs worker's vault, for a destination's runs: its encrypted fields and its signed
 * requests, each with the destination as the authority. Both throw when the vault can't answer.
 */
export interface ExportVault {
  fields(
    destination: { id: string; channelId: string },
    memberIds: string[],
  ): Promise<Record<string, Record<string, FieldValue>>>;
  sign(destinationId: string, request: DestinationObjectRequest): ReturnType<DestinationSigner>;
}

export interface ExportRunDeps {
  db: D1Database;
  vault: ExportVault;
  fetch: Fetcher;
}

interface MemberLine {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  status: string;
  digest: string;
  source_json: string;
  tags_json: string;
  created_at: number;
  updated_at: number;
  consent_at: number | null;
  confirmed_at: number | null;
  unsubscribed_at: number | null;
  tracking_opt_out_at: number | null;
}

const iso = (ms: number | null) => (ms === null ? null : toIso(ms));
const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** Writes what changed since the cursor. Returns the number of objects written. */
export async function runExportDestination(
  deps: ExportRunDeps,
  row: DestinationRow,
  now: number = Date.now(),
): Promise<number> {
  const config = JSON.parse(row.config_json) as ExportDestinationConfig;
  const target: ExportTarget = {
    ...config,
    sign: (request) => deps.vault.sign(row.id, request),
  };
  const cursor = JSON.parse(row.cursor_json) as ExportCursor;
  const settled = now - EXPORT_SETTLE_MS;
  const save = () =>
    run(
      deps.db,
      'UPDATE export_destinations SET cursor_json = ?1 WHERE id = ?2',
      JSON.stringify(cursor),
      row.id,
    );
  let written = 0;
  const scope = JSON.parse(row.scope_json) as ExportScope;
  const everyone = scope.members === 'all';
  let fields: Awaited<ReturnType<typeof channelFields>> | null = null;

  for (let n = 0; n < MAX_OBJECTS_PER_STREAM; n++) {
    const at = cursor.members ?? 0;
    const afterId = cursor.membersId ?? '';
    const members = await all<MemberLine>(
      deps.db,
      `SELECT m.id, m.email, m.first_name, m.last_name, m.status, m.digest, m.source_json, m.created_at,
              m.updated_at, m.consent_at, m.confirmed_at, m.unsubscribed_at, m.tracking_opt_out_at,
              (SELECT json_group_array(t.name) FROM member_tags mt JOIN tags t ON t.id = mt.tag_id
                WHERE mt.member_id = m.id) AS tags_json
         FROM members m
        WHERE m.channel_id = ?1 AND m.updated_at <= ?2
          AND (m.updated_at > ?3 OR (m.updated_at = ?3 AND m.id > ?4))
        ORDER BY m.updated_at, m.id LIMIT ?5`,
      row.channel_id,
      settled,
      at,
      afterId,
      CHUNK,
    );
    if (!members.length) break;
    fields ??= scopedFields(await channelFields(deps.db, row.channel_id), scope);
    const full = members.filter((m) => everyone || m.status === 'active');
    const destination = { id: row.id, channelId: row.channel_id };
    const values: Map<string, Record<string, FieldValue>> = fields.size
      ? await readFieldValues(
          deps.db,
          full.map((m) => m.id),
          fields,
          { open: (ids) => deps.vault.fields(destination, ids) },
        )
      : new Map();
    const body = members
      .map((m) =>
        !everyone && m.status !== 'active'
          ? // Not (or no longer) subscribed: enough to drop or mark them, nothing about who they are.
            `${JSON.stringify({
              id: m.id,
              status: m.status,
              reduced: true,
              updatedAt: iso(m.updated_at),
              unsubscribedAt: iso(m.unsubscribed_at),
              trackingOptOutAt: iso(m.tracking_opt_out_at),
            })}\n`
          : `${JSON.stringify({
              id: m.id,
              email: m.email,
              firstName: m.first_name,
              lastName: m.last_name,
              status: m.status,
              digest: m.digest,
              tags: (JSON.parse(m.tags_json) as string[]).sort(),
              source: JSON.parse(m.source_json) as unknown,
              fields: values.get(m.id) ?? {},
              createdAt: iso(m.created_at),
              updatedAt: iso(m.updated_at),
              consentAt: iso(m.consent_at),
              confirmedAt: iso(m.confirmed_at),
              unsubscribedAt: iso(m.unsubscribed_at),
              // The person objected to open and click tracking: their earlier opens and clicks (in
              // events/ objects) should go too. Matched to them by `id`, like deletions/ lines.
              trackingOptOutAt: iso(m.tracking_opt_out_at),
            })}\n`,
      )
      .join('');
    await put(
      target,
      `${config.prefix}members/${pad(at, 13)}-${afterId || '0'}.jsonl`,
      body,
      deps.fetch,
    );
    const last = members.at(-1) as MemberLine;
    cursor.members = last.updated_at;
    cursor.membersId = last.id;
    await save();
    written++;
  }

  for (let n = 0; n < MAX_OBJECTS_PER_STREAM; n++) {
    const from = cursor.events ?? 0;
    const events = await all<{
      seq: number;
      member_id: string;
      type: string;
      payload_json: string;
      created_at: number;
    }>(
      deps.db,
      `SELECT seq, member_id, type, payload_json, created_at FROM member_events e
        WHERE channel_id = ?1 AND seq > ?2 AND created_at <= ?3
          AND (?5 = 1 OR EXISTS (SELECT 1 FROM members m WHERE m.id = e.member_id AND m.status = 'active'))
        ORDER BY seq LIMIT ?4`,
      row.channel_id,
      from,
      settled,
      CHUNK,
      everyone ? 1 : 0,
    );
    if (!events.length) break;
    const body = events
      .map(
        (e) =>
          `${JSON.stringify({
            seq: e.seq,
            memberId: e.member_id,
            type: e.type,
            payload: JSON.parse(e.payload_json) as unknown,
            createdAt: toIso(e.created_at),
          })}\n`,
      )
      .join('');
    await put(target, `${config.prefix}events/${pad(from, 12)}.jsonl`, body, deps.fetch);
    cursor.events = (events.at(-1) as { seq: number }).seq;
    await save();
    written++;
  }

  for (let n = 0; n < MAX_OBJECTS_PER_STREAM; n++) {
    const from = cursor.deletions ?? 0;
    const deletions = await all<{ seq: number; member_id: string; created_at: number }>(
      deps.db,
      `SELECT seq, member_id, created_at FROM platform_events
        WHERE channel_id = ?1 AND type = 'member.deleted' AND seq > ?2 ORDER BY seq LIMIT ?3`,
      row.channel_id,
      from,
      CHUNK,
    );
    if (!deletions.length) break;
    const body = deletions
      .map(
        (d) =>
          `${JSON.stringify({ seq: d.seq, memberId: d.member_id, deletedAt: toIso(d.created_at) })}\n`,
      )
      .join('');
    await put(target, `${config.prefix}deletions/${pad(from, 12)}.jsonl`, body, deps.fetch);
    cursor.deletions = (deletions.at(-1) as { seq: number }).seq;
    await save();
    written++;
  }
  return written;
}

export interface ExportRunOutcome {
  id: string;
  workspaceId: string;
  ok: boolean;
  objects: number;
  /** Set when this failure reached the notify threshold. */
  failureCount: number;
  error: string | null;
}

/** Destinations whose schedule is due (or that failed last time), a bounded batch per call. */
export async function runDueExportDestinations(
  deps: ExportRunDeps,
  now: number = Date.now(),
  limit = 10,
): Promise<ExportRunOutcome[]> {
  const due = await all<DestinationRow>(
    deps.db,
    `SELECT ${DESTINATION_COLUMNS} FROM export_destinations f
      WHERE status IN ('active', 'failing')
        -- Only while someone with current authority stands behind it (feed-authority.ts). That
        -- includes a live Channel, so a deleted publication's subscribers stop flowing out while
        -- it can still be restored.
        AND ${FEED_AUTHORITY_SQL('export_destination')}
        AND (last_run_at IS NULL
             OR last_run_at + (CASE schedule WHEN 'hourly' THEN ?1 ELSE ?2 END) <= ?3 + ?4)
      ORDER BY last_run_at IS NOT NULL, last_run_at LIMIT ?5`,
    SCHEDULE_MS.hourly,
    SCHEDULE_MS.daily,
    now,
    DUE_SLACK_MS,
    limit,
  );
  const outcomes: ExportRunOutcome[] = [];
  for (const row of due) {
    try {
      const objects = await runExportDestination(deps, row, now);
      await run(
        deps.db,
        `UPDATE export_destinations SET status = CASE WHEN status = 'paused' THEN status ELSE 'active' END,
            last_run_at = ?1, last_error = NULL, failure_count = 0 WHERE id = ?2`,
        now,
        row.id,
      );
      outcomes.push({
        id: row.id,
        workspaceId: row.workspace_id,
        ok: true,
        objects,
        failureCount: 0,
        error: null,
      });
    } catch (error) {
      const message = (error as Error).message.slice(0, 500);
      const updated = await first<{ failure_count: number }>(
        deps.db,
        `UPDATE export_destinations SET status = CASE WHEN status = 'paused' THEN status ELSE 'failing' END,
            last_run_at = ?1, last_error = ?2, failure_count = failure_count + 1
          WHERE id = ?3 RETURNING failure_count`,
        now,
        message,
        row.id,
      );
      outcomes.push({
        id: row.id,
        workspaceId: row.workspace_id,
        ok: false,
        objects: 0,
        failureCount: updated?.failure_count ?? row.failure_count + 1,
        error: message,
      });
    }
  }
  return outcomes;
}
