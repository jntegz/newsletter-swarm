import { describe, expect, it } from 'vitest';
import {
  FLOW_MAX_TRIGGERS,
  FLOW_RECIPES,
  FLOW_RECIPE_DEFS,
  FlowGraphDraftSchema,
  FlowGraphSchema,
  FlowNodeSchema,
  collectReferencedIds,
  extraTriggerTypes,
  funnelLookbackDays,
  funnelRate,
  funnelRates,
  newId,
  nextNodeId,
  pickSplitTestWinner,
  triggersOf,
  validateFlowGraph,
  type FlowGraph,
} from '../src/index';

const circle = newId('circle');
const tag = newId('tag');
const dispatchA = newId('dispatch');
const dispatchB = newId('dispatch');
const level = newId('membershipLevel');
const form = newId('captureForm');

/** confirmed → email → delay 2 days → branch(level) → true: email B, false: add tag. */
function welcome(): FlowGraph {
  return FlowGraphSchema.parse({
    schema: 1,
    nodes: [
      { id: 'trigger', type: 'trigger', config: { event: 'confirmed', formId: form } },
      { id: 'mail1', type: 'send_email', config: { dispatchId: dispatchA } },
      { id: 'wait', type: 'delay', config: { mode: 'duration', amount: 2, unit: 'days' } },
      {
        id: 'paid',
        type: 'branch',
        config: { condition: { field: 'level', cmp: 'in', value: [level] } },
      },
      { id: 'mail2', type: 'send_email', config: { dispatchId: dispatchB, audience: 'paid' } },
      { id: 'tag', type: 'add_tag', config: { tagId: tag } },
    ],
    edges: [
      { from: 'trigger', to: 'mail1' },
      { from: 'mail1', to: 'wait' },
      { from: 'wait', to: 'paid' },
      { from: 'paid', to: 'mail2', label: 'true' },
      { from: 'paid', to: 'tag', label: 'false' },
    ],
  });
}

const codes = (graph: FlowGraph) => validateFlowGraph(graph).map((i) => i.code);

describe('Several start events', () => {
  const withTrigger = (config: unknown) =>
    FlowGraphDraftSchema.parse({
      schema: 1,
      nodes: [{ id: 'trigger', type: 'trigger', config }],
      edges: [],
    });

  it('reads a graph saved with one trigger as it was', () => {
    const graph = welcome();
    expect(triggersOf(graph)).toEqual([{ event: 'confirmed', formId: form }]);
    expect(extraTriggerTypes(graph)).toBeNull();
    expect(JSON.stringify(graph)).not.toContain('alsoStartOn');
  });

  it('lists every start event in order, each with its own filter', () => {
    const filter = { field: 'circle', cmp: 'eq', value: circle };
    const graph = withTrigger({
      event: 'confirmed',
      alsoStartOn: [
        { event: 'tag_added', tagId: tag, filter },
        { event: 'referral_succeeded' },
        { event: 'tag_added', tagId: newId('tag') },
      ],
    });
    expect(triggersOf(graph).map((t) => t.event)).toEqual([
      'confirmed',
      'tag_added',
      'referral_succeeded',
      'tag_added',
    ]);
    expect(triggersOf(graph)[1]?.filter).toEqual(filter);
    expect(extraTriggerTypes(graph)).toEqual(['tag_added', 'referral_succeeded']);
    expect(codes(graph)).toEqual([]);
  });

  it('keeps a default on a start event', () => {
    const graph = withTrigger({ event: 'confirmed', alsoStartOn: [{ event: 'member_joined' }] });
    expect(triggersOf(graph)[1]).toEqual({ event: 'member_joined', includeImports: false });
  });

  it('takes as many as the limit and no more', () => {
    const also = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ event: 'api_event', name: `e${i}` }));
    const node = (n: number) => ({
      id: 'trigger',
      type: 'trigger',
      config: { event: 'confirmed', alsoStartOn: also(n) },
    });
    expect(FLOW_MAX_TRIGGERS).toBeGreaterThanOrEqual(3);
    expect(FlowNodeSchema.safeParse(node(FLOW_MAX_TRIGGERS - 1)).success).toBe(true);
    expect(FlowNodeSchema.safeParse(node(FLOW_MAX_TRIGGERS)).success).toBe(false);
  });

  it('refuses a start event set up incompletely', () => {
    const node = {
      id: 'trigger',
      type: 'trigger',
      config: { event: 'confirmed', alsoStartOn: [{ event: 'tag_added' }] },
    };
    expect(FlowNodeSchema.safeParse(node).success).toBe(false);
  });

  it('flags two identical start events, but not the same event with different filters', () => {
    const same = withTrigger({
      event: 'tag_added',
      tagId: tag,
      alsoStartOn: [{ tagId: tag, event: 'tag_added' }],
    });
    expect(codes(same)).toContain('duplicate_trigger');
    const different = withTrigger({
      event: 'tag_added',
      tagId: tag,
      alsoStartOn: [
        { event: 'tag_added', tagId: tag, filter: { field: 'circle', cmp: 'eq', value: circle } },
      ],
    });
    expect(codes(different)).toEqual([]);
  });

  it('collects references from every start event', () => {
    const milestone = newId('championMilestone');
    const refs = collectReferencedIds(
      withTrigger({
        event: 'confirmed',
        formId: form,
        alsoStartOn: [
          { event: 'tag_added', tagId: tag },
          { event: 'referral_milestone', milestoneId: milestone },
          { event: 'api_event', name: 'go', filter: { field: 'circle', cmp: 'eq', value: circle } },
        ],
      }),
    );
    expect(refs.forms).toEqual([form]);
    expect(refs.tags).toEqual([tag]);
    expect(refs.milestones).toEqual([milestone]);
    expect(refs.circles).toEqual([circle]);
  });
});

describe('Flow graphs', () => {
  it('accepts a valid graph and fills defaults', () => {
    const graph = welcome();
    expect(codes(graph)).toEqual([]);
    expect(graph.edges[0]!.label).toBe('default');
    const mail = graph.nodes.find((n) => n.id === 'mail1');
    expect(mail?.type === 'send_email' && mail.config.audience).toBe('any');
    expect(nextNodeId(graph, 'paid', 'false')).toBe('tag');
    expect(nextNodeId(graph, 'tag', 'default')).toBeUndefined();
  });

  it('requires exactly one trigger', () => {
    const graph = welcome();
    graph.nodes.push({
      id: 't2',
      type: 'trigger',
      config: { event: 'tag_added', tagId: tag } as never,
    });
    expect(codes(graph)).toContain('trigger_count');
    graph.nodes = graph.nodes.filter((n) => n.type !== 'trigger');
    expect(codes(graph)).toContain('trigger_count');
  });

  it('refuses cycles, self loops and edges into the trigger', () => {
    const cycle = welcome();
    cycle.edges.push({ from: 'tag', to: 'mail1', label: 'default' });
    expect(codes(cycle)).toContain('cycle');

    const self = welcome();
    self.edges.push({ from: 'tag', to: 'tag', label: 'default' });
    expect(codes(self)).toContain('self_loop');

    const back = welcome();
    back.edges.push({ from: 'tag', to: 'trigger', label: 'default' });
    expect(codes(back)).toContain('edge_into_trigger');
  });

  it('checks edge labels against the node type', () => {
    const graph = welcome();
    graph.edges.push({ from: 'mail2', to: 'tag', label: 'timeout' });
    expect(codes(graph)).toContain('bad_label');

    const twice = welcome();
    twice.edges.push({ from: 'paid', to: 'mail1', label: 'true' });
    expect(codes(twice)).toContain('duplicate_label');
  });

  it('reports unreachable nodes and unknown edge ends', () => {
    const graph = welcome();
    graph.nodes.push({ id: 'lonely', type: 'exit', config: {} });
    expect(validateFlowGraph(graph)).toContainEqual(
      expect.objectContaining({ code: 'unreachable', nodeId: 'lonely' }),
    );
    graph.edges.push({ from: 'tag', to: 'nowhere', label: 'default' });
    expect(codes(graph)).toContain('unknown_node');
  });

  it('refuses the same email twice and waits on non-email steps', () => {
    const graph = welcome();
    const dup = graph.nodes.find((n) => n.id === 'mail2');
    if (dup?.type === 'send_email') dup.config.dispatchId = dispatchA;
    expect(codes(graph)).toContain('duplicate_email');

    const wait = welcome();
    wait.nodes.push({
      id: 'w',
      type: 'wait_for_event',
      config: { event: 'open', sendNodeId: 'tag', timeoutHours: 24 },
    });
    wait.edges.push({ from: 'tag', to: 'w', label: 'default' });
    expect(codes(wait)).toContain('bad_wait_source');
  });

  it('enforces config schemas through FlowGraphSchema', () => {
    const bad = {
      schema: 1,
      nodes: [
        { id: 'trigger', type: 'trigger', config: { event: 'unengaged', days: 3 } },
        { id: 'hook', type: 'webhook_call', config: { url: 'http://example.com/hook' } },
      ],
      edges: [{ from: 'trigger', to: 'hook' }],
    };
    expect(FlowGraphSchema.safeParse(bad).success).toBe(false);
    const cyclic = { ...welcome(), edges: [...welcome().edges, { from: 'tag', to: 'mail1' }] };
    const result = FlowGraphSchema.safeParse(cyclic);
    expect(result.success).toBe(false);
  });

  it('collects every referenced id for the same-Channel check', () => {
    const refs = collectReferencedIds(welcome());
    expect(refs.dispatches).toEqual([dispatchA, dispatchB].sort());
    expect(refs.forms).toEqual([form]);
    expect(refs.tags).toEqual([tag]);
    expect(refs.levels).toEqual([level]);
    expect(refs.circles).toEqual([]);

    const filtered = welcome();
    const trigger = filtered.nodes[0]!;
    if (trigger.type === 'trigger') {
      trigger.config = {
        event: 'circle_entered',
        circleId: circle,
        filter: { op: 'and', children: [{ field: 'field:plan', cmp: 'eq', value: 'Pro' }] },
      };
    }
    const more = collectReferencedIds(filtered);
    expect(more.circles).toEqual([circle]);
    expect(more.fieldKeys).toEqual(['plan']);
  });
});

describe('growth helpers', () => {
  it('picks split test winners deterministically', () => {
    const winner = pickSplitTestWinner([
      { variantId: 'a', label: 'A', delivered: 100, value: 20 },
      { variantId: 'b', label: 'B', delivered: 200, value: 40 },
      { variantId: 'c', label: 'C', delivered: 0, value: 0 },
    ]);
    expect(winner?.label).toBe('B');
    const tie = pickSplitTestWinner([
      { variantId: 'b', label: 'B', delivered: 100, value: 10 },
      { variantId: 'a', label: 'A', delivered: 100, value: 10 },
    ]);
    expect(tie?.label).toBe('A');
  });

  it('limits Funnel Explorer lookback on the free plan only', () => {
    expect(funnelLookbackDays('free')).toBe(30);
    expect(funnelLookbackDays('pro')).toBeNull();
  });
});

describe('funnel rates', () => {
  it('divides each stage by the one before it and leaves empty stages null', () => {
    expect(funnelRate(1, 3)).toBe(0.3333);
    expect(funnelRate(5, 0)).toBeNull();
    expect(
      funnelRates({
        visits: 200,
        formViews: 50,
        subscribes: 10,
        confirms: 0,
        firstOpens: 0,
        paid: 0,
      }),
    ).toEqual({ formViews: 0.25, subscribes: 0.2, confirms: 0, firstOpens: null, paid: null });
  });
});

describe('Flow Recipes', () => {
  it('builds a valid graph for every recipe, using each email exactly once', () => {
    for (const key of FLOW_RECIPES) {
      const def = FLOW_RECIPE_DEFS[key];
      const ids = Object.fromEntries(def.emails.map((e) => [e.key, newId('dispatch')]));
      const graph = FlowGraphSchema.parse(def.graph(ids));
      expect(validateFlowGraph(graph), key).toEqual([]);
      expect(collectReferencedIds(graph).dispatches, key).toEqual(Object.values(ids).sort());
    }
  });

  it('accepts auto-promotion settings on an A/B split only within bounds', () => {
    const split = (autoPromote: unknown) =>
      FlowGraphSchema.safeParse({
        schema: 1,
        nodes: [
          { id: 'trigger', type: 'trigger', config: { event: 'confirmed' } },
          { id: 'split', type: 'ab_split', config: { percentA: 50, autoPromote } },
        ],
        edges: [{ from: 'trigger', to: 'split' }],
      }).success;
    expect(split({ metric: 'opens' })).toBe(true);
    expect(split({ metric: 'clicks', minPerVariant: 500, afterHours: 72 })).toBe(true);
    expect(split({ metric: 'goal' })).toBe(false);
    expect(split({ metric: 'opens', afterHours: 0 })).toBe(false);
  });
});
