import { env } from 'cloudflare:test';
import type { ImportJob, MemberDetail, MemberField } from '@swarm/domain';
import { newId } from '@swarm/domain';
import { expect } from 'vitest';
import { call, json, uniqueEmail, type Session } from './helpers';

export async function data<T>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await json<{ data: T }>(res)).data;
}

export async function addMember(
  s: Session,
  channelId: string,
  body: Record<string, unknown> = {},
): Promise<MemberDetail> {
  return data<MemberDetail>(
    await call('POST', `/api/v1/channels/${channelId}/members`, {
      cookie: s.cookie,
      body: { email: uniqueEmail('member'), consent: true, ...body },
    }),
    201,
  );
}

export async function addField(
  s: Session,
  channelId: string,
  body: Record<string, unknown> = {},
): Promise<MemberField> {
  return data<MemberField>(
    await call('POST', `/api/v1/channels/${channelId}/member-fields`, {
      cookie: s.cookie,
      body: { key: `f_${crypto.randomUUID().slice(0, 8)}`, label: 'Field', type: 'text', ...body },
    }),
    201,
  );
}

export function csvForm(text: string, name = 'list.csv', type = 'text/csv'): FormData {
  const form = new FormData();
  form.set('file', new File([text], name, { type }));
  return form;
}

export async function upload(s: Session, channelId: string, text: string): Promise<ImportJob> {
  return data<ImportJob>(
    await call('POST', `/api/v1/channels/${channelId}/imports`, {
      cookie: s.cookie,
      form: csvForm(text),
    }),
    201,
  );
}

/** Marks an import as analyzed with a report, as the jobs worker would. */
export async function markAnalyzed(importId: string, newMembers = 1): Promise<void> {
  const counts = {
    new: newMembers,
    updated: 0,
    unchanged: 0,
    invalid: 0,
    role: 0,
    disposable: 0,
    suppressed: 0,
    duplicate: 0,
  };
  const samples = Object.fromEntries(Object.keys(counts).map((k) => [k, []]));
  await env.DB.prepare("UPDATE import_jobs SET status = 'analyzed', report_json = ?1 WHERE id = ?2")
    .bind(
      JSON.stringify({
        total: newMembers,
        counts,
        samples,
        fieldErrors: 0,
        fieldErrorSamples: [],
        warmImport: newMembers >= 10_000,
      }),
      importId,
    )
    .run();
}

/** A finished export with two parts in R2, as the jobs worker would leave it. */
export async function finishedExport(
  workspaceId: string,
  channelId: string,
  options: { expiresAt?: number } = {},
): Promise<string> {
  const id = newId('exportJob');
  const prefix = `ws/${workspaceId}/ch/${channelId}/${id}/`;
  await env.EXPORTS.put(`${prefix}0-header`, 'id,email\r\n');
  await env.EXPORTS.put(`${prefix}1-`, 'mb_1,a@example.com\r\n');
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO export_jobs (id, workspace_id, channel_id, format, status, r2_key, row_count, cursor, created_at, completed_at, expires_at)
     VALUES (?1, ?2, ?3, 'csv', 'done', ?4, 1, 'mb_1', ?5, ?5, ?6)`,
  )
    .bind(id, workspaceId, channelId, prefix, now, options.expiresAt ?? now + 3_600_000)
    .run();
  return id;
}

/** A sent Broadcast to `memberId` with one delivery, open and click. */
export async function seedDelivery(
  workspaceId: string,
  channelId: string,
  memberId: string,
  email: string,
  at: number,
): Promise<{ broadcastId: string; deliveryId: string }> {
  const dispatchId = newId('dispatch');
  const broadcastId = newId('broadcast');
  const deliveryId = newId('delivery');
  const linkId = newId('linkTarget');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at)
       VALUES (?1, ?2, 'Issue 7', '{}', 'sent', ?3, ?3)`,
    ).bind(dispatchId, channelId, at),
    env.DB.prepare(
      `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text,
         from_name, from_address, track_opens, created_at, last_progress_at)
       VALUES (?1, ?2, ?3, ?4, 'sent', 'Issue 7', '', '', '', 'Field Notes', 'notes@example.com', 1, ?5, ?5)`,
    ).bind(broadcastId, dispatchId, channelId, workspaceId, at),
    env.DB.prepare(
      `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, sent_at, opened_at, human_opened_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
    ).bind(deliveryId, broadcastId, channelId, memberId, email, at, at + 1000),
    env.DB.prepare(
      "INSERT INTO link_targets (id, broadcast_id, url, position) VALUES (?1, ?2, 'https://example.com/read', 0)",
    ).bind(linkId, broadcastId),
    env.DB.prepare(
      `INSERT INTO clicks (id, delivery_id, broadcast_id, link_target_id, classification, created_at)
       VALUES (?1, ?2, ?3, ?4, 'human', ?5)`,
    ).bind(newId('click'), deliveryId, broadcastId, linkId, at + 2000),
  ]);
  return { broadcastId, deliveryId };
}
