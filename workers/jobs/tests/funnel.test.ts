// Funnel Explorer rollups (Phase 6) against real D1: first-touch and Champion attribution, each
// per-Member stage once, idempotent re-runs, form views and the minute cron hook.
import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import {
  FUNNEL_OPEN_LAG_MS,
  analyticsDay,
  funnelVisitStatement,
  memberFunnelKey,
  recordMemberEvent,
  rollupFunnelFormViews,
  runFunnelRollup,
} from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { MINUTE_CRON } from '../src/crons';
import { runScheduled } from '../src/index';
import { jobsEnv, seedChannel } from './helpers';

// One clock for the file: the open pass keeps a time cursor, so time only moves forward.
let clock = Date.now();
const tick = (ms = 1000) => (clock += ms);
const settle = () => clock + FUNNEL_OPEN_LAG_MS + 1000;

interface Cell {
  day: string;
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
}

const cells = async (channelId: string) =>
  (
    await env.DB.prepare(
      `SELECT day, source, utm_source, utm_medium, utm_campaign, form_id, champion_id, visits,
              form_views, subscribes, confirms, first_opens, paid
         FROM funnel_daily WHERE channel_id = ?1
        ORDER BY day, source, utm_source, utm_medium, utm_campaign, form_id, champion_id`,
    )
      .bind(channelId)
      .all<Cell>()
  ).results;

const totals = async (channelId: string) =>
  (await cells(channelId)).reduce(
    (sum, c) => ({
      visits: sum.visits + c.visits,
      form_views: sum.form_views + c.form_views,
      subscribes: sum.subscribes + c.subscribes,
      confirms: sum.confirms + c.confirms,
      first_opens: sum.first_opens + c.first_opens,
      paid: sum.paid + c.paid,
    }),
    { visits: 0, form_views: 0, subscribes: 0, confirms: 0, first_opens: 0, paid: 0 },
  );

async function addForm(workspaceId: string, channelId: string): Promise<string> {
  const id = newId('captureForm');
  await env.DB.prepare(
    `INSERT INTO capture_forms (id, workspace_id, channel_id, name, draft_config_json, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'Footer', '{}', ?4, ?4)`,
  )
    .bind(id, workspaceId, channelId, clock)
    .run();
  return id;
}

async function addMember(
  channelId: string,
  options: { source?: Record<string, string>; formId?: string; referredBy?: string } = {},
): Promise<string> {
  const id = newId('member');
  await env.DB.prepare(
    `INSERT INTO members (id, channel_id, email, status, source_json, form_id, referred_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?6, ?7, ?7)`,
  )
    .bind(
      id,
      channelId,
      `f-${crypto.randomUUID()}@example.com`,
      JSON.stringify(options.source ?? {}),
      options.formId ?? null,
      options.referredBy ?? null,
      clock,
    )
    .run();
  if (options.referredBy) {
    await env.DB.prepare(
      'INSERT INTO referrals (id, channel_id, referrer_id, referred_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
    )
      .bind(newId('referral'), channelId, options.referredBy, id, clock)
      .run();
  }
  return id;
}

const join = (memberId: string, source: 'form' | 'import' | 'operator' | 'checkout' = 'form') =>
  recordMemberEvent(
    env.DB,
    { type: 'member_joined', memberId, payload: { source, status: 'active' } },
    tick(),
  );
const confirm = (memberId: string) =>
  recordMemberEvent(
    env.DB,
    { type: 'confirmed', memberId, payload: { method: 'single_opt_in' } },
    tick(),
  );
const purchase = (memberId: string, levelId: string | null = null) =>
  recordMemberEvent(
    env.DB,
    { type: 'level_purchased', memberId, payload: { levelId, source: 'stripe' } },
    tick(),
  );

async function openBroadcast(
  workspaceId: string,
  channelId: string,
  memberId: string,
  openedAt: number | null,
): Promise<void> {
  const dispatchId = newId('dispatch');
  const broadcastId = newId('broadcast');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at)
       VALUES (?1, ?2, 'Issue', '{}', 'sent', ?3, ?3)`,
    ).bind(dispatchId, channelId, clock),
    env.DB.prepare(
      `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text,
         from_name, from_address, track_opens, created_at, last_progress_at)
       VALUES (?1, ?2, ?3, ?4, 'sent', 'Issue', '', '', '', 'Field Notes', 'notes@example.com', 1, ?5, ?5)`,
    ).bind(broadcastId, dispatchId, channelId, workspaceId, clock),
    env.DB.prepare(
      `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, sent_at, opened_at, human_opened_at)
       VALUES (?1, ?2, ?3, ?4, 'reader@example.com', ?5, ?6, ?6)`,
    ).bind(newId('delivery'), broadcastId, channelId, memberId, clock, openedAt),
  ]);
}

describe('funnel attribution', () => {
  it('uses the first touch, the sign-up form and the Champion', () => {
    expect(
      memberFunnelKey({
        source_json: JSON.stringify({
          utm_source: 'News Letter',
          utm_medium: 'Email',
          utm_campaign: 'Spring_2026',
          referrer: 'https://www.google.com/search',
          current: { utm_source: 'later' },
        }),
        form_id: 'cf_1',
        referred_by: 'mb_1',
        referral_status: 'counted',
      }),
    ).toEqual({
      source: 'newsletter',
      utmSource: 'newsletter',
      utmMedium: 'email',
      utmCampaign: 'spring_2026',
      formId: 'cf_1',
      championId: 'mb_1',
    });
    expect(
      memberFunnelKey({
        source_json: JSON.stringify({
          referrer: 'https://www.google.com/',
          first_url: 'https://notes.example/p/a',
        }),
        form_id: null,
        referred_by: 'mb_1',
        referral_status: 'rejected',
      }),
    ).toMatchObject({ source: 'google.com', utmSource: '', formId: '', championId: '' });
    expect(
      memberFunnelKey({
        source_json: JSON.stringify({
          referrer: 'https://notes.example/',
          first_url: 'https://notes.example/p/a',
        }),
        form_id: null,
        referred_by: null,
      }).source,
    ).toBe('internal');
    expect(memberFunnelKey({ source_json: 'nope', form_id: null, referred_by: null }).source).toBe(
      'direct',
    );
  });
});

describe('funnel rollup', () => {
  it('counts each stage once per Member, attributed by first touch and Champion, idempotently', async () => {
    const { workspaceId, channelId } = await seedChannel();
    const formId = await addForm(workspaceId, channelId);
    const champion = await addMember(channelId);
    const a = await addMember(channelId, {
      source: { utm_source: 'twitter', utm_campaign: 'launch', referrer: 'https://t.co/x' },
      formId,
    });
    const b = await addMember(channelId, {
      source: { referrer: 'https://www.google.com/' },
      referredBy: champion,
    });
    const imported = await addMember(channelId);
    const day = analyticsDay(clock);

    await join(a);
    await confirm(a);
    await confirm(a); // a return confirm later: still one confirm
    await join(b, 'checkout');
    await confirm(b);
    await purchase(b, 'lv_one');
    await purchase(b, 'lv_two'); // an upgrade: still one paid
    await join(imported, 'import');
    await confirm(imported);
    await purchase(imported);

    await openBroadcast(workspaceId, channelId, a, tick());
    await openBroadcast(workspaceId, channelId, a, tick()); // a second open: still one first open
    await openBroadcast(workspaceId, channelId, b, null); // delivered, never opened
    await openBroadcast(workspaceId, channelId, imported, tick());

    await runFunnelRollup(env.DB, settle());
    const first = await cells(channelId);
    expect(first).toEqual([
      {
        day,
        source: 'google.com',
        utm_source: '',
        utm_medium: '',
        utm_campaign: '',
        form_id: '',
        champion_id: champion,
        visits: 0,
        form_views: 0,
        subscribes: 1,
        confirms: 1,
        first_opens: 0,
        paid: 1,
      },
      {
        day,
        source: 'twitter',
        utm_source: 'twitter',
        utm_medium: '',
        utm_campaign: 'launch',
        form_id: formId,
        champion_id: '',
        visits: 0,
        form_views: 0,
        subscribes: 1,
        confirms: 1,
        first_opens: 1,
        paid: 0,
      },
    ]);

    // Re-running, and re-reading everything from scratch, changes nothing.
    await runFunnelRollup(env.DB, settle());
    await env.DB.prepare('DELETE FROM funnel_cursors').run();
    await runFunnelRollup(env.DB, settle());
    expect(await cells(channelId)).toEqual(first);
    // member_events.processed_at belongs to the Flows engine.
    const stamped = await env.DB.prepare(
      'SELECT count(*) AS n FROM member_events WHERE channel_id = ?1 AND processed_at IS NOT NULL',
    )
      .bind(channelId)
      .first<{ n: number }>();
    expect(stamped?.n).toBe(0);

    // b opens later: counted once, on the open's day.
    await openBroadcast(workspaceId, channelId, b, tick(5000));
    await runFunnelRollup(env.DB, settle());
    await runFunnelRollup(env.DB, settle());
    expect(await totals(channelId)).toEqual({
      visits: 0,
      form_views: 0,
      subscribes: 2,
      confirms: 2,
      first_opens: 2,
      paid: 1,
    });
  });

  it('ignores stages of Members it does not follow and events of other types', async () => {
    const { channelId } = await seedChannel();
    const before = await addMember(channelId); // joined before the funnel existed: no member_joined
    const operator = await addMember(channelId);
    await join(operator, 'operator');
    await confirm(before);
    await purchase(before);
    await confirm(operator);
    await recordMemberEvent(
      env.DB,
      { type: 'tag_added', memberId: before, payload: { tagId: 'tg_x' } },
      tick(),
    );
    await runFunnelRollup(env.DB, settle());
    expect(await cells(channelId)).toEqual([]);
  });

  it('copies form views for today and yesterday as a replace', async () => {
    const { workspaceId, channelId } = await seedChannel();
    const formId = await addForm(workspaceId, channelId);
    const now = Date.now();
    const today = analyticsDay(now);
    const yesterday = analyticsDay(now - 86_400_000);
    const old = analyticsDay(now - 5 * 86_400_000);
    for (const [day, views] of [
      [today, 7],
      [yesterday, 3],
      [old, 9],
    ] as const) {
      await env.DB.prepare(
        'INSERT INTO capture_form_daily (form_id, day, views, submissions) VALUES (?1, ?2, ?3, 1)',
      )
        .bind(formId, day, views)
        .run();
    }
    await rollupFunnelFormViews(env.DB, now);
    await env.DB.prepare(
      'UPDATE capture_form_daily SET views = views + 2 WHERE form_id = ?1 AND day = ?2',
    )
      .bind(formId, today)
      .run();
    await rollupFunnelFormViews(env.DB, now);
    await rollupFunnelFormViews(env.DB, now);
    expect((await cells(channelId)).map((c) => [c.day, c.form_id, c.form_views])).toEqual([
      [yesterday, formId, 3],
      [today, formId, 9],
    ]);
  });

  it('adds visits with source and UTM tags from the landing page', async () => {
    const { channelId } = await seedChannel();
    const now = Date.now();
    const url = new URL(
      'https://notes.example/p/a?utm_source=Mastodon&utm_medium=social&utm_campaign=Fall%20Sale',
    );
    await funnelVisitStatement(env.DB, { channelId, url, referrer: undefined, now }).run();
    await funnelVisitStatement(env.DB, { channelId, url, referrer: undefined, now }).run();
    await funnelVisitStatement(env.DB, {
      channelId,
      url: new URL('https://notes.example/'),
      referrer: 'https://www.bing.com/',
      now,
    }).run();
    expect(
      (await cells(channelId)).map((c) => [
        c.source,
        c.utm_source,
        c.utm_medium,
        c.utm_campaign,
        c.visits,
      ]),
    ).toEqual([
      ['bing.com', '', '', '', 1],
      ['mastodon', 'mastodon', 'social', 'fallsale', 2],
    ]);
  });

  it('runs from the minute cron', async () => {
    const { channelId } = await seedChannel();
    const member = await addMember(channelId, { source: { utm_source: 'cron' } });
    await join(member);
    await runScheduled(jobsEnv().env, MINUTE_CRON, settle());
    expect((await totals(channelId)).subscribes).toBe(1);
  });
});
