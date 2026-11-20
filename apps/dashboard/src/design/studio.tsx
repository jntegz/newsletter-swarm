// What every panel of the design studio shares: the draft, the theme it draws with, who may change
// what, which panel, section and file are open, and a way to jump to a problem's place.
import type { Problem, SectionInstance } from '@swarm/site-themes';
import { createContext, useContext } from 'react';
import type { DesignStats, SiteDesignState, StatsDays } from '../api/design';
import type { ThemeChoice } from './draft';
import type { DesignDraft } from './useDesignDraft';

export type Panel = 'template' | 'style' | 'sections' | 'code';

export interface DesignSearch {
  panel?: Panel;
  section?: string;
  file?: string;
}

/** Where the code editor should put the cursor next: a problem's file, line and column. */
export interface CodeTarget {
  file: string;
  line: number;
  column: number;
  /** Bumps for each jump, so jumping to the same place twice still moves the cursor. */
  n: number;
}

export interface StudioValue {
  channelId: string;
  /** Editors and up change the design; viewers look. */
  canEdit: boolean;
  /** Admins change the code. */
  canAdmin: boolean;
  themes: ThemeChoice[];
  draft: DesignDraft;
  server: SiteDesignState;
  /** The page's sections in order (the theme's defaults until someone arranges them). */
  sections: SectionInstance[];
  panel: Panel;
  setPanel: (panel: Panel) => void;
  selected: string | null;
  /** Opens a section's settings; `reveal` scrolls the preview to it. */
  select: (id: string | null, options?: { reveal?: boolean }) => void;
  file: string | null;
  setFile: (path: string) => void;
  codeTarget: CodeTarget | null;
  /** Section analytics and A/B test results for the chosen period (undefined while loading). */
  stats: DesignStats | undefined;
  statsError: boolean;
  retryStats: () => void;
  statsDays: StatsDays;
  setStatsDays: (days: StatsDays) => void;
  /** The section whose variant B is being edited, so the preview shows it; null for none. */
  setEditingB: (sectionId: string | null) => void;
  /** Opens the place a problem points at: the code for a file, else the panel it concerns. */
  openProblem: (problem: Problem) => void;
}

export const StudioContext = createContext<StudioValue | null>(null);

export function useStudio(): StudioValue {
  const value = useContext(StudioContext);
  if (!value) throw new Error('useStudio() outside the design studio');
  return value;
}
