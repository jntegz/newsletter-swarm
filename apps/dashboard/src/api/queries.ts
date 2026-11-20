import type {
  AuditEvent,
  AuthConfig,
  Channel,
  CreateChannel,
  Flags,
  Invite,
  MediaAsset,
  Me,
  Seat,
  SeatAccess,
  SeatRole,
  SessionSummary,
  UpdateChannel,
  UpdateMedia,
  Workspace,
} from '@swarm/domain';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export const keys = {
  me: ['me'] as const,
  authConfig: ['auth-config'] as const,
  channels: (workspaceId: string, deleted = false) =>
    ['workspaces', workspaceId, 'channels', { deleted }] as const,
  channel: (channelId: string) => ['channels', channelId] as const,
  channelFlags: (channelId: string) => ['channels', channelId, 'flags'] as const,
  instanceFlags: ['flags'] as const,
  media: (channelId: string) => ['channels', channelId, 'media'] as const,
  seats: (workspaceId: string) => ['workspaces', workspaceId, 'seats'] as const,
  invites: (workspaceId: string) => ['workspaces', workspaceId, 'invites'] as const,
  sessions: ['sessions'] as const,
  audit: (workspaceId: string) => ['workspaces', workspaceId, 'audit'] as const,
};

export const meQuery = queryOptions({
  queryKey: keys.me,
  queryFn: ({ signal }) => api.get<Me>('/api/v1/auth/session', signal),
  staleTime: 60_000,
  retry: false,
});

/** Optional features in effect for a Channel (platform → workspace → Channel overrides). */
const channelFlagsQuery = (channelId: string) =>
  queryOptions({
    queryKey: keys.channelFlags(channelId),
    queryFn: ({ signal }) => api.get<Flags>(`/api/v1/channels/${channelId}/flags`, signal),
    // The server caches overrides for 60 s too.
    staleTime: 60_000,
  });

/**
 * Whether an optional feature is on for a Channel: true or false once known, undefined while
 * loading, null when the flags could not be read (callers then fall back to the server's answer).
 */
export function useChannelFlag(
  channelId: string | undefined,
  key: string,
): boolean | null | undefined {
  const flags = useQuery({ ...channelFlagsQuery(channelId ?? ''), enabled: !!channelId });
  if (flags.data) return flags.data.flags[key] === true;
  return flags.isError ? null : undefined;
}

/** Optional features for the whole Swarm: the platform value, before any workspace's override. */
const instanceFlagsQuery = queryOptions({
  queryKey: keys.instanceFlags,
  queryFn: ({ signal }) => api.get<Flags>('/api/v1/flags', signal),
  staleTime: 60_000,
});

/** The same three answers as useChannelFlag, from the instance's flags. */
export function useInstanceFlag(key: string): boolean | null | undefined {
  const flags = useQuery(instanceFlagsQuery);
  if (flags.data) return flags.data.flags[key] === true;
  return flags.isError ? null : undefined;
}

/** Whether a feature is on for the whole Swarm. False until known, and if it can't be read. */
export function usePlatformFlag(key: string): boolean {
  return useInstanceFlag(key) === true;
}

/**
 * Which flag read answers for a feature outside any one publication. A publication's flags already
 * include the instance's and the workspace's overrides, so they win; the instance's answer when
 * there is no publication yet, or its flags could not be read.
 */
export function workspaceFlag(
  hasChannel: boolean,
  channel: boolean | null | undefined,
  instance: boolean | null | undefined,
): boolean | null | undefined {
  return hasChannel && channel !== null ? channel : instance;
}

export const authConfigQuery = queryOptions({
  queryKey: keys.authConfig,
  queryFn: ({ signal }) => api.get<AuthConfig>('/api/v1/auth/config', signal),
  staleTime: Infinity,
});

export const channelsQuery = (workspaceId: string, deleted = false) =>
  queryOptions({
    queryKey: keys.channels(workspaceId, deleted),
    queryFn: ({ signal }) =>
      api.get<Channel[]>(
        `/api/v1/workspaces/${workspaceId}/channels${deleted ? '?deleted=true' : ''}`,
        signal,
      ),
  });

export const channelQuery = (channelId: string) =>
  queryOptions({
    queryKey: keys.channel(channelId),
    queryFn: ({ signal }) => api.get<Channel>(`/api/v1/channels/${channelId}`, signal),
  });

/** The Channel's media library; `q` searches alt text, `kind` picks images or other files. */
export const mediaQuery = (channelId: string, q = '', kind?: MediaAsset['kind']) =>
  queryOptions({
    queryKey: [...keys.media(channelId), { q: q.trim(), kind }],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams();
      if (q.trim()) params.set('q', q.trim());
      if (kind) params.set('kind', kind);
      const query = params.size ? `?${params}` : '';
      return api.get<MediaAsset[]>(`/api/v1/channels/${channelId}/media${query}`, signal);
    },
  });

export const seatsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: keys.seats(workspaceId),
    queryFn: ({ signal }) => api.get<Seat[]>(`/api/v1/workspaces/${workspaceId}/seats`, signal),
  });

/** What removing a seat also revokes (its API keys and authorised apps). */
export const seatAccessQuery = (workspaceId: string, seatId: string) =>
  queryOptions({
    queryKey: [...keys.seats(workspaceId), seatId, 'access'] as const,
    queryFn: ({ signal }) =>
      api.get<SeatAccess>(`/api/v1/workspaces/${workspaceId}/seats/${seatId}/access`, signal),
    staleTime: 0,
  });

export const invitesQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: keys.invites(workspaceId),
    queryFn: ({ signal }) => api.get<Invite[]>(`/api/v1/workspaces/${workspaceId}/invites`, signal),
  });

export const sessionsQuery = queryOptions({
  queryKey: keys.sessions,
  queryFn: ({ signal }) => api.get<SessionSummary[]>('/api/v1/auth/sessions', signal),
});

export const auditQuery = (workspaceId: string, cursor: string | null) =>
  queryOptions({
    queryKey: [...keys.audit(workspaceId), cursor],
    queryFn: ({ signal }) =>
      api.get<{ items: AuditEvent[]; nextCursor: string | null }>(
        `/api/v1/workspaces/${workspaceId}/audit?limit=25${cursor ? `&cursor=${cursor}` : ''}`,
        signal,
      ),
  });

interface ChainVerification {
  ok: boolean;
  checked: number;
  brokenAtSeq: number | null;
}

/**
 * Verifies a hash chain (`…/audit/verify` or `…/agent-actions/verify`) to the end. The API checks
 * a bounded page per request, so a long chain takes several requests that follow nextCursor.
 */
export async function verifyChain(path: string, signal?: AbortSignal): Promise<ChainVerification> {
  let cursor: string | null = null;
  for (;;) {
    const page: ChainVerification & { complete: boolean; nextCursor: string | null } =
      await api.get(cursor ? `${path}?cursor=${cursor}` : path, signal);
    if (page.complete || !page.nextCursor) return page;
    cursor = page.nextCursor;
  }
}

export function useCreateChannel(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateChannel) =>
      api.post<Channel>(`/api/v1/workspaces/${workspaceId}/channels`, input),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'channels'] }),
  });
}

export function useUpdateChannel(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateChannel) =>
      api.patch<Channel>(`/api/v1/channels/${channelId}`, input),
    onSuccess: (channel) => {
      client.setQueryData(keys.channel(channelId), channel);
      void client.invalidateQueries({ queryKey: ['workspaces', channel.workspaceId, 'channels'] });
    },
  });
}

export function useDeleteChannel(channel: Channel) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<Channel>(`/api/v1/channels/${channel.id}`),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ['workspaces', channel.workspaceId, 'channels'] }),
  });
}

export function useRestoreChannel(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) => api.post<Channel>(`/api/v1/channels/${channelId}/restore`),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'channels'] }),
  });
}

/** Uploads a file; `alt` is an image's alt text, or a font's or file's name. */
export function useUploadMedia(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: File | { file: File; alt?: string }) => {
      const { file, alt } = input instanceof File ? { file: input, alt: undefined } : input;
      const form = new FormData();
      form.set('file', file);
      if (alt?.trim()) form.set('alt', alt.trim());
      return api.upload<MediaAsset>(`/api/v1/channels/${channelId}/media`, form);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: keys.media(channelId) }),
  });
}

export function useUpdateMedia(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateMedia & { id: string }) =>
      api.patch<MediaAsset>(`/api/v1/media/${id}`, input),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.media(channelId) }),
  });
}

export function useDeleteMedia(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/media/${id}`),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.media(channelId) }),
  });
}

export function useRenameWorkspace(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.patch<Workspace>(`/api/v1/workspaces/${workspaceId}`, { name }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.me }),
  });
}

export function useInvite(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; role: Exclude<SeatRole, 'owner'> }) =>
      api.post<Invite>(`/api/v1/workspaces/${workspaceId}/invites`, input),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.invites(workspaceId) }),
  });
}

export function useRevokeInvite(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) =>
      api.delete(`/api/v1/workspaces/${workspaceId}/invites/${inviteId}`),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.invites(workspaceId) }),
  });
}

export function useChangeRole(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ seatId, role }: { seatId: string; role: SeatRole }) =>
      api.patch<Seat>(`/api/v1/workspaces/${workspaceId}/seats/${seatId}`, { role }),
    onSettled: () => client.invalidateQueries({ queryKey: keys.seats(workspaceId) }),
  });
}

export function useRemoveSeat(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (seatId: string) => api.delete(`/api/v1/workspaces/${workspaceId}/seats/${seatId}`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.seats(workspaceId) });
      // Their API keys were revoked with the seat.
      void client.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'api-keys'] });
    },
  });
}

export function useRevokeSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => api.delete(`/api/v1/auth/sessions/${sessionId}`),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.sessions }),
  });
}
