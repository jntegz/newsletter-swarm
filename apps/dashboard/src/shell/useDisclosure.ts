import { useCallback, useEffect, useId, useState, type KeyboardEvent } from 'react';

const ITEMS = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled])';

/**
 * A button that shows a small panel below it (publication switcher, New post, insert menu).
 * The disclosure pattern: Escape and a click outside close it, focus goes to the first item on
 * open and back to the button on Escape; the arrow keys move between the panel's items.
 * Spread `buttonProps` on the button and `panelProps` on the panel; the two find each other by id.
 */
export function useDisclosure() {
  const [open, setOpen] = useState(false);
  const buttonId = useId();
  const panelId = useId();

  const close = useCallback(
    (returnFocus = false) => {
      setOpen(false);
      if (returnFocus) document.getElementById(buttonId)?.focus();
    },
    [buttonId],
  );

  useEffect(() => {
    if (!open) return;
    const panel = document.getElementById(panelId);
    panel?.querySelector<HTMLElement>(ITEMS)?.focus();
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panel?.contains(target) || document.getElementById(buttonId)?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close(true);
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close, buttonId, panelId]);

  /** Arrow keys move between the panel's items; Tab works as usual. */
  const onPanelKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [
      ...(document.getElementById(panelId)?.querySelectorAll<HTMLElement>(ITEMS) ?? []),
    ];
    if (!items.length) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'ArrowDown'
        ? (items[at + 1] ?? items[0])
        : (items[at - 1] ?? items[items.length - 1]);
    next?.focus();
  };

  return {
    open,
    setOpen,
    close,
    buttonProps: {
      id: buttonId,
      'aria-expanded': open,
      'aria-controls': panelId,
      onClick: () => setOpen((value) => !value),
    },
    panelProps: { id: panelId, hidden: !open, onKeyDown: onPanelKeyDown },
  };
}
