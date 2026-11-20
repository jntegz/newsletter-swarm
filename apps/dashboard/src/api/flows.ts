// Queries and mutations for Flows (Phase 6): the list per Channel, the builder's draft graph,
// Flow emails, publishing and the lifecycle, test runs, runs and stats, the recipe gallery, and
// the Template Library.
import type {
  BulkJob,
  CreateFlow,
  Dispatch,
  DispatchDocument,
  Flow,
  FlowEnrolPreview,
  FlowEnrolStart,
  FlowDraftPending,
  FlowGraph,
  FlowRecipe,
  FlowRehearsalResult,
  FlowRehearse,
  FlowRun,
  FlowRunHold,
  FlowRunStatus,
  FlowStats,
  FlowStatus,
  FlowSummary,
  InboxRuleSettings,
  StarterTemplate,
  StarterTemplateKey,
  StarterTemplateSummary,
  Template,
  TemplateKind,
  TemplateSummary,
  UpdateFlow,
  UpdateInboxRuleSettings,
} from '@swarm/domain';
import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { api } from './client';
import { isFeatureDisabled } from './site';
import { sendKeys } from './send';

export { isFeatureDisabled };

interface FlowRecipeInfo {
  key: FlowRecipe;
  name: string;
  description: string;
  triggerType: string;
  emailCount: number;
}

interface FlowRunStep {
  nodeId: string;
  attempt: number;
  status: 'pending' | 'done' | 'failed' | 'skipped';
  outcome: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}
type FlowRunDetail = FlowRun & { steps: FlowRunStep[]; holds: FlowRunHold[] };
interface FlowRunPage {
  items: FlowRun[];
  nextCursor: string | null;
}
interface PublishFlowResult {
  flow: Flow;
  version: number;
  emails: { nodeId: string; dispatchId: string; broadcastId: string }[];
}

export const flowKeys = {
  list: (channelId: string) => ['channels', channelId, 'flows'] as const,
  flow: (id: string) => ['flows', id] as const,
  emails: (id: string) => ['flows', id, 'emails'] as const,
  runs: (id: string) => ['flows', id, 'runs'] as const,
  run: (id: string, runId: string) => ['flows', id, 'runs', runId] as const,
  stats: (id: string, version: number | null) => ['flows', id, 'stats', { version }] as const,
  inboxRules: (channelId: string) => ['channels', channelId, 'inbox-rules'] as const,
  recipes: ['flow-recipes'] as const,
  templates: (workspaceId: string, channelId: string | null) =>
    ['workspaces', workspaceId, 'templates', { channelId }] as const,
  allTemplates: (workspaceId: string) => ['workspaces', workspaceId, 'templates'] as const,
  template: (id: string) => ['templates', id] as const,
  starterTemplates: (channelId: string) => ['channels', channelId, 'starter-templates'] as const,
};

// ---- Flows -----------------------------------------------------------------------------------

export const flowsQuery = (channelId: string, status?: FlowStatus) =>
  queryOptions({
    queryKey: [...flowKeys.list(channelId), { status }],
    queryFn: ({ signal }) =>
      api.get<FlowSummary[]>(
        `/api/v1/channels/${channelId}/flows${status ? `?status=${status}` : ''}`,
        signal,
      ),
  });

export const flowQuery = (id: string) =>
  queryOptions({
    queryKey: flowKeys.flow(id),
    queryFn: ({ signal }) => api.get<Flow>(`/api/v1/flows/${id}`, signal),
  });

export const flowRecipesQuery = queryOptions({
  queryKey: flowKeys.recipes,
  queryFn: ({ signal }) => api.get<FlowRecipeInfo[]>('/api/v1/flow-recipes', signal),
  staleTime: Infinity,
});

export function useCreateFlow(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateFlow) => api.post<Flow>(`/api/v1/channels/${channelId}/flows`, input),
    onSuccess: (flow) => {
      client.setQueryData(flowKeys.flow(flow.id), flow);
      void client.invalidateQueries({ queryKey: flowKeys.list(channelId) });
    },
  });
}

/** Saves the draft (or name, description, re-entry). The response carries fresh `issues`. */
export function useUpdateFlow(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateFlow) => api.patch<Flow>(`/api/v1/flows/${id}`, input),
    onSuccess: (flow) => {
      client.setQueryData(flowKeys.flow(id), flow);
      void client.invalidateQueries({ queryKey: flowKeys.list(flow.channelId) });
    },
  });
}

/** Saves a draft graph; typed separately so the builder can pass a graph with its positions. */
export const saveDraftGraph = (
  id: string,
  draftGraph: FlowGraph,
  draftPending: FlowDraftPending | null,
) => api.patch<Flow>(`/api/v1/flows/${id}`, { draftGraph, draftPending });

/** A subscriber's page says where they stand in every live Flow, so a change to a Flow changes it. */
const invalidateMemberFlows = (client: QueryClient) =>
  client.invalidateQueries({
    predicate: ({ queryKey }) => queryKey[0] === 'members' && queryKey[2] === 'flows',
  });

function useFlowAction<I, O>(flow: Pick<Flow, 'id' | 'channelId'>, call: (input: I) => Promise<O>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: (result) => {
      const updated =
        result && typeof result === 'object' && 'draftGraph' in result
          ? (result as unknown as Flow)
          : result && typeof result === 'object' && 'flow' in result
            ? (result as unknown as PublishFlowResult).flow
            : null;
      if (updated) client.setQueryData(flowKeys.flow(flow.id), updated);
      void client.invalidateQueries({ queryKey: flowKeys.flow(flow.id) });
      void client.invalidateQueries({ queryKey: flowKeys.list(flow.channelId) });
      void invalidateMemberFlows(client);
    },
  });
}

export const usePublishFlow = (flow: Pick<Flow, 'id' | 'channelId'>) =>
  useFlowAction(flow, (input: { migrateRuns: boolean; resendNodeIds?: string[] }) =>
    api.post<PublishFlowResult>(`/api/v1/flows/${flow.id}/publish`, input),
  );
export const usePauseFlow = (flow: Pick<Flow, 'id' | 'channelId'>) =>
  useFlowAction(flow, () => api.post<Flow>(`/api/v1/flows/${flow.id}/pause`));
export const useResumeFlow = (flow: Pick<Flow, 'id' | 'channelId'>) =>
  useFlowAction(flow, () => api.post<Flow>(`/api/v1/flows/${flow.id}/resume`));
export const useArchiveFlow = (flow: Pick<Flow, 'id' | 'channelId'>) =>
  useFlowAction(flow, () => api.post<Flow>(`/api/v1/flows/${flow.id}/archive`));

export function useDeleteFlow(flow: Pick<Flow, 'id' | 'channelId'>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete(`/api/v1/flows/${flow.id}`),
    onSuccess: () => {
      client.removeQueries({ queryKey: flowKeys.flow(flow.id) });
      void client.invalidateQueries({ queryKey: flowKeys.list(flow.channelId) });
      void invalidateMemberFlows(client);
    },
  });
}

/** Admin only. The secret is returned once and never again. */
export const useRotateWebhookSecret = (flow: Pick<Flow, 'id' | 'channelId'>) =>
  useFlowAction(flow, () =>
    api.post<{ secret: string }>(`/api/v1/flows/${flow.id}/webhook-secret`),
  );

// ---- Inbox rules -----------------------------------------------------------------------------

export const inboxRulesQuery = (channelId: string) =>
  queryOptions({
    queryKey: flowKeys.inboxRules(channelId),
    queryFn: ({ signal }) =>
      api.get<InboxRuleSettings>(`/api/v1/channels/${channelId}/inbox-rules`, signal),
  });

export function useSaveInboxRules(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateInboxRuleSettings) =>
      api.put<InboxRuleSettings>(`/api/v1/channels/${channelId}/inbox-rules`, input),
    onSuccess: (settings) => client.setQueryData(flowKeys.inboxRules(channelId), settings),
  });
}

// ---- Flow emails -----------------------------------------------------------------------------

export function useCreateFlowEmail(flowId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { subject?: string; preheader?: string; content?: DispatchDocument }) =>
      api.post<Dispatch>(`/api/v1/flows/${flowId}/emails`, input),
    onSuccess: (dispatch) => {
      client.setQueryData(sendKeys.dispatch(dispatch.id), dispatch);
      void client.invalidateQueries({ queryKey: flowKeys.emails(flowId) });
      void client.invalidateQueries({ queryKey: flowKeys.flow(flowId) });
    },
  });
}

// ---- Runs and stats --------------------------------------------------------------------------

interface RunFilter {
  status?: FlowRunStatus | undefined;
  version?: number | undefined;
  cursor?: string | null | undefined;
}

export const flowRunsQuery = (id: string, filter: RunFilter = {}) =>
  queryOptions({
    queryKey: [
      ...flowKeys.runs(id),
      { status: filter.status, version: filter.version, cursor: filter.cursor ?? null },
    ],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (filter.status) params.set('status', filter.status);
      if (filter.version) params.set('version', String(filter.version));
      if (filter.cursor) params.set('cursor', filter.cursor);
      return api.get<FlowRunPage>(`/api/v1/flows/${id}/runs?${params}`, signal);
    },
    placeholderData: keepPreviousData,
  });

export const flowRunQuery = (id: string, runId: string) =>
  queryOptions({
    queryKey: flowKeys.run(id, runId),
    queryFn: ({ signal }) => api.get<FlowRunDetail>(`/api/v1/flows/${id}/runs/${runId}`, signal),
    refetchInterval: (query) =>
      query.state.data && ['running', 'waiting'].includes(query.state.data.status) ? 4000 : false,
  });

export function useTestRun(flowId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (memberId: string) =>
      api.post<FlowRun>(`/api/v1/flows/${flowId}/test-run`, { memberId }),
    onSuccess: () => void client.invalidateQueries({ queryKey: flowKeys.runs(flowId) }),
  });
}

/** Asks what would happen. Nothing changes on the server, so nothing here needs refreshing. */
export const useRehearse = (flowId: string) =>
  useMutation({
    mutationFn: (input: FlowRehearse) =>
      api.post<FlowRehearsalResult>(`/api/v1/flows/${flowId}/rehearse`, input),
  });

export const usePreviewPeople = (flowId: string) =>
  useMutation({
    mutationFn: (input: Pick<FlowEnrolStart, 'selection'>) =>
      api.post<FlowEnrolPreview>(`/api/v1/flows/${flowId}/people/preview`, input),
  });

export function useAddPeople(flowId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: FlowEnrolStart) =>
      api.post<BulkJob>(`/api/v1/flows/${flowId}/people`, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: flowKeys.flow(flowId) });
      void invalidateMemberFlows(client);
    },
  });
}

export function useExitRun(flowId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.post<FlowRun>(`/api/v1/flows/${flowId}/runs/${runId}/exit`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: flowKeys.runs(flowId) });
      void client.invalidateQueries({ queryKey: flowKeys.flow(flowId) });
      void invalidateMemberFlows(client);
    },
  });
}

export const flowStatsQuery = (id: string, version: number | null) =>
  queryOptions({
    queryKey: flowKeys.stats(id, version),
    queryFn: ({ signal }) =>
      api.get<FlowStats>(
        `/api/v1/flows/${id}/stats${version ? `?version=${version}` : ''}`,
        signal,
      ),
    placeholderData: keepPreviousData,
  });

// ---- Template Library ------------------------------------------------------------------------

export const templatesQuery = (workspaceId: string, channelId: string | null) =>
  queryOptions({
    queryKey: flowKeys.templates(workspaceId, channelId),
    queryFn: ({ signal }) =>
      api.get<TemplateSummary[]>(
        `/api/v1/workspaces/${workspaceId}/templates${channelId ? `?channelId=${channelId}` : ''}`,
        signal,
      ),
  });

function useTemplateMutation<I, O>(workspaceId: string, call: (input: I) => Promise<O>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: () =>
      void client.invalidateQueries({ queryKey: flowKeys.allTemplates(workspaceId) }),
  });
}

interface CreateTemplateInput {
  channelId: string | null;
  name: string;
  description?: string;
  kind: TemplateKind;
  subject?: string;
  preheader?: string;
  content: DispatchDocument;
}

export const useCreateTemplate = (workspaceId: string) =>
  useTemplateMutation(workspaceId, (input: CreateTemplateInput) =>
    api.post<Template>(`/api/v1/workspaces/${workspaceId}/templates`, input),
  );

export const useImportTemplate = (workspaceId: string) =>
  useTemplateMutation(
    workspaceId,
    (input: { channelId: string | null; name: string; html: string }) =>
      api.post<Template>(`/api/v1/workspaces/${workspaceId}/templates/import`, input),
  );

interface UpdateTemplateInput {
  channelId?: string | null;
  name?: string;
  description?: string | null;
}

export const useUpdateTemplate = (workspaceId: string) =>
  useTemplateMutation(workspaceId, ({ id, ...input }: UpdateTemplateInput & { id: string }) =>
    api.patch<Template>(`/api/v1/templates/${id}`, input),
  );

export const useDeleteTemplate = (workspaceId: string) =>
  useTemplateMutation(workspaceId, (id: string) => api.delete(`/api/v1/templates/${id}`));

/** Starts a draft Dispatch from the template in a Channel. */
export function useUseTemplate() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, channelId }: { id: string; channelId: string }) =>
      api.post<Dispatch>(`/api/v1/templates/${id}/use`, { channelId }),
    onSuccess: (dispatch) => {
      client.setQueryData(sendKeys.dispatch(dispatch.id), dispatch);
      void client.invalidateQueries({ queryKey: sendKeys.dispatches(dispatch.channelId) });
    },
  });
}

// Starter templates ship with Swarm: the same list for every publication, never edited.

export const starterTemplatesQuery = (channelId: string) =>
  queryOptions({
    queryKey: flowKeys.starterTemplates(channelId),
    queryFn: ({ signal }) =>
      api.get<StarterTemplateSummary[]>(`/api/v1/channels/${channelId}/starter-templates`, signal),
    // They change only with a new version of Swarm.
    staleTime: Infinity,
  });

/** One starter with its content and a preview in the publication's email design. */
export const starterTemplateQuery = (channelId: string, key: StarterTemplateKey) =>
  queryOptions({
    queryKey: [...flowKeys.starterTemplates(channelId), key] as const,
    queryFn: ({ signal }) =>
      api.get<StarterTemplate>(`/api/v1/channels/${channelId}/starter-templates/${key}`, signal),
  });

/** Starts a draft Dispatch from a starter template in a Channel. */
export function useUseStarterTemplate() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ key, channelId }: { key: StarterTemplateKey; channelId: string }) =>
      api.post<Dispatch>(`/api/v1/channels/${channelId}/starter-templates/${key}/use`, {}),
    onSuccess: (dispatch) => {
      client.setQueryData(sendKeys.dispatch(dispatch.id), dispatch);
      void client.invalidateQueries({ queryKey: sendKeys.dispatches(dispatch.channelId) });
    },
  });
}

/** The export is an HTML file; the browser downloads it with the session cookie. */
export const templateExportUrl = (id: string) => `/api/v1/templates/${id}/export`;

export const useSaveAsTemplate = (workspaceId: string, dispatchId: string) =>
  useTemplateMutation(
    workspaceId,
    (input: { name: string; description?: string; shared: boolean }) =>
      api.post<Template>(`/api/v1/dispatches/${dispatchId}/save-as-template`, input),
  );
