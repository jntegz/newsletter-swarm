// The top of the writing area, drawn as the post itself rather than as a form: the cover image,
// the subject as the title, the preview text as the line under it, then a quiet row with what
// kind of post this is and the inbox preview. Enter moves on (subject → preview text → body),
// so a writer can start typing the moment the post opens.
import type { CoverImage } from '@swarm/domain';
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import * as Icon from '../icons';
import { CoverImageField } from './CoverImageField';
import { InboxPreview } from './InboxPreview';

const INBOX_KEY = 'swarm:editor-inbox-preview';

function readInboxOpen(): boolean {
  try {
    return window.localStorage.getItem(INBOX_KEY) === '1';
  } catch {
    return false;
  }
}

function storeInboxOpen(open: boolean) {
  try {
    window.localStorage.setItem(INBOX_KEY, open ? '1' : '0');
  } catch {
    // Storage can be blocked; the choice then lasts for this visit.
  }
}

/** A subject has no line breaks: pasted ones become spaces. */
export const oneLine = (value: string) => value.replace(/\s*[\r\n]+\s*/g, ' ');

export function PostHeader({
  subject,
  preheader,
  subjectMax,
  preheaderMax,
  canWrite,
  kind,
  publication,
  cover,
  channelId,
  fromName,
  firstLine,
  preheaderRef,
  onSubject,
  onPreheader,
  onCover,
  onDone,
}: {
  subject: string;
  preheader: string;
  subjectMax: number;
  preheaderMax: number;
  canWrite: boolean;
  /** "Post" or "Automation email". */
  kind: string;
  publication: string;
  cover: CoverImage | null;
  channelId: string;
  fromName: string;
  /** What inboxes show when there is no preview text. */
  firstLine: string;
  /** The preview text field, so the send panel's "Add preview text" can focus it. */
  preheaderRef: RefObject<HTMLTextAreaElement | null>;
  onSubject: (value: string) => void;
  onPreheader: (value: string) => void;
  onCover: (cover: CoverImage | null) => void;
  /** Leaves the header for the body (Enter in the preview text). */
  onDone: () => void;
}) {
  const subjectId = useId();
  const preheaderId = useId();
  const hintId = useId();
  const inboxId = useId();
  const [inboxOpen, setInboxOpen] = useState(readInboxOpen);
  const title = useRef<HTMLTextAreaElement>(null);
  const preview = preheaderRef;

  // The title and the preview text grow with what's typed instead of scrolling inside themselves.
  useAutoHeight(title, subject);
  useAutoHeight(preview, preheader);
  // A new, empty post starts with the cursor in the title, once the person's role says they can
  // write (it loads just after the post), and only the first time.
  const autoFocused = useRef(false);
  useEffect(() => {
    if (autoFocused.current || !canWrite) return;
    autoFocused.current = true;
    if (!subject.trim() && !document.activeElement?.closest('[contenteditable="true"]')) {
      title.current?.focus();
    }
    // Only when writing becomes possible, not as the subject changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canWrite]);

  const toggleInbox = () => {
    setInboxOpen((open) => {
      storeInboxOpen(!open);
      return !open;
    });
  };

  const previewLength = preheader.length;
  const previewAdvice =
    previewLength === 0
      ? 'Empty: inboxes show the first line'
      : previewLength < 40
        ? 'Short: 40 to 90 reads well on a phone'
        : previewLength <= 90
          ? 'A good length for a phone'
          : 'Long: phones show about 90';

  return (
    <header className="group/header">
      <div className={cover ? 'mb-6' : 'mb-3 -ml-2.5 min-h-8'}>
        <CoverImageField
          channelId={channelId}
          cover={cover}
          canWrite={canWrite}
          onChange={onCover}
          inline
        />
      </div>

      {canWrite ? (
        <>
          <div className="post-field">
            <label htmlFor={subjectId} className="sr-only">
              Subject
            </label>
            <textarea
              ref={title}
              id={subjectId}
              rows={1}
              value={subject}
              maxLength={subjectMax}
              placeholder="Subject"
              autoComplete="off"
              spellCheck
              aria-describedby={hintId}
              className="post-title"
              onChange={(e) => onSubject(oneLine(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  preview.current?.focus();
                }
              }}
            />
          </div>
          <div className="post-field mt-1.5">
            <label htmlFor={preheaderId} className="sr-only">
              Preview text
            </label>
            <textarea
              ref={preview}
              id={preheaderId}
              rows={1}
              value={preheader}
              maxLength={preheaderMax}
              placeholder="Add preview text, shown after the subject in inboxes"
              autoComplete="off"
              aria-describedby={hintId}
              className="post-dek"
              onChange={(e) => onPreheader(oneLine(e.target.value))}
              onKeyDown={(e) => {
                const el = e.currentTarget;
                const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
                const atEnd = el.selectionStart === el.value.length;
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  onDone();
                } else if (e.key === 'ArrowUp' && atStart) {
                  e.preventDefault();
                  title.current?.focus();
                } else if (e.key === 'ArrowDown' && atEnd) {
                  e.preventDefault();
                  onDone();
                }
              }}
            />
          </div>
        </>
      ) : (
        <>
          <p className="post-title">{subject.trim() || 'Untitled post'}</p>
          {preheader.trim() && <p className="post-dek mt-1.5">{preheader}</p>}
        </>
      )}

      <div className="mt-3 flex items-start gap-3 text-[13px] text-sub">
        {/* The kind of post, and in the same place while the header is in use, the lengths. */}
        <div className="grid min-w-0 flex-1 pt-1.5">
          <span
            className={`[grid-area:1/1] ${canWrite ? 'transition-opacity duration-150 sm:group-has-[textarea:focus]/header:opacity-0' : ''} max-sm:hidden`}
          >
            {kind} · {publication}
          </span>
          {canWrite && (
            <span
              id={hintId}
              className="[grid-area:1/1] tabular-nums transition-opacity duration-150 sm:opacity-0 sm:group-has-[textarea:focus]/header:opacity-100"
            >
              Subject {subject.length}/{subjectMax} · Preview text {previewLength}/{preheaderMax} ·{' '}
              {previewAdvice}
            </span>
          )}
          {!canWrite && (
            <span className="sm:hidden">
              {kind} · {publication}
            </span>
          )}
        </div>
        <button
          type="button"
          aria-expanded={inboxOpen}
          aria-controls={inboxId}
          onClick={toggleInbox}
          className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-[6px] px-2 font-semibold text-sub transition-colors hover:bg-surface-alt hover:text-ink"
        >
          <Icon.Mail size={16} />
          Inbox preview
          <Icon.ChevronDown
            size={16}
            className={`transition-transform ${inboxOpen ? 'rotate-180' : ''}`}
          />
        </button>
      </div>
      <div id={inboxId} hidden={!inboxOpen} className="mt-3">
        <InboxPreview
          fromName={fromName}
          subject={subject}
          previewText={preheader}
          firstLine={firstLine}
          bare
        />
      </div>
    </header>
  );
}

const sizesItself =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
    ? CSS.supports('field-sizing', 'content')
    : false;

/**
 * Keeps a one-row textarea as tall as its text. Browsers with `field-sizing: content` (see
 * index.css) do it themselves; elsewhere it is measured on every change, when the column changes
 * width and once the fonts have loaded.
 */
function useAutoHeight(ref: RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || sizesItself) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [ref, value]);
  useEffect(() => {
    const el = ref.current;
    if (!el || sizesItself) return;
    const fit = () => {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    };
    void document.fonts?.ready.then(fit);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(el.parentElement ?? el);
    return () => observer.disconnect();
  }, [ref]);
}
