// Queries and mutations for Phase 2: Dispatches, Broadcasts and Settings → Sending.
// Members live in ./members.
import type {
  ArchiveResult,
  Broadcast,
  BroadcastProgress,
  BroadcastReport,
  BroadcastClickMap,
  BroadcastStats,
  ChannelOverview,
  CreateDispatch,
  CheckedSendingDomain,
  CreateSenderIdentity,
  CreateSendingDomain,
  EmailCss,
  Dispatch,
  DispatchCounts,
  DispatchListItem,
  DispatchListStatus,
  DispatchRevision,
  DispatchRevisionDetail,
  DispatchStartedBy,
  DispatchSummary,
  Preflight,
  Ramp,
  RestartRamp,
  SenderIdentity,
  SendingDomain,
  TestSend,
  UpdateDispatch,
  SkipRamp,
  UpdateRamp,
} from '@swarm/domain';
import { keepPreviousData, queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { fitsKeepalive } from '../editor/saveQueue';
import { api, request } from './client';
import { flowKeys } from './flows';

export const sendKeys = {
  dispatches: (channelId: string) => ['channels', channelId, 'dispatches'] as const,
  dispatch: (id: string) => ['dispatches', id] as const,
  revisions: (id: string) => ['dispatches', id, 'revisions'] as const,
  preflight: (id: string) => ['dispatches', id, 'preflight'] as const,
  broadcasts: (channelId: string) => ['channels', channelId, 'broadcasts'] as const,
  broadcast: (id: string) => ['broadcasts', id] as const,
  domains: (channelId: string) => ['channels', channelId, 'sending-domains'] as const,
  senders: (channelId: string) => ['channels', channelId, 'sender-identities'] as const,
  ramps: (channelId: string) => ['channels', channelId, 'ramps'] as const,
  overview: (channelId: string) => ['channels', channelId, 'overview'] as const,
  emailCss: (channelId: string) => ['channels', channelId, 'email-css'] as const,
};

// ---- Dispatches ------------------------------------------------------------------------------

export const dispatchesQuery = (channelId: string) =>
  queryOptions({
    queryKey: sendKeys.dispatches(channelId),
    queryFn: ({ signal }) =>
      api.get<DispatchSummary[]>(`/api/v1/channels/${channelId}/dispatches`, signal),
  });

/** What the posts list asks for: the archive or the rest, a status chip, a search and Started by. */
export interface PostListFilter {
  archived: 'exclude' | 'only';
  status?: DispatchListStatus | undefined;
  q?: string | undefined;
  startedBy?: DispatchStartedBy | undefined;
}

const listParams = (values: Record<string, string | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value);
  const text = params.toString();
  return text ? `?${text}` : '';
};

/** The posts list, with who started each post and how its latest send did. */
export const postListQuery = (channelId: string, filter: PostListFilter) =>
  queryOptions({
    queryKey: [...sendKeys.dispatches(channelId), 'list', filter],
    queryFn: ({ signal }) =>
      api.get<DispatchListItem[]>(
        `/api/v1/channels/${channelId}/dispatches${listParams({ ...filter, stats: 'latest' })}`,
        signal,
      ),
    // A new search keeps the rows on screen until its answer comes, so the table doesn't flicker.
    placeholderData: keepPreviousData,
  });

/** How many posts each status chip holds, for the same search and Started by. */
export const postCountsQuery = (
  channelId: string,
  filter: Pick<PostListFilter, 'q' | 'startedBy'>,
) =>
  queryOptions({
    queryKey: [...sendKeys.dispatches(channelId), 'counts', filter],
    queryFn: ({ signal }) =>
      api.get<DispatchCounts>(
        `/api/v1/channels/${channelId}/dispatches/counts${listParams(filter)}`,
        signal,
      ),
    placeholderData: keepPreviousData,
  });

/** The posts on a range of days, for the calendar. */
export const calendarQuery = (channelId: string, from: string, to: string) =>
  queryOptions({
    queryKey: [...sendKeys.dispatches(channelId), 'calendar', from, to],
    queryFn: ({ signal }) =>
      api.get<DispatchSummary[]>(
        `/api/v1/channels/${channelId}/dispatches/calendar?from=${from}&to=${to}`,
        signal,
      ),
  });

export const dispatchQuery = (id: string) =>
  queryOptions({
    queryKey: sendKeys.dispatch(id),
    queryFn: ({ signal }) => api.get<Dispatch>(`/api/v1/dispatches/${id}`, signal),
  });

export const revisionsQuery = (id: string) =>
  queryOptions({
    queryKey: sendKeys.revisions(id),
    queryFn: ({ signal }) =>
      api.get<DispatchRevision[]>(`/api/v1/dispatches/${id}/revisions`, signal),
  });

export const revisionQuery = (id: string, revisionId: string) =>
  queryOptions({
    queryKey: [...sendKeys.revisions(id), revisionId],
    queryFn: ({ signal }) =>
      api.get<DispatchRevisionDetail>(`/api/v1/dispatches/${id}/revisions/${revisionId}`, signal),
  });

export const preflightQuery = (id: string) =>
  queryOptions({
    queryKey: sendKeys.preflight(id),
    queryFn: ({ signal }) => api.get<Preflight>(`/api/v1/dispatches/${id}/preflight`, signal),
    staleTime: 0,
  });

export function useCreateDispatch(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDispatch) =>
      api.post<Dispatch>(`/api/v1/channels/${channelId}/dispatches`, input),
    onSuccess: (dispatch) => {
      client.setQueryData(sendKeys.dispatch(dispatch.id), dispatch);
      void client.invalidateQueries({ queryKey: sendKeys.dispatches(channelId) });
    },
  });
}

/**
 * Sets or clears a draft's planned date. The calendar moves at once and the server's answer settles
 * it; an open editor's document is left alone, so it never jumps under the cursor.
 */
export function useSetPlannedDate(channelId: string) {
  const client = useQueryClient();
  const calendars = [...sendKeys.dispatches(channelId), 'calendar'];
  return useMutation({
    mutationFn: ({ id, plannedDate }: { id: string; plannedDate: string | null }) =>
      api.put<DispatchSummary>(`/api/v1/dispatches/${id}/planned-date`, { plannedDate }),
    onMutate: async ({ id, plannedDate }) => {
      await client.cancelQueries({ queryKey: calendars });
      client.setQueriesData<DispatchSummary[]>({ queryKey: calendars }, (list) =>
        list?.map((post) => (post.id === id ? { ...post, plannedDate } : post)),
      );
    },
    onSuccess: (post) => {
      client.setQueryData<Dispatch>(
        sendKeys.dispatch(post.id),
        (old) => old && { ...old, plannedDate: post.plannedDate },
      );
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: sendKeys.dispatches(channelId) });
    },
  });
}

/** Moves posts in or out of the archive. An open editor's document is left alone. */
export function useArchivePosts(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ action, ids }: { action: 'archive' | 'restore'; ids: string[] }) =>
      api.post<ArchiveResult>(`/api/v1/channels/${channelId}/dispatches/${action}`, {
        dispatchIds: ids,
      }),
    onSuccess: (result, { action }) => {
      const archivedAt = action === 'archive' ? new Date().toISOString() : null;
      for (const id of result.changed) {
        client.setQueryData<Dispatch>(
          sendKeys.dispatch(id),
          (old) => old && { ...old, archivedAt },
        );
      }
      void client.invalidateQueries({ queryKey: sendKeys.dispatches(channelId) });
    },
  });
}

/** Saves without refetching the document, so the editor never jumps under the cursor. */
/**
 * Sends a save as the page closes. Best effort: the answer never reaches this page, and a post too
 * big for a keepalive request stays unsent, which is why the page warns before it closes.
 */
export function saveDispatchOnLeave(id: string, input: UpdateDispatch): boolean {
  if (!fitsKeepalive(JSON.stringify(input))) return false;
  void request('PATCH', `/api/v1/dispatches/${id}`, { json: input, keepalive: true }).catch(
    () => undefined,
  );
  return true;
}

export function useSaveDispatch(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateDispatch) => api.patch<Dispatch>(`/api/v1/dispatches/${id}`, input),
    onSuccess: (dispatch) => {
      // Saves overlap: the editor autosaves while the send route saves the audience, each with its
      // own mutation. An older answer arriving last must not put back what a newer save changed:
      // the page would lose the audience, and the next change would save that loss for real.
      client.setQueryData<Dispatch>(sendKeys.dispatch(id), (current) =>
        current && Date.parse(current.updatedAt) > Date.parse(dispatch.updatedAt)
          ? current
          : dispatch,
      );
      void client.invalidateQueries({ queryKey: sendKeys.revisions(id) });
      void client.invalidateQueries({ queryKey: sendKeys.preflight(id) });
      void client.invalidateQueries({ queryKey: sendKeys.dispatches(dispatch.channelId) });
      // An automation's canvas shows its emails' subjects.
      if (dispatch.flowId) {
        void client.invalidateQueries({ queryKey: flowKeys.flow(dispatch.flowId) });
      }
    },
  });
}

function useDispatchAction<I, O>(id: string, call: (input: I) => Promise<O>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['dispatches', id] });
      void client.invalidateQueries({ queryKey: ['channels'] });
    },
  });
}

export const useNameRevision = (id: string) =>
  useDispatchAction(id, (name: string) =>
    api.post<DispatchRevision>(`/api/v1/dispatches/${id}/revisions`, { name }),
  );

export const useRestoreRevision = (id: string) =>
  useDispatchAction(id, (revisionId: string) =>
    api.post<Dispatch>(`/api/v1/dispatches/${id}/revisions/${revisionId}/restore`),
  );

export const useTestSend = (id: string) =>
  useMutation({
    mutationFn: (input: TestSend) =>
      api.post<{ sentTo: string[] }>(`/api/v1/dispatches/${id}/test`, input),
  });

export const useSchedule = (id: string) =>
  // A bare time moves the send and keeps its best-time choice.
  useDispatchAction(id, (input: string | { publishAt: string; bestTime: boolean }) =>
    api.post<Dispatch>(
      `/api/v1/dispatches/${id}/schedule`,
      typeof input === 'string' ? { publishAt: input } : input,
    ),
  );

export const useUnschedule = (id: string) =>
  useDispatchAction(id, () => api.delete<Dispatch>(`/api/v1/dispatches/${id}/schedule`));

export const useSendNow = (id: string) =>
  useDispatchAction(id, (input?: { bestTime: boolean }) =>
    api.post<{ broadcastId: string }>(`/api/v1/dispatches/${id}/send`, input),
  );

export const useDeleteDispatch = (id: string) =>
  useDispatchAction(id, () => api.delete(`/api/v1/dispatches/${id}`));

// ---- Broadcasts ------------------------------------------------------------------------------

const LIVE = new Set(['queued', 'sending']);
/**
 * Polls every 2 seconds while the Broadcast is live. With the send monitor socket open, polling
 * drops to a 30-second safety net.
 */
export const broadcastQuery = (id: string, streaming = false) =>
  queryOptions({
    queryKey: sendKeys.broadcast(id),
    queryFn: ({ signal }) => api.get<BroadcastReport>(`/api/v1/broadcasts/${id}`, signal),
    refetchInterval: (query) =>
      query.state.data && LIVE.has(query.state.data.status) ? (streaming ? 30_000 : 2000) : false,
  });

/**
 * Subscribes to the Broadcast's send monitor while it is live, merging each update into the
 * cached Broadcast. Returns whether the socket is open; when it isn't, polling carries on.
 */
export function useLiveBroadcast(id: string, live: boolean): boolean {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  // The monitor closes a socket every few minutes (4001) so access is checked again on the way
  // back in; reconnecting goes through the api worker's checks.
  const [connection, setConnection] = useState(0);
  useEffect(() => {
    if (!live || typeof WebSocket === 'undefined') return;
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/api/v1/broadcasts/${id}/live`);
    let statsRefreshedAt = 0;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    socket.onopen = () => setOpen(true);
    socket.onclose = (event) => {
      setOpen(false);
      if (event.code === 4001) reconnect = setTimeout(() => setConnection((n) => n + 1), 1000);
    };
    socket.onmessage = (event) => {
      let progress: BroadcastProgress;
      try {
        progress = JSON.parse(String(event.data)) as BroadcastProgress;
      } catch {
        return;
      }
      if (progress.broadcastId !== id) return;
      const { status, recipientCount, sentCount, failedCount, completedAt, waiting } = progress;
      // The first count of who is sent what comes with the move out of queued, and isn't pushed.
      const before = client.getQueryData<BroadcastReport>(sendKeys.broadcast(id))?.status;
      if (before === 'queued' && status !== 'queued') {
        void client.invalidateQueries({ queryKey: sendKeys.broadcast(id) });
      }
      // A monitor deployed before sending limits sends no `waiting`; the poll fills it in.
      client.setQueryData<BroadcastReport>(sendKeys.broadcast(id), (old) =>
        old
          ? {
              ...old,
              status,
              recipientCount,
              sentCount,
              failedCount,
              completedAt,
              ...(waiting !== undefined ? { waiting } : {}),
            }
          : old,
      );
      // Engagement comes from other workers, so stats are refetched rather than pushed.
      if (Date.now() - statsRefreshedAt > 3000 || !LIVE.has(status)) {
        statsRefreshedAt = Date.now();
        void client.invalidateQueries({ queryKey: [...sendKeys.broadcast(id), 'stats'] });
      }
      if (!LIVE.has(status)) void client.invalidateQueries({ queryKey: sendKeys.broadcast(id) });
    };
    return () => {
      clearTimeout(reconnect);
      socket.onclose = null;
      socket.close();
      setOpen(false);
    };
  }, [client, id, live, connection]);
  return open;
}

export const broadcastStatsQuery = (id: string, live: boolean) =>
  queryOptions({
    queryKey: [...sendKeys.broadcast(id), 'stats'],
    queryFn: ({ signal }) => api.get<BroadcastStats>(`/api/v1/broadcasts/${id}/stats`, signal),
    refetchInterval: live ? 5000 : 60_000,
  });

/** The sent email with clicks marked. Slower than the stats: a change reloads the framed email. */
export const broadcastClickMapQuery = (id: string, live: boolean) =>
  queryOptions({
    queryKey: [...sendKeys.broadcast(id), 'click-map'],
    queryFn: ({ signal }) =>
      api.get<BroadcastClickMap>(`/api/v1/broadcasts/${id}/click-map`, signal),
    refetchInterval: live ? 30_000 : 60_000,
  });

/** Member growth and the latest Broadcasts with their opens and clicks, for the Overview. */
export const channelOverviewQuery = (channelId: string) =>
  queryOptions({
    queryKey: sendKeys.overview(channelId),
    queryFn: ({ signal }) =>
      api.get<ChannelOverview>(`/api/v1/channels/${channelId}/overview`, signal),
  });

export function useResendUnopened(id: string) {
  return useMutation({
    mutationFn: () => api.post<{ dispatchId: string }>(`/api/v1/broadcasts/${id}/resend-unopened`),
  });
}

export function useCancelBroadcast(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<Broadcast>(`/api/v1/broadcasts/${id}/cancel`),
    onSuccess: (broadcast) => {
      // The cancel answer has no Split Test or Cohort Sample, so keep those from the cache.
      client.setQueryData<BroadcastReport>(sendKeys.broadcast(id), (old) => ({
        splitTest: null,
        cohortSample: null,
        ...old,
        ...broadcast,
        waiting: null,
      }));
      void client.invalidateQueries({ queryKey: sendKeys.broadcast(id) });
      void client.invalidateQueries({ queryKey: sendKeys.dispatch(broadcast.dispatchId) });
    },
  });
}

/** Sends a waiting send on now (docs/writing-and-sending.md "When a send waits"). */
export function useResumeBroadcast(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<BroadcastReport>(`/api/v1/broadcasts/${id}/resume`),
    onSuccess: (report) => client.setQueryData(sendKeys.broadcast(id), report),
  });
}

// ---- Sending ---------------------------------------------------------------------------------

export const domainsQuery = (channelId: string) =>
  queryOptions({
    queryKey: sendKeys.domains(channelId),
    queryFn: ({ signal }) =>
      api.get<SendingDomain[]>(`/api/v1/channels/${channelId}/sending-domains`, signal),
  });

export const sendersQuery = (channelId: string) =>
  queryOptions({
    queryKey: sendKeys.senders(channelId),
    queryFn: ({ signal }) =>
      api.get<SenderIdentity[]>(`/api/v1/channels/${channelId}/sender-identities`, signal),
  });

export const rampsQuery = (channelId: string) =>
  queryOptions({
    queryKey: sendKeys.ramps(channelId),
    queryFn: ({ signal }) => api.get<Ramp[]>(`/api/v1/channels/${channelId}/ramps`, signal),
  });

function useSendingMutation<I, O>(channelId: string, call: (input: I) => Promise<O>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: () => {
      for (const key of [sendKeys.domains, sendKeys.senders, sendKeys.ramps]) {
        void client.invalidateQueries({ queryKey: key(channelId) });
      }
    },
  });
}

export const useAddDomain = (channelId: string) =>
  useSendingMutation(channelId, (input: CreateSendingDomain) =>
    api.post<SendingDomain>(`/api/v1/channels/${channelId}/sending-domains`, input),
  );

export const useVerifyDomain = (channelId: string) =>
  useSendingMutation(channelId, (domainId: string) =>
    api.post<CheckedSendingDomain>(`/api/v1/sending-domains/${domainId}/verify`),
  );

export const useRemoveDomain = (channelId: string) =>
  useSendingMutation(channelId, (domainId: string) =>
    api.delete(`/api/v1/sending-domains/${domainId}`),
  );

export const useAddSender = (channelId: string) =>
  useSendingMutation(channelId, (input: CreateSenderIdentity) =>
    api.post<SenderIdentity>(`/api/v1/channels/${channelId}/sender-identities`, input),
  );

export const useMakeDefaultSender = (channelId: string) =>
  useSendingMutation(channelId, (identityId: string) =>
    api.patch<SenderIdentity>(`/api/v1/sender-identities/${identityId}`, { isDefault: true }),
  );

export const useRemoveSender = (channelId: string) =>
  useSendingMutation(channelId, (identityId: string) =>
    api.delete(`/api/v1/sender-identities/${identityId}`),
  );

export const useUpdateRamp = (channelId: string) =>
  useSendingMutation(channelId, ({ rampId, ...input }: UpdateRamp & { rampId: string }) =>
    api.patch<Ramp>(`/api/v1/ramps/${rampId}`, input),
  );

export const useSkipRamp = (channelId: string) =>
  useSendingMutation(channelId, ({ rampId, ...input }: SkipRamp & { rampId: string }) =>
    api.post<Ramp>(`/api/v1/ramps/${rampId}/skip`, input),
  );

export const useRestartRamp = (channelId: string) =>
  useSendingMutation(channelId, ({ rampId, ...input }: RestartRamp & { rampId: string }) =>
    api.post<Ramp>(`/api/v1/ramps/${rampId}/restart`, input),
  );

/** The Channel's custom email CSS (flag custom_email_css; 404 feature_disabled when off). */
export const emailCssQuery = (channelId: string) =>
  queryOptions({
    queryKey: sendKeys.emailCss(channelId),
    queryFn: ({ signal }) => api.get<EmailCss>(`/api/v1/channels/${channelId}/email-css`, signal),
  });

export function useSaveEmailCss(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (css: string) =>
      api.put<EmailCss>(`/api/v1/channels/${channelId}/email-css`, { css }),
    onSuccess: (saved) => {
      client.setQueryData(sendKeys.emailCss(channelId), saved);
      // Every stored render of the Channel's Dispatches is now out of date.
      void client.invalidateQueries({ queryKey: ['dispatches'] });
    },
  });
}
