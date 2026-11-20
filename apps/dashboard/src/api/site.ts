// Queries and mutations for Site Studio (Phase 4): website settings, sections, pages, redirects,
// Bot Rules, web domains and site analytics, plus putting a Dispatch on the web.
import type {
  AddWebDomain,
  AuthorProfile,
  BotRules,
  CreateSitePage,
  CreateSiteRedirect,
  CreateSiteSection,
  Dispatch,
  RedirectImportResult,
  SiteAnalytics,
  SitePage,
  SitePageSummary,
  SiteRedirect,
  SiteSection,
  SiteSettings,
  UpdateBotRules,
  UpdateSitePage,
  UpdateSiteSection,
  UpdateSiteSettings,
  UpsertAuthorProfile,
  WebDomainList,
} from '@swarm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from './client';
import { sendKeys } from './send';

const siteKeys = {
  all: (channelId: string) => ['channels', channelId, 'site'] as const,
  settings: (channelId: string) => ['channels', channelId, 'site', 'settings'] as const,
  sections: (channelId: string) => ['channels', channelId, 'site', 'sections'] as const,
  pages: (channelId: string) => ['channels', channelId, 'site', 'pages'] as const,
  page: (channelId: string, pageId: string) =>
    ['channels', channelId, 'site', 'pages', pageId] as const,
  redirects: (channelId: string) => ['channels', channelId, 'site', 'redirects'] as const,
  botRules: (channelId: string) => ['channels', channelId, 'site', 'bot-rules'] as const,
  domains: (channelId: string) => ['channels', channelId, 'site', 'web-domains'] as const,
  analytics: (channelId: string) => ['channels', channelId, 'site', 'analytics'] as const,
  authors: (channelId: string) => ['channels', channelId, 'site', 'authors'] as const,
};

const base = (channelId: string) => `/api/v1/channels/${channelId}/site`;

/** True when the API refused because an optional feature is off for this Channel. */
export const isFeatureDisabled = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.code === 'feature_disabled';

// ---- Settings ------------------------------------------------------------------------------

export const siteSettingsQuery = (channelId: string) =>
  queryOptions({
    queryKey: siteKeys.settings(channelId),
    queryFn: ({ signal }) => api.get<SiteSettings>(`${base(channelId)}/settings`, signal),
  });

export function useUpdateSiteSettings(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSiteSettings) =>
      api.patch<SiteSettings>(`${base(channelId)}/settings`, input),
    onSuccess: (settings) => {
      client.setQueryData(siteKeys.settings(channelId), settings);
      // The AI crawler policy is shared with the Bot Rules.
      void client.invalidateQueries({ queryKey: siteKeys.botRules(channelId) });
    },
  });
}

// ---- Sections ------------------------------------------------------------------------------

export const siteSectionsQuery = (channelId: string) =>
  queryOptions({
    queryKey: siteKeys.sections(channelId),
    queryFn: ({ signal }) => api.get<SiteSection[]>(`${base(channelId)}/sections`, signal),
    // feature_disabled is an answer, not a hiccup.
    retry: (count, error) => !isFeatureDisabled(error) && count < 2,
  });

function useSectionMutation<I, O>(channelId: string, call: (input: I) => Promise<O>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: () => client.invalidateQueries({ queryKey: siteKeys.sections(channelId) }),
  });
}

export const useCreateSection = (channelId: string) =>
  useSectionMutation(channelId, (input: CreateSiteSection) =>
    api.post<SiteSection>(`${base(channelId)}/sections`, input),
  );

export const useUpdateSection = (channelId: string) =>
  useSectionMutation(channelId, ({ id, ...input }: UpdateSiteSection & { id: string }) =>
    api.patch<SiteSection>(`${base(channelId)}/sections/${id}`, input),
  );

export const useDeleteSection = (channelId: string) =>
  useSectionMutation(channelId, (id: string) => api.delete(`${base(channelId)}/sections/${id}`));

// ---- Author pages (flag author_pages) -------------------------------------------------------

export const authorsQuery = (channelId: string) =>
  queryOptions({
    queryKey: siteKeys.authors(channelId),
    queryFn: ({ signal }) =>
      api.get<AuthorProfile[]>(`/api/v1/channels/${channelId}/authors`, signal),
    retry: (count, error) => !isFeatureDisabled(error) && count < 2,
  });

function useAuthorMutation<I, O>(channelId: string, call: (input: I) => Promise<O>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: () => client.invalidateQueries({ queryKey: siteKeys.authors(channelId) }),
  });
}

export const useSaveAuthor = (channelId: string) =>
  useAuthorMutation(
    channelId,
    ({ operatorId, ...input }: UpsertAuthorProfile & { operatorId: string }) =>
      api.put<AuthorProfile>(`/api/v1/channels/${channelId}/authors/${operatorId}`, input),
  );

export const useDeleteAuthor = (channelId: string) =>
  useAuthorMutation(channelId, (operatorId: string) =>
    api.delete(`/api/v1/channels/${channelId}/authors/${operatorId}`),
  );

// ---- Pages ---------------------------------------------------------------------------------

export const sitePagesQuery = (channelId: string) =>
  queryOptions({
    queryKey: siteKeys.pages(channelId),
    queryFn: ({ signal }) =>
      api.get<{ items: SitePageSummary[]; limit: number | null }>(
        `${base(channelId)}/pages`,
        signal,
      ),
  });

export const sitePageQuery = (channelId: string, pageId: string) =>
  queryOptions({
    queryKey: siteKeys.page(channelId, pageId),
    queryFn: ({ signal }) => api.get<SitePage>(`${base(channelId)}/pages/${pageId}`, signal),
  });

export function useCreatePage(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSitePage) => api.post<SitePage>(`${base(channelId)}/pages`, input),
    onSuccess: (page) => {
      client.setQueryData(siteKeys.page(channelId, page.id), page);
      void client.invalidateQueries({ queryKey: siteKeys.pages(channelId), exact: true });
    },
  });
}

/** Saves without refetching the page, so the editor never jumps under the cursor. */
export function useUpdatePage(channelId: string, pageId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSitePage) =>
      api.patch<SitePage>(`${base(channelId)}/pages/${pageId}`, input),
    onSuccess: (page) => {
      client.setQueryData(siteKeys.page(channelId, pageId), page);
      void client.invalidateQueries({ queryKey: siteKeys.pages(channelId), exact: true });
    },
  });
}

export function useDeletePage(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (pageId: string) => api.delete(`${base(channelId)}/pages/${pageId}`),
    onSuccess: () => client.invalidateQueries({ queryKey: siteKeys.pages(channelId) }),
  });
}

// ---- Redirects -----------------------------------------------------------------------------

export const siteRedirectsQuery = (channelId: string) =>
  queryOptions({
    queryKey: siteKeys.redirects(channelId),
    queryFn: ({ signal }) =>
      api.get<{ items: SiteRedirect[]; limit: number | null }>(
        `${base(channelId)}/redirects`,
        signal,
      ),
  });

function useRedirectMutation<I, O>(channelId: string, call: (input: I) => Promise<O>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: () => client.invalidateQueries({ queryKey: siteKeys.redirects(channelId) }),
  });
}

export const useCreateRedirect = (channelId: string) =>
  useRedirectMutation(channelId, (input: CreateSiteRedirect) =>
    api.post<SiteRedirect>(`${base(channelId)}/redirects`, input),
  );

export const useUpdateRedirect = (channelId: string) =>
  useRedirectMutation(
    channelId,
    ({ id, ...input }: { id: string; to?: string; statusCode?: SiteRedirect['statusCode'] }) =>
      api.patch<SiteRedirect>(`${base(channelId)}/redirects/${id}`, input),
  );

export const useDeleteRedirect = (channelId: string) =>
  useRedirectMutation(channelId, (id: string) => api.delete(`${base(channelId)}/redirects/${id}`));

export const useImportRedirects = (channelId: string) =>
  useRedirectMutation(channelId, (csv: string) =>
    api.post<RedirectImportResult>(`${base(channelId)}/redirects/import`, { csv }),
  );

// ---- Bot Rules -----------------------------------------------------------------------------

export const botRulesQuery = (channelId: string) =>
  queryOptions({
    queryKey: siteKeys.botRules(channelId),
    queryFn: ({ signal }) => api.get<BotRules>(`${base(channelId)}/bot-rules`, signal),
  });

export function useUpdateBotRules(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateBotRules) => api.put<BotRules>(`${base(channelId)}/bot-rules`, input),
    onSuccess: (rules) => {
      client.setQueryData(siteKeys.botRules(channelId), rules);
      void client.invalidateQueries({ queryKey: siteKeys.settings(channelId) });
    },
  });
}

// ---- Web domains ---------------------------------------------------------------------------

const domainsBase = (channelId: string) => `/api/v1/channels/${channelId}/domains/web`;

export const webDomainsQuery = (channelId: string) =>
  queryOptions({
    queryKey: siteKeys.domains(channelId),
    queryFn: ({ signal }) => api.get<WebDomainList>(domainsBase(channelId), signal),
  });

function useDomainMutation<I>(channelId: string, call: (input: I) => Promise<WebDomainList>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: (list) => {
      client.setQueryData(siteKeys.domains(channelId), list);
      // The site address and Dispatch web addresses follow the primary hostname.
      void client.invalidateQueries({ queryKey: siteKeys.settings(channelId) });
    },
  });
}

export const useAddWebDomain = (channelId: string) =>
  useDomainMutation(channelId, (input: AddWebDomain) =>
    api.post<WebDomainList>(domainsBase(channelId), input),
  );

export const useRefreshWebDomain = (channelId: string) =>
  useDomainMutation(channelId, (hostnameId: string) =>
    api.post<WebDomainList>(`${domainsBase(channelId)}/${hostnameId}/refresh`),
  );

export const usePrimaryWebDomain = (channelId: string) =>
  useDomainMutation(channelId, (hostnameId: string) =>
    api.post<WebDomainList>(`${domainsBase(channelId)}/${hostnameId}/primary`),
  );

export function useRemoveWebDomain(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (hostnameId: string) => api.delete(`${domainsBase(channelId)}/${hostnameId}`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: siteKeys.domains(channelId) });
      void client.invalidateQueries({ queryKey: siteKeys.settings(channelId) });
    },
  });
}

// ---- Analytics -----------------------------------------------------------------------------

export interface SiteAnalyticsFilter {
  from: string;
  to: string;
  path?: string | undefined;
  source?: string | undefined;
}

export const siteAnalyticsQuery = (channelId: string, filter: SiteAnalyticsFilter) =>
  queryOptions({
    queryKey: [...siteKeys.analytics(channelId), filter],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ from: filter.from, to: filter.to });
      if (filter.path) params.set('path', filter.path);
      if (filter.source) params.set('source', filter.source);
      return api.get<SiteAnalytics>(`${base(channelId)}/analytics?${params}`, signal);
    },
    placeholderData: (previous) => previous,
  });

// ---- A Dispatch on the web -----------------------------------------------------------------

function useWebAction(dispatchId: string, path: 'publish-web' | 'unpublish-web') {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<Dispatch>(`/api/v1/dispatches/${dispatchId}/${path}`),
    onSuccess: (dispatch) => {
      client.setQueryData(sendKeys.dispatch(dispatchId), dispatch);
      void client.invalidateQueries({ queryKey: sendKeys.dispatches(dispatch.channelId) });
      void client.invalidateQueries({ queryKey: siteKeys.sections(dispatch.channelId) });
    },
  });
}

export const usePublishWeb = (dispatchId: string) => useWebAction(dispatchId, 'publish-web');
export const useUnpublishWeb = (dispatchId: string) => useWebAction(dispatchId, 'unpublish-web');
