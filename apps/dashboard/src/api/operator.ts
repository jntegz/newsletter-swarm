// Open Operator (Settings → Developers → Open Operator): MCP settings, the agent log and the
// approval queue. Contract: docs/open-operator.md.
import type {
  AgentAction,
  AgentApproval,
  AgentOutcome,
  AgentSettings,
  ApprovalStatus,
  UpdateAgentSettings,
} from '@swarm/domain';
import { keepPreviousData, queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { verifyChain } from './queries';

const base = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}`;

const operatorKeys = {
  all: (workspaceId: string) => ['workspaces', workspaceId, 'open-operator'] as const,
  settings: (workspaceId: string) => [...operatorKeys.all(workspaceId), 'settings'] as const,
  actions: (workspaceId: string) => [...operatorKeys.all(workspaceId), 'actions'] as const,
  approvals: (workspaceId: string) => [...operatorKeys.all(workspaceId), 'approvals'] as const,
};

export const agentSettingsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: operatorKeys.settings(workspaceId),
    queryFn: ({ signal }) => api.get<AgentSettings>(`${base(workspaceId)}/agent-settings`, signal),
  });

export function useUpdateAgentSettings(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateAgentSettings) =>
      api.put<AgentSettings>(`${base(workspaceId)}/agent-settings`, input),
    onSuccess: (settings) => client.setQueryData(operatorKeys.settings(workspaceId), settings),
  });
}

export const agentActionsQuery = (
  workspaceId: string,
  outcome: AgentOutcome | '',
  cursor: string | null,
) =>
  queryOptions({
    queryKey: [...operatorKeys.actions(workspaceId), outcome, cursor],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ limit: '25' });
      if (outcome) params.set('outcome', outcome);
      if (cursor) params.set('cursor', cursor);
      return api.get<{ items: AgentAction[]; nextCursor: string | null }>(
        `${base(workspaceId)}/agent-actions?${params}`,
        signal,
      );
    },
    placeholderData: keepPreviousData,
  });

export const agentLogVerificationQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: [...operatorKeys.actions(workspaceId), 'verify'],
    queryFn: ({ signal }) => verifyChain(`${base(workspaceId)}/agent-actions/verify`, signal),
  });

export const agentApprovalsQuery = (workspaceId: string, status: ApprovalStatus | 'all') =>
  queryOptions({
    queryKey: [...operatorKeys.approvals(workspaceId), status],
    queryFn: ({ signal }) =>
      api.get<{ items: AgentApproval[]; nextCursor: string | null }>(
        `${base(workspaceId)}/agent-approvals?status=${status}&limit=50`,
        signal,
      ),
  });

export function useDecideApproval(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      decision,
      reason,
    }: {
      id: string;
      decision: 'approve' | 'reject' | 'resolve';
      reason?: string;
    }) =>
      api.post<AgentApproval>(
        `${base(workspaceId)}/agent-approvals/${id}/${decision}`,
        decision === 'reject' ? (reason ? { reason } : {}) : undefined,
      ),
    onSettled: () => client.invalidateQueries({ queryKey: operatorKeys.all(workspaceId) }),
  });
}
