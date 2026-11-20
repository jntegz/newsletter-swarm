import { createRoute, z } from '@hono/zod-openapi';
import { all, first, isUniqueViolation, lowerRole, roleAtLeast, run } from '@swarm/db';
import {
  ChannelSchema,
  CreateChannelSchema,
  NEW_CHANNEL_SETTINGS,
  UpdateChannelSchema,
  idPattern,
  newId,
  type SeatRole,
} from '@swarm/domain';
import { CHANNEL_DELETED_REASON, cancelBroadcast } from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireChannel, requireWorkspace } from '../lib/access';
import { appendAudit } from '../lib/audit';
import { clientIp, createRouter, env } from '../lib/context';
import { ipPrefix } from '../lib/crypto';
import { toChannel, type ChannelRow } from '../lib/mappers';
import { errors, idParam, jsonBody, ok } from '../lib/openapi';
import { requireFlag } from '../lib/site';

const RESTORE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const COLUMNS =
  'c.id, c.workspace_id, c.slug, c.name, c.description, c.branding_json, c.settings_json, c.status, c.created_at, c.updated_at, c.deleted_at';

export const channels = createRouter();

const workspaceParam = idParam('workspaceId', idPattern('workspace'));
const channelParam = idParam('channelId', idPattern('channel'));

async function loadChannel(db: D1Database, channelId: string): Promise<ChannelRow> {
  const row = await first<ChannelRow>(
    db,
    `SELECT ${COLUMNS} FROM channels c WHERE c.id = ?1`,
    channelId,
  );
  if (!row) throw new ApiError('not_found', 'Publication not found.');
  return row;
}

channels.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/channels',
    tags: ['Channels'],
    summary: 'Channels in a workspace',
    request: {
      params: workspaceParam,
      query: z.object({
        deleted: z.enum(['true', 'false']).optional().openapi({
          description: 'Admins only: list Channels deleted in the last 30 days instead',
        }),
      }),
    },
    responses: {
      200: ok(z.array(ChannelSchema), 'Channels'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const deleted = c.req.valid('query').deleted === 'true';
    const { auth, role } = await requireWorkspace(c, workspaceId, deleted ? 'admin' : 'viewer');
    const rows = await all<ChannelRow & { channel_role: SeatRole | null }>(
      env(c).DB,
      `SELECT ${COLUMNS}, cr.role AS channel_role FROM channels c
         LEFT JOIN channel_roles cr ON cr.channel_id = c.id AND cr.operator_id = ?2
        WHERE c.workspace_id = ?1 AND ${deleted ? 'c.deleted_at > ?3' : 'c.deleted_at IS NULL'}
        ORDER BY c.created_at`,
      workspaceId,
      auth.operatorId,
      ...(deleted ? [Date.now() - RESTORE_WINDOW_MS] : []),
    );
    return c.json(
      { data: rows.map((row) => toChannel(row, lowerRole(role, row.channel_role))) },
      200,
    );
  },
);

channels.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/workspaces/{workspaceId}/channels',
    tags: ['Channels'],
    summary: 'Create a Channel',
    request: { params: workspaceParam, body: jsonBody(CreateChannelSchema) },
    responses: {
      201: ok(ChannelSchema, 'Created'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const { auth, role } = await requireWorkspace(c, workspaceId, 'admin');
    const input = c.req.valid('json');
    const e = env(c);
    const now = Date.now();
    const id = newId('channel');
    try {
      await run(
        e.DB,
        `INSERT INTO channels (id, workspace_id, slug, name, description, branding_json, settings_json,
           created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?8, ?7, ?7)`,
        id,
        workspaceId,
        input.slug,
        input.name,
        input.description ?? null,
        JSON.stringify({ accentColor: null, logoMediaId: null }),
        now,
        // Per-person tracking starts off (docs/privacy-controls.md).
        JSON.stringify(NEW_CHANNEL_SETTINGS),
      );
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ApiError('conflict', 'That address is already taken.');
      throw error;
    }
    await appendAudit(e.DB, {
      workspaceId,
      actorId: auth.operatorId,
      action: 'channel.created',
      targetType: 'channel',
      targetId: id,
      metadata: { slug: input.slug, name: input.name },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.json({ data: toChannel(await loadChannel(e.DB, id), role) }, 201);
  },
);

channels.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}',
    tags: ['Channels'],
    summary: 'One Channel',
    request: { params: channelParam },
    responses: { 200: ok(ChannelSchema, 'Channel'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'viewer');
    return c.json({ data: toChannel(await loadChannel(env(c).DB, channelId), access.role) }, 200);
  },
);

channels.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/channels/{channelId}',
    tags: ['Channels'],
    summary: 'Update a Channel',
    description: 'Editors change name, description and branding. Pausing a Channel needs admin.',
    request: { params: channelParam, body: jsonBody(UpdateChannelSchema) },
    responses: {
      200: ok(ChannelSchema, 'Updated'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'editor');
    if (input.status && !roleAtLeast(access.role, 'admin')) {
      throw new ApiError('forbidden', 'Pausing a publication needs the admin role.');
    }
    const e = env(c);
    const current = await loadChannel(e.DB, channelId);

    let branding = JSON.parse(current.branding_json) as Record<string, unknown>;
    if (input.branding) {
      const logoId = input.branding.logoMediaId;
      if (logoId) {
        const owned = await first(
          e.DB,
          'SELECT 1 FROM media WHERE id = ?1 AND workspace_id = ?2 AND deleted_at IS NULL',
          logoId,
          access.workspaceId,
        );
        if (!owned) throw new ApiError('invalid_input', 'That logo is not in this workspace.');
      }
      branding = { ...branding, ...input.branding };
    }

    const settings = JSON.parse(current.settings_json) as Record<string, unknown>;
    if (input.doubleOptIn !== undefined) settings.doubleOptIn = input.doubleOptIn;
    if (input.requireConfirmation !== undefined) {
      settings.requireConfirmation = input.requireConfirmation;
    }
    // Requiring confirmation means the default is on; turning the default off ends the requirement.
    if (input.requireConfirmation === true) settings.doubleOptIn = true;
    else if (input.doubleOptIn === false) delete settings.requireConfirmation;
    if (input.signupPath !== undefined) {
      await requireFlag(c, access, 'signup_paths', 'Signup steps are not available.');
      settings.signupPath = input.signupPath;
    }
    if (input.sunsetDays !== undefined) {
      if (!roleAtLeast(access.role, 'admin')) {
        throw new ApiError(
          'forbidden',
          'Unsubscribing readers automatically needs the admin role.',
        );
      }
      if (input.sunsetDays === null) delete settings.sunsetDays;
      else settings.sunsetDays = input.sunsetDays;
    }
    // Tracking choices (docs/privacy-controls.md). A privacy decision for everyone on the list.
    const tracking = ['trackOpens', 'trackClicks', 'profileReaders'] as const;
    if (tracking.some((key) => input[key] !== undefined)) {
      if (!roleAtLeast(access.role, 'admin')) {
        throw new ApiError('forbidden', 'Changing what is tracked needs the admin role.');
      }
      for (const key of tracking) {
        // Stored only when off, so a publication that never chose stays on the default.
        if (input[key] === true) delete settings[key];
        else if (input[key] === false) settings[key] = false;
      }
      if (input.profileReaders === true && settings.trackOpens === false) {
        throw new ApiError(
          'invalid_input',
          'Reader profiles need open tracking. Turn open tracking on first.',
          [{ path: 'profileReaders', message: 'Needs open tracking.' }],
        );
      }
    }
    if (input.emailDesign !== undefined) {
      await requireFlag(c, access, 'email_design', 'Email design is not available.');
      settings.emailDesign = input.emailDesign;
    }
    if (input.confirmDays !== undefined) settings.confirmDays = input.confirmDays;
    if (input.styleGuide !== undefined) settings.styleGuide = input.styleGuide;

    const row = await first<ChannelRow>(
      e.DB,
      `UPDATE channels SET name = ?1, description = ?2, branding_json = ?3, status = ?4, updated_at = ?5,
              settings_json = ?7
        WHERE id = ?6
       RETURNING id, workspace_id, slug, name, description, branding_json, settings_json, status, created_at, updated_at, deleted_at`,
      input.name ?? current.name,
      input.description === undefined ? current.description : input.description,
      JSON.stringify(branding),
      input.status ?? current.status,
      Date.now(),
      channelId,
      JSON.stringify(settings),
    );
    // Site pages show these, and are cached under the version: readers get the change at once.
    if (
      input.name !== undefined ||
      input.description !== undefined ||
      input.branding !== undefined ||
      input.signupPath !== undefined
    ) {
      await run(
        e.DB,
        `INSERT INTO site_settings (channel_id, cache_version, updated_at) VALUES (?1, 2, ?2)
           ON CONFLICT (channel_id) DO UPDATE SET cache_version = cache_version + 1, updated_at = ?2`,
        channelId,
        Date.now(),
      );
    }
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'channel.updated',
      targetType: 'channel',
      targetId: channelId,
      metadata: { fields: Object.keys(input) },
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.json({ data: toChannel(row as ChannelRow, access.role) }, 200);
  },
);

channels.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/channels/{channelId}',
    tags: ['Channels'],
    summary: 'Delete a Channel',
    description:
      'Soft delete. Sends still going out are canceled. The Channel can be restored for 30 days and keeps its address meanwhile.',
    request: { params: channelParam },
    responses: {
      200: ok(ChannelSchema, 'Deleted'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'admin');
    const e = env(c);
    const now = Date.now();
    const row = await first<ChannelRow>(
      e.DB,
      `UPDATE channels SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2
       RETURNING id, workspace_id, slug, name, description, branding_json, settings_json, status, created_at, updated_at, deleted_at`,
      now,
      channelId,
    );
    // A deleted Channel mails nobody again: its sends in progress stop now, as a cancel would (the
    // jobs cron then cancels their Split Tests and Cohort Samples). A send that starts alongside
    // this is stopped by the pipeline at its next step. Flows exit their runs on their own.
    const sending = await all<{ id: string }>(
      e.DB,
      `SELECT id FROM broadcasts WHERE channel_id = ?1 AND kind = 'broadcast' AND status IN ('queued', 'sending')`,
      channelId,
    );
    const canceled: string[] = [];
    for (const { id } of sending) {
      if (await cancelBroadcast(e.DB, id, now, CHANNEL_DELETED_REASON)) canceled.push(id);
    }
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'channel.deleted',
      targetType: 'channel',
      targetId: channelId,
      ...(canceled.length ? { metadata: { canceledBroadcasts: canceled } } : {}),
      ipPrefix: ipPrefix(clientIp(c)),
    });
    return c.json({ data: toChannel(row as ChannelRow, access.role) }, 200);
  },
);

channels.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/restore',
    tags: ['Channels'],
    summary: 'Restore a deleted Channel',
    request: { params: channelParam },
    responses: {
      200: ok(ChannelSchema, 'Restored'),
      ...errors('unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'admin', { allowDeleted: true });
    const e = env(c);
    const now = Date.now();
    // Posts that came due while the Channel was deleted go back to draft in the same transaction,
    // so the send cron never fires them late. Later ones keep their time.
    const [unscheduled, restored] = await e.DB.batch<{ id: string }>([
      e.DB.prepare(
        `UPDATE dispatches SET status = 'draft', publish_at = NULL, best_time = 0, updated_by = ?1, updated_at = ?2
          WHERE channel_id = ?3 AND status = 'scheduled' AND publish_at <= ?2
            AND EXISTS (SELECT 1 FROM channels WHERE id = ?3 AND deleted_at > ?4)
          RETURNING id`,
      ).bind(access.auth.operatorId, now, channelId, now - RESTORE_WINDOW_MS),
      e.DB.prepare(
        `UPDATE channels SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2 AND deleted_at > ?3
         RETURNING id, workspace_id, slug, name, description, branding_json, settings_json, status, created_at, updated_at, deleted_at`,
      ).bind(now, channelId, now - RESTORE_WINDOW_MS),
    ]);
    const row = restored?.results[0] as ChannelRow | undefined;
    if (!row) throw new ApiError('not_found', 'This publication can no longer be restored.');
    await appendAudit(e.DB, {
      workspaceId: access.workspaceId,
      actorId: access.auth.operatorId,
      action: 'channel.restored',
      targetType: 'channel',
      targetId: channelId,
      ipPrefix: ipPrefix(clientIp(c)),
    });
    for (const dispatch of unscheduled?.results ?? []) {
      await appendAudit(e.DB, {
        workspaceId: access.workspaceId,
        actorId: access.auth.operatorId,
        action: 'dispatch.unscheduled',
        targetType: 'dispatch',
        targetId: dispatch.id,
        metadata: { reason: 'came due while the Channel was deleted' },
        ipPrefix: ipPrefix(clientIp(c)),
      });
    }
    return c.json({ data: toChannel(row, access.role) }, 200);
  },
);
