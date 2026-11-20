// Settings → Privacy: how long engagement history stays tied to a person (docs/privacy-controls.md).
// The jobs worker does the removing (packages/engine/src/retention.ts); this only reads and sets
// the workspace's choice. Admins and owners.
import { createRoute, z } from '@hono/zod-openapi';
import { all, first, run, toIso } from '@swarm/db';
import {
  EngagementRetentionSchema,
  FormerTeammateSchema,
  UpdateEngagementRetentionSchema,
  idPattern,
  type EngagementRetention,
  type FormerTeammate,
} from '@swarm/domain';
import { redactFormerTeammate, teammateEmailSql } from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireWorkspace } from '../lib/access';
import { appendAudit } from '../lib/audit';
import { clientIp, createRouter, env } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { errors, idParam, jsonBody, ok } from '../lib/openapi';

export const retention = createRouter();

const workspaceParam = idParam('workspaceId', idPattern('workspace'));

const read = async (db: D1Database, workspaceId: string): Promise<EngagementRetention> => {
  const row = await first<{
    months: EngagementRetention['months'];
    left: EngagementRetention['leftMemberMonths'];
    payment: EngagementRetention['paymentRecordYears'];
    audit: EngagementRetention['auditLogMonths'];
  }>(
    db,
    `SELECT engagement_retention_months AS months, left_member_retention_months AS left,
            payment_record_years AS payment, audit_retention_months AS audit
       FROM workspaces WHERE id = ?1`,
    workspaceId,
  );
  return {
    months: row?.months ?? 13,
    leftMemberMonths: row?.left ?? 24,
    paymentRecordYears: row?.payment ?? 10,
    auditLogMonths: row?.audit ?? 24,
  };
};

retention.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/retention',
    tags: ['Privacy'],
    summary: 'How long engagement history stays tied to a person',
    request: { params: workspaceParam },
    responses: {
      200: ok(EngagementRetentionSchema, 'Retention'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    await requireWorkspace(c, workspaceId, 'admin');
    return c.json({ data: await read(env(c).DB, workspaceId) }, 200);
  },
);

retention.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/workspaces/{workspaceId}/retention',
    tags: ['Privacy'],
    summary: 'Set how long engagement history stays tied to a person',
    description:
      'After `months`, deliveries, opens, clicks and per-send copies of addresses stop naming the person; send reports keep their numbers. After `leftMemberMonths` since someone left, their profile is reduced to what keeps them from being emailed. `paymentRecordYears` after a payment, the provider ids an erasure kept for the books are removed. The audit log keeps `auditLogMonths` (less where the plan keeps less). Each can be sent alone. A shorter time applies to existing records within a day.',
    request: { params: workspaceParam, body: jsonBody(UpdateEngagementRetentionSchema) },
    responses: {
      200: ok(EngagementRetentionSchema, 'Updated'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const { auth } = await requireWorkspace(c, workspaceId, 'admin');
    const input = c.req.valid('json');
    const e = env(c);
    const before = await read(e.DB, workspaceId);
    const months = input.months ?? before.months;
    const leftMemberMonths = input.leftMemberMonths ?? before.leftMemberMonths;
    const paymentRecordYears = input.paymentRecordYears ?? before.paymentRecordYears;
    const auditLogMonths = input.auditLogMonths ?? before.auditLogMonths;
    await run(
      e.DB,
      `UPDATE workspaces SET engagement_retention_months = ?1, left_member_retention_months = ?2,
          payment_record_years = ?5, audit_retention_months = ?6, updated_at = ?3
        WHERE id = ?4`,
      months,
      leftMemberMonths,
      Date.now(),
      workspaceId,
      paymentRecordYears,
      auditLogMonths,
    );
    await appendAudit(e.DB, {
      workspaceId,
      actorId: auth.operatorId,
      action: 'workspace.retention_changed',
      targetType: 'workspace',
      targetId: workspaceId,
      metadata: {
        from: before.months,
        to: months,
        leftMemberFrom: before.leftMemberMonths,
        leftMemberTo: leftMemberMonths,
        paymentRecordFrom: before.paymentRecordYears,
        paymentRecordTo: paymentRecordYears,
        auditLogFrom: before.auditLogMonths,
        auditLogTo: auditLogMonths,
      },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.json({ data: { months, leftMemberMonths, paymentRecordYears, auditLogMonths } }, 200);
  },
);

// ---- Former teammates ------------------------------------------------------------------------

const operatorParam = z.object({
  workspaceId: z.string().regex(idPattern('workspace')),
  operatorId: z.string().regex(idPattern('operator')),
});

retention.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/former-teammates',
    tags: ['Privacy'],
    summary: 'People who worked in this workspace and no longer do',
    description:
      'Everyone in the audit log or with an accepted invitation who holds no seat or publication role here now, newest activity first. Owners only.',
    request: { params: workspaceParam },
    responses: {
      200: ok(z.array(FormerTeammateSchema), 'Former teammates'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    await requireWorkspace(c, workspaceId, 'owner');
    const rows = await all<{
      id: string;
      email: string;
      name: string | null;
      redacted: number;
      last_active_at: number | null;
    }>(
      env(c).DB,
      `SELECT o.id, ${teammateEmailSql('o', '?1')} AS email,
              CASE WHEN x.operator_id IS NULL THEN o.name END AS name,
              x.operator_id IS NOT NULL AS redacted,
              (SELECT max(a.created_at) FROM audit_events a
                WHERE a.workspace_id = ?1 AND a.actor_operator_id = o.id) AS last_active_at
         FROM operators o
         LEFT JOIN teammate_redactions x ON x.workspace_id = ?1 AND x.operator_id = o.id
        WHERE (EXISTS (SELECT 1 FROM audit_events a WHERE a.workspace_id = ?1 AND a.actor_operator_id = o.id)
               OR EXISTS (SELECT 1 FROM invites i WHERE i.workspace_id = ?1 AND i.email = o.email
                            AND i.accepted_at IS NOT NULL))
          AND NOT EXISTS (SELECT 1 FROM seats s WHERE s.workspace_id = ?1 AND s.operator_id = o.id)
          AND NOT EXISTS (SELECT 1 FROM channel_roles cr JOIN channels ch ON ch.id = cr.channel_id
                           WHERE ch.workspace_id = ?1 AND cr.operator_id = o.id)
        ORDER BY last_active_at DESC LIMIT 200`,
      workspaceId,
    );
    const data: FormerTeammate[] = rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      redacted: row.redacted === 1,
      lastActiveAt: row.last_active_at === null ? null : toIso(row.last_active_at),
    }));
    return c.json({ data }, 200);
  },
);

retention.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/workspaces/{workspaceId}/former-teammates/{operatorId}/redact',
    tags: ['Privacy'],
    summary: "Remove a former teammate's details from this workspace",
    description:
      'Owners only. For someone with no seat or publication role here: wherever this workspace shows who did something (the audit log, posts, API keys, app grants, data requests, approvals) it shows a placeholder from now on, and their accepted invitations lose their address. Audit entries are hash-chained, so they are not rewritten: a `teammate.redacted` entry records the change and the log is shown with the placeholder. Their account and other workspaces are not changed. `conflict` while they still hold a seat or role here. Safe to repeat.',
    request: { params: operatorParam },
    responses: {
      200: ok(FormerTeammateSchema, 'Redacted'),
      ...errors('unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { workspaceId, operatorId } = c.req.valid('param');
    const { auth } = await requireWorkspace(c, workspaceId, 'owner');
    const result = await redactFormerTeammate(env(c).DB, {
      workspaceId,
      operatorId,
      by: auth.operatorId,
      ipPrefix: ipPrefix(clientIp(c)),
    });
    if (result.outcome === 'unknown') {
      throw new ApiError('not_found', 'Nobody by that id worked in this workspace.');
    }
    if (result.outcome === 'has_seat') {
      throw new ApiError(
        'conflict',
        'They still have a seat or a publication role here. Remove it first.',
      );
    }
    return c.json(
      {
        data: {
          id: operatorId,
          email: result.placeholder as string,
          name: null,
          redacted: true,
          lastActiveAt: null,
        },
      },
      200,
    );
  },
);
