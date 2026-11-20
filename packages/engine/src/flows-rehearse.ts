/**
 * Rehearse: what a Flow would do for one Member, with nothing sent and nothing changed.
 *
 * This is not a second engine. Each step is answered by `decideStep` (flows-decide.ts), the same
 * call a real run makes, including the Member recheck, the repeat-send check and the inbox rules.
 * Entry is answered by `chooseStartEvent`, `whyRunRefused` and startFlowRun's own guards. All of it
 * reads through a read-only view of the database:
 * - the view refuses anything but a read, so a rehearsal can't write even by mistake, and this
 *   module is given a database and nothing else: no queues, no mail, no fetch;
 * - what earlier steps of the rehearsal would have changed (tags, profile fields, paid access, emails
 *   sent, a hold waiting, an assumed open) is laid over the real tables as common table expressions,
 *   so the real SQL, down to compiled Circle rules, sees the Member as the run would by then.
 * Only the waiting is different: where a run parks, a rehearsal moves its clock on and asks again.
 * workers/jobs/tests/flows-rehearse.test.ts runs random graphs through this and through the real
 * engine and compares every step.
 *
 * What it can't know is stated, not guessed: whether someone opens or clicks is the writer's answer,
 * and an A/B split can be picked. It also assumes webhooks answer, that a paused publication or
 * warm-up comes back, and that nothing else changes for the Member along the way (another automation
 * they get through an event or a step, a post, a Circle refresh, an unsubscribe).
 */
import {
  CIRCLE_MAX_LEAVES,
  nextNodeId,
  triggerOf,
  triggersOf,
  type CircleRule,
  type FlowEnrolDecision,
  type FlowGraph,
  type FlowNode,
  type FlowRehearsal,
  type FlowRehearsalAnswer,
  type FlowRehearsalCondition,
  type FlowRehearsalDetail,
  type FlowRehearsalHold,
  type FlowRehearsalStep,
  type FlowReentry,
} from '@swarm/domain';
import { personalize } from '@swarm/mail';
import { liveCompGrants } from './comp-grants';
import { all, first, toIso } from './db';
import { currentEntitlement } from './entitlements';
import {
  compNoteMarker,
  contextAfterSend,
  decideStep,
  eventHappened,
  isPermanentStepError,
  levelUnavailable,
  memberMatchesRule,
  outcomeOfHold,
  outcomeWhenTimeIsUp,
  wouldStartFlowRun,
  type FlowEmailRow,
  type FlowRow,
  type Outcome,
  type StepAction,
} from './flows-decide';
import { chooseStartEvent, payloadFor, sameMomentGuard, whyRunRefused } from './flows-enrol';
import { foreignReferences } from './flows-engine';
import { toStored, type StoredValue } from './fields';
import { previewReserve, rampRetrySeconds, type RampRow } from './ramp';

/** Conditions of one branch looked at one by one for its reason; beyond this it stays general. */
const MAX_EXPLAINED_CONDITIONS = 12;
/** A real step decides again each time its hold ends; this only guards a rule set that never settles. */
const MAX_DECISIONS_PER_STEP = 64;

// ---- The read-only view ----------------------------------------------------------------------

type Value = string | number | null;

/**
 * The overlay's values, bound as one JSON array in the parameter after the query's own, so none is
 * ever written into the SQL text. One parameter keeps a large overlay under D1's limit of 100.
 */
function binder(sql: string) {
  const values: Value[] = [];
  // Numbered only once something is added, so a query the overlay leaves alone is never checked.
  let param: string | undefined;
  const value = (v: Value) => {
    param ??= `?${nextParam(sql)}`;
    values.push(v);
    return `json_extract(${param}, '$[${values.length - 1}]')`;
  };
  return { values, value, row: (...vs: Value[]) => `(${vs.map(value).join(', ')})` };
}

const UNNUMBERED = 'A rehearsal reads only SQL with numbered parameters (?N).';

/**
 * The first parameter number after the ones `sql` uses. Engine SQL numbers its parameters (?N); a
 * bare ? or a named one would be numbered after the overlay's, so those are refused.
 */
export function nextParam(sql: string): number {
  // Literals, quoted names (SQLite also quotes with [] and ``) and comments can hold a ? that is no
  // parameter, or a quote or -- that would hide one.
  const code = sql.replace(
    /'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g,
    ' ',
  );
  let highest = 0;
  for (const [, n] of code.matchAll(/\?(\d*)/g)) {
    if (!n) throw new Error(UNNUMBERED);
    highest = Math.max(highest, Number(n));
  }
  if (/[:@$][A-Za-z_]/.test(code)) throw new Error(UNNUMBERED);
  return highest + 1;
}

/** Added rows. VALUES because SQLite limits how many SELECTs one statement can join with UNION. */
const plus = (rows: string[]) => (rows.length ? `UNION ALL VALUES ${rows.join(', ')}` : '');

interface OverlaySubscription {
  id: string;
  levelId: string;
  periodEnd: number | null;
  now: number;
}

/** What a rehearsal's earlier steps would have changed for one Member. */
class Overlay {
  readonly tagsAdded = new Set<string>();
  readonly tagsRemoved = new Set<string>();
  readonly fields = new Map<string, StoredValue | null>();
  readonly subscriptions: OverlaySubscription[] = [];
  readonly subscriptionsEnded = new Set<string>();
  /** Set once paid access has changed: the row it comes to, or null for none. */
  entitlement:
    | { source: string; startsAt: number; expiresAt: number | null; levelId: string | null }
    | null
    | undefined;
  /** Emails this rehearsal has sent: the ledger, the recipient row and the delivery. */
  readonly sent: { broadcastId: string; sendRegardless: boolean; at: number }[] = [];
  /** An email the writer said was opened or clicked. */
  readonly engaged = new Map<string, { at: number; clicked: boolean }>();
  /** The step waiting on a hold now, like the flow_holds row a real run would have. */
  hold: { runId: string; nodeId: string; reason: string; until: number; heldAt: number } | null =
    null;
  /** A draft's email steps, as flow_emails rows, so the repeat-send check sees them like a version's. */
  readonly draftEmails: { nodeId: string; dispatchId: string; broadcastId: string }[] = [];
  /** Runs a step of this rehearsal would have started in other Flows. */
  readonly runsStarted: { flowId: string; version: number; at: number }[] = [];
  /** Once the rehearsal's clock has moved, other runs' holds that were due have gone their way. */
  clockMoved = false;

  constructor(
    readonly memberId: string,
    readonly channelId: string,
    readonly flowId: string,
    readonly version: number,
  ) {}

  /** The common table expressions, each hiding the real table of the same name. */
  private tables(now: number, sql: string): { tables: string[]; values: Value[] } {
    const { value, row, values } = binder(sql);
    const m = () => value(this.memberId);
    const list = (ids: Iterable<string>) => [...ids].map(value).join(', ');
    const out: string[] = [];
    if (this.tagsAdded.size || this.tagsRemoved.size) {
      const touched = list([...this.tagsAdded, ...this.tagsRemoved]);
      out.push(
        [
          `member_tags (member_id, tag_id, created_at) AS (`,
          `SELECT member_id, tag_id, created_at FROM main.member_tags`,
          `WHERE NOT (member_id = ${m()} AND tag_id IN (${touched}))`,
          plus([...this.tagsAdded].map((t) => row(this.memberId, t, now))),
          `)`,
        ].join(' '),
      );
    }
    if (this.fields.size) {
      const added = [...this.fields.entries()].flatMap(([fieldId, stored]) =>
        stored
          ? [
              row(
                this.memberId,
                fieldId,
                stored.value_text,
                stored.value_num,
                stored.value_enc,
                now,
              ),
            ]
          : [],
      );
      out.push(
        [
          `member_field_values (member_id, field_id, value_text, value_num, value_enc, updated_at) AS (`,
          `SELECT member_id, field_id, value_text, value_num, value_enc, updated_at FROM main.member_field_values`,
          `WHERE NOT (member_id = ${m()} AND field_id IN (${list(this.fields.keys())}))`,
          plus(added),
          `)`,
        ].join(' '),
      );
    }
    if (this.subscriptions.length || this.subscriptionsEnded.size) {
      const columns =
        'id, channel_id, member_id, level_id, source, status, current_period_end, grace_until, created_at, revoked_at';
      out.push(
        [
          `member_subscriptions (${columns}) AS (`,
          `SELECT ${columns} FROM main.member_subscriptions`,
          `WHERE id NOT IN (${list(this.subscriptionsEnded)})`,
          plus(
            this.subscriptions.map((s) =>
              row(
                s.id,
                this.channelId,
                this.memberId,
                s.levelId,
                'comp',
                'active',
                s.periodEnd,
                null,
                s.now,
                null,
              ),
            ),
          ),
          `)`,
        ].join(' '),
      );
    }
    if (this.entitlement !== undefined) {
      const columns = 'member_id, channel_id, kind, source, starts_at, expires_at, level_id';
      const e = this.entitlement;
      out.push(
        [
          `member_entitlements (${columns}) AS (`,
          `SELECT ${columns} FROM main.member_entitlements WHERE member_id <> ${m()}`,
          plus(
            e
              ? [
                  row(
                    this.memberId,
                    this.channelId,
                    'paid',
                    e.source,
                    e.startsAt,
                    e.expiresAt,
                    e.levelId,
                  ),
                ]
              : [],
          ),
          `)`,
        ].join(' '),
      );
    }
    if (this.sent.length) {
      out.push(
        [
          `flow_email_ledger (member_id, broadcast_id, channel_id, send_regardless, sent_at) AS (`,
          `SELECT member_id, broadcast_id, channel_id, send_regardless, sent_at FROM main.flow_email_ledger`,
          plus(
            this.sent.map((e) =>
              row(this.memberId, e.broadcastId, this.channelId, e.sendRegardless ? 1 : 0, e.at),
            ),
          ),
          `)`,
        ].join(' '),
        [
          `broadcast_recipients (broadcast_id, member_id, status, held) AS (`,
          `SELECT broadcast_id, member_id, status, held FROM main.broadcast_recipients`,
          plus(this.sent.map((e) => row(e.broadcastId, this.memberId, 'sent', 0))),
          `)`,
        ].join(' '),
      );
    }
    if (this.sent.length || this.engaged.size) {
      const columns =
        'id, broadcast_id, channel_id, member_id, status, sent_at, opened_at, human_opened_at, clicked_at, human_clicked_at';
      const ids = new Map(this.sent.map((e) => [e.broadcastId, e.at] as const));
      const real = [...this.engaged.keys()].filter((id) => !ids.has(id));
      const stamp = (id: string, at: number) => {
        const seen = this.engaged.get(id);
        const opened = seen?.at ?? null;
        const clicked = seen?.clicked ? seen.at : null;
        return row(
          `rehearsal:${id}`,
          id,
          this.channelId,
          this.memberId,
          'sent',
          at,
          opened,
          opened,
          clicked,
          clicked,
        );
      };
      out.push(
        [
          `deliveries (${columns}) AS (`,
          `SELECT ${columns} FROM main.deliveries`,
          // A real delivery the writer says was opened: it stands in for the real row.
          real.length ? `WHERE NOT (member_id = ${m()} AND broadcast_id IN (${list(real)}))` : ``,
          plus([
            ...[...ids.entries()].map(([id, at]) => stamp(id, at)),
            ...real.map((id) => stamp(id, this.engaged.get(id)?.at ?? now)),
          ]),
          `)`,
        ].join(' '),
      );
    }
    if (this.hold || this.clockMoved) {
      const columns =
        'run_id, node_id, flow_id, version, channel_id, member_id, reason, until, zone, held_at, released_at, outcome';
      const h = this.hold;
      out.push(
        [
          `flow_holds (${columns}) AS (`,
          `SELECT ${columns} FROM main.flow_holds`,
          ...(this.clockMoved ? [`WHERE until > ${value(now)}`] : []),
          plus(
            h
              ? [
                  row(
                    h.runId,
                    h.nodeId,
                    this.flowId,
                    this.version,
                    this.channelId,
                    this.memberId,
                    h.reason,
                    h.until,
                    'UTC',
                    h.heldAt,
                    null,
                    null,
                  ),
                ]
              : [],
          ),
          `)`,
        ].join(' '),
      );
    }
    if (this.draftEmails.length) {
      const columns = 'flow_id, version, node_id, dispatch_id, broadcast_id, created_at, resend';
      out.push(
        [
          `flow_emails (${columns}) AS (`,
          `SELECT ${columns} FROM main.flow_emails`,
          plus(
            this.draftEmails.map((e) =>
              row(this.flowId, this.version, e.nodeId, e.dispatchId, e.broadcastId, 0, 0),
            ),
          ),
          `)`,
        ].join(' '),
      );
    }
    if (this.runsStarted.length) {
      const columns =
        'id, flow_id, version, channel_id, member_id, status, current_node_id, next_at, trigger_event_seq, test, started_at';
      out.push(
        [
          `flow_runs (${columns}) AS (`,
          `SELECT ${columns} FROM main.flow_runs`,
          plus(
            this.runsStarted.map((r) =>
              row(
                `rehearsal:${r.flowId}`,
                r.flowId,
                r.version,
                this.channelId,
                this.memberId,
                'running',
                null,
                null,
                null,
                0,
                r.at,
              ),
            ),
          ),
          `)`,
        ].join(' '),
      );
    }
    return { tables: out, values };
  }

  /** `sql` as it reads with this overlay applied, and the overlay's values to bind after its own. */
  apply(sql: string, now: number): Applied {
    const { tables, values } = this.tables(now, sql);
    if (!tables.length) return { sql, values: null };
    const head = sql.trimStart();
    return {
      sql: /^with\s/i.test(head)
        ? `WITH ${tables.join(', ')}, ${head.replace(/^with\s+/i, '')}`
        : `WITH ${tables.join(', ')} ${head}`,
      values: values.length ? JSON.stringify(values) : null,
    };
  }
}

/** Thrown if anything in a rehearsal tries to change the database. It never should. */
export class RehearsalWriteError extends Error {
  constructor(what: string) {
    super(`A rehearsal may only read: ${what.slice(0, 80)}`);
    this.name = 'RehearsalWriteError';
  }
}

const READ = /^\s*(select|with)\b/i;
const WRITE = /\b(insert|update|delete|replace|create|drop|alter|pragma|attach)\s/i;

interface Applied {
  sql: string;
  /** The JSON array bound after the query's own parameters, or null when nothing is added. */
  values: string | null;
}

/** A statement that binds `values` after whatever its caller binds. */
function bindingAfter(statement: D1PreparedStatement, values: string): D1PreparedStatement {
  const bound = (...own: unknown[]) => statement.bind(...own, values);
  return {
    bind: bound,
    first: (column?: string) => (column === undefined ? bound().first() : bound().first(column)),
    all: () => bound().all(),
    raw: (options?: { columnNames?: false }) => bound().raw(options),
    run: () => bound().run(),
  } as unknown as D1PreparedStatement;
}

/** A database that only reads, and reads through the overlay. */
export function readOnlyView(
  db: D1Database,
  overlay?: { apply: (sql: string, now: number) => Applied },
  clock: { now: number } = { now: 0 },
): D1Database {
  const refuse = (what: string) => () => {
    throw new RehearsalWriteError(what);
  };
  return {
    prepare(sql: string) {
      // Comments aside, engine SQL starts with its verb. WRITE catches a data-changing CTE.
      if (!READ.test(sql) || WRITE.test(sql.replace(/'[^']*'/g, "''"))) {
        throw new RehearsalWriteError(sql);
      }
      if (!overlay) return db.prepare(sql);
      const applied = overlay.apply(sql, clock.now);
      const statement = db.prepare(applied.sql);
      return applied.values === null ? statement : bindingAfter(statement, applied.values);
    },
    batch: refuse('batch'),
    exec: refuse('exec'),
    dump: refuse('dump'),
    withSession: refuse('withSession'),
  } as unknown as D1Database;
}

// ---- Why a branch went its way ---------------------------------------------------------------

interface Explained {
  holds: boolean;
  because: FlowRehearsalCondition[];
}

const leafCount = (rule: CircleRule): number =>
  'op' in rule ? rule.children.reduce((sum, child) => sum + leafCount(child), 0) : 1;

async function explain(
  rule: CircleRule,
  holds: (leaf: CircleRule) => Promise<boolean>,
): Promise<Explained> {
  if (!('op' in rule)) {
    const value = await holds(rule);
    return {
      holds: value,
      because: [
        {
          field: rule.field,
          cmp: rule.cmp,
          ...(rule.value === undefined ? {} : { value: rule.value }),
          holds: value,
        },
      ],
    };
  }
  const children: Explained[] = [];
  for (const child of rule.children) children.push(await explain(child, holds));
  if (rule.op === 'not') {
    const only = children[0] ?? { holds: false, because: [] };
    return { holds: !only.holds, because: only.because };
  }
  const passing = children.filter((c) => c.holds);
  const failing = children.filter((c) => !c.holds);
  if (rule.op === 'and') {
    return failing.length
      ? { holds: false, because: failing.flatMap((c) => c.because) }
      : { holds: true, because: passing.flatMap((c) => c.because) };
  }
  return passing.length
    ? { holds: true, because: passing[0]!.because }
    : { holds: false, because: failing.flatMap((c) => c.because) };
}

// ---- Entering ---------------------------------------------------------------------------------

interface RehearseFlow extends Pick<
  FlowRow,
  'id' | 'workspace_id' | 'channel_id' | 'webhook_secret_enc'
> {
  reentry: FlowReentry;
}

/**
 * What enrollFromEvents would do with this event for this Member, as an answer: the same choice of
 * start event, the same refusals of startFlowRun, and the same reason Why would show.
 */
async function rehearseEntry(
  view: D1Database,
  flow: RehearseFlow,
  graph: FlowGraph,
  memberId: string,
  version: number,
  pinned: number | null,
  now: number,
  startEvent: number,
): Promise<FlowRehearsal['entry']> {
  const configs = triggersOf(graph);
  const config = configs[startEvent] ?? configs[0];
  if (!config) return { allowed: false, startEvent: null, reason: null };
  const triggers = configs
    .map((c, index) => ({ index, config: c }))
    .filter((t) => t.config.event === config.event);
  const scope = { member_id: memberId, channel_id: flow.channel_id };
  const choice = await chooseStartEvent(triggers, config.event, payloadFor(config), (filter) =>
    memberMatchesRule(view, scope, filter, now),
  );
  if (!choice) return { allowed: false, startEvent: null, reason: null };
  if ('reason' in choice) return { allowed: false, startEvent: null, reason: choice.reason };
  const starts = await wouldStartFlowRun(view, {
    flowId: flow.id,
    memberId,
    channelId: flow.channel_id,
    version: pinned,
    ...sameMomentGuard({ triggerCount: configs.length, reentry: flow.reentry }, now),
    now,
  });
  if (starts) return { allowed: true, startEvent: choice.index, reason: null };
  const reason: FlowEnrolDecision | null = await whyRunRefused(
    view,
    { id: flow.id, version, reentry: flow.reentry },
    { member_id: memberId, seq: -1, created_at: now },
  );
  return { allowed: false, startEvent: choice.index, reason };
}

// ---- One rehearsal ---------------------------------------------------------------------------

export interface RehearseInput {
  flow: RehearseFlow;
  graph: FlowGraph;
  source: 'draft' | 'live';
  /** The live version when `source` is 'live'; for a draft, the version it would become. */
  version: number;
  memberId: string;
  now: number;
  hasFieldKeys: boolean;
  answers?: Record<string, FlowRehearsalAnswer>;
  /** Which start event to imagine, by its place in the list. */
  startEvent?: number;
  /** The run id splits are drawn from. Only the comparison test sets it, to a real run's id. */
  runId?: string;
}

export async function rehearseFlow(db: D1Database, input: RehearseInput): Promise<FlowRehearsal> {
  const { flow, graph, memberId } = input;
  const channelId = flow.channel_id;
  const clock = { now: input.now };
  const overlay = new Overlay(memberId, channelId, flow.id, input.version);
  const view = readOnlyView(db, overlay, clock);
  const answers = input.answers ?? {};

  const member = await first<{
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    status: string;
  }>(
    view,
    'SELECT id, email, first_name, last_name, status FROM members WHERE id = ?1 AND channel_id = ?2',
    memberId,
    channelId,
  );
  if (!member) throw new Error(`Member ${memberId} is not in Channel ${channelId}.`);

  const entry = await rehearseEntry(
    view,
    flow,
    graph,
    memberId,
    input.version,
    input.source === 'live' ? input.version : null,
    input.now,
    input.startEvent ?? 0,
  );

  const run = {
    id: input.runId ?? `rehearsal:${memberId}`,
    flow_id: flow.id,
    version: input.version,
    channel_id: channelId,
    member_id: memberId,
    context_json: '{}',
    test: 0 as const,
  };
  const scope = { member_id: memberId, channel_id: channelId };

  // A draft has no frozen emails yet. It reads like the version it would become.
  const drafts = new Map<string, string>();
  if (input.source === 'draft') {
    for (const node of graph.nodes) {
      if (node.type !== 'send_email') continue;
      const broadcastId = `draft:${node.id}`;
      drafts.set(node.id, broadcastId);
      overlay.draftEmails.push({
        nodeId: node.id,
        dispatchId: node.config.dispatchId,
        broadcastId,
      });
    }
  }

  const steps: FlowRehearsalStep[] = [];
  const finish = (
    status: 'completed' | 'exited' | 'paused',
    reason: FlowRehearsal['end']['reason'],
    problem: string | null = null,
  ): FlowRehearsal => ({
    member: { id: member.id, email: member.email, status: member.status },
    entry,
    steps,
    end: { status, reason, problem },
  });

  const trigger = triggerOf(graph);
  if (!trigger) return finish('exited', 'invalid_reference');
  // The engine makes this check before each step; nothing here can change the answer between steps.
  if ((await foreignReferences(view, flow, graph)).length) {
    steps.push({
      nodeId: trigger.id,
      type: trigger.type,
      status: 'skipped',
      outcome: null,
      at: toIso(clock.now),
      detail: plainDetail(trigger),
    });
    return finish('exited', 'invalid_reference');
  }

  const ramps = new Map<string, RampRow>();
  /** Set once a run would have waited for the publication: from then on it is taken to be back. */
  let channelBack = false;
  /** Clicks the writer assumed: a real click would answer a later wait on the same email. */
  const assumedClicks: { broadcastId: string; url: string | null }[] = [];

  const moveClock = (to: number) => {
    if (to > clock.now) overlay.clockMoved = true;
    clock.now = Math.max(clock.now, to);
  };

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  let node: FlowNode | undefined = trigger;
  for (let guard = 0; node && guard <= graph.nodes.length; guard++) {
    const current: FlowNode = node;
    let result: { outcome: Exclude<Outcome, { kind: 'park' }>; detail: FlowRehearsalDetail };
    try {
      result = await rehearseStep(current);
    } catch (error) {
      if (!isPermanentStepError(error)) throw error;
      steps.push({
        nodeId: current.id,
        type: current.type,
        status: 'failed',
        outcome: null,
        at: toIso(clock.now),
        detail: plainDetail(current),
      });
      return finish(
        'paused',
        'step_failed',
        error instanceof Error ? error.message : String(error),
      );
    }
    overlay.hold = null;
    const { outcome, detail } = result;
    if (outcome.kind === 'exit') {
      steps.push({
        nodeId: current.id,
        type: current.type,
        status: outcome.status ?? 'skipped',
        outcome: null,
        at: toIso(clock.now),
        detail,
      });
      return finish('exited', outcome.reason);
    }
    steps.push({
      nodeId: current.id,
      type: current.type,
      status: outcome.status ?? 'done',
      outcome: outcome.label,
      at: toIso(clock.now),
      detail,
    });
    const nextId = nextNodeId(graph, current.id, outcome.label);
    if (!nextId) return finish('completed', null);
    node = byId.get(nextId);
  }
  return finish('exited', 'invalid_reference');

  /**
   * One step from decision to finish. A real step that parks runs again from the top when its time
   * comes, Member recheck first, so here it does too, with the clock moved on.
   */
  async function rehearseStep(
    current: FlowNode,
  ): Promise<{ outcome: Exclude<Outcome, { kind: 'park' }>; detail: FlowRehearsalDetail }> {
    const holds: FlowRehearsalHold[] = [];
    for (let pass = 0; pass < MAX_DECISIONS_PER_STEP; pass++) {
      const decision = await decideStep({
        db: view,
        run,
        flow,
        graph,
        node: current,
        now: clock.now,
        hasFieldKeys: input.hasFieldKeys,
        channelBack,
        ...(current.type === 'ab_split' &&
        (answers[current.id] === 'a' || answers[current.id] === 'b')
          ? { arm: answers[current.id] as 'a' | 'b' }
          : {}),
        ...(input.source === 'draft'
          ? { findEmail: (send) => draftEmail(send.id, send.config.dispatchId) }
          : {}),
      });
      if (decision.kind === 'hold') {
        const { decision: rule, zone } = decision.hold;
        holds.push({
          reason: rule.reason,
          until: toIso(rule.until),
          expired: rule.action === 'expire',
          zone,
        });
        const ended = outcomeOfHold(decision.hold);
        if (ended.kind !== 'park') {
          if (ended.kind === 'exit') {
            return { outcome: ended, detail: await emailDetailOf(current, 'not_sent', holds) };
          }
          return { outcome: ended, detail: plainDetail(current) };
        }
        overlay.hold = {
          runId: run.id,
          nodeId: current.id,
          reason: rule.reason,
          until: rule.until,
          heldAt: overlay.hold?.heldAt ?? clock.now,
        };
        moveClock(ended.until);
        continue;
      }
      if (decision.kind === 'act') {
        if (decision.action.type === 'send' && decision.action.email.ramp_id) {
          const grant = await reserveInRehearsal(decision.action.email.ramp_id);
          if (grant) {
            holds.push(grant.hold);
            moveClock(clock.now + grant.waitMs);
            continue;
          }
        }
        return preview(decision.action, current, holds);
      }
      const decided = decision.outcome;
      if (decided.kind === 'park' && decided.result.deferred === 'channel_paused') {
        // A real run looks again every hour until the publication is back. It can't be known when;
        // this is the soonest it could go on.
        holds.push({ reason: 'channel_paused', until: null, expired: false, zone: null });
        channelBack = true;
        moveClock(decided.until);
        continue;
      }
      return settle(decided, current, holds);
    }
    throw new Error(`The step ${current.id} never settled.`);
  }

  /** Null when the warm-up lets the email through, which it then counts. */
  async function reserveInRehearsal(
    rampId: string,
  ): Promise<{ hold: FlowRehearsalHold; waitMs: number } | null> {
    let ramp = ramps.get(rampId);
    if (!ramp) {
      const found = await first<RampRow>(
        view,
        'SELECT * FROM reputation_ramps WHERE id = ?1',
        rampId,
      );
      if (!found) throw new Error(`ramp ${rampId} not found`);
      ramp = found;
    }
    const preview = await previewReserve(view, ramp, 1, clock.now);
    if (preview.granted > 0) {
      ramps.set(rampId, preview.ramp);
      return null;
    }
    const waitMs = rampRetrySeconds(preview.ramp, clock.now) * 1000;
    if (preview.ramp.status === 'paused') {
      // Someone has to resume it, so a rehearsal takes it to be back at the next look.
      ramps.set(rampId, { ...preview.ramp, status: 'warming' });
      return {
        hold: { reason: 'ramp_paused', until: null, expired: false, zone: null },
        waitMs,
      };
    }
    ramps.set(rampId, preview.ramp);
    return {
      hold: {
        reason: 'ramp_full',
        until: toIso(clock.now + waitMs),
        expired: false,
        zone: null,
      },
      waitMs,
    };
  }

  /** A draft's email: what it says today. It has no Broadcast until it is published. */
  async function draftEmail(nodeId: string, dispatchId: string): Promise<FlowEmailRow | null> {
    const dispatch = await first<{ id: string; subject: string; preheader: string }>(
      view,
      `SELECT id, subject, preheader FROM dispatches
        WHERE id = ?1 AND channel_id = ?2 AND flow_id = ?3 AND kind = 'flow'`,
      dispatchId,
      channelId,
      flow.id,
    );
    if (!dispatch) return null;
    return {
      id: drafts.get(nodeId) ?? `draft:${nodeId}`,
      dispatch_id: dispatch.id,
      status: 'sending',
      channel_id: channelId,
      ramp_id: null,
      has_teaser: 0,
      gate_level_ids_json: null,
      subject: dispatch.subject,
      preheader: dispatch.preheader,
    };
  }

  /** A decision with no action: follow it, jumping over waits. */
  async function settle(
    decided: Outcome,
    current: FlowNode,
    holds: FlowRehearsalHold[],
  ): Promise<{ outcome: Exclude<Outcome, { kind: 'park' }>; detail: FlowRehearsalDetail }> {
    if (decided.kind !== 'park') {
      return { outcome: decided, detail: await detailOf(decided, current, holds) };
    }
    const label = outcomeWhenTimeIsUp(current);
    if (current.type === 'delay' && label) {
      moveClock(decided.until);
      return {
        outcome: { kind: 'next', label },
        detail: { kind: 'delay', until: toIso(decided.until) },
      };
    }
    if (current.type !== 'wait_for_event' || !decided.wait || !label) {
      throw new Error(`a ${current.type} step does not park here`);
    }
    const wait = decided.wait;
    const base = {
      kind: 'wait' as const,
      event: wait.event,
      url: wait.url ?? null,
      until: toIso(wait.until),
    };
    // finish() in the real engine: an event that already happened resolves the wait at once.
    const assumed = assumedClicks.some(
      (c) =>
        c.broadcastId === wait.broadcastId &&
        (wait.event === 'open' || !wait.url || c.url === wait.url),
    );
    if (wait.broadcastId && (assumed || (await eventHappened(view, memberId, wait)))) {
      return {
        outcome: { kind: 'next', label: 'default' },
        detail: { ...base, basis: 'already', answer: 'yes' },
      };
    }
    const timedOut = (): Exclude<Outcome, { kind: 'park' }> => {
      moveClock(wait.until);
      return { kind: 'next', label };
    };
    // Nobody can open what never reached them, whatever the writer's answer.
    const delivered =
      !!wait.broadcastId &&
      (await first(
        view,
        'SELECT 1 AS ok FROM deliveries WHERE broadcast_id = ?1 AND member_id = ?2 LIMIT 1',
        wait.broadcastId,
        memberId,
      )) !== null;
    if (!delivered) {
      return { outcome: timedOut(), detail: { ...base, basis: 'no_email', answer: 'no' } };
    }
    if (answers[current.id] === 'yes') {
      overlay.engaged.set(wait.broadcastId, { at: clock.now, clicked: wait.event === 'click' });
      if (wait.event === 'click') {
        assumedClicks.push({ broadcastId: wait.broadcastId, url: wait.url ?? null });
      }
      return {
        outcome: { kind: 'next', label: 'default' },
        detail: { ...base, basis: 'assumed', answer: 'yes' },
      };
    }
    return { outcome: timedOut(), detail: { ...base, basis: 'assumed', answer: 'no' } };
  }

  /** The words for a decision that needed no action, for each kind of node. */
  async function detailOf(
    decided: Exclude<Outcome, { kind: 'park' }>,
    current: FlowNode,
    holds: FlowRehearsalHold[],
  ): Promise<FlowRehearsalDetail> {
    switch (current.type) {
      case 'send_email': {
        if (decided.kind === 'exit') return emailDetailOf(current, 'not_sent', holds);
        const skipped = (decided.result as { skipped?: string } | undefined)?.skipped;
        return emailDetailOf(
          current,
          skipped === 'already_received' ? 'already_received' : 'already_sent',
          holds,
        );
      }
      case 'delay':
        return { kind: 'delay', until: null };
      case 'branch': {
        if (decided.kind === 'exit') return { kind: 'branch', matched: false, because: [] };
        const matched = decided.label === 'true';
        const rule = current.config.condition as CircleRule;
        if (leafCount(rule) > Math.min(MAX_EXPLAINED_CONDITIONS, CIRCLE_MAX_LEAVES)) {
          return { kind: 'branch', matched, because: [] };
        }
        const explained = await explain(
          rule,
          async (leaf) => (await memberMatchesRule(view, scope, leaf, clock.now)) === true,
        );
        return {
          kind: 'branch',
          matched,
          because: explained.holds === matched ? explained.because : [],
        };
      }
      case 'ab_split':
        return {
          kind: 'split',
          arm: decided.kind === 'next' && decided.label === 'b' ? 'b' : 'a',
          percentA: current.config.percentA,
          picked: answers[current.id] === 'a' || answers[current.id] === 'b',
        };
      case 'change_level':
        return {
          kind: 'level',
          action: current.config.action,
          levelId: current.config.levelId,
          unavailable: decided === levelUnavailable,
        };
      case 'enrol_flow': {
        const result = (decided.result ?? {}) as { reason?: string };
        return { kind: 'enrol', flowId: current.config.flowId, result: result.reason ?? 'done' };
      }
      default:
        return plainDetail(current);
    }
  }

  /** The email a send step stands for, when the run won't send it now. */
  async function emailDetailOf(
    current: FlowNode,
    state: 'already_sent' | 'already_received' | 'not_sent',
    holds: FlowRehearsalHold[],
  ): Promise<FlowRehearsalDetail> {
    if (current.type !== 'send_email') return plainDetail(current);
    const email =
      input.source === 'draft'
        ? await draftEmail(current.id, current.config.dispatchId)
        : await first<FlowEmailRow>(
            view,
            `SELECT b.id, fe.dispatch_id, b.status, b.channel_id, b.ramp_id, 0 AS has_teaser,
                    NULL AS gate_level_ids_json, b.subject, b.preheader
               FROM flow_emails fe JOIN broadcasts b ON b.id = fe.broadcast_id
              WHERE fe.flow_id = ?1 AND fe.version = ?2 AND fe.node_id = ?3`,
            flow.id,
            run.version,
            current.id,
          );
    return emailDetail(email, state, holds);
  }

  function emailDetail(
    email: FlowEmailRow | null,
    state: 'would_send' | 'already_sent' | 'already_received' | 'not_sent',
    holds: FlowRehearsalHold[],
  ): FlowRehearsalDetail {
    // Fills merge tags with the function the send pipeline uses.
    const filled = personalize(
      { html: '', text: email?.preheader ?? '', subject: email?.subject ?? '' },
      {
        link: () => '',
        unsubscribeUrl: '',
        pixelUrl: null,
        member: {
          email: member!.email,
          firstName: member!.first_name,
          lastName: member!.last_name,
        },
      },
    );
    return { kind: 'email', state, subject: filled.subject, previewText: filled.text, holds };
  }

  /** What an action would come to, and what it would leave behind for the steps after it. */
  async function preview(
    action: StepAction,
    current: FlowNode,
    holds: FlowRehearsalHold[],
  ): Promise<{ outcome: Exclude<Outcome, { kind: 'park' }>; detail: FlowRehearsalDetail }> {
    const next = { kind: 'next', label: 'default' } as const;
    switch (action.type) {
      case 'send':
      case 'requeue_send': {
        run.context_json = JSON.stringify(
          contextAfterSend(action.context, current.id, action.email.id),
        );
        overlay.sent.push({
          broadcastId: action.email.id,
          sendRegardless: action.type === 'send' && action.sendRegardless,
          at: clock.now,
        });
        return { outcome: next, detail: emailDetail(action.email, 'would_send', holds) };
      }
      case 'add_tag':
        overlay.tagsAdded.add(action.tagId);
        overlay.tagsRemoved.delete(action.tagId);
        return { outcome: next, detail: { kind: 'tag', action: 'add', tagId: action.tagId } };
      case 'remove_tag':
        overlay.tagsRemoved.add(action.tagId);
        overlay.tagsAdded.delete(action.tagId);
        return { outcome: next, detail: { kind: 'tag', action: 'remove', tagId: action.tagId } };
      case 'update_field': {
        const stored = action.field.encrypted
          ? { value_text: null, value_num: null, value_enc: 'rehearsal' }
          : await toStored(action.field, action.value);
        overlay.fields.set(action.field.id, stored);
        return { outcome: next, detail: { kind: 'field', fieldId: action.field.id } };
      }
      case 'grant_level': {
        overlay.subscriptions.push({
          id: `rehearsal:${current.id}`,
          levelId: action.levelId,
          periodEnd: action.days === null ? null : clock.now + action.days * 86_400_000,
          now: clock.now,
        });
        await recomputeOverlayEntitlement();
        return {
          outcome: next,
          detail: { kind: 'level', action: 'grant', levelId: action.levelId, unavailable: false },
        };
      }
      case 'revoke_level': {
        const grants = await liveCompGrants(view, {
          channelId,
          memberId,
          levelId: action.levelId,
          noteMarker: compNoteMarker(flow.id),
        });
        for (const grant of grants) {
          if (grant.subscription_id) overlay.subscriptionsEnded.add(grant.subscription_id);
        }
        // A grant from earlier in this same rehearsal carries the Flow's marker too.
        let revoked = grants.length;
        for (let i = overlay.subscriptions.length - 1; i >= 0; i--) {
          if (overlay.subscriptions[i]!.levelId === action.levelId) {
            overlay.subscriptions.splice(i, 1);
            revoked++;
          }
        }
        // revokeCompGrants recomputes only when it revoked something.
        if (revoked) await recomputeOverlayEntitlement();
        return {
          outcome: next,
          detail: { kind: 'level', action: 'revoke', levelId: action.levelId, unavailable: false },
        };
      }
      case 'enrol': {
        const version = action.target.live_version as number;
        const starts = await wouldStartFlowRun(view, {
          flowId: action.target.id,
          memberId,
          channelId,
          version,
          now: clock.now,
        });
        if (starts) overlay.runsStarted.push({ flowId: action.target.id, version, at: clock.now });
        return {
          outcome: starts
            ? { kind: 'next', label: 'default' }
            : { kind: 'next', label: 'default', status: 'skipped' },
          detail: {
            kind: 'enrol',
            flowId: action.target.id,
            result: starts ? 'would_start' : 'not_eligible',
          },
        };
      }
      case 'webhook':
        if (current.type !== 'webhook_call') throw new Error('not a webhook step');
        return { outcome: next, detail: { kind: 'webhook', url: current.config.url } };
      case 'notify':
        if (current.type !== 'notify_author') throw new Error('not a notify step');
        return { outcome: next, detail: { kind: 'notify', message: current.config.message } };
    }
  }

  async function recomputeOverlayEntitlement() {
    const entitlement = await currentEntitlement(view, channelId, memberId, clock.now);
    overlay.entitlement = entitlement
      ? {
          source: entitlement.source,
          startsAt: entitlement.startsAt,
          expiresAt: entitlement.expiresAt,
          levelId: entitlement.levelId,
        }
      : null;
  }
}

/** A step's details when all there is to say is what it is. */
function plainDetail(node: FlowNode): FlowRehearsalDetail {
  switch (node.type) {
    case 'trigger':
      return { kind: 'start' };
    case 'exit':
      return { kind: 'exit' };
    case 'send_email':
      return {
        kind: 'email',
        state: 'not_sent',
        subject: '',
        previewText: '',
        holds: [],
      };
    case 'delay':
      return { kind: 'delay', until: null };
    case 'add_tag':
      return { kind: 'tag', action: 'add', tagId: node.config.tagId };
    case 'remove_tag':
      return { kind: 'tag', action: 'remove', tagId: node.config.tagId };
    case 'update_field':
      return { kind: 'field', fieldId: node.config.fieldId };
    case 'change_level':
      return {
        kind: 'level',
        action: node.config.action,
        levelId: node.config.levelId,
        unavailable: false,
      };
    case 'enrol_flow':
      return { kind: 'enrol', flowId: node.config.flowId, result: 'done' };
    case 'branch':
      return { kind: 'branch', matched: false, because: [] };
    case 'ab_split':
      return { kind: 'split', arm: 'a', percentA: node.config.percentA, picked: false };
    case 'wait_for_event':
      return {
        kind: 'wait',
        event: node.config.event,
        url: node.config.url ?? null,
        until: new Date(0).toISOString(),
        basis: 'no_email',
        answer: 'no',
      };
    case 'webhook_call':
      return { kind: 'webhook', url: node.config.url };
    case 'notify_author':
      return { kind: 'notify', message: node.config.message };
  }
}

/** Picks up to `size` Members of a Circle at random. Reads only. */
export async function sampleCircle(
  db: D1Database,
  channelId: string,
  circleId: string,
  size: number,
): Promise<{ memberIds: string[]; circleSize: number }> {
  const rows = await all<{ member_id: string }>(
    db,
    `SELECT cm.member_id FROM circle_members cm JOIN members m ON m.id = cm.member_id
      WHERE cm.circle_id = ?1 AND m.channel_id = ?2 ORDER BY random() LIMIT ?3`,
    circleId,
    channelId,
    size,
  );
  const count = await first<{ n: number }>(
    db,
    'SELECT count(*) AS n FROM circle_members WHERE circle_id = ?1',
    circleId,
  );
  return { memberIds: rows.map((r) => r.member_id), circleSize: count?.n ?? 0 };
}
