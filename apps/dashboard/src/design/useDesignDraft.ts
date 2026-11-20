// The draft as the studio holds it: one copy in memory that every panel changes, saved by itself
// about 800ms after the last change (sooner for style, so the preview follows), retried when a
// save fails, and kept in memory even after the studio closes until the server has it.
import type { Design, Problem } from '@swarm/site-themes';
import { checkDesign, compileTheme, type CompiledTheme } from '@swarm/site-themes';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { designApi, designKeys, type SiteDesignState } from '../api/design';
import { NOTHING_TO_SAVE, createSaveQueue, type SaveStatus } from '../editor/saveQueue';
import { filesOf, type ThemeChoice } from './draft';
import { uniqueProblems } from './files';

const DRAFT_SAVE_MS = 800;
/** Style changes save this soon, so the preview shows them while the control is still in hand. */
const STYLE_SAVE_MS = 250;
/** How long typing in the code editor waits before the browser checks the files again. */
const CHECK_MS = 200;

/**
 * Drafts not yet stored, by publication. A studio that closes with a save still failing leaves its
 * draft here, and the next one to open picks it up and saves it.
 */
const unsaved = new Map<string, Design>();

interface ChangeOptions {
  /** Save sooner than usual: style changes, so the preview catches up quickly. */
  soon?: boolean;
}

export interface DesignDraft {
  design: Design;
  /** The compiled theme the panels draw from: the latest that compiled, while the code has errors. */
  theme: CompiledTheme | null;
  /** Whether the current files compile. */
  compiles: boolean;
  problems: Problem[];
  save: SaveStatus;
  /** Bumps after every stored draft, so the preview reloads. */
  revision: number;
  change: (update: (design: Design) => Design, options?: ChangeOptions) => void;
  /** A draft the server already holds (after a restore or an import): shown, not saved again. */
  adopt: (design: Design, problems?: Problem[]) => void;
  /** Saves now. Rejects when the save fails (the queue keeps trying). */
  flush: () => Promise<void>;
  pending: () => boolean;
}

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (settled === value) return;
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, settled, ms]);
  return settled;
}

export function useDesignDraft(
  channelId: string,
  server: SiteDesignState,
  themes: readonly ThemeChoice[],
): DesignDraft {
  const client = useQueryClient();
  /** Keeps the cached design in step with what the server holds, for the next time it opens. */
  const stored = (design: Design, problems: Problem[] | undefined, at?: string) =>
    client.setQueryData<SiteDesignState>(designKeys.all(channelId), (old) =>
      old
        ? {
            ...old,
            draft: design,
            draftUpdatedAt: at ?? new Date().toISOString(),
            ...(problems ? { problems } : {}),
          }
        : old,
    );
  const remembered = unsaved.get(channelId);
  const [design, setDesign] = useState<Design>(() => remembered ?? server.draft);
  const current = useRef(design);
  const [save, setSave] = useState<SaveStatus>(NOTHING_TO_SAVE);
  const [revision, setRevision] = useState(0);
  // What the server said about the draft it last stored, and which draft that was.
  const [checked, setChecked] = useState<{ design: Design; problems: Problem[] } | null>(() =>
    remembered ? null : { design: server.draft, problems: server.problems },
  );

  // The queue reads `current` from its timers, never while rendering.
  // eslint-disable-next-line react-hooks/refs
  const [queue] = useState(() =>
    createSaveQueue<Design>({
      debounceMs: DRAFT_SAVE_MS,
      read: () => current.current,
      write: async (sent) => {
        const answer = await designApi.saveDraft(channelId, sent);
        if (current.current === sent) unsaved.delete(channelId);
        if (answer?.problems) setChecked({ design: sent, problems: answer.problems });
        stored(sent, answer?.problems, answer?.draftUpdatedAt);
        setRevision((n) => n + 1);
      },
      onChange: setSave,
    }),
  );

  // React's strict mode mounts twice: the queue opens again. Closing saves what is left, and keeps
  // trying a few times after the studio is gone.
  useEffect(() => {
    queue.open();
    if (unsaved.has(channelId)) queue.changed();
    return () => queue.close(() => undefined);
  }, [queue, channelId]);

  const soonTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(soonTimer.current), []);

  const change = useCallback(
    (update: (design: Design) => Design, options: ChangeOptions = {}) => {
      const next = update(current.current);
      if (next === current.current) return;
      current.current = next;
      unsaved.set(channelId, next);
      setDesign(next);
      queue.changed();
      if (options.soon) {
        clearTimeout(soonTimer.current);
        soonTimer.current = setTimeout(
          () => void queue.flush().catch(() => undefined),
          STYLE_SAVE_MS,
        );
      }
    },
    [queue, channelId],
  );

  const adopt = useCallback(
    (next: Design, problems?: Problem[]) => {
      current.current = next;
      unsaved.delete(channelId);
      setDesign(next);
      if (problems) setChecked({ design: next, problems });
      setRevision((n) => n + 1);
    },
    [channelId],
  );

  // Checks in the browser as people type: the files compile (waiting a moment while code is being
  // typed), then the design is checked against them. The server's answer, once it has this exact
  // draft, is the one that counts.
  const files = filesOf(design, themes);
  const settledFiles = useDebounced(files, CHECK_MS);
  const compiled = useMemo(
    () =>
      settledFiles
        ? compileTheme(settledFiles)
        : {
            theme: null,
            problems: [
              {
                file: 'design',
                line: 1,
                column: 1,
                message: `There is no “${design.theme}” template.`,
                severity: 'error' as const,
              },
            ],
          },
    [settledFiles, design.theme],
  );
  const [lastGood, setLastGood] = useState<CompiledTheme | null>(compiled.theme);
  if (compiled.theme && compiled.theme !== lastGood) setLastGood(compiled.theme);
  const theme = compiled.theme ?? lastGood;

  const problems = useMemo(() => {
    if (checked && checked.design === design) return uniqueProblems(checked.problems);
    const local = [...compiled.problems];
    if (compiled.theme) local.push(...checkDesign(compiled.theme, design));
    return uniqueProblems(local);
  }, [checked, design, compiled]);

  return {
    design,
    theme,
    compiles: !!compiled.theme,
    problems,
    save,
    revision,
    change,
    adopt,
    flush: queue.flush,
    pending: queue.pending,
  };
}
