// Record lifetimes (packages/engine/src/lifetimes.ts): departed subscribers' profiles, deleted
// publications past their restore window, and operator sign-in records.
import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import {
  ACCOUNT_EVENT_DAYS,
  CHANNEL_PURGE_DAYS,
  EXPIRED_PAYMENT_PREFIX,
  MONTH_MS,
  eraseAddress,
  expirePaymentReferences,
  OPERATOR_RECORD_DAYS,
  FILE_PURGE_BATCH,
  pruneOperatorRecords,
  purgeDeletedChannelFiles,
  purgeDeletedChannels,
  reduceDepartedMembers,
} from '@swarm/engine';
import { parseKeyring } from '@swarm/tokens';
import { describe, expect, it } from 'vitest';
import { addField, addMember, count, one, seedChannel } from './helpers';

const markerKeys = parseKeyring(env.TEST_FIELD_KEYS);

const DAY = 86_400_000;
const unique = (label: string) => `${label}-${crypto.randomUUID().slice(0, 8)}@example.org`;

describe('departed subscribers', () => {
  it('reduces a profile after the workspace period and keeps them from being emailed', async () => {
    const { workspaceId, channelId } = await seedChannel();
    const now = Date.now();
    const field = await addField(channelId, 'city', 'text');
    const left = await addMember(channelId, unique('left'), {
      status: 'unsubscribed',
      firstName: 'Philippa',
    });
    const recent = await addMember(channelId, unique('recent'), {
      status: 'unsubscribed',
      firstName: 'Quentin',
    });
    const active = await addMember(channelId, unique('active'), { firstName: 'Rosamund' });
    const tagId = newId('tag');
    await env.DB.batch([
      env.DB.prepare('UPDATE members SET unsubscribed_at = ?1 WHERE id = ?2').bind(
        now - 25 * MONTH_MS,
        left,
      ),
      env.DB.prepare('UPDATE members SET unsubscribed_at = ?1 WHERE id = ?2').bind(
        now - 2 * MONTH_MS,
        recent,
      ),
      env.DB.prepare(
        'INSERT INTO member_field_values (member_id, field_id, value_text, updated_at) VALUES (?1, ?2, ?3, 0)',
      ).bind(left, field, 'Lisbon'),
      env.DB.prepare(
        "INSERT INTO tags (id, channel_id, name, created_at) VALUES (?1, ?2, 'vip', 0)",
      ).bind(tagId, channelId),
      env.DB.prepare(
        'INSERT INTO member_tags (member_id, tag_id, created_at) VALUES (?1, ?2, 0)',
      ).bind(left, tagId),
      env.DB.prepare(
        `INSERT INTO member_consents (member_id, source, wording, ticked, must_confirm, created_at)
         VALUES (?1, 'form', 'Yes, email me', 1, 0, 0)`,
      ).bind(left),
    ]);
    expect(await reduceDepartedMembers(env.DB, now)).toBeGreaterThanOrEqual(1);
    const row = await one<Record<string, unknown>>(
      'SELECT status, email, first_name, reduced_at FROM members WHERE id = ?1',
      left,
    );
    expect(row).toMatchObject({ status: 'unsubscribed', first_name: null, reduced_at: now });
    expect(
      await count('SELECT count(*) AS n FROM member_field_values WHERE member_id = ?1', left),
    ).toBe(0);
    expect(await count('SELECT count(*) AS n FROM member_tags WHERE member_id = ?1', left)).toBe(0);
    // Consent proof stays.
    expect(
      await count('SELECT count(*) AS n FROM member_consents WHERE member_id = ?1', left),
    ).toBe(1);
    // Inside the period, or still subscribed: untouched.
    expect(await one('SELECT first_name FROM members WHERE id = ?1', recent)).toEqual({
      first_name: 'Quentin',
    });
    expect(await one('SELECT first_name FROM members WHERE id = ?1', active)).toEqual({
      first_name: 'Rosamund',
    });
    // A shorter period, chosen by the workspace, reaches the recent one too.
    await env.DB.prepare('UPDATE workspaces SET left_member_retention_months = 12 WHERE id = ?1')
      .bind(workspaceId)
      .run();
    await reduceDepartedMembers(env.DB, now + 11 * MONTH_MS);
    expect(await one('SELECT first_name FROM members WHERE id = ?1', recent)).toEqual({
      first_name: null,
    });
    // The address and status stay, so the departure is still honoured: nobody is mailed.
    expect(await one('SELECT email, status FROM members WHERE id = ?1', left)).toEqual({
      email: row!.email,
      status: 'unsubscribed',
    });
  });
});

describe('deleted publications', () => {
  it('disposes of subscribers past the restore window, and keeps the books without addresses', async () => {
    const { channelId } = await seedChannel();
    const email = unique('gone');
    const memberId = await addMember(channelId, email, { firstName: 'Silvanus' });
    const reference = `ref${crypto.randomUUID().replace(/-/g, '')}`;
    await env.DB.prepare(
      `INSERT INTO checkout_sessions (reference, channel_id, email, intent, created_at)
       VALUES (?1, ?2, ?3, 'subscribe', 0)`,
    )
      .bind(reference, channelId, unique('buyer'))
      .run();
    const deletedAt = Date.now();
    await env.DB.prepare('UPDATE channels SET deleted_at = ?1 WHERE id = ?2')
      .bind(deletedAt, channelId)
      .run();
    // Inside the window: nothing goes.
    await purgeDeletedChannels(env.DB, deletedAt + 31 * DAY);
    expect(await count('SELECT count(*) AS n FROM members WHERE id = ?1', memberId)).toBe(1);

    const after = deletedAt + (CHANNEL_PURGE_DAYS + 1) * DAY;
    for (let i = 0; i < 50; i++) {
      const result = await purgeDeletedChannels(env.DB, after);
      if (!result.members && !result.channels) break;
    }
    expect(await count('SELECT count(*) AS n FROM members WHERE channel_id = ?1', channelId)).toBe(
      0,
    );
    expect(
      await one('SELECT email FROM checkout_sessions WHERE reference = ?1', reference),
    ).toEqual({ email: null });
    expect(
      await one('SELECT purged_at IS NOT NULL AS purged FROM channels WHERE id = ?1', channelId),
    ).toEqual({ purged: 1 });
  });
});

describe("a deleted publication's stored files", () => {
  const buckets = () => ({ media: env.MEDIA, imports: env.IMPORTS, exports: env.EXPORTS });

  it('are deleted in bounded batches after its personal data is purged, and nothing else', async () => {
    const { workspaceId, channelId } = await seedChannel();
    const kept = await seedChannel();
    const prefix = `ws/${workspaceId}/ch/${channelId}/`;
    const otherPrefix = `ws/${kept.workspaceId}/ch/${kept.channelId}/`;
    const mediaId = newId('media');
    await env.DB.prepare(
      `INSERT INTO media (id, workspace_id, channel_id, r2_key, content_type, bytes, created_at)
       VALUES (?1, ?2, ?3, ?4, 'image/png', 3, 0)`,
    )
      .bind(mediaId, workspaceId, channelId, `${prefix}${mediaId}.png`)
      .run();
    await env.MEDIA.put(`${prefix}${mediaId}.png`, 'png');
    // More media than one batch, and files in the other buckets.
    for (let i = 0; i < FILE_PURGE_BATCH + 5; i++) await env.MEDIA.put(`${prefix}m${i}.pdf`, 'x');
    await env.IMPORTS.put(`${prefix}import.csv`, 'email\nreader@example.org');
    await env.EXPORTS.put(`${prefix}export-1/0-header`, 'email');
    await env.MEDIA.put(`${otherPrefix}keep.png`, 'png');

    // Not purged yet (inside the restore window, or the data purge not done): nothing goes.
    await env.DB.prepare('UPDATE channels SET deleted_at = ?1 WHERE id = ?2')
      .bind(Date.now(), channelId)
      .run();
    // (Publications earlier tests purged go first.)
    for (let i = 0; i < 20; i++) {
      const result = await purgeDeletedChannelFiles(env.DB, buckets(), Date.now());
      if (!result.objects && !result.channels) break;
    }
    expect(await env.IMPORTS.head(`${prefix}import.csv`)).not.toBeNull();

    const after = Date.now() + (CHANNEL_PURGE_DAYS + 1) * DAY;
    for (let i = 0; i < 50; i++) {
      const result = await purgeDeletedChannels(env.DB, after);
      if (!result.members && !result.channels) break;
    }
    const first = await purgeDeletedChannelFiles(env.DB, buckets(), after);
    // One batch per bucket: the media bucket is not empty yet.
    expect(first.channels).toBe(0);
    expect(first.objects).toBeLessThanOrEqual(3 * FILE_PURGE_BATCH);
    let runs = 1;
    for (; runs < 10; runs++) {
      const result = await purgeDeletedChannelFiles(env.DB, buckets(), after);
      if (result.channels) break;
    }
    expect(runs).toBeGreaterThan(1);
    for (const bucket of [env.MEDIA, env.IMPORTS, env.EXPORTS]) {
      expect((await bucket.list({ prefix })).objects).toEqual([]);
    }
    expect(await env.MEDIA.head(`${otherPrefix}keep.png`)).not.toBeNull();
    expect(
      await one('SELECT deleted_at IS NOT NULL AS gone FROM media WHERE id = ?1', mediaId),
    ).toEqual({ gone: 1 });
    expect(
      await one(
        'SELECT files_purged_at IS NOT NULL AS done FROM channels WHERE id = ?1',
        channelId,
      ),
    ).toEqual({ done: 1 });
  });
});

describe('payment references after erasure', () => {
  const YEAR = 12 * MONTH_MS;

  async function paid(channelId: string, memberId: string | null, email: string, at: number) {
    const paymentId = newId('payment');
    const reference = `ref${crypto.randomUUID().replace(/-/g, '')}`;
    const session = `cs_test_${crypto.randomUUID().replace(/-/g, '')}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO payments (id, channel_id, member_id, kind, stripe_object_id, currency, amount, occurred_at)
         VALUES (?1, ?2, ?3, 'one_time', ?4, 'eur', 500, ?5)`,
      ).bind(paymentId, channelId, memberId, `pi_${crypto.randomUUID().slice(0, 12)}`, at),
      env.DB.prepare(
        `INSERT INTO checkout_sessions (reference, stripe_session_id, channel_id, member_id, email, intent,
           status, created_at, completed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'tip', 'complete', ?6, ?6)`,
      ).bind(reference, session, channelId, memberId, email, at),
    ]);
    return { paymentId, reference, session };
  }

  it('keeps them for the books, then removes them after the workspace period', async () => {
    const { workspaceId, channelId } = await seedChannel();
    await env.DB.prepare('UPDATE workspaces SET payment_record_years = 6 WHERE id = ?1')
      .bind(workspaceId)
      .run();
    const email = unique('buyer');
    const memberId = await addMember(channelId, email);
    const paidAt = Date.now() - YEAR;
    const erased = await paid(channelId, memberId, email, paidAt);
    // Someone else's payment of the same day, still theirs: never touched.
    const otherEmail = unique('other');
    const kept = await paid(channelId, await addMember(channelId, otherEmail), otherEmail, paidAt);

    const erasedAt = Date.now();
    await eraseAddress(env.DB, { workspaceId, email, keys: markerKeys }, erasedAt);
    const payment = () =>
      one<{ stripe_object_id: string; member_id: string | null; detached_at: number | null }>(
        'SELECT stripe_object_id, member_id, detached_at, amount FROM payments WHERE id = ?1',
        erased.paymentId,
      );
    // Detached, the reference kept for bookkeeping.
    expect(await payment()).toMatchObject({ member_id: null, detached_at: erasedAt });
    expect((await payment())!.stripe_object_id).toMatch(/^pi_/);
    expect(
      await one(
        'SELECT email, stripe_session_id, detached_at FROM checkout_sessions WHERE reference = ?1',
        erased.reference,
      ),
    ).toEqual({ email: null, stripe_session_id: erased.session, detached_at: erasedAt });

    // Five years after the payment: still inside six.
    await expirePaymentReferences(env.DB, paidAt + 5 * YEAR);
    expect((await payment())!.stripe_object_id).toMatch(/^pi_/);

    // Past six years: the ids go, the amount stays.
    for (let i = 0; i < 20; i++) {
      const result = await expirePaymentReferences(env.DB, paidAt + 6 * YEAR + DAY);
      if (!result.payments && !result.checkouts) break;
    }
    expect(await payment()).toMatchObject({
      stripe_object_id: `${EXPIRED_PAYMENT_PREFIX}${erased.paymentId}`,
      amount: 500,
    });
    expect(
      await one(
        'SELECT stripe_session_id FROM checkout_sessions WHERE reference = ?1',
        erased.reference,
      ),
    ).toEqual({ stripe_session_id: null });
    expect(
      await one(
        'SELECT stripe_session_id FROM checkout_sessions WHERE reference = ?1',
        kept.reference,
      ),
    ).toEqual({ stripe_session_id: kept.session });
    expect(
      (await one<{ stripe_object_id: string }>(
        'SELECT stripe_object_id FROM payments WHERE id = ?1',
        kept.paymentId,
      ))!.stripe_object_id,
    ).toMatch(/^pi_/);
  });

  it('counts from the payment with the default of 10 years', async () => {
    const { workspaceId, channelId } = await seedChannel();
    const email = unique('buyer');
    const memberId = await addMember(channelId, email);
    const paidAt = Date.now() - YEAR;
    const erased = await paid(channelId, memberId, email, paidAt);
    await eraseAddress(env.DB, { workspaceId, email, keys: markerKeys }, Date.now());
    const reference = async () =>
      (await one<{ stripe_object_id: string }>(
        'SELECT stripe_object_id FROM payments WHERE id = ?1',
        erased.paymentId,
      ))!.stripe_object_id;
    for (let i = 0; i < 20; i++) {
      const result = await expirePaymentReferences(env.DB, paidAt + 9 * YEAR);
      if (!result.payments && !result.checkouts) break;
    }
    expect(await reference()).toMatch(/^pi_/);
    for (let i = 0; i < 20; i++) {
      const result = await expirePaymentReferences(env.DB, paidAt + 10 * YEAR + DAY);
      if (!result.payments && !result.checkouts) break;
    }
    expect(await reference()).toBe(`${EXPIRED_PAYMENT_PREFIX}${erased.paymentId}`);
  });
});

describe('operator records', () => {
  it('deletes ended sessions, spent codes and unaccepted invitations after their period', async () => {
    const { workspaceId } = await seedChannel();
    const now = Date.now();
    const old = now - (OPERATOR_RECORD_DAYS + 1) * DAY;
    const operatorId = newId('operator');
    const ids = {
      oldSession: newId('session'),
      liveSession: newId('session'),
      oldCode: newId('quickpass'),
      oldInvite: newId('invite'),
      acceptedInvite: newId('invite'),
      oldEvent: newId('accountEvent'),
      recentEvent: newId('accountEvent'),
    };
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO operators (id, email, name, created_at, updated_at) VALUES (?1, ?2, 'Op', 0, 0)",
      ).bind(operatorId, unique('op')),
      env.DB.prepare(
        `INSERT INTO sessions (id, token_hash, operator_id, user_agent, created_at, last_seen_at, expires_at)
         VALUES (?1, ?2, ?3, 'Firefox', ?4, ?4, ?4)`,
      ).bind(ids.oldSession, `h-${ids.oldSession}`, operatorId, old),
      env.DB.prepare(
        `INSERT INTO sessions (id, token_hash, operator_id, user_agent, created_at, last_seen_at, expires_at)
         VALUES (?1, ?2, ?3, 'Firefox', ?4, ?4, ?5)`,
      ).bind(ids.liveSession, `h-${ids.liveSession}`, operatorId, now, now + DAY),
      env.DB.prepare(
        `INSERT INTO quickpass_tokens (id, token_hash, email, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?4)`,
      ).bind(ids.oldCode, `h-${ids.oldCode}`, unique('typed'), old),
      env.DB.prepare(
        `INSERT INTO invites (id, workspace_id, email, role, token_hash, invited_by, created_at, expires_at)
         VALUES (?1, ?2, ?3, 'editor', ?4, ?5, ?6, ?6)`,
      ).bind(ids.oldInvite, workspaceId, unique('declined'), `h-${ids.oldInvite}`, operatorId, old),
      env.DB.prepare(
        `INSERT INTO invites (id, workspace_id, email, role, token_hash, invited_by, created_at, expires_at, accepted_at)
         VALUES (?1, ?2, ?3, 'editor', ?4, ?5, ?6, ?6, ?6)`,
      ).bind(
        ids.acceptedInvite,
        workspaceId,
        unique('joined'),
        `h-${ids.acceptedInvite}`,
        operatorId,
        old,
      ),
    ]);
    await env.DB.batch(
      [
        [ids.oldEvent, now - (ACCOUNT_EVENT_DAYS + 1) * DAY],
        [ids.recentEvent, now - (ACCOUNT_EVENT_DAYS - 1) * DAY],
      ].map(([id, at]) =>
        env.DB.prepare(
          `INSERT INTO account_events (id, operator_id, action, method, ip_prefix, created_at)
           VALUES (?1, ?2, 'operator.signed_in', 'quickpass', '192.0.2.0/24', ?3)`,
        ).bind(id, operatorId, at),
      ),
    );
    await env.DB.prepare(
      `INSERT INTO factor_undo_tokens (token_hash, operator_id, window_start, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?3, ?3)`,
    )
      .bind(`h-undo-${ids.oldSession}`, operatorId, old)
      .run();
    const pruned = await pruneOperatorRecords(env.DB, now);
    expect(pruned.sessions).toBeGreaterThanOrEqual(1);
    expect(
      await count(
        'SELECT count(*) AS n FROM factor_undo_tokens WHERE operator_id = ?1',
        operatorId,
      ),
    ).toBe(0);
    expect(
      await count('SELECT count(*) AS n FROM account_events WHERE id = ?1', ids.oldEvent),
    ).toBe(0);
    expect(
      await count('SELECT count(*) AS n FROM account_events WHERE id = ?1', ids.recentEvent),
    ).toBe(1);
    expect(await count('SELECT count(*) AS n FROM sessions WHERE id = ?1', ids.oldSession)).toBe(0);
    expect(await count('SELECT count(*) AS n FROM sessions WHERE id = ?1', ids.liveSession)).toBe(
      1,
    );
    expect(
      await count('SELECT count(*) AS n FROM quickpass_tokens WHERE id = ?1', ids.oldCode),
    ).toBe(0);
    expect(await count('SELECT count(*) AS n FROM invites WHERE id = ?1', ids.oldInvite)).toBe(0);
    expect(await count('SELECT count(*) AS n FROM invites WHERE id = ?1', ids.acceptedInvite)).toBe(
      1,
    );
  });
});
