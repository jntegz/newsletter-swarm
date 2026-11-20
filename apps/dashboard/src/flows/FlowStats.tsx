// Flow stats for one version: numbers on each step of the canvas, drop-off heat on its edges, and
// the same figures as tables (so nothing depends on colour or on the canvas).
import type { Flow, FlowEdgeLabel, FlowNodeType, FlowStats } from '@swarm/domain';
import { EmptyState, ErrorNotice, LoadingRows } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { SelectField } from './Select';
import { flowStatsQuery } from '../api/flows';
import { numberFormat, percentFormat } from '../pages/common';
import { FlowCanvas, edgeKey, type NodeStatsOverlay } from './Canvas';
import { EDGE_LABEL, STEP_INFO, heatColour, withPositions, type WorkingGraph } from './graph';
import type { Lookups } from './lookups';
import { summarize } from './summary';

/** The version's graph, from the stats (ids, types, edges) with names and positions from the draft. */
function statsGraph(stats: FlowStats, draft: Flow['draftGraph']): WorkingGraph {
  const draftById = new Map(draft.nodes.map((n) => [n.id, n]));
  const nodes = stats.nodes.map((s) => {
    const d = draftById.get(s.nodeId);
    const same = d && d.type === s.type;
    return {
      id: s.nodeId,
      type: s.type as FlowNodeType,
      config: same ? { ...d.config } : {},
      ...(same && d.position ? { position: d.position } : {}),
      ...(same && d.name ? { name: d.name } : {}),
    };
  });
  return withPositions({
    nodes,
    edges: stats.edges.map((e) => ({ from: e.from, to: e.to, label: e.label as FlowEdgeLabel })),
  });
}

export function FlowStatsView({ flow, lookups }: { flow: Flow; lookups: Lookups }) {
  const versions = flow.versions;
  const [version, setVersion] = useState<number | null>(
    flow.liveVersion ?? versions[0]?.version ?? null,
  );
  const stats = useQuery({ ...flowStatsQuery(flow.id, version), enabled: versions.length > 0 });

  const graph = useMemo(
    () => (stats.data ? statsGraph(stats.data, flow.draftGraph) : null),
    [stats.data, flow.draftGraph],
  );
  const overlay = useMemo(
    () =>
      new Map<string, NodeStatsOverlay>(
        (stats.data?.nodes ?? []).map((n) => [n.nodeId, n] as const),
      ),
    [stats.data],
  );
  const edgeStats = useMemo(
    () => new Map((stats.data?.edges ?? []).map((e) => [edgeKey(e.from, e.label), e] as const)),
    [stats.data],
  );

  if (versions.length === 0) {
    return (
      <EmptyState title="No stats yet">
        Publish the automation to see how many subscribers reach each step and where they drop off.
      </EmptyState>
    );
  }

  const title = (id: string) => {
    const n = graph?.nodes.find((x) => x.id === id);
    return n ? n.name || STEP_INFO[n.type].label : id;
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="w-48">
          <SelectField
            label="Version"
            value={String(version ?? '')}
            onChange={(e) => setVersion(Number(e.target.value))}
          >
            {versions.map((v) => (
              <option key={v.version} value={v.version}>
                Version {v.version}
                {v.version === flow.liveVersion ? ' (live)' : v.retiredAt ? ' (retired)' : ''}
              </option>
            ))}
          </SelectField>
        </div>
        <HeatLegend />
      </div>
      {stats.isPending && <LoadingRows label="Loading stats" rows={4} />}
      {stats.error && <ErrorNotice message={stats.error.message} />}
      {stats.data && graph && (
        <>
          <FlowCanvas
            graph={graph}
            names={lookups.names}
            readOnly
            stats={overlay}
            edgeStats={edgeStats}
            label={`Version ${stats.data.version} with the number of runs at each step`}
            height={480}
          />
          <p className="text-[12px] text-sub">Test runs are left out of these numbers.</p>
          {stats.data.triggers.length > 1 && (
            <div className="card-app overflow-x-auto">
              <table className="w-full min-w-[420px] text-left text-[13px]">
                <caption className="px-5 pt-4 text-left text-[15px] font-semibold">
                  Start events
                </caption>
                <thead>
                  <tr className="table-head">
                    <th scope="col" className="px-5 py-3 font-semibold">
                      Start event
                    </th>
                    <th scope="col" className="px-5 py-3 text-right font-semibold">
                      Runs started
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {stats.data.triggers.map((t) => (
                    <tr key={t.index} className="border-t border-line">
                      <th scope="row" className="px-5 py-3 font-semibold">
                        {summarize(
                          { id: 'trigger', type: 'trigger', config: t.config },
                          lookups.names,
                        )}
                      </th>
                      <td className="tabular px-5 py-3 text-right">
                        {numberFormat.format(t.runs)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="card-app overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-[13px]">
              <caption className="px-5 pt-4 text-left text-[15px] font-semibold">Steps</caption>
              <thead>
                <tr className="table-head">
                  <th scope="col" className="px-5 py-3 font-semibold">
                    Step
                  </th>
                  <th scope="col" className="px-3 py-3 text-right font-semibold">
                    Entered
                  </th>
                  <th scope="col" className="px-3 py-3 text-right font-semibold">
                    Completed
                  </th>
                  <th scope="col" className="px-3 py-3 text-right font-semibold">
                    Exited
                  </th>
                  <th scope="col" className="px-3 py-3 text-right font-semibold">
                    Failed
                  </th>
                  <th scope="col" className="px-3 py-3 text-right font-semibold">
                    Delivered
                  </th>
                  <th scope="col" className="px-3 py-3 text-right font-semibold">
                    Open rate
                  </th>
                  <th scope="col" className="px-5 py-3 text-right font-semibold">
                    Clicks
                  </th>
                </tr>
              </thead>
              <tbody>
                {stats.data.nodes.map((n) => (
                  <tr key={n.nodeId} className="border-t border-line">
                    <th scope="row" className="px-5 py-3 font-semibold">
                      {title(n.nodeId)}
                    </th>
                    <td className="tabular px-3 py-3 text-right">
                      {numberFormat.format(n.entered)}
                    </td>
                    <td className="tabular px-3 py-3 text-right">
                      {numberFormat.format(n.completed)}
                    </td>
                    <td className="tabular px-3 py-3 text-right">
                      {numberFormat.format(n.exited)}
                    </td>
                    <td className="tabular px-3 py-3 text-right">
                      {numberFormat.format(n.failed)}
                    </td>
                    <td className="tabular px-3 py-3 text-right">
                      {n.email ? numberFormat.format(n.email.delivered) : '—'}
                    </td>
                    <td className="tabular px-3 py-3 text-right">
                      {n.email ? percentFormat.format(n.email.openRate) : '—'}
                    </td>
                    <td className="tabular px-5 py-3 text-right">
                      {n.email ? numberFormat.format(n.email.humanClicks) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <HeldTable stats={stats.data} title={title} />
          {stats.data.edges.length > 0 && (
            <div className="card-app overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-[13px]">
                <caption className="px-5 pt-4 text-left text-[15px] font-semibold">
                  Paths and drop-off
                </caption>
                <thead>
                  <tr className="table-head">
                    <th scope="col" className="px-5 py-3 font-semibold">
                      From
                    </th>
                    <th scope="col" className="px-3 py-3 font-semibold">
                      Outcome
                    </th>
                    <th scope="col" className="px-3 py-3 font-semibold">
                      To
                    </th>
                    <th scope="col" className="px-3 py-3 text-right font-semibold">
                      Runs
                    </th>
                    <th scope="col" className="px-5 py-3 text-right font-semibold">
                      Drop-off
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {stats.data.edges.map((e) => (
                    <tr key={`${e.from}-${e.label}`} className="border-t border-line">
                      <td className="px-5 py-3">{title(e.from)}</td>
                      <td className="px-3 py-3 text-sub">
                        {EDGE_LABEL[e.label as FlowEdgeLabel] ?? e.label}
                      </td>
                      <td className="px-3 py-3">{title(e.to)}</td>
                      <td className="tabular px-3 py-3 text-right">
                        {numberFormat.format(e.runs)}
                      </td>
                      <td className="tabular px-5 py-3 text-right">
                        <span className="inline-flex items-center gap-2">
                          <span
                            aria-hidden="true"
                            className="inline-block size-2.5 rounded-pill"
                            style={{ background: heatColour(e.dropOff) }}
                          />
                          {percentFormat.format(e.dropOff)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** What the publication's inbox rules did to this version's emails. */
function HeldTable({ stats, title }: { stats: FlowStats; title: (id: string) => string }) {
  const held = stats.nodes.filter((n) => n.held.total > 0);
  if (!held.length) {
    return (
      <p className="text-[13px] text-sub">Inbox rules have not held any email of this version.</p>
    );
  }
  return (
    <div className="card-app overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-[13px]">
        <caption className="px-5 pt-4 text-left text-[15px] font-semibold">
          Held by inbox rules
        </caption>
        <thead>
          <tr className="table-head">
            <th scope="col" className="px-5 py-3 font-semibold">
              Step
            </th>
            <th scope="col" className="px-3 py-3 text-right font-semibold">
              Waiting now
            </th>
            <th scope="col" className="px-3 py-3 text-right font-semibold">
              Held in total
            </th>
            <th scope="col" className="px-5 py-3 text-right font-semibold">
              Held too long
            </th>
          </tr>
        </thead>
        <tbody>
          {held.map((n) => (
            <tr key={n.nodeId} className="border-t border-line">
              <th scope="row" className="px-5 py-3 font-semibold">
                {title(n.nodeId)}
              </th>
              <td className="tabular px-3 py-3 text-right">{numberFormat.format(n.held.now)}</td>
              <td className="tabular px-3 py-3 text-right">{numberFormat.format(n.held.total)}</td>
              <td className="tabular px-5 py-3 text-right">
                {numberFormat.format(n.held.expired)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HeatLegend() {
  return (
    <div className="flex items-center gap-3 text-[12px] text-sub">
      <span>Edge colour shows drop-off:</span>
      {[
        [0, 'none'],
        [0.5, 'half'],
        [1, 'all'],
      ].map(([value, label]) => (
        <span key={label} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block h-1 w-5 rounded-pill"
            style={{ background: heatColour(value as number) }}
          />
          {label}
        </span>
      ))}
    </div>
  );
}
