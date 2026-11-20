// What capture and site ask of the vault: the Member Center (a link the vault verifies itself),
// signup seals, join and journey tokens, and Member Center and goods links minted from evidence,
// rate-limited and recorded.
import { env } from 'cloudflare:workers';
import { sha256Hex } from '@swarm/db';
import { createLinkKeys, encrypt, memberToken, readGoodsToken, signJoinToken } from '@swarm/engine';
import { parseKeyring, parseVerifyKeyring, verifyLink, verifyToken } from '@swarm/tokens';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addApiKey,
  addField,
  addMember,
  addOperator,
  memberLinkV1,
  memberLinkV2,
  rows,
  seedChannel,
  session,
  sql,
  storeValue,
  vault,
  legacyLinks,
} from './helpers';

const fieldKeys = parseKeyring(env.FIELD_KEYS);
const memberKeys = parseKeyring(env.MEMBER_KEYS);
const legacy = legacyLinks(env.MEMBER_KEYS);
/** What site holds to check goods links: their public key, and MEMBER_KEYS for v1 ones. */
const siteLinks = createLinkKeys({
  mode: { signing: 'v2', legacyCutoffMs: null },
  memberKeys,
  rings: { GOODS_VERIFY_KEYS: env.TEST_GOODS_VERIFY_KEYS },
});
const v2 = { vars: { LINK_SIGNING_MODE: 'v2', LINK_LEGACY_CUTOFF: String(Date.now()) } };

async function publishForm(workspaceId: string, channelId: string): Promise<string> {
  const id = `cf_${crypto.randomUUID().replaceAll('-', '')}`;
  await sql(
    `INSERT INTO capture_forms (id, workspace_id, channel_id, name, status, draft_config_json, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'Form', 'published', '{}', ?4, ?4)`,
    id,
    workspaceId,
    channelId,
    Date.now(),
  );
  return id;
}

describe('capture: the Member Center', () => {
  let workspaceId: string;
  let channelId: string;
  let memberId: string;

  beforeEach(async () => {
    ({ workspaceId, channelId } = await seedChannel());
    const fieldId = await addField(channelId, 'tax_id');
    memberId = await addMember(channelId);
    await storeValue(memberId, fieldId, await encrypt(fieldKeys, JSON.stringify('DE-1')));
  });

  it('shows fields only within an hour of an emailed link', async () => {
    const capture = vault('capture');
    const footer = await capture.openMemberCenter({ token: await memberLinkV1(memberId) });
    expect(footer).toMatchObject({
      ok: true,
      value: { memberId, channelId, emailed: false, fields: {} },
    });
    const fresh = await capture.openMemberCenter({
      token: await memberLinkV1(memberId, { emailed: true }),
    });
    expect(fresh).toMatchObject({ ok: true, value: { emailed: true, fields: { tax_id: 'DE-1' } } });
    const stale = await capture.openMemberCenter({
      token: await memberLinkV1(memberId, { emailed: true, now: Date.now() - 2 * 3_600_000 }),
    });
    expect(stale).toMatchObject({ ok: true, value: { fields: {} } });
  });

  it('accepts v2 links for the Member’s own Channel only, and not after links were ended', async () => {
    const capture = vault('capture', v2);
    expect(
      (await capture.openMemberCenter({ token: await memberLinkV2(memberId, channelId) })).ok,
    ).toBe(true);
    const other = await seedChannel();
    expect(
      await capture.openMemberCenter({ token: await memberLinkV2(memberId, other.channelId) }),
    ).toEqual({ ok: false, reason: 'refused' });
    const token = await memberLinkV2(memberId, channelId, { now: Date.now() - 60_000 });
    await sql('UPDATE members SET member_links_after = ?1 WHERE id = ?2', Date.now(), memberId);
    expect(await capture.openMemberCenter({ token })).toEqual({ ok: false, reason: 'refused' });
  });

  it('refuses forged and garbled links, and v1 links once their window closed', async () => {
    const capture = vault('capture');
    const forged = await memberToken(legacyLinks(`m1:${'x'.repeat(64)}`), {
      memberId,
      channelId,
    });
    expect(await capture.openMemberCenter({ token: forged })).toEqual({
      ok: false,
      reason: 'refused',
    });
    expect(await capture.openMemberCenter({ token: 'nonsense' })).toEqual({
      ok: false,
      reason: 'refused',
    });
    const closed = vault('capture', {
      vars: { LINK_SIGNING_MODE: 'v2', LINK_LEGACY_CUTOFF: String(Date.now() - 31 * 86_400_000) },
    });
    expect(await closed.openMemberCenter({ token: await memberLinkV1(memberId) })).toEqual({
      ok: false,
      reason: 'refused',
    });
    // Without MEMBER_KEYS (pruned after the window), no v1 link opens at all.
    const pruned = vault('capture', { vars: { ...v2.vars, MEMBER_KEYS: undefined } });
    expect(await pruned.openMemberCenter({ token: await memberLinkV1(memberId) })).toEqual({
      ok: false,
      reason: 'refused',
    });
  });

  it('seals profile edits only with a fresh emailed link, for that Member', async () => {
    const capture = vault('capture');
    expect(
      await capture.sealMemberCenterFields({
        token: await memberLinkV1(memberId),
        values: { tax_id: 'X' },
      }),
    ).toEqual({ ok: false, reason: 'refused' });
    const sealed = await capture.sealMemberCenterFields({
      token: await memberLinkV1(memberId, { emailed: true }),
      values: { tax_id: 'X' },
    });
    expect(sealed.ok).toBe(true);
  });

  it('rate-limits one Member’s opens', async () => {
    const capture = vault('capture');
    const token = await memberLinkV1(memberId);
    await sql(
      `INSERT INTO vault_rate (scope, subject_hash, window_start, used)
       VALUES ('member-center', ?1, ?2, 120)`,
      await sha256Hex(`member-center\n${memberId}`),
      Date.now() - (Date.now() % 600_000),
    );
    expect(await capture.openMemberCenter({ token })).toEqual({
      ok: false,
      reason: 'rate_limited',
    });
    const audit = await rows<{ decision: string }>(
      "SELECT decision FROM vault_audit WHERE op = 'openMemberCenter' AND principal_id = ?1",
      await sha256Hex(`vault-subject\n${memberId}`),
    );
    expect(audit).toEqual([{ decision: 'rate_limited' }]);
  });

  it('seals signup fields for a live form, a new Member or one in its Channel', async () => {
    const formId = await publishForm(workspaceId, channelId);
    const capture = vault('capture');
    const newMember = `mb_${crypto.randomUUID().replaceAll('-', '')}`;
    expect(
      (await capture.sealSignupFields({ formId, memberId: newMember, values: { tax_id: 'A' } })).ok,
    ).toBe(true);
    const other = await seedChannel();
    const stranger = await addMember(other.channelId);
    expect(
      await capture.sealSignupFields({ formId, memberId: stranger, values: { tax_id: 'A' } }),
    ).toEqual({ ok: false, reason: 'not_found' });
    await sql("UPDATE capture_forms SET status = 'archived' WHERE id = ?1", formId);
    expect(
      await capture.sealSignupFields({ formId, memberId: newMember, values: { tax_id: 'A' } }),
    ).toEqual({ ok: false, reason: 'refused' });
  });
});

describe('join and journey tokens', () => {
  let workspaceId: string;
  let channelId: string;
  let formId: string;
  const memberId = `mb_${'a'.repeat(32)}`;

  beforeEach(async () => {
    ({ workspaceId, channelId } = await seedChannel());
    formId = await publishForm(workspaceId, channelId);
  });

  it('mints a join token only the vault opens, for its own Channel', async () => {
    const minted = await vault('capture').mintJoinToken({
      formId,
      memberId,
      email: 'Ada@Example.test',
      journeyPath: '/v1/j/sj_1',
    });
    if (!minted.ok) throw new Error(minted.reason);
    expect(minted.value.startsWith('v2.join.')).toBe(true);
    expect(minted.value).not.toContain('example');
    const opened = await vault('site').openJoinToken({ token: minted.value, channelId });
    expect(opened).toMatchObject({
      ok: true,
      value: { formId, memberId, email: 'ada@example.test', journeyPath: '/v1/j/sj_1' },
    });
    const other = await seedChannel();
    expect(
      await vault('site').openJoinToken({ token: minted.value, channelId: other.channelId }),
    ).toEqual({
      ok: false,
      reason: 'refused',
    });
  });

  it('opens a v1 join token from before the vault, while legacy opening is on', async () => {
    const token = await signJoinToken(legacy, fieldKeys, {
      channelId,
      formId,
      email: 'old@example.test',
      memberId,
      journey: null,
    });
    expect(await vault('site').openJoinToken({ token, channelId })).toMatchObject({
      ok: true,
      value: { email: 'old@example.test', memberId },
    });
    expect(
      await vault('site', { vars: { VAULT_LEGACY_OPEN: 'off' } }).openJoinToken({
        token,
        channelId,
      }),
    ).toEqual({ ok: false, reason: 'refused' });
  });

  it('refuses a join token for a form that is not live, or a Member of another Channel', async () => {
    await sql("UPDATE capture_forms SET status = 'draft' WHERE id = ?1", formId);
    expect(
      await vault('capture').mintJoinToken({ formId, memberId, email: 'a@example.test' }),
    ).toEqual({ ok: false, reason: 'not_found' });
    await sql("UPDATE capture_forms SET status = 'published' WHERE id = ?1", formId);
    const other = await seedChannel();
    const stranger = await addMember(other.channelId);
    expect(
      await vault('capture').mintJoinToken({ formId, memberId: stranger, email: 'a@example.test' }),
    ).toEqual({ ok: false, reason: 'not_found' });
  });

  it('round-trips a journey token for a live journey of the form’s Channel', async () => {
    const journeyId = `sj_${crypto.randomUUID().replaceAll('-', '')}`;
    await sql(
      `INSERT INTO signup_journeys (id, channel_id, name, status, form_id, variants_json, created_at, updated_at)
       VALUES (?1, ?2, 'J', 'live', ?3, '[]', ?4, ?4)`,
      journeyId,
      channelId,
      formId,
      Date.now(),
    );
    const capture = vault('capture');
    const minted = await capture.mintJourneyToken({
      formId,
      journeyId,
      variant: 'a',
      memberId,
      email: 'j@example.test',
    });
    if (!minted.ok) throw new Error(minted.reason);
    expect(await capture.openJourneyToken({ token: minted.value })).toEqual({
      ok: true,
      value: { journeyId, variant: 'a', formId, memberId, email: 'j@example.test' },
    });
    await sql("UPDATE signup_journeys SET status = 'paused' WHERE id = ?1", journeyId);
    expect(await capture.openJourneyToken({ token: minted.value })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('Member Center links from evidence', () => {
  let workspaceId: string;
  let channelId: string;
  let memberId: string;

  beforeEach(async () => {
    ({ workspaceId, channelId } = await seedChannel());
    memberId = await addMember(channelId, `${crypto.randomUUID().slice(0, 8)}@example.test`);
  });

  it('mints after a recent confirmation, v1 before the cutover and v2 after', async () => {
    const requestId = `cq_${crypto.randomUUID().replaceAll('-', '')}`;
    const now = Date.now();
    await sql(
      `INSERT INTO confirm_requests (id, member_id, channel_id, last_sent_at, confirmed_at, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?4)`,
      requestId,
      memberId,
      channelId,
      now,
      now + 86_400_000,
    );
    const before = await vault('capture').mintMemberLink({ kind: 'confirmed-request', requestId });
    if (!before.ok) throw new Error(before.reason);
    const v1 = await verifyToken(memberKeys, 'member', before.value[0]?.token as string);
    expect(v1).toMatchObject({ ok: true, payload: { m: memberId } });
    const after = await vault('capture', v2).mintMemberLink({
      kind: 'confirmed-request',
      requestId,
    });
    if (!after.ok) throw new Error(after.reason);
    const ring = await parseVerifyKeyring('MEMBER_SIGNING_KEYS', env.MEMBER_VERIFY_KEYS);
    expect(await verifyLink('member', ring, after.value[0]?.token as string)).toMatchObject({
      ok: true,
      payload: { m: memberId, c: channelId },
    });
    await sql(
      'UPDATE confirm_requests SET confirmed_at = ?1 WHERE id = ?2',
      now - 3_600_000,
      requestId,
    );
    expect(await vault('capture').mintMemberLink({ kind: 'confirmed-request', requestId })).toEqual(
      {
        ok: false,
        reason: 'refused',
      },
    );
  });

  it('mints emailed links for an address’s Members, three an hour', async () => {
    const email = (
      await rows<{ email: string }>('SELECT email FROM members WHERE id = ?1', memberId)
    )[0]?.email as string;
    const capture = vault('capture');
    for (let i = 0; i < 3; i++) {
      const links = await capture.mintMemberLink({ kind: 'link-request', channelId, email });
      if (!links.ok) throw new Error(links.reason);
      expect(links.value.map((l) => l.memberId)).toEqual([memberId]);
      expect(
        await verifyToken(memberKeys, 'member', links.value[0]?.token as string),
      ).toMatchObject({
        payload: { e: 1 },
      });
    }
    expect(await capture.mintMemberLink({ kind: 'link-request', channelId, email })).toEqual({
      ok: false,
      reason: 'rate_limited',
    });
    // An address with no Member gets nothing, and the same answer shape.
    expect(
      await capture.mintMemberLink({
        kind: 'link-request',
        channelId,
        email: 'nobody@example.test',
      }),
    ).toEqual({ ok: true, value: [] });
    const minted = await rows<{ n: number }>(
      "SELECT COUNT(*) AS n FROM vault_mints WHERE subject = ?1 AND evidence = 'link-request'",
      await sha256Hex(`vault-subject\n${memberId}`),
    );
    expect(minted).toEqual([{ n: 3 }]);
  });

  it('steps up a valid link to an emailed one, not for an unreachable Member', async () => {
    const capture = vault('capture');
    const stepped = await capture.mintMemberLink({
      kind: 'step-up',
      token: await memberLinkV1(memberId),
    });
    expect(stepped.ok).toBe(true);
    await sql("UPDATE members SET status = 'bounced' WHERE id = ?1", memberId);
    expect(
      await capture.mintMemberLink({ kind: 'step-up', token: await memberLinkV1(memberId) }),
    ).toEqual({ ok: false, reason: 'refused' });
  });

  it('steps up as often as capture mails a Member fresh links and change notices in an hour', async () => {
    // capture's own budgets per Member an hour: 3 fresh links (linkEmail) and 6 change notices
    // (changeNotice), each with a step-up link the vault mints. A refusal here drops a mail the
    // page has already promised.
    const capture = vault('capture');
    const token = await memberLinkV1(memberId);
    for (let i = 0; i < 9; i++) {
      expect((await capture.mintMemberLink({ kind: 'step-up', token })).ok, `mint ${i + 1}`).toBe(
        true,
      );
    }
    expect(await capture.mintMemberLink({ kind: 'step-up', token })).toEqual({
      ok: false,
      reason: 'rate_limited',
    });
  });

  it('mints for the api with sends:write or an editor, for Members of that Channel', async () => {
    const api = vault('api');
    const key = await addApiKey(workspaceId, ['sends:write']);
    const links = await api.mintMemberLinks(
      { kind: 'api-key', secret: key },
      { channelId, memberIds: [memberId] },
    );
    expect(links.ok && Object.keys(links.value)).toEqual([memberId]);
    const reader = await addApiKey(workspaceId, ['members:read']);
    expect(
      await api.mintMemberLinks(
        { kind: 'api-key', secret: reader },
        { channelId, memberIds: [memberId] },
      ),
    ).toEqual({ ok: false, reason: 'refused' });
    const viewer = await addOperator(workspaceId, 'viewer');
    expect(
      await api.mintMemberLinks(session(viewer.sessionToken), { channelId, memberIds: [memberId] }),
    ).toEqual({ ok: false, reason: 'refused' });
    const other = await seedChannel();
    const stranger = await addMember(other.channelId);
    expect(
      await api.mintMemberLinks(
        { kind: 'api-key', secret: key },
        { channelId, memberIds: [stranger] },
      ),
    ).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('goods links', () => {
  let channelId: string;
  let orderId: string;

  beforeEach(async () => {
    ({ channelId } = await seedChannel());
    orderId = `go_${crypto.randomUUID().replaceAll('-', '')}`;
    const goodId = `gd_${crypto.randomUUID().replaceAll('-', '')}`;
    await sql(
      `INSERT INTO goods (id, channel_id, slug, name, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Zine', ?4, ?4)`,
      goodId,
      channelId,
      `zine-${goodId.slice(-6)}`,
      Date.now(),
    );
    await sql(
      `INSERT INTO good_orders (id, channel_id, good_id, email, amount, currency, status, created_at, paid_at)
       VALUES (?1, ?2, ?4, 'buyer@example.test', 500, 'eur', 'paid', ?3, ?3)`,
      orderId,
      channelId,
      Date.now(),
      goodId,
    );
  });

  it('mints the library link for an address with a paid order, by mail only (3 a day)', async () => {
    const site = vault('site');
    const request = { kind: 'library-request', channelId, email: 'Buyer@example.test' } as const;
    const links = await site.mintGoodsLink(request);
    if (!links.ok || !links.value) throw new Error('no links');
    const read = await readGoodsToken(env.DB, siteLinks, channelId, links.value.library);
    expect(read).toMatchObject({ email: 'buyer@example.test' });
    expect(await site.mintGoodsLink({ ...request, email: 'none@example.test' })).toEqual({
      ok: true,
      value: null,
    });
    await site.mintGoodsLink(request);
    await site.mintGoodsLink(request);
    expect(await site.mintGoodsLink(request)).toEqual({ ok: false, reason: 'rate_limited' });
  });

  it('mints for the thank-you page of an order paid in the last day only', async () => {
    const site = vault('site', v2);
    const links = await site.mintGoodsLink({ kind: 'order', channelId, orderId });
    if (!links.ok || !links.value) throw new Error('no links');
    const ring = await parseVerifyKeyring('GOODS_SIGNING_KEYS', env.TEST_GOODS_VERIFY_KEYS);
    expect(await verifyLink('goods-order', ring, links.value.order)).toMatchObject({
      ok: true,
      payload: { c: channelId, o: orderId },
    });
    await sql(
      'UPDATE good_orders SET paid_at = ?1 WHERE id = ?2',
      Date.now() - 2 * 86_400_000,
      orderId,
    );
    expect(await site.mintGoodsLink({ kind: 'order', channelId, orderId })).toEqual({
      ok: false,
      reason: 'refused',
    });
    const other = await seedChannel();
    expect(
      await site.mintGoodsLink({ kind: 'order', channelId: other.channelId, orderId }),
    ).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('mints for the api only with a recent payment event of the Channel', async () => {
    const eventId = 'evt_test_1';
    await sql(
      `INSERT INTO stripe_events (event_id, stripe_account_id, channel_id, type, created_at, received_at)
       VALUES (?1, 'acct_1', ?2, 'checkout.session.completed', ?3, ?3)`,
      eventId,
      channelId,
      Date.now(),
    );
    const api = vault('api');
    const principal = { kind: 'payment-event', provider: 'stripe', channelId, eventId } as const;
    expect((await api.mintGoodsLinks(principal, { channelId, orderId })).ok).toBe(true);
    expect(
      await api.mintGoodsLinks({ ...principal, eventId: 'evt_missing' }, { channelId, orderId }),
    ).toEqual({ ok: false, reason: 'refused' });
    await sql(
      'UPDATE stripe_events SET received_at = ?1 WHERE event_id = ?2',
      Date.now() - 7_200_000,
      eventId,
    );
    expect(await api.mintGoodsLinks(principal, { channelId, orderId })).toEqual({
      ok: false,
      reason: 'refused',
    });
  });
});
