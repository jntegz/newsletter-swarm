// Exit gate of Phase 6: no Flow email can reach a suppressed, unsubscribed, bounced, complained,
// paused or deleted Member. Random Flow graphs run through the real engine and the real send
// pipeline against D1, with Member state changing at random points through the same functions the
// product uses (the Member Center, the unsubscribe link, provider events, operator suppressions,
// deletion, erasure), while queues deliver late, out of order and twice and the provider throttles.
// Most rounds also run under random inbox rules: emails are held and released, posts go out, rules
// change, and Members leave while their email is held. Those Members must get nothing, an email the
// rules cover must never have gone against them, and no Member gets the same email from two versions.
//
// The check sits at the last step: the moment the mail provider is handed a message.
//
//   pnpm --filter @swarm/jobs exec vitest run tests/flows-fuzz.test.ts
//   FLOW_FUZZ_ITERATIONS=500 pnpm --filter @swarm/jobs exec vitest run tests/flows-fuzz.test.ts
//
// A failure prints the seed of the round and the command that replays exactly that round.
import { env } from 'cloudflare:test';
import { newId, type FlowGraph, type InboxRules } from '@swarm/domain';
import {
  addManualSuppression,
  applySesEvent,
  enrollFromEvents,
  ensureRamp,
  eraseAddress,
  inQuietHours,
  migrateRuns,
  pauseMember,
  recordClick,
  recordMemberEvent,
  recordOpen,
  resumeFlowRuns,
  resumeMember,
  reviewReferral,
  runStep,
  saveInboxRules,
  suppress,
  sweepFlows,
  tagStatements,
  unsubscribeDelivery,
  unsubscribeMember,
  type SesEvent,
} from '@swarm/engine';
import { MailProviderError, type OutgoingMail } from '@swarm/mail';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '@swarm/vault/testing';
import {
  ZONES,
  below,
  mulberry32,
  pick,
  randomGraph,
  randomRules,
  type Rand,
  type Refs,
} from './flows-fuzz-graphs';
import { addField, addMember, count, seedChannel, testFieldKeys } from './helpers';
import {
  HOUR,
  addLinkTarget,
  attachPipeline,
  dispatchId,
  harness,
  makeAdmin,
  makeTag,
  publishFlow,
  publishVersion,
  type Harness,
  type SendPipeline,
} from './flows-helpers';

const DEFAULT_ITERATIONS = 30;
const DEFAULT_SEED = 0x5eed_0006;
const TICKS = 120;
const SETTLE_HORIZON_MS = 30 * 24 * HOUR;
const DAY_MS = 24 * HOUR;
/** Rounds with no inbox rule at all prove that holding isn't what keeps people safe. */
const RULES_CHANCE = 0.75;
/** A fixed start, so "until a weekday and time" delays replay the same way. */
const START = Date.UTC(2026, 10, 2, 9, 0, 0);

const iterations = Number(env.FLOW_FUZZ_ITERATIONS) || DEFAULT_ITERATIONS;
const baseSeed = env.FLOW_FUZZ_SEED ? Number(env.FLOW_FUZZ_SEED) >>> 0 : DEFAULT_SEED;

/** Round 0 runs the base seed itself, so a printed seed replays with FLOW_FUZZ_ITERATIONS=1. */
const roundSeed = (round: number) => (baseSeed + Math.imul(round, 0x9e3779b9)) >>> 0;

const CLOSING_CHANGES = [
  'unsubscribe_member_center',
  'unsubscribe_link',
  'hard_bounce',
  'soft_bounce_limit',
  'complaint',
  'suppress_workspace',
  'suppress_channel',
  'delete',
  'erase',
  'pause',
] as const;
type ClosingChange = (typeof CLOSING_CHANGES)[number];

interface FuzzMember {
  id: string;
  email: string;
  /** Never changed: proves the gate doesn't simply stop everything. */
  control: boolean;
  closed: { change: ClosingChange; tick: number; at: number; heldRuns: string[] } | null;
  gone: boolean;
  /** The zone the rules read this Member in. */
  zone: string;
}

interface Stats {
  handedToProvider: number;
  changes: Record<string, number>;
  exits: Record<string, number>;
  /** Recipient rows stopped at the last moment, after their step had already queued them. */
  stoppedAtSendTime: number;
  /** Emails inbox rules held, and what became of them. */
  held: number;
  heldThenSent: number;
  /** Closing changes that found the Member's email held, and the unsubscribes among them. */
  closedWhileHeld: number;
  unsubscribedWhileHeld: number;
  /** Emails the rules cover, checked against the rules once the round was over. */
  checkedAgainstRules: number;
}

const newStats = (): Stats => ({
  handedToProvider: 0,
  changes: {},
  exits: {},
  stoppedAtSendTime: 0,
  held: 0,
  heldThenSent: 0,
  closedWhileHeld: 0,
  unsubscribedWhileHeld: 0,
  checkedAgainstRules: 0,
});

class Round {
  readonly trace: string[] = [];
  readonly violations: string[] = [];
  readonly members: FuzzMember[] = [];
  readonly flows: { id: string; version: number; graph: FlowGraph }[] = [];
  tick = 0;
  webhookFails = 0.15;
  throttle = 0.15;
  /** The round's inbox rules; null when none are on. */
  rules: InboxRules | null = null;
  /** Once rules changed, what was sent can't be judged against one set of them. */
  rulesChanged = false;
  /** Posts each Member got or will get, and when the engine could first know about them. */
  readonly posts: { memberId: string | null; at: number; knownFrom: number }[] = [];

  constructor(
    readonly rand: Rand,
    readonly h: Harness,
    readonly sends: SendPipeline,
    readonly seed: { workspaceId: string; channelId: string; otherChannelId: string },
    readonly refs: Refs,
    readonly fire: (member: FuzzMember) => Promise<void>,
  ) {}

  log(line: string) {
    this.trace.push(`[${this.tick}] +${Math.round((this.h.clock.now - START) / 60_000)}m ${line}`);
  }

  get now() {
    return this.h.clock.now;
  }

  /** The oracle: every message handed to the provider, judged at that moment. */
  async judge(mail: OutgoingMail, stats: Stats) {
    stats.handedToProvider++;
    const member = this.members.find((m) => m.email === mail.to);
    if (!member) {
      this.violations.push(`mail to an address outside the test: ${mail.to}`);
      return;
    }
    if (member.closed) {
      this.violations.push(
        `${mail.to} got broadcast ${mail.tags?.broadcast} after "${member.closed.change}" at tick ${member.closed.tick}`,
      );
    }
    // The database agrees: the address may be mailed in this Channel right now.
    const row = await env.DB.prepare(
      `SELECT m.status, EXISTS (SELECT 1 FROM suppressions s WHERE s.workspace_id = ?1 AND s.email = m.email
                                  AND (s.channel_id IS NULL OR s.channel_id = m.channel_id)) AS suppressed
         FROM members m WHERE m.channel_id = ?2 AND m.email = ?3`,
    )
      .bind(this.seed.workspaceId, this.seed.channelId, mail.to)
      .first<{ status: string; suppressed: number }>();
    if (!row || row.status !== 'active' || row.suppressed) {
      this.violations.push(
        `${mail.to} got broadcast ${mail.tags?.broadcast} while its row says ${JSON.stringify(row)}`,
      );
    }
  }

  private latestDelivery(member: FuzzMember) {
    return env.DB.prepare(
      'SELECT id FROM deliveries WHERE member_id = ?1 ORDER BY sent_at DESC, id DESC LIMIT 1',
    )
      .bind(member.id)
      .first<{ id: string }>();
  }

  /** A provider event about the Member's latest email, or the suppression it would cause. */
  private async providerEvent(
    member: FuzzMember,
    event: Omit<SesEvent, 'mail'>,
    fallback: () => Promise<void>,
  ) {
    const delivery = await this.latestDelivery(member);
    if (delivery) {
      await applySesEvent(
        env.DB,
        { ...event, mail: { tags: { delivery: [delivery.id] } } } as SesEvent,
        this.now,
      );
    } else {
      await fallback();
    }
  }

  async close(member: FuzzMember, change: ClosingChange, stats: Stats) {
    const db = env.DB;
    const ws = this.seed.workspaceId;
    this.log(`${change} ${member.email}`);
    stats.changes[change] = (stats.changes[change] ?? 0) + 1;
    // Read first: deleting and erasing take the holds with the Member.
    const held = await this.heldRuns(member);
    stats.closedWhileHeld += held.length;
    if (change.startsWith('unsubscribe')) stats.unsubscribedWhileHeld += held.length;
    switch (change) {
      case 'unsubscribe_member_center':
        await unsubscribeMember(db, member.id, 'fuzz', this.now);
        break;
      case 'unsubscribe_link': {
        const delivery = await this.latestDelivery(member);
        if (delivery) await unsubscribeDelivery(db, delivery.id, this.now);
        else await unsubscribeMember(db, member.id, null, this.now);
        break;
      }
      case 'hard_bounce':
        await this.providerEvent(
          member,
          {
            eventType: 'Bounce',
            bounce: { bounceType: 'Permanent', bounceSubType: 'General' },
          },
          () => suppress(db, ws, member.email, 'hard_bounce', 'fuzz', 'bounced', this.now),
        );
        break;
      case 'soft_bounce_limit':
        // The third email in a row to bounce softly (the default bounce rule): two earlier ones
        // are on record, and the latest email's report is the third. A report of the same email
        // counts once, so it is one report here (docs/deliverability.md "Bounces").
        await db
          .prepare(
            `INSERT INTO bounce_states (id, workspace_id, email, soft_streak, last_kind, last_cause,
                                        last_bounced_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, 2, 'soft', 'mailbox_full', ?4, ?4, ?4)
             ON CONFLICT (workspace_id, email) DO UPDATE SET soft_streak = 2`,
          )
          .bind(newId('bounceState', this.now), ws, member.email.toLowerCase(), this.now)
          .run();
        await this.providerEvent(
          member,
          { eventType: 'Bounce', bounce: { bounceType: 'Transient' } },
          () => suppress(db, ws, member.email, 'soft_bounce', 'fuzz', 'bounced', this.now),
        );
        break;
      case 'complaint':
        await this.providerEvent(
          member,
          { eventType: 'Complaint', complaint: { complaintFeedbackType: 'abuse' } },
          () => suppress(db, ws, member.email, 'complaint', 'fuzz', 'complained', this.now),
        );
        break;
      case 'suppress_workspace':
        await addManualSuppression(db, {
          workspaceId: ws,
          channelId: null,
          email: member.email,
          now: this.now,
        });
        break;
      case 'suppress_channel':
        await addManualSuppression(db, {
          workspaceId: ws,
          channelId: this.seed.channelId,
          email: member.email,
          now: this.now,
        });
        break;
      case 'delete':
        // workers/api lib/members.ts deleteMember.
        await db.batch([
          db
            .prepare("UPDATE deliveries SET email = 'deleted' WHERE member_id = ?1")
            .bind(member.id),
          db.prepare('DELETE FROM members WHERE id = ?1').bind(member.id),
        ]);
        member.gone = true;
        break;
      case 'erase':
        await eraseAddress(
          db,
          { workspaceId: ws, email: member.email, keys: testFieldKeys },
          this.now,
        );
        member.gone = true;
        break;
      case 'pause':
        await pauseMember(db, member.id, 2, this.now);
        break;
    }
    member.closed = { change, tick: this.tick, at: this.now, heldRuns: held };
  }

  /** The Member's runs waiting on a hold right now. */
  async heldRuns(member: FuzzMember): Promise<string[]> {
    const rows = await env.DB.prepare(
      `SELECT h.run_id FROM flow_holds h JOIN flow_runs r ON r.id = h.run_id
        WHERE h.member_id = ?1 AND h.released_at IS NULL AND h.node_id = r.current_node_id
          AND r.status IN ('running', 'waiting', 'paused')`,
    )
      .bind(member.id)
      .all<{ run_id: string }>();
    return rows.results.map((r) => r.run_id);
  }

  /** A post, which the newsletter day rule waits around: one a Member got, or one scheduled. */
  async post(rand: Rand) {
    const db = env.DB;
    const { channelId, workspaceId } = this.seed;
    const dispatch = dispatchId();
    const member = pick(rand, this.members);
    if (member.gone || rand() < 0.3) {
      const at = this.now + (1 + below(rand, 72)) * HOUR;
      this.log(`post scheduled for +${Math.round((at - START) / 60_000)}m`);
      await db
        .prepare(
          `INSERT INTO dispatches (id, channel_id, subject, content_json, status, publish_at, kind, audience_json, created_at, updated_at)
           VALUES (?1, ?2, 'Post', '{"type":"doc","content":[]}', 'scheduled', ?3, 'broadcast', '{"include":[],"exclude":[]}', ?4, ?4)`,
        )
        .bind(dispatch, channelId, at, this.now)
        .run();
      this.posts.push({ memberId: null, at, knownFrom: this.now });
      return;
    }
    this.log(`post to ${member.email}`);
    const broadcast = newId('broadcast', this.now);
    await db.batch([
      db
        .prepare(
          `INSERT INTO dispatches (id, channel_id, subject, content_json, status, kind, created_at, updated_at)
           VALUES (?1, ?2, 'Post', '{"type":"doc","content":[]}', 'sent', 'broadcast', ?3, ?3)`,
        )
        .bind(dispatch, channelId, this.now),
      db
        .prepare(
          `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html,
             text, from_name, from_address, track_opens, snapshot_done, fanout_done, created_at, last_progress_at)
           VALUES (?1, ?2, ?3, ?4, 'sent', 'Post', '', '<p>Hi</p>', 'Hi', 'Notes', 'notes@mail.swarm.localhost', 1, 1, 1, ?5, ?5)`,
        )
        .bind(broadcast, dispatch, channelId, workspaceId, this.now),
      db
        .prepare(
          `INSERT INTO broadcast_recipients (broadcast_id, member_id, email, status)
           SELECT ?1, id, email, 'sent' FROM members WHERE id = ?2`,
        )
        .bind(broadcast, member.id),
    ]);
    this.posts.push({ memberId: member.id, at: this.now, knownFrom: this.now });
  }

  /** Someone changes the rules mid-round, which wakes every held email to decide again. */
  async changeRules(rand: Rand) {
    const rules = randomRules(rand);
    this.log(`rules -> ${JSON.stringify(rules)}`);
    await saveInboxRules(
      env.DB,
      this.seed.channelId,
      { rules, timezone: pick(rand, ZONES) },
      this.now,
    );
    this.rulesChanged = true;
  }

  /** A stray change that must not stop the Member's mail. */
  async harmless(member: FuzzMember) {
    this.log(`harmless change for ${member.email}`);
    await addManualSuppression(env.DB, {
      workspaceId: this.seed.workspaceId,
      channelId: this.seed.otherChannelId,
      email: member.email,
      now: this.now,
    });
    await env.DB.batch(
      tagStatements(env.DB, member.id, [pick(this.rand, this.refs.tags).id], this.now),
    );
  }

  async runOneJob() {
    const due = this.h.jobs.items.flatMap((item, i) => (item.at <= this.now ? [i] : []));
    if (!due.length) return;
    const [item] = this.h.jobs.items.splice(pick(this.rand, due), 1);
    const message = item!.message;
    if (message.type === 'flow_step') {
      this.log(`step ${message.runId.slice(-6)} ${message.nodeId}#${message.attempt}`);
      await runStep(this.h.env, message, this.now);
    } else if (message.type === 'flow_events') {
      await enrollFromEvents(this.h.env, this.now);
    }
  }

  async runOneSend() {
    const due = this.sends.due();
    if (!due.length) return;
    const index = pick(this.rand, due);
    const message = this.sends.items[index]!.message;
    this.log(`send queue delivers ${message.type}`);
    await this.sends.consume(index, this.rand() < 0.15 ? 2 : 1);
  }

  async advance(ms: number) {
    this.h.clock.now += ms;
    this.log(`clock +${Math.round(ms / 60_000)}m`);
    await sweepFlows(this.h.env, this.now);
  }

  /** The Member reads their newest email: a real open or click, which can wake a wait. */
  async engage(member: FuzzMember) {
    const delivery = await env.DB.prepare(
      `SELECT d.id, d.broadcast_id, d.sent_at, l.id AS link FROM deliveries d
         LEFT JOIN link_targets l ON l.broadcast_id = d.broadcast_id
        WHERE d.member_id = ?1 ORDER BY d.sent_at DESC, d.id DESC LIMIT 1`,
    )
      .bind(member.id)
      .first<{ id: string; broadcast_id: string; sent_at: number; link: string | null }>();
    if (!delivery) return;
    const signals = {
      method: 'GET',
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
      asn: null,
      asOrganization: null,
      ip: null,
    };
    this.log(`engage ${member.email}`);
    if (this.rand() < 0.5 || !delivery.link) {
      await recordOpen(env.DB, delivery.id, signals, this.now);
    } else {
      await recordClick(
        env.DB,
        {
          deliveryId: delivery.id,
          linkTargetId: delivery.link,
          broadcastId: delivery.broadcast_id,
          sentAt: delivery.sent_at,
        },
        signals,
        this.now + 5000,
      );
    }
  }

  async toggleFlow() {
    const flow = pick(this.rand, this.flows);
    const row = await env.DB.prepare('SELECT status FROM flows WHERE id = ?1')
      .bind(flow.id)
      .first<{ status: string }>();
    const next = row?.status === 'live' ? 'paused' : 'live';
    this.log(`flow ${flow.id.slice(-6)} -> ${next}`);
    await env.DB.prepare('UPDATE flows SET status = ?1 WHERE id = ?2').bind(next, flow.id).run();
    if (next === 'live') await resumeFlowRuns(this.h.env, flow.id, this.now);
  }

  /** Publishes the same graph as a new version; in-progress runs stay or are migrated. */
  async publishNewVersion() {
    const flow = pick(this.rand, this.flows);
    const version = flow.version + 1;
    const migrate = this.rand() < 0.5;
    this.log(`publish v${version} of ${flow.id.slice(-6)}${migrate ? ' and migrate' : ''}`);
    const broadcasts = await publishVersion(this.seed, flow.id, version, flow.graph);
    for (const id of Object.values(broadcasts)) await addLinkTarget(id);
    await env.DB.batch([
      env.DB.prepare(
        'UPDATE flow_versions SET retired_at = ?1 WHERE flow_id = ?2 AND version = ?3',
      ).bind(this.now, flow.id, flow.version),
      env.DB.prepare('UPDATE flows SET live_version = ?1 WHERE id = ?2').bind(version, flow.id),
    ]);
    if (migrate) await migrateRuns(this.h.env, flow.id, flow.version, version, this.now);
    flow.version = version;
  }

  /** Lets everything finish: no failures left to inject, the clock jumps to whatever is next. */
  async settle() {
    this.webhookFails = 0;
    this.throttle = 0;
    for (const flow of this.flows) {
      await env.DB.prepare("UPDATE flows SET status = 'live' WHERE id = ?1").bind(flow.id).run();
      await resumeFlowRuns(this.h.env, flow.id, this.now);
    }
    await sweepFlows(this.h.env, this.now);
    // A Flow can legitimately re-fire its own trigger with a delay inside (re-entry is allowed
    // and within the hourly cap), and that never ends. Past the horizon the Flows are archived.
    const horizon = this.now + SETTLE_HORIZON_MS;
    let archived = false;
    for (let guard = 0; guard < 2000; guard++) {
      if (!archived && this.now > horizon) {
        archived = true;
        for (const flow of this.flows) {
          await env.DB.prepare("UPDATE flows SET status = 'archived' WHERE id = ?1")
            .bind(flow.id)
            .run();
        }
      }
      const ran = (await this.h.drain()) + (await this.sends.consumeDue());
      if (ran) continue;
      const open = await env.DB.prepare(
        `SELECT min(next_at) AS at FROM flow_runs WHERE channel_id = ?1 AND status IN ('running', 'waiting')`,
      )
        .bind(this.seed.channelId)
        .first<{ at: number | null }>();
      const waiting = [
        open?.at ?? null,
        ...this.h.jobs.items.map((i) => i.at),
        ...this.sends.items.map((i) => i.at),
      ].filter((at): at is number => at !== null);
      const events = await count(
        'SELECT count(*) AS n FROM member_events WHERE processed_at IS NULL',
      );
      if (!waiting.length && !events) return;
      this.h.clock.now = Math.max(
        this.now + 1000,
        ...(waiting.length ? [Math.min(...waiting)] : []),
      );
      await sweepFlows(this.h.env, this.now);
    }
    const open = await env.DB.prepare(
      `SELECT r.id, r.status, r.exit_reason, r.current_node_id, r.next_at, r.version, r.wait_json,
              (SELECT json_group_array(s.node_id || '#' || s.attempt || ':' || s.status)
                 FROM flow_run_steps s WHERE s.run_id = r.id) AS steps
         FROM flow_runs r WHERE r.channel_id = ?1 AND r.status IN ('running', 'waiting')`,
    )
      .bind(this.seed.channelId)
      .all();
    const pendingEvents = await env.DB.prepare(
      'SELECT seq, type, member_id, created_at FROM member_events WHERE processed_at IS NULL ORDER BY seq LIMIT 8',
    ).all();
    throw new Error(
      `the round did not settle at +${this.now - START}ms; events ${JSON.stringify(pendingEvents.results)}; at +${this.now - START}ms; jobs ${JSON.stringify(this.h.jobs.items.slice(0, 5))}, ` +
        `sends ${JSON.stringify(this.sends.items.slice(0, 5))}, open runs ${JSON.stringify(open.results)}`,
    );
  }
}

async function buildRound(rand: Rand, stats: Stats): Promise<Round> {
  const seed = await seedChannel();
  // Bounces stop mailing at once, paid plan or not: a subscriber held for an admin is still mailed
  // by design (docs/deliverability.md "Bounces"), which this fuzz would count as a leak.
  await env.DB.prepare(
    `INSERT INTO bounce_policies (workspace_id, hard_bounces, soft_streak, ask_for_paid, updated_at)
     VALUES (?1, 1, 3, 0, ?2)`,
  )
    .bind(seed.workspaceId, START)
    .run();
  // A second Channel of the workspace: its Channel-only suppressions must not stop this one.
  const otherChannelId = newId('channel', START);
  await env.DB.prepare(
    `INSERT INTO channels (id, workspace_id, slug, name, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'Other', ?4, ?4)`,
  )
    .bind(otherChannelId, seed.workspaceId, `ch-${otherChannelId.slice(-12)}`, START)
    .run();

  const tags: Refs['tags'] = [];
  for (const name of ['red', 'green', 'blue']) {
    tags.push({ id: await makeTag(seed.channelId, name), name });
  }
  const levelId = newId('membershipLevel', START);
  await env.DB.prepare(
    `INSERT INTO membership_levels (id, channel_id, name, created_at, updated_at) VALUES (?1, ?2, 'Pro', ?3, ?3)`,
  )
    .bind(levelId, seed.channelId, START)
    .run();
  const refs: Refs = {
    tags,
    levelId,
    fieldId: await addField(seed.channelId, 'company', 'text'),
    operatorId: await makeAdmin(seed.workspaceId, `admin-${levelId.slice(-12)}@ops.example`),
  };
  const timezoneField = await addField(seed.channelId, 'timezone', 'text');

  const h = harness(START, {
    fetch: async () => new Response(null, { status: rand() < round.webhookFails ? 503 : 204 }),
  });
  const sends = attachPipeline(h);
  const webhookSecretEnc = await encrypt(testFieldKeys, 'whsec_fuzz');

  // The trigger the main Flow listens to, fired the way the product fires it.
  const triggerTag = pick(rand, tags);
  const kind = rand();
  const useTag = kind < 0.25;
  const useReferral = !useTag && kind < 0.45;
  const first = useTag
    ? { event: 'tag_added', tagId: triggerTag.id }
    : useReferral
      ? { event: 'referral_succeeded' }
      : { event: 'api_event', name: 'go' };
  // Sometimes a second start event, which a Member can match in the same moment as the first.
  const withSecond = rand() < 0.3;
  const trigger = withSecond
    ? { ...first, alsoStartOn: [{ event: 'api_event', name: 'also' }] }
    : first;
  const fire = async (member: FuzzMember) => {
    if (withSecond && rand() < 0.5) {
      await recordMemberEvent(
        env.DB,
        { type: 'api_event', memberId: member.id, payload: { name: 'also' } },
        h.clock.now,
      );
    }
    if (useReferral) {
      // A held referral a teammate approves, the emitter with no delivery to fake. Each counts once.
      const referredId = await addMember(
        seed.channelId,
        `referred-${crypto.randomUUID()}@example.com`,
      );
      const referralId = newId('referral');
      await env.DB.prepare(
        `INSERT INTO referrals (id, channel_id, referrer_id, referred_id, created_at, status)
         VALUES (?1, ?2, ?3, ?4, ?5, 'held')`,
      )
        .bind(referralId, seed.channelId, member.id, referredId, h.clock.now)
        .run();
      await reviewReferral(
        { db: env.DB },
        { channelId: seed.channelId, referralId, operatorId: refs.operatorId, approve: true },
        h.clock.now,
      );
    } else if (useTag) {
      await env.DB.prepare('DELETE FROM member_tags WHERE member_id = ?1 AND tag_id = ?2')
        .bind(member.id, triggerTag.id)
        .run();
      await env.DB.batch(tagStatements(env.DB, member.id, [triggerTag.id], h.clock.now));
    } else {
      await recordMemberEvent(
        env.DB,
        { type: 'api_event', memberId: member.id, payload: { name: 'go' } },
        h.clock.now,
      );
    }
  };

  const round: Round = new Round(rand, h, sends, { ...seed, otherChannelId }, refs, fire);
  sends.outbox.onSend = (mail) => round.judge(mail, stats);
  sends.outbox.fail = () =>
    rand() < round.throttle ? new MailProviderError(429, 'throttled', 'Slow down', 30) : null;

  const publish = async (graph: FlowGraph) => {
    const published = await publishFlow(seed, graph, {
      reentry: rand() < 0.5 ? 'never' : 'after_exit',
      webhookSecretEnc,
    });
    for (const id of Object.values(published.broadcasts)) await addLinkTarget(id);
    round.flows.push({ id: published.flowId, version: 1, graph });
    return published;
  };

  // Most rounds run under inbox rules, read in the publication's zone or the Member's own.
  const channelZone = pick(rand, ZONES);
  if (rand() < RULES_CHANCE) {
    round.rules = randomRules(rand);
    round.log(`rules ${JSON.stringify(round.rules)} in ${channelZone}`);
    await saveInboxRules(
      env.DB,
      seed.channelId,
      { rules: round.rules, timezone: channelZone },
      START,
    );
  }
  const target = await publish(
    randomGraph(rand, { event: 'api_event', name: 'enrolled_only' }, refs),
  );
  const main = await publish(randomGraph(rand, trigger, { ...refs, targetFlowId: target.flowId }));

  // Sometimes the Flow emails go through a small Reputation Ramp, so a send can be deferred.
  if (rand() < 0.3) {
    const ramp = await ensureRamp(env.DB, seed.channelId, null, START);
    await env.DB.prepare('UPDATE reputation_ramps SET cap_today = ?1 WHERE id = ?2')
      .bind(1 + below(rand, 4), ramp.id)
      .run();
    for (const id of [...Object.values(main.broadcasts), ...Object.values(target.broadcasts)]) {
      await env.DB.prepare('UPDATE broadcasts SET ramp_id = ?1 WHERE id = ?2')
        .bind(ramp.id, id)
        .run();
    }
  }

  const size = 6 + below(rand, 5);
  for (let i = 0; i < size; i++) {
    const address = `fuzz-${seed.channelId.slice(-10)}-${i}@example.com`;
    const id = await addMember(seed.channelId, address);
    if (rand() < 0.5) {
      await env.DB.prepare(
        `INSERT INTO member_entitlements (member_id, channel_id, kind, source, starts_at) VALUES (?1, ?2, 'paid', 'comp', 0)`,
      )
        .bind(id, seed.channelId)
        .run();
    }
    let zone = round.rules ? channelZone : 'UTC';
    if (rand() < 0.3) {
      zone = pick(rand, ZONES);
      await env.DB.prepare(
        `INSERT INTO member_field_values (member_id, field_id, value_text, updated_at) VALUES (?1, ?2, ?3, ?4)`,
      )
        .bind(id, timezoneField, zone, START)
        .run();
    }
    round.members.push({ id, email: address, control: i === 0, closed: null, gone: false, zone });
  }
  return round;
}

/** One random action. The weights keep queues moving while Members keep changing. */
async function act(round: Round, stats: Stats) {
  const { rand } = round;
  const anyone = pick(rand, round.members);
  const changeable = round.members.filter((m) => !m.control && !m.closed);
  const roll = rand();
  if (roll < 0.05) {
    if (changeable.length) {
      // Half the time someone whose email is held right now, if there is anyone.
      const held: FuzzMember[] = [];
      for (const member of changeable) {
        if ((await round.heldRuns(member)).length) held.push(member);
      }
      const from = held.length && rand() < 0.5 ? held : changeable;
      await round.close(pick(rand, from), pick(rand, CLOSING_CHANGES), stats);
    }
  } else if (roll < 0.06) {
    const paused = round.members.filter((m) => m.closed?.change === 'pause');
    if (paused.length) {
      const member = pick(rand, paused);
      round.log(`resume ${member.email}`);
      await resumeMember(env.DB, member.id, round.now);
      member.closed = null;
    }
  } else if (roll < 0.08) {
    if (!anyone.gone) await round.harmless(anyone);
  } else if (roll < 0.14) {
    // Also fires for Members who already left: enrolling them must not mail them either.
    if (!anyone.gone) {
      round.log(`fire for ${anyone.email}`);
      await round.fire(anyone);
    }
  } else if (roll < 0.19) {
    await enrollFromEvents(round.h.env, round.now);
  } else if (roll < 0.59) {
    await round.runOneJob();
  } else if (roll < 0.76) {
    await round.runOneSend();
  } else if (roll < 0.86) {
    await round.advance((1 + below(rand, 90)) * 60_000);
  } else if (roll < 0.91) {
    await round.advance((1 + below(rand, 20)) * HOUR);
  } else if (roll < 0.95) {
    if (!anyone.gone) await round.engage(anyone);
  } else if (roll < 0.965) {
    await round.post(rand);
  } else if (roll < 0.975) {
    if (round.rules && rand() < 0.5) await round.changeRules(rand);
  } else if (roll < 0.985) {
    await round.toggleFlow();
  } else {
    await round.publishNewVersion();
  }
}

const localDay = (ms: number, zone: string) =>
  new Date(ms).toLocaleDateString('en-CA', { timeZone: zone });

/**
 * Every email the rules cover, judged by the moment the engine let it go. Emails marked send
 * regardless are left out of the counts here, since they may pass a limit on purpose; the engine
 * test covers that they use it up.
 */
async function assertRulesKept(round: Round, stats: Stats) {
  const rules = round.rules;
  if (!rules || round.rulesChanged) return;
  const rows = await env.DB.prepare(
    `SELECT member_id, sent_at FROM flow_email_ledger
      WHERE channel_id = ?1 AND send_regardless = 0 ORDER BY sent_at`,
  )
    .bind(round.seed.channelId)
    .all<{ member_id: string; sent_at: number }>();
  for (const { member_id: memberId, sent_at: at } of rows.results) {
    const member = round.members.find((m) => m.id === memberId);
    if (!member) continue;
    stats.checkedAgainstRules++;
    const within = (windowMs: number) =>
      rows.results.filter(
        (r) => r.member_id === memberId && r.sent_at <= at && r.sent_at > at - windowMs,
      ).length;
    const where = `${member.email} at +${at - START}ms under ${JSON.stringify(rules)}`;
    if (rules.quietHours && inQuietHours(at, rules.quietHours, member.zone)) {
      round.violations.push(`an email went in quiet hours: ${where}`);
    }
    if (rules.perDay !== null && within(DAY_MS) > rules.perDay) {
      round.violations.push(`an email went over the daily limit: ${where}`);
    }
    if (rules.perWeek !== null && within(7 * DAY_MS) > rules.perWeek) {
      round.violations.push(`an email went over the weekly limit: ${where}`);
    }
    if (rules.newsletterDay) {
      const around = rules.newsletterDay.hoursAround * HOUR;
      for (const post of round.posts) {
        if (post.knownFrom > at || (post.memberId !== null && post.memberId !== memberId)) continue;
        if (
          localDay(post.at, member.zone) === localDay(at, member.zone) ||
          Math.abs(post.at - at) < around
        ) {
          round.violations.push(
            `an email went too close to a post at +${post.at - START}ms: ${where}`,
          );
        }
      }
    }
  }
}

/** Nobody's email is lost in a hold, and nobody who left while held got it. */
async function assertHolds(round: Round, stats: Stats) {
  const { channelId } = round.seed;
  // Everything finished, so no hold is still waiting on a run that can go on.
  expect(
    await count(
      `SELECT count(*) AS n FROM flow_holds h JOIN flow_runs r ON r.id = h.run_id
        WHERE h.channel_id = ?1 AND h.released_at IS NULL AND r.status IN ('running', 'waiting')`,
      channelId,
    ),
  ).toBe(0);
  for (const member of round.members) {
    for (const runId of member.closed?.heldRuns ?? []) {
      if (member.gone) {
        // The holds went with the Member, and judge() would have seen any mail.
        continue;
      }
      expect(
        await count(
          `SELECT count(*) AS n FROM flow_holds WHERE run_id = ?1 AND outcome = 'sent'`,
          runId,
        ),
      ).toBe(0);
    }
  }
  // A hold on someone who stayed only ends without the email for a reason the run states.
  const control = round.members.find((m) => m.control)!;
  const lost = await env.DB.prepare(
    `SELECT h.outcome, r.exit_reason FROM flow_holds h JOIN flow_runs r ON r.id = h.run_id
      WHERE h.member_id = ?1 AND h.outcome = 'left' AND r.exit_reason IN ('member_inactive', 'suppressed')`,
  )
    .bind(control.id)
    .all();
  expect(lost.results).toEqual([]);
  stats.held += await count(
    'SELECT count(*) AS n FROM flow_holds WHERE channel_id = ?1',
    channelId,
  );
  stats.heldThenSent += await count(
    `SELECT count(*) AS n FROM flow_holds WHERE channel_id = ?1 AND outcome = 'sent'`,
    channelId,
  );
}

/** What must hold once everything has finished. */
async function assertFinal(round: Round, stats: Stats) {
  await assertRulesKept(round, stats);
  expect(round.violations).toEqual([]);
  const { channelId } = round.seed;
  await assertHolds(round, stats);

  // Never twice: one hand-off per (Flow Broadcast, address), whatever the queues did. A throttled
  // attempt isn't accepted, so `accepted` is what counts here.
  const handed = round.sends.outbox.accepted.map((m) => `${m.tags?.broadcast}:${m.to}`);
  expect(handed.length).toBe(new Set(handed).size);

  // Nor twice from two versions of a Flow: every version's Broadcast of an email is the same email.
  const emails = await env.DB.prepare(
    `SELECT fe.broadcast_id, fe.dispatch_id FROM flow_emails fe JOIN flows f ON f.id = fe.flow_id
      WHERE f.channel_id = ?1`,
  )
    .bind(channelId)
    .all<{ broadcast_id: string; dispatch_id: string }>();
  const emailOf = new Map(emails.results.map((e) => [e.broadcast_id, e.dispatch_id]));
  const sameEmail = round.sends.outbox.accepted.map(
    (m) => `${emailOf.get(m.tags?.broadcast ?? '')}:${m.to}`,
  );
  expect(sameEmail.length).toBe(new Set(sameEmail).size);

  // Nothing is left in flight, and the rows agree with the mail.
  const stuck = await count(
    `SELECT count(*) AS n FROM broadcast_recipients r JOIN broadcasts b ON b.id = r.broadcast_id
      WHERE b.channel_id = ?1 AND r.status IN ('pending', 'sending')`,
    channelId,
  );
  expect(stuck).toBe(0);
  expect(await count('SELECT count(*) AS n FROM deliveries WHERE channel_id = ?1', channelId)).toBe(
    handed.length,
  );

  // No delivery was recorded after the Member left.
  for (const member of round.members) {
    if (!member.closed || member.gone) continue;
    expect(
      await count(
        'SELECT count(*) AS n FROM deliveries WHERE member_id = ?1 AND sent_at > ?2',
        member.id,
        member.closed.at,
      ),
    ).toBe(0);
  }

  // The gate is not a wall: a Member who stayed got every email their run's steps sent.
  const control = round.members.find((m) => m.control)!;
  const sendNodes = new Set(
    round.flows.flatMap((f) =>
      f.graph.nodes.filter((n) => n.type === 'send_email').map((n) => n.id),
    ),
  );
  const steps = await env.DB.prepare(
    `SELECT s.node_id, json_extract(s.result_json, '$.broadcastId') AS broadcast_id
       FROM flow_run_steps s JOIN flow_runs r ON r.id = s.run_id
      WHERE r.member_id = ?1 AND s.status = 'done'`,
  )
    .bind(control.id)
    .all<{ node_id: string; broadcast_id: string | null }>();
  for (const step of steps.results) {
    if (!sendNodes.has(step.node_id) || !step.broadcast_id) continue;
    expect(handed).toContain(`${step.broadcast_id}:${control.email}`);
  }

  stats.stoppedAtSendTime += await count(
    `SELECT count(*) AS n FROM broadcast_recipients r JOIN broadcasts b ON b.id = r.broadcast_id
      WHERE b.channel_id = ?1 AND r.status = 'skipped'`,
    channelId,
  );
  const exits = await env.DB.prepare(
    `SELECT exit_reason, count(*) AS n FROM flow_runs WHERE channel_id = ?1 AND exit_reason IS NOT NULL GROUP BY exit_reason`,
  )
    .bind(channelId)
    .all<{ exit_reason: string; n: number }>();
  for (const { exit_reason, n } of exits.results) {
    stats.exits[exit_reason] = (stats.exits[exit_reason] ?? 0) + n;
  }
}

function replayMessage(seed: number, round: Round | null, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const lines = [
    `Flow fuzz failure with seed ${seed}. Replay this round with:`,
    `  FLOW_FUZZ_SEED=${seed} FLOW_FUZZ_ITERATIONS=1 pnpm --filter @swarm/jobs exec vitest run tests/flows-fuzz.test.ts`,
    '',
    message,
  ];
  if (round) {
    lines.push(
      '',
      'Graphs:',
      ...round.flows.map((f) =>
        JSON.stringify({
          flow: f.id,
          nodes: f.graph.nodes.map((n) => `${n.id}:${n.type}`),
          edges: f.graph.edges.map((e) => `${e.from}-${e.label}->${e.to}`),
        }),
      ),
      '',
      'Last actions:',
      ...round.trace.slice(-60),
    );
  }
  return lines.join('\n');
}

describe('Flows: no email reaches a Member who should not get it (fuzz)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    `holds over ${iterations} random rounds from seed ${baseSeed}`,
    async () => {
      const stats = newStats();
      for (let i = 0; i < iterations; i++) {
        const seed = roundSeed(i);
        const rand = mulberry32(seed);
        // Ids come from the seed too: A/B arms hash the run id, so a replay takes the same paths.
        const idRand = mulberry32(seed ^ 0xa5a5a5a5);
        vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
          const bytes = array as unknown as Uint8Array;
          for (let b = 0; b < bytes.length; b++) bytes[b] = below(idRand, 256);
          return array;
        });
        let round: Round | null = null;
        try {
          round = await buildRound(rand, stats);
          // Most Members enter early, so there is something in flight to disturb.
          for (const member of round.members) {
            if (rand() < 0.7) await round.fire(member);
          }
          await enrollFromEvents(round.h.env, round.now);
          for (round.tick = 0; round.tick < TICKS; round.tick++) await act(round, stats);
          // Whoever is held right now may unsubscribe while they wait.
          for (const member of round.members) {
            if (member.control || member.closed) continue;
            if ((await round.heldRuns(member)).length && rand() < 0.6) {
              await round.close(member, 'unsubscribe_member_center', stats);
            }
          }
          // A last chance to fire and to leave, right before everything drains.
          for (const member of round.members) {
            if (!member.gone) await round.fire(member);
          }
          await round.settle();
          await assertFinal(round, stats);
        } catch (error) {
          throw new Error(replayMessage(seed, round, error), { cause: error });
        }
      }
      console.log(`flow fuzz: seed ${baseSeed}, ${iterations} rounds, ${JSON.stringify(stats)}`);

      // A run that exercised nothing proves nothing. Short replays of one seed are exempt.
      if (iterations >= DEFAULT_ITERATIONS) {
        expect(stats.handedToProvider).toBeGreaterThan(0);
        expect(Object.keys(stats.changes).length).toBeGreaterThanOrEqual(6);
        expect(stats.exits.member_inactive ?? 0).toBeGreaterThan(0);
        expect(stats.stoppedAtSendTime).toBeGreaterThan(0);
        // Inbox rules really held emails, let them go, and let some go stale.
        expect(stats.held).toBeGreaterThan(0);
        expect(stats.heldThenSent).toBeGreaterThan(0);
        expect(stats.exits.hold_expired ?? 0).toBeGreaterThan(0);
        expect(stats.checkedAgainstRules).toBeGreaterThan(0);
        // Members left while held, unsubscribing among them, and judge() saw no mail to them.
        expect(stats.closedWhileHeld).toBeGreaterThan(0);
        expect(stats.unsubscribedWhileHeld).toBeGreaterThan(0);
      }
    },
    Math.max(120_000, iterations * 15_000),
  );
});
