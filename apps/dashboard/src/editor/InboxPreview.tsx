// One inbox row as most mail apps draw it: sender, subject in bold, then the preview text, or
// the post's first line when the preview text is empty, as inboxes do.
import { useId } from 'react';

export function InboxPreview({
  fromName,
  subject,
  previewText,
  firstLine,
  bare = false,
}: {
  fromName: string;
  subject: string;
  previewText: string;
  firstLine: string;
  /** Without its own heading, where a button already names it (the editor's header). */
  bare?: boolean;
}) {
  const labelId = useId();
  const initials =
    fromName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join('') || 'S';
  const shown = previewText.trim() || firstLine.trim();
  return (
    <div>
      <p id={labelId} className={bare ? 'sr-only' : 'mb-1.5 text-[15px] font-semibold'}>
        Inbox preview
      </p>
      <div
        role="group"
        aria-labelledby={labelId}
        className="grid grid-cols-[36px_minmax(0,1fr)] gap-x-3 gap-y-0.5 rounded-card bg-surface-alt px-3.5 py-3"
      >
        <span
          aria-hidden="true"
          className="row-span-3 grid size-9 place-items-center rounded-full bg-purple text-[13px] font-bold text-white"
        >
          {initials}
        </span>
        <span className="truncate font-bold">{fromName}</span>
        <span className="truncate font-bold">{subject.trim() || 'No subject yet'}</span>
        <span className="relative truncate text-sub">
          {shown || 'Nothing to show yet: add preview text or start writing.'}
          {!previewText.trim() && shown && (
            <span className="sr-only"> (the post’s first line)</span>
          )}
        </span>
      </div>
    </div>
  );
}
