// Email checks with DeBounce (docs/email-verification.md): the install's status for instance
// admins, a workspace's rules, checks of a list, a publication's results and one subscriber's.
import type {
  CreateEmailCheckRun,
  EmailCheckRedActionInput,
  EmailCheckRedResult,
  EmailCheckRun,
  EmailCheckSettings,
  EmailCheckStatus,
  EmailCheckSummary,
  ImportJob,
  InstanceEmailChecks,
  MemberEmailCheck,
} from '@swarm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { memberKeys } from './members';

const emailCheckKeys = {
  instance: ['instance', 'email-checks'] as const,
  status: (workspaceId: string) => ['workspaces', workspaceId, 'email-checks'] as const,
  run: (runId: string) => ['email-check-runs', runId] as const,
  summary: (channelId: string) => ['channels', channelId, 'email-checks'] as const,
  member: (memberId: string) => ['members', memberId, 'email-check'] as const,
};

/** A run that may still change. */
const RUN_MOVING = new Set(['planning', 'running', 'stopping']);

export const instanceEmailChecksQuery = (enabled: boolean) =>
  queryOptions({
    queryKey: emailCheckKeys.instance,
    queryFn: ({ signal }) => api.get<InstanceEmailChecks>('/api/v1/instance/email-checks', signal),
    enabled,
  });

export const emailCheckStatusQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: emailCheckKeys.status(workspaceId),
    queryFn: ({ signal }) =>
      api.get<EmailCheckStatus>(`/api/v1/workspaces/${workspaceId}/email-checks`, signal),
  });

export const emailCheckSummaryQuery = (channelId: string, enabled = true) =>
  queryOptions({
    queryKey: emailCheckKeys.summary(channelId),
    queryFn: ({ signal }) =>
      api.get<EmailCheckSummary>(`/api/v1/channels/${channelId}/email-checks`, signal),
    enabled,
    refetchInterval: (query) =>
      query.state.data?.run && RUN_MOVING.has(query.state.data.run.status) ? 5000 : false,
  });

export const emailCheckRunQuery = (workspaceId: string, runId: string | null) =>
  queryOptions({
    queryKey: emailCheckKeys.run(runId ?? ''),
    queryFn: ({ signal }) =>
      api.get<EmailCheckRun>(
        `/api/v1/workspaces/${workspaceId}/email-checks/runs/${runId}`,
        signal,
      ),
    enabled: !!runId,
    refetchInterval: (query) =>
      query.state.data && RUN_MOVING.has(query.state.data.status) ? 2500 : false,
  });

export const memberEmailCheckQuery = (memberId: string) =>
  queryOptions({
    queryKey: emailCheckKeys.member(memberId),
    queryFn: ({ signal }) =>
      api.get<{ available: boolean; check: MemberEmailCheck | null }>(
        `/api/v1/members/${memberId}/email-check`,
        signal,
      ),
  });

export function useSaveEmailCheckSettings(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (settings: EmailCheckSettings) =>
      api.put<EmailCheckStatus>(
        `/api/v1/workspaces/${workspaceId}/email-checks/settings`,
        settings,
      ),
    onSuccess: (data) => client.setQueryData(emailCheckKeys.status(workspaceId), data),
  });
}

export function useInstanceEmailChecks() {
  const client = useQueryClient();
  const done = (data: InstanceEmailChecks) => {
    client.setQueryData(emailCheckKeys.instance, data);
    void client.invalidateQueries({ queryKey: ['workspaces'] });
  };
  return {
    everyWorkspace: useMutation({
      mutationFn: (everyWorkspace: boolean) =>
        api.put<InstanceEmailChecks>('/api/v1/instance/email-checks', { everyWorkspace }),
      onSuccess: done,
    }),
    workspace: useMutation({
      mutationFn: ({ id, allowed }: { id: string; allowed: boolean }) =>
        api.put<InstanceEmailChecks>(`/api/v1/instance/email-checks/workspaces/${id}`, { allowed }),
      onSuccess: done,
    }),
    /** A workspace's single checks per day and list checks per month; null: the default. */
    budget: useMutation({
      mutationFn: ({
        id,
        ...body
      }: {
        id: string;
        allowed: boolean;
        dailyChecks: number | null;
        listChecks: number | null;
      }) => api.put<InstanceEmailChecks>(`/api/v1/instance/email-checks/workspaces/${id}`, body),
      onSuccess: done,
    }),
  };
}

function useRunChange<I>(workspaceId: string, call: (input: I) => Promise<EmailCheckRun>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: (run) => {
      client.setQueryData(emailCheckKeys.run(run.id), run);
      void client.invalidateQueries({
        predicate: (q) => q.queryKey[0] === 'channels' && q.queryKey[2] === 'email-checks',
      });
    },
  });
}

export const usePlanEmailCheck = (workspaceId: string) =>
  useRunChange(workspaceId, (input: CreateEmailCheckRun) =>
    api.post<EmailCheckRun>(`/api/v1/workspaces/${workspaceId}/email-checks/runs`, input),
  );

export const useRunAction = (workspaceId: string) =>
  useRunChange(workspaceId, ({ id, action }: { id: string; action: 'start' | 'stop' | 'resume' }) =>
    api.post<EmailCheckRun>(`/api/v1/workspaces/${workspaceId}/email-checks/runs/${id}/${action}`),
  );

export function useRedAction(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: EmailCheckRedActionInput) =>
      api.post<EmailCheckRedResult>(`/api/v1/channels/${channelId}/email-checks/red`, input),
    onSuccess: (_data, input) => {
      if (!input.confirm) return;
      void client.invalidateQueries({ queryKey: memberKeys.list(channelId) });
      void client.invalidateQueries({ queryKey: emailCheckKeys.summary(channelId) });
    },
  });
}

export function useCheckMemberAgain(memberId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>(`/api/v1/members/${memberId}/email-check`),
    onSuccess: () => {
      // The check runs in the background; look again in a few seconds.
      setTimeout(
        () => void client.invalidateQueries({ queryKey: emailCheckKeys.member(memberId) }),
        4000,
      );
    },
  });
}

export function useImportEmailCheck(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, checkAddresses }: { id: string; checkAddresses: boolean }) =>
      api.put<ImportJob>(`/api/v1/imports/${id}/email-check`, { checkAddresses }),
    onSuccess: (job) => {
      client.setQueryData(memberKeys.import(job.id), job);
      void client.invalidateQueries({ queryKey: memberKeys.imports(channelId) });
    },
  });
}

/** An import's own check; polled while it moves. */
export const importEmailCheckQuery = (importId: string, enabled: boolean) =>
  queryOptions({
    queryKey: ['imports', importId, 'email-check'] as const,
    queryFn: ({ signal }) =>
      api.get<EmailCheckRun | null>(`/api/v1/imports/${importId}/email-check`, signal),
    enabled,
    refetchInterval: (query) =>
      query.state.data && query.state.data.status !== 'completed' ? 3000 : false,
  });

export function useImportCheckAction(importId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (action: 'resume' | 'stop') =>
      api.post<EmailCheckRun>(`/api/v1/imports/${importId}/email-check/${action}`),
    onSuccess: (run) => client.setQueryData(['imports', importId, 'email-check'], run),
  });
}
