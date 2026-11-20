// What an agent's tool call would do, for holding it and for showing and binding its approval
// (Open Operator and Copilot actions, docs/open-operator.md "What is held"). The engine decides
// body-only rules (bodyEffect); these are the rules that read stored state.
// - effectOf: a write is held like a destructive call when it would widen a post's web
//   visibility, or start a live Flow through a tag, field or Roster trigger.
// - targetOf: what a held call acts on as it is now (a Dispatch's subject, sender, audience and a
//   digest of its send fields; a Member's or feed source's state), stored on the approval.
// - targetChanged: on approval, whether a Dispatch's send fields changed since it was held.
import { canonicalJson, first, sha256Hex } from '@swarm/db';
import { THIRD_PARTY_TEXT_OPERATIONS } from '@swarm/domain';
import { toolName, type ApprovalRow, type AgentTool } from '@swarm/engine';
import type { ApiPrincipal } from '../v2/context';

/** The tools whose answers carry text from outside the workspace. */
const EXPOSING_TOOLS = JSON.stringify(Object.keys(THIRD_PARTY_TEXT_OPERATIONS).map(toolName));

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Who can read a post on the website, narrowest first. */
const WEB_REACH: Record<string, number> = { hidden: 0, paid: 1, members: 2, public: 3 };

/** The Flow start events a write can cause, by operation (and body field for updateMember). */
function flowTriggers(operationId: string, body: Json): string[] {
  switch (operationId) {
    case 'addMemberTags':
      return ['tag_added'];
    case 'setMemberFields':
      return ['field_changed'];
    case 'updateMember':
      return body.fields !== undefined ? ['field_changed'] : [];
    case 'subscribeRosterMember':
      return ['roster_joined'];
    default:
      return [];
  }
}

async function liveFlowListens(
  db: D1Database,
  channelId: string,
  types: string[],
): Promise<boolean> {
  const row = await first(
    db,
    `SELECT 1 FROM flows
      WHERE channel_id = ?1 AND status = 'live' AND deleted_at IS NULL AND live_version IS NOT NULL
        AND (trigger_type IN (SELECT value FROM json_each(?2)) OR EXISTS (
          SELECT 1 FROM json_each(coalesce(extra_trigger_types, '[]'))
           WHERE value IN (SELECT value FROM json_each(?2))))
      LIMIT 1`,
    channelId,
    JSON.stringify(types),
  );
  return !!row;
}

/**
 * When the workspace bounds exposed credentials (agent_settings.exposed_hold_minutes): whether
 * this key or grant read text from outside the workspace in that window. Copilot has its own,
 * stricter rule (any tool result), so it is not counted here.
 */
async function recentlyExposed(
  db: D1Database,
  principal: ApiPrincipal,
  now: number,
): Promise<number | null> {
  if (principal.kind === 'copilot') return null;
  const settings = await first<{ exposed_hold_minutes: number }>(
    db,
    'SELECT exposed_hold_minutes FROM agent_settings WHERE workspace_id = ?1',
    principal.workspaceId,
  );
  const minutes = settings?.exposed_hold_minutes ?? 0;
  if (minutes <= 0) return null;
  const read = await first(
    db,
    `SELECT 1 FROM agent_actions
      WHERE workspace_id = ?1 AND principal_id = ?2 AND outcome = 'ok' AND created_at > ?3
        AND tool IN (SELECT value FROM json_each(?4))
      LIMIT 1`,
    principal.workspaceId,
    principal.id,
    now - minutes * 60_000,
    EXPOSING_TOOLS,
  );
  return read ? minutes : null;
}

export const agentEffectOf =
  (db: D1Database, now: () => number = Date.now) =>
  async (principal: ApiPrincipal, tool: AgentTool, args: Json): Promise<string | null> => {
    const exposed = await recentlyExposed(db, principal, now());
    if (exposed !== null) {
      return `This credential read text from outside the workspace (Member or feed text) in the last ${exposed} minutes, so its changes wait for a person (this workspace’s setting).`;
    }
    const channelId = str(args.channelId);
    if (!channelId) return null;
    const body = isObject(args.body) ? args.body : {};
    if (tool.operationId === 'updateDispatch' && typeof body.webVisibility === 'string') {
      const row = await first<{ web_visibility: string }>(
        db,
        'SELECT web_visibility FROM dispatches WHERE id = ?1 AND channel_id = ?2',
        str(args.dispatchId),
        channelId,
      );
      const next = WEB_REACH[body.webVisibility];
      const now = row ? WEB_REACH[row.web_visibility] : undefined;
      if (next !== undefined && now !== undefined && next > now) {
        return `It widens who can read the post on the website (${row!.web_visibility} → ${body.webVisibility}).`;
      }
    }
    const triggers = flowTriggers(tool.operationId, body);
    if (triggers.length && (await liveFlowListens(db, channelId, triggers))) {
      return 'A live Flow of this publication starts on this change, so it can enrol the Member.';
    }
    return null;
  };

interface DispatchSnapshotRow {
  id: string;
  subject: string;
  preheader: string;
  content_json: string;
  cover_media_id: string | null;
  cover_alt: string;
  sender_identity_id: string | null;
  audience_json: string | null;
  status: string;
  web_visibility: string;
  from_name: string | null;
  from_local: string | null;
  domain: string | null;
}

/** The digest of what a Dispatch sends and to whom (the fields the scheduled lock covers). */
const sendDigest = (row: DispatchSnapshotRow) =>
  sha256Hex(
    canonicalJson({
      subject: row.subject,
      preheader: row.preheader,
      content: row.content_json,
      cover: [row.cover_media_id, row.cover_alt],
      sender: row.sender_identity_id,
      audience: row.audience_json,
    }),
  );

const dispatchRow = (db: D1Database, dispatchId: string, channelId: string) =>
  first<DispatchSnapshotRow>(
    db,
    `SELECT d.id, d.subject, d.preheader, d.content_json, d.cover_media_id, d.cover_alt,
            d.sender_identity_id, d.audience_json, d.status, d.web_visibility,
            s.from_name, s.from_local, sd.domain
       FROM dispatches d
       LEFT JOIN sender_identities s ON s.id = d.sender_identity_id
       LEFT JOIN sending_domains sd ON sd.id = s.sending_domain_id
      WHERE d.id = ?1 AND d.channel_id = ?2`,
    dispatchId,
    channelId,
  );

/**
 * What a held call acts on, as it is now. No personal data: a Member is its id and status, never
 * its address, so approvals don't become another copy of subscriber data.
 */
export const agentTargetOf =
  (db: D1Database) =>
  async (_principal: ApiPrincipal, _tool: AgentTool, args: Json): Promise<Json | null> => {
    const channelId = str(args.channelId);
    if (!channelId) return null;
    const dispatchId = str(args.dispatchId);
    if (dispatchId) {
      const row = await dispatchRow(db, dispatchId, channelId);
      if (!row) return null;
      let audience: unknown = null;
      try {
        audience = row.audience_json ? (JSON.parse(row.audience_json) as unknown) : null;
      } catch {
        audience = null;
      }
      return {
        type: 'dispatch',
        id: row.id,
        subject: row.subject,
        preheader: row.preheader,
        status: row.status,
        webVisibility: row.web_visibility,
        sender:
          row.from_name && row.from_local
            ? `${row.from_name} <${row.from_local}@${row.domain ?? '…'}>`
            : null,
        audience,
        sendDigest: await sendDigest(row),
      };
    }
    const memberId = str(args.memberId);
    if (memberId) {
      const row = await first<{ id: string; status: string }>(
        db,
        'SELECT id, status FROM members WHERE id = ?1 AND channel_id = ?2',
        memberId,
        channelId,
      );
      return row ? { type: 'member', id: row.id, status: row.status } : null;
    }
    const feedSourceId = str(args.feedSourceId);
    if (feedSourceId) {
      const row = await first<{ id: string; url: string; mode: string; status: string }>(
        db,
        'SELECT id, url, mode, status FROM feed_sources WHERE id = ?1 AND channel_id = ?2',
        feedSourceId,
        channelId,
      );
      return row
        ? { type: 'feed_source', id: row.id, url: row.url, mode: row.mode, status: row.status }
        : null;
    }
    return null;
  };

/** On approval: what changed in the held call's Dispatch since it was held, or null. */
export const agentTargetChanged =
  (db: D1Database) =>
  async (row: ApprovalRow): Promise<string | null> => {
    if (!row.target_json || !row.channel_id) return null;
    let held: Json;
    try {
      held = JSON.parse(row.target_json) as Json;
    } catch {
      return null;
    }
    if (held.type !== 'dispatch' || typeof held.id !== 'string') return null;
    const current = await dispatchRow(db, held.id, row.channel_id);
    if (!current) return null; // The route answers 404 itself.
    if ((await sendDigest(current)) === held.sendDigest) return null;
    return 'The post changed after this call was held (its subject, content, sender or audience). Nothing ran: ask for it again so the change gets its own decision.';
  };
