// The editor's preview, shown in the writing area: the saved post as an email (desktop or
// mobile width, or with forced dark colours) or at web width, as a free or a paid subscriber gets it. It reuses the server
// renders the old dialogs showed: the stored email (which stops at the paywall break for a paid
// post) and the full render from "preview as a member".
import type { Dispatch } from '@swarm/domain';
import { darkEmail } from '@swarm/mail/dark-preview';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { dispatchPreviewQuery, isFeatureDisabled } from '../api/growth';
import { hasGate } from '../site/helpers';

export type PreviewMode = 'edit' | 'desktop' | 'mobile' | 'dark' | 'web';
export type ViewAs = 'free' | 'paid';

/** A paid post with a paywall break goes out as two emails: full, and stopped at the break. */
export const twoEmails = (dispatch: Dispatch) =>
  dispatch.webVisibility === 'paid' && hasGate(dispatch.content);

export function PreviewPane({
  dispatch,
  mode,
  viewAs,
  from,
}: {
  dispatch: Dispatch;
  mode: Exclude<PreviewMode, 'edit'>;
  viewAs: ViewAs;
  from: { name: string; address: string } | null;
}) {
  const split = twoEmails(dispatch);
  const wantsFull = split && viewAs === 'paid';
  const full = useQuery({ ...dispatchPreviewQuery(dispatch.id, null), enabled: wantsFull });
  const fullOff = wantsFull && !!full.error && isFeatureDisabled(full.error);
  const html = wantsFull ? (full.data?.html ?? null) : dispatch.html;
  const dark = useMemo(
    () => (mode === 'dark' && html !== null ? darkEmail(html) : null),
    [mode, html],
  );

  const note = split
    ? viewAs === 'paid'
      ? 'Paid subscribers get the whole post.'
      : 'Free subscribers get the post up to the paywall break, then a prompt to upgrade.'
    : 'Everyone gets the same email. View as matters once a paid post has a paywall break.';

  const width =
    mode === 'mobile'
      ? 'max-w-[375px] rounded-[22px]'
      : mode === 'web'
        ? 'max-w-[860px]'
        : 'max-w-[640px]';

  return (
    <div className="min-h-[calc(100vh-57px)] bg-surface-alt px-3 pt-4 pb-10 sm:px-6 sm:pt-7 sm:pb-24">
      <div className="mx-auto mb-3 flex max-w-[640px] flex-wrap justify-between gap-3 text-[13px] text-sub">
        <span aria-live="polite">{note}</span>
        <span>The saved version, before personalisation</span>
      </div>
      <div
        className={`mx-auto overflow-hidden rounded-card border border-line bg-surface ${width}`}
      >
        {mode === 'web' ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3.5 text-[13px] text-sub">
            <span className="min-w-0 truncate">
              {dispatch.webUrl ?? 'The web address is set when the post is first published.'}
            </span>
            {dispatch.onSite && dispatch.webUrl && (
              <a
                href={dispatch.webUrl}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-purple"
              >
                Open on the website
              </a>
            )}
          </div>
        ) : (
          <div className="grid gap-0.5 border-b border-line px-5 py-3.5 text-[13px] text-sub">
            <span>
              From <b className="font-semibold text-ink">{from?.name ?? 'Your publication'}</b>
              {from && <> &lt;{from.address}&gt;</>}
            </span>
            <span className="mt-1 text-[17px] font-bold text-ink">
              {dispatch.subject || 'No subject yet'}
            </span>
            {dispatch.preheader && <span className="truncate">{dispatch.preheader}</span>}
          </div>
        )}
        {wantsFull && full.isPending && (
          <p role="status" className="px-5 py-8 text-sub">
            Rendering the full email…
          </p>
        )}
        {fullOff && (
          <p className="px-5 py-8 text-sub">
            The full paid version can’t be previewed here for this publication. Send yourself a test
            of the full email from Check &amp; send instead.
          </p>
        )}
        {wantsFull && full.error && !fullOff && (
          <p role="alert" className="px-5 py-8 text-danger">
            No preview: {full.error.message}
          </p>
        )}
        {html !== null && (
          // No scripts, forms or same-origin access: the preview can never act on the dashboard.
          <iframe
            title={mode === 'web' ? 'Web preview' : 'Email preview'}
            sandbox=""
            srcDoc={dark ? dark.html : html}
            className={`block h-[max(480px,calc(100vh-260px))] w-full ${dark ? 'bg-rail' : 'bg-white'}`}
          />
        )}
      </div>
      {mode === 'dark' && (
        <div className="mx-auto mt-3 grid max-w-[640px] gap-2 text-[13px] text-sub">
          <p>
            An approximation of the forced dark colours many mail apps use. Each app does this its
            own way, so send yourself a test to be sure. Images are shown as they are: check any
            logo with a transparent background.
          </p>
          {dark && dark.problems.length > 0 && (
            <div role="status" className="rounded-card bg-warn-soft px-3.5 py-2.5 text-warn">
              <p className="font-semibold">
                {dark.problems.length === 1
                  ? 'This text stays dark and can disappear:'
                  : `${dark.problems.length} pieces of text stay dark and can disappear:`}
              </p>
              <ul className="mt-1 list-disc pl-5">
                {dark.problems.slice(0, 5).map((problem, i) => (
                  <li key={i}>{problem}</li>
                ))}
              </ul>
              <p className="mt-1">Set a background on that text, or remove its colour.</p>
            </div>
          )}
        </div>
      )}
      {mode === 'web' && (
        <p className="mx-auto mt-3 max-w-[860px] text-[13px] text-sub">
          The post at web width. Your website adds its own header, navigation and theme around it.
          {dispatch.content.content.some(
            (block) => (block.attrs as { showOn?: unknown } | undefined)?.showOn,
          ) &&
            ' This view is built from the email, so it leaves out Website only blocks and includes Email only ones. Open the published post to see them as readers will.'}
        </p>
      )}
    </div>
  );
}
