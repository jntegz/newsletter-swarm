// The save model for a single toggle, radio group or select (DESIGN.md): it saves as soon as it
// changes, and a small note next to it says "Saving…", then "Saved" with Undo where the change can
// be taken back. A failed save says so in the same place; the control goes back on its own.
import { useEffect, useState } from 'react';

type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

/** The state of one on-change save: call saving(), then saved() or failed(). "Saved" fades. */
export function useSaveState(clearAfterMs = 6000) {
  const [state, setState] = useState<SaveState>('idle');
  useEffect(() => {
    if (state !== 'saved') return;
    const timer = setTimeout(() => setState('idle'), clearAfterMs);
    return () => clearTimeout(timer);
  }, [state, clearAfterMs]);
  return {
    state,
    saving: () => setState('saving'),
    saved: () => setState('saved'),
    failed: () => setState('failed'),
    reset: () => setState('idle'),
  };
}

export function SavedNote({
  state,
  onUndo,
  failedText = 'Not saved. Try again.',
}: {
  state: SaveState;
  /** Offered while "Saved" shows, for a change that can be taken back. */
  onUndo?: (() => void) | undefined;
  failedText?: string;
}) {
  return (
    <span className="inline-flex min-h-6 items-center gap-2 text-[13px]">
      {/* Always in the page, so screen readers hear each change. */}
      <span role="status" className={state === 'failed' ? 'font-semibold text-danger' : 'text-sub'}>
        {state === 'saving'
          ? 'Saving…'
          : state === 'saved'
            ? 'Saved'
            : state === 'failed'
              ? failedText
              : ''}
      </span>
      {state === 'saved' && onUndo && (
        <button
          type="button"
          onClick={onUndo}
          className="min-h-6 rounded-[6px] px-1 font-semibold text-purple underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple"
        >
          Undo
        </button>
      )}
    </span>
  );
}
