// Pure helpers for the Flow builder: the step palette, connection rules (FLOW_NODE_OUTPUTS),
// a top-down layered layout for graphs without positions, and the issue list shown on nodes.
//
// The builder keeps a working graph whose nodes may still be half set up (a send step without its
// email, a tag step without a tag). Complete nodes, and edges between them, are saved as the draft
// graph: the API stores drafts with structural issues but refuses configs that don't parse. The
// rest is saved beside it as `draftPending`, so leaving the page keeps half-set-up steps.
import {
  FLOW_GRAPH_SCHEMA_VERSION,
  FLOW_NODE_OUTPUTS,
  FlowNodeSchema,
  validateFlowGraph,
  type FlowDraftPending,
  type FlowEdge,
  type FlowEdgeLabel,
  type FlowGraph,
  type FlowGraphIssue,
  type FlowNode,
  type FlowNodeType,
  type FlowTriggerType,
} from '@swarm/domain';

/** A node in the working graph: the saved shape, with a config that may be incomplete. */
export interface WorkingNode {
  id: string;
  type: FlowNodeType;
  config: Record<string, unknown>;
  position?: { x: number; y: number };
  name?: string;
}
export interface WorkingGraph {
  nodes: WorkingNode[];
  edges: FlowEdge[];
}

export interface Issue {
  code: string;
  message: string;
  nodeId?: string | undefined;
}

// ---- Palette ---------------------------------------------------------------------------------

export type ActionType = Exclude<FlowNodeType, 'trigger'>;

export const STEP_INFO: Record<
  FlowNodeType,
  {
    label: string;
    description: string;
    group: 'Start' | 'Message' | 'Timing' | 'Member' | 'Logic' | 'Other';
  }
> = {
  trigger: { label: 'Trigger', description: 'What starts the automation.', group: 'Start' },
  send_email: { label: 'Send email', description: 'Send an automation email.', group: 'Message' },
  delay: {
    label: 'Delay',
    description: 'Wait a while, or until a weekday and time.',
    group: 'Timing',
  },
  wait_for_event: {
    label: 'Wait for open or click',
    description: 'Wait for an email to be opened or clicked, with a timeout.',
    group: 'Timing',
  },
  add_tag: { label: 'Add tag', description: 'Tag the subscriber.', group: 'Member' },
  remove_tag: {
    label: 'Remove tag',
    description: 'Take a tag off the subscriber.',
    group: 'Member',
  },
  update_field: { label: 'Update field', description: 'Set a profile field.', group: 'Member' },
  change_level: {
    label: 'Change paid plan',
    description: 'Grant or revoke a complimentary paid plan.',
    group: 'Member',
  },
  enrol_flow: {
    label: 'Start another automation',
    description: 'Enrol the subscriber in another automation.',
    group: 'Member',
  },
  branch: { label: 'Branch', description: 'Go one way or another on a condition.', group: 'Logic' },
  ab_split: {
    label: 'A/B split',
    description: 'Split subscribers between two paths.',
    group: 'Logic',
  },
  webhook_call: {
    label: 'Webhook',
    description: 'Call a URL with the subscriber’s details.',
    group: 'Other',
  },
  notify_author: {
    label: 'Notify the team',
    description: 'Email the publication’s team.',
    group: 'Other',
  },
  exit: { label: 'Exit', description: 'End the run here.', group: 'Other' },
};

export const PALETTE: ActionType[] = [
  'send_email',
  'delay',
  'wait_for_event',
  'branch',
  'ab_split',
  'add_tag',
  'remove_tag',
  'update_field',
  'change_level',
  'enrol_flow',
  'webhook_call',
  'notify_author',
  'exit',
];

/** Starting configs. Some are incomplete on purpose: the inspector asks for the rest. */
function defaultConfig(type: ActionType): Record<string, unknown> {
  switch (type) {
    case 'send_email':
      return { audience: 'any' };
    case 'delay':
      return { mode: 'duration', amount: 1, unit: 'days' };
    case 'change_level':
      return { action: 'grant', days: null };
    case 'branch':
      return { condition: { op: 'and', children: [] } };
    case 'ab_split':
      return { percentA: 50 };
    case 'wait_for_event':
      return { event: 'open', timeoutHours: 72 };
    case 'webhook_call':
      return { includeFields: false };
    case 'notify_author':
      return { message: 'A subscriber reached this step.' };
    default:
      return {};
  }
}

export const TRIGGER_LABEL: Record<FlowTriggerType, string> = {
  member_joined: 'Subscriber joined',
  form_submitted: 'Form submitted',
  confirmed: 'Confirmed opt-in',
  circle_entered: 'Entered a segment',
  circle_exited: 'Left a segment',
  tag_added: 'Tag added',
  tag_removed: 'Tag removed',
  field_changed: 'Profile field changed',
  level_purchased: 'Paid plan purchased',
  level_canceled: 'Paid plan canceled',
  ask_answered: 'Answered a poll or survey',
  unengaged: 'Unengaged for a while',
  link_clicked: 'Link clicked',
  gate_hit: 'Reached a paywall',
  api_event: 'API event',
  roster_joined: 'Joined a Roster',
  roster_left: 'Left a Roster',
  referral_succeeded: 'Referral succeeded',
  referral_milestone: 'Referral milestone reached',
};

export const EDGE_LABEL: Record<FlowEdgeLabel, string> = {
  default: 'Next',
  true: 'Yes',
  false: 'No',
  a: 'A',
  b: 'B',
  timeout: 'Timed out',
};

/** A node id that is new to the graph: `<type>_<n>`, within the 40-character limit. */
export function newNodeId(graph: WorkingGraph, type: ActionType): string {
  const taken = new Set(graph.nodes.map((n) => n.id));
  const base = type.replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
  for (let i = 1; ; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ---- Connections -----------------------------------------------------------------------------

export const outputsOf = (type: FlowNodeType): readonly FlowEdgeLabel[] => FLOW_NODE_OUTPUTS[type];

/** Outputs of a node that have no edge yet. */
export function freeOutputs(graph: WorkingGraph, nodeId: string): FlowEdgeLabel[] {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return [];
  const used = new Set(graph.edges.filter((e) => e.from === nodeId).map((e) => e.label));
  return outputsOf(node.type).filter((label) => !used.has(label));
}

/** Whether `to` can already reach `from` (so a new from → to edge would close a loop). */
function reaches(graph: WorkingGraph, start: string, target: string): boolean {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of graph.edges) if (e.from === id) stack.push(e.to);
  }
  return false;
}

/** Why an edge from → to on `label` is refused, or null when it is allowed. */
export function connectionProblem(
  graph: WorkingGraph,
  from: string,
  to: string,
  label: FlowEdgeLabel,
): string | null {
  const source = graph.nodes.find((n) => n.id === from);
  const target = graph.nodes.find((n) => n.id === to);
  if (!source || !target) return 'That step no longer exists.';
  if (from === to) return 'A step cannot lead to itself.';
  if (target.type === 'trigger') return 'Nothing can lead into the trigger.';
  if (!outputsOf(source.type).includes(label)) return 'That step has no such outcome.';
  if (graph.edges.some((e) => e.from === from && e.label === label && e.to !== to)) {
    return 'That outcome is already connected.';
  }
  if (reaches(graph, to, from)) return 'Steps cannot loop back.';
  return null;
}

/** Points `from`'s `label` outcome at `to` (replacing what it pointed at), or ends it (null). */
export function setOutcome(
  graph: WorkingGraph,
  from: string,
  label: FlowEdgeLabel,
  to: string | null,
): WorkingGraph {
  const edges = graph.edges.filter((e) => !(e.from === from && e.label === label));
  if (to) edges.push({ from, to, label });
  return { ...graph, edges };
}

/** Removes a node and every edge touching it. The trigger stays. */
export function removeNode(graph: WorkingGraph, nodeId: string): WorkingGraph {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node || node.type === 'trigger') return graph;
  return {
    nodes: graph.nodes.filter((n) => n.id !== nodeId),
    edges: graph.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
  };
}

/**
 * Adds a step. With `after`, it is connected from that node's first free outcome and placed
 * below it.
 */
export function addStep(
  graph: WorkingGraph,
  type: ActionType,
  after?: string,
): { graph: WorkingGraph; id: string } {
  const id = newNodeId(graph, type);
  const parent = after ? graph.nodes.find((n) => n.id === after) : undefined;
  const label = parent ? freeOutputs(graph, parent.id)[0] : undefined;
  const siblings = parent ? graph.edges.filter((e) => e.from === parent.id).length : 0;
  const lowest = graph.nodes.reduce((max, n) => Math.max(max, n.position?.y ?? 0), 0);
  const position = parent?.position
    ? { x: parent.position.x + siblings * (NODE_GAP_X / 1.5), y: parent.position.y + LAYER_GAP }
    : { x: 0, y: lowest + LAYER_GAP };
  const node: WorkingNode = { id, type, config: defaultConfig(type), position };
  const next: WorkingGraph = { nodes: [...graph.nodes, node], edges: graph.edges };
  return {
    id,
    graph: parent && label ? setOutcome(next, parent.id, label, id) : next,
  };
}

// ---- Layout ----------------------------------------------------------------------------------

const NODE_GAP_X = 260;
export const LAYER_GAP = 140;

const LABEL_ORDER: FlowEdgeLabel[] = ['default', 'true', 'a', 'false', 'b', 'timeout'];

/**
 * A simple top-down layered layout: each node sits one layer below its deepest parent (the
 * graph is a DAG), siblings are ordered by their parent's place and the outcome label, and each
 * layer is centred on x = 0. Unreachable nodes go in a final row.
 */
export function layoutGraph(graph: WorkingGraph): Record<string, { x: number; y: number }> {
  const ids = graph.nodes.map((n) => n.id);
  const known = new Set(ids);
  const edges = graph.edges.filter((e) => known.has(e.from) && known.has(e.to) && e.from !== e.to);
  const incoming = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const e of edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);

  // Longest-path layering with Kahn's algorithm; nodes left over sit in a cycle or below one.
  const layer = new Map<string, number>();
  const queue = graph.nodes.filter((n) => n.type === 'trigger' || incoming.get(n.id) === 0);
  const trigger = graph.nodes.find((n) => n.type === 'trigger');
  for (const n of queue) layer.set(n.id, 0);
  const remaining = new Map(incoming);
  const order: string[] = [];
  const pending = queue.map((n) => n.id);
  while (pending.length) {
    const id = pending.shift()!;
    order.push(id);
    const children = edges
      .filter((e) => e.from === id)
      .sort((a, b) => LABEL_ORDER.indexOf(a.label) - LABEL_ORDER.indexOf(b.label));
    for (const e of children) {
      layer.set(e.to, Math.max(layer.get(e.to) ?? 0, (layer.get(id) ?? 0) + 1));
      const left = (remaining.get(e.to) ?? 0) - 1;
      remaining.set(e.to, left);
      if (left === 0) pending.push(e.to);
    }
  }

  // Reachable from the trigger: everything else (and leftovers) goes in a last row.
  const reachable = new Set<string>(trigger ? [] : order);
  if (trigger) {
    const stack = [trigger.id];
    while (stack.length) {
      const id = stack.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const e of edges) if (e.from === id) stack.push(e.to);
    }
  }
  let deepest = 0;
  for (const id of reachable) deepest = Math.max(deepest, layer.get(id) ?? 0);
  const rows = new Map<number, string[]>();
  const place = (id: string, row: number) => rows.set(row, [...(rows.get(row) ?? []), id]);
  for (const id of order) if (reachable.has(id)) place(id, layer.get(id) ?? 0);
  for (const id of ids) if (!reachable.has(id)) place(id, deepest + 1);

  // Order each row by the mean position of its parents in the row above.
  const positions: Record<string, { x: number; y: number }> = {};
  const sortedRows = [...rows.entries()].sort((a, b) => a[0] - b[0]);
  for (const [row, members] of sortedRows) {
    const weight = (id: string) => {
      const parents = edges.filter((e) => e.to === id && positions[e.from]);
      if (!parents.length) return members.indexOf(id) * 1e-3;
      return (
        parents.reduce(
          (sum, e) => sum + positions[e.from]!.x + (LABEL_ORDER.indexOf(e.label) - 2) * 0.01,
          0,
        ) / parents.length
      );
    };
    const sorted = [...members].sort((a, b) => weight(a) - weight(b));
    sorted.forEach((id, i) => {
      positions[id] = { x: (i - (sorted.length - 1) / 2) * NODE_GAP_X, y: row * LAYER_GAP };
    });
  }
  return positions;
}

/** Fills in positions for nodes that have none (all of them laid out, if any are missing). */
export function withPositions(graph: WorkingGraph): WorkingGraph {
  if (graph.nodes.every((n) => n.position)) return graph;
  const positions = layoutGraph(graph);
  return {
    ...graph,
    nodes: graph.nodes.map((n) => ({ ...n, position: positions[n.id] ?? { x: 0, y: 0 } })),
  };
}

// ---- Completeness and saving -----------------------------------------------------------------

/** The node parsed against the schema, or the first problem with its config. */
function parseNode(
  node: WorkingNode,
): { ok: true; node: FlowNode } | { ok: false; message: string } {
  const result = FlowNodeSchema.safeParse(node);
  if (result.success) return { ok: true, node: result.data };
  return { ok: false, message: incompleteMessage(node) };
}

function incompleteMessage(node: WorkingNode): string {
  const c = node.config;
  switch (node.type) {
    case 'send_email':
      return c.dispatchId ? 'Check this email step.' : 'Choose or write the email to send.';
    case 'add_tag':
    case 'remove_tag':
      return 'Choose a tag.';
    case 'update_field':
      return c.fieldId ? 'Enter a value for the field.' : 'Choose a profile field.';
    case 'change_level':
      return 'Choose a paid plan.';
    case 'enrol_flow':
      return 'Choose the automation to start.';
    case 'branch':
      return 'Add a condition to the branch.';
    case 'webhook_call':
      return 'Enter an https URL for the webhook.';
    case 'notify_author':
      return 'Write the message for the team.';
    case 'delay':
      return c.mode === 'until'
        ? 'Choose at least one weekday, a time and a timezone.'
        : 'Enter a whole number of minutes, hours or days.';
    case 'ab_split':
      return 'Send between 1 and 99% down path A.';
    case 'wait_for_event':
      return 'Set a timeout of at least one hour, and a valid URL if you enter one.';
    case 'trigger':
      return 'Finish setting up the trigger.';
    default:
      return 'Finish setting up this step.';
  }
}

/**
 * What the API is sent: the draft graph (complete nodes, edges between them), the pending steps
 * (incomplete nodes and every edge touching one; null when there are none), and an issue per
 * incomplete node (shown on it and in the list).
 */
export function toSavable(graph: WorkingGraph): {
  graph: FlowGraph;
  pending: FlowDraftPending | null;
  incomplete: Issue[];
} {
  const nodes: FlowNode[] = [];
  const pendingNodes: FlowDraftPending['nodes'] = [];
  const incomplete: Issue[] = [];
  for (const node of graph.nodes) {
    const parsed = parseNode(node);
    if (parsed.ok) nodes.push(parsed.node);
    else {
      pendingNodes.push(node);
      incomplete.push({ code: 'incomplete', message: parsed.message, nodeId: node.id });
    }
  }
  const kept = new Set(nodes.map((n) => n.id));
  const complete = (e: FlowEdge) => kept.has(e.from) && kept.has(e.to);
  return {
    graph: { schema: FLOW_GRAPH_SCHEMA_VERSION, nodes, edges: graph.edges.filter(complete) },
    pending: pendingNodes.length
      ? { nodes: pendingNodes, edges: graph.edges.filter((e) => !complete(e)) }
      : null,
    incomplete,
  };
}

/** Structural issues of the working graph: its incomplete steps first, then validateFlowGraph's. */
export function localIssues(graph: WorkingGraph): Issue[] {
  const { graph: savable, incomplete } = toSavable(graph);
  if (!savable.nodes.length) return incomplete;
  const structural = validateFlowGraph(savable).filter(
    // An incomplete step's children look unreachable only because its edges aren't saved yet.
    (issue) => !(issue.code === 'unreachable' && incomplete.length > 0),
  );
  return [...incomplete, ...structural.map(issueOf)];
}

const issueOf = (issue: FlowGraphIssue): Issue => ({
  code: issue.code,
  message: issue.message,
  ...(issue.nodeId ? { nodeId: issue.nodeId } : {}),
});

/** The API's issues and the local ones, without duplicates (same code on the same node). */
export function mergeIssues(fromApi: readonly Issue[], local: readonly Issue[]): Issue[] {
  const seen = new Set<string>();
  const out: Issue[] = [];
  for (const issue of [...local, ...fromApi]) {
    const key = `${issue.code}|${issue.nodeId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

/** Issues grouped by node id; issues without a node are under ''. */
export function issuesByNode(issues: readonly Issue[]): Map<string, Issue[]> {
  const map = new Map<string, Issue[]>();
  for (const issue of issues) {
    const key = issue.nodeId ?? '';
    map.set(key, [...(map.get(key) ?? []), issue]);
  }
  return map;
}

/** The working graph from a saved draft and its pending steps (when there are any). */
export const toWorking = (graph: FlowGraph, pending?: FlowDraftPending | null): WorkingGraph => {
  const saved = new Set(graph.nodes.map((n) => n.id));
  const extra = (pending?.nodes ?? []).filter((n) => !saved.has(n.id));
  const all = new Set([...saved, ...extra.map((n) => n.id)]);
  return {
    nodes: [...graph.nodes, ...extra].map((n) => {
      const node: WorkingNode = { id: n.id, type: n.type, config: { ...n.config } };
      if (n.position) node.position = n.position;
      if (n.name) node.name = n.name;
      return node;
    }),
    edges: [
      ...graph.edges,
      ...(pending?.edges ?? []).filter((e) => all.has(e.from) && all.has(e.to)),
    ].map((e) => ({ ...e })),
  };
};

// ---- Stats -----------------------------------------------------------------------------------

/**
 * Drop-off as a heat colour, from the calm series colour (no drop-off) to the danger tone (all
 * runs stop). Returned as an `rgb()` string so it works in SVG stroke attributes.
 */
export function heatColour(dropOff: number): string {
  const t = Math.min(1, Math.max(0, dropOff));
  const from = [0x6c, 0x4c, 0xf1]; // --purple
  const to = [0xb5, 0x40, 0x1f]; // --danger
  const mix = from.map((c, i) => Math.round(c + (to[i]! - c) * t));
  return `rgb(${mix.join(', ')})`;
}
