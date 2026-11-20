// Privacy Center: the data-request queue (Phase 7). Admins and owners of a workspace see every
// export and erasure request with its SLA timer, file one on behalf of a person who asked by
// other means, and approve, reject or retry. Member Center requests from a verified link run
// without approval; an erasure from a link that proves nothing (source `member_center_unverified`,
// a footer link that may have been forwarded) and operator requests wait for an approval, and
// approving an erasure needs the explicit confirmation "erase". The jobs worker runs approved
// requests (@swarm/engine privacy.ts). A finished export can also be downloaded here, for a person
// whose address can't receive the emailed link (bounced, complained). Every change and download is
// audited, never with the address.
import { createRoute, z } from '@hono/zod-openapi';
import { all, first, toIso } from '@swarm/db';
import {
  ApproveDsrRequestSchema,
  CreateDsrRequestSchema,
  DsrListQuerySchema,
  DsrRequestSchema,
  ERASE_CONFIRMATION,
  RejectDsrRequestSchema,
  idPattern,
  page,
  type DsrKind,
  type DsrRequest,
  type DsrSource,
  type DsrStatus,
} from '@swarm/domain';
import {
  createDsrRequest,
  exportDownload,
  hasLivePaidSubscription,
  markerLabel,
  markerSalt,
  openDsrRequest,
  teammateEmailSql,
} from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireWorkspace } from '../lib/access';
import { appendAudit } from '../lib/audit';
import { clientIp, createRouter, env, type AppContext } from '../lib/context';
import { privacyVault, requestVault } from '../lib/vault';
import { ipPrefix } from '../lib/crypto';
import { errors, idParam, jsonBody, ok } from '../lib/openapi';

export const privacy = createRouter();

const workspaceParam = idParam('workspaceId', idPattern('workspace'));
const requestParams = workspaceParam.extend(idParam('requestId', idPattern('dsrRequest')).shape);

interface RequestRow {
  id: string;
  workspace_id: string;
  channel_id: string | null;
  member_id: string | null;
  member_email: string | null;
  member_channel_id: string | null;
  email_hash: string;
  kind: DsrKind;
  source: DsrSource;
  status: DsrStatus;
  due_at: number;
  note: string | null;
  handled_by: string | null;
  handler_email: string | null;
  error: string | null;
  attempts: number;
  export_expires_at: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

const SELECT = `SELECT r.id, r.workspace_id, r.channel_id, r.member_id, m.email AS member_email,
         m.channel_id AS member_channel_id, r.email_hash, r.kind, r.source, r.status, r.due_at, r.note,
         r.handled_by, ${teammateEmailSql('o', 'r.workspace_id')} AS handler_email, r.error, r.attempts, r.export_expires_at, r.created_at,
         r.updated_at, r.completed_at
    FROM dsr_requests r
    LEFT JOIN members m ON m.id = r.member_id
    LEFT JOIN operators o ON o.id = r.handled_by`;

const OPEN: DsrStatus[] = ['pending', 'processing'];

async function toRequest(
  c: AppContext,
  row: RequestRow,
  now: number,
  salt?: string,
): Promise<DsrRequest> {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    kind: row.kind,
    source: row.source,
    status: row.status,
    member:
      row.member_id && row.member_email && row.member_channel_id
        ? { id: row.member_id, email: row.member_email, channelId: row.member_channel_id }
        : null,
    // A short label of the workspace-keyed marker, never the full value (privacy.ts markerLabel).
    emailHash: await markerLabel(env(c).DB, row.workspace_id, row.email_hash, salt),
    dueAt: toIso(row.due_at),
    overdue: OPEN.includes(row.status) && row.due_at < now,
    note: row.note,
    handledBy:
      row.handled_by && row.handler_email ? { id: row.handled_by, email: row.handler_email } : null,
    error: row.error,
    attempts: row.attempts,
    exportExpiresAt: row.export_expires_at === null ? null : toIso(row.export_expires_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    completedAt: row.completed_at === null ? null : toIso(row.completed_at),
  };
}

/** The request, in this workspace; 404 otherwise (other workspaces' ids are never confirmed). */
async function loadRequest(c: AppContext, workspaceId: string, requestId: string) {
  const row = await first<RequestRow>(
    env(c).DB,
    `${SELECT} WHERE r.id = ?1 AND r.workspace_id = ?2`,
    requestId,
    workspaceId,
  );
  if (!row) throw new ApiError('not_found', 'Request not found.');
  return row;
}

privacy.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/privacy/requests',
    tags: ['Privacy Center'],
    summary: 'The data-request queue, newest first',
    description:
      'Export and erasure requests with their SLA (`dueAt`; `overdue` while still open past it). Filter by status or kind. Admins and owners only.',
    request: { params: workspaceParam, query: DsrListQuerySchema },
    responses: {
      200: ok(page(DsrRequestSchema), 'Requests'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const { cursor, limit, status, kind } = c.req.valid('query');
    await requireWorkspace(c, workspaceId, 'admin');
    if (cursor && !idPattern('dsrRequest').test(cursor)) {
      throw new ApiError('invalid_input', 'That page cursor is not valid.');
    }
    const rows = await all<RequestRow>(
      env(c).DB,
      `${SELECT} WHERE r.workspace_id = ?1 AND (?2 IS NULL OR r.id < ?2)
          AND (?3 IS NULL OR r.status = ?3) AND (?4 IS NULL OR r.kind = ?4)
        ORDER BY r.id DESC LIMIT ?5`,
      workspaceId,
      cursor ?? null,
      status ?? null,
      kind ?? null,
      limit + 1,
    );
    const now = Date.now();
    const salt = await markerSalt(env(c).DB, workspaceId);
    const items = await Promise.all(
      rows.slice(0, limit).map((row) => toRequest(c, row, now, salt)),
    );
    const nextCursor = rows.length > limit ? (items.at(-1)?.id ?? null) : null;
    return c.json({ data: { items, nextCursor } }, 200);
  },
);

privacy.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/privacy/requests/{requestId}',
    tags: ['Privacy Center'],
    summary: 'One data request',
    request: { params: requestParams },
    responses: {
      200: ok(DsrRequestSchema, 'Request'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId, requestId } = c.req.valid('param');
    await requireWorkspace(c, workspaceId, 'admin');
    return c.json(
      { data: await toRequest(c, await loadRequest(c, workspaceId, requestId), Date.now()) },
      200,
    );
  },
);

privacy.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/workspaces/{workspaceId}/privacy/requests',
    tags: ['Privacy Center'],
    summary: 'File a data request on behalf of a person',
    description:
      'For someone who asked by email or another channel. It covers every Member with the address in the workspace and every row that holds the address without a Member (orders, Gift Passes, checkouts, trial claims, sponsor bookings, bounce and check results), and waits for an approval. The address needs no Member: no subscriber is created, and the answer is the same whether or not the workspace holds anything for it. Check who is asking before you file. One open request per kind and address (409). Admins and owners only.',
    request: { params: workspaceParam, body: jsonBody(CreateDsrRequestSchema) },
    responses: {
      201: ok(DsrRequestSchema, 'Filed'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireWorkspace(c, workspaceId, 'admin');
    const e = env(c);
    if (input.channelId) {
      const channel = await first(
        e.DB,
        'SELECT 1 FROM channels WHERE id = ?1 AND workspace_id = ?2',
        input.channelId,
        workspaceId,
      );
      if (!channel) throw new ApiError('not_found', 'Publication not found.');
    }
    const member = await first<{ id: string; channel_id: string }>(
      e.DB,
      `SELECT m.id, m.channel_id FROM members m JOIN channels c ON c.id = m.channel_id
        WHERE c.workspace_id = ?1 AND m.email = ?2 AND (?3 IS NULL OR m.channel_id = ?3)
        ORDER BY m.channel_id = ?3 DESC, m.created_at LIMIT 1`,
      workspaceId,
      input.email,
      input.channelId ?? null,
    );
    // No Member is needed: a buyer, gift recipient or sponsor contact who never subscribed, or a
    // subscriber an operator already deleted, can still get a copy or a deletion.
    if (await openDsrRequest(e.DB, workspaceId, input.email, input.kind, privacyVault(c))) {
      throw new ApiError('conflict', `An ${input.kind} request for that address is already open.`);
    }
    const now = Date.now();
    // The address is sealed by the vault for this request (admin, checked there too).
    const id = await createDsrRequest(
      e.DB,
      requestVault(c),
      {
        workspaceId,
        channelId: input.channelId ?? member?.channel_id ?? null,
        memberId: member?.id ?? null,
        email: input.email,
        kind: input.kind,
        source: 'operator',
        status: 'pending',
        note: input.note || null,
        handledBy: access.auth.operatorId,
      },
      now,
    );
    await appendAudit(e.DB, {
      workspaceId,
      actorId: access.auth.operatorId,
      action: 'privacy.request_created',
      targetType: 'dsr_request',
      targetId: id,
      metadata: { kind: input.kind },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.json({ data: await toRequest(c, await loadRequest(c, workspaceId, id), now) }, 201);
  },
);

privacy.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/workspaces/{workspaceId}/privacy/requests/{requestId}/approve',
    tags: ['Privacy Center'],
    summary: 'Approve a pending request',
    description:
      'The jobs worker then runs it, usually within a minute. An erasure cannot be undone, so approving one needs `confirm: "erase"`, and is refused (409) while the person still has a Stripe subscription that renews: cancel it first.',
    request: { params: requestParams, body: jsonBody(ApproveDsrRequestSchema) },
    responses: {
      200: ok(DsrRequestSchema, 'Approved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { workspaceId, requestId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireWorkspace(c, workspaceId, 'admin');
    const e = env(c);
    const row = await loadRequest(c, workspaceId, requestId);
    if (row.status !== 'pending') {
      throw new ApiError('conflict', 'Only a pending request can be approved.');
    }
    if (row.kind === 'erase') {
      if (input.confirm !== ERASE_CONFIRMATION) {
        throw new ApiError('invalid_input', 'Erasure cannot be undone. Confirm it to continue.', [
          { path: 'confirm', message: 'Type erase to confirm.' },
        ]);
      }
      if (
        row.member_email &&
        (await hasLivePaidSubscription(e.DB, workspaceId, row.member_email))
      ) {
        throw new ApiError(
          'conflict',
          'This person still has a paid subscription that renews. Cancel it in Stripe first.',
        );
      }
    }
    const now = Date.now();
    const updated = await first(
      e.DB,
      `UPDATE dsr_requests SET status = 'processing', note = coalesce(?1, note), handled_by = ?2,
          attempts = 0, error = NULL, updated_at = ?3
        WHERE id = ?4 AND status = 'pending' RETURNING id`,
      input.note || null,
      access.auth.operatorId,
      now,
      requestId,
    );
    if (!updated) throw new ApiError('conflict', 'Only a pending request can be approved.');
    await appendAudit(e.DB, {
      workspaceId,
      actorId: access.auth.operatorId,
      action: 'privacy.request_approved',
      targetType: 'dsr_request',
      targetId: requestId,
      metadata: { kind: row.kind },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.json(
      { data: await toRequest(c, await loadRequest(c, workspaceId, requestId), now) },
      200,
    );
  },
);

privacy.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/workspaces/{workspaceId}/privacy/requests/{requestId}/reject',
    tags: ['Privacy Center'],
    summary: 'Reject a pending request, with the reason',
    request: { params: requestParams, body: jsonBody(RejectDsrRequestSchema) },
    responses: {
      200: ok(DsrRequestSchema, 'Rejected'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { workspaceId, requestId } = c.req.valid('param');
    const { note } = c.req.valid('json');
    const access = await requireWorkspace(c, workspaceId, 'admin');
    const e = env(c);
    const row = await loadRequest(c, workspaceId, requestId);
    const now = Date.now();
    const updated = await first(
      e.DB,
      // The sealed address stays until the jobs worker has told the person (privacy.ts
      // sendRequestOutcomeNotices), which then clears it.
      `UPDATE dsr_requests SET status = 'rejected', note = ?1, handled_by = ?2,
          updated_at = ?3, completed_at = ?3
        WHERE id = ?4 AND status = 'pending' RETURNING id`,
      note,
      access.auth.operatorId,
      now,
      requestId,
    );
    if (!updated) throw new ApiError('conflict', 'Only a pending request can be rejected.');
    await appendAudit(e.DB, {
      workspaceId,
      actorId: access.auth.operatorId,
      action: 'privacy.request_rejected',
      targetType: 'dsr_request',
      targetId: requestId,
      metadata: { kind: row.kind },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.json(
      { data: await toRequest(c, await loadRequest(c, workspaceId, requestId), now) },
      200,
    );
  },
);

privacy.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/workspaces/{workspaceId}/privacy/requests/{requestId}/retry',
    tags: ['Privacy Center'],
    summary: 'Run a failed request again',
    request: { params: requestParams },
    responses: {
      200: ok(DsrRequestSchema, 'Queued again'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { workspaceId, requestId } = c.req.valid('param');
    const access = await requireWorkspace(c, workspaceId, 'admin');
    const e = env(c);
    const row = await loadRequest(c, workspaceId, requestId);
    const now = Date.now();
    const updated = await first(
      e.DB,
      `UPDATE dsr_requests SET status = 'processing', attempts = 0, claimed_until = NULL,
          handled_by = ?1, updated_at = ?2
        WHERE id = ?3 AND status = 'failed' RETURNING id`,
      access.auth.operatorId,
      now,
      requestId,
    );
    if (!updated) throw new ApiError('conflict', 'Only a failed request can be retried.');
    await appendAudit(e.DB, {
      workspaceId,
      actorId: access.auth.operatorId,
      action: 'privacy.request_retried',
      targetType: 'dsr_request',
      targetId: requestId,
      metadata: { kind: row.kind },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.json(
      { data: await toRequest(c, await loadRequest(c, workspaceId, requestId), now) },
      200,
    );
  },
);

privacy.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/workspaces/{workspaceId}/privacy/requests/{requestId}/download',
    tags: ['Privacy Center'],
    summary: 'Download a finished data export',
    description:
      'The same JSON file the person’s emailed link gives, while that link works, sent as a download. For an address that can’t receive email (bounced or complained) this is the only copy: the jobs worker does not mail it. A POST, because every download is audited.',
    request: { params: requestParams },
    responses: {
      200: {
        description: 'The file',
        content: {
          'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) },
        },
      },
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId, requestId } = c.req.valid('param');
    const access = await requireWorkspace(c, workspaceId, 'admin');
    const e = env(c);
    const row = await loadRequest(c, workspaceId, requestId);
    const download = row.kind === 'export' ? await exportDownload(e.DB, requestId) : null;
    const object = download ? await e.EXPORTS.get(download.key) : null;
    if (!download || !object) {
      throw new ApiError('not_found', 'This export is no longer available. File a new request.');
    }
    await appendAudit(e.DB, {
      workspaceId,
      actorId: access.auth.operatorId,
      action: 'privacy.export_downloaded',
      targetType: 'dsr_request',
      targetId: requestId,
      ipPrefix: ipPrefix(clientIp(c)),
    });
    const day = new Date(download.createdAt).toISOString().slice(0, 10);
    // Sent as a file to save, not JSON to read: the browser keeps it as data-request-<day>.json.
    return new Response(object.body, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="data-request-${day}.json"`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  },
);
