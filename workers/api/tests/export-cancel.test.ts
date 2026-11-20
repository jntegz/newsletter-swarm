// Admins can cancel a Member export that has not finished (S04-P1-TR-export-current-authority):
// the job stops as failed with the reason and its parts are deleted.
import { env } from 'cloudflare:test';
import type { ExportJob } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { call, createChannel, json, seatAs, signIn } from './helpers';

describe('cancelling an export', () => {
  it('stops a queued export and deletes what it wrote; only admins may, and only once', async () => {
    const owner = await signIn();
    const channelId = (await createChannel(owner)).id;
    const created = await call('POST', `/api/v1/channels/${channelId}/exports`, {
      cookie: owner.cookie,
      body: { format: 'csv' },
    });
    expect(created.status).toBe(202);
    const job = (await json<{ data: ExportJob }>(created)).data;
    const prefix = `ws/${owner.workspaceId}/ch/${channelId}/${job.id}/`;
    await env.EXPORTS.put(`${prefix}0-header`, 'email\n');

    const editor = await seatAs(owner.workspaceId, 'editor');
    const path = `/api/v1/exports/${job.id}/cancel`;
    expect((await call('POST', path, { cookie: editor.cookie })).status).toBe(403);

    const canceled = await call('POST', path, { cookie: owner.cookie });
    expect(canceled.status).toBe(200);
    expect((await json<{ data: ExportJob }>(canceled)).data).toMatchObject({
      status: 'failed',
      error: `Canceled by ${owner.email}.`,
      downloadUrl: null,
    });
    expect((await env.EXPORTS.list({ prefix })).objects).toEqual([]);
    expect((await call('POST', path, { cookie: owner.cookie })).status).toBe(409);
  });
});
