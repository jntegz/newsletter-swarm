import { FLOW_RECIPE_DEFS, FLOW_RECIPES } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import {
  LAYER_GAP,
  addStep,
  connectionProblem,
  freeOutputs,
  heatColour,
  issuesByNode,
  layoutGraph,
  localIssues,
  mergeIssues,
  newNodeId,
  removeNode,
  setOutcome,
  toSavable,
  toWorking,
  withPositions,
  type WorkingGraph,
} from './graph';
import { summarize } from './summary';

const D1 = 'dp_00000000000000000000000000000001';
const D2 = 'dp_00000000000000000000000000000002';

/** trigger → branch (true → send a, false → delay → send b). */
function sample(): WorkingGraph {
  return {
    nodes: [
      { id: 'trigger', type: 'trigger', config: { event: 'confirmed' } },
      {
        id: 'check',
        type: 'branch',
        config: { condition: { op: 'and', children: [{ field: 'tag', cmp: 'eq', value: 'vip' }] } },
      },
      { id: 'send_a', type: 'send_email', config: { dispatchId: D1, audience: 'any' } },
      { id: 'wait', type: 'delay', config: { mode: 'duration', amount: 2, unit: 'days' } },
      { id: 'send_b', type: 'send_email', config: { dispatchId: D2, audience: 'any' } },
    ],
    edges: [
      { from: 'trigger', to: 'check', label: 'default' },
      { from: 'check', to: 'send_a', label: 'true' },
      { from: 'check', to: 'wait', label: 'false' },
      { from: 'wait', to: 'send_b', label: 'default' },
    ],
  };
}

describe('layoutGraph', () => {
  it('puts each node one layer below its deepest parent, branches left to right', () => {
    const p = layoutGraph(sample());
    expect(p.trigger).toEqual({ x: 0, y: 0 });
    expect(p.check!.y).toBe(LAYER_GAP);
    expect(p.send_a!.y).toBe(2 * LAYER_GAP);
    expect(p.wait!.y).toBe(2 * LAYER_GAP);
    expect(p.send_b!.y).toBe(3 * LAYER_GAP);
    // "Yes" sits left of "No".
    expect(p.send_a!.x).toBeLessThan(p.wait!.x);
  });

  it('places a node reached by two paths below both', () => {
    const g = sample();
    g.edges.push({ from: 'send_a', to: 'send_b', label: 'default' });
    const p = layoutGraph(g);
    expect(p.send_b!.y).toBe(3 * LAYER_GAP);
  });

  it('puts unreachable nodes in a last row', () => {
    const g = sample();
    g.nodes.push({ id: 'stray', type: 'exit', config: {} });
    const p = layoutGraph(g);
    expect(p.stray!.y).toBe(4 * LAYER_GAP);
  });

  it('fills positions only when some are missing', () => {
    const g = sample();
    const laid = withPositions(g);
    expect(laid.nodes.every((n) => n.position)).toBe(true);
    const moved = { ...laid, nodes: laid.nodes.map((n) => ({ ...n, position: { x: 7, y: 7 } })) };
    expect(withPositions(moved)).toBe(moved);
  });
});

describe('connections', () => {
  it('follows FLOW_NODE_OUTPUTS', () => {
    const g = sample();
    expect(freeOutputs(g, 'check')).toEqual([]);
    expect(freeOutputs(g, 'send_b')).toEqual(['default']);
    expect(connectionProblem(g, 'send_b', 'wait', 'true')).toMatch(/no such outcome/);
    expect(connectionProblem(g, 'send_b', 'trigger', 'default')).toMatch(/into the trigger/);
    expect(connectionProblem(g, 'send_b', 'send_b', 'default')).toMatch(/itself/);
    expect(connectionProblem(g, 'send_b', 'check', 'default')).toMatch(/loop back/);
    expect(connectionProblem(g, 'check', 'send_b', 'true')).toMatch(/already connected/);
    expect(connectionProblem(g, 'send_a', 'send_b', 'default')).toBeNull();
  });

  it('exit nodes have no outcomes', () => {
    const g = sample();
    g.nodes.push({ id: 'end', type: 'exit', config: {} });
    expect(freeOutputs(g, 'end')).toEqual([]);
  });

  it('setOutcome replaces or clears an outcome', () => {
    const g = setOutcome(sample(), 'check', 'true', 'send_b');
    expect(g.edges.filter((e) => e.from === 'check' && e.label === 'true')).toEqual([
      { from: 'check', to: 'send_b', label: 'true' },
    ]);
    const cleared = setOutcome(g, 'check', 'true', null);
    expect(cleared.edges.some((e) => e.from === 'check' && e.label === 'true')).toBe(false);
  });

  it('addStep connects after the selected node on its first free outcome', () => {
    const { graph, id } = addStep(withPositions(sample()), 'exit', 'send_b');
    expect(id).toBe('exit_1');
    expect(graph.edges).toContainEqual({ from: 'send_b', to: 'exit_1', label: 'default' });
    const again = addStep(graph, 'exit');
    expect(again.id).toBe('exit_2');
    expect(again.graph.edges.length).toBe(graph.edges.length);
  });

  it('removeNode drops its edges and never the trigger', () => {
    const g = removeNode(sample(), 'wait');
    expect(g.nodes.map((n) => n.id)).not.toContain('wait');
    expect(g.edges.some((e) => e.from === 'wait' || e.to === 'wait')).toBe(false);
    expect(removeNode(g, 'trigger')).toBe(g);
  });

  it('new node ids match the API pattern', () => {
    expect(newNodeId(sample(), 'wait_for_event')).toMatch(/^[a-z0-9_-]{1,40}$/i);
  });
});

describe('saving and issues', () => {
  it('keeps incomplete steps out of the saved graph and reports them', () => {
    const { graph } = addStep(sample(), 'add_tag', 'send_b');
    const { graph: saved, incomplete } = toSavable(graph);
    expect(saved.nodes.map((n) => n.id)).not.toContain('add_tag_1');
    expect(saved.edges.some((e) => e.to === 'add_tag_1')).toBe(false);
    expect(incomplete).toEqual([
      { code: 'incomplete', message: 'Choose a tag.', nodeId: 'add_tag_1' },
    ]);
  });

  it('saves incomplete steps as pending and restores the same working graph from both', () => {
    const { graph } = addStep(sample(), 'add_tag', 'send_b');
    const { graph: saved, pending } = toSavable(graph);
    expect(pending?.nodes.map((n) => n.id)).toEqual(['add_tag_1']);
    expect(pending?.edges.every((e) => e.from === 'add_tag_1' || e.to === 'add_tag_1')).toBe(true);
    const restored = toWorking(saved, pending);
    expect(new Set(restored.nodes.map((n) => n.id))).toEqual(new Set(graph.nodes.map((n) => n.id)));
    expect(restored.edges).toHaveLength(graph.edges.length);
    expect(toSavable(sample()).pending).toBeNull();
  });

  it('a complete sample has no issues; structural ones come from validateFlowGraph', () => {
    expect(localIssues(sample())).toEqual([]);
    const g = sample();
    g.nodes.push({ id: 'stray', type: 'exit', config: {} });
    expect(localIssues(g)).toEqual([
      { code: 'unreachable', message: 'This step can never be reached.', nodeId: 'stray' },
    ]);
    const dup = sample();
    (dup.nodes[4]!.config as { dispatchId: string }).dispatchId = D1;
    expect(localIssues(dup).map((i) => i.code)).toEqual(['duplicate_email']);
  });

  it('merges API and local issues without duplicates and groups them by node', () => {
    const merged = mergeIssues(
      [
        { code: 'unreachable', message: 'x', nodeId: 'a' },
        { code: 'trigger_count', message: 'y' },
      ],
      [{ code: 'unreachable', message: 'x', nodeId: 'a' }],
    );
    expect(merged).toHaveLength(2);
    const grouped = issuesByNode(merged);
    expect(grouped.get('a')).toHaveLength(1);
    expect(grouped.get('')).toHaveLength(1);
  });

  it('every recipe graph loads without issues', () => {
    for (const key of FLOW_RECIPES) {
      const def = FLOW_RECIPE_DEFS[key];
      const ids = Object.fromEntries(
        def.emails.map((e, i) => [e.key, `dp_${String(i + 1).padStart(32, '0')}`]),
      );
      expect(localIssues(toWorking(def.graph(ids))), key).toEqual([]);
    }
  });
});

describe('display', () => {
  it('summarises steps in plain words', () => {
    const names = { email: (id: string) => (id === D1 ? 'Welcome aboard' : undefined) };
    const [trigger, branch, sendA, wait] = sample().nodes;
    expect(summarize(trigger!, names)).toBe('Confirmed opt-in');
    expect(summarize(branch!, names)).toBe('If 1 condition match');
    expect(summarize(sendA!, names)).toBe('Welcome aboard');
    expect(summarize(wait!, names)).toBe('Wait 2 days');
    expect(
      summarize({
        id: 'd',
        type: 'delay',
        config: { mode: 'until', weekdays: [1, 3], time: '09:00', timezone: 'member' },
      }),
    ).toBe("Until Mon, Wed at 09:00, the subscriber's time");
    expect(summarize({ id: 's', type: 'ab_split', config: { percentA: 30 } })).toBe(
      '30% A · 70% B',
    );
  });

  it('colours drop-off from indigo to the danger tone', () => {
    expect(heatColour(0)).toBe('rgb(108, 76, 241)');
    expect(heatColour(1)).toBe('rgb(181, 64, 31)');
    expect(heatColour(5)).toBe(heatColour(1));
  });
});

describe('several start events', () => {
  const TAG = 'tg_00000000000000000000000000000001';
  const graphWith = (config: Record<string, unknown>): WorkingGraph => ({
    nodes: [{ id: 'trigger', type: 'trigger', config }],
    edges: [],
  });

  it('saves a complete set of start events and keeps them on the trigger', () => {
    const config = {
      event: 'confirmed',
      alsoStartOn: [{ event: 'tag_added', tagId: TAG }, { event: 'referral_succeeded' }],
    };
    const saved = toSavable(graphWith(config));
    expect(saved.incomplete).toEqual([]);
    expect(saved.graph.nodes[0]?.config).toEqual(config);
    expect(toWorking(saved.graph).nodes[0]?.config).toEqual(config);
  });

  it('keeps an unfinished start event as a pending step', () => {
    const saved = toSavable(
      graphWith({ event: 'confirmed', alsoStartOn: [{ event: 'tag_added' }] }),
    );
    expect(saved.incomplete[0]?.message).toBe('Finish setting up the trigger.');
    expect(saved.pending?.nodes[0]?.id).toBe('trigger');
  });

  it('flags two identical start events', () => {
    const issues = localIssues(
      graphWith({
        event: 'tag_added',
        tagId: TAG,
        alsoStartOn: [{ event: 'tag_added', tagId: TAG }],
      }),
    );
    expect(issues.map((i) => i.code)).toContain('duplicate_trigger');
  });

  it('summarises by how many there are, and names a milestone', () => {
    const node = (config: Record<string, unknown>) => ({
      id: 'trigger',
      type: 'trigger' as const,
      config,
    });
    expect(
      summarize(node({ event: 'confirmed', alsoStartOn: [{ event: 'referral_succeeded' }] })),
    ).toBe('2 start events');
    expect(summarize(node({ event: 'referral_succeeded' }))).toBe('Referral succeeded');
    expect(
      summarize(node({ event: 'referral_milestone', milestoneId: 'cm_1' }), {
        milestone: () => 'Five friends',
      }),
    ).toBe('Referral milestone reached: Five friends');
  });
});
