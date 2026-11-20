// The Flow canvas (React Flow): steps as nodes with one source handle per outcome
// (FLOW_NODE_OUTPUTS), labelled edges, issues on nodes, and an optional stats overlay with
// drop-off heat on the edges. Loaded only with the builder route.
import '@xyflow/react/dist/style.css';
import './canvas.css';
import type { FlowEdgeLabel, FlowNodeType } from '@swarm/domain';
import {
  Background,
  Handle,
  Panel,
  MarkerType,
  Position,
  ReactFlow,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  EDGE_LABEL,
  STEP_INFO,
  connectionProblem,
  heatColour,
  outputsOf,
  type Issue,
  type WorkingGraph,
} from './graph';
import { StepIcon } from './StepIcon';
import { summarize, type Names } from './summary';

export interface NodeStatsOverlay {
  entered: number;
  completed: number;
  exited: number;
  failed: number;
}

interface StepData extends Record<string, unknown> {
  type: FlowNodeType;
  title: string;
  summary: string;
  issues: Issue[];
  stats?: NodeStatsOverlay;
  readOnly: boolean;
  /** A rehearsal is showing: true on its path, false off it. */
  onPath?: boolean;
}
type StepNode = Node<StepData, 'step'>;

const number = new Intl.NumberFormat('en-US');

const StepNodeView = memo(function StepNodeView({ data, selected }: NodeProps<StepNode>) {
  const outputs = outputsOf(data.type);
  const hasIssues = data.issues.length > 0;
  return (
    <div
      className={`w-[220px] rounded-card-app border bg-surface px-3 py-2.5 text-left shadow-soft ${
        data.onPath === false ? 'opacity-45 ' : ''
      }${data.onPath === true ? 'ring-2 ring-signal ' : ''}${
        selected
          ? 'border-purple outline-2 outline-offset-2 outline-purple'
          : hasIssues
            ? 'border-danger'
            : 'border-line-app'
      }`}
    >
      {data.type !== 'trigger' && (
        <Handle
          type="target"
          position={Position.Top}
          isConnectable={!data.readOnly}
          className="size-2.5! border-2! border-surface! bg-purple!"
        />
      )}
      <div className="flex items-center gap-2">
        <span
          className={`grid size-7 shrink-0 place-items-center rounded-[9px] ${
            data.type === 'trigger' ? 'bg-purple text-white' : 'bg-lavender text-purple-deep'
          }`}
        >
          <StepIcon type={data.type} size={15} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-semibold text-ink">{data.title}</span>
          <span className="block truncate text-[11.5px] text-sub">{data.summary}</span>
        </span>
      </div>
      {hasIssues && (
        <p className="mt-1.5 line-clamp-2 text-[11.5px] font-semibold text-danger">
          {data.issues[0]!.message}
          {data.issues.length > 1 ? ` (+${data.issues.length - 1})` : ''}
        </p>
      )}
      {data.stats && (
        <dl className="tabular mt-2 grid grid-cols-4 gap-1 border-t border-line pt-1.5 text-center text-[10.5px] text-sub">
          {(
            [
              ['In', data.stats.entered],
              ['Done', data.stats.completed],
              ['Exit', data.stats.exited],
              ['Fail', data.stats.failed],
            ] as const
          ).map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd className="text-[12px] font-semibold text-ink">{number.format(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {outputs.map((label, i) => (
        <Handle
          key={label}
          id={label}
          type="source"
          position={Position.Bottom}
          isConnectable={!data.readOnly}
          style={{ left: `${((i + 1) / (outputs.length + 1)) * 100}%` }}
          className="size-2.5! border-2! border-surface! bg-purple-deep!"
          title={EDGE_LABEL[label]}
        />
      ))}
      {outputs.length > 1 && (
        <div
          className="mt-1 flex justify-around text-[10.5px] font-semibold text-sub"
          aria-hidden="true"
        >
          {outputs.map((label) => (
            <span key={label}>{EDGE_LABEL[label]}</span>
          ))}
        </div>
      )}
    </div>
  );
});

const nodeTypes = { step: StepNodeView };

/** Zoom controls with plain labelled buttons (React Flow's own panel carries a stray aria-label). */
function ZoomButtons() {
  const flow = useReactFlow();
  const button =
    'grid size-8 place-items-center rounded-[8px] border border-line-app bg-surface text-[15px] font-semibold text-ink hover:bg-surface-alt focus-visible:outline-2 focus-visible:outline-purple';
  return (
    <Panel position="bottom-left" className="flex gap-1">
      <button
        type="button"
        className={button}
        aria-label="Zoom in"
        onClick={() => void flow.zoomIn()}
      >
        +
      </button>
      <button
        type="button"
        className={button}
        aria-label="Zoom out"
        onClick={() => void flow.zoomOut()}
      >
        −
      </button>
      <button
        type="button"
        className={`${button} w-auto px-2 text-[12px]`}
        onClick={() => void flow.fitView({ padding: 0.2, maxZoom: 1 })}
      >
        Fit
      </button>
    </Panel>
  );
}

interface CanvasProps {
  graph: WorkingGraph;
  names: Names;
  issues?: Map<string, Issue[]>;
  selectedId?: string | null;
  readOnly: boolean;
  onSelect?: (id: string | null) => void;
  onMove?: (id: string, position: { x: number; y: number }) => void;
  onConnect?: (from: string, label: FlowEdgeLabel, to: string) => void;
  onDeleteRequest?: (id: string) => void;
  onOpenInspector?: (id: string) => void;
  /** Stats mode: numbers on nodes and drop-off heat on edges. */
  stats?: Map<string, NodeStatsOverlay>;
  edgeStats?: Map<string, { runs: number; dropOff: number }>;
  /** A rehearsal's path: its steps and edges stand out, and the rest fades. */
  path?: { nodes: Set<string>; edges: Set<string> } | null;
  label: string;
  height?: number;
}

export const edgeKey = (from: string, label: string) => `${from}\u0000${label}`;

export function FlowCanvas({
  graph,
  names,
  issues,
  selectedId = null,
  readOnly,
  onSelect,
  onMove,
  onConnect,
  onDeleteRequest,
  onOpenInspector,
  stats,
  edgeStats,
  path = null,
  label,
  height = 560,
}: CanvasProps) {
  const built = useMemo<StepNode[]>(
    () =>
      graph.nodes.map((n) => {
        const title = n.name || STEP_INFO[n.type].label;
        const summary = summarize(n, names);
        const nodeIssues = issues?.get(n.id) ?? [];
        const overlay = stats?.get(n.id);
        return {
          id: n.id,
          type: 'step',
          position: n.position ?? { x: 0, y: 0 },
          selected: n.id === selectedId,
          deletable: false,
          draggable: !readOnly,
          ariaRole: 'button',
          ariaLabel: `${title}: ${summary}${nodeIssues.length ? `. ${nodeIssues.length === 1 ? '1 issue' : `${nodeIssues.length} issues`}` : ''}${
            overlay
              ? `. ${overlay.entered} entered, ${overlay.completed} completed, ${overlay.exited} exited, ${overlay.failed} failed`
              : ''
          }${path?.nodes.has(n.id) ? '. On the rehearsal’s path' : ''}`,
          data: {
            type: n.type,
            title,
            summary,
            issues: nodeIssues,
            readOnly,
            ...(overlay ? { stats: overlay } : {}),
            ...(path ? { onPath: path.nodes.has(n.id) } : {}),
          },
        };
      }),
    [graph.nodes, names, issues, selectedId, readOnly, stats, path],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<StepNode>(built);
  useEffect(() => setNodes(built), [built, setNodes]);

  const titleOf = useCallback(
    (id: string) => {
      const n = graph.nodes.find((x) => x.id === id);
      return n ? n.name || STEP_INFO[n.type].label : id;
    },
    [graph.nodes],
  );

  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((e) => {
        const heat = edgeStats?.get(edgeKey(e.from, e.label));
        const onPath = path?.edges.has(edgeKey(e.from, e.label));
        const colour = heat ? heatColour(heat.dropOff) : 'var(--purple)';
        const text =
          e.label === 'default' && !heat
            ? undefined
            : [
                e.label === 'default' ? null : EDGE_LABEL[e.label],
                heat
                  ? `${number.format(heat.runs)} · ${Math.round(heat.dropOff * 100)}% drop`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ');
        return {
          id: `${e.from}-${e.label}-${e.to}`,
          source: e.from,
          sourceHandle: e.label,
          target: e.to,
          type: 'smoothstep',
          focusable: false,
          deletable: false,
          ariaLabel: `${titleOf(e.from)} to ${titleOf(e.to)}${e.label === 'default' ? '' : `, ${EDGE_LABEL[e.label]}`}`,
          ...(text ? { label: text } : {}),
          labelStyle: { fontSize: 11, fontWeight: 600, fill: 'var(--ink)' },
          labelBgStyle: { fill: 'var(--surface)' },
          labelBgPadding: [6, 3] as [number, number],
          labelBgBorderRadius: 6,
          style: {
            stroke: colour,
            strokeWidth: heat ? 2 + heat.dropOff * 3 : onPath ? 3 : 1.75,
            ...(path && !onPath ? { opacity: 0.25 } : {}),
          },
          markerEnd: { type: MarkerType.ArrowClosed, color: colour, width: 16, height: 16 },
        };
      }),
    [graph.edges, edgeStats, titleOf, path],
  );

  const isValidConnection = useCallback(
    (c: Connection | Edge) =>
      !readOnly &&
      !!c.source &&
      !!c.target &&
      connectionProblem(
        graph,
        c.source,
        c.target,
        (c.sourceHandle ?? 'default') as FlowEdgeLabel,
      ) === null,
    [graph, readOnly],
  );

  // Keyboard: a focused step opens in the inspector on Enter and asks to be removed on Delete.
  // A native listener, because React Flow's node wrappers are the focus targets.
  const wrapper = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onSelect, onOpenInspector, onDeleteRequest, readOnly });
  useEffect(() => {
    handlers.current = { onSelect, onOpenInspector, onDeleteRequest, readOnly };
  });
  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const nodeEl = target.closest<HTMLElement>('.react-flow__node');
      const id = nodeEl?.dataset.id;
      if (!id || target !== nodeEl) return;
      const h = handlers.current;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        h.onSelect?.(id);
        h.onOpenInspector?.(id);
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && !h.readOnly) {
        event.preventDefault();
        h.onDeleteRequest?.(id);
      }
    };
    el.addEventListener('keydown', onKeyDown);
    return () => el.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div
      className="flow-canvas overflow-hidden rounded-card-app border border-line-app bg-surface-alt"
      style={{ height }}
      ref={wrapper}
    >
      <ReactFlow<StepNode>
        aria-label={label}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, node) => onSelect?.(node.id)}
        onPaneClick={() => onSelect?.(null)}
        onNodeDragStop={(_, node) => onMove?.(node.id, node.position)}
        onConnect={(c) => {
          if (c.source && c.target) {
            onConnect?.(c.source, (c.sourceHandle ?? 'default') as FlowEdgeLabel, c.target);
          }
        }}
        isValidConnection={isValidConnection}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        nodesFocusable
        edgesFocusable={false}
        elementsSelectable
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.5}
      >
        <Background gap={18} size={1.2} color="#dedbea" />
        <ZoomButtons />
      </ReactFlow>
    </div>
  );
}
