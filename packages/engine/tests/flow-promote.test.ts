import { FLOW_RECIPE_DEFS, newId, validateFlowGraph, type FlowGraph } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { replaceSplitWithWinner } from '../src/index';

const welcome = (): FlowGraph =>
  FLOW_RECIPE_DEFS.welcome.graph({ welcome_a: newId('dispatch'), welcome_b: newId('dispatch') });

describe('replaceSplitWithWinner', () => {
  it('replaces the split with a direct edge and drops the losing branch', () => {
    for (const winner of ['a', 'b'] as const) {
      const graph = replaceSplitWithWinner(welcome(), 'split', winner);
      const node = winner === 'a' ? 'welcome_a' : 'welcome_b';
      expect(graph.nodes.map((n) => n.id)).toEqual(['trigger', node]);
      expect(graph.edges).toEqual([{ from: 'trigger', to: node, label: 'default' }]);
      expect(validateFlowGraph(graph)).toEqual([]);
    }
  });

  it('keeps steps after the split that the winner still reaches', () => {
    const base = welcome();
    const graph: FlowGraph = {
      ...base,
      nodes: [...base.nodes, { id: 'done', type: 'exit', config: {} }],
      edges: [
        ...base.edges,
        { from: 'welcome_a', to: 'done', label: 'default' },
        { from: 'welcome_b', to: 'done', label: 'default' },
      ],
    };
    const promoted = replaceSplitWithWinner(graph, 'split', 'b');
    expect(promoted.nodes.map((n) => n.id)).toEqual(['trigger', 'welcome_b', 'done']);
    expect(validateFlowGraph(promoted)).toEqual([]);
  });
});
