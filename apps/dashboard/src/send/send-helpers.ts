// The send route's decisions, apart from its rendering so they are tested without a browser.
import type {
  DispatchStatus,
  DispatchSummary,
  PreflightAdvice,
  PreflightCheck,
} from '@swarm/domain';
import { describeAudience } from '../circles/rules';
import { numberFormat } from '../pages/common';

/** Only a post that can still go out has a send route; the rest keep their send report. */
export const showsSendRoute = (status: DispatchStatus) =>
  status === 'draft' || status === 'scheduled';

/** What archiving does and doesn't do, wherever it is offered. */
export const ARCHIVE_NOTE =
  'Archiving tidies your posts list. An archived post keeps its stats and stays on your website. To take a post off the website, use Website in its More options.';

/** The server's rule: a finished post or a past issue, never a draft or a send still to come. */
export const canArchive = (
  post: Pick<DispatchSummary, 'status' | 'importedAt' | 'archivedAt'>,
): boolean =>
  !!post.archivedAt ||
  post.status === 'sent' ||
  post.status === 'canceled' ||
  (post.status === 'draft' && !!post.importedAt);

/**
 * Whether the Write stop is finished. The server's content check decides what counts as content,
 * since a post can be only an image or a button, which have no words to count.
 */
export const writeIsDone = (subject: string, failing: readonly PreflightCheck[]) =>
  !!subject.trim() && failing.length === 0;

/** Who gets it, in one line: segments, what is left out, rosters, then the count once known. */
export function audienceSummary(input: {
  chosen: boolean;
  audience: { include: readonly string[]; exclude: readonly string[] };
  names: ReadonlyMap<string, string>;
  rosters: string | null;
  count: number | null;
}): string {
  if (!input.chosen) return 'Not chosen yet';
  const who = describeAudience(input.audience, input.names);
  const rosters = input.rosters ? `, ${input.rosters}` : '';
  const count = input.count === null ? '' : ` · ${numberFormat.format(input.count)}`;
  return `${who}${rosters}${count}`;
}

/** Why the send button is disabled, or null when it isn't. */
export function sendBlockedReason(input: {
  canSend: boolean;
  canWrite: boolean;
  writeDone: boolean;
  writeProblem: string | undefined;
  whoDone: boolean;
  checking: boolean;
  checksError: string | null;
  ready: boolean;
  firstProblem: string | undefined;
  needsTime: boolean;
}): string | null {
  if (!input.canSend) {
    return input.canWrite
      ? 'An editor or admin sends posts. You can write and send tests.'
      : 'An editor or admin sends posts.';
  }
  if (!input.writeDone) return input.writeProblem ?? 'Add a subject first.';
  if (!input.whoDone) return 'Choose who gets this post first.';
  if (input.checking) return 'Checking the post…';
  if (input.checksError) return `The checks didn’t run: ${input.checksError}`;
  if (!input.ready) return input.firstProblem ?? 'Fix the checks above first.';
  return input.needsTime ? 'Pick a date and time.' : null;
}

/**
 * The content advice the send panel lists. Missing preview text is left out: the panel already
 * has its own row for it, with a button that adds one. An API from before advice existed sends
 * none.
 */
export const inboxAdvice = (advice: readonly PreflightAdvice[] | undefined): PreflightAdvice[] =>
  (advice ?? []).filter((item) => item.id !== 'preview_text');
