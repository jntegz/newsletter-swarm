// What a Flow's steps can refer to (tags, fields, levels, forms, Circles, Flows, Asks,
// Dispatches, Flow emails, teammates, Rosters), loaded once for the pickers and the canvas
// summaries.
import type {
  Ask,
  CaptureForm,
  ChampionMilestone,
  Circle,
  DispatchSummary,
  Flow,
  FlowSummary,
  MemberField,
  MembershipLevel,
  Roster,
  Seat,
  Tag,
} from '@swarm/domain';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { allCirclesQuery, memberFieldsQuery, tagsQuery } from '../api/circles';
import { captureFormsQuery } from '../api/capture';
import { api } from '../api/client';
import { flowsQuery } from '../api/flows';
import { championMilestonesQuery } from '../api/growth';
import { levelsQuery } from '../api/money';
import { seatsQuery, useChannelFlag } from '../api/queries';
import { rostersQuery } from '../api/rosters';
import { dispatchesQuery } from '../api/send';
import type { Names } from './summary';

/** Asks for the trigger picker (its own key: the Ask pages may cache a different shape). */
const asksForFlowsQuery = (channelId: string) =>
  queryOptions({
    queryKey: ['channels', channelId, 'flow-pickers', 'asks'],
    queryFn: ({ signal }) => api.get<Ask[]>(`/api/v1/channels/${channelId}/asks`, signal),
    staleTime: 30_000,
  });

export interface Lookups {
  tags: Tag[];
  fields: MemberField[];
  levels: MembershipLevel[];
  forms: CaptureForm[];
  circles: Circle[];
  flows: FlowSummary[];
  asks: Ask[];
  dispatches: DispatchSummary[];
  seats: Seat[];
  emails: Flow['emails'];
  /** Empty while the rosters flag is off; the Roster triggers are offered only when it is on. */
  rosters: Roster[];
  rostersOn: boolean;
  engagementScores: boolean;
  milestones: ChampionMilestone[];
  names: Names;
}

const byId = <T extends { id: string }>(list: readonly T[], label: (item: T) => string) => {
  const map = new Map(list.map((item) => [item.id, label(item)]));
  return (id: string) => map.get(id);
};

export function useLookups(channelId: string, workspaceId: string, flow: Flow): Lookups {
  const tags = useQuery(tagsQuery(channelId)).data;
  const fields = useQuery(memberFieldsQuery(channelId)).data;
  const levels = useQuery({ ...levelsQuery(channelId), retry: false }).data;
  const forms = useQuery({ ...captureFormsQuery(channelId), retry: false }).data;
  const circles = useQuery({ ...allCirclesQuery(channelId), retry: false }).data;
  const flows = useQuery(flowsQuery(channelId)).data;
  const asks = useQuery({ ...asksForFlowsQuery(channelId), retry: false }).data;
  const dispatches = useQuery({ ...dispatchesQuery(channelId), retry: false }).data;
  const seats = useQuery({ ...seatsQuery(workspaceId), retry: false }).data;
  const emails = flow.emails;
  const rostersOn = useChannelFlag(channelId, 'rosters') === true;
  const rosters = useQuery({ ...rostersQuery(channelId, rostersOn), retry: false }).data;
  const engagementScores = useChannelFlag(channelId, 'engagement_scores') === true;
  const milestones = useQuery({ ...championMilestonesQuery(channelId), retry: false }).data;

  return useMemo(() => {
    const list = {
      tags: tags ?? [],
      fields: fields ?? [],
      levels: levels?.items ?? [],
      forms: forms ?? [],
      circles: circles ?? [],
      flows: (flows ?? []).filter((f) => f.id !== flow.id),
      asks: asks ?? [],
      dispatches: dispatches ?? [],
      seats: seats ?? [],
      emails,
      rosters: rostersOn ? (rosters ?? []) : [],
      rostersOn,
      engagementScores,
      milestones: milestones ?? [],
    };
    const emailMap = new Map(emails.map((e) => [e.dispatchId, e.subject]));
    const names: Names = {
      tag: byId(list.tags, (t) => t.name),
      field: byId(list.fields, (f) => f.label || f.key),
      level: byId(list.levels, (l) => l.name),
      form: byId(list.forms, (f) => f.name),
      circle: byId(list.circles, (c) => c.name),
      flow: byId(flows ?? [], (f) => f.name),
      ask: byId(list.asks, (a) => a.title),
      dispatch: byId(list.dispatches, (d) => d.subject || 'Untitled post'),
      email: (id) => emailMap.get(id),
      roster: byId(list.rosters, (r) => r.name),
      milestone: byId(list.milestones, (m) => m.name),
    };
    return { ...list, names };
  }, [
    tags,
    fields,
    levels,
    forms,
    circles,
    flows,
    asks,
    dispatches,
    seats,
    emails,
    rosters,
    rostersOn,
    engagementScores,
    milestones,
    flow.id,
  ]);
}
