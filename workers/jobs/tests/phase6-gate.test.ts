// Exit gate of Phase 6, end to end against real D1 and the crons that run in production: Welcome
// A/B promotes its winner from real sends and real opens, and Champions milestones grant their
// reward from real sign-ups through a share link. The units are tested in champions.test.ts and
// workers/api/tests/flows.test.ts; these walk the whole path.
import { env } from 'cloudflare:test';
import { FLOW_RECIPE_DEFS, FlowGraphSchema, newId, type FlowGraph } from '@swarm/domain';
import {
  enrollFromEvents,
  ensureChampionCode,
  entitledLevel,
  recordOpen,
  subscribe,
} from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { DAILY_CRON, MINUTE_CRON } from '../src/crons';
import { runScheduled } from '../src/index';
import { addMember, count, jobsEnv, one, seedChannel, testFieldKeys } from './helpers';
import {
  DAY,
  HOUR,
  attachPipeline,
  dispatchId,
  harness,
  publishFlow,
  runsOf,
  type Harness,
  type SendPipeline,
} from './flows-helpers';
import { testLinks } from './links';

type Seed = Awaited<ReturnType<typeof seedChannel>>;

const human = {
  method: 'GET',
  userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
  asn: null,
  asOrganization: null,
  ip: null,
};

const address = (label: string) => `${label}-${crypto.randomUUID()}@example.com`;

function signUp(
  h: Harness,
  seed: Seed,
  email: string,
  options: { ref?: string; ip?: string } = {},
) {
  return subscribe(
    {
      db: env.DB,
      mail: h.mail,
      links: testLinks(),
      captureOrigin: 'https://forms.swarm.test',
      platformMailDomain: 'mail.swarm.test',
      fieldKeys: testFieldKeys,
      now: () => h.clock.now,
    },
    {
      channelId: seed.channelId,
      workspaceId: seed.workspaceId,
      formId: null,
      email,
      doubleOptIn: false,
      ...(options.ref ? { ref: options.ref } : {}),
      ...(options.ip ? { ip: options.ip } : {}),
    },
  );
}

async function settle(h: Harness, sends: SendPipeline) {
  for (let i = 0; i < 20; i++) {
    await enrollFromEvents(h.env, h.clock.now);
    if (!((await h.drain()) + (await sends.consumeDue()))) return;
  }
}

const deliveryOf = (memberId: string, broadcastId?: string) =>
  one<{ id: string; broadcast_id: string }>(
    `SELECT id, broadcast_id FROM deliveries WHERE member_id = ?1 AND (?2 IS NULL OR broadcast_id = ?2)`,
    memberId,
    broadcastId ?? null,
  );

describe('Welcome A/B', () => {
  it('promotes the variant people opened, and new Members get only that one', async () => {
    const seed = await seedChannel();
    const h = harness();
    const sends = attachPipeline(h);
    const recipe = FLOW_RECIPE_DEFS.welcome.graph({
      welcome_a: dispatchId(),
      welcome_b: dispatchId(),
    });
    // The recipe as shipped, with a sample a test can reach.
    const graph: FlowGraph = FlowGraphSchema.parse({
      ...recipe,
      nodes: recipe.nodes.map((n) =>
        n.type === 'ab_split'
          ? {
              ...n,
              config: {
                ...n.config,
                autoPromote: { metric: 'opens', minPerVariant: 2, afterHours: 48 },
              },
            }
          : n,
      ),
    });
    expect(graph.nodes.some((n) => n.type === 'ab_split')).toBe(true);
    const flow = await publishFlow(seed, graph);
    const a = flow.broadcasts.welcome_a!;
    const b = flow.broadcasts.welcome_b!;

    // Real sign-ups fire 'confirmed', and each run lands on one arm, until both arms have a sample.
    const members: { id: string; broadcastId: string }[] = [];
    while (
      members.filter((m) => m.broadcastId === a).length < 2 ||
      members.filter((m) => m.broadcastId === b).length < 2
    ) {
      expect(members.length).toBeLessThan(60);
      const { memberId } = await signUp(h, seed, address('new'));
      await settle(h, sends);
      const delivery = await deliveryOf(memberId!);
      members.push({ id: memberId!, broadcastId: delivery!.broadcast_id });
    }
    expect(sends.outbox.accepted).toHaveLength(members.length);

    // Everyone who got B opens it; nobody opens A.
    for (const member of members.filter((m) => m.broadcastId === b)) {
      const delivery = await deliveryOf(member.id, b);
      await recordOpen(env.DB, delivery!.id, human, h.clock.now + 60_000);
    }

    // Too early: the daily job leaves the version alone before the window ends.
    const jobs = jobsEnv().env;
    await runScheduled(jobs, DAILY_CRON, h.clock.now + 24 * HOUR);
    const liveVersion = () =>
      one<{ live_version: number }>('SELECT live_version FROM flows WHERE id = ?1', flow.flowId);
    expect((await liveVersion())?.live_version).toBe(1);

    h.clock.now += 49 * HOUR;
    await runScheduled(jobs, DAILY_CRON, h.clock.now);
    expect((await liveVersion())?.live_version).toBe(2);
    const version = await one<{ graph_json: string }>(
      'SELECT graph_json FROM flow_versions WHERE flow_id = ?1 AND version = 2',
      flow.flowId,
    );
    const promoted = JSON.parse(version!.graph_json) as FlowGraph;
    expect(promoted.nodes.map((n) => n.id).sort()).toEqual(['trigger', 'welcome_b']);
    const audit = await one<{ metadata_json: string }>(
      `SELECT metadata_json FROM audit_events WHERE target_id = ?1 AND action = 'flow.split_promoted'`,
      flow.flowId,
    );
    expect(JSON.parse(audit!.metadata_json)).toMatchObject({ winner: 'b', toVersion: 2 });
    // The old version's Flow Broadcasts close: nothing is open on them.
    expect(
      await count(
        `SELECT count(*) AS n FROM broadcasts WHERE id IN (?1, ?2) AND status = 'sending'`,
        a,
        b,
      ),
    ).toBe(0);

    // A new sign-up goes straight to the winner, on the new version.
    const winner = await one<{ broadcast_id: string }>(
      `SELECT broadcast_id FROM flow_emails WHERE flow_id = ?1 AND version = 2 AND node_id = 'welcome_b'`,
      flow.flowId,
    );
    for (let i = 0; i < 6; i++) {
      const { memberId } = await signUp(h, seed, address('later'));
      await settle(h, sends);
      expect((await deliveryOf(memberId!))?.broadcast_id).toBe(winner!.broadcast_id);
      expect((await runsOf(flow.flowId, memberId!))[0]?.version).toBe(2);
    }
  });
});

describe('Champions', () => {
  it('grants the reward once two friends joined through the share link and read a Dispatch', async () => {
    const seed = await seedChannel();
    const { channelId } = seed;
    const h = harness();
    const sends = attachPipeline(h);
    const levelId = newId('membershipLevel');
    const rewardId = newId('championReward');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO champion_settings (channel_id, enabled, engagement_days, cluster_limit, cluster_window_hours,
           block_disposable, updated_at) VALUES (?1, 1, 14, 3, 24, 1, 0)`,
      ).bind(channelId),
      env.DB.prepare(
        `INSERT INTO membership_levels (id, channel_id, name, created_at, updated_at) VALUES (?1, ?2, 'Supporter', 0, 0)`,
      ).bind(levelId, channelId),
      env.DB.prepare(
        `INSERT INTO champion_rewards (id, channel_id, kind, name, level_id, comp_days, created_at, updated_at)
         VALUES (?1, ?2, 'comp_level', 'Thank you', ?3, 30, 0, 0)`,
      ).bind(rewardId, channelId, levelId),
      env.DB.prepare(
        `INSERT INTO champion_milestones (id, channel_id, referrals_required, name, reward_id, created_at, updated_at)
         VALUES (?1, ?2, 2, 'Two friends', ?3, 0, 0)`,
      ).bind(newId('championMilestone'), channelId, rewardId),
    ]);
    // Every new Member gets a welcome email they can open; that open is what makes them count.
    await publishFlow(
      seed,
      FlowGraphSchema.parse({
        schema: 1,
        nodes: [
          { id: 'trigger', type: 'trigger', config: { event: 'confirmed' } },
          { id: 'email', type: 'send_email', config: { dispatchId: dispatchId() } },
        ],
        edges: [{ from: 'trigger', to: 'email' }],
      }),
    );
    const championEmail = address('champion');
    const champion = await addMember(channelId, championEmail);
    const code = await ensureChampionCode(env.DB, channelId, champion);

    const first = await signUp(h, seed, address('first'), { ref: code!, ip: '198.51.100.7' });
    const second = await signUp(h, seed, address('second'), { ref: code!, ip: '203.0.113.9' });
    await settle(h, sends);
    const jobs = jobsEnv().env;
    const awards = () =>
      env.DB.prepare('SELECT status, comp_grant_id FROM champion_awards WHERE member_id = ?1')
        .bind(champion)
        .all<{ status: string; comp_grant_id: string | null }>()
        .then((r) => r.results);
    const openedEmail = async (memberId: string) => {
      const delivery = await deliveryOf(memberId);
      await recordOpen(env.DB, delivery!.id, human, h.clock.now);
    };

    // Joined but never opened anything: no credit yet.
    await runScheduled(jobs, MINUTE_CRON, h.clock.now);
    expect(await awards()).toEqual([]);

    // One friend reads their email: one short of the milestone.
    h.clock.now += HOUR;
    await openedEmail(first.memberId!);
    await runScheduled(jobs, MINUTE_CRON, h.clock.now);
    expect(await awards()).toEqual([]);
    expect(await entitledLevel(env.DB, channelId, champion, h.clock.now)).toBeUndefined();

    // The second does: the reward is granted, active and emailed.
    h.clock.now += HOUR;
    await openedEmail(second.memberId!);
    await runScheduled(jobs, MINUTE_CRON, h.clock.now);
    const [award, ...others] = await awards();
    expect(others).toEqual([]);
    expect(award?.status).toBe('fulfilled');
    expect(award?.comp_grant_id).toBeTruthy();
    expect(await entitledLevel(env.DB, channelId, champion, h.clock.now)).toBe(levelId);
    const grant = await one<{ expires_at: number }>(
      'SELECT expires_at FROM comp_grants WHERE id = ?1',
      award!.comp_grant_id,
    );
    expect(grant?.expires_at).toBe(h.clock.now + 30 * DAY);
    const listing = await env.DEV_MAILBOX.list({ prefix: 'mail/', include: ['customMetadata'] });
    const toChampion = listing.objects.filter((o) => o.customMetadata?.to === championEmail);
    expect(toChampion).toHaveLength(1);
    const mail = await (await env.DEV_MAILBOX.get(toChampion[0]!.key))!.json<{
      category: string;
      text: string;
    }>();
    expect(mail.category).toBe('champion_award');
    expect(mail.text).toContain('Supporter for 30 days');
    // The grant fires level_purchased, so a Flow can follow up on it.
    expect(
      await count(
        `SELECT count(*) AS n FROM member_events WHERE member_id = ?1 AND type = 'level_purchased'`,
        champion,
      ),
    ).toBe(1);

    // Later crons change nothing: exactly once.
    await runScheduled(jobs, MINUTE_CRON, h.clock.now + HOUR);
    expect(await awards()).toHaveLength(1);
    expect(
      await count('SELECT count(*) AS n FROM comp_grants WHERE member_id = ?1', champion),
    ).toBe(1);
  });

  it('holds a third friend from the same network back from the count', async () => {
    const seed = await seedChannel();
    const h = harness();
    await env.DB.prepare(
      `INSERT INTO champion_settings (channel_id, enabled, engagement_days, cluster_limit, cluster_window_hours,
         block_disposable, updated_at) VALUES (?1, 1, 14, 2, 24, 1, 0)`,
    )
      .bind(seed.channelId)
      .run();
    const champion = await addMember(seed.channelId, address('champion'));
    const code = await ensureChampionCode(env.DB, seed.channelId, champion);
    for (let i = 0; i < 3; i++) {
      await signUp(h, seed, address('friend'), { ref: code!, ip: '198.51.100.7' });
    }
    await runScheduled(jobsEnv().env, MINUTE_CRON, h.clock.now);
    expect(
      await count(
        `SELECT count(*) AS n FROM referrals WHERE referrer_id = ?1 AND status = 'held'`,
        champion,
      ),
    ).toBe(1);
  });
});
