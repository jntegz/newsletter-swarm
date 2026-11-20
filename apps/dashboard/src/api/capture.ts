// Queries and mutations for Capture Forms (workers/api/src/routes/captureForms.ts), profile fields
// for the builder, and resending a pending Member's confirmation.
import type {
  CaptureForm,
  CaptureFormConfig,
  MemberField,
  SmartPromptPlacement,
} from '@swarm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

// The domain package exports schemas, not type aliases, for these three; the shapes match
// CaptureFormVersionSchema, CaptureFormStatsSchema and CaptureFormSnippetSchema.
interface CaptureFormVersion {
  version: number;
  config: CaptureFormConfig;
  publishedBy: string | null;
  publishedAt: string;
}

interface CaptureFormDay {
  day: string;
  views: number;
  submissions: number;
  confirmed: number;
}

export interface CaptureFormStats {
  days: CaptureFormDay[];
  totals: { views: number; submissions: number; confirmed: number };
  /** Confirmed Members per view, 0–1; null without views. */
  conversion: number | null;
}

interface CaptureFormSnippet {
  version: number;
  scriptUrl: string;
  integrity: string;
  script: string;
  noscript: string;
  attribution: string;
}

const captureKeys = {
  forms: (channelId: string) => ['channels', channelId, 'capture-forms'] as const,
  form: (formId: string) => ['capture-forms', formId] as const,
  versions: (formId: string) => ['capture-forms', formId, 'versions'] as const,
  snippet: (formId: string) => ['capture-forms', formId, 'snippet'] as const,
  stats: (formId: string, days: number) => ['capture-forms', formId, 'stats', days] as const,
  memberFields: (channelId: string) => ['channels', channelId, 'member-fields'] as const,
};

export const captureFormsQuery = (channelId: string) =>
  queryOptions({
    queryKey: captureKeys.forms(channelId),
    queryFn: ({ signal }) =>
      api.get<CaptureForm[]>(`/api/v1/channels/${channelId}/capture-forms`, signal),
  });

export const captureFormQuery = (formId: string) =>
  queryOptions({
    queryKey: captureKeys.form(formId),
    queryFn: ({ signal }) => api.get<CaptureForm>(`/api/v1/capture-forms/${formId}`, signal),
  });

export const captureVersionsQuery = (formId: string) =>
  queryOptions({
    queryKey: captureKeys.versions(formId),
    queryFn: ({ signal }) =>
      api.get<CaptureFormVersion[]>(`/api/v1/capture-forms/${formId}/versions`, signal),
  });

/** The embed code for the published version. The API answers 409 until the first publish. */
export const captureSnippetQuery = (formId: string) =>
  queryOptions({
    queryKey: captureKeys.snippet(formId),
    queryFn: ({ signal }) =>
      api.get<CaptureFormSnippet>(`/api/v1/capture-forms/${formId}/snippet`, signal),
    retry: false,
  });

export const captureStatsQuery = (formId: string, days = 30) =>
  queryOptions({
    queryKey: captureKeys.stats(formId, days),
    queryFn: ({ signal }) =>
      api.get<CaptureFormStats>(`/api/v1/capture-forms/${formId}/stats?days=${days}`, signal),
    staleTime: 60_000,
  });

export const memberFieldsQuery = (channelId: string) =>
  queryOptions({
    queryKey: captureKeys.memberFields(channelId),
    queryFn: ({ signal }) =>
      api.get<MemberField[]>(`/api/v1/channels/${channelId}/member-fields`, signal),
  });

export function useCreateCaptureForm(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      config?: CaptureFormConfig;
      kind?: 'form' | 'prompt';
      placement?: SmartPromptPlacement;
    }) => api.post<CaptureForm>(`/api/v1/channels/${channelId}/capture-forms`, input),
    onSuccess: (form) => {
      client.setQueryData(captureKeys.form(form.id), form);
      void client.invalidateQueries({ queryKey: captureKeys.forms(channelId) });
    },
  });
}

/** Saves the name and/or the draft. The live form changes only on publish. */
export function useSaveCaptureForm(formId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name?: string;
      config?: CaptureFormConfig;
      placement?: SmartPromptPlacement;
    }) => api.patch<CaptureForm>(`/api/v1/capture-forms/${formId}`, input),
    onSuccess: (form) => {
      client.setQueryData(captureKeys.form(formId), form);
      void client.invalidateQueries({ queryKey: captureKeys.forms(form.channelId) });
    },
  });
}

/** Publish and restore both replace the form, its history and its embed code. */
function useFormReplaced(formId: string) {
  const client = useQueryClient();
  return (form: CaptureForm) => {
    client.setQueryData(captureKeys.form(formId), form);
    void client.invalidateQueries({ queryKey: captureKeys.versions(formId) });
    void client.invalidateQueries({ queryKey: captureKeys.snippet(formId) });
    void client.invalidateQueries({ queryKey: captureKeys.forms(form.channelId) });
  };
}

/** The draft becomes the next version and goes live (editor and above). */
export function usePublishCaptureForm(formId: string) {
  const onSuccess = useFormReplaced(formId);
  return useMutation({
    mutationFn: () => api.post<CaptureForm>(`/api/v1/capture-forms/${formId}/publish`),
    onSuccess,
  });
}

/** Copies a published version into the draft (author and above). */
export function useRestoreCaptureVersion(formId: string) {
  const onSuccess = useFormReplaced(formId);
  return useMutation({
    mutationFn: (version: number) =>
      api.post<CaptureForm>(`/api/v1/capture-forms/${formId}/versions/${version}/restore`),
    onSuccess,
  });
}

export function useDeleteCaptureForm(form: CaptureForm) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete(`/api/v1/capture-forms/${form.id}`),
    onSuccess: () => {
      client.removeQueries({ queryKey: captureKeys.form(form.id) });
      void client.invalidateQueries({ queryKey: captureKeys.forms(form.channelId) });
    },
  });
}

/**
 * Sends a pending Member their confirmation email again (editor and above). The API answers
 * 409 for Members who aren't pending or are suppressed, and 429 when one went out recently.
 */
export function useSendConfirmation(memberId: string) {
  return useMutation({
    mutationFn: () =>
      api.post<{ sent: true }>(`/api/v1/members/${encodeURIComponent(memberId)}/confirmation`),
  });
}
