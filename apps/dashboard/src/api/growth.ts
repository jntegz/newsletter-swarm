// Queries and mutations for the Phase 6 growth screens: Split Tests and Cohort Sampling on a
// Dispatch, the "as a Member" preview (Smart Blocks), Champions, Ask, Signup Journeys, Series and
// the Funnel Explorer. Routes: workers/api/src/routes/{holdbacks,champions,asks,journeys,series,
// funnel}.ts. An optional feature that is off answers 404 feature_disabled; that is an answer,
// not a hiccup, so those queries never retry it.
import type {
  Ask,
  AskResults,
  AskTextAnswers,
  ChampionAward,
  ChampionLeaderboardEntry,
  ChampionMilestone,
  ChampionReward,
  ChampionSettings,
  CohortSample,
  CreateAsk,
  CreateChampionMilestone,
  CreateChampionReward,
  CreateSeries,
  CreateSignupJourney,
  DispatchPreview,
  Funnel,
  FunnelQueryCut,
  MemberChampion,
  PutCohortSample,
  PutSplitTest,
  Referral,
  ReferralStatus,
  Series,
  SignupJourney,
  SignupJourneyStats,
  SplitTest,
  UpdateAsk,
  UpdateChampionMilestone,
  UpdateChampionReward,
  UpdateChampionSettings,
  UpdateSeries,
  UpdateSignupJourney,
} from '@swarm/domain';
import { keepPreviousData, queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from './client';
import { sendKeys } from './send';
import { isFeatureDisabled } from './site';

export { isFeatureDisabled };

type Page<T> = { items: T[]; nextCursor: string | null };

/** Don't retry an answer: a feature that is off, or a thing that isn't there. */
const retryAnswers = (count: number, error: Error) =>
  !isFeatureDisabled(error) &&
  !(error instanceof ApiError && error.code === 'not_found') &&
  count < 2;

/** True for 404 not_found (as opposed to feature_disabled). */
export const isNotFound = (error: unknown): boolean =>
  error instanceof ApiError && error.code === 'not_found';

const channelBase = (channelId: string) => `/api/v1/channels/${channelId}`;

const growthKeys = {
  splitTest: (dispatchId: string) => ['dispatches', dispatchId, 'split-test'] as const,
  cohortSample: (dispatchId: string) => ['dispatches', dispatchId, 'cohort-sample'] as const,
  preview: (dispatchId: string, memberId: string | null) =>
    ['dispatches', dispatchId, 'preview', { memberId }] as const,
  champions: (channelId: string) => ['channels', channelId, 'champions'] as const,
  asks: (channelId: string) => ['channels', channelId, 'asks'] as const,
  ask: (askId: string) => ['asks', askId] as const,
  journeys: (channelId: string) => ['channels', channelId, 'journeys'] as const,
  journey: (journeyId: string) => ['journeys', journeyId] as const,
  series: (channelId: string) => ['channels', channelId, 'series'] as const,
  funnel: (channelId: string) => ['channels', channelId, 'funnel'] as const,
};

// ---- Split Tests and Cohort Sampling -------------------------------------------------------

/** The Dispatch's Split Test; 404 not_found when it has none, feature_disabled when off. */
export const splitTestQuery = (dispatchId: string) =>
  queryOptions({
    queryKey: growthKeys.splitTest(dispatchId),
    queryFn: ({ signal }) =>
      api.get<SplitTest>(`/api/v1/dispatches/${dispatchId}/split-test`, signal),
    retry: retryAnswers,
  });

export const cohortSampleQuery = (dispatchId: string) =>
  queryOptions({
    queryKey: growthKeys.cohortSample(dispatchId),
    queryFn: ({ signal }) =>
      api.get<CohortSample>(`/api/v1/dispatches/${dispatchId}/cohort-sample`, signal),
    retry: retryAnswers,
  });

function useHoldBackMutation<I, O>(dispatchId: string, call: (input: I) => Promise<O>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: growthKeys.splitTest(dispatchId) });
      void client.invalidateQueries({ queryKey: growthKeys.cohortSample(dispatchId) });
      void client.invalidateQueries({ queryKey: sendKeys.preflight(dispatchId) });
    },
  });
}

export const usePutSplitTest = (dispatchId: string) =>
  useHoldBackMutation(dispatchId, (input: PutSplitTest) =>
    api.put<SplitTest>(`/api/v1/dispatches/${dispatchId}/split-test`, input),
  );

export const useDeleteSplitTest = (dispatchId: string) =>
  useHoldBackMutation(dispatchId, () => api.delete(`/api/v1/dispatches/${dispatchId}/split-test`));

export const usePutCohortSample = (dispatchId: string) =>
  useHoldBackMutation(dispatchId, (input: PutCohortSample) =>
    api.put<CohortSample>(`/api/v1/dispatches/${dispatchId}/cohort-sample`, input),
  );

export const useDeleteCohortSample = (dispatchId: string) =>
  useHoldBackMutation(dispatchId, () =>
    api.delete(`/api/v1/dispatches/${dispatchId}/cohort-sample`),
  );

// ---- Preview as a Member (Smart Blocks) ----------------------------------------------------

/** The saved version as one Member (or, without one, everyone) would get it. */
export const dispatchPreviewQuery = (dispatchId: string, memberId: string | null) =>
  queryOptions({
    queryKey: growthKeys.preview(dispatchId, memberId),
    queryFn: ({ signal }) =>
      api.get<DispatchPreview>(
        `/api/v1/dispatches/${dispatchId}/preview${memberId ? `?memberId=${memberId}` : ''}`,
        signal,
      ),
    retry: retryAnswers,
    staleTime: 0,
  });

/** Whether Smart Blocks are on for the Dispatch's Channel: the preview answers feature_disabled. */
export const smartBlocksProbeQuery = (dispatchId: string) =>
  queryOptions({
    ...dispatchPreviewQuery(dispatchId, null),
    staleTime: 5 * 60_000,
    select: () => true,
  });

// ---- Champions -----------------------------------------------------------------------------

const championsBase = (channelId: string) => `${channelBase(channelId)}/champions`;

export const championSettingsQuery = (channelId: string) =>
  queryOptions({
    queryKey: [...growthKeys.champions(channelId), 'settings'],
    queryFn: ({ signal }) =>
      api.get<ChampionSettings>(`${championsBase(channelId)}/settings`, signal),
  });

export const championRewardsQuery = (channelId: string) =>
  queryOptions({
    queryKey: [...growthKeys.champions(channelId), 'rewards'],
    queryFn: ({ signal }) =>
      api
        .get<{ items: ChampionReward[] }>(`${championsBase(channelId)}/rewards`, signal)
        .then((r) => r.items),
  });

export const championMilestonesQuery = (channelId: string) =>
  queryOptions({
    queryKey: [...growthKeys.champions(channelId), 'milestones'],
    queryFn: ({ signal }) =>
      api
        .get<{ items: ChampionMilestone[] }>(`${championsBase(channelId)}/milestones`, signal)
        .then((r) => r.items),
  });

export const championLeaderboardQuery = (channelId: string, cursor: string | null) =>
  queryOptions({
    queryKey: [...growthKeys.champions(channelId), 'leaderboard', { cursor }],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ limit: '25' });
      if (cursor) params.set('cursor', cursor);
      return api.get<Page<ChampionLeaderboardEntry>>(
        `${championsBase(channelId)}/leaderboard?${params}`,
        signal,
      );
    },
    placeholderData: keepPreviousData,
  });

export const referralsQuery = (
  channelId: string,
  status: ReferralStatus | undefined,
  cursor: string | null,
) =>
  queryOptions({
    queryKey: [...growthKeys.champions(channelId), 'referrals', { status, cursor }],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ limit: '25' });
      if (status) params.set('status', status);
      if (cursor) params.set('cursor', cursor);
      return api.get<Page<Referral>>(`${championsBase(channelId)}/referrals?${params}`, signal);
    },
    placeholderData: keepPreviousData,
  });

export const awardsQuery = (
  channelId: string,
  status: ChampionAward['status'] | undefined,
  cursor: string | null,
) =>
  queryOptions({
    queryKey: [...growthKeys.champions(channelId), 'awards', { status, cursor }],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ limit: '25' });
      if (status) params.set('status', status);
      if (cursor) params.set('cursor', cursor);
      return api.get<Page<ChampionAward>>(`${championsBase(channelId)}/awards?${params}`, signal);
    },
    placeholderData: keepPreviousData,
  });

export const memberChampionQuery = (channelId: string, memberId: string) =>
  queryOptions({
    queryKey: [...growthKeys.champions(channelId), 'member', memberId],
    queryFn: ({ signal }) =>
      api.get<MemberChampion>(`${channelBase(channelId)}/members/${memberId}/champion`, signal),
  });

function useChampionsMutation<I, O>(channelId: string, call: (input: I) => Promise<O>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: () => client.invalidateQueries({ queryKey: growthKeys.champions(channelId) }),
  });
}

export const useUpdateChampionSettings = (channelId: string) =>
  useChampionsMutation(channelId, (input: UpdateChampionSettings) =>
    api.patch<ChampionSettings>(`${championsBase(channelId)}/settings`, input),
  );

export const useCreateReward = (channelId: string) =>
  useChampionsMutation(channelId, (input: CreateChampionReward) =>
    api.post<ChampionReward>(`${championsBase(channelId)}/rewards`, input),
  );

export const useUpdateReward = (channelId: string) =>
  useChampionsMutation(channelId, ({ id, ...input }: UpdateChampionReward & { id: string }) =>
    api.patch<ChampionReward>(`${championsBase(channelId)}/rewards/${id}`, input),
  );

export const useCreateMilestone = (channelId: string) =>
  useChampionsMutation(channelId, (input: CreateChampionMilestone) =>
    api.post<ChampionMilestone>(`${championsBase(channelId)}/milestones`, input),
  );

export const useUpdateMilestone = (channelId: string) =>
  useChampionsMutation(channelId, ({ id, ...input }: UpdateChampionMilestone & { id: string }) =>
    api.patch<ChampionMilestone>(`${championsBase(channelId)}/milestones/${id}`, input),
  );

export const useDeleteMilestone = (channelId: string) =>
  useChampionsMutation(channelId, (id: string) =>
    api.delete(`${championsBase(channelId)}/milestones/${id}`),
  );

export const useReviewReferral = (channelId: string) =>
  useChampionsMutation(channelId, ({ id, approve }: { id: string; approve: boolean }) =>
    api.post<Referral>(
      `${championsBase(channelId)}/referrals/${id}/${approve ? 'approve' : 'reject'}`,
    ),
  );

export const useFulfilAward = (channelId: string) =>
  useChampionsMutation(channelId, ({ id, detail }: { id: string; detail: string | null }) =>
    api.post<ChampionAward>(`${championsBase(channelId)}/awards/${id}/fulfil`, { detail }),
  );

// ---- Ask -----------------------------------------------------------------------------------

export const asksQuery = (channelId: string) =>
  queryOptions({
    queryKey: growthKeys.asks(channelId),
    queryFn: ({ signal }) => api.get<Ask[]>(`${channelBase(channelId)}/asks`, signal),
  });

export const askQuery = (askId: string) =>
  queryOptions({
    queryKey: growthKeys.ask(askId),
    queryFn: ({ signal }) => api.get<Ask>(`/api/v1/asks/${askId}`, signal),
    retry: retryAnswers,
  });

export const askResultsQuery = (askId: string, circleId: string | null) =>
  queryOptions({
    queryKey: [...growthKeys.ask(askId), 'results', { circleId }],
    queryFn: ({ signal }) =>
      api.get<AskResults>(
        `/api/v1/asks/${askId}/results${circleId ? `?circleId=${circleId}` : ''}`,
        signal,
      ),
    placeholderData: keepPreviousData,
  });

export const askAnswersQuery = (askId: string, questionId: string, cursor: string | null) =>
  queryOptions({
    queryKey: [...growthKeys.ask(askId), 'answers', questionId, { cursor }],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ limit: '20' });
      if (cursor) params.set('cursor', cursor);
      return api.get<AskTextAnswers>(
        `/api/v1/asks/${askId}/questions/${questionId}/answers?${params}`,
        signal,
      );
    },
    placeholderData: keepPreviousData,
  });

export function useCreateAsk(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAsk) => api.post<Ask>(`${channelBase(channelId)}/asks`, input),
    onSuccess: (ask) => {
      client.setQueryData(growthKeys.ask(ask.id), ask);
      void client.invalidateQueries({ queryKey: growthKeys.asks(channelId) });
    },
  });
}

export function useUpdateAsk(ask: Pick<Ask, 'id' | 'channelId'>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateAsk) => api.patch<Ask>(`/api/v1/asks/${ask.id}`, input),
    onSuccess: (saved) => {
      client.setQueryData(growthKeys.ask(ask.id), saved);
      void client.invalidateQueries({ queryKey: growthKeys.asks(ask.channelId) });
    },
  });
}

export function useDeleteAsk(ask: Pick<Ask, 'id' | 'channelId'>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete(`/api/v1/asks/${ask.id}`),
    onSuccess: () => {
      client.removeQueries({ queryKey: growthKeys.ask(ask.id) });
      void client.invalidateQueries({ queryKey: growthKeys.asks(ask.channelId) });
    },
  });
}

/** Downloads a file the API answers with (CSV), keeping the session cookie. */
export async function downloadFile(path: string, filename: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin' });
  } catch {
    throw new ApiError('network', 'Swarm could not be reached. Check your connection.', 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { code: ApiError['code']; message: string };
    } | null;
    throw new ApiError(
      body?.error?.code ?? 'internal',
      body?.error?.message ?? 'The file could not be downloaded.',
      res.status,
    );
  }
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- Signup Journeys -----------------------------------------------------------------------

export const journeysQuery = (channelId: string) =>
  queryOptions({
    queryKey: growthKeys.journeys(channelId),
    queryFn: ({ signal }) => api.get<SignupJourney[]>(`${channelBase(channelId)}/journeys`, signal),
    retry: retryAnswers,
  });

export const journeyQuery = (journeyId: string) =>
  queryOptions({
    queryKey: growthKeys.journey(journeyId),
    queryFn: ({ signal }) => api.get<SignupJourney>(`/api/v1/journeys/${journeyId}`, signal),
    retry: retryAnswers,
  });

export const journeyStatsQuery = (journeyId: string, days: number) =>
  queryOptions({
    queryKey: [...growthKeys.journey(journeyId), 'stats', days],
    queryFn: ({ signal }) =>
      api.get<SignupJourneyStats>(`/api/v1/journeys/${journeyId}/stats?days=${days}`, signal),
    placeholderData: keepPreviousData,
  });

export function useCreateJourney(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSignupJourney) =>
      api.post<SignupJourney>(`${channelBase(channelId)}/journeys`, input),
    onSuccess: (journey) => {
      client.setQueryData(growthKeys.journey(journey.id), journey);
      void client.invalidateQueries({ queryKey: growthKeys.journeys(channelId) });
    },
  });
}

function useJourneyMutation<I>(
  journey: Pick<SignupJourney, 'id' | 'channelId'>,
  call: (input: I) => Promise<SignupJourney>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: (saved) => {
      client.setQueryData(growthKeys.journey(journey.id), saved);
      void client.invalidateQueries({ queryKey: growthKeys.journeys(journey.channelId) });
    },
  });
}

export const useUpdateJourney = (journey: Pick<SignupJourney, 'id' | 'channelId'>) =>
  useJourneyMutation(journey, (input: UpdateSignupJourney) =>
    api.patch<SignupJourney>(`/api/v1/journeys/${journey.id}`, input),
  );

export const usePromoteJourney = (journey: Pick<SignupJourney, 'id' | 'channelId'>) =>
  useJourneyMutation(journey, (variant: string) =>
    api.post<SignupJourney>(`/api/v1/journeys/${journey.id}/promote`, { variant }),
  );

export function useDeleteJourney(journey: Pick<SignupJourney, 'id' | 'channelId'>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete(`/api/v1/journeys/${journey.id}`),
    onSuccess: () => {
      client.removeQueries({ queryKey: growthKeys.journey(journey.id) });
      void client.invalidateQueries({ queryKey: growthKeys.journeys(journey.channelId) });
    },
  });
}

// ---- Series --------------------------------------------------------------------------------

export const seriesListQuery = (channelId: string) =>
  queryOptions({
    queryKey: growthKeys.series(channelId),
    queryFn: ({ signal }) =>
      api.get<{ items: Series[] }>(`${channelBase(channelId)}/series`, signal).then((r) => r.items),
    retry: retryAnswers,
  });

export const seriesQuery = (channelId: string, seriesId: string) =>
  queryOptions({
    queryKey: [...growthKeys.series(channelId), seriesId],
    queryFn: ({ signal }) =>
      api.get<Series>(`${channelBase(channelId)}/series/${seriesId}`, signal),
    retry: retryAnswers,
  });

function useSeriesMutation<I, O>(channelId: string, call: (input: I) => Promise<O>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: () => client.invalidateQueries({ queryKey: growthKeys.series(channelId) }),
  });
}

export const useCreateSeries = (channelId: string) =>
  useSeriesMutation(channelId, (input: CreateSeries) =>
    api.post<Series>(`${channelBase(channelId)}/series`, input),
  );

export const useUpdateSeries = (channelId: string, seriesId: string) =>
  useSeriesMutation(channelId, (input: UpdateSeries) =>
    api.patch<Series>(`${channelBase(channelId)}/series/${seriesId}`, input),
  );

export const useDeleteSeries = (channelId: string, seriesId: string) =>
  useSeriesMutation(channelId, () => api.delete(`${channelBase(channelId)}/series/${seriesId}`));

// ---- Funnel Explorer -----------------------------------------------------------------------

export interface FunnelParams {
  from: string;
  to: string;
  cut: FunnelQueryCut;
  filters: Partial<
    Record<'source' | 'utmSource' | 'utmMedium' | 'utmCampaign' | 'formId' | 'championId', string>
  >;
}

export const funnelQuery = (channelId: string, params: FunnelParams) =>
  queryOptions({
    queryKey: [...growthKeys.funnel(channelId), params],
    queryFn: ({ signal }) => {
      const search = new URLSearchParams({ from: params.from, to: params.to, cut: params.cut });
      for (const [key, value] of Object.entries(params.filters)) {
        if (value !== undefined) search.set(key, value);
      }
      return api.get<Funnel>(`${channelBase(channelId)}/analytics/funnel?${search}`, signal);
    },
    placeholderData: keepPreviousData,
  });
