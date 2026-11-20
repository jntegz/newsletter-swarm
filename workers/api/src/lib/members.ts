// Member writes and the detail read, shared by the dashboard routes (routes/members.ts) and the
// public API (v2/members.ts): add, edit (with the member state machine), tags and delete.
import type { z } from '@hono/zod-openapi';
import { all, first, isUniqueViolation, run, toIso } from '@swarm/db';
import type { MemberListQuerySchema } from '@swarm/domain';
import {
  DEFAULT_PAUSE_DAYS,
  MAX_LIST_FIELDS,
  MAX_PAUSE_DAYS,
  idPattern,
  newId,
  type CreateMember,
  type Member,
  type MemberDetail,
  type MemberEngagement,
  type MemberJoinSource,
  type MemberListItem,
  type MemberPatch,
  type MemberSource,
  type MemberStatus,
} from '@swarm/domain';
import {
  leftAddresses,
  linksFor,
  mailAdapter,
  memberConsents,
  recordConsent,
  rememberLeftStatements,
  sendConfirmation,
  channelFields,
  engagementEnabled,
  ensureTags,
  fieldValueStatements,
  isErasedAddress,
  memberDeletedStatement,
  memberEventStatement,
  platformEventStatement,
  prepareFieldValues,
  readChecks,
  readEmailCheckSettings,
  readFieldValues,
  readMemberEngagement,
  tagRemovedEventStatement,
  tagStatements,
  type PreparedValue,
} from '@swarm/engine';
import { ApiError, createLogger } from '@swarm/runtime';
import { actorAudit, type Actor } from './actor';
import { fieldInputError, transitionRefusal } from './audience';
import { appendAudit } from './audit';
import { refreshCircles } from './circles';
import { env, type AppContext } from './context';
import { MEMBER_COLUMNS, toMember, type MemberRow } from './send';
import { memberFieldVault, privacyVault } from './vault';
import { requireFlag } from './site';

const DAY_MS = 86_400_000;
const log = createLogger({ service: 'api' });

/** The list filters; `circle` (the dashboard's list) keeps only Members of that Circle. */
type MemberListQuery = z.infer<typeof MemberListQuerySchema> & { circle?: string | undefined };

/** A LIKE pattern matching `q` anywhere, with the wildcards in `q` escaped (ESCAPE '!'). */
export const containsPattern = (q: string) => `%${q.replace(/[!%_]/g, (ch) => `!${ch}`)}%`;

/** One page of a Channel's Members, newest first; the cursor is the last id of a page. */
export async function listMembers(
  c: AppContext,
  channelId: string,
  query: MemberListQuery,
): Promise<{ items: MemberListItem[]; nextCursor: string | null }> {
  const { cursor, limit, status, tag, q, circle, emailCheck, emailCheckCode } = query;
  if (cursor && !idPattern('member').test(cursor)) {
    throw new ApiError('invalid_input', 'That page cursor is not valid.');
  }
  const workspaceId =
    (
      await first<{ workspace_id: string }>(
        env(c).DB,
        'SELECT workspace_id FROM channels WHERE id = ?1',
        channelId,
      )
    )?.workspace_id ?? '';
  const rows = await all<MemberRow>(
    env(c).DB,
    `SELECT ${MEMBER_COLUMNS} FROM members m
      WHERE m.channel_id = ?1 AND (?2 IS NULL OR m.id < ?2) AND (?3 IS NULL OR m.status = ?3)
        AND (?4 IS NULL OR m.email LIKE ?4 ESCAPE '!' OR m.first_name LIKE ?4 ESCAPE '!'
             OR m.last_name LIKE ?4 ESCAPE '!')
        AND (?5 IS NULL OR EXISTS (SELECT 1 FROM member_tags mt JOIN tags t ON t.id = mt.tag_id
                                    WHERE mt.member_id = m.id AND t.channel_id = ?1 AND t.name = ?5))
        AND (?7 IS NULL OR (?7 = 'unchecked') = NOT EXISTS (
              SELECT 1 FROM email_checks ec WHERE ec.workspace_id = ?9 AND ec.email = m.email
                 AND (?7 = 'unchecked' OR ec.state = ?7)))
        AND (?8 IS NULL OR EXISTS (SELECT 1 FROM email_checks ec
              WHERE ec.workspace_id = ?9 AND ec.email = m.email AND ec.code = ?8))
        AND (?10 IS NULL OR EXISTS (SELECT 1 FROM circle_members cm JOIN circles c ON c.id = cm.circle_id
                                    WHERE cm.member_id = m.id AND cm.circle_id = ?10
                                      AND c.channel_id = ?1 AND c.deleted_at IS NULL))
      ORDER BY m.id DESC LIMIT ?6`,
    channelId,
    cursor ?? null,
    status ?? null,
    q ? containsPattern(q) : null,
    tag ?? null,
    limit + 1,
    emailCheck ?? null,
    emailCheckCode ?? null,
    workspaceId,
    circle ?? null,
  );
  const page = rows.slice(0, limit).map(toMember);
  const nextCursor = rows.length > limit ? (page.at(-1)?.id ?? null) : null;
  const on = await engagementEnabled(env(c).DB, channelId);
  const scores = on
    ? await readMemberEngagement(
        env(c).DB,
        channelId,
        page.map((m) => m.id),
      )
    : new Map<string, MemberEngagement>();
  // Email checks (docs/email-verification.md): one result per address in the workspace.
  const checks = page.length
    ? await readChecks(
        env(c).DB,
        workspaceId,
        page.map((m) => m.email),
        (await readEmailCheckSettings(env(c).DB, workspaceId)).validMonths,
      )
    : new Map();
  const items = page.map((m) => ({
    ...m,
    engagement: scores.get(m.id) ?? null,
    emailCheck: checks.get(m.email.toLowerCase()) ?? null,
  }));
  return { items, nextCursor };
}

/**
 * Adds the asked-for profile field values to a page of Members (`keys` comma-separated). Encrypted
 * fields are decrypted, the same rule as the detail: any teammate with access to the Channel.
 */
export async function withFieldColumns(
  c: AppContext,
  channelId: string,
  result: { items: Member[]; nextCursor: string | null },
  keys: string,
): Promise<{ items: MemberListItem[]; nextCursor: string | null }> {
  const e = env(c);
  const wanted = [
    ...new Set(
      keys
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
    ),
  ];
  if (wanted.length > MAX_LIST_FIELDS) {
    throw new ApiError('invalid_input', `Show up to ${MAX_LIST_FIELDS} profile fields at once.`, [
      { path: 'fields', message: `Up to ${MAX_LIST_FIELDS} keys.` },
    ]);
  }
  const defined = await channelFields(e.DB, channelId);
  const unknown = wanted.find((k) => !defined.has(k));
  if (unknown) {
    throw new ApiError(
      'invalid_input',
      `There is no profile field "${unknown}" in this publication.`,
      [{ path: 'fields', message: `Unknown profile field "${unknown}".` }],
    );
  }
  const chosen = new Map(wanted.map((k) => [k, defined.get(k)!]));
  // Encrypted ones are opened by the vault under this request's credential; down: null, flagged.
  const vault = memberFieldVault(c, channelId);
  const values = await readFieldValues(
    e.DB,
    result.items.map((m) => m.id),
    chosen,
    vault,
  );
  return {
    items: result.items.map((m) => ({
      ...m,
      fields: values.get(m.id) ?? {},
      ...(vault.unavailableFor.has(m.id) ? { encryptedUnavailable: true } : {}),
    })),
    nextCursor: result.nextCursor,
  };
}

interface DetailRow extends MemberRow {
  source_json: string;
  form_id: string | null;
  referred_by: string | null;
  unsubscribe_reason: string | null;
  referral_count: number;
}

export async function memberDetail(c: AppContext, memberId: string): Promise<MemberDetail> {
  const e = env(c);
  const row = await first<DetailRow>(
    e.DB,
    `SELECT ${MEMBER_COLUMNS}, m.source_json, m.form_id, m.referred_by, m.unsubscribe_reason,
            (SELECT count(*) FROM referrals r WHERE r.referrer_id = m.id) AS referral_count
       FROM members m WHERE m.id = ?1`,
    memberId,
  );
  if (!row) throw new ApiError('not_found', 'Subscriber not found.');
  const fields = await channelFields(e.DB, row.channel_id);
  const vault = memberFieldVault(c, row.channel_id);
  const values = await readFieldValues(e.DB, [memberId], fields, vault);
  const paid = await first<{
    level_id: string | null;
    level_name: string | null;
    source: string;
    starts_at: number;
    expires_at: number | null;
  }>(
    e.DB,
    `SELECT me.level_id, l.name AS level_name, me.source, me.starts_at, me.expires_at
       FROM member_entitlements me LEFT JOIN membership_levels l ON l.id = me.level_id
      WHERE me.member_id = ?1 AND me.channel_id = ?2 AND me.kind = 'paid'
        AND (me.expires_at IS NULL OR me.expires_at > ?3)`,
    memberId,
    row.channel_id,
    Date.now(),
  );
  const scores = (await engagementEnabled(e.DB, row.channel_id))
    ? await readMemberEngagement(e.DB, row.channel_id, [memberId])
    : null;
  return {
    ...toMember(row),
    engagement: scores?.get(memberId) ?? null,
    source: JSON.parse(row.source_json) as MemberSource,
    consents: (await memberConsents(e.DB, memberId)).map((consent) => ({
      source: consent.source,
      formId: consent.form_id,
      formVersion: consent.form_version,
      wording: consent.wording,
      ticked: consent.ticked === null ? null : consent.ticked === 1,
      mustConfirm: consent.must_confirm === 1,
      attestedBy: consent.attested_by,
      verifiedHost: consent.verified_host,
      claimedOrigin: consent.claimed_origin,
      at: toIso(consent.created_at),
    })),
    formId: row.form_id,
    referredBy: row.referred_by,
    referralCount: row.referral_count,
    unsubscribeReason: row.unsubscribe_reason,
    fields: values.get(memberId) ?? {},
    ...(vault.unavailableFor.has(memberId) ? { encryptedUnavailable: true } : {}),
    membership: paid
      ? {
          levelId: paid.level_id,
          levelName: paid.level_name,
          source: paid.source,
          startsAt: toIso(paid.starts_at),
          expiresAt: paid.expires_at === null ? null : toIso(paid.expires_at),
        }
      : null,
  };
}

/**
 * Adds a Member. With `consent` they start active, otherwise pending and sent nothing until someone
 * asks. A Channel that requires confirmation is stricter: they always start pending and are emailed
 * a confirmation now. Tags by name (created when missing), fields by key. A Member with the same
 * address in this Channel answers 409.
 */
export async function createMember(
  c: AppContext,
  actor: Actor,
  channelId: string,
  input: CreateMember,
  source: Extract<MemberJoinSource, 'operator' | 'api'>,
  /**
   * For an agent's tool call (MCP or Copilot): who asserts the person's consent. Without a person
   * who approved the call, the agent's word alone doesn't make the Member active.
   */
  agent?: { credential: string; approvedBy: string | null },
): Promise<string> {
  const e = env(c);
  const now = Date.now();
  const id = newId('member', now);
  // Privacy Center (Phase 7): an erased address stays out, whichever surface adds it.
  if (await isErasedAddress(e.DB, actor.workspaceId, input.email, privacyVault(c))) {
    throw new ApiError(
      'conflict',
      'That address was erased at the person’s request and can’t be added again.',
    );
  }

  let values: PreparedValue[] = [];
  if (input.fields && Object.keys(input.fields).length) {
    const fields = await channelFields(e.DB, channelId);
    values = await prepareFieldValues(
      fields,
      input.fields,
      memberFieldVault(c, channelId),
      id,
    ).catch((error) => fieldInputError(error));
  }
  const tagIds = [...(await ensureTags(e.DB, channelId, input.tags ?? [], now)).values()];
  // Someone who unsubscribed and was then deleted comes back only through their own confirmation.
  const left = (await leftAddresses(e.DB, channelId, [input.email], privacyVault(c))).size > 0;
  const channel = await first<{ settings_json: string }>(
    e.DB,
    'SELECT settings_json FROM channels WHERE id = ?1',
    channelId,
  );
  const mustConfirm =
    (JSON.parse(channel?.settings_json ?? '{}') as { requireConfirmation?: unknown })
      .requireConfirmation === true;
  // An agent's `consent: true` counts only when a named person approved the call.
  const vouched = input.consent === true && (!agent || agent.approvedBy !== null);
  const active = vouched && !left && !mustConfirm;
  const status: MemberStatus = active ? 'active' : 'pending';
  try {
    await e.DB.batch([
      e.DB.prepare(
        `INSERT INTO members (id, channel_id, email, first_name, last_name, status, consent_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
      ).bind(
        id,
        channelId,
        input.email,
        input.firstName || null,
        input.lastName || null,
        status,
        active ? now : null,
        now,
      ),
      memberEventStatement(
        e.DB,
        { type: 'member_joined', memberId: id, payload: { source, status } },
        now,
      ),
      ...tagStatements(e.DB, id, tagIds, now),
      ...fieldValueStatements(e.DB, id, values, now),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError('conflict', 'That address is already a subscriber.');
    }
    throw error;
  }
  await appendAudit(
    e.DB,
    actorAudit(actor, {
      action: 'member.added',
      targetType: 'member',
      targetId: id,
      metadata: { channelId, status },
    }),
  );
  await recordConsent(
    e.DB,
    id,
    // `ticked` is the person adding them vouching that they asked; no wording was shown to the Member.
    // For an agent's call, `attestedBy` says who asserted it: the credential, and the operator
    // who approved the call when there was one (`<operator>+<credential>`).
    {
      source,
      ticked: input.consent === true,
      mustConfirm: status === 'pending',
      ...(agent
        ? {
            attestedBy: agent.approvedBy
              ? `${agent.approvedBy}+${agent.credential}`
              : agent.credential,
          }
        : {}),
    },
    now,
  );
  if (mustConfirm) {
    // The Member is added whatever happens to this mail; it can be sent again from their page.
    await sendConfirmation(
      {
        db: e.DB,
        mail: mailAdapter(e, e.PLATFORM_MAIL_DOMAIN),
        links: linksFor(e),
        captureOrigin: e.CAPTURE_ORIGIN.replace(/\/$/, ''),
        platformMailDomain: e.PLATFORM_MAIL_DOMAIN,
      },
      { memberId: id, kind: 'subscribe' },
    ).catch((error: unknown) => {
      log.error('confirmation for an added Member failed', {
        memberId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  refreshCircles(c, channelId);
  // Email checks: checked in the background, never in the way (docs/email-verification.md).
  if (e.DEBOUNCE_API_KEY) {
    await e.JOBS_QUEUE.send({
      type: 'email_check',
      workspaceId: actor.workspaceId,
      channelId,
      memberIds: [id],
    }).catch((error: unknown) =>
      log.warn('email check not queued', {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  return id;
}

type MemberChange = MemberPatch & {
  /** Tags to add without replacing the others (the public API's tag endpoints and upsert). */
  addTags?: string[];
  /** Tag names to remove. */
  removeTags?: string[];
};

/**
 * Edits a Member. Teammates (and API callers) can pause, resume or unsubscribe; they can't
 * confirm a pending Member, bring back an unsubscribed one, or change a bounced or complained
 * one: those answer 409. `tags` replaces the Member's tags; `addTags`/`removeTags` change some.
 */
export async function updateMember(
  c: AppContext,
  actor: Actor,
  memberId: string,
  input: MemberChange,
): Promise<void> {
  const e = env(c);
  const now = Date.now();
  const current = await first<{ status: MemberStatus; channel_id: string; workspace_id: string }>(
    e.DB,
    `SELECT m.status, m.channel_id, ch.workspace_id
       FROM members m JOIN channels ch ON ch.id = m.channel_id WHERE m.id = ?1`,
    memberId,
  );
  if (!current) throw new ApiError('not_found', 'Subscriber not found.');
  // Nothing sends digests yet, so the choice is refused unless the digest flag is on (as in the
  // Member Center), before anything is written.
  if (input.digest !== undefined) {
    await requireFlag(
      c,
      { workspaceId: current.workspace_id, channelId: current.channel_id },
      'digest',
      'Digest frequency is not turned on for this publication.',
    );
  }

  // Status first: a guarded update, so two teammates racing can't skip the state machine.
  const target = input.status ?? current.status;
  const pausing = target === 'paused';
  let pausedUntil: number | null = null;
  if (input.pausedUntil !== undefined && !pausing) {
    throw new ApiError('invalid_input', 'A pause date only goes with the paused status.');
  }
  if (pausing) {
    pausedUntil = input.pausedUntil
      ? Date.parse(input.pausedUntil)
      : now + DEFAULT_PAUSE_DAYS * DAY_MS;
    if (pausedUntil <= now || pausedUntil > now + MAX_PAUSE_DAYS * DAY_MS) {
      throw new ApiError('invalid_input', 'Pick a pause end within the next year.', [
        { path: 'pausedUntil', message: 'Pick a date within the next year.' },
      ]);
    }
  }
  if (target !== current.status) {
    const refusal = transitionRefusal(current.status, target);
    if (refusal) throw new ApiError('conflict', refusal);
    const moved = await first<{ id: string }>(
      e.DB,
      `UPDATE members SET status = ?1, updated_at = ?2,
              paused_until = ?3,
              unsubscribed_at = CASE WHEN ?1 = 'unsubscribed' THEN ?2 ELSE unsubscribed_at END
        WHERE id = ?4 AND status = ?5 RETURNING id`,
      target,
      now,
      pausedUntil,
      memberId,
      current.status,
    );
    if (!moved)
      throw new ApiError('conflict', 'This subscriber changed meanwhile. Reload and try again.');
  } else if (pausing && (input.pausedUntil !== undefined || input.status !== undefined)) {
    await run(
      e.DB,
      "UPDATE members SET paused_until = ?1, updated_at = ?2 WHERE id = ?3 AND status = 'paused'",
      pausedUntil,
      now,
      memberId,
    );
  }

  let values: PreparedValue[] = [];
  if (input.fields && Object.keys(input.fields).length) {
    const fields = await channelFields(e.DB, current.channel_id);
    values = await prepareFieldValues(
      fields,
      input.fields,
      memberFieldVault(c, current.channel_id),
      memberId,
    ).catch((error) => fieldInputError(error));
  }
  const statements: D1PreparedStatement[] = [];
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = ?${params.length}`);
  };
  if (input.firstName !== undefined) set('first_name', input.firstName || null);
  if (input.lastName !== undefined) set('last_name', input.lastName || null);
  if (input.digest !== undefined) set('digest', input.digest);
  if (sets.length) {
    set('updated_at', now);
    params.push(memberId);
    statements.push(
      e.DB.prepare(`UPDATE members SET ${sets.join(', ')} WHERE id = ?${params.length}`).bind(
        ...params,
      ),
    );
  }
  if (input.tags) {
    const tagIds = [...(await ensureTags(e.DB, current.channel_id, input.tags, now)).values()];
    statements.push(...tagStatements(e.DB, memberId, tagIds, now, true));
  }
  if (input.addTags?.length) {
    const tagIds = [...(await ensureTags(e.DB, current.channel_id, input.addTags, now)).values()];
    statements.push(...tagStatements(e.DB, memberId, tagIds, now));
  }
  if (input.removeTags?.length) {
    const names = JSON.stringify(input.removeTags.map((name) => name.toLowerCase()));
    const ids = (
      await e.DB.prepare(
        `SELECT id FROM tags WHERE channel_id = ?1 AND lower(name) IN (SELECT value FROM json_each(?2))`,
      )
        .bind(current.channel_id, names)
        .all<{ id: string }>()
    ).results.map((row) => row.id);
    if (ids.length) {
      statements.push(
        tagRemovedEventStatement(e.DB, memberId, ids, 'only', now),
        e.DB.prepare(
          'DELETE FROM member_tags WHERE member_id = ?1 AND tag_id IN (SELECT value FROM json_each(?2))',
        ).bind(memberId, JSON.stringify(ids)),
      );
    }
  }
  statements.push(...fieldValueStatements(e.DB, memberId, values, now));
  // Event Webhooks (Phase 7): tag and field changes arrive as member events; the rest here.
  const webhookEvent = (type: 'member.unsubscribed' | 'member.updated') =>
    platformEventStatement(
      e.DB,
      {
        type,
        workspaceId: actor.workspaceId,
        channelId: current.channel_id,
        memberId,
        payload: {},
      },
      now,
    );
  const statusMoved = target !== current.status;
  if (statusMoved && target === 'unsubscribed')
    statements.push(webhookEvent('member.unsubscribed'));
  if ((statusMoved && target !== 'unsubscribed') || sets.length) {
    statements.push(webhookEvent('member.updated'));
  }
  if (statements.length) await e.DB.batch(statements);

  await appendAudit(
    e.DB,
    actorAudit(actor, {
      action: 'member.updated',
      targetType: 'member',
      targetId: memberId,
      metadata: {
        changed: Object.keys(input).filter((k) => k !== 'fields'),
        fields: values.map((v) => v.field.key),
        ...(target !== current.status ? { from: current.status, to: target } : {}),
      },
    }),
  );
  refreshCircles(c, current.channel_id);
}

/**
 * Removes the Member. Their address is erased from delivery history (counts stay) and their
 * metered reads go. Rows that hold the address without a Member (suppressions, orders, checkouts,
 * Gift Passes, trial claims, email checks, bounce history) stay: a full erasure is a Privacy
 * Center request, which needs no Member, so it can still be filed afterwards.
 */
export async function deleteMember(
  c: AppContext,
  actor: Actor,
  memberId: string,
  channelId: string,
): Promise<void> {
  const e = env(c);
  const remember = await rememberLeftStatements(
    e.DB,
    channelId,
    [memberId],
    Date.now(),
    privacyVault(c),
  );
  await e.DB.batch([
    ...remember,
    // Event Webhooks (Phase 7): member.deleted, before the delete.
    memberDeletedStatement(e.DB, memberId),
    e.DB.prepare("UPDATE deliveries SET email = 'deleted' WHERE member_id = ?1").bind(memberId),
    // A signed-in reader's metered reads are keyed by their Member id, with no foreign key.
    e.DB.prepare('DELETE FROM gate_meter_reads WHERE reader_key = ?1').bind(memberId),
    e.DB.prepare('DELETE FROM members WHERE id = ?1').bind(memberId),
  ]);
  await appendAudit(
    e.DB,
    actorAudit(actor, { action: 'member.deleted', targetType: 'member', targetId: memberId }),
  );
  refreshCircles(c, channelId);
}
