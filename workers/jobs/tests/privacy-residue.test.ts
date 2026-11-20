// Privacy processing details (privacy.ts): what is left on request rows and event rows after an
// erasure, workspace-keyed erasure markers and their upgrade, requests for an address with no
// Member, and telling people about requests that were rejected or failed.
import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import {
  addressMarker,
  createDsrRequest,
  emailHash,
  eraseAddress,
  erasedAddresses,
  ERASED_REQUEST_NOTE,
  isErasedAddress,
  keyedMarker,
  leftAddresses,
  markerLabel,
  markerSalt,
  PROVIDER_LIST_NOTE,
  RETAINED_PROVIDER_REFERENCES,
  sealDsrAddress,
  sendRequestOutcomeNotices,
  upgradeAddressMarkers,
} from '@swarm/engine';
import type { OutgoingMail } from '@swarm/mail';
import { parseKeyring } from '@swarm/tokens';
import { describe, expect, it } from 'vitest';
import { runPrivacy } from '../src/handlers/privacy';
import { addMember, count, jobsEnv, one, seedChannel } from './helpers';
import { testLinks } from './links';

const fieldKeys = parseKeyring(env.TEST_FIELD_KEYS);
const memberKeys = testLinks();
const DAY = 86_400_000;
const address = () => `residue-${crypto.randomUUID().slice(0, 10)}@example.org`;

/** Every column of a row as text, joined, for a substring search. */
const rowText = (row: Record<string, unknown> | null) =>
  Object.values(row ?? {})
    .map((v) => String(v ?? ''))
    .join(' ')
    .toLowerCase();

describe('erasure residue', () => {
  it('clears notes, errors and sealed addresses on every request for the address, and browser family', async () => {
    const { workspaceId, channelId } = await seedChannel();
    const email = address();
    const memberId = await addMember(channelId, email, { firstName: 'Ottoline' });
    const now = Date.now();
    // An earlier request that failed, with a note and an error naming the person.
    const failed = await createDsrRequest(
      env.DB,
      fieldKeys,
      {
        workspaceId,
        channelId,
        memberId,
        email,
        kind: 'export',
        source: 'operator',
        status: 'processing',
        note: 'Ottoline rang on Tuesday from her work phone',
      },
      now - DAY,
    );
    await env.DB.prepare("UPDATE dsr_requests SET status = 'failed', error = ?1 WHERE id = ?2")
      .bind(`could not reach ${email}`, failed)
      .run();
    const erase = await createDsrRequest(
      env.DB,
      fieldKeys,
      {
        workspaceId,
        channelId,
        memberId,
        email,
        kind: 'erase',
        source: 'operator',
        status: 'processing',
        note: 'Ottoline asked again by letter',
      },
      now,
    );
    // An open and a click with a browser family, on a delivery to the Member.
    const dispatchId = newId('dispatch');
    const broadcastId = newId('broadcast');
    const deliveryId = newId('delivery');
    const linkId = newId('linkTarget');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at)
         VALUES (?1, ?2, 'S', '{}', 'sent', ?3, ?3)`,
      ).bind(dispatchId, channelId, now),
      env.DB.prepare(
        `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text,
           from_name, from_address, track_opens, created_at, last_progress_at)
         VALUES (?1, ?2, ?3, ?4, 'sent', 'S', '', '', '', 'F', 'f@example.com', 1, ?5, ?5)`,
      ).bind(broadcastId, dispatchId, channelId, workspaceId, now),
      env.DB.prepare(
        `INSERT INTO link_targets (id, broadcast_id, url, position) VALUES (?1, ?2, 'https://a.example/', 0)`,
      ).bind(linkId, broadcastId),
      env.DB.prepare(
        `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, status, sent_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'delivered', ?6)`,
      ).bind(deliveryId, broadcastId, channelId, memberId, email, now),
      env.DB.prepare(
        `INSERT INTO opens (id, delivery_id, broadcast_id, classification, ua_family, ip_prefix, asn, created_at)
         VALUES (?1, ?2, ?3, 'human', 'Firefox', '203.0.113.0/24', 64500, ?4)`,
      ).bind(newId('open'), deliveryId, broadcastId, now),
      env.DB.prepare(
        `INSERT INTO clicks (id, delivery_id, broadcast_id, link_target_id, classification, ua_family, ip_prefix, asn, created_at)
         VALUES (?1, ?2, ?3, ?4, 'human', 'Firefox', '203.0.113.0/24', 64500, ?5)`,
      ).bind(newId('click'), deliveryId, broadcastId, linkId, now),
    ]);

    await runPrivacy(jobsEnv().env, now);

    const requests = await env.DB.prepare(
      'SELECT id, status, note, error, email_enc, email_hash FROM dsr_requests WHERE id IN (?1, ?2)',
    )
      .bind(failed, erase)
      .all<Record<string, unknown>>();
    expect(requests.results).toHaveLength(2);
    for (const row of requests.results) {
      expect(row.email_enc).toBeNull();
      expect(row.error).toBeNull();
      expect(row.note).toBe(ERASED_REQUEST_NOTE);
      expect(rowText(row)).not.toContain('ottoline');
      expect(rowText(row)).not.toContain(email);
    }
    expect(requests.results.find((r) => r.id === erase)!.status).toBe('completed');
    expect(requests.results.find((r) => r.id === failed)!.status).toBe('rejected');
    expect(
      await one('SELECT ua_family, ip_prefix FROM opens WHERE delivery_id = ?1', deliveryId),
    ).toEqual({ ua_family: null, ip_prefix: null });
    expect(await one('SELECT ua_family FROM clicks WHERE delivery_id = ?1', deliveryId)).toEqual({
      ua_family: null,
    });
  });

  it('keeps no address in error text', async () => {
    const { workspaceId } = await seedChannel();
    const email = address();
    const requestId = await createDsrRequest(env.DB, fieldKeys, {
      workspaceId,
      channelId: null,
      memberId: null,
      email,
      kind: 'export',
      source: 'operator',
      status: 'processing',
    });
    // An exports bucket that refuses the file, with the address in its error.
    const { env: jobs } = jobsEnv();
    const failing = {
      ...jobs,
      EXPORTS: {
        put: async () => {
          throw new Error(`upload refused for ${email} (quota)`);
        },
      } as unknown as R2Bucket,
    };
    await runPrivacy(failing, Date.now());
    const row = await one<{ error: string }>(
      'SELECT error FROM dsr_requests WHERE id = ?1',
      requestId,
    );
    expect(row!.error).toContain('[email]');
    expect(row!.error).not.toContain(email);
  });
});

describe('what an erasure keeps on purpose', () => {
  it('keeps only the listed payment references, and says when the provider list may keep the address', async () => {
    const { workspaceId, channelId } = await seedChannel();
    const email = address();
    const memberId = await addMember(channelId, email);
    const paymentId = newId('payment');
    const reference = `ref${crypto.randomUUID().replace(/-/g, '')}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO payments (id, channel_id, member_id, kind, stripe_object_id, currency, amount, occurred_at)
         VALUES (?1, ?2, ?3, 'one_time', 'ch_synthetic1', 'eur', 500, 0)`,
      ).bind(paymentId, channelId, memberId),
      env.DB.prepare(
        `INSERT INTO checkout_sessions (reference, stripe_session_id, channel_id, member_id, email, intent, created_at)
         VALUES (?1, 'cs_synthetic1', ?2, ?3, ?4, 'subscribe', 0)`,
      ).bind(reference, channelId, memberId, email),
      env.DB.prepare(
        `INSERT INTO suppressions (id, workspace_id, email, reason, created_at)
         VALUES (?1, ?2, ?3, 'hard_bounce', 0)`,
      ).bind(newId('suppression'), workspaceId, email),
    ]);
    const requestId = await createDsrRequest(env.DB, fieldKeys, {
      workspaceId,
      channelId,
      memberId,
      email,
      kind: 'erase',
      source: 'operator',
      status: 'processing',
    });
    await runPrivacy(jobsEnv().env, Date.now());
    const payment = await one<Record<string, unknown>>(
      'SELECT member_id, stripe_object_id FROM payments WHERE id = ?1',
      paymentId,
    );
    const checkout = await one<Record<string, unknown>>(
      'SELECT member_id, email, stripe_session_id FROM checkout_sessions WHERE reference = ?1',
      reference,
    );
    // What remains is exactly the stated list, detached from the person.
    const kept = [
      ...(payment?.stripe_object_id ? ['payments.stripe_object_id'] : []),
      ...(checkout?.stripe_session_id ? ['checkout_sessions.stripe_session_id'] : []),
    ];
    expect(kept.sort()).toEqual(Object.keys(RETAINED_PROVIDER_REFERENCES).sort());
    expect(payment!.member_id).toBeNull();
    expect(checkout).toMatchObject({ member_id: null, email: null });
    expect(
      (await one<{ note: string }>('SELECT note FROM dsr_requests WHERE id = ?1', requestId))!.note,
    ).toContain(PROVIDER_LIST_NOTE);
  });
});

describe('erasure markers', () => {
  it('differ by workspace, are not the bare digest, and still block the address', async () => {
    const email = address();
    const a = await seedChannel();
    const b = await seedChannel();
    const markerA = await addressMarker(env.DB, a.workspaceId, email, fieldKeys);
    const markerB = await addressMarker(env.DB, b.workspaceId, email, fieldKeys);
    const digest = await emailHash(email);
    expect(markerA).not.toBe(markerB);
    expect(markerA).not.toContain(digest);
    // The API's label is 12 hex digits of the keyed form, never a prefix of the bare digest.
    const label = await markerLabel(env.DB, a.workspaceId, markerA);
    expect(label).toMatch(/^[0-9a-f]{12}$/);
    expect(digest.startsWith(label)).toBe(false);

    await addMember(a.channelId, email);
    await createDsrRequest(env.DB, fieldKeys, {
      workspaceId: a.workspaceId,
      channelId: a.channelId,
      memberId: null,
      email,
      kind: 'erase',
      source: 'operator',
      status: 'processing',
    });
    await runPrivacy(jobsEnv().env, Date.now());
    expect(await isErasedAddress(env.DB, a.workspaceId, email, fieldKeys)).toBe(true);
    expect(await isErasedAddress(env.DB, b.workspaceId, email, fieldKeys)).toBe(false);
    expect(
      await one('SELECT email_hash FROM suppressions WHERE workspace_id = ?1', a.workspaceId),
    ).toEqual({ email_hash: markerA });
  });

  it('upgrades markers written before, from the stored value, without a gap', async () => {
    const { workspaceId, channelId } = await seedChannel();
    const email = address();
    const left = address();
    const digest = await emailHash(email);
    const suppressionId = newId('suppression');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO suppressions (id, workspace_id, email, email_hash, reason, detail, created_at)
         VALUES (?1, ?2, ?3, ?4, 'manual', 'erased', 0)`,
      ).bind(suppressionId, workspaceId, `erased+${suppressionId}@invalid`, digest),
      env.DB.prepare(
        'INSERT INTO left_addresses (channel_id, email_hash, left_at) VALUES (?1, ?2, 0)',
      ).bind(channelId, await emailHash(left)),
    ]);
    // Before the upgrade, the old form still blocks.
    expect(await isErasedAddress(env.DB, workspaceId, email, fieldKeys)).toBe(true);
    expect((await leftAddresses(env.DB, channelId, [left], fieldKeys)).has(left)).toBe(true);
    for (let i = 0; i < 20 && (await upgradeAddressMarkers(env.DB, fieldKeys)) > 0; i++);
    expect(await one('SELECT email_hash FROM suppressions WHERE id = ?1', suppressionId)).toEqual({
      email_hash: await addressMarker(env.DB, workspaceId, email, fieldKeys),
    });
    expect(
      await count(
        "SELECT count(*) AS n FROM left_addresses WHERE channel_id = ?1 AND email_hash NOT LIKE 'k2.%'",
        channelId,
      ),
    ).toBe(0);
    // And after it.
    expect(await isErasedAddress(env.DB, workspaceId, email, fieldKeys)).toBe(true);
    expect([
      ...(await erasedAddresses(env.DB, workspaceId, [email.toUpperCase()], fieldKeys)),
    ]).toEqual([email]);
    expect((await leftAddresses(env.DB, channelId, [left], fieldKeys)).has(left)).toBe(true);
  });
});

describe('install-keyed erasure markers', () => {
  it('are keyed with FIELD_KEYS, so the database alone cannot test an address', async () => {
    const email = address();
    const { workspaceId } = await seedChannel();
    const marker = await addressMarker(env.DB, workspaceId, email, fieldKeys);
    expect(marker).toMatch(/^k2\.f1:[0-9a-f]{64}$/);
    // Everything in the database (the salt) gives only the salted form, which is not stored.
    const salt = (await one<{ marker_salt: string }>(
      'SELECT marker_salt FROM workspaces WHERE id = ?1',
      workspaceId,
    ))!.marker_salt;
    const salted = await keyedMarker(salt, await emailHash(email));
    expect(marker).not.toContain(salted.slice(3));
    // Another key gives another marker.
    const other = await addressMarker(
      env.DB,
      workspaceId,
      email,
      parseKeyring(`f9:${'9'.repeat(64)}`),
    );
    expect(other).not.toBe(marker);
    expect(await markerLabel(env.DB, workspaceId, marker)).toMatch(/^[0-9a-f]{12}$/);
  });

  it('upgrade salted markers in place when they are used, and by the job', async () => {
    const { workspaceId, channelId } = await seedChannel();
    const used = address();
    const idle = address();
    const left = address();
    const salt = await markerSalt(env.DB, workspaceId);
    const salted = async (email: string) => keyedMarker(salt, await emailHash(email));
    const usedId = newId('suppression');
    const idleId = newId('suppression');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO suppressions (id, workspace_id, email, email_hash, reason, detail, created_at)
         VALUES (?1, ?2, ?3, ?4, 'manual', 'erased', 0)`,
      ).bind(usedId, workspaceId, `erased+${usedId}@invalid`, await salted(used)),
      env.DB.prepare(
        `INSERT INTO suppressions (id, workspace_id, email, email_hash, reason, detail, created_at)
         VALUES (?1, ?2, ?3, ?4, 'manual', 'erased', 0)`,
      ).bind(idleId, workspaceId, `erased+${idleId}@invalid`, await salted(idle)),
      env.DB.prepare(
        'INSERT INTO left_addresses (channel_id, email_hash, left_at) VALUES (?1, ?2, 0)',
      ).bind(channelId, await salted(left)),
    ]);
    const stored = async (id: string) =>
      (await one<{ email_hash: string }>('SELECT email_hash FROM suppressions WHERE id = ?1', id))!
        .email_hash;
    // On use: matched in the salted form, rewritten to the keyed one.
    expect(await isErasedAddress(env.DB, workspaceId, used.toUpperCase(), fieldKeys)).toBe(true);
    expect(await stored(usedId)).toBe(await addressMarker(env.DB, workspaceId, used, fieldKeys));
    expect((await leftAddresses(env.DB, channelId, [left], fieldKeys)).has(left)).toBe(true);
    expect(
      await count(
        'SELECT count(*) AS n FROM left_addresses WHERE channel_id = ?1 AND email_hash = ?2',
        channelId,
        await addressMarker(env.DB, workspaceId, left, fieldKeys),
      ),
    ).toBe(1);
    // By the job, from the stored value alone.
    expect(await stored(idleId)).toBe(await salted(idle));
    for (let i = 0; i < 20 && (await upgradeAddressMarkers(env.DB, fieldKeys)) > 0; i++);
    expect(await stored(idleId)).toBe(await addressMarker(env.DB, workspaceId, idle, fieldKeys));
    expect(await isErasedAddress(env.DB, workspaceId, idle, fieldKeys)).toBe(true);
    expect(
      await count(
        "SELECT count(*) AS n FROM suppressions WHERE workspace_id = ?1 AND email_hash LIKE 'k1:%'",
        workspaceId,
      ),
    ).toBe(0);
  });

  it('keep matching after a key rotation, and move to the new key when used', async () => {
    const { workspaceId } = await seedChannel();
    const email = address();
    const before = parseKeyring(`f1:${'f'.repeat(64)}`);
    const rotated = parseKeyring(`f2:${'2'.repeat(64)},f1:${'f'.repeat(64)}`);
    await eraseAddress(env.DB, { workspaceId, email, keys: before });
    const row = () =>
      one<{ email_hash: string }>(
        'SELECT email_hash FROM suppressions WHERE workspace_id = ?1',
        workspaceId,
      );
    expect((await row())!.email_hash).toMatch(/^k2\.f1:/);
    expect(await isErasedAddress(env.DB, workspaceId, email, rotated)).toBe(true);
    expect((await row())!.email_hash).toMatch(/^k2\.f2:/);
    // Without the key it was written with, it is not recognised: keep old keys in FIELD_KEYS.
    expect(
      await isErasedAddress(env.DB, workspaceId, email, parseKeyring(`f3:${'3'.repeat(64)}`)),
    ).toBe(false);
  });
});

describe('a request for an address with no Member', () => {
  it('exports and erases address-only rows without creating a Member', async () => {
    const { workspaceId, channelId } = await seedChannel();
    const email = address();
    const reference = `ref${crypto.randomUUID().replace(/-/g, '')}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO checkout_sessions (reference, channel_id, email, intent, created_at)
         VALUES (?1, ?2, ?3, 'subscribe', ?4)`,
      ).bind(reference, channelId, email, Date.now()),
      env.DB.prepare(
        `INSERT INTO bounce_events (workspace_id, email, kind, cause, code, detail, created_at)
         VALUES (?1, ?2, 'soft', 'mailbox_full', '4.2.2', 'full', ?3)`,
      ).bind(workspaceId, email, Date.now()),
    ]);
    const exportId = await createDsrRequest(env.DB, fieldKeys, {
      workspaceId,
      channelId: null,
      memberId: null,
      email,
      kind: 'export',
      source: 'operator',
      status: 'processing',
    });
    await runPrivacy(jobsEnv().env, Date.now());
    const exported = await one<{ status: string; export_key: string }>(
      'SELECT status, export_key FROM dsr_requests WHERE id = ?1',
      exportId,
    );
    expect(exported!.status).toBe('completed');
    const file = await (await env.EXPORTS.get(exported!.export_key))!.json<{
      bounces: unknown[];
      addressOnly: { checkouts: unknown[] };
    }>();
    expect(file.bounces).toHaveLength(1);
    expect(file.addressOnly.checkouts).toHaveLength(1);

    await createDsrRequest(env.DB, fieldKeys, {
      workspaceId,
      channelId: null,
      memberId: null,
      email,
      kind: 'erase',
      source: 'operator',
      status: 'processing',
    });
    await runPrivacy(jobsEnv().env, Date.now());
    expect(
      await one('SELECT email FROM checkout_sessions WHERE reference = ?1', reference),
    ).toEqual({ email: null });
    expect(await count('SELECT count(*) AS n FROM bounce_events WHERE email = ?1', email)).toBe(0);
    expect(await count('SELECT count(*) AS n FROM members WHERE email = ?1', email)).toBe(0);
    expect(await isErasedAddress(env.DB, workspaceId, email, fieldKeys)).toBe(true);
  });
});

describe('request outcomes', () => {
  function deps() {
    const sent: OutgoingMail[] = [];
    const mail = {
      async send(m: OutgoingMail) {
        sent.push(m);
        return { messageId: `t-${sent.length}` };
      },
    };
    return {
      sent,
      deps: {
        db: env.DB,
        mail,
        links: memberKeys,
        fieldKeys,
        captureOrigin: 'https://capture.example.test',
        platformMailDomain: 'mail.example.test',
        exports: env.EXPORTS,
        notices: { mail, from: 'notifications@mail.example.test' },
        appOrigin: 'https://app.example.test',
      },
    };
  }

  it('tells the person once that a request was declined, without saying why, then forgets the address', async () => {
    const { workspaceId, channelId } = await seedChannel();
    const email = address();
    const requestId = newId('dsrRequest');
    await env.DB.prepare(
      `INSERT INTO dsr_requests (id, workspace_id, channel_id, email_hash, email_enc, kind, source, status, note,
         due_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'x', ?4, 'erase', 'member_center_unverified', 'rejected', 'Not the holder, per Rosalind',
         0, 0, 0)`,
    )
      .bind(requestId, workspaceId, channelId, await sealDsrAddress(fieldKeys, email))
      .run();
    const { sent, deps: d } = deps();
    expect(await sendRequestOutcomeNotices(d, Date.now())).toMatchObject({ people: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(email);
    expect(sent[0]!.text).toContain('declined');
    expect(sent[0]!.text).not.toContain('Rosalind');
    expect(
      await one(
        'SELECT email_enc, outcome_noticed_at IS NOT NULL AS noticed FROM dsr_requests WHERE id = ?1',
        requestId,
      ),
    ).toEqual({ email_enc: null, noticed: 1 });
    // Once only.
    await sendRequestOutcomeNotices(d, Date.now());
    expect(sent).toHaveLength(1);
  });

  it('tells the person a failed request is delayed and keeps reminding admins until it is resolved', async () => {
    const { workspaceId, channelId } = await seedChannel();
    const operatorId = newId('operator');
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO operators (id, email, name, created_at, updated_at) VALUES (?1, ?2, 'Admin', 0, 0)",
      ).bind(operatorId, `admin-${crypto.randomUUID().slice(0, 8)}@example.com`),
      env.DB.prepare(
        "INSERT INTO seats (workspace_id, operator_id, role, created_at, updated_at) VALUES (?1, ?2, 'admin', 0, 0)",
      ).bind(workspaceId, operatorId),
    ]);
    const email = address();
    const requestId = newId('dsrRequest');
    await env.DB.prepare(
      `INSERT INTO dsr_requests (id, workspace_id, channel_id, email_hash, email_enc, kind, source, status, error,
         due_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'x', ?4, 'export', 'member_center', 'failed', 'boom', 0, 0, 0)`,
    )
      .bind(requestId, workspaceId, channelId, await sealDsrAddress(fieldKeys, email))
      .run();
    const { sent, deps: d } = deps();
    const now = Date.now();
    expect(await sendRequestOutcomeNotices(d, now)).toEqual({ people: 1, admins: 1 });
    expect(sent.map((m) => m.subject)).toContain('A data request failed and needs you');
    expect(sent.find((m) => m.to === email)!.text).toContain('could not complete it yet');
    // A failed request keeps its sealed address for the retry.
    expect(
      await one(
        'SELECT email_enc IS NOT NULL AS sealed FROM dsr_requests WHERE id = ?1',
        requestId,
      ),
    ).toEqual({ sealed: 1 });
    // Not again the next minute; again after the reminder period while it is still failed.
    expect(await sendRequestOutcomeNotices(d, now + 60_000)).toEqual({ people: 0, admins: 0 });
    expect(await sendRequestOutcomeNotices(d, now + 4 * DAY)).toEqual({ people: 0, admins: 1 });
    await env.DB.prepare("UPDATE dsr_requests SET status = 'rejected' WHERE id = ?1")
      .bind(requestId)
      .run();
    expect((await sendRequestOutcomeNotices(d, now + 8 * DAY)).admins).toBe(0);
  });
});
