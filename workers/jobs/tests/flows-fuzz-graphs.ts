// Random Flow graphs and inbox rules, shared by the fuzz (flows-fuzz.test.ts) and the comparison of
// real runs with rehearsals (flows-rehearse.test.ts).
import {
  FLOW_NODE_OUTPUTS,
  FlowGraphSchema,
  InboxRulesSchema,
  validateFlowGraph,
  type FlowGraph,
  type InboxRules,
} from '@swarm/domain';
import { expect } from 'vitest';
import { dispatchId } from './flows-helpers';

export const ZONES = ['Europe/Prague', 'America/New_York', 'Asia/Tokyo', 'Pacific/Auckland'];

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rand = () => number;
export const below = (rand: Rand, n: number) => Math.floor(rand() * n);
export const pick = <T>(rand: Rand, list: readonly T[]): T => list[below(rand, list.length)]!;

/** Any mix of the rules, tight enough that emails are held, stack up and sometimes go stale. */
export function randomRules(rand: Rand): InboxRules {
  return InboxRulesSchema.parse({
    perDay: rand() < 0.5 ? 1 + below(rand, 3) : null,
    perWeek: rand() < 0.35 ? 2 + below(rand, 6) : null,
    quietHours:
      rand() < 0.5
        ? pick(rand, [
            { start: '22:00', end: '08:00' },
            { start: '09:00', end: '17:00' },
            { start: '00:30', end: '23:30' },
          ])
        : null,
    newsletterDay: rand() < 0.4 ? { hoursAround: pick(rand, [0, 0, 6, 48]) } : null,
    maxHoldDays: pick(rand, [1, 2, 14]),
  });
}

type RawNode = { id: string; type: string; config: Record<string, unknown> };
type RawEdge = { from: string; to: string; label: string };

export interface Refs {
  tags: { id: string; name: string }[];
  levelId: string;
  fieldId: string;
  operatorId: string;
  /** A second live Flow that enrol_flow can point at. */
  targetFlowId?: string;
}

/** A valid random graph using every action in the catalogue. */
export function randomGraph(
  rand: Rand,
  trigger: Record<string, unknown>,
  refs: Refs,
  options: { condition?: (rand: Rand) => unknown } = {},
): FlowGraph {
  const nodes: RawNode[] = [{ id: 'trigger', type: 'trigger', config: trigger }];
  const edges: RawEdge[] = [];
  const free: { from: string; label: string }[] = [{ from: 'trigger', label: 'default' }];
  const size = 4 + below(rand, 9);
  for (let i = 0; i < size && free.length; i++) {
    const id = `n${i}`;
    const type = pick(rand, [
      'send_email',
      'send_email',
      'send_email',
      'send_email',
      'delay',
      'delay',
      'add_tag',
      'remove_tag',
      'update_field',
      'change_level',
      ...(refs.targetFlowId ? (['enrol_flow'] as const) : []),
      'branch',
      'ab_split',
      'wait_for_event',
      'webhook_call',
      'notify_author',
      'exit',
    ] as const);
    let config: Record<string, unknown>;
    switch (type) {
      case 'send_email':
        config = {
          dispatchId: dispatchId(),
          audience: pick(rand, ['any', 'any', 'paid', 'free']),
          ...(rand() < 0.2 ? { sendRegardless: true } : {}),
        };
        break;
      case 'delay':
        config = pick(rand, [
          { mode: 'duration', amount: 1 + below(rand, 90), unit: 'minutes' },
          { mode: 'duration', amount: 1 + below(rand, 30), unit: 'hours' },
          { mode: 'duration', amount: 1 + below(rand, 3), unit: 'days' },
          { mode: 'until', weekdays: [below(rand, 7)], time: '08:30', timezone: 'member' },
          { mode: 'until', weekdays: [below(rand, 7)], time: '17:00', timezone: 'Europe/Prague' },
        ]);
        break;
      case 'add_tag':
      case 'remove_tag':
        config = { tagId: pick(rand, refs.tags).id };
        break;
      case 'update_field':
        config = { fieldId: refs.fieldId, value: pick(rand, ['Acme', 'Globex']) };
        break;
      case 'change_level':
        config =
          rand() < 0.7
            ? { action: 'grant', levelId: refs.levelId, days: pick(rand, [1, 30, null]) }
            : { action: 'revoke', levelId: refs.levelId };
        break;
      case 'enrol_flow':
        config = { flowId: refs.targetFlowId };
        break;
      case 'branch':
        config = {
          condition: options.condition
            ? options.condition(rand)
            : { field: 'tag', cmp: 'eq', value: pick(rand, refs.tags).name },
        };
        break;
      case 'ab_split':
        config = { percentA: 1 + below(rand, 98) };
        break;
      case 'wait_for_event':
        config = {
          event: pick(rand, ['open', 'click']),
          timeoutHours: 1 + below(rand, 48),
        };
        break;
      case 'webhook_call':
        config = { url: 'https://hooks.example.com/in', includeFields: rand() < 0.5 };
        break;
      case 'notify_author':
        config = {
          message: 'A Member got here.',
          ...(rand() < 0.5 ? { operatorIds: [refs.operatorId] } : {}),
        };
        break;
      case 'exit':
        config = {};
        break;
    }
    const slot = free.splice(below(rand, free.length), 1)[0]!;
    edges.push({ from: slot.from, to: id, label: slot.label });
    nodes.push({ id, type, config });
    for (const label of FLOW_NODE_OUTPUTS[type]) free.push({ from: id, label });
    // Sometimes join another free outcome to this node (a DAG merge).
    if (free.length > 1 && rand() < 0.3) {
      const extra = free.findIndex((f) => f.from !== id);
      if (extra >= 0) {
        const [s] = free.splice(extra, 1);
        edges.push({ from: s!.from, to: id, label: s!.label });
      }
    }
  }
  const graph = FlowGraphSchema.parse({ schema: 1, nodes, edges });
  expect(validateFlowGraph(graph)).toEqual([]);
  return graph;
}
