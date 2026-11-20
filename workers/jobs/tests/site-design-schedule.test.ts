// Scheduled publishing of website designs (docs/site-themes.md, "Draft, preview, publish"): the
// five-minute cron publishes a due snapshot exactly as Publish does, once, and leaves the live
// design alone when the snapshot fails its check.
import { env } from 'cloudflare:test';
import { newId, type SiteDesign } from '@swarm/domain';
import { publishSiteDesign } from '@swarm/engine/site-design';
import { describe, expect, it } from 'vitest';
import { claimDueSchedules, publishDueSiteDesigns } from '../src/handlers/siteDesign';
import { runScheduled } from '../src/index';
import { count, jobsEnv, one, seedChannel } from './helpers';

const MINUTE = 60_000;
const FIVE_MINUTE_CRON = '*/5 * * * *';

const design = (heading: string, overrides: Partial<SiteDesign> = {}): SiteDesign => ({
  theme: 'launch',
  files: null,
  settings: { accent: '#2f5d50' },
  sections: [
    {
      id: 'hero-1',
      type: 'hero',
      settings: { heading },
      experiment: {
        id: 'exp-1',
        status: 'running',
        variantB: { heading: `${heading}, B` },
        startedAt: '2026-11-01T08:00:00.000Z',
      },
    },
  ],
  ...overrides,
});
const broken: SiteDesign = {
  theme: 'launch',
  files: null,
  settings: {},
  sections: [{ id: 'n', type: 'nope', settings: {} }],
};

async function seed(options: { flag?: boolean; live?: SiteDesign } = {}) {
  const { workspaceId, channelId } = await seedChannel();
  const operatorId = newId('operator', Date.now());
  await env.DB.prepare(
    'INSERT INTO operators (id, email, created_at, updated_at) VALUES (?1, ?2, 0, 0)',
  )
    .bind(operatorId, `${operatorId}@example.com`)
    .run();
  if (options.flag !== false) {
    await env.DB.prepare(
      `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at) VALUES (?1, 'site_templates', 'channel', ?2, 1, 0)`,
    )
      .bind(`ff_${crypto.randomUUID().replace(/-/g, '')}`, channelId)
      .run();
    await env.CACHE.delete(`flags:v1:${workspaceId}:${channelId}`);
  }
  const live = options.live ? JSON.stringify(options.live) : null;
  // The draft as it is now: a later edit than the snapshot.
  await env.DB.prepare(
    `INSERT INTO site_designs (channel_id, draft_json, draft_updated_at, published_json,
       published_version, published_at, published_tests)
     VALUES (?1, ?2, 0, ?3, ?4, ?5, '[]')`,
  )
    .bind(
      channelId,
      JSON.stringify(design('Edited after scheduling')),
      live,
      live ? 1 : 0,
      live ? 0 : null,
    )
    .run();
  await env.DB.prepare(
    `INSERT INTO site_settings (channel_id, cache_version, updated_at) VALUES (?1, 7, 0)`,
  )
    .bind(channelId)
    .run();
  return { workspaceId, channelId, operatorId };
}

async function scheduleAt(channelId: string, operatorId: string, at: number, snapshot: SiteDesign) {
  await env.DB.prepare(
    `INSERT INTO site_design_schedules (channel_id, design_json, publish_at, scheduled_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(channelId, JSON.stringify(snapshot), at, operatorId, at - 60 * MINUTE)
    .run();
}

const designRow = (channelId: string) =>
  one<{
    published_json: string | null;
    published_version: number;
    published_by: string | null;
    published_at: number | null;
    published_tests: string | null;
    draft_json: string;
  }>(
    `SELECT published_json, published_version, published_by, published_at, published_tests, draft_json
       FROM site_designs WHERE channel_id = ?1`,
    channelId,
  );
const cacheVersion = async (channelId: string) =>
  (
    await one<{ cache_version: number }>(
      'SELECT cache_version FROM site_settings WHERE channel_id = ?1',
      channelId,
    )
  )?.cache_version;
const scheduleOf = (channelId: string) =>
  one<{ status: string; problems_json: string | null; claim_token: string | null }>(
    'SELECT status, problems_json, claim_token FROM site_design_schedules WHERE channel_id = ?1',
    channelId,
  );

describe('scheduled website designs', () => {
  it('publishes the snapshot at its time and not before, exactly as Publish would', async () => {
    const { env: jobs } = jobsEnv();
    const { workspaceId, channelId, operatorId } = await seed();
    const at = Date.now() + 30 * MINUTE;
    await scheduleAt(channelId, operatorId, at, design('Scheduled'));

    // A minute early: nothing happens.
    await runScheduled(jobs, FIVE_MINUTE_CRON, at - MINUTE);
    expect((await designRow(channelId))?.published_json).toBeNull();
    expect(await cacheVersion(channelId)).toBe(7);
    expect((await scheduleOf(channelId))?.status).toBe('scheduled');

    // At the time: the snapshot, not the draft edited since.
    await runScheduled(jobs, FIVE_MINUTE_CRON, at + 2 * MINUTE);
    const row = await designRow(channelId);
    expect(JSON.parse(row!.published_json!)).toEqual(design('Scheduled'));
    expect(JSON.parse(row!.draft_json)).toEqual(design('Edited after scheduling'));
    expect(row?.published_version).toBe(1);
    expect(row?.published_by).toBe(operatorId);
    expect(row?.published_at).toBe(at + 2 * MINUTE);
    // The running A/B test, for the site to give views their variants.
    expect(JSON.parse(row!.published_tests!)).toEqual(['hero-1']);
    expect(await cacheVersion(channelId)).toBe(8);
    // The schedule is done.
    expect(await scheduleOf(channelId)).toBeNull();

    // A version, by the person who scheduled it.
    const version = await one<{ id: string; design_json: string; published_by: string }>(
      'SELECT id, design_json, published_by FROM site_design_versions WHERE channel_id = ?1',
      channelId,
    );
    expect(JSON.parse(version!.design_json)).toEqual(design('Scheduled'));
    expect(version?.published_by).toBe(operatorId);

    // The audit entry: the person who scheduled it, with a note that it was scheduled.
    const audit = await one<{ actor_operator_id: string; metadata_json: string }>(
      `SELECT actor_operator_id, metadata_json FROM audit_events
        WHERE workspace_id = ?1 AND action = 'site.design_published' AND target_id = ?2`,
      workspaceId,
      channelId,
    );
    expect(audit?.actor_operator_id).toBe(operatorId);
    expect(JSON.parse(audit!.metadata_json)).toMatchObject({
      versionId: version!.id,
      theme: 'launch',
      scheduled: true,
      scheduledFor: new Date(at).toISOString(),
    });

    // A later run publishes nothing more.
    await runScheduled(jobs, FIVE_MINUTE_CRON, at + 7 * MINUTE);
    expect((await designRow(channelId))?.published_version).toBe(1);
    expect(await cacheVersion(channelId)).toBe(8);
  });

  it('publishes once when runs overlap', async () => {
    const { env: jobs } = jobsEnv();
    const { channelId, operatorId } = await seed();
    const at = Date.now() - MINUTE;
    await scheduleAt(channelId, operatorId, at, design('Once'));
    const now = Date.now();
    const results = await Promise.all([
      publishDueSiteDesigns(jobs, now),
      publishDueSiteDesigns(jobs, now),
      publishDueSiteDesigns(jobs, now),
    ]);
    const mine = await count(
      'SELECT count(*) AS n FROM site_design_versions WHERE channel_id = ?1',
      channelId,
    );
    expect(mine).toBe(1);
    expect((await designRow(channelId))?.published_version).toBe(1);
    expect(await cacheVersion(channelId)).toBe(8);
    expect(
      await count(
        `SELECT count(*) AS n FROM audit_events WHERE action = 'site.design_published' AND target_id = ?1`,
        channelId,
      ),
    ).toBe(1);
    expect(results.reduce((n, r) => n + r.published, 0)).toBeGreaterThanOrEqual(1);
  });

  it('never takes a schedule another run holds, and writes nothing on a lost claim', async () => {
    const { channelId, operatorId } = await seed();
    const at = Date.now() - MINUTE;
    await scheduleAt(channelId, operatorId, at, design('Held'));
    const now = Date.now();
    const first = await claimDueSchedules(env.DB, 'run-a', now);
    expect(first.map((r) => r.channel_id)).toContain(channelId);
    // While run A's lease lasts, run B gets nothing for this Channel.
    const second = await claimDueSchedules(env.DB, 'run-b', now + MINUTE);
    expect(second.map((r) => r.channel_id)).not.toContain(channelId);
    // Run A died; after the lease another run takes it, and A's late batch writes nothing.
    const third = await claimDueSchedules(env.DB, 'run-c', now + 11 * MINUTE);
    expect(third.map((r) => r.channel_id)).toContain(channelId);
    const { workspace_id } = (await one<{ workspace_id: string }>(
      'SELECT workspace_id FROM channels WHERE id = ?1',
      channelId,
    ))!;
    const late = await publishSiteDesign(env.DB, {
      channelId,
      workspaceId: workspace_id,
      design: design('Held'),
      operatorId,
      now: now + 12 * MINUTE,
      schedule: { token: 'run-a', publishAt: at },
    });
    expect(late.status).toBe('lost');
    expect((await designRow(channelId))?.published_json).toBeNull();
    expect(await cacheVersion(channelId)).toBe(7);
    expect(
      await count(
        'SELECT count(*) AS n FROM site_design_versions WHERE channel_id = ?1',
        channelId,
      ),
    ).toBe(0);
    expect((await scheduleOf(channelId))?.claim_token).toBe('run-c');
    // Run C goes on to publish it.
    const done = await publishSiteDesign(env.DB, {
      channelId,
      workspaceId: workspace_id,
      design: design('Held'),
      operatorId,
      now: now + 12 * MINUTE,
      schedule: { token: 'run-c', publishAt: at },
    });
    expect(done.status).toBe('published');
    expect(await scheduleOf(channelId)).toBeNull();
  });

  it('marks the schedule failed with the problems and leaves the live design untouched', async () => {
    const { env: jobs } = jobsEnv();
    const live = design('Live now');
    const { workspaceId, channelId, operatorId } = await seed({ live });
    const at = Date.now() - MINUTE;
    await scheduleAt(channelId, operatorId, at, broken);
    const result = await publishDueSiteDesigns(jobs, Date.now());
    expect(result.failed).toBeGreaterThanOrEqual(1);

    const row = await designRow(channelId);
    expect(JSON.parse(row!.published_json!)).toEqual(live);
    expect(row?.published_version).toBe(1);
    expect(await cacheVersion(channelId)).toBe(7);
    expect(
      await count(
        'SELECT count(*) AS n FROM site_design_versions WHERE channel_id = ?1',
        channelId,
      ),
    ).toBe(0);

    const schedule = await scheduleOf(channelId);
    expect(schedule?.status).toBe('failed');
    expect(schedule?.claim_token).toBeNull();
    const problems = JSON.parse(schedule!.problems_json!) as { message: string }[];
    expect(problems.map((p) => p.message)).toEqual(
      expect.arrayContaining([expect.stringMatching(/no “nope” section/)]),
    );
    expect(
      await count(
        `SELECT count(*) AS n FROM audit_events
          WHERE workspace_id = ?1 AND action = 'site.design_schedule_failed' AND target_id = ?2`,
        workspaceId,
        channelId,
      ),
    ).toBe(1);

    // A failed schedule stays until someone dismisses it; the cron doesn't try it again.
    await publishDueSiteDesigns(jobs, Date.now() + 10 * MINUTE);
    expect((await scheduleOf(channelId))?.status).toBe('failed');
    expect(JSON.parse((await designRow(channelId))!.published_json!)).toEqual(live);
  });

  it('never publishes a cancelled schedule', async () => {
    const { env: jobs } = jobsEnv();
    const { channelId, operatorId } = await seed();
    await scheduleAt(channelId, operatorId, Date.now() - MINUTE, design('Cancelled'));
    await env.DB.prepare(
      `UPDATE site_design_schedules SET status = 'cancelled', cancelled_at = ?2 WHERE channel_id = ?1`,
    )
      .bind(channelId, Date.now())
      .run();
    await publishDueSiteDesigns(jobs, Date.now());
    expect((await designRow(channelId))?.published_json).toBeNull();
    expect((await scheduleOf(channelId))?.status).toBe('cancelled');
  });

  it('fails instead of publishing when website themes are off for the publication', async () => {
    const { env: jobs } = jobsEnv();
    const { channelId, operatorId } = await seed({ flag: false });
    await scheduleAt(channelId, operatorId, Date.now() - MINUTE, design('Off'));
    await publishDueSiteDesigns(jobs, Date.now());
    expect((await designRow(channelId))?.published_json).toBeNull();
    expect((await scheduleOf(channelId))?.status).toBe('failed');
  });

  it('keeps the last 20 versions when a scheduled publish adds one', async () => {
    const { env: jobs } = jobsEnv();
    const { channelId, operatorId } = await seed();
    const old = JSON.stringify(design('Old'));
    await env.DB.batch(
      Array.from({ length: 20 }, (_, i) =>
        env.DB.prepare(
          `INSERT INTO site_design_versions (id, channel_id, design_json, theme, published_at)
           VALUES (?1, ?2, ?3, 'launch', ?4)`,
        ).bind(newId('siteDesignVersion', i + 1), channelId, old, i + 1),
      ),
    );
    await scheduleAt(channelId, operatorId, Date.now() - MINUTE, design('Twenty-first'));
    await publishDueSiteDesigns(jobs, Date.now());
    expect(
      await count(
        'SELECT count(*) AS n FROM site_design_versions WHERE channel_id = ?1',
        channelId,
      ),
    ).toBe(20);
    const newest = await one<{ design_json: string }>(
      `SELECT design_json FROM site_design_versions WHERE channel_id = ?1
        ORDER BY published_at DESC LIMIT 1`,
      channelId,
    );
    expect(JSON.parse(newest!.design_json)).toEqual(design('Twenty-first'));
  });
});
