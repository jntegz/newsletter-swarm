import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';

type ToastTone = 'success' | 'neutral' | 'error';

export interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

type ToastAction =
  { type: 'show'; toast: Toast } | { type: 'dismiss'; id: number } | { type: 'clear' };

/** At most this many toasts show at once; the oldest makes room. */
export const MAX_TOASTS = 3;

/**
 * The toast queue. Showing the same message and tone again replaces the earlier one rather than
 * stacking a duplicate.
 */
export function toastReducer(state: readonly Toast[], action: ToastAction): Toast[] {
  switch (action.type) {
    case 'show': {
      const rest = state.filter(
        (t) => !(t.message === action.toast.message && t.tone === action.toast.tone),
      );
      return [...rest, action.toast].slice(-MAX_TOASTS);
    }
    case 'dismiss':
      return state.filter((t) => t.id !== action.id);
    case 'clear':
      return [];
  }
}

/** How long a toast stays: errors wait for the operator to dismiss them. */
export function toastDuration(tone: ToastTone): number | null {
  return tone === 'error' ? null : 5000;
}

interface ToastApi {
  show: (message: string, tone?: ToastTone) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Shows a toast from anywhere under a ToastProvider. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast needs a ToastProvider.');
  return api;
}

/**
 * Holds the toasts and renders them in a polite live region at the bottom of the screen.
 * Errors are announced assertively. Toasts confirm; they never carry the only copy of a message
 * the operator must act on, so put those in an ErrorNotice next to the cause as well.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, dispatch] = useReducer(toastReducer, []);
  const next = useRef(1);
  const show = useCallback((message: string, tone: ToastTone = 'success') => {
    dispatch({ type: 'show', toast: { id: next.current++, tone, message } });
  }, []);
  const dismiss = useCallback((id: number) => dispatch({ type: 'dismiss', id }), []);
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastRegion toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

const TONE: Record<ToastTone, string> = {
  success: 'text-success',
  neutral: 'text-ink',
  error: 'text-danger',
};

/** The toasts on screen. Exported for the kit page; apps use ToastProvider. */
export function ToastRegion({
  toasts,
  onDismiss,
  inline = false,
}: {
  toasts: readonly Toast[];
  onDismiss: (id: number) => void;
  /** Renders in the page flow instead of fixed to the screen. */
  inline?: boolean;
}) {
  return (
    <div
      className={
        inline
          ? 'grid gap-2'
          : 'pointer-events-none fixed inset-x-4 bottom-4 z-50 grid justify-items-center gap-2 sm:inset-x-auto sm:right-6 sm:justify-items-end'
      }
    >
      <div role="status" aria-live="polite" className="grid gap-2">
        {toasts
          .filter((t) => t.tone !== 'error')
          .map((t) => (
            <ToastCard key={t.id} toast={t} onDismiss={onDismiss} />
          ))}
      </div>
      <div role="alert" aria-live="assertive" className="grid gap-2">
        {toasts
          .filter((t) => t.tone === 'error')
          .map((t) => (
            <ToastCard key={t.id} toast={t} onDismiss={onDismiss} />
          ))}
      </div>
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const ms = toastDuration(toast.tone);
    if (ms === null) return;
    const timer = setTimeout(() => onDismiss(toast.id), ms);
    return () => clearTimeout(timer);
  }, [toast.id, toast.tone, onDismiss]);
  return (
    <div className="pointer-events-auto flex max-w-[420px] items-start gap-3 rounded-[12px] border border-line-app bg-surface px-4 py-3 text-[13.5px] shadow-card">
      <p className={`flex-1 font-semibold ${TONE[toast.tone]}`}>{toast.message}</p>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss"
        className="-my-2 -mr-3 grid size-10 shrink-0 place-items-center rounded-pill text-sub hover:bg-surface-alt hover:text-ink"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        >
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  );
}
