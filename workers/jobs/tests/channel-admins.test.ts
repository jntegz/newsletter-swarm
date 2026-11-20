/**
 * Who is told about a Channel: its owners and admins. A per-Channel role only ever lowers a seat,
 * so it removes an admin from a Channel's notices but never adds a lower seat to them.
 */
import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import { channelAdminEmails } from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { one, seedChannel, seedFeedAdmin } from './helpers';

async function channelRole(channelId: string, operatorId: string, role: string) {
  await env.DB.prepare(
    'INSERT INTO channel_roles (id, channel_id, operator_id, role, created_at) VALUES (?1, ?2, ?3, ?4, 0)',
  )
    .bind(newId('channelRole'), channelId, operatorId, role)
    .run();
}

const emailOf = async (operatorId: string) =>
  (await one<{ email: string }>('SELECT email FROM operators WHERE id = ?1', operatorId))!.email;

describe('channelAdminEmails', () => {
  it('lists admin seats, drops those a Channel role lowers and never adds a raised seat', async () => {
    const { workspaceId, channelId } = await seedChannel();
    const admin = await seedFeedAdmin(workspaceId, 'admin');
    const lowered = await seedFeedAdmin(workspaceId, 'admin');
    const raised = await seedFeedAdmin(workspaceId, 'author');
    await channelRole(channelId, lowered, 'viewer');
    await channelRole(channelId, raised, 'admin');
    expect(await channelAdminEmails(env.DB, channelId)).toEqual([await emailOf(admin)]);
  });
});
