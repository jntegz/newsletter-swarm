// Rosters (Phase 8, flag rosters; docs/rosters.md) in the capture worker: a Capture Form's
// Rosters are joined by new Members (at single opt-in, or at the confirm), and the Member Center
// lets Members join and leave the Rosters it lists.
import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { memberTokenFor } from './links';
import {
  addMember,
  call,
  confirmLink,
  member,
  nextIp,
  ORIGIN,
  seedChannel,
  seedForm,
  submitJson,
  uniqueEmail,
} from './helpers';

async function setup(options: { flag?: boolean; doubleOptIn?: boolean } = {}) {
  const channel = await seedChannel({ doubleOptIn: options.doubleOptIn ?? false });
  const now = Date.now();
  const listed = newId('roster');
  const hidden = newId('roster');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO rosters (id, channel_id, name, description, member_center, created_at, updated_at)
       VALUES (?1, ?3, 'Deals', 'Offers every Friday', 1, ?4, ?4), (?2, ?3, 'Internal', NULL, 0, ?4, ?4)`,
    ).bind(listed, hidden, channel.channelId, now),
    ...(options.flag === false
      ? []
      : [
          env.DB.prepare(
            `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at) VALUES (?1, 'rosters', 'channel', ?2, 1, 0)`,
          ).bind(newId('featureFlag'), channel.channelId),
        ]),
  ]);
  return { channel, listed, hidden };
}

async function rosterRows(memberId: string) {
  const { results } = await env.DB.prepare(
    'SELECT roster_id, status, source FROM roster_members WHERE member_id = ?1 ORDER BY roster_id',
  )
    .bind(memberId)
    .all<{ roster_id: string; status: string; source: string }>();
  return results;
}

/** Subscribe runs after the response; poll briefly for the Member. */
async function eventually(channelId: string, email: string) {
  for (let i = 0; i < 50; i++) {
    const row = await member(channelId, email);
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('no subscriber');
}

describe('Capture Form Rosters', () => {
  it('joins a new single opt-in subscriber to the form’s Rosters', async () => {
    const { channel, listed, hidden } = await setup();
    const form = await seedForm(channel, { rosterIds: [listed, hidden] });
    const email = uniqueEmail();
    await submitJson(form.id, { email });
    const row = await eventually(channel.channelId, email);
    expect(row.status).toBe('active');
    const rows = await rosterRows(row.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'subscribed' && r.source === 'form')).toBe(true);
  });

  it('joins under double opt-in only when the subscriber confirms', async () => {
    const { channel, listed } = await setup({ doubleOptIn: true });
    const form = await seedForm(channel, { rosterIds: [listed] });
    const email = uniqueEmail();
    await submitJson(form.id, { email });
    const link = await confirmLink(email);
    const row = await eventually(channel.channelId, email);
    expect(row.status).toBe('pending');
    expect(await rosterRows(row.id)).toEqual([]);
    await call(link, { method: 'POST' });
    expect(await rosterRows(row.id)).toEqual([
      { roster_id: listed, status: 'subscribed', source: 'form' },
    ]);
  });

  it('leaves an existing subscriber’s Rosters alone', async () => {
    const { channel, listed } = await setup();
    const form = await seedForm(channel, { rosterIds: [listed] });
    const email = uniqueEmail();
    const id = await addMember(channel.channelId, email, 'active');
    await submitJson(form.id, { email });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await rosterRows(id)).toEqual([]);
  });

  it('joins nothing while the flag is off', async () => {
    const { channel, listed } = await setup({ flag: false });
    const form = await seedForm(channel, { rosterIds: [listed] });
    const email = uniqueEmail();
    await submitJson(form.id, { email });
    const row = await eventually(channel.channelId, email);
    expect(await rosterRows(row.id)).toEqual([]);
  });
});

function post(path: string, fields: Record<string, string | string[]>) {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) body.append(name, v);
  }
  return call(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cf-connecting-ip': nextIp(),
      origin: ORIGIN,
    },
    body: body.toString(),
  });
}

describe('Subscriber settings Rosters', () => {
  async function center(flag = true) {
    const { channel, listed, hidden } = await setup({ flag });
    const id = await addMember(channel.channelId, uniqueEmail(), 'active');
    return { id, listed, hidden, path: `/m/${await memberTokenFor(id)}` };
  }

  it('lists the Rosters shown in the subscriber settings, and saves the choice', async () => {
    const { id, listed, hidden, path } = await center();
    const html = await (await call(path)).text();
    expect(html).toContain('<h2>Your Rosters</h2>');
    expect(html).toContain(`value="${listed}"`);
    expect(html).toContain('Offers every Friday');
    expect(html).not.toContain(hidden);

    const joined = await post(path, { action: 'rosters', roster: [listed, hidden] });
    expect(joined.status).toBe(303);
    expect(joined.headers.get('location')).toContain('saved=rosters');
    // The hidden Roster was posted but isn't listed, so nothing changes for it.
    expect(await rosterRows(id)).toEqual([
      { roster_id: listed, status: 'subscribed', source: 'member' },
    ]);
    expect(await (await call(path)).text()).toMatch(new RegExp(`value="${listed}" checked`));

    await post(path, { action: 'rosters' });
    expect(await rosterRows(id)).toEqual([
      { roster_id: listed, status: 'unsubscribed', source: 'member' },
    ]);
    const events = await env.DB.prepare(
      "SELECT type FROM member_events WHERE member_id = ?1 AND type LIKE 'roster_%' ORDER BY seq",
    )
      .bind(id)
      .all<{ type: string }>();
    expect(events.results.map((e) => e.type)).toEqual(['roster_joined', 'roster_left']);
  });

  it('shows nothing about Rosters while the flag is off', async () => {
    const { id, listed, path } = await center(false);
    expect(await (await call(path)).text()).not.toContain('Your Rosters');
    const res = await post(path, { action: 'rosters', roster: listed });
    expect(res.status).toBe(409);
    expect(await rosterRows(id)).toEqual([]);
  });
});
