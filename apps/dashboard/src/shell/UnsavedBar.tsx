// The save model for a form of several fields (DESIGN.md): nothing to press while nothing changed.
// Once a field changes, a bar sticks to the bottom of the window with "Unsaved changes", Discard
// and Save. Leaving or reloading the page asks first. After a save the bar says "Saved" briefly.
// Single toggles, radios and selects save on change instead, with SavedNote.
import { Button } from '@swarm/ui/components';
import { useEffect, useState } from 'react';
import * as Icon from '../icons';

/** Asks before the tab closes or reloads while `dirty`. */
export function useUnsavedGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers need returnValue set to show the prompt.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
}

interface UnsavedBarProps {
  /** Something differs from what is saved. */
  dirty: boolean;
  pending: boolean;
  /** The id of the form Save submits. Without it, Save calls `onSave`. */
  form?: string;
  onSave?: () => void;
  /** Puts every field back to what is saved. */
  onDiscard: () => void;
  /** A save that failed for a reason no field shows. */
  error?: string | null | undefined;
  /** What is unsaved, when a page has more than one bar's worth: "Unsaved changes to …". */
  label?: string;
}

const SAVED_FOR_MS = 3000;

export function UnsavedBar({
  dirty,
  pending,
  form,
  onSave,
  onDiscard,
  error,
  label = 'Unsaved changes',
}: UnsavedBarProps) {
  useUnsavedGuard(dirty);
  // A save that finishes with nothing left to save, and no error, says so for a moment. Worked
  // out while rendering, when `pending` turns false, rather than in an effect.
  const [wasPending, setWasPending] = useState(pending);
  const [saves, setSaves] = useState(0);
  if (pending !== wasPending) {
    setWasPending(pending);
    // A count, not a time: each save restarts the timer below.
    if (!pending && !dirty && !error) setSaves((count) => count + 1);
  }
  useEffect(() => {
    if (!saves) return;
    const timer = setTimeout(() => setSaves(0), SAVED_FOR_MS);
    return () => clearTimeout(timer);
  }, [saves]);
  const saved = saves > 0 && !dirty;

  const showing = dirty || pending;
  return (
    <>
      <div
        hidden={!showing && !saved}
        className="sticky bottom-0 z-20 mt-6 border-t border-line bg-surface py-3"
      >
        {showing ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <p className="text-[14px] font-semibold">{label}</p>
            {error && (
              <p role="alert" className="text-[13px] font-semibold text-danger">
                {error}
              </p>
            )}
            <div className="ml-auto flex gap-2">
              <Button variant="ghost" size="sm" disabled={pending} onClick={onDiscard}>
                Discard
              </Button>
              <Button
                type={form ? 'submit' : 'button'}
                form={form}
                size="sm"
                loading={pending}
                onClick={form ? undefined : onSave}
              >
                Save
              </Button>
            </div>
          </div>
        ) : (
          <p aria-hidden="true" className="flex items-center gap-1.5 text-[14px] text-success">
            <Icon.Check size={16} /> Saved
          </p>
        )}
      </div>
      {/* Outside the bar, so it is in the page even while the bar is hidden. */}
      <p role="status" className="sr-only">
        {saved ? 'Saved' : ''}
      </p>
    </>
  );
}
