import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import { handleSendMessage, preflight, startBroadcast, type DispatchRow } from '@swarm/engine';
import { SesError } from '@swarm/mail';
import { describe, expect, it } from 'vitest';
import {
  CaptureMail,
  completeRamp,
  config,
  context,
  drain,
  seedChannel,
  seedDispatch,
} from './harness';

const DAY = 24 * 60 * 60 * 1000;

const GATED = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Free part, with ' },
        {
          type: 'text',
          text: 'a link',
          marks: [{ type: 'link', attrs: { href: 'https://free.example/a' } }],
        },
      ],
    },
    { type: 'gate' },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Paid part, with ' },
        {
          type: 'text',
          text: 'another link',
          marks: [{ type: 'link', attrs: { href: 'https://paid.example/b' } }],
        },
      ],
    },
  ],
};

interface Reader {
  id: string;
  email: string;
}

async function addReader(channelId: string, label: string): Promise<Reader> {
  const id = newId('member');
  const email = `${label}-${crypto.randomUUID().slice(0, 8)}@example.org`;
  await env.DB.prepare(
    `INSERT INTO members (id, channel_id, email, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'active', ?4, ?4)`,
  )
    .bind(id, channelId, email, Date.now())
    .run();
  return { id, email };
}

async function addLevel(channelId: string, name: string): Promise<string> {
  const id = newId('membershipLevel');
  await env.DB.prepare(
    `INSERT INTO membership_levels (id, channel_id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)`,
  )
    .bind(id, channelId, name, Date.now())
    .run();
  return id;
}

async function entitle(
  channelId: string,
  memberId: string,
  levelId: string | null,
  window: { startsAt?: number; expiresAt?: number | null } = {},
) {
  await env.DB.prepare(
    `INSERT INTO member_entitlements (member_id, channel_id, kind, source, starts_at, expires_at, level_id)
     VALUES (?1, ?2, 'paid', 'stripe', ?3, ?4, ?5)`,
  )
    .bind(
      memberId,
      channelId,
      window.startsAt ?? Date.now() - DAY,
      window.expiresAt === undefined ? Date.now() + 30 * DAY : window.expiresAt,
      levelId,
    )
    .run();
}

async function gate(channelId: string, dispatchId: string, levelIds: string[]) {
  await env.DB.prepare(
    `INSERT INTO gates (dispatch_id, channel_id, level_ids_json, updated_at) VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(dispatchId, channelId, JSON.stringify(levelIds), Date.now())
    .run();
}

async function gatedDispatch(
  channelId: string,
  visibility: 'paid' | 'members' = 'paid',
): Promise<DispatchRow> {
  const dispatch = await seedDispatch(channelId, { content_json: JSON.stringify(GATED) });
  await env.DB.prepare('UPDATE dispatches SET web_visibility = ?1 WHERE id = ?2')
    .bind(visibility, dispatch.id)
    .run();
  return { ...dispatch, web_visibility: visibility };
}

/** Three Members: on the gated level, on another paid level, and free. */
async function setup() {
  const { channelId } = await seedChannel();
  await completeRamp(channelId);
  const gold = await addLevel(channelId, 'Gold');
  const silver = await addLevel(channelId, 'Silver');
  const onGold = await addReader(channelId, 'gold');
  const onSilver = await addReader(channelId, 'silver');
  const free = await addReader(channelId, 'free');
  await entitle(channelId, onGold.id, gold);
  await entitle(channelId, onSilver.id, silver);
  return { channelId, gold, silver, onGold, onSilver, free };
}

async function send(dispatch: DispatchRow, run = context()) {
  const { broadcastId } = await startBroadcast(env.DB, run.queue, config, {
    dispatch,
    operatorId: null,
    allowHtmlBlocks: false,
  });
  return { broadcastId, run };
}

/** 'full' or 'teaser' for the email each address received. */
function received(mail: CaptureMail): Map<string, 'full' | 'teaser'> {
  const out = new Map<string, 'full' | 'teaser'>();
  for (const m of mail.sent) {
    const full = m.html.includes('Paid part') && m.text.includes('Paid part');
    const teaser =
      m.html.includes('The rest of this post is for paid subscribers.') &&
      !m.html.includes('Paid part') &&
      !m.text.includes('Paid part');
    expect(full !== teaser, `${m.to} got exactly one variant`).toBe(true);
    out.set(m.to, full ? 'full' : 'teaser');
  }
  return out;
}

async function variants(broadcastId: string) {
  const { results } = await env.DB.prepare(
    'SELECT member_id, variant FROM broadcast_recipients WHERE broadcast_id = ?1',
  )
    .bind(broadcastId)
    .all<{ member_id: string; variant: string }>();
  return Object.fromEntries(results.map((r) => [r.member_id, r.variant]));
}

describe('full or teaser email per entitlement', () => {
  it('sends the full email to the gated level and the teaser to everyone else', async () => {
    const { channelId, gold, onGold, onSilver, free } = await setup();
    const dispatch = await gatedDispatch(channelId);
    await gate(channelId, dispatch.id, [gold]);

    const check = await preflight(env.DB, config, dispatch, { allowHtmlBlocks: false });
    expect(check.ready).toBe(true);
    expect(check.recipientCount).toBe(3);
    expect(check.split).toEqual({ full: 1, teaser: 2, levelIds: [gold] });
    expect(check.checks.find((c) => c.key === 'audience')?.message).toContain(
      '1 gets the full post and 2 the teaser that stops at the paywall.',
    );
    // One link list for both emails: the full email's links, the teaser's renumbered into it.
    expect(check.template?.links).toEqual(['https://free.example/a', 'https://paid.example/b']);
    expect(check.teaser?.links).toEqual(check.template?.links);

    const { broadcastId, run } = await send(dispatch);
    await drain(run.ctx, run.queue);
    const got = received(run.mail);
    expect(got.get(onGold.email)).toBe('full');
    expect(got.get(onSilver.email)).toBe('teaser');
    expect(got.get(free.email)).toBe('teaser');
    expect(await variants(broadcastId)).toEqual({
      [onGold.id]: 'full',
      [onSilver.id]: 'teaser',
      [free.id]: 'teaser',
    });
    // Both emails' links are tracked against the same link targets.
    const targets = await env.DB.prepare(
      'SELECT url FROM link_targets WHERE broadcast_id = ?1 ORDER BY position',
    )
      .bind(broadcastId)
      .all<{ url: string }>();
    expect(targets.results.map((t) => t.url)).toEqual([
      'https://free.example/a',
      'https://paid.example/b',
    ]);
    for (const m of run.mail.sent) expect(m.html).toContain('https://link.swarm.test/c/');
  });

  it('admits any paid level when the Gate lists none', async () => {
    const { channelId, onGold, onSilver, free } = await setup();
    const dispatch = await gatedDispatch(channelId);
    // No Gate row at all behaves like an empty list.
    const check = await preflight(env.DB, config, dispatch, { allowHtmlBlocks: false });
    expect(check.split).toEqual({ full: 2, teaser: 1, levelIds: [] });

    const { run } = await send(dispatch);
    await drain(run.ctx, run.queue);
    const got = received(run.mail);
    expect(got.get(onGold.email)).toBe('full');
    expect(got.get(onSilver.email)).toBe('full');
    expect(got.get(free.email)).toBe('teaser');
  });

  it('sends the teaser when the entitlement expired or has not started', async () => {
    const { channelId, gold } = await setup();
    const expired = await addReader(channelId, 'expired');
    const later = await addReader(channelId, 'later');
    const forever = await addReader(channelId, 'forever');
    await entitle(channelId, expired.id, gold, { expiresAt: Date.now() - 1000 });
    await entitle(channelId, later.id, gold, { startsAt: Date.now() + DAY });
    await entitle(channelId, forever.id, gold, { expiresAt: null });
    const dispatch = await gatedDispatch(channelId);
    await gate(channelId, dispatch.id, [gold]);

    const { run } = await send(dispatch);
    await drain(run.ctx, run.queue);
    const got = received(run.mail);
    expect(got.get(expired.email)).toBe('teaser');
    expect(got.get(later.email)).toBe('teaser');
    expect(got.get(forever.email)).toBe('full');
  });

  it('admits an entitlement with no level only through a Gate that admits any paid level', async () => {
    const { channelId, gold } = await setup();
    const legacy = await addReader(channelId, 'legacy');
    await entitle(channelId, legacy.id, null);
    const restricted = await gatedDispatch(channelId);
    await gate(channelId, restricted.id, [gold]);
    const open = await gatedDispatch(channelId);
    expect(
      (await preflight(env.DB, config, restricted, { allowHtmlBlocks: false })).split,
    ).toMatchObject({ full: 1 });
    expect((await preflight(env.DB, config, open, { allowHtmlBlocks: false })).split).toMatchObject(
      { full: 3 },
    );
  });

  it("sends a 'members' Dispatch in full to every Member", async () => {
    const { channelId, onGold, onSilver, free } = await setup();
    const dispatch = await gatedDispatch(channelId, 'members');
    const check = await preflight(env.DB, config, dispatch, { allowHtmlBlocks: false });
    expect(check.split).toBeNull();
    expect(check.teaser).toBeNull();

    const { broadcastId, run } = await send(dispatch);
    await drain(run.ctx, run.queue);
    const got = received(run.mail);
    expect([...got.values()]).toEqual(['full', 'full', 'full']);
    expect(got.has(onGold.email) && got.has(onSilver.email) && got.has(free.email)).toBe(true);
    const row = await env.DB.prepare('SELECT teaser_html FROM broadcasts WHERE id = ?1')
      .bind(broadcastId)
      .first<{ teaser_html: string | null }>();
    expect(row?.teaser_html).toBeNull();
  });

  it('keeps each recipient’s variant through retries and duplicate batches', async () => {
    const { channelId, gold, onGold, onSilver, free } = await setup();
    const dispatch = await gatedDispatch(channelId);
    await gate(channelId, dispatch.id, [gold]);
    const mail = new CaptureMail();
    const { broadcastId, run } = await send(dispatch, context(mail));

    // The snapshot decides the variants...
    const snapshot = run.queue.items.shift()!;
    expect(snapshot.body.type).toBe('snapshot');
    await handleSendMessage(run.ctx, snapshot.body);
    expect(await variants(broadcastId)).toMatchObject({ [onGold.id]: 'full' });

    // ...so entitlements changing afterwards don't change what is sent, and neither does a retry.
    await env.DB.prepare('DELETE FROM member_entitlements WHERE member_id = ?1')
      .bind(onGold.id)
      .run();
    await entitle(channelId, free.id, gold);
    let failedOnce = false;
    mail.fail = (m) => {
      if (m.to === onGold.email && !failedOnce) {
        failedOnce = true;
        return new SesError(429, 'TooManyRequestsException', 'slow down');
      }
      return null;
    };
    const result = await drain(run.ctx, run.queue, { duplicateBatches: true });
    expect(result.retries).toBeGreaterThan(0);
    expect(mail.sent).toHaveLength(3);
    const got = received(mail);
    expect(got.get(onGold.email)).toBe('full');
    expect(got.get(onSilver.email)).toBe('teaser');
    expect(got.get(free.email)).toBe('teaser');
  });
});
