// Toasts: a short note after an action, with at most one action of its own, usually Undo. They sit
// at the bottom left of the content (full width along the bottom on a phone), are announced
// politely, and never take focus. A toast waits while the pointer or focus is on it, and while the
// tab is hidden. Ctrl/⌘ Z outside a text field runs the newest toast's action.
// Toasts confirm; they never carry the only copy of something a person must act on.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from 'react';
import * as Icon from '../icons';
import { isTypingTarget } from './keys';

/** How long a toast stays, in ms, unless the caller says otherwise. */
const TOAST_MS = 6000;
/** At most this many toasts show at once; the oldest makes room. */
const MAX_TOASTS = 3;

interface ToastInput {
  message: string;
  /** One action, such as Undo. Running it closes the toast. */
  action?: { label: string; onAction: () => void };
  duration?: number;
}

interface ToastItem extends ToastInput {
  id: number;
}

interface ToastApi {
  show: (toast: ToastInput) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Shows a toast from anywhere in the shell. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast needs the ToastProvider in AppShell.');
  return api;
}

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  const show = useCallback((toast: ToastInput) => {
    const id = next.current++;
    setToasts((current) => [...current, { ...toast, id }].slice(-MAX_TOASTS));
    return id;
  }, []);
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  // Ctrl/⌘ Z runs the newest toast's action, unless a text field or the editor has the key.
  const latest = [...toasts].reverse().find((toast) => toast.action);
  useEffect(() => {
    if (!latest?.action) return;
    const { onAction } = latest.action;
    const onKey = (event: KeyboardEvent) => {
      const mod = mac ? event.metaKey : event.ctrlKey;
      if (!mod || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'z') return;
      if (event.defaultPrevented || isTypingTarget(event.target)) return;
      event.preventDefault();
      dismiss(latest.id);
      onAction();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [latest, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 sm:right-auto sm:bottom-6 sm:max-[1019px]:left-6 min-[1020px]:left-[264px]">
        {/* Always in the page, so screen readers hear a toast the moment it is added. */}
        <div role="status" aria-live="polite" className="grid gap-2">
          {toasts.map((toast) => (
            <ToastCard key={toast.id} toast={toast} onDismiss={dismiss} />
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }) {
  const [held, setHeld] = useState({ pointer: false, focus: false, hidden: false });
  const remaining = useRef(toast.duration ?? TOAST_MS);
  const cardRef = useRef<HTMLDivElement>(null);
  // Where focus was before it came into the toast, to go back there when the toast closes.
  const cameFrom = useRef<HTMLElement | null>(null);
  const waiting = held.pointer || held.focus || held.hidden;

  useEffect(() => {
    const onVisibility = () => setHeld((h) => ({ ...h, hidden: document.hidden }));
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const close = useCallback(() => {
    const card = cardRef.current;
    if (card?.contains(document.activeElement)) {
      const back = cameFrom.current;
      (back?.isConnected ? back : document.getElementById('main'))?.focus({ preventScroll: true });
    }
    onDismiss(toast.id);
  }, [onDismiss, toast.id]);

  useEffect(() => {
    if (waiting) return;
    const started = Date.now();
    const timer = setTimeout(close, remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(1500, remaining.current - (Date.now() - started));
    };
  }, [waiting, close]);

  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const from = event.relatedTarget;
    if (from instanceof HTMLElement && !event.currentTarget.contains(from)) cameFrom.current = from;
    setHeld((h) => ({ ...h, focus: true }));
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setHeld((h) => ({ ...h, focus: false }));
    }
  };

  return (
    <div
      ref={cardRef}
      onPointerEnter={() => setHeld((h) => ({ ...h, pointer: true }))}
      onPointerLeave={() => setHeld((h) => ({ ...h, pointer: false }))}
      onFocus={onFocus}
      onBlur={onBlur}
      className="pointer-events-auto flex items-center gap-2 border-t border-line bg-surface py-2 pr-2 pl-4 pb-[max(8px,env(safe-area-inset-bottom))] text-[14px] text-ink shadow-card transition-[opacity,translate] duration-150 starting:translate-y-2 starting:opacity-0 motion-reduce:transition-none sm:w-max sm:max-w-[480px] sm:rounded-card sm:border sm:pb-2"
    >
      <p className="min-w-0 flex-1 py-1.5">{toast.message}</p>
      {toast.action && (
        <button
          type="button"
          className="btn-quiet btn-sm shrink-0 underline underline-offset-2"
          aria-keyshortcuts={mac ? 'Meta+Z' : 'Control+Z'}
          onClick={() => {
            const { onAction } = toast.action!;
            close();
            onAction();
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={close}
        className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-control text-sub hover:bg-surface-alt hover:text-ink"
      >
        <Icon.Close size={16} />
      </button>
    </div>
  );
}
