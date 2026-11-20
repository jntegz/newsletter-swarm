// Scheduled publishing of website designs (docs/site-themes.md, "Draft, preview, publish"): the
// schedule routes, their roles, tenancy and limits, and the snapshot they keep. Publishing at the
// time is the jobs worker's (workers/jobs/tests/site-design-schedule.test.ts).
import { env } from 'cloudflare:test';
import type {
  SiteDesign,
  SiteDesignRefused,
  SiteDesignSchedule,
  SiteDesignState,
} from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createChannel, json, seatAs, signIn, type Session } from './helpers';

const MINUTE = 60_000;
const DAY = 86_400_000;

const design = (accent: string, overrides: Partial<SiteDesign> = {}): SiteDesign => ({
  theme: 'launch',
  files: null,
  settings: { accent },
  sections: null,
  ...overrides,
});
const broken = design('#111111', { sections: [{ id: 'n', type: 'nope', settings: {} }] });

async function data<T>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await json<{ data: T }>(res)).data;
}

async function enableFlag(workspaceId: string, channelId: string) {
  await env.DB.prepare(
    `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at) VALUES (?1, 'site_templates', 'channel', ?2, 1, 0)`,
  )
    .bind(`ff_${crypto.randomUUID().replace(/-/g, '')}`, channelId)
    .run();
  await env.CACHE.delete(`flags:v1:${workspaceId}:${channelId}`);
}

const base = (channelId: string) => `/api/v1/channels/${channelId}/site/design`;
const inMinutes = (n: number) => new Date(Date.now() + n * MINUTE).toISOString();

const scheduleRow = (channelId: string) =>
  env.DB.prepare('SELECT * FROM site_design_schedules WHERE channel_id = ?1')
    .bind(channelId)
    .first<{ design_json: string; publish_at: number; scheduled_by: string; status: string }>();

const auditCount = async (action: string, channelId: string) =>
  (
    await env.DB.prepare(
      'SELECT count(*) AS n FROM audit_events WHERE action = ?1 AND target_id = ?2',
    )
      .bind(action, channelId)
      .first<{ n: number }>()
  )?.n ?? 0;

describe('website design: scheduled publish', () => {
  let owner: Session;
  let editor: Session;
  let viewer: Session;
  let author: Session;
  let channel: { id: string };

  beforeAll(async () => {
    owner = await signIn();
    channel = await createChannel(owner);
    await enableFlag(owner.workspaceId, channel.id);
    editor = await seatAs(owner.workspaceId, 'editor');
    viewer = await seatAs(owner.workspaceId, 'viewer');
    author = await seatAs(owner.workspaceId, 'author');
  });

  const saveDraft = (s: Session, body: SiteDesign, channelId = channel.id) =>
    call('PUT', `${base(channelId)}/draft`, { cookie: s.cookie, body });
  const schedule = (s: Session, at: string, channelId = channel.id) =>
    call('PUT', `${base(channelId)}/schedule`, { cookie: s.cookie, body: { at } });
  const cancel = (s: Session, channelId = channel.id) =>
    call('DELETE', `${base(channelId)}/schedule`, { cookie: s.cookie });
  const restore = (s: Session, channelId = channel.id) =>
    call('POST', `${base(channelId)}/schedule/restore`, { cookie: s.cookie });
  const state = async (s: Session, channelId = channel.id) =>
    data<SiteDesignState>(await call('GET', base(channelId), { cookie: s.cookie }));

  it('has no schedule to begin with', async () => {
    expect((await state(viewer)).schedule).toBeNull();
  });

  it('schedules a snapshot of the draft for editors, which viewers see', async () => {
    await data(await saveDraft(editor, design('#123456')));
    const at = inMinutes(60);
    expect((await schedule(viewer, at)).status).toBe(403);
    expect((await schedule(author, at)).status).toBe(403);
    const made = await data<SiteDesignSchedule>(await schedule(editor, at));
    expect(made).toMatchObject({
      at,
      by: editor.me.operator.id,
      status: 'scheduled',
      problems: [],
    });
    expect((await state(viewer)).schedule).toEqual(made);
    expect(await auditCount('site.design_scheduled', channel.id)).toBe(1);

    // Later edits to the draft don't change what goes live.
    await data(await saveDraft(editor, design('#654321')));
    const row = await scheduleRow(channel.id);
    expect(JSON.parse(row!.design_json)).toEqual(design('#123456'));
    expect(row!.publish_at).toBe(Date.parse(at));
    expect((await state(viewer)).draft.settings).toEqual({ accent: '#654321' });
    // Scheduling doesn't publish.
    expect((await state(viewer)).published).toBeNull();
  });

  it('replaces the schedule when scheduled again, with the draft as it is then', async () => {
    const at = inMinutes(24 * 60);
    const made = await data<SiteDesignSchedule>(await schedule(owner, at));
    expect(made.by).toBe(owner.me.operator.id);
    const rows = await env.DB.prepare(
      'SELECT count(*) AS n FROM site_design_schedules WHERE channel_id = ?1',
    )
      .bind(channel.id)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
    const row = await scheduleRow(channel.id);
    expect(JSON.parse(row!.design_json)).toEqual(design('#654321'));
    expect((await state(viewer)).schedule?.at).toBe(at);
  });

  it('refuses times under 5 minutes or over 90 days ahead, and anything not a time', async () => {
    for (const at of [
      inMinutes(4),
      new Date(Date.now() - DAY).toISOString(),
      new Date(Date.now() + 91 * DAY).toISOString(),
    ]) {
      const res = await schedule(editor, at);
      expect(res.status, at).toBe(400);
      const body = await json<{ error: { code: string; details: { path: string }[] } }>(res);
      expect(body.error.code).toBe('invalid_input');
      expect(body.error.details[0]?.path).toBe('at');
    }
    expect((await schedule(editor, 'tomorrow')).status).toBe(400);
    expect(
      (await call('PUT', `${base(channel.id)}/schedule`, { cookie: editor.cookie, body: {} }))
        .status,
    ).toBe(400);
    // Just inside both ends is fine.
    await data(await schedule(editor, inMinutes(6)));
    await data(await schedule(editor, new Date(Date.now() + 89 * DAY).toISOString()));
  });

  it('refuses to schedule while the draft has errors (422, with the problems), keeping the old one', async () => {
    const before = await scheduleRow(channel.id);
    await data(await saveDraft(editor, broken));
    const res = await schedule(editor, inMinutes(60));
    expect(res.status).toBe(422);
    const body = await json<SiteDesignRefused>(res);
    expect(body.error.code).toBe('invalid_input');
    expect(body.problems.map((p) => p.message)).toEqual(
      expect.arrayContaining([expect.stringMatching(/no “nope” section/)]),
    );
    expect(await scheduleRow(channel.id)).toEqual(before);
    await data(await saveDraft(editor, design('#654321')));
  });

  it('leaves the schedule alone when publishing by hand', async () => {
    const before = await scheduleRow(channel.id);
    await data(await call('POST', `${base(channel.id)}/publish`, { cookie: editor.cookie }));
    expect(await scheduleRow(channel.id)).toEqual(before);
    expect((await state(viewer)).schedule?.status).toBe('scheduled');
  });

  it('cancels for editors, puts it back on Undo, and answers 404 when nothing is scheduled', async () => {
    const before = (await state(viewer)).schedule;
    const snapshot = (await scheduleRow(channel.id))!.design_json;
    expect((await cancel(viewer)).status).toBe(403);
    expect((await cancel(author)).status).toBe(403);
    const res = await cancel(editor);
    expect(res.status).toBe(204);
    expect((await state(viewer)).schedule).toBeNull();
    expect(await auditCount('site.design_schedule_cancelled', channel.id)).toBe(1);
    expect((await cancel(editor)).status).toBe(404);
    // The cron never takes a cancelled one.
    expect((await scheduleRow(channel.id))?.status).toBe('cancelled');

    // Undo: the same snapshot at the same time, even after the draft changed.
    await data(await saveDraft(editor, design('#abcdef')));
    expect((await restore(viewer)).status).toBe(403);
    const back = await data<SiteDesignSchedule>(await restore(editor));
    expect(back).toEqual(before);
    expect((await scheduleRow(channel.id))!.design_json).toBe(snapshot);
    expect((await state(viewer)).schedule).toEqual(before);
    expect(await auditCount('site.design_schedule_restored', channel.id)).toBe(1);
    // Nothing cancelled now, so nothing to put back.
    expect((await restore(editor)).status).toBe(404);

    // Only for a while after cancelling.
    expect((await cancel(editor)).status).toBe(204);
    await env.DB.prepare('UPDATE site_design_schedules SET cancelled_at = ?2 WHERE channel_id = ?1')
      .bind(channel.id, Date.now() - 11 * MINUTE)
      .run();
    expect((await restore(editor)).status).toBe(404);
    expect((await state(viewer)).schedule).toBeNull();
    await data(await saveDraft(editor, design('#654321')));
  });

  it('shows a failed schedule with its problems, and clears it on cancel or a new schedule', async () => {
    await data(await schedule(editor, inMinutes(30)));
    const problems = [
      { file: 'design', line: 1, column: 1, message: 'Something broke.', severity: 'error' },
    ];
    await env.DB.prepare(
      `UPDATE site_design_schedules SET status = 'failed', problems_json = ?2, failed_at = ?3
        WHERE channel_id = ?1`,
    )
      .bind(channel.id, JSON.stringify(problems), Date.now())
      .run();
    const failed = (await state(viewer)).schedule;
    expect(failed?.status).toBe('failed');
    expect(failed?.problems).toEqual(problems);

    // Dismiss is Cancel; its Undo brings back the failure as it was.
    expect((await cancel(editor)).status).toBe(204);
    expect((await state(viewer)).schedule).toBeNull();
    expect(await data<SiteDesignSchedule>(await restore(editor))).toEqual(failed);

    // Scheduling again starts over.
    const again = await data<SiteDesignSchedule>(await schedule(editor, inMinutes(45)));
    expect(again.status).toBe('scheduled');
    const row = await env.DB.prepare(
      'SELECT status, problems_json, failed_at FROM site_design_schedules WHERE channel_id = ?1',
    )
      .bind(channel.id)
      .first();
    expect(row).toEqual({ status: 'scheduled', problems_json: null, failed_at: null });
    expect((await state(viewer)).schedule?.problems).toEqual([]);
    expect((await cancel(editor)).status).toBe(204);
  });

  it('drops a cron run’s claim when replaced, so the old snapshot can’t publish', async () => {
    await data(await schedule(editor, inMinutes(30)));
    await env.DB.prepare(
      `UPDATE site_design_schedules SET claim_token = 'old-run', claimed_until = ?2
        WHERE channel_id = ?1`,
    )
      .bind(channel.id, Date.now() + 10 * MINUTE)
      .run();
    await data(await schedule(editor, inMinutes(40)));
    const row = await env.DB.prepare(
      'SELECT claim_token, claimed_until FROM site_design_schedules WHERE channel_id = ?1',
    )
      .bind(channel.id)
      .first();
    expect(row).toEqual({ claim_token: null, claimed_until: null });
    expect((await cancel(editor)).status).toBe(204);
  });

  it('is behind the site_templates flag', async () => {
    const other = await createChannel(owner);
    for (const res of [
      await restore(owner, other.id),
      await schedule(owner, inMinutes(60), other.id),
      await cancel(owner, other.id),
    ]) {
      expect(res.status).toBe(404);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe('feature_disabled');
    }
  });

  it('answers 404 to people outside the workspace, both ways', async () => {
    await data(await schedule(editor, inMinutes(60)));
    const stranger = await signIn();
    const theirs = await createChannel(stranger);
    await enableFlag(stranger.workspaceId, theirs.id);
    expect((await schedule(stranger, inMinutes(60))).status).toBe(404);
    expect((await cancel(stranger)).status).toBe(404);
    expect((await restore(stranger)).status).toBe(404);
    expect((await call('GET', base(channel.id), { cookie: stranger.cookie })).status).toBe(404);
    // Ours is untouched.
    expect((await state(viewer)).schedule?.status).toBe('scheduled');
    // And theirs stays theirs.
    await data(await saveDraft(stranger, design('#222222'), theirs.id));
    await data(await schedule(stranger, inMinutes(60), theirs.id));
    expect((await schedule(owner, inMinutes(60), theirs.id)).status).toBe(404);
    expect((await cancel(owner, theirs.id)).status).toBe(404);
    expect((await scheduleRow(theirs.id))?.scheduled_by).toBe(stranger.me.operator.id);
  });
});
