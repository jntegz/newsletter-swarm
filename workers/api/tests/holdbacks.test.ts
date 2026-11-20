// Phase 6 send options: Split Tests, Cohort Samples, Smart Blocks on save and the "as Member X"
// preview, with flags, roles, tenancy and the Broadcast detail.
import { env } from 'cloudflare:test';
import type {
  BroadcastDetail,
  CohortSample,
  Dispatch,
  DispatchPreview,
  Member,
  Preflight,
  SplitTest,
} from '@swarm/domain';
import { newId } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { call, createChannel, seatAs, signIn } from './helpers';
import { addMember, data, enableFlag, errorCode } from './money-helpers';

const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...content: unknown[]) => ({ type: 'doc', content });
const smart = (condition: unknown, text: string, anonymous = 'hide') => ({
  type: 'smartBlock',
  attrs: { condition, anonymous, label: text },
  content: [para(text)],
});

async function setup(flags: ('split_tests' | 'cohort_sampling' | 'smart_blocks')[] = []) {
  const owner = await signIn();
  const { id: channelId } = await createChannel(owner);
  for (const flag of flags) await enableFlag(flag, owner.workspaceId, channelId);
  const dispatch = await data<Dispatch>(
    await call('POST', `/api/v1/channels/${channelId}/dispatches`, {
      cookie: owner.cookie,
      body: { subject: 'Issue A', content: doc(para('Hello {{ first_name | there }}')) },
    }),
    201,
  );
  return { owner, channelId, dispatch };
}

const splitBody = {
  variable: 'subject',
  variants: [{}, { subject: 'Issue B' }],
  testPercent: 50,
  metric: 'opens',
  windowMinutes: 60,
};

async function tag(channelId: string, memberId: string, name: string) {
  const tagId = newId('tag');
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO tags (id, channel_id, name, created_at) VALUES (?1, ?2, ?3, 0)',
    ).bind(tagId, channelId, name),
    env.DB.prepare(
      'INSERT INTO member_tags (member_id, tag_id, created_at) VALUES (?1, ?2, 0)',
    ).bind(memberId, tagId),
  ]);
}

describe('flags', () => {
  it('answers feature_disabled while the flags are off', async () => {
    const { owner, dispatch } = await setup();
    const base = `/api/v1/dispatches/${dispatch.id}`;
    for (const [method, path, body] of [
      ['GET', `${base}/split-test`, undefined],
      ['PUT', `${base}/split-test`, splitBody],
      ['DELETE', `${base}/split-test`, undefined],
      ['GET', `${base}/cohort-sample`, undefined],
      ['PUT', `${base}/cohort-sample`, {}],
      ['DELETE', `${base}/cohort-sample`, undefined],
      ['GET', `${base}/preview`, undefined],
    ] as const) {
      const res = await call(method, path, { cookie: owner.cookie, body });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await errorCode(res)).toBe('feature_disabled');
    }
    const save = await call('PATCH', base, {
      cookie: owner.cookie,
      body: { content: doc(smart({ field: 'tag', cmp: 'is_set' }, 'Tagged')) },
    });
    expect(save.status).toBe(404);
    expect(await errorCode(save)).toBe('feature_disabled');
  });
});

describe('Split Tests', () => {
  it('saves, reads, replaces and removes a Split Test', async () => {
    const { owner, dispatch } = await setup(['split_tests']);
    const path = `/api/v1/dispatches/${dispatch.id}/split-test`;
    expect((await call('GET', path, { cookie: owner.cookie })).status).toBe(404);
    const saved = await data<SplitTest>(
      await call('PUT', path, { cookie: owner.cookie, body: splitBody }),
    );
    expect(saved.status).toBe('draft');
    expect(saved.variants.map((v) => [v.label, v.subject])).toEqual([
      ['A', null],
      ['B', 'Issue B'],
    ]);
    const replaced = await data<SplitTest>(
      await call('PUT', path, {
        cookie: owner.cookie,
        body: {
          ...splitBody,
          variants: [{}, { subject: 'B' }, { subject: 'C', preheader: 'Pre C' }],
          metric: 'goal',
          goal: { event: 'link_clicked', url: 'https://x.example/a' },
        },
      }),
    );
    expect(replaced.id).toBe(saved.id);
    expect(replaced.variants).toHaveLength(3);
    expect(replaced.goal).toEqual({ event: 'link_clicked', url: 'https://x.example/a' });
    expect(
      (await data<SplitTest>(await call('GET', path, { cookie: owner.cookie }))).variants,
    ).toHaveLength(3);
    expect((await call('DELETE', path, { cookie: owner.cookie })).status).toBe(204);
    expect((await call('GET', path, { cookie: owner.cookie })).status).toBe(404);
  });

  it('validates variants, goals and gated paid Dispatches', async () => {
    const { owner, dispatch } = await setup(['split_tests']);
    const path = `/api/v1/dispatches/${dispatch.id}/split-test`;
    const put = (body: unknown) => call('PUT', path, { cookie: owner.cookie, body });
    expect(
      (await put({ ...splitBody, variants: [{ subject: 'x' }, { subject: 'B' }] })).status,
    ).toBe(400);
    expect((await put({ ...splitBody, variants: [{}, {}] })).status).toBe(400);
    expect((await put({ ...splitBody, variants: [{}] })).status).toBe(400);
    expect((await put({ ...splitBody, testPercent: 2 })).status).toBe(400);
    expect((await put({ ...splitBody, metric: 'goal' })).status).toBe(400);
    expect(
      (
        await put({
          ...splitBody,
          metric: 'goal',
          goal: { event: 'level_purchased', levelId: newId('membershipLevel') },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await put({
          ...splitBody,
          variable: 'content',
          variants: [{}, { content: doc(smart({ field: 'tag', cmp: 'is_set' }, 'x')) }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await put({
          ...splitBody,
          variable: 'content',
          variants: [{}, { content: doc(para('B')) }],
        })
      ).status,
    ).toBe(200);

    // A paid Dispatch with a gate divider: content tests are refused, subject tests are fine.
    await call('PATCH', `/api/v1/dispatches/${dispatch.id}`, {
      cookie: owner.cookie,
      body: { content: doc(para('Free'), { type: 'gate' }, para('Paid')), webVisibility: 'paid' },
    });
    const gated = await put({
      ...splitBody,
      variable: 'content',
      variants: [{}, { content: doc(para('B')) }],
    });
    expect(gated.status).toBe(400);
    expect(await gated.text()).toMatch(/paywall break/);
    expect((await put(splitBody)).status).toBe(200);
    expect(
      (await put({ ...splitBody, variants: [{}, { subject: 'B', preheader: 'Other' }] })).status,
    ).toBe(400);
  });

  it('can’t be combined with a Cohort Sample', async () => {
    const { owner, dispatch } = await setup(['split_tests', 'cohort_sampling']);
    const base = `/api/v1/dispatches/${dispatch.id}`;
    expect(
      (await call('PUT', `${base}/split-test`, { cookie: owner.cookie, body: splitBody })).status,
    ).toBe(200);
    const sample = await call('PUT', `${base}/cohort-sample`, { cookie: owner.cookie, body: {} });
    expect(sample.status).toBe(409);
    await call('DELETE', `${base}/split-test`, { cookie: owner.cookie });
    const saved = await data<CohortSample>(
      await call('PUT', `${base}/cohort-sample`, {
        cookie: owner.cookie,
        body: { samplePercent: 20 },
      }),
    );
    expect(saved).toMatchObject({
      samplePercent: 20,
      windowMinutes: 120,
      maxBounceRate: 0.05,
      maxComplaintRate: 0.001,
      maxUnsubscribeRate: 0.02,
      minOpenRate: null,
      status: 'draft',
    });
    expect(
      (await call('PUT', `${base}/split-test`, { cookie: owner.cookie, body: splitBody })).status,
    ).toBe(409);
    expect((await call('DELETE', `${base}/cohort-sample`, { cookie: owner.cookie })).status).toBe(
      204,
    );
  });

  it('applies roles and tenancy', async () => {
    const { owner, dispatch } = await setup(['split_tests']);
    const path = `/api/v1/dispatches/${dispatch.id}/split-test`;
    const viewer = await seatAs(owner.workspaceId, 'viewer');
    expect((await call('PUT', path, { cookie: viewer.cookie, body: splitBody })).status).toBe(403);
    const stranger = await signIn();
    const res = await call('GET', path, { cookie: stranger.cookie });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('not_found');
    expect((await call('PUT', path, { cookie: stranger.cookie, body: splitBody })).status).toBe(
      404,
    );
  });

  it('regression: takes a scheduled Dispatch back to draft when its author sets up a test', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    await enableFlag('split_tests', owner.workspaceId, channelId);
    await addMember(owner, channelId);
    const author = await seatAs(owner.workspaceId, 'author');
    const editor = await seatAs(owner.workspaceId, 'editor');
    const make = async (by: typeof author) => {
      const dispatch = await data<Dispatch>(
        await call('POST', `/api/v1/channels/${channelId}/dispatches`, {
          cookie: by.cookie,
          body: { subject: 'Issue A', content: doc(para('Hello')) },
        }),
        201,
      );
      const publishAt = new Date(Date.now() + 3600_000).toISOString();
      await data(
        await call('POST', `/api/v1/dispatches/${dispatch.id}/schedule`, {
          cookie: editor.cookie,
          body: { publishAt },
        }),
      );
      return { id: dispatch.id, publishAt };
    };
    const read = async (id: string) =>
      data<Dispatch>(await call('GET', `/api/v1/dispatches/${id}`, { cookie: owner.cookie }));

    const own = await make(author);
    const test = await data<SplitTest & { unscheduled?: boolean }>(
      await call('PUT', `/api/v1/dispatches/${own.id}/split-test`, {
        cookie: author.cookie,
        body: splitBody,
      }),
    );
    expect(test.unscheduled).toBe(true);
    expect(await read(own.id)).toMatchObject({ status: 'draft', publishAt: null });

    // An editor's test leaves the schedule alone.
    const theirs = await make(editor);
    await data(
      await call('PUT', `/api/v1/dispatches/${theirs.id}/split-test`, {
        cookie: editor.cookie,
        body: splitBody,
      }),
    );
    expect(await read(theirs.id)).toMatchObject({
      status: 'scheduled',
      publishAt: theirs.publishAt,
    });
  });

  it('regression: takes a scheduled Dispatch back to draft when its author removes a test or changes a sample', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    await enableFlag('split_tests', owner.workspaceId, channelId);
    await enableFlag('cohort_sampling', owner.workspaceId, channelId);
    await addMember(owner, channelId);
    const author = await seatAs(owner.workspaceId, 'author');
    const editor = await seatAs(owner.workspaceId, 'editor');
    // The author writes the Dispatch; the editor sets up the hold-back and schedules it.
    const make = async (holdback?: 'split-test' | 'cohort-sample') => {
      const dispatch = await data<Dispatch>(
        await call('POST', `/api/v1/channels/${channelId}/dispatches`, {
          cookie: author.cookie,
          body: { subject: 'Issue A', content: doc(para('Hello')) },
        }),
        201,
      );
      if (holdback) {
        await data(
          await call('PUT', `/api/v1/dispatches/${dispatch.id}/${holdback}`, {
            cookie: editor.cookie,
            body: holdback === 'split-test' ? splitBody : {},
          }),
        );
      }
      const publishAt = new Date(Date.now() + 3600_000).toISOString();
      await data(
        await call('POST', `/api/v1/dispatches/${dispatch.id}/schedule`, {
          cookie: editor.cookie,
          body: { publishAt },
        }),
      );
      return { id: dispatch.id, publishAt };
    };
    const read = async (id: string) =>
      data<Dispatch>(await call('GET', `/api/v1/dispatches/${id}`, { cookie: owner.cookie }));
    const draft = { status: 'draft', publishAt: null };

    const tested = await make('split-test');
    const removeTest = await call('DELETE', `/api/v1/dispatches/${tested.id}/split-test`, {
      cookie: author.cookie,
    });
    expect(removeTest.status).toBe(204);
    expect(await read(tested.id)).toMatchObject(draft);

    // Removing the sample also removes its bounce and complaint halt.
    const sampled = await make('cohort-sample');
    const removeSample = await call('DELETE', `/api/v1/dispatches/${sampled.id}/cohort-sample`, {
      cookie: author.cookie,
    });
    expect(removeSample.status).toBe(204);
    expect(await read(sampled.id)).toMatchObject(draft);

    const plain = await make();
    const sample = await data<CohortSample & { unscheduled?: boolean }>(
      await call('PUT', `/api/v1/dispatches/${plain.id}/cohort-sample`, {
        cookie: author.cookie,
        body: { samplePercent: 20, maxBounceRate: 0.5, maxComplaintRate: 0.5 },
      }),
    );
    expect(sample.unscheduled).toBe(true);
    expect(await read(plain.id)).toMatchObject(draft);

    // An editor's changes leave the schedule alone.
    const kept = await make('split-test');
    for (const [method, path, body] of [
      ['DELETE', 'split-test', undefined],
      ['PUT', 'cohort-sample', { samplePercent: 20 }],
      ['DELETE', 'cohort-sample', undefined],
    ] as const) {
      const res = await call(method, `/api/v1/dispatches/${kept.id}/${path}`, {
        cookie: editor.cookie,
        body,
      });
      expect(res.status, `${method} ${path}`).toBeLessThan(300);
      if (method === 'PUT') expect(await data(res)).not.toHaveProperty('unscheduled');
    }
    expect(await read(kept.id)).toMatchObject({ status: 'scheduled', publishAt: kept.publishAt });
  });

  it('shows the hold-back in the checklist and the variants on the Broadcast', async () => {
    const { owner, channelId, dispatch } = await setup(['split_tests']);
    for (let i = 0; i < 4; i++) await addMember(owner, channelId);
    await call('PUT', `/api/v1/dispatches/${dispatch.id}/split-test`, {
      cookie: owner.cookie,
      body: splitBody,
    });
    const check = await data<Preflight>(
      await call('GET', `/api/v1/dispatches/${dispatch.id}/preflight`, { cookie: owner.cookie }),
    );
    expect(check.holdBack).toEqual({ kind: 'split_test', test: 2, held: 2, variants: 2 });
    expect(check.checks.find((c) => c.key === 'test')?.ok).toBe(true);
    const { broadcastId } = await data<{ broadcastId: string }>(
      await call('POST', `/api/v1/dispatches/${dispatch.id}/send`, { cookie: owner.cookie }),
      202,
    );
    const detail = await data<BroadcastDetail>(
      await call('GET', `/api/v1/broadcasts/${broadcastId}`, { cookie: owner.cookie }),
    );
    expect(detail.cohortSample).toBeNull();
    expect(detail.splitTest?.status).toBe('testing');
    expect(detail.splitTest?.variants.map((v) => v.label)).toEqual(['A', 'B']);
    expect(detail.splitTest?.decideAt).not.toBeNull();
    // Once running, the test can't change.
    const locked = await call('PUT', `/api/v1/dispatches/${dispatch.id}/split-test`, {
      cookie: owner.cookie,
      body: splitBody,
    });
    expect(locked.status).toBe(409);
  });
});

describe('Smart Blocks', () => {
  it('refuses conditions that name another Channel’s Circle or level', async () => {
    const { owner, channelId, dispatch } = await setup(['smart_blocks']);
    const other = await createChannel(owner);
    const foreignCircle = newId('circle');
    const ownCircle = newId('circle');
    const foreignLevel = newId('membershipLevel');
    await env.DB.batch([
      ...[
        [foreignCircle, other.id],
        [ownCircle, channelId],
      ].map(([id, channel]) =>
        env.DB.prepare(
          `INSERT INTO circles (id, workspace_id, channel_id, name, rule_json, created_at, updated_at)
           VALUES (?1, ?2, ?3, 'C', '{"field":"email","cmp":"is_set"}', 0, 0)`,
        ).bind(id, owner.workspaceId, channel),
      ),
      env.DB.prepare(
        `INSERT INTO membership_levels (id, channel_id, name, created_at, updated_at) VALUES (?1, ?2, 'Gold', 0, 0)`,
      ).bind(foreignLevel, other.id),
    ]);
    const save = (condition: unknown) =>
      call('PATCH', `/api/v1/dispatches/${dispatch.id}`, {
        cookie: owner.cookie,
        body: { content: doc(smart(condition, 'Block')) },
      });
    for (const condition of [
      { field: 'circle', cmp: 'eq', value: foreignCircle },
      { field: 'level', cmp: 'in', value: [foreignLevel] },
      { field: 'nonsense', cmp: 'eq', value: 'x' },
    ]) {
      const res = await save(condition);
      expect(res.status, JSON.stringify(condition)).toBe(400);
      expect(await errorCode(res)).toBe('invalid_input');
    }
    expect((await save({ field: 'circle', cmp: 'eq', value: ownCircle })).status).toBe(200);
    // Nested Smart Blocks are refused by the renderer.
    const nested = await call('PATCH', `/api/v1/dispatches/${dispatch.id}`, {
      cookie: owner.cookie,
      body: {
        content: doc({
          type: 'smartBlock',
          attrs: { condition: { field: 'tag', cmp: 'is_set' } },
          content: [smart({ field: 'tag', cmp: 'is_set' }, 'x')],
        }),
      },
    });
    expect(nested.status).toBe(400);
  });

  it('previews the email as a Member', async () => {
    const { owner, channelId, dispatch } = await setup(['smart_blocks']);
    const vip = await addMember(owner, channelId);
    const plain: Member = await addMember(owner, channelId);
    await tag(channelId, vip.id, 'VIP');
    await call('PATCH', `/api/v1/dispatches/${dispatch.id}`, {
      cookie: owner.cookie,
      body: {
        content: doc(
          para('Hello'),
          smart({ field: 'tag', cmp: 'eq', value: 'VIP' }, 'For VIPs'),
          smart({ field: 'tag', cmp: 'neq', value: 'VIP' }, 'Become a VIP', 'show'),
        ),
      },
    });
    const preview = (memberId?: string) =>
      call(
        'GET',
        `/api/v1/dispatches/${dispatch.id}/preview${memberId ? `?memberId=${memberId}` : ''}`,
        { cookie: owner.cookie },
      );
    const asVip = await data<DispatchPreview>(await preview(vip.id));
    expect(asVip.html).toContain('For VIPs');
    expect(asVip.html).not.toContain('Become a VIP');
    expect(asVip.text).not.toContain('swarm:sb');
    expect(asVip.smartBlocks).toEqual([
      { index: 0, label: 'For VIPs', visible: true },
      { index: 1, label: 'Become a VIP', visible: false },
    ]);
    const asPlain = await data<DispatchPreview>(await preview(plain.id));
    expect(asPlain.html).not.toContain('For VIPs');
    expect(asPlain.html).toContain('Become a VIP');
    const everyone = await data<DispatchPreview>(await preview());
    expect(everyone.html).toContain('For VIPs');
    expect(everyone.html).toContain('Become a VIP');
    expect(everyone.memberId).toBeNull();
    // A Member of another Channel can't be previewed.
    const otherOwner = await signIn();
    const { id: otherChannel } = await createChannel(otherOwner);
    const stranger = await addMember(otherOwner, otherChannel);
    expect((await preview(stranger.id)).status).toBe(400);
  });
});
