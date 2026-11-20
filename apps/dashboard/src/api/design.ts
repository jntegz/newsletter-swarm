// The website's design (docs/site-themes.md, API): the draft and the published design, the built-in
// themes with their files, versions, previews, a theme as one file to export and import, the
// section analytics and A/B test results, and the scheduled publish.
import type { Design, Problem, TestResult, ThemeFiles, Variant } from '@swarm/site-themes';
import { queryOptions } from '@tanstack/react-query';
import { api } from './client';
import type { ThemeExport } from '../design/files';

type DesignPerson = string | { id?: string; name?: string | null; email?: string | null };

interface BuiltInThemeInfo {
  id: string;
  name: string;
  description: string;
  files: ThemeFiles;
}

/** A snapshot of the draft waiting to publish at `at`, or refused at its time (`failed`). */
export interface DesignSchedule {
  at: string;
  by: DesignPerson | null;
  createdAt: string;
  status: 'scheduled' | 'failed';
  /** Why it failed; empty while it waits. */
  problems: Problem[];
}

export interface SiteDesignState {
  draft: Design;
  published: Design | null;
  draftUpdatedAt: string | null;
  publishedAt: string | null;
  publishedBy: DesignPerson | null;
  problems: Problem[];
  themes: BuiltInThemeInfo[];
  /** Missing from an older server; read as none. */
  schedule?: DesignSchedule | null;
}

export interface DesignVersion {
  id: string;
  publishedAt: string;
  publishedBy: DesignPerson | null;
  theme: string;
}

export type PreviewAs = 'visitor' | 'subscriber' | 'paid';

interface DesignPreview {
  url: string;
  expiresAt: string;
}

/** Which variant of the draft's A/B tests a preview draws: B of all of them, or one section's. */
export interface PreviewVariant {
  variant: 'b';
  section?: string;
}

/** The periods the numbers beside the sections are read for. */
export const STATS_DAYS = [7, 30, 90] as const;
export type StatsDays = (typeof STATS_DAYS)[number];

export interface SectionCounts {
  reached: number;
  signups: number;
}

/** One A/B test's result, counted from the day it started (docs/site-themes.md). */
interface SiteTestResult extends TestResult {
  sectionId: string;
  experimentId: string;
  status: 'running' | 'ended';
  startedAt: string;
  endedAt: string | null;
  winner: Variant | null;
}

export interface DesignStats {
  days: number;
  from: string;
  to: string;
  sections: (SectionCounts & { sectionId: string; variant: Variant })[];
  totals: SectionCounts;
  tests: SiteTestResult[];
}

/** What saving the draft answers: its problems, and when it was stored when the server says. */
interface DraftSaved {
  problems?: Problem[];
  draftUpdatedAt?: string;
}

export const designKeys = {
  all: (channelId: string) => ['channels', channelId, 'site', 'design'] as const,
  versions: (channelId: string) => ['channels', channelId, 'site', 'design', 'versions'] as const,
  stats: (channelId: string, days: StatsDays) =>
    ['channels', channelId, 'site', 'design', 'stats', days] as const,
};

const base = (channelId: string) => `/api/v1/channels/${channelId}/site/design`;

export const designQuery = (channelId: string) =>
  queryOptions({
    queryKey: designKeys.all(channelId),
    queryFn: ({ signal }) => api.get<SiteDesignState>(base(channelId), signal),
    // The studio keeps its own copy of the draft while it is open; a refetch would only race it.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

export const designVersionsQuery = (channelId: string) =>
  queryOptions({
    queryKey: designKeys.versions(channelId),
    queryFn: ({ signal }) =>
      api
        .get<{ items: DesignVersion[] }>(`${base(channelId)}/versions`, signal)
        .then((r) => r.items),
  });

export const designStatsQuery = (channelId: string, days: StatsDays) =>
  queryOptions({
    queryKey: designKeys.stats(channelId, days),
    queryFn: ({ signal }) => api.get<DesignStats>(`${base(channelId)}/stats?days=${days}`, signal),
    staleTime: 60_000,
  });

export const designApi = {
  saveDraft: (channelId: string, design: Design) =>
    api.put<DraftSaved | null>(`${base(channelId)}/draft`, design),
  publish: (channelId: string) => api.post<unknown>(`${base(channelId)}/publish`),
  schedule: (channelId: string, at: Date) =>
    api.put<DesignSchedule>(`${base(channelId)}/schedule`, { at: at.toISOString() }),
  cancelSchedule: (channelId: string) => api.delete<unknown>(`${base(channelId)}/schedule`),
  restoreSchedule: (channelId: string) =>
    api.post<DesignSchedule>(`${base(channelId)}/schedule/restore`),
  restore: (channelId: string, versionId: string) =>
    api.post<unknown>(`${base(channelId)}/versions/${versionId}/restore`),
  preview: (channelId: string, as: PreviewAs, variant?: PreviewVariant | null) =>
    api.post<DesignPreview>(`${base(channelId)}/preview`, { as, ...(variant ?? {}) }),
  exportTheme: (channelId: string) => api.get<ThemeExport>(`${base(channelId)}/export`),
  importTheme: (channelId: string, theme: ThemeExport) =>
    api.post<DraftSaved | null>(`${base(channelId)}/import`, theme),
};
