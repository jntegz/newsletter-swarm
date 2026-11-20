import { useRef, type KeyboardEvent, type ReactNode } from 'react';

interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  disabled?: boolean;
}

/**
 * The tab a key moves to (WAI-ARIA tabs, automatic activation): arrows wrap, Home and End jump
 * to the ends, disabled tabs are skipped. Null when the key isn't a tab key or nothing can move.
 */
export function nextTabIndex(
  current: number,
  key: string,
  disabled: readonly boolean[],
): number | null {
  const count = disabled.length;
  if (count === 0) return null;
  const enabled = (i: number) => !disabled[i];
  const walk = (from: number, step: 1 | -1) => {
    for (let n = 1; n <= count; n++) {
      const i = (((from + step * n) % count) + count) % count;
      if (enabled(i)) return i;
    }
    return null;
  };
  switch (key) {
    case 'ArrowRight':
      return walk(current, 1);
    case 'ArrowLeft':
      return walk(current, -1);
    case 'Home':
      return walk(-1, 1);
    case 'End':
      return walk(count, -1);
    default:
      return null;
  }
}

interface TabsProps<T extends string> {
  /** Names the tab list for screen readers. */
  label: string;
  tabs: readonly TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** The id of each tab button; its panel points back with aria-labelledby. */
  idFor: (id: T) => string;
  /** The id of the panel each tab controls. */
  panelFor: (id: T) => string;
  /** Narrower tab padding, for tabs inside a card. */
  compact?: boolean;
  className?: string;
}

/**
 * ARIA tabs with a roving tabindex: only the selected tab is in the Tab order, arrow keys move
 * between tabs (and select them), Home and End jump to the first and last.
 */
export function Tabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
  idFor,
  panelFor,
  compact = false,
  className = 'border-line-app',
}: TabsProps<T>) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = tabs.findIndex((t) => t.id === value);
    const next = nextTabIndex(
      index,
      event.key,
      tabs.map((t) => !!t.disabled),
    );
    const tab = next === null ? undefined : tabs[next];
    if (!tab) return;
    event.preventDefault();
    onChange(tab.id);
    refs.current.get(tab.id)?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className={`flex gap-1 border-b ${className}`}>
      {tabs.map((t) => (
        <button
          key={t.id}
          ref={(node) => {
            if (node) refs.current.set(t.id, node);
            else refs.current.delete(t.id);
          }}
          id={idFor(t.id)}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          aria-controls={panelFor(t.id)}
          tabIndex={value === t.id ? 0 : -1}
          disabled={t.disabled}
          onClick={() => onChange(t.id)}
          onKeyDown={onKeyDown}
          className={`-mb-px min-h-10 border-b-2 ${compact ? 'px-3' : 'px-4'} text-[13.5px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple disabled:cursor-not-allowed disabled:opacity-55 ${
            value === t.id
              ? 'border-purple text-purple-deep'
              : 'border-transparent text-sub hover:text-ink'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** The panel for one tab. Rendering only the selected panel is fine; the ids still match. */
export function TabPanel({
  id,
  labelledBy,
  children,
  className,
}: {
  id: string;
  labelledBy: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div id={id} role="tabpanel" aria-labelledby={labelledBy} tabIndex={0} className={className}>
      {children}
    </div>
  );
}
