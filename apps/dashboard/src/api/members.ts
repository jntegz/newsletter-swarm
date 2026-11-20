// Queries and mutations for the Members workstream: Members, profile fields, tags, imports,
// exports and bulk actions.
import type {
  EmailCheckState,
  BulkJob,
  CreateBulkJob,
  CreateExport,
  CreateMember,
  CreateMemberField,
  CreateMemberView,
  ExportJob,
  ImportJob,
  ImportSource,
  ImportMapping,
  MemberActivity,
  MemberCounts,
  MemberDetail,
  MemberField,
  MemberFlowHistory,
  MemberListItem,
  MemberPatch,
  MemberStatus,
  MemberView,
  Tag,
  UpdateMemberField,
  UpdateMemberView,
} from '@swarm/domain';
import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api, request } from './client';

export const memberKeys = {
  /** Every Member list and the counts of a Channel. */
  list: (channelId: string) => ['channels', channelId, 'members'] as const,
  detail: (id: string) => ['members', id] as const,
  activity: (id: string) => ['members', id, 'activity'] as const,
  fields: (channelId: string) => ['channels', channelId, 'member-fields'] as const,
  tags: (channelId: string) => ['channels', channelId, 'tags'] as const,
  imports: (channelId: string) => ['channels', channelId, 'imports'] as const,
  import: (id: string) => ['imports', id] as const,
  exports: (channelId: string) => ['channels', channelId, 'exports'] as const,
  export: (id: string) => ['exports', id] as const,
  bulkJob: (id: string) => ['bulk-jobs', id] as const,
  /** Saved views: outside `list`, so a change to a Member doesn't refetch them. */
  views: (channelId: string) => ['channels', channelId, 'member-views'] as const,
};

/** How often a running job is polled. */
const POLL_MS = 1500;

// ---- Members ---------------------------------------------------------------------------------

interface MemberFilter {
  cursor?: string | null;
  status?: MemberStatus | undefined;
  tag?: string | undefined;
  q?: string | undefined;
  /** Only Members of this segment (Circle id). */
  circle?: string | undefined;
  /** Profile field keys to return as columns. */
  fields?: string[] | undefined;
  /** Email checks: a colour or "unchecked", and one result code. */
  emailCheck?: EmailCheckState | undefined;
  emailCheckCode?: number | undefined;
}

export const membersQuery = (channelId: string, filter: MemberFilter = {}) => {
  const q = filter.q?.trim() || undefined;
  const fields = filter.fields?.length ? filter.fields.join(',') : undefined;
  const key = {
    cursor: filter.cursor ?? null,
    status: filter.status,
    tag: filter.tag,
    q,
    circle: filter.circle,
    fields,
    emailCheck: filter.emailCheck,
    emailCheckCode: filter.emailCheckCode,
  };
  return queryOptions({
    queryKey: [...memberKeys.list(channelId), key],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (key.cursor) params.set('cursor', key.cursor);
      if (key.status) params.set('status', key.status);
      if (key.tag) params.set('tag', key.tag);
      if (key.q) params.set('q', key.q.slice(0, 100));
      if (key.circle) params.set('circle', key.circle);
      if (key.fields) params.set('fields', key.fields);
      if (key.emailCheck) params.set('emailCheck', key.emailCheck);
      if (key.emailCheckCode) params.set('emailCheckCode', String(key.emailCheckCode));
      return api.get<{ items: MemberListItem[]; nextCursor: string | null }>(
        `/api/v1/channels/${channelId}/members?${params}`,
        signal,
      );
    },
    placeholderData: keepPreviousData,
  });
};

export const memberCountsQuery = (channelId: string) =>
  queryOptions({
    queryKey: [...memberKeys.list(channelId), 'counts'],
    queryFn: ({ signal }) =>
      api.get<MemberCounts>(`/api/v1/channels/${channelId}/members/counts`, signal),
  });

export const memberQuery = (id: string) =>
  queryOptions({
    queryKey: memberKeys.detail(id),
    queryFn: ({ signal }) => api.get<MemberDetail>(`/api/v1/members/${id}`, signal),
  });

export const memberFlowsQuery = (id: string) =>
  queryOptions({
    queryKey: ['members', id, 'flows'],
    queryFn: ({ signal }) => api.get<MemberFlowHistory[]>(`/api/v1/members/${id}/flows`, signal),
  });

export const memberActivityQuery = (id: string) =>
  queryOptions({
    queryKey: memberKeys.activity(id),
    queryFn: ({ signal }) => api.get<MemberActivity[]>(`/api/v1/members/${id}/activity`, signal),
  });

export function useAddMember(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMember) =>
      api.post<MemberDetail>(`/api/v1/channels/${channelId}/members`, input),
    onSuccess: (member) => {
      client.setQueryData(memberKeys.detail(member.id), member);
      void client.invalidateQueries({ queryKey: memberKeys.list(channelId) });
      void client.invalidateQueries({ queryKey: memberKeys.tags(channelId) });
    },
  });
}

export function useUpdateMember(channelId: string, memberId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: MemberPatch) =>
      api.patch<MemberDetail>(`/api/v1/members/${memberId}`, input),
    onSuccess: (member) => {
      client.setQueryData(memberKeys.detail(memberId), member);
      void client.invalidateQueries({ queryKey: memberKeys.list(channelId) });
      void client.invalidateQueries({ queryKey: memberKeys.tags(channelId) });
    },
  });
}

export function useDeleteMember(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (memberId: string) => api.delete(`/api/v1/members/${memberId}`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: memberKeys.list(channelId) });
      void client.invalidateQueries({ queryKey: memberKeys.tags(channelId) });
    },
  });
}

// ---- Saved views ----------------------------------------------------------------------------

export const memberViewsQuery = (channelId: string) =>
  queryOptions({
    queryKey: memberKeys.views(channelId),
    queryFn: ({ signal }) =>
      api.get<MemberView[]>(`/api/v1/channels/${channelId}/members/views`, signal),
    staleTime: 30_000,
  });

export function useCreateMemberView(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMemberView) =>
      api.post<MemberView>(`/api/v1/channels/${channelId}/members/views`, input),
    onSuccess: () => client.invalidateQueries({ queryKey: memberKeys.views(channelId) }),
  });
}

export function useUpdateMemberView(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateMemberView & { id: string }) =>
      api.patch<MemberView>(`/api/v1/channels/${channelId}/members/views/${id}`, input),
    onSuccess: () => client.invalidateQueries({ queryKey: memberKeys.views(channelId) }),
  });
}

export function useDeleteMemberView(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/channels/${channelId}/members/views/${id}`),
    onSuccess: () => client.invalidateQueries({ queryKey: memberKeys.views(channelId) }),
  });
}

// ---- Profile fields --------------------------------------------------------------------------

export const memberFieldsQuery = (channelId: string) =>
  queryOptions({
    queryKey: memberKeys.fields(channelId),
    queryFn: ({ signal }) =>
      api.get<MemberField[]>(`/api/v1/channels/${channelId}/member-fields`, signal),
  });

function useFieldMutation<I, O>(channelId: string, call: (input: I) => Promise<O>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: memberKeys.fields(channelId) });
      // Member details carry field values, which change when a field is removed.
      void client.invalidateQueries({ queryKey: ['members'] });
    },
  });
}

export const useCreateMemberField = (channelId: string) =>
  useFieldMutation(channelId, (input: CreateMemberField) =>
    api.post<MemberField>(`/api/v1/channels/${channelId}/member-fields`, input),
  );

export const useUpdateMemberField = (channelId: string) =>
  useFieldMutation(channelId, ({ id, ...input }: UpdateMemberField & { id: string }) =>
    api.patch<MemberField>(`/api/v1/member-fields/${id}`, input),
  );

export const useDeleteMemberField = (channelId: string) =>
  useFieldMutation(channelId, (id: string) => api.delete(`/api/v1/member-fields/${id}`));

// ---- Tags ------------------------------------------------------------------------------------

export const tagsQuery = (channelId: string) =>
  queryOptions({
    queryKey: memberKeys.tags(channelId),
    queryFn: ({ signal }) => api.get<Tag[]>(`/api/v1/channels/${channelId}/tags`, signal),
  });

function useTagMutation<I, O>(channelId: string, call: (input: I) => Promise<O>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: memberKeys.tags(channelId) });
      void client.invalidateQueries({ queryKey: memberKeys.list(channelId) });
      void client.invalidateQueries({ queryKey: ['members'] });
    },
  });
}

export const useCreateTag = (channelId: string) =>
  useTagMutation(channelId, (name: string) =>
    api.post<Tag>(`/api/v1/channels/${channelId}/tags`, { name }),
  );

export const useRenameTag = (channelId: string) =>
  useTagMutation(channelId, ({ id, name }: { id: string; name: string }) =>
    api.patch<Tag>(`/api/v1/tags/${id}`, { name }),
  );

export const useDeleteTag = (channelId: string) =>
  useTagMutation(channelId, (id: string) => api.delete(`/api/v1/tags/${id}`));

// ---- Imports ---------------------------------------------------------------------------------

const IMPORT_RUNNING = new Set<ImportJob['status']>(['analyzing', 'importing']);

export const importsQuery = (channelId: string) =>
  queryOptions({
    queryKey: memberKeys.imports(channelId),
    queryFn: ({ signal }) => api.get<ImportJob[]>(`/api/v1/channels/${channelId}/imports`, signal),
    refetchInterval: (query) =>
      query.state.data?.some((job) => IMPORT_RUNNING.has(job.status)) ? 5000 : false,
  });

/** Polls while the dry run or the import is running. */
export const importQuery = (id: string) =>
  queryOptions({
    queryKey: memberKeys.import(id),
    queryFn: ({ signal }) => api.get<ImportJob>(`/api/v1/imports/${id}`, signal),
    refetchInterval: (query) =>
      query.state.data && IMPORT_RUNNING.has(query.state.data.status) ? POLL_MS : false,
  });

function useImportMutation<I>(channelId: string, call: (input: I) => Promise<ImportJob>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: (job) => {
      client.setQueryData(memberKeys.import(job.id), job);
      void client.invalidateQueries({ queryKey: memberKeys.imports(channelId) });
    },
  });
}

export const useUploadImport = (channelId: string) =>
  useImportMutation(channelId, (input: File | { file: File; source: ImportSource }) => {
    const { file, source } = input instanceof File ? { file: input, source: 'csv' } : input;
    const form = new FormData();
    form.set('file', file);
    // The migration shim (Phase 7): exports of other newsletter platforms.
    if (source !== 'csv') form.set('source', source);
    return api.upload<ImportJob>(`/api/v1/channels/${channelId}/imports`, form);
  });

export const useSaveImportMapping = (channelId: string) =>
  useImportMutation(channelId, ({ id, ...input }: ImportMapping & { id: string }) =>
    request<ImportJob>('PUT', `/api/v1/imports/${id}/mapping`, { json: input }),
  );

export const useAnalyzeImport = (channelId: string) =>
  useImportMutation(channelId, (id: string) =>
    api.post<ImportJob>(`/api/v1/imports/${id}/analyze`),
  );

export const useConfirmImport = (channelId: string) =>
  useImportMutation(channelId, (id: string) =>
    api.post<ImportJob>(`/api/v1/imports/${id}/confirm`),
  );

export const useCancelImport = (channelId: string) =>
  useImportMutation(channelId, (id: string) => api.post<ImportJob>(`/api/v1/imports/${id}/cancel`));

/** Refreshes the Member list and tags once an import finishes. */
export function useRefreshWhenImported(channelId: string, job: ImportJob | undefined) {
  const client = useQueryClient();
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!job || job.status !== 'done' || seen.current === job.id) return;
    seen.current = job.id;
    void client.invalidateQueries({ queryKey: memberKeys.list(channelId) });
    void client.invalidateQueries({ queryKey: memberKeys.tags(channelId) });
    void client.invalidateQueries({ queryKey: memberKeys.imports(channelId) });
  }, [client, channelId, job]);
}

// ---- Exports ---------------------------------------------------------------------------------

const JOB_RUNNING = new Set(['queued', 'running']);

export const exportsQuery = (channelId: string) =>
  queryOptions({
    queryKey: memberKeys.exports(channelId),
    queryFn: ({ signal }) => api.get<ExportJob[]>(`/api/v1/channels/${channelId}/exports`, signal),
  });

export const exportQuery = (id: string) =>
  queryOptions({
    queryKey: memberKeys.export(id),
    queryFn: ({ signal }) => api.get<ExportJob>(`/api/v1/exports/${id}`, signal),
    refetchInterval: (query) =>
      query.state.data && JOB_RUNNING.has(query.state.data.status) ? POLL_MS : false,
  });

/** Stops an export that has not finished; its parts are deleted. */
export function useCancelExport(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (exportId: string) => api.post<ExportJob>(`/api/v1/exports/${exportId}/cancel`),
    onSuccess: (job) => {
      client.setQueryData(memberKeys.export(job.id), job);
      void client.invalidateQueries({ queryKey: memberKeys.exports(channelId) });
    },
  });
}

export function useCreateExport(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateExport) =>
      api.post<ExportJob>(`/api/v1/channels/${channelId}/exports`, input),
    onSuccess: (job) => {
      client.setQueryData(memberKeys.export(job.id), job);
      void client.invalidateQueries({ queryKey: memberKeys.exports(channelId) });
    },
  });
}

// ---- Bulk actions ----------------------------------------------------------------------------

export function useStartBulkJob(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBulkJob) =>
      api.post<BulkJob>(`/api/v1/channels/${channelId}/bulk-jobs`, input),
    onSuccess: (job) => client.setQueryData(memberKeys.bulkJob(job.id), job),
  });
}

const bulkJobQuery = (id: string) =>
  queryOptions({
    queryKey: memberKeys.bulkJob(id),
    queryFn: ({ signal }) => api.get<BulkJob>(`/api/v1/bulk-jobs/${id}`, signal),
    refetchInterval: (query) =>
      query.state.data && JOB_RUNNING.has(query.state.data.status) ? POLL_MS : false,
  });

/** Follows a bulk job, and refreshes Members and tags once it stops running. */
export function useBulkJob(channelId: string, id: string | null) {
  const client = useQueryClient();
  const job = useQuery({ ...bulkJobQuery(id ?? ''), enabled: !!id });
  const finished = useRef<string | null>(null);
  const data = id ? job.data : undefined;
  useEffect(() => {
    if (!data || JOB_RUNNING.has(data.status) || finished.current === data.id) return;
    finished.current = data.id;
    void client.invalidateQueries({ queryKey: memberKeys.list(channelId) });
    void client.invalidateQueries({ queryKey: memberKeys.tags(channelId) });
    void client.invalidateQueries({ queryKey: ['members'] });
  }, [client, channelId, data]);
  return { job: data, error: id ? job.error : null };
}
