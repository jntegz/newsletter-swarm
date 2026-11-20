/**
 * The post editor's autosave. One save runs at a time, and it reads the document when it starts, so
 * edits made while a save runs join the next one instead of queuing one save per keystroke.
 *
 * Edits and saves are counted: `edit` is the latest change, `stored` the latest change the server
 * has. Nothing else decides whether the page is saved.
 */
export type SaveState = 'saved' | 'unsaved' | 'saving' | 'error';

export interface SaveStatus {
  state: SaveState;
  error: string | null;
  savedAt: Date | null;
}

export const NOTHING_TO_SAVE: SaveStatus = { state: 'saved', error: null, savedAt: null };

/** How long to wait before trying a failed save again. The last delay repeats. */
export const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

/** Once the editor has closed, a save that keeps failing stops after this many attempts. */
export const ATTEMPTS_AFTER_CLOSE = 5;

/** Browsers refuse a keepalive request whose body would take the page past 64 KB. */
const KEEPALIVE_LIMIT_BYTES = 64_000;

/** Whether a request body is small enough to go out as the page closes. */
export function fitsKeepalive(body: string): boolean {
  return new TextEncoder().encode(body).length < KEEPALIVE_LIMIT_BYTES;
}

interface SaveQueueOptions<Payload> {
  debounceMs: number;
  /** The document as it is now. Called as each save starts. */
  read: () => Payload;
  write: (payload: Payload) => Promise<unknown>;
  onChange: (status: SaveStatus) => void;
}

interface SaveQueue {
  /** Call on every edit: saves after a quiet moment. */
  changed: () => void;
  /** Saves now. Resolves once everything edited so far is stored; rejects if a save fails. */
  flush: () => Promise<void>;
  /** True while anything is unsaved or a save is running. */
  pending: () => boolean;
  /** The editor is going away: saves now, and calls back once saved or given up. */
  close: (onSettled: () => void) => void;
  /** The editor is back (React's strict mode mounts everything twice). */
  open: () => void;
}

export function createSaveQueue<Payload>(options: SaveQueueOptions<Payload>): SaveQueue {
  let edit = 0;
  let stored = 0;
  let writing: number | null = null;
  let again = false;
  let failures = 0;
  let error: string | null = null;
  let savedAt: Date | null = null;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let onSettled: (() => void) | null = null;
  let waiters: { target: number; resolve: () => void; reject: (reason: unknown) => void }[] = [];

  const pending = () => writing !== null || edit > stored;

  const announce = () => {
    const state: SaveState = error
      ? 'error'
      : writing !== null
        ? 'saving'
        : edit > stored
          ? 'unsaved'
          : 'saved';
    options.onChange({ state, error, savedAt });
  };

  const settle = () => {
    const gaveUp = failures >= ATTEMPTS_AFTER_CLOSE;
    if (!closed || !onSettled || (pending() && !gaveUp)) return;
    const done = onSettled;
    onSettled = null;
    done();
  };

  const succeeded = () => {
    stored = writing ?? stored;
    writing = null;
    failures = 0;
    error = null;
    savedAt = new Date();
    const ready = waiters.filter((waiter) => waiter.target <= stored);
    waiters = waiters.filter((waiter) => waiter.target > stored);
    ready.forEach((waiter) => waiter.resolve());
    if (again || waiters.length) start();
    announce();
    settle();
  };

  const failed = (reason: unknown) => {
    writing = null;
    again = false;
    failures += 1;
    error = reason instanceof Error ? reason.message : 'The post could not be saved.';
    const told = waiters;
    waiters = [];
    told.forEach((waiter) => waiter.reject(reason));
    if (!closed || failures < ATTEMPTS_AFTER_CLOSE) {
      const delay = RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length) - 1];
      clearTimeout(retry);
      retry = setTimeout(start, delay);
    }
    announce();
    settle();
  };

  function start() {
    if (writing !== null) {
      again = true;
      return;
    }
    again = false;
    if (edit <= stored) return;
    clearTimeout(debounce);
    clearTimeout(retry);
    writing = edit;
    announce();
    let saving: Promise<unknown>;
    try {
      saving = options.write(options.read());
    } catch (reason) {
      saving = Promise.reject(reason);
    }
    saving.then(succeeded, failed);
  }

  return {
    changed: () => {
      edit += 1;
      clearTimeout(debounce);
      debounce = setTimeout(start, options.debounceMs);
      announce();
    },
    flush: () => {
      clearTimeout(debounce);
      if (!pending()) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        waiters.push({ target: edit, resolve, reject });
        start();
      });
    },
    pending,
    close: (settled) => {
      closed = true;
      onSettled = settled;
      failures = 0;
      clearTimeout(debounce);
      if (pending()) start();
      settle();
    },
    open: () => {
      closed = false;
      onSettled = null;
    },
  };
}
