// Members, profile fields and tags through the API: the member state machine, field validation
// and encryption, search escaping, tag filters and the activity timeline.
import { env } from 'cloudflare:test';
import {
  MEMBER_STATUSES,
  canTransition,
  newId,
  type Member,
  type MemberActivity,
  type MemberDetail,
  type MemberField,
  type MemberListItem,
  type Tag,
} from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { addField, addMember, data, seedDelivery } from './audience-helpers';
import { call, createChannel, json, signIn, uniqueEmail, type Session } from './helpers';
import { enableFlag } from './money-helpers';

let owner: Session;
let channelId: string;

beforeAll(async () => {
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
});

const patch = (memberId: string, body: Record<string, unknown>) =>
  call('PATCH', `/api/v1/members/${memberId}`, { cookie: owner.cookie, body });

const setStatus = (memberId: string, status: string, pausedUntil: number | null = null) =>
  env.DB.prepare('UPDATE members SET status = ?1, paused_until = ?2 WHERE id = ?3')
    .bind(status, pausedUntil, memberId)
    .run();

describe('adding Members', () => {
  it('starts Members active with consent and pending without, sending nothing', async () => {
    const consented = await addMember(owner, channelId);
    expect(consented.status).toBe('active');
    // The Flow trigger, with the status the Member started in.
    const joined = await env.DB.prepare(
      `SELECT payload_json FROM member_events WHERE member_id = ?1 AND type = 'member_joined'`,
    )
      .bind(consented.id)
      .first<{ payload_json: string }>();
    expect(JSON.parse(joined!.payload_json)).toEqual({ source: 'operator', status: 'active' });
    const email = uniqueEmail('pending');
    const pending = await addMember(owner, channelId, { email, consent: undefined });
    expect(pending.status).toBe('pending');
    const row = await env.DB.prepare('SELECT consent_at FROM members WHERE id = ?1')
      .bind(pending.id)
      .first<{ consent_at: number | null }>();
    expect(row?.consent_at).toBeNull();
    const mail = await call('GET', `/__dev/mail/latest.json?to=${encodeURIComponent(email)}`);
    expect(mail.status).toBe(404);
  });

  it('records who vouched for an added Member', async () => {
    const added = await addMember(owner, channelId);
    const res = await call('GET', `/api/v1/members/${added.id}`, { cookie: owner.cookie });
    const { data } = await json<{ data: { consents: Record<string, unknown>[] } }>(res);
    expect(data.consents).toMatchObject([
      { source: 'operator', wording: null, ticked: true, mustConfirm: false },
    ]);
  });

  it('with confirmation required, ignores consent and emails the added Member', async () => {
    const strict = await createChannel(owner);
    const patched = await call('PATCH', `/api/v1/channels/${strict.id}`, {
      cookie: owner.cookie,
      body: { requireConfirmation: true },
    });
    expect(patched.status).toBe(200);
    const email = uniqueEmail('strict');
    const added = await addMember(owner, strict.id, { email, consent: true });
    expect(added.status).toBe('pending');
    const row = await env.DB.prepare('SELECT consent_at FROM members WHERE id = ?1')
      .bind(added.id)
      .first<{ consent_at: number | null }>();
    expect(row?.consent_at).toBeNull();
    const mail = await json<{ data: { category: string } }>(
      await call('GET', `/__dev/mail/latest.json?to=${encodeURIComponent(email)}`),
    );
    expect(mail.data.category).toBe('confirm');
  });

  it('offers signup steps only with their flag on', async () => {
    const channel = await createChannel(owner);
    const patch = () =>
      call('PATCH', `/api/v1/channels/${channel.id}`, {
        cookie: owner.cookie,
        body: { signupPath: 'email_name_plan' },
      });
    expect((await patch()).status).toBe(404);
    await enableFlag('signup_paths', owner.workspaceId, channel.id);
    const res = await patch();
    expect(res.status).toBe(200);
    expect((await json<{ data: { signupPath: string } }>(res)).data.signupPath).toBe(
      'email_name_plan',
    );
  });

  it('treats addresses case-insensitively', async () => {
    const email = uniqueEmail('Case');
    await addMember(owner, channelId, { email });
    const dup = await call('POST', `/api/v1/channels/${channelId}/members`, {
      cookie: owner.cookie,
      body: { email: email.toUpperCase() },
    });
    expect(dup.status).toBe(409);
  });

  it('creates missing tags by name and reuses existing ones regardless of case', async () => {
    const a = await addMember(owner, channelId, { tags: ['Weekly Readers', 'VIP'] });
    expect(a.tags).toEqual(['VIP', 'Weekly Readers']);
    const b = await addMember(owner, channelId, { tags: ['vip'] });
    expect(b.tags).toEqual(['VIP']);
    const tags = await data<Tag[]>(
      await call('GET', `/api/v1/channels/${channelId}/tags`, { cookie: owner.cookie }),
    );
    expect(tags.find((t) => t.name === 'VIP')?.memberCount).toBe(2);
  });
});

describe('member state machine', () => {
  const cases = MEMBER_STATUSES.flatMap((from) =>
    MEMBER_STATUSES.filter((to) => to !== from).map((to) => ({ from, to })),
  );
  for (const { from, to } of cases) {
    const allowed = canTransition(from, to, 'operator');
    it(`${from} → ${to} is ${allowed ? 'allowed' : 'refused with 409'}`, async () => {
      const member = await addMember(owner, channelId);
      await setStatus(member.id, from, from === 'paused' ? Date.now() + 86_400_000 : null);
      const res = await patch(member.id, { status: to });
      if (allowed) {
        const updated = await data<MemberDetail>(res);
        expect(updated.status).toBe(to);
      } else {
        expect(res.status).toBe(409);
        const body = await json<{ error: { code: string; message: string } }>(res);
        expect(body.error.code).toBe('conflict');
        expect(body.error.message.length).toBeGreaterThan(10);
        const row = await env.DB.prepare('SELECT status FROM members WHERE id = ?1')
          .bind(member.id)
          .first<{ status: string }>();
        expect(row?.status).toBe(from);
      }
    });
  }

  it('keeps an unsubscribed address from coming back active by deleting and re-adding it', async () => {
    const member = await addMember(owner, channelId);
    await setStatus(member.id, 'unsubscribed');
    const gone = await call('DELETE', `/api/v1/members/${member.id}`, { cookie: owner.cookie });
    expect(gone.status).toBe(204);
    const again = await data<MemberDetail>(
      await call('POST', `/api/v1/channels/${channelId}/members`, {
        cookie: owner.cookie,
        body: { email: member.email, consent: true },
      }),
      201,
    );
    expect(again.status).toBe('pending');

    // Someone who never unsubscribed is unaffected.
    const stayer = await addMember(owner, channelId);
    await call('DELETE', `/api/v1/members/${stayer.id}`, { cookie: owner.cookie });
    const back = await data<MemberDetail>(
      await call('POST', `/api/v1/channels/${channelId}/members`, {
        cookie: owner.cookie,
        body: { email: stayer.email, consent: true },
      }),
      201,
    );
    expect(back.status).toBe('active');
  });

  it('takes a signed-in reader’s metered reads with them when deleted', async () => {
    const member = await addMember(owner, channelId);
    const dispatchId = `dp_${crypto.randomUUID().replace(/-/g, '')}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at)
         VALUES (?1, ?2, 'S', '{}', 'sent', 0, 0)`,
      ).bind(dispatchId, channelId),
      env.DB.prepare(
        `INSERT INTO gate_meter_reads (channel_id, reader_key, period, dispatch_id, read_at)
         VALUES (?1, ?2, '2026-10', ?3, 0)`,
      ).bind(channelId, member.id, dispatchId),
    ]);
    expect(
      (await call('DELETE', `/api/v1/members/${member.id}`, { cookie: owner.cookie })).status,
    ).toBe(204);
    expect(
      await env.DB.prepare('SELECT count(*) AS n FROM gate_meter_reads WHERE reader_key = ?1')
        .bind(member.id)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });

  it('explains why an unsubscribed Member can’t be reactivated', async () => {
    const member = await addMember(owner, channelId);
    await setStatus(member.id, 'unsubscribed');
    const res = await patch(member.id, { status: 'active' });
    expect((await json<{ error: { message: string } }>(res)).error.message).toMatch(
      /Only the subscriber/,
    );
  });

  it('pauses for four weeks by default, or until a given date, and clears it on resume', async () => {
    const member = await addMember(owner, channelId);
    const paused = await data<MemberDetail>(await patch(member.id, { status: 'paused' }));
    const days = (Date.parse(paused.pausedUntil!) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(27.9);
    expect(days).toBeLessThan(28.1);

    const until = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const moved = await data<MemberDetail>(
      await patch(member.id, { status: 'paused', pausedUntil: until }),
    );
    expect(moved.pausedUntil).toBe(until);

    const resumed = await data<MemberDetail>(await patch(member.id, { status: 'active' }));
    expect(resumed.pausedUntil).toBeNull();
  });

  it('refuses pause dates in the past or without the paused status', async () => {
    const member = await addMember(owner, channelId);
    const past = new Date(Date.now() - 1000).toISOString();
    expect((await patch(member.id, { status: 'paused', pausedUntil: past })).status).toBe(400);
    expect(
      (await patch(member.id, { pausedUntil: new Date(Date.now() + 1e6).toISOString() })).status,
    ).toBe(400);
  });

  it('records the unsubscribe time', async () => {
    const member = await addMember(owner, channelId);
    const out = await data<MemberDetail>(await patch(member.id, { status: 'unsubscribed' }));
    expect(out.unsubscribedAt).not.toBeNull();
  });
});

describe('editing Members', () => {
  it('refuses a digest change while the digest flag is off, and changes nothing', async () => {
    const member = await addMember(owner, channelId, { firstName: 'Ada' });
    const refused = await patch(member.id, { firstName: 'Grace', digest: 'weekly' });
    expect(refused.status).toBe(404);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'feature_disabled',
    );
    const after = await data<MemberDetail>(
      await call('GET', `/api/v1/members/${member.id}`, { cookie: owner.cookie }),
    );
    expect(after).toMatchObject({ firstName: 'Ada', digest: member.digest });
  });

  it('replaces tags, edits names and digest', async () => {
    await enableFlag('digest', owner.workspaceId, channelId);
    const member = await addMember(owner, channelId, { tags: ['a', 'b'] });
    const updated = await data<MemberDetail>(
      await patch(member.id, {
        tags: ['b', 'c'],
        firstName: 'Grace',
        lastName: '',
        digest: 'weekly',
      }),
    );
    expect(updated).toMatchObject({
      tags: ['b', 'c'],
      firstName: 'Grace',
      lastName: null,
      digest: 'weekly',
    });
  });
});

describe('profile fields', () => {
  let plan: MemberField;
  let interests: MemberField;
  let secret: MemberField;
  beforeAll(async () => {
    plan = await addField(owner, channelId, {
      key: 'plan',
      label: 'Plan',
      type: 'select',
      options: ['Weekly', 'Monthly'],
    });
    interests = await addField(owner, channelId, {
      key: 'interests',
      label: 'Interests',
      type: 'multi_select',
      options: ['Bees', 'Honey', 'Wax'],
    });
    secret = await addField(owner, channelId, {
      key: 'tax_id',
      label: 'Tax id',
      type: 'text',
      encrypted: true,
    });
    await addField(owner, channelId, { key: 'age', label: 'Age', type: 'number' });
    await addField(owner, channelId, { key: 'birthday', label: 'Birthday', type: 'date' });
  });

  it('validates values against the field type and round-trips encrypted values', async () => {
    const member = await addMember(owner, channelId, {
      fields: {
        plan: 'weekly',
        interests: ['wax', 'Bees'],
        tax_id: 'DE123',
        age: '42',
        birthday: '1990-02-28',
      },
    });
    expect(member.fields).toEqual({
      plan: 'Weekly',
      interests: ['Bees', 'Wax'],
      tax_id: 'DE123',
      age: 42,
      birthday: '1990-02-28',
    });
    const stored = await env.DB.prepare(
      'SELECT value_text, value_enc FROM member_field_values WHERE member_id = ?1 AND field_id = ?2',
    )
      .bind(member.id, secret.id)
      .first<{ value_text: string | null; value_enc: string }>();
    expect(stored?.value_text).toBeNull();
    expect(stored?.value_enc).not.toContain('DE123');

    const read = await data<MemberDetail>(
      await call('GET', `/api/v1/members/${member.id}`, { cookie: owner.cookie }),
    );
    expect(read.fields.tax_id).toBe('DE123');

    const cleared = await data<MemberDetail>(
      await patch(member.id, { fields: { tax_id: null, age: 43 } }),
    );
    expect(cleared.fields).toEqual({
      plan: 'Weekly',
      interests: ['Bees', 'Wax'],
      age: 43,
      birthday: '1990-02-28',
    });
  });

  it('adds the asked-for profile field columns to the Member list, decrypted', async () => {
    const member = await addMember(owner, channelId, {
      fields: { plan: 'monthly', tax_id: 'FR999', age: '7' },
    });
    const list = await data<{ items: MemberListItem[] }>(
      await call('GET', `/api/v1/channels/${channelId}/members?limit=100&fields=plan,tax_id`, {
        cookie: owner.cookie,
      }),
    );
    const row = list.items.find((m) => m.id === member.id)!;
    // Only the columns asked for; an encrypted one comes back readable, like the detail.
    expect(row.fields).toEqual({ plan: 'Monthly', tax_id: 'FR999' });
    expect(list.items.every((m) => m.fields !== undefined)).toBe(true);

    const plain = await data<{ items: MemberListItem[] }>(
      await call('GET', `/api/v1/channels/${channelId}/members?limit=1`, { cookie: owner.cookie }),
    );
    expect(plain.items[0]!.fields).toBeUndefined();

    const unknown = await call('GET', `/api/v1/channels/${channelId}/members?fields=plan,nope`, {
      cookie: owner.cookie,
    });
    expect(unknown.status).toBe(400);
    const many = Array.from({ length: 21 }, (_, i) => `k${i}`).join(',');
    expect(
      (
        await call('GET', `/api/v1/channels/${channelId}/members?fields=${many}`, {
          cookie: owner.cookie,
        })
      ).status,
    ).toBe(400);
  });

  for (const [fields, path] of [
    [{ plan: 'Yearly' }, 'fields.plan'],
    [{ age: 'old' }, 'fields.age'],
    [{ birthday: '2026-02-30' }, 'fields.birthday'],
    [{ nope: 'x' }, 'fields.nope'],
  ] as const) {
    it(`refuses ${JSON.stringify(fields)}`, async () => {
      const res = await call('POST', `/api/v1/channels/${channelId}/members`, {
        cookie: owner.cookie,
        body: { email: uniqueEmail(), fields },
      });
      expect(res.status).toBe(400);
      const body = await json<{ error: { details: { path: string }[] } }>(res);
      expect(body.error.details[0]?.path).toBe(path);
    });
  }

  it('keeps keys unique and type and encryption fixed', async () => {
    const dup = await call('POST', `/api/v1/channels/${channelId}/member-fields`, {
      cookie: owner.cookie,
      body: { key: 'plan', label: 'Again', type: 'text' },
    });
    expect(dup.status).toBe(409);
    const noChoices = await call('POST', `/api/v1/channels/${channelId}/member-fields`, {
      cookie: owner.cookie,
      body: { key: 'tier', label: 'Tier', type: 'select' },
    });
    expect(noChoices.status).toBe(400);
    const retype = await call('PATCH', `/api/v1/member-fields/${plan.id}`, {
      cookie: owner.cookie,
      body: { type: 'text' },
    });
    expect(retype.status).toBe(409);
    const decrypt = await call('PATCH', `/api/v1/member-fields/${secret.id}`, {
      cookie: owner.cookie,
      body: { encrypted: false },
    });
    expect(decrypt.status).toBe(409);
    const same = await call('PATCH', `/api/v1/member-fields/${plan.id}`, {
      cookie: owner.cookie,
      body: { type: 'select', label: 'Plan name', position: 9 },
    });
    expect((await data<MemberField>(same)).label).toBe('Plan name');
  });

  it('refuses to remove a choice Members hold, and allows removing unused ones', async () => {
    await addMember(owner, channelId, { fields: { interests: ['Honey'] } });
    const inUse = await call('PATCH', `/api/v1/member-fields/${interests.id}`, {
      cookie: owner.cookie,
      body: { options: ['Bees', 'Wax'] },
    });
    expect(inUse.status).toBe(409);
    expect((await json<{ error: { message: string } }>(inUse)).error.message).toMatch(/Honey/);
    const added = await data<MemberField>(
      await call('PATCH', `/api/v1/member-fields/${interests.id}`, {
        cookie: owner.cookie,
        body: { options: ['Bees', 'Honey', 'Wax', 'Pollen'] },
      }),
    );
    expect(added.options).toEqual(['Bees', 'Honey', 'Wax', 'Pollen']);
    const removed = await data<MemberField>(
      await call('PATCH', `/api/v1/member-fields/${interests.id}`, {
        cookie: owner.cookie,
        body: { options: ['Bees', 'Honey', 'Wax'] },
      }),
    );
    expect(removed.options).toHaveLength(3);
  });

  it('erases values when a field is removed, and frees its key', async () => {
    const temp = await addField(owner, channelId, { key: 'temp', type: 'text' });
    const member = await addMember(owner, channelId, { fields: { temp: 'x' } });
    expect(
      (await call('DELETE', `/api/v1/member-fields/${temp.id}`, { cookie: owner.cookie })).status,
    ).toBe(204);
    const values = await env.DB.prepare(
      'SELECT count(*) AS n FROM member_field_values WHERE field_id = ?1',
    )
      .bind(temp.id)
      .first<{ n: number }>();
    expect(values?.n).toBe(0);
    const read = await data<MemberDetail>(
      await call('GET', `/api/v1/members/${member.id}`, { cookie: owner.cookie }),
    );
    expect(read.fields.temp).toBeUndefined();
    await addField(owner, channelId, { key: 'temp', type: 'number' });
    expect(
      (
        await call('PATCH', `/api/v1/member-fields/${temp.id}`, {
          cookie: owner.cookie,
          body: { label: 'x' },
        })
      ).status,
    ).toBe(404);
  });
});

describe('search and filters', () => {
  let ch: string;
  beforeAll(async () => {
    ch = (await createChannel(owner)).id;
    await addMember(owner, ch, {
      firstName: 'under_score',
      email: 'one@example.com',
      tags: ['north'],
    });
    await addMember(owner, ch, { firstName: 'underXscore', email: 'two@example.com' });
    await addMember(owner, ch, { firstName: '50% off', email: 'three@example.com' });
    await addMember(owner, ch, {
      firstName: 'Hey!',
      lastName: 'Lovelace',
      email: 'four@example.com',
      tags: ['North'],
    });
    await addMember(owner, ch, { email: 'pending@example.com', consent: undefined });
  });

  const search = async (query: string) =>
    (
      await data<{ items: Member[] }>(
        await call('GET', `/api/v1/channels/${ch}/members?${query}`, { cookie: owner.cookie }),
      )
    ).items
      .map((m) => m.email)
      .sort();

  it('escapes LIKE wildcards in the search', async () => {
    expect(await search('q=under_')).toEqual(['one@example.com']);
    expect(await search('q=%25')).toEqual(['three@example.com']);
    expect(await search('q=!')).toEqual(['four@example.com']);
    expect(await search('q=LOVELACE')).toEqual(['four@example.com']);
    expect(await search('q=TWO%40')).toEqual(['two@example.com']);
  });

  it('filters by status and tag name', async () => {
    expect(await search('status=pending')).toEqual(['pending@example.com']);
    expect(await search('tag=north')).toEqual(['four@example.com', 'one@example.com']);
    expect(await search('tag=north&q=hey')).toEqual(['four@example.com']);
    expect(await search('tag=nobody')).toEqual([]);
  });
});

describe('member detail and activity', () => {
  it('names the forms a Member sent, the one they joined from and any later one', async () => {
    const channelId = (await createChannel(owner)).id;
    const member = await addMember(owner, channelId);
    const formId = newId('captureForm');
    const later = Date.now() + 5000;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO capture_forms (id, workspace_id, channel_id, name, status, draft_config_json, created_at, updated_at)
         SELECT ?1, workspace_id, id, 'Footer form', 'draft', '{}', 0, 0 FROM channels WHERE id = ?2`,
      ).bind(formId, channelId),
      env.DB.prepare('UPDATE members SET form_id = ?1 WHERE id = ?2').bind(formId, member.id),
      env.DB.prepare(
        `INSERT INTO member_events (channel_id, member_id, type, payload_json, created_at)
         VALUES (?1, ?2, 'form_submitted', json_object('formId', ?3, 'created', 1), ?4),
                (?1, ?2, 'form_submitted', json_object('formId', ?3, 'created', 0), ?5)`,
      ).bind(channelId, member.id, formId, later - 1000, later),
    ]);
    const activity = await data<MemberActivity[]>(
      await call('GET', `/api/v1/members/${member.id}/activity`, { cookie: owner.cookie }),
    );
    expect(activity.map((a) => a.type)).toEqual(['form', 'joined']);
    expect(activity[0]).toMatchObject({ formId, formName: 'Footer form' });
    expect(activity[1]).toMatchObject({ formId, formName: 'Footer form' });
  });

  it('shows deliveries, opens, clicks and joining, newest first; delete erases the address', async () => {
    const member = await addMember(owner, channelId);
    const t = Date.now() + 10_000;
    const { broadcastId, deliveryId } = await seedDelivery(
      owner.workspaceId,
      channelId,
      member.id,
      member.email,
      t,
    );
    const activity = await data<MemberActivity[]>(
      await call('GET', `/api/v1/members/${member.id}/activity`, { cookie: owner.cookie }),
    );
    expect(activity.map((a) => a.type)).toEqual(['click', 'open', 'delivery', 'joined']);
    expect(activity.at(-1)).toMatchObject({ formId: null, formName: null });
    expect(activity[0]).toMatchObject({
      broadcastId,
      subject: 'Issue 7',
      url: 'https://example.com/read',
    });

    const detail = await data<MemberDetail>(
      await call('GET', `/api/v1/members/${member.id}`, { cookie: owner.cookie }),
    );
    expect(detail).toMatchObject({ source: {}, formId: null, referralCount: 0 });

    expect(
      (await call('DELETE', `/api/v1/members/${member.id}`, { cookie: owner.cookie })).status,
    ).toBe(204);
    const delivery = await env.DB.prepare('SELECT email, member_id FROM deliveries WHERE id = ?1')
      .bind(deliveryId)
      .first<{ email: string; member_id: string | null }>();
    expect(delivery).toEqual({ email: 'deleted', member_id: null });
  });
});

describe('tags', () => {
  it('creates, renames, refuses duplicates and deletes', async () => {
    const make = (name: string) =>
      call('POST', `/api/v1/channels/${channelId}/tags`, { cookie: owner.cookie, body: { name } });
    const tag = await data<Tag>(await make('Readers'), 201);
    expect((await make('readers')).status).toBe(409);
    await data<Tag>(await make('Writers'), 201);
    const clash = await call('PATCH', `/api/v1/tags/${tag.id}`, {
      cookie: owner.cookie,
      body: { name: 'WRITERS' },
    });
    expect(clash.status).toBe(409);
    const renamed = await data<Tag>(
      await call('PATCH', `/api/v1/tags/${tag.id}`, {
        cookie: owner.cookie,
        body: { name: 'Listeners' },
      }),
    );
    expect(renamed.name).toBe('Listeners');
    const member = await addMember(owner, channelId, { tags: ['Listeners'] });
    expect((await call('DELETE', `/api/v1/tags/${tag.id}`, { cookie: owner.cookie })).status).toBe(
      204,
    );
    const read = await data<MemberDetail>(
      await call('GET', `/api/v1/members/${member.id}`, { cookie: owner.cookie }),
    );
    expect(read.tags).toEqual([]);
  });
});
