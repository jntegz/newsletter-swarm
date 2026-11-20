// The editor's keyboard layer: the page-level shortcuts (save, focus mode, this list), the list
// itself, and the small measures the sticky bars need. Formatting shortcuts live in TipTap.
import { Button, Dialog } from '@swarm/ui/components';
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
/** The modifier as people see it on their keyboard. */
export const MOD = mac ? '⌘' : 'Ctrl';
const ALT = mac ? '⌥' : 'Alt';
const SHIFT = mac ? '⇧' : 'Shift';

/** Minutes to read at about 230 words a minute, as a short phrase. */
export function readingTime(words: number): string {
  if (words === 0) return 'nothing to read yet';
  const minutes = Math.max(1, Math.round(words / 230));
  return `${minutes} min read`;
}

/** Whether a key event is the page shortcut `key` with Ctrl/⌘ (and Shift when asked). */
export function isShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  key: string,
  { shift = false }: { shift?: boolean } = {},
): boolean {
  const mod = mac ? event.metaKey : event.ctrlKey;
  return mod && !event.altKey && event.shiftKey === shift && event.key.toLowerCase() === key;
}

/**
 * Page shortcuts while a post is open: Ctrl/⌘ S saves now (instead of the browser saving the
 * page), Ctrl/⌘ \ turns focus mode on and off, Ctrl/⌘ / shows the list, Escape leaves focus mode.
 * Escape is left alone while a menu, a dialog or the slash menu is open: they close first.
 */
export function useEditorShortcuts({
  onSave,
  onFocus,
  onShortcuts,
  onLeaveFocus,
}: {
  onSave: (() => void) | undefined;
  onFocus: () => void;
  onShortcuts: () => void;
  onLeaveFocus: (() => void) | undefined;
}) {
  const handlers = useRef({ onSave, onFocus, onShortcuts, onLeaveFocus });
  useLayoutEffect(() => {
    handlers.current = { onSave, onFocus, onShortcuts, onLeaveFocus };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const h = handlers.current;
      if (isShortcut(event, 's')) {
        event.preventDefault();
        h.onSave?.();
      } else if (isShortcut(event, '\\')) {
        event.preventDefault();
        h.onFocus();
      } else if (isShortcut(event, '/')) {
        event.preventDefault();
        h.onShortcuts();
      } else if (
        event.key === 'Escape' &&
        h.onLeaveFocus &&
        // ProseMirror cancels every Escape, so that says nothing. Menus and the slash menu stop it
        // before it gets here; an open dialog closes first.
        !document.querySelector('dialog[open]')
      ) {
        h.onLeaveFocus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/**
 * Keeps `--editor-bar` on `root` equal to the height of the sticky editor bar, so the toolbar and
 * the side panel stick just below it however many lines the bar wraps onto.
 */
export function useStickyBarHeight(
  root: RefObject<HTMLElement | null>,
  bar: RefObject<HTMLElement | null>,
) {
  useLayoutEffect(() => {
    const rootEl = root.current;
    const barEl = bar.current;
    if (!rootEl || !barEl) return;
    const apply = () => rootEl.style.setProperty('--editor-bar', `${barEl.offsetHeight}px`);
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(apply);
    observer.observe(barEl);
    return () => observer.disconnect();
  }, [root, bar]);
}

interface Shortcut {
  keys: string[];
  does: string;
}

const GROUPS: { title: string; items: Shortcut[] }[] = [
  {
    title: 'The post',
    items: [
      { keys: [MOD, 'S'], does: 'Save now' },
      { keys: [MOD, '\\'], does: 'Focus mode on or off' },
      { keys: ['Esc'], does: 'Leave focus mode' },
      { keys: ['Enter'], does: 'From the subject to the preview text, then to the post' },
      { keys: [MOD, 'K'], does: 'Search or jump to a page' },
      { keys: [MOD, '/'], does: 'This list' },
    ],
  },
  {
    title: 'Writing',
    items: [
      { keys: ['/'], does: 'Insert a block (on an empty line)' },
      { keys: [MOD, 'B'], does: 'Bold' },
      { keys: [MOD, 'I'], does: 'Italic' },
      { keys: [MOD, 'U'], does: 'Underline' },
      { keys: [MOD, SHIFT, 'S'], does: 'Strikethrough' },
      { keys: [MOD, 'E'], does: 'Inline code' },
      { keys: [MOD, 'Z'], does: 'Undo' },
      { keys: mac ? [MOD, SHIFT, 'Z'] : ['Ctrl', 'Y'], does: 'Redo' },
      { keys: [ALT, '↑'], does: 'Move the block up' },
      { keys: [ALT, '↓'], does: 'Move the block down' },
    ],
  },
  {
    title: 'Type at the start of a line',
    items: [
      { keys: ['##', 'Space'], does: 'Heading' },
      { keys: ['###', 'Space'], does: 'Subheading' },
      { keys: ['-', 'Space'], does: 'Bulleted list' },
      { keys: ['1.', 'Space'], does: 'Numbered list' },
      { keys: ['>', 'Space'], does: 'Quote' },
      { keys: ['---'], does: 'Divider' },
    ],
  },
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      open
      onClose={onClose}
      title="Keyboard shortcuts"
      description="For writing without reaching for the mouse."
      actions={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="grid gap-6">
        {GROUPS.map((group) => (
          <section key={group.title}>
            <h3 className="mb-2 text-[15px] font-semibold">{group.title}</h3>
            <dl className="grid gap-1.5">
              {group.items.map((item) => (
                <div
                  key={item.does}
                  className="flex items-baseline justify-between gap-4 text-[13.5px]"
                >
                  <dt className="text-sub">{item.does}</dt>
                  <dd className="flex shrink-0 gap-1">
                    {item.keys.map((key) => (
                      <kbd
                        key={key}
                        className="min-w-6 rounded-[5px] border border-line-control bg-surface-alt px-1.5 text-center font-mono text-[12px] leading-[20px] text-ink"
                      >
                        {key}
                      </kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
