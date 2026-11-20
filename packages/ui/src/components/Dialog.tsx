import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  actions: ReactNode;
}

/**
 * A modal built on the native <dialog>: the browser traps focus, closes it on Escape,
 * marks the rest of the page inert and returns focus to the trigger when it closes. The title and
 * actions stay put and only the middle scrolls, so a long form never loses its buttons. When the
 * middle does scroll, it can be focused, so the keyboard can scroll it too.
 */
export function Dialog({ open, onClose, title, description, children, actions }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  const body = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const el = body.current;
    if (!open || !el) return;
    const check = () => setScrolls(el.scrollHeight > el.clientHeight + 1);
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(check);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    if (el.lastElementChild) observer.observe(el.lastElementChild);
    return () => observer.disconnect();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onClose={onClose}
      className="m-auto max-h-[calc(100dvh-32px)] w-[min(460px,calc(100%-32px))] overflow-hidden rounded-card-app border border-line-app bg-surface p-0 text-ink shadow-card backdrop:bg-[rgba(15,15,18,0.32)]"
    >
      <div className="flex max-h-[calc(100dvh-34px)] flex-col">
        <h2 id={titleId} className="px-6 pt-6 text-[19px] font-semibold tracking-[-0.025em]">
          {title}
        </h2>
        {(description || children) && (
          <div
            ref={body}
            className="min-h-0 flex-1 overflow-y-auto px-6 pt-2 pb-1"
            {...(scrolls ? { tabIndex: 0, role: 'region', 'aria-labelledby': titleId } : {})}
          >
            {description && (
              <div id={descriptionId} className="text-[14px] leading-[1.55] text-sub">
                {description}
              </div>
            )}
            {children && <div className={description ? 'mt-4 pb-5' : 'mt-2 pb-5'}>{children}</div>}
          </div>
        )}
        <div
          className={`flex flex-wrap justify-end gap-2 px-6 pb-6 ${children ? 'border-t border-line pt-4' : 'pt-5'}`}
        >
          {actions}
        </div>
      </div>
    </dialog>
  );
}
