// Funnel Explorer API (Phase 6): totals, conversion, cuts, lookback by plan, roles and tenancy.
import { env } from 'cloudflare:test';
import { newId, type Funnel, type SeatRole } from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { data } from './audience-helpers';
import { call, createChannel, seatAs, signIn, type Session } from './helpers';

const DAY = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const today = dayOf(Date.now());
const daysAgo = (n: number) => dayOf(Date.parse(`${today}T00:00:00Z`) - n * DAY);

type Row = Partial<{
  source: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  form_id: string;
  champion_id: string;
  visits: number;
  form_views: number;
  subscribes: number;
  confirms: number;
  first_opens: number;
  paid: number;
}>;

async function seed(channelId: string, day: string, row: Row): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO funnel_daily (channel_id, day, source, utm_source, utm_medium, utm_campaign, form_id,
       champion_id, visits, form_views, subscribes, confirms, first_opens, paid)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
  )
    .bind(
      channelId,
      day,
      row.source ?? '',
      row.utm_source ?? '',
      row.utm_medium ?? '',
      row.utm_campaign ?? '',
      row.form_id ?? '',
      row.champion_id ?? '',
      row.visits ?? 0,
      row.form_views ?? 0,
      row.subscribes ?? 0,
      row.confirms ?? 0,
      row.first_opens ?? 0,
      row.paid ?? 0,
    )
    .run();
}

const setPlan = (workspaceId: string, plan: string) =>
  env.DB.prepare('UPDATE workspaces SET plan = ?1 WHERE id = ?2').bind(plan, workspaceId).run();

describe('Funnel Explorer', () => {
  let owner: Session;
  let channelId: string;
  let formId: string;
  let championId: string;

  beforeAll(async () => {
    owner = await signIn();
    channelId = (await createChannel(owner)).id;
    const now = Date.now();
    formId = newId('captureForm');
    championId = newId('member');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO capture_forms (id, workspace_id, channel_id, name, draft_config_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'Footer form', '{}', ?4, ?4)`,
      ).bind(formId, owner.workspaceId, channelId, now),
      env.DB.prepare(
        `INSERT INTO members (id, channel_id, email, first_name, status, created_at, updated_at)
         VALUES (?1, ?2, 'champ@example.com', 'Ada', 'active', ?3, ?3)`,
      ).bind(championId, channelId, now),
    ]);
    await seed(channelId, today, { source: 'google.com', visits: 100 });
    await seed(channelId, today, { form_id: formId, form_views: 50 });
    await seed(channelId, today, {
      source: 'google.com',
      form_id: formId,
      subscribes: 10,
      confirms: 8,
      first_opens: 6,
      paid: 1,
    });
    await seed(channelId, daysAgo(1), {
      source: 'twitter',
      utm_source: 'twitter',
      utm_campaign: 'launch',
      champion_id: championId,
      visits: 40,
      subscribes: 5,
      confirms: 4,
      first_opens: 2,
    });
    await seed(channelId, daysAgo(2), { source: 'direct', visits: 10, subscribes: 1 });
    await seed(channelId, daysAgo(3), { source: 'bing.com', visits: 5, subscribes: 1 });
    // Outside the free plan's lookback.
    await seed(channelId, daysAgo(60), { source: 'google.com', visits: 1000, subscribes: 100 });
  });

  const url = (query = '') => `/api/v1/channels/${channelId}/analytics/funnel${query}`;

  it('returns stage totals, conversion and a by-day series', async () => {
    const funnel = await data<Funnel>(await call('GET', url(), { cookie: owner.cookie }));
    expect(funnel).toMatchObject({ to: today, from: daysAgo(29), cut: 'source', clamped: false });
    expect(funnel.lookbackDays).toBe(30);
    expect(funnel.totals).toEqual({
      visits: 155,
      formViews: 50,
      subscribes: 17,
      confirms: 12,
      firstOpens: 8,
      paid: 1,
    });
    expect(funnel.stages.map((s) => [s.stage, s.count, s.fromPrevious])).toEqual([
      ['visits', 155, null],
      ['form_views', 50, 0.3226],
      ['subscribes', 17, 0.34],
      ['confirms', 12, 0.7059],
      ['first_opens', 8, 0.6667],
      ['paid', 1, 0.125],
    ]);
    expect(funnel.stages.at(-1)?.fromVisits).toBe(0.0065);
    expect(funnel.rates.confirms).toBe(0.7059);
    expect(funnel.byDay).toHaveLength(30);
    expect(funnel.byDay.at(-1)).toMatchObject({ day: today, visits: 100, subscribes: 10 });
    expect(funnel.byDay.at(-2)).toMatchObject({ day: daysAgo(1), visits: 40, firstOpens: 2 });
  });

  it('breaks down by a cut with top N and other, and labels forms and Champions', async () => {
    const bySource = await data<Funnel>(
      await call('GET', url('?cut=source&top=2'), { cookie: owner.cookie }),
    );
    expect(bySource.breakdown.map((b) => [b.value, b.other, b.counts.subscribes])).toEqual([
      ['google.com', false, 10],
      ['twitter', false, 5],
      [null, true, 2],
    ]);
    expect(bySource.breakdown[0]?.counts.visits).toBe(100);
    expect(bySource.breakdown[0]?.rates.subscribes).toBeNull(); // google had no form views
    expect(bySource.breakdown[2]?.counts.visits).toBe(15);

    const byForm = await data<Funnel>(
      await call('GET', url('?cut=form'), { cookie: owner.cookie }),
    );
    expect(byForm.breakdown.map((b) => [b.value, b.label])).toEqual([
      [formId, 'Footer form'],
      ['', null],
    ]);
    expect(byForm.breakdown[0]?.rates).toMatchObject({ subscribes: 0.2, confirms: 0.8 });

    const byChampion = await data<Funnel>(
      await call('GET', url('?cut=champion'), { cookie: owner.cookie }),
    );
    expect(byChampion.breakdown.find((b) => b.value === championId)?.label).toBe('Ada');

    const byCampaign = await data<Funnel>(
      await call('GET', url('?cut=utm_campaign'), { cookie: owner.cookie }),
    );
    expect(byCampaign.breakdown.map((b) => b.value)).toEqual(['', 'launch']);
  });

  it('filters by exact cut values, with empty meaning none', async () => {
    const twitter = await data<Funnel>(
      await call('GET', url('?utmSource=twitter'), { cookie: owner.cookie }),
    );
    expect(twitter.totals).toMatchObject({ visits: 40, subscribes: 5 });
    const noChampion = await data<Funnel>(
      await call('GET', url('?championId=&formId='), { cookie: owner.cookie }),
    );
    expect(noChampion.totals).toMatchObject({ visits: 115, formViews: 0, subscribes: 2 });
  });

  it('limits the free plan to 30 days back and leaves paid plans unlimited', async () => {
    const old = daysAgo(90);
    const free = await data<Funnel>(
      await call('GET', url(`?from=${old}`), { cookie: owner.cookie }),
    );
    expect(free).toMatchObject({ from: daysAgo(29), clamped: true, lookbackDays: 30 });
    expect(free.totals.subscribes).toBe(17);
    expect(
      (await call('GET', url(`?from=${old}&to=${daysAgo(40)}`), { cookie: owner.cookie })).status,
    ).toBe(400);

    await setPlan(owner.workspaceId, 'pro');
    try {
      const paid = await data<Funnel>(
        await call('GET', url(`?from=${old}`), { cookie: owner.cookie }),
      );
      expect(paid).toMatchObject({ from: old, clamped: false, lookbackDays: null });
      expect(paid.totals.subscribes).toBe(117);
      expect(paid.byDay).toHaveLength(91);
      const window = await data<Funnel>(
        await call('GET', url(`?from=${old}&to=${daysAgo(40)}`), { cookie: owner.cookie }),
      );
      expect(window.totals.visits).toBe(1000);
      expect((await call('GET', url('?from=2010-01-01'), { cookie: owner.cookie })).status).toBe(
        400,
      );
    } finally {
      await setPlan(owner.workspaceId, 'free');
    }
  });

  it('rejects bad input', async () => {
    for (const query of [
      '?from=2026-13-01',
      `?from=${today}&to=${daysAgo(3)}`,
      '?cut=country',
      '?top=0',
      '?top=51',
    ]) {
      expect((await call('GET', url(query), { cookie: owner.cookie })).status, query).toBe(400);
    }
  });

  it('lets every role read it and hides other Channels behind 404', async () => {
    const roles: SeatRole[] = ['viewer', 'author', 'editor', 'admin'];
    for (const role of roles) {
      const seat = await seatAs(owner.workspaceId, role);
      expect((await call('GET', url(), { cookie: seat.cookie })).status, role).toBe(200);
    }
    const outsider = await signIn();
    expect((await call('GET', url(), { cookie: outsider.cookie })).status).toBe(404);
    expect((await call('GET', url())).status).toBe(401);

    // Their own Channel never shows this Channel's rows or labels.
    const own = await createChannel(outsider);
    const theirs = await data<Funnel>(
      await call(
        'GET',
        `/api/v1/channels/${own.id}/analytics/funnel?cut=champion&championId=${championId}`,
        { cookie: outsider.cookie },
      ),
    );
    expect(theirs.totals.subscribes).toBe(0);
    expect(theirs.breakdown).toEqual([]);
  });
});
