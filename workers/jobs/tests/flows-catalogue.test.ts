// Exit gate of Phase 6: the full trigger and action catalogue, end to end. Each trigger is fired by
// the code that fires it in the product (not by writing the event by hand) and must end in an email
// handed to the provider; a Flow listening for something else must stay empty. The two triggers
// emitted by other workers are written with the payload those workers write and their emitters are
// tested there: gate_hit in workers/site/tests/money.test.ts, api_event in workers/api/tests/v2.test.ts.
import { env } from 'cloudflare:test';
import { FlowGraphSchema, newId, type FlowGraph } from '@swarm/domain';
import {
  checkMilestones,
  checkUnengaged,
  confirmRequest,
  countReferrals,
  enrollFromEvents,
  fieldValueStatements,
  grantComp,
  loadAsk,
  recomputeEntitlement,
  recordAskAnswers,
  recordClick,
  recordMemberEvent,
  recordOpen,
  recordReferral,
  reviewReferral,
  revokeCompGrants,
  subscribe,
  tagRemovedEventStatement,
  tagStatements,
  abArm,
  type ChannelField,
} from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { toStored } from '@swarm/vault/testing';
import { refreshCircle } from '../src/handlers/circles';
import { addField, addMember, count, jobsEnv, one, seedChannel, testFieldKeys } from './helpers';
import {
  DAY,
  HOUR,
  addLinkTarget,
  attachPipeline,
  dispatchId,
  harness,
  makeAdmin,
  makeTag,
  publishFlow,
  runsOf,
  stepsOf,
  type Harness,
  type PublishedFlow,
  type SendPipeline,
} from './flows-helpers';
import { testLinks } from './links';

type Seed = Awaited<ReturnType<typeof seedChannel>>;
type RawNode = { id: string; type: string; config: Record<string, unknown> };
type RawEdge = { from: string; to: string; label?: string };

const graph = (nodes: RawNode[], edges: RawEdge[]): FlowGraph =>
  FlowGraphSchema.parse({ schema: 1, nodes, edges });

/** trigger → email. */
const emailFlow = (trigger: Record<string, unknown>) =>
  graph(
    [
      { id: 'trigger', type: 'trigger', config: trigger },
      { id: 'email', type: 'send_email', config: { dispatchId: dispatchId() } },
    ],
    [{ from: 'trigger', to: 'email' }],
  );

const address = (label = 'm') => `${label}-${crypto.randomUUID()}@example.com`;

const human = {
  method: 'GET',
  userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
  asn: null,
  asOrganization: null,
  ip: null,
};

interface World {
  seed: Seed;
  h: Harness;
  sends: SendPipeline;
}

async function world(start?: number): Promise<World> {
  const seed = await seedChannel();
  const h = harness(start);
  return { seed, h, sends: attachPipeline(h) };
}

/** Everything that is due: enrolment, steps, and the send queue up to the provider. */
async function settle({ h, sends }: World) {
  for (let i = 0; i < 20; i++) {
    await enrollFromEvents(h.env, h.clock.now);
    const ran = (await h.drain()) + (await sends.consumeDue());
    if (!ran) return;
  }
}

/** The Flow's email reached this address, and the run finished. */
async function expectFired(w: World, flow: PublishedFlow, email: string) {
  await settle(w);
  const mail = w.sends.outbox.accepted.filter(
    (m) => m.to === email && m.tags?.broadcast === flow.broadcasts.email,
  );
  expect(mail).toHaveLength(1);
  const member = await one<{ id: string }>('SELECT id FROM members WHERE email = ?1', email);
  const runs = await runsOf(flow.flowId, member!.id);
  expect(runs.map((r) => r.status)).toEqual(['completed']);
}

const expectQuiet = async (flow: PublishedFlow) => expect(await runsOf(flow.flowId)).toEqual([]);

function subscribeDeps(h: Harness) {
  return {
    db: env.DB,
    mail: h.mail,
    links: testLinks(),
    captureOrigin: 'https://forms.swarm.test',
    platformMailDomain: 'mail.swarm.test',
    fieldKeys: testFieldKeys,
    now: () => h.clock.now,
  };
}

async function makeForm(seed: Seed) {
  const id = newId('captureForm');
  await env.DB.prepare(
    `INSERT INTO capture_forms (id, workspace_id, channel_id, name, draft_config_json, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'Footer', '{}', 0, 0)`,
  )
    .bind(id, seed.workspaceId, seed.channelId)
    .run();
  return id;
}

const signUp = (
  w: World,
  input: { email: string; formId?: string | null; doubleOptIn?: boolean },
) =>
  subscribe(subscribeDeps(w.h), {
    channelId: w.seed.channelId,
    workspaceId: w.seed.workspaceId,
    formId: input.formId ?? null,
    email: input.email,
    doubleOptIn: input.doubleOptIn ?? false,
  });

async function makeLevel(seed: Seed, name = 'Pro') {
  const id = newId('membershipLevel');
  await env.DB.prepare(
    `INSERT INTO membership_levels (id, channel_id, name, created_at, updated_at) VALUES (?1, ?2, ?3, 0, 0)`,
  )
    .bind(id, seed.channelId, name)
    .run();
  return id;
}

describe('Flow triggers: the real event ends in an email', () => {
  it('member_joined: any source or one form, and imports only when asked', async () => {
    const w = await world();
    const form = await makeForm(w.seed);
    const otherForm = await makeForm(w.seed);
    const any = await publishFlow(w.seed, emailFlow({ event: 'member_joined' }));
    const byForm = await publishFlow(w.seed, emailFlow({ event: 'member_joined', formId: form }));
    const wrong = await publishFlow(
      w.seed,
      emailFlow({ event: 'member_joined', formId: otherForm }),
    );
    const email = address();
    expect((await signUp(w, { email, formId: form })).outcome).toBe('created_active');
    await expectFired(w, any, email);
    await expectFired(w, byForm, email);
    await expectQuiet(wrong);
  });

  // The audit found this trigger had no test at all.
  it('form_submitted: a new Member, and an existing one submitting again', async () => {
    const w = await world();
    const form = await makeForm(w.seed);
    const otherForm = await makeForm(w.seed);
    const any = await publishFlow(w.seed, emailFlow({ event: 'form_submitted' }));
    const byForm = await publishFlow(w.seed, emailFlow({ event: 'form_submitted', formId: form }));
    const wrong = await publishFlow(
      w.seed,
      emailFlow({ event: 'form_submitted', formId: otherForm }),
    );

    const newcomer = address('new');
    await signUp(w, { email: newcomer, formId: form });
    await expectFired(w, any, newcomer);
    await expectFired(w, byForm, newcomer);
    await expectQuiet(wrong);

    // Somebody already on the list fills in the form: no new Member, but the Flow still starts.
    const existing = address('old');
    await addMember(w.seed.channelId, existing);
    expect((await signUp(w, { email: existing, formId: form })).outcome).not.toBe('created_active');
    await expectFired(w, any, existing);
    await expectFired(w, byForm, existing);
    await expectQuiet(wrong);
  });

  it('form_submitted does not fire without a form (the API and imports are not forms)', async () => {
    const w = await world();
    const flow = await publishFlow(w.seed, emailFlow({ event: 'form_submitted' }));
    await signUp(w, { email: address() });
    await settle(w);
    await expectQuiet(flow);
  });

  it('confirmed: on the confirm link under double opt-in, not at sign-up', async () => {
    const w = await world();
    const form = await makeForm(w.seed);
    const otherForm = await makeForm(w.seed);
    const flow = await publishFlow(w.seed, emailFlow({ event: 'confirmed', formId: form }));
    const wrong = await publishFlow(w.seed, emailFlow({ event: 'confirmed', formId: otherForm }));
    const email = address();
    const { memberId } = await signUp(w, { email, formId: form, doubleOptIn: true });
    await settle(w);
    await expectQuiet(flow);

    const request = await one<{ id: string }>(
      'SELECT id FROM confirm_requests WHERE member_id = ?1',
      memberId,
    );
    expect((await confirmRequest(env.DB, request!.id, w.h.clock.now)).outcome).toBe('confirmed');
    await expectFired(w, flow, email);
    await expectQuiet(wrong);
  });

  it('circle_entered and circle_exited: from a Circle refresh', async () => {
    const w = await world();
    const { workspaceId, channelId } = w.seed;
    const circleId = newId('circle');
    const otherCircle = newId('circle');
    const rule = (name: string) => JSON.stringify({ field: 'first_name', cmp: 'eq', value: name });
    for (const [id, name] of [
      [circleId, 'Ada'],
      [otherCircle, 'Nobody'],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO circles (id, workspace_id, channel_id, name, rule_json, generation, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, 'pending', 0, 0)`,
      )
        .bind(id, workspaceId, channelId, id, rule(name))
        .run();
    }
    const entered = await publishFlow(w.seed, emailFlow({ event: 'circle_entered', circleId }));
    const exited = await publishFlow(w.seed, emailFlow({ event: 'circle_exited', circleId }));
    const wrong = await publishFlow(
      w.seed,
      emailFlow({ event: 'circle_entered', circleId: otherCircle }),
    );
    const leaves = address('leaves');
    const joins = address('joins');
    await addMember(channelId, leaves, { firstName: 'Ada' });
    await addMember(channelId, joins, { firstName: 'Bob' });
    const jobs = jobsEnv().env;
    await refreshCircle(jobs, circleId, 1, w.h.clock.now);
    await env.DB.prepare('UPDATE circles SET rule_json = ?1, generation = 2 WHERE id = ?2')
      .bind(rule('Bob'), circleId)
      .run();
    await refreshCircle(jobs, circleId, 2, w.h.clock.now + 1000);
    await expectFired(w, entered, joins);
    await expectFired(w, exited, leaves);
    await expectQuiet(wrong);
  });

  it('tag_added and tag_removed: only for that tag, and only on a real change', async () => {
    const w = await world();
    const tag = await makeTag(w.seed.channelId);
    const otherTag = await makeTag(w.seed.channelId);
    const added = await publishFlow(w.seed, emailFlow({ event: 'tag_added', tagId: tag }));
    const removed = await publishFlow(w.seed, emailFlow({ event: 'tag_removed', tagId: tag }));
    const wrong = await publishFlow(w.seed, emailFlow({ event: 'tag_added', tagId: otherTag }));
    const email = address();
    const memberId = await addMember(w.seed.channelId, email);
    await env.DB.batch(tagStatements(env.DB, memberId, [tag], w.h.clock.now));
    await expectFired(w, added, email);
    await expectQuiet(wrong);
    await env.DB.batch([
      tagRemovedEventStatement(env.DB, memberId, [tag], 'only', w.h.clock.now),
      env.DB.prepare('DELETE FROM member_tags WHERE member_id = ?1 AND tag_id = ?2').bind(
        memberId,
        tag,
      ),
    ]);
    await expectFired(w, removed, email);
  });

  it('field_changed: only for that field', async () => {
    const w = await world();
    const fieldId = await addField(w.seed.channelId, 'company', 'text');
    const otherField = await addField(w.seed.channelId, 'city', 'text');
    const flow = await publishFlow(w.seed, emailFlow({ event: 'field_changed', fieldId }));
    const wrong = await publishFlow(
      w.seed,
      emailFlow({ event: 'field_changed', fieldId: otherField }),
    );
    const email = address();
    const memberId = await addMember(w.seed.channelId, email);
    const field: ChannelField = {
      id: fieldId,
      key: 'company',
      type: 'text',
      options: [],
      encrypted: false,
      label: 'company',
    };
    const stored = await toStored(field, 'Acme', testFieldKeys);
    await env.DB.batch(
      fieldValueStatements(env.DB, memberId, [{ field, value: 'Acme', stored }], w.h.clock.now),
    );
    await expectFired(w, flow, email);
    await expectQuiet(wrong);
  });

  it('level_purchased and level_canceled: any level or one level', async () => {
    const w = await world();
    const levelId = await makeLevel(w.seed);
    const otherLevel = await makeLevel(w.seed, 'Other');
    const anyLevel = await publishFlow(w.seed, emailFlow({ event: 'level_purchased' }));
    const bought = await publishFlow(w.seed, emailFlow({ event: 'level_purchased', levelId }));
    const canceled = await publishFlow(w.seed, emailFlow({ event: 'level_canceled', levelId }));
    const wrong = await publishFlow(
      w.seed,
      emailFlow({ event: 'level_purchased', levelId: otherLevel }),
    );
    const email = address();
    const memberId = await addMember(w.seed.channelId, email);
    const { channelId } = w.seed;
    await grantComp(
      env.DB,
      { channelId, memberId, levelId, expiresAt: null, note: 'flow-test', grantedBy: null },
      w.h.clock.now,
    );
    await recomputeEntitlement(env.DB, channelId, memberId, w.h.clock.now);
    await expectFired(w, anyLevel, email);
    await expectFired(w, bought, email);
    await expectQuiet(wrong);

    await revokeCompGrants(
      env.DB,
      { channelId, memberId, levelId, noteMarker: 'flow-test' },
      w.h.clock.now,
    );
    await recomputeEntitlement(env.DB, channelId, memberId, w.h.clock.now);
    await expectFired(w, canceled, email);
  });

  it('ask_answered: any answer or one answer', async () => {
    const w = await world();
    const { channelId } = w.seed;
    const askId = newId('ask');
    const questionId = newId('askQuestion');
    const yes = newId('askOption');
    const no = newId('askOption');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO asks (id, channel_id, kind, title, status, created_at, updated_at)
         VALUES (?1, ?2, 'poll', 'Tea?', 'open', 0, 0)`,
      ).bind(askId, channelId),
      env.DB.prepare(
        `INSERT INTO ask_questions (id, ask_id, position, prompt, kind) VALUES (?1, ?2, 0, 'Tea?', 'choice')`,
      ).bind(questionId, askId),
      env.DB.prepare(
        `INSERT INTO ask_options (id, ask_id, question_id, label, position) VALUES (?1, ?2, ?3, 'Yes', 0)`,
      ).bind(yes, askId, questionId),
      env.DB.prepare(
        `INSERT INTO ask_options (id, ask_id, question_id, label, position) VALUES (?1, ?2, ?3, 'No', 1)`,
      ).bind(no, askId, questionId),
    ]);
    const anyAnswer = await publishFlow(w.seed, emailFlow({ event: 'ask_answered', askId }));
    const onlyYes = await publishFlow(
      w.seed,
      emailFlow({ event: 'ask_answered', askId, optionId: yes }),
    );
    const onlyNo = await publishFlow(
      w.seed,
      emailFlow({ event: 'ask_answered', askId, optionId: no }),
    );
    const email = address();
    const memberId = await addMember(channelId, email);
    const ask = await loadAsk(env.DB, askId, channelId);
    const result = await recordAskAnswers(env.DB, {
      ask: ask!,
      memberId,
      surface: 'email',
      answers: [{ questionId, optionId: yes }],
      now: w.h.clock.now,
    });
    expect(result.outcome).toBe('recorded');
    await expectFired(w, anyAnswer, email);
    await expectFired(w, onlyYes, email);
    await expectQuiet(onlyNo);
  });

  it('unengaged: from the daily check, for that many days', async () => {
    const w = await world(Date.now() + 40 * DAY);
    const flow = await publishFlow(w.seed, emailFlow({ event: 'unengaged', days: 30 }));
    const later = await publishFlow(w.seed, emailFlow({ event: 'unengaged', days: 90 }));
    const email = address();
    await addMember(w.seed.channelId, email);
    await checkUnengaged(w.h.env, w.h.clock.now);
    await expectFired(w, flow, email);
    await expectQuiet(later);
  });

  it('link_clicked: a real human click, by Dispatch and URL', async () => {
    const w = await world();
    const source = await publishFlow(w.seed, emailFlow({ event: 'api_event', name: 'start' }));
    const broadcastId = source.broadcasts.email!;
    const linkTargetId = await addLinkTarget(broadcastId, 'https://example.com/read');
    const dispatch = await one<{ dispatch_id: string }>(
      'SELECT dispatch_id FROM broadcasts WHERE id = ?1',
      broadcastId,
    );
    const anyLink = await publishFlow(w.seed, emailFlow({ event: 'link_clicked' }));
    const exact = await publishFlow(
      w.seed,
      emailFlow({
        event: 'link_clicked',
        dispatchId: dispatch!.dispatch_id,
        url: 'https://example.com/read',
      }),
    );
    const wrongUrl = await publishFlow(
      w.seed,
      emailFlow({ event: 'link_clicked', url: 'https://example.com/other' }),
    );
    const email = address();
    const memberId = await addMember(w.seed.channelId, email);
    await recordMemberEvent(
      env.DB,
      { type: 'api_event', memberId, payload: { name: 'start' } },
      w.h.clock.now,
    );
    await settle(w);
    const delivery = await one<{ id: string; sent_at: number }>(
      'SELECT id, sent_at FROM deliveries WHERE member_id = ?1',
      memberId,
    );
    // A scanner fetching the link at once is not a click.
    await recordClick(
      env.DB,
      { deliveryId: delivery!.id, linkTargetId, broadcastId, sentAt: delivery!.sent_at },
      human,
      delivery!.sent_at + 500,
    );
    await settle(w);
    await expectQuiet(anyLink);

    w.h.clock.now += HOUR;
    await recordClick(
      env.DB,
      { deliveryId: delivery!.id, linkTargetId, broadcastId, sentAt: delivery!.sent_at },
      human,
      w.h.clock.now,
    );
    await expectFired(w, anyLink, email);
    await expectFired(w, exact, email);
    await expectQuiet(wrongUrl);
  });

  it('link_clicked: a Flow naming the original address follows its short link', async () => {
    const w = await world();
    const source = await publishFlow(w.seed, emailFlow({ event: 'api_event', name: 'start' }));
    const broadcastId = source.broadcasts.email!;
    const short = 'https://go.example/read-abc';
    const original = 'https://example.com/read';
    const linkTargetId = await addLinkTarget(broadcastId, short);
    const channel = await one<{ workspace_id: string }>(
      'SELECT workspace_id FROM channels WHERE id = ?1',
      w.seed.channelId,
    );
    const connection = `ac_${crypto.randomUUID().replace(/-/g, '')}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO app_connections (id, workspace_id, app, base_url, key_enc, last4, slug_format, created_at, updated_at)
         VALUES (?1, ?2, 'shorthop', 'https://go.example', 'sealed', 'abcd', '{random}', 0, 0)`,
      ).bind(connection, channel!.workspace_id),
      env.DB.prepare(
        `INSERT INTO app_short_links (connection_id, post_id, url, short_url, created_at) VALUES (?1, '', ?2, ?3, 0)`,
      ).bind(connection, original, short),
    ]);
    const byOriginal = await publishFlow(
      w.seed,
      emailFlow({ event: 'link_clicked', url: original }),
    );
    const byShort = await publishFlow(w.seed, emailFlow({ event: 'link_clicked', url: short }));
    const other = await publishFlow(
      w.seed,
      emailFlow({ event: 'link_clicked', url: 'https://example.com/other' }),
    );
    const email = address();
    const memberId = await addMember(w.seed.channelId, email);
    await recordMemberEvent(
      env.DB,
      { type: 'api_event', memberId, payload: { name: 'start' } },
      w.h.clock.now,
    );
    await settle(w);
    const delivery = await one<{ id: string; sent_at: number }>(
      'SELECT id, sent_at FROM deliveries WHERE member_id = ?1',
      memberId,
    );
    w.h.clock.now += HOUR;
    await recordClick(
      env.DB,
      { deliveryId: delivery!.id, linkTargetId, broadcastId, sentAt: delivery!.sent_at },
      human,
      w.h.clock.now,
    );
    await expectFired(w, byOriginal, email);
    await expectFired(w, byShort, email);
    await expectQuiet(other);
  });

  it('gate_hit: any Dispatch or one Dispatch', async () => {
    const w = await world();
    const dispatch = newId('dispatch');
    const other = newId('dispatch');
    for (const id of [dispatch, other]) {
      await env.DB.prepare(
        `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at)
         VALUES (?1, ?2, 'Paid', '{}', 'sent', 0, 0)`,
      )
        .bind(id, w.seed.channelId)
        .run();
    }
    const any = await publishFlow(w.seed, emailFlow({ event: 'gate_hit' }));
    const one_ = await publishFlow(w.seed, emailFlow({ event: 'gate_hit', dispatchId: dispatch }));
    const wrong = await publishFlow(w.seed, emailFlow({ event: 'gate_hit', dispatchId: other }));
    const email = address();
    const memberId = await addMember(w.seed.channelId, email);
    await recordMemberEvent(
      env.DB,
      {
        type: 'gate_hit',
        memberId,
        channelId: w.seed.channelId,
        payload: { dispatchId: dispatch },
      },
      w.h.clock.now,
    );
    await expectFired(w, any, email);
    await expectFired(w, one_, email);
    await expectQuiet(wrong);
  });

  it('api_event: by name', async () => {
    const w = await world();
    const flow = await publishFlow(
      w.seed,
      emailFlow({ event: 'api_event', name: 'trial.started' }),
    );
    const wrong = await publishFlow(w.seed, emailFlow({ event: 'api_event', name: 'trial.ended' }));
    const email = address();
    const memberId = await addMember(w.seed.channelId, email);
    await recordMemberEvent(
      env.DB,
      { type: 'api_event', memberId, payload: { name: 'trial.started', properties: { a: 1 } } },
      w.h.clock.now,
    );
    await expectFired(w, flow, email);
    await expectQuiet(wrong);
  });

  /** A referral of a new Member by `referrerId`, as sign-up records it. */
  async function referral(w: World, referrerId: string, status?: 'held') {
    const email = address('friend');
    const referredId = await addMember(w.seed.channelId, email);
    await env.DB.prepare('UPDATE members SET confirmed_at = ?1 WHERE id = ?2')
      .bind(w.h.clock.now, referredId)
      .run();
    const recorded = await recordReferral(
      env.DB,
      { channelId: w.seed.channelId, referrerId, referredId, referredEmail: email },
      w.h.clock.now,
    );
    expect(recorded).toBe('recorded');
    if (status) {
      await env.DB.prepare(`UPDATE referrals SET status = ?1 WHERE referred_id = ?2`)
        .bind(status, referredId)
        .run();
    }
    const row = await one<{ id: string }>(
      'SELECT id FROM referrals WHERE referred_id = ?1',
      referredId,
    );
    return { referralId: row!.id, referredId };
  }

  /** The human open that makes a referral count. */
  async function humanOpen(w: World, flow: PublishedFlow, memberId: string) {
    await env.DB.prepare(
      `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, sent_at, human_opened_at)
       VALUES (?1, ?2, ?3, ?4, 'friend@example.com', ?5, ?5)`,
    )
      .bind(newId('delivery'), flow.broadcasts.email, w.seed.channelId, memberId, w.h.clock.now)
      .run();
  }

  async function championsOn(w: World) {
    await env.DB.prepare(
      `INSERT INTO champion_settings (channel_id, enabled, updated_at) VALUES (?1, 1, 0)`,
    )
      .bind(w.seed.channelId)
      .run();
  }

  it('referral_succeeded: for the referrer, once the referral counts, and only once', async () => {
    const w = await world();
    await championsOn(w);
    const flow = await publishFlow(w.seed, emailFlow({ event: 'referral_succeeded' }));
    const email = address('referrer');
    const referrerId = await addMember(w.seed.channelId, email);
    const { referralId, referredId } = await referral(w, referrerId);

    // Signed up and confirmed, but no human open yet: it hasn't counted.
    await countReferrals({ db: env.DB }, w.h.clock.now);
    await settle(w);
    await expectQuiet(flow);

    await humanOpen(w, flow, referredId);
    await countReferrals({ db: env.DB }, w.h.clock.now);
    await expectFired(w, flow, email);
    const run = (await runsOf(flow.flowId, referrerId))[0]!;
    expect(JSON.parse(run.context_json).trigger.payload).toEqual({ referralId });
    // The person they referred is not in the Flow, and the next pass emits nothing new.
    expect(await runsOf(flow.flowId, referredId)).toEqual([]);
    await countReferrals({ db: env.DB }, w.h.clock.now);
    expect(
      await count(
        `SELECT count(*) AS n FROM member_events WHERE type = 'referral_succeeded' AND member_id = ?1`,
        referrerId,
      ),
    ).toBe(1);
  });

  it('referral_succeeded: nothing while Champions is off, though the referral still counts', async () => {
    const w = await world();
    const flow = await publishFlow(w.seed, emailFlow({ event: 'referral_succeeded' }));
    const operatorId = await makeAdmin(w.seed.workspaceId, address('admin'));
    const referrerId = await addMember(w.seed.channelId, address('referrer'));
    const { referralId, referredId } = await referral(w, referrerId);
    const held = await referral(w, referrerId, 'held');

    await humanOpen(w, flow, referredId);
    await countReferrals({ db: env.DB }, w.h.clock.now);
    await reviewReferral(
      { db: env.DB },
      { channelId: w.seed.channelId, referralId: held.referralId, operatorId, approve: true },
      w.h.clock.now,
    );
    await settle(w);
    await expectQuiet(flow);
    expect(
      await count(
        `SELECT count(*) AS n FROM referrals WHERE id IN (?1, ?2) AND status = 'counted'`,
        referralId,
        held.referralId,
      ),
    ).toBe(2);
    expect(
      await count(
        `SELECT count(*) AS n FROM member_events WHERE type = 'referral_succeeded' AND member_id = ?1`,
        referrerId,
      ),
    ).toBe(0);

    // Switching it on later doesn't start automations for what was counted while it was off.
    await championsOn(w);
    await countReferrals({ db: env.DB }, w.h.clock.now);
    await settle(w);
    await expectQuiet(flow);
  });

  it('referral_succeeded: also when a teammate approves a held referral, not when they reject it', async () => {
    const w = await world();
    await championsOn(w);
    const flow = await publishFlow(w.seed, emailFlow({ event: 'referral_succeeded' }));
    const operatorId = await makeAdmin(w.seed.workspaceId, address('admin'));
    const rejected = await addMember(w.seed.channelId, address('referrer'));
    const refused = await referral(w, rejected, 'held');
    await reviewReferral(
      { db: env.DB },
      {
        channelId: w.seed.channelId,
        referralId: refused.referralId,
        operatorId,
        approve: false,
      },
      w.h.clock.now,
    );
    await settle(w);
    await expectQuiet(flow);

    const email = address('referrer');
    const referrerId = await addMember(w.seed.channelId, email);
    const held = await referral(w, referrerId, 'held');
    await reviewReferral(
      { db: env.DB },
      { channelId: w.seed.channelId, referralId: held.referralId, operatorId, approve: true },
      w.h.clock.now,
    );
    await expectFired(w, flow, email);
  });

  it('referral_milestone: any milestone or one milestone, once per milestone', async () => {
    const w = await world();
    const milestone = async (required: number) => {
      const id = newId('championMilestone');
      await env.DB.prepare(
        `INSERT INTO champion_milestones (id, channel_id, name, referrals_required, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'active', 0, 0)`,
      )
        .bind(id, w.seed.channelId, `${required} referrals`, required)
        .run();
      return id;
    };
    await championsOn(w);
    const first = await milestone(1);
    const later = await milestone(2);
    const any = await publishFlow(w.seed, emailFlow({ event: 'referral_milestone' }));
    const chosen = await publishFlow(
      w.seed,
      emailFlow({ event: 'referral_milestone', milestoneId: first }),
    );
    const wrong = await publishFlow(
      w.seed,
      emailFlow({ event: 'referral_milestone', milestoneId: later }),
    );
    const email = address('referrer');
    const referrerId = await addMember(w.seed.channelId, email);
    const { referredId } = await referral(w, referrerId);
    await humanOpen(w, any, referredId);
    await countReferrals({ db: env.DB }, w.h.clock.now);
    await expectFired(w, any, email);
    await expectFired(w, chosen, email);
    await expectQuiet(wrong);

    // Checking again finds the award already there, so the event isn't emitted twice.
    await checkMilestones({ db: env.DB }, w.seed.channelId, referrerId, w.h.clock.now);
    expect(
      await count(
        `SELECT count(*) AS n FROM member_events WHERE type = 'referral_milestone' AND member_id = ?1`,
        referrerId,
      ),
    ).toBe(1);
  });
});

/** Fires a Flow for a new Member and lets it run. */
async function run(w: World, g: FlowGraph, options: Parameters<typeof publishFlow>[2] = {}) {
  const flow = await publishFlow(w.seed, g, options);
  const email = address();
  const memberId = await addMember(w.seed.channelId, email);
  await recordMemberEvent(
    env.DB,
    { type: 'api_event', memberId, payload: { name: 'go' } },
    w.h.clock.now,
  );
  await settle(w);
  const [r] = await runsOf(flow.flowId, memberId);
  return { flow, email, memberId, run: r!, steps: await stepsOf(r!.id) };
}

const go = { id: 'trigger', type: 'trigger', config: { event: 'api_event', name: 'go' } };

/**
 * The actions flows.test.ts doesn't check one at a time. delay, change_level, enrol_flow and
 * webhook_call have their own tests there.
 */
describe('Flow actions: what each one does', () => {
  it('send_email hands the provider a tracked email with an unsubscribe and a text part', async () => {
    const w = await world();
    const { email } = await run(
      w,
      graph(
        [go, { id: 'email', type: 'send_email', config: { dispatchId: dispatchId() } }],
        [{ from: 'trigger', to: 'email' }],
      ),
    );
    const [mail] = w.sends.outbox.accepted;
    expect(mail!.to).toBe(email);
    expect(mail!.text).toBeTruthy();
    expect(mail!.html).toBeTruthy();
    expect(mail!.headers?.['List-Unsubscribe']).toContain('/u/');
    expect(mail!.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(mail!.tags?.delivery).toMatch(/^dl_/);
  });

  it('add_tag and remove_tag change the tag and emit the event', async () => {
    const w = await world();
    const add = await makeTag(w.seed.channelId);
    const remove = await makeTag(w.seed.channelId);
    const { memberId, run: r } = await run(
      w,
      graph(
        [
          go,
          { id: 'seed', type: 'add_tag', config: { tagId: remove } },
          { id: 'plus', type: 'add_tag', config: { tagId: add } },
          { id: 'minus', type: 'remove_tag', config: { tagId: remove } },
        ],
        [
          { from: 'trigger', to: 'seed' },
          { from: 'seed', to: 'plus' },
          { from: 'plus', to: 'minus' },
        ],
      ),
    );
    expect(r.status).toBe('completed');
    const tags = await env.DB.prepare('SELECT tag_id FROM member_tags WHERE member_id = ?1')
      .bind(memberId)
      .all<{ tag_id: string }>();
    expect(tags.results.map((t) => t.tag_id)).toEqual([add]);
    expect(
      await count(
        `SELECT count(*) AS n FROM member_events WHERE member_id = ?1 AND type = 'tag_removed'`,
        memberId,
      ),
    ).toBe(1);
  });

  it('update_field writes the value and emits field_changed', async () => {
    const w = await world();
    const fieldId = await addField(w.seed.channelId, 'plan', 'text');
    const { memberId, run: r } = await run(
      w,
      graph(
        [go, { id: 'set', type: 'update_field', config: { fieldId, value: 'gold' } }],
        [{ from: 'trigger', to: 'set' }],
      ),
    );
    expect(r.status).toBe('completed');
    const value = await one<{ value_text: string }>(
      'SELECT value_text FROM member_field_values WHERE member_id = ?1 AND field_id = ?2',
      memberId,
      fieldId,
    );
    expect(value?.value_text).toBe('gold');
    expect(
      await count(
        `SELECT count(*) AS n FROM member_events WHERE member_id = ?1 AND type = 'field_changed'`,
        memberId,
      ),
    ).toBe(1);
  });

  it('update_field pauses the run on a value that does not fit, and is never marked done', async () => {
    const w = await world();
    const fieldId = await addField(w.seed.channelId, 'age', 'number');
    await makeAdmin(w.seed.workspaceId, address('admin'));
    const { run: r, steps } = await run(
      w,
      graph(
        [go, { id: 'set', type: 'update_field', config: { fieldId, value: 'not a number' } }],
        [{ from: 'trigger', to: 'set' }],
      ),
    );
    expect([r.status, r.exit_reason]).toEqual(['paused', 'step_failed']);
    expect(steps.find((s) => s.node_id === 'set')?.status).toBe('failed');
  });

  it('branch follows the condition against the Member as they are now', async () => {
    const w = await world();
    const name = `vip-${crypto.randomUUID().slice(0, 8)}`;
    const tag = await makeTag(w.seed.channelId, name);
    const branching = () =>
      graph(
        [
          go,
          { id: 'tag', type: 'add_tag', config: { tagId: tag } },
          {
            id: 'check',
            type: 'branch',
            config: { condition: { field: 'tag', cmp: 'eq', value: name } },
          },
          { id: 'yes', type: 'exit', config: {} },
          { id: 'no', type: 'exit', config: {} },
        ],
        [
          { from: 'trigger', to: 'tag' },
          { from: 'tag', to: 'check' },
          { from: 'check', to: 'yes', label: 'true' },
          { from: 'check', to: 'no', label: 'false' },
        ],
      );
    const { steps } = await run(w, branching());
    expect(steps.find((s) => s.node_id === 'check')?.outcome).toBe('true');
    expect(steps.map((s) => s.node_id)).toContain('yes');
    expect(steps.map((s) => s.node_id)).not.toContain('no');
  });

  it('ab_split takes the arm the run id hashes to, and both arms get runs', async () => {
    const w = await world();
    const flow = await publishFlow(
      w.seed,
      graph(
        [
          go,
          { id: 'split', type: 'ab_split', config: { percentA: 50 } },
          { id: 'a', type: 'exit', config: {} },
          { id: 'b', type: 'exit', config: {} },
        ],
        [
          { from: 'trigger', to: 'split' },
          { from: 'split', to: 'a', label: 'a' },
          { from: 'split', to: 'b', label: 'b' },
        ],
      ),
    );
    for (let i = 0; i < 24; i++) {
      const memberId = await addMember(w.seed.channelId, address());
      await recordMemberEvent(
        env.DB,
        { type: 'api_event', memberId, payload: { name: 'go' } },
        w.h.clock.now,
      );
    }
    await settle(w);
    const arms = new Set<string>();
    for (const r of await runsOf(flow.flowId)) {
      const steps = await stepsOf(r.id);
      const split = steps.find((s) => s.node_id === 'split')!;
      expect(split.outcome).toBe(await abArm(r.id, 'split', 50));
      expect(steps.map((s) => s.node_id)).toContain(split.outcome!);
      arms.add(split.outcome!);
    }
    expect(arms).toEqual(new Set(['a', 'b']));
  });

  it('wait_for_event wakes on a real open and on a real click of the right URL', async () => {
    const w = await world();
    const steps = (event: string, url?: string) =>
      graph(
        [
          go,
          { id: 'email', type: 'send_email', config: { dispatchId: dispatchId() } },
          {
            id: 'wait',
            type: 'wait_for_event',
            config: { event, timeoutHours: 24, ...(url ? { url } : {}) },
          },
          { id: 'seen', type: 'exit', config: {} },
          { id: 'missed', type: 'exit', config: {} },
        ],
        [
          { from: 'trigger', to: 'email' },
          { from: 'email', to: 'wait' },
          { from: 'wait', to: 'seen' },
          { from: 'wait', to: 'missed', label: 'timeout' },
        ],
      );
    const opened = await run(w, steps('open'));
    expect(opened.run.status).toBe('waiting');
    const delivery = await one<{ id: string }>(
      'SELECT id FROM deliveries WHERE member_id = ?1',
      opened.memberId,
    );
    await recordOpen(env.DB, delivery!.id, human, w.h.clock.now);
    await settle(w);
    expect((await runsOf(opened.flow.flowId))[0]!.exit_reason).toBe('exit_node');
    expect((await stepsOf(opened.run.id)).find((s) => s.node_id === 'wait')?.outcome).toBe(
      'default',
    );

    // A new Channel: the first Flow would enrol this Member too.
    const w2 = await world();
    const clicked = await run(w2, steps('click', 'https://example.com/yes'));
    const broadcastId = clicked.flow.broadcasts.email!;
    const right = await addLinkTarget(broadcastId, 'https://example.com/yes');
    const wrong = newId('linkTarget');
    await env.DB.prepare(
      'INSERT INTO link_targets (id, broadcast_id, url, position) VALUES (?1, ?2, ?3, 1)',
    )
      .bind(wrong, broadcastId, 'https://example.com/no')
      .run();
    const sent = await one<{ id: string; sent_at: number }>(
      'SELECT id, sent_at FROM deliveries WHERE member_id = ?1',
      clicked.memberId,
    );
    const click = (linkTargetId: string, at: number) =>
      recordClick(
        env.DB,
        { deliveryId: sent!.id, linkTargetId, broadcastId, sentAt: sent!.sent_at },
        human,
        at,
      );
    await click(wrong, w2.h.clock.now + 5000);
    await settle(w2);
    expect((await runsOf(clicked.flow.flowId))[0]!.status).toBe('waiting');
    await click(right, w2.h.clock.now + 10_000);
    await settle(w2);
    expect((await stepsOf(clicked.run.id)).find((s) => s.node_id === 'wait')?.outcome).toBe(
      'default',
    );
  });

  it('notify_author emails the admins, or only the listed operators', async () => {
    const w = await world();
    const admin = address('admin');
    const other = address('other');
    await makeAdmin(w.seed.workspaceId, admin);
    const listed = await makeAdmin(w.seed.workspaceId, other);
    const { email, run: r } = await run(
      w,
      graph(
        [
          go,
          { id: 'all', type: 'notify_author', config: { message: 'Everyone should see this.' } },
          {
            id: 'one',
            type: 'notify_author',
            config: { message: 'Only one should see this.', operatorIds: [listed] },
          },
        ],
        [
          { from: 'trigger', to: 'all' },
          { from: 'all', to: 'one' },
        ],
      ),
    );
    expect(r.status).toBe('completed');
    const notices = w.h.mail.sent.map((m) => ({ to: m.to, text: m.text ?? '' }));
    const toAdmin = notices.filter((n) => n.to === admin).map((n) => n.text);
    const toOther = notices.filter((n) => n.to === other).map((n) => n.text);
    expect(toAdmin.some((t) => t.includes('Everyone should see this.'))).toBe(true);
    expect(toAdmin.some((t) => t.includes('Only one should see this.'))).toBe(false);
    expect(toOther.some((t) => t.includes('Only one should see this.'))).toBe(true);
    // The notice names the Member; it is not sent to them.
    expect(notices.some((n) => n.to === email)).toBe(false);
  });

  it('exit ends the run with exit_node', async () => {
    const w = await world();
    const { run: r, steps } = await run(
      w,
      graph([go, { id: 'stop', type: 'exit', config: {} }], [{ from: 'trigger', to: 'stop' }]),
    );
    expect([r.status, r.exit_reason]).toEqual(['exited', 'exit_node']);
    expect(steps.at(-1)?.status).toBe('done');
  });
});

describe('Flows: a Flow that re-fires its own trigger', () => {
  it('regression: stops at the hourly cap instead of running its notices forever', async () => {
    const w = await world();
    const name = `loop-${crypto.randomUUID().slice(0, 8)}`;
    const tag = await makeTag(w.seed.channelId, name);
    await makeAdmin(w.seed.workspaceId, address('admin'));
    const flow = await publishFlow(
      w.seed,
      graph(
        [
          { id: 'trigger', type: 'trigger', config: { event: 'tag_added', tagId: tag } },
          { id: 'tell', type: 'notify_author', config: { message: 'Round again.' } },
          { id: 'off', type: 'remove_tag', config: { tagId: tag } },
          { id: 'on', type: 'add_tag', config: { tagId: tag } },
        ],
        [
          { from: 'trigger', to: 'tell' },
          { from: 'tell', to: 'off' },
          { from: 'off', to: 'on' },
        ],
      ),
      { reentry: 'after_exit' },
    );
    const memberId = await addMember(w.seed.channelId, address());
    await env.DB.batch(tagStatements(env.DB, memberId, [tag], w.h.clock.now));
    for (let i = 0; i < 60; i++) {
      await settle(w);
      w.h.clock.now += 1000;
    }
    expect((await runsOf(flow.flowId, memberId)).length).toBe(10);
    expect(w.h.mail.sent.length).toBe(10);
  });
});
