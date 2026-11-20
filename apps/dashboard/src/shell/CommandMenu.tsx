// Ctrl/⌘K: a native <dialog> with a filter and four groups. Jump to (every page in the rail),
// Create (new post, import, new segment), Subscriber views (the publication's saved views of the
// subscriber list) and Recent (the publication's latest posts).
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from 'react';
import { memberViewsQuery } from '../api/members';
import { dispatchesQuery, useCreateDispatch } from '../api/send';
import { useCurrentChannel } from '../channel';
import * as Icon from '../icons';
import { viewHref } from '../pages/member-views';
import { HOME, SETTINGS } from './nav';
import { useVisibleNav } from './useVisibleNav';

type IconComponent = ComponentType<{ size?: number; className?: string }>;

interface Command {
  id: string;
  label: string;
  group: (typeof GROUPS)[number];
  icon: IconComponent;
  href?: string;
  run?: () => void;
}

const JUMP_ICONS: Record<string, IconComponent> = {
  Home: Icon.Overview,
  Posts: Icon.Doc,
  Templates: Icon.Templates,
  Subscribers: Icon.Members,
  Segments: Icon.Filter,
  'Signup forms': Icon.Card,
  Automations: Icon.Flows,
  'Referrals & growth': Icon.Growth,
  'Paid subscriptions': Icon.Membership,
  Website: Icon.Globe,
  'Sending & delivery': Icon.Send,
  Settings: Icon.Sliders,
};

const GROUPS = ['Jump to', 'Create', 'Subscriber views', 'Recent'] as const;

export function CommandMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  // While the filter field has focus, Enter takes the first result, so that result is marked.
  const [inField, setInField] = useState(true);
  const navigate = useNavigate();
  const { channel } = useCurrentChannel();
  const nav = useVisibleNav();
  const create = useCreateDispatch(channel?.id ?? '');
  const recent = useQuery({ ...dispatchesQuery(channel?.id ?? ''), enabled: open && !!channel });
  const views = useQuery({ ...memberViewsQuery(channel?.id ?? ''), enabled: open && !!channel });

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setQ('');
      dialog.showModal();
      inputRef.current?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // A click on the backdrop (the dialog element itself, outside its box) closes it.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const onClick = (event: MouseEvent) => {
      if (event.target === dialog) onClose();
    };
    dialog.addEventListener('click', onClick);
    return () => dialog.removeEventListener('click', onClick);
  }, [onClose]);

  const commands = useMemo<Command[]>(() => {
    const id = channel?.id;
    const go = (href: string) => () => {
      onClose();
      void navigate({ href });
    };
    const list: Command[] = [HOME, ...nav.flatMap((g) => g.items), SETTINGS].map((item) => ({
      id: `jump-${item.label}`,
      label: item.label,
      group: 'Jump to',
      icon: JUMP_ICONS[item.label] ?? Icon.ChevronRight,
      href: item.href(id),
    }));
    list.push(
      {
        id: 'create-post',
        label: 'New post',
        group: 'Create',
        icon: Icon.Plus,
        run: () => {
          if (!id) return go('/channels/new')();
          create.mutate(
            {},
            {
              onSuccess: (dispatch) => {
                onClose();
                void navigate({
                  to: '/dispatches/$dispatchId',
                  params: { dispatchId: dispatch.id },
                });
              },
            },
          );
        },
      },
      {
        id: 'create-import',
        label: 'Import subscribers',
        group: 'Create',
        icon: Icon.Upload,
        href: id ? `/members/import?channel=${id}` : '/members/import',
      },
      {
        id: 'create-segment',
        label: 'New segment',
        group: 'Create',
        icon: Icon.Filter,
        href: id ? `/circles/new?channel=${id}` : '/circles/new',
      },
    );
    if (id) {
      for (const view of views.data ?? []) {
        list.push({
          id: `view-${view.id}`,
          label: view.name,
          group: 'Subscriber views',
          icon: Icon.Members,
          href: viewHref(id, view),
        });
      }
    }
    for (const post of [...(recent.data ?? [])]
      .filter((d) => d.kind === 'broadcast' && !d.archivedAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 5)) {
      list.push({
        id: `recent-${post.id}`,
        label: post.subject || 'Untitled post',
        group: 'Recent',
        icon: Icon.Clock,
        href: `/dispatches/${post.id}`,
      });
    }
    return list.map((c) => (c.href && !c.run ? { ...c, run: go(c.href) } : c));
  }, [channel?.id, create, nav, navigate, onClose, recent.data, views.data]);

  const query = q.trim().toLowerCase();
  const shown = commands.filter((c) => c.label.toLowerCase().includes(query));

  const items = () => [...(listRef.current?.querySelectorAll<HTMLElement>('[data-command]') ?? [])];
  /** Arrow keys move through the results, from the filter field or from a result. */
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const all = items();
      const at = all.indexOf(event.currentTarget);
      const next =
        event.key === 'ArrowDown' ? (all[at + 1] ?? all[0]) : (all[at - 1] ?? all[all.length - 1]);
      next?.focus();
    }
  };

  return (
    <dialog
      ref={ref}
      aria-label="Command menu"
      onClose={onClose}
      className="mx-auto mt-[12vh] w-[min(560px,calc(100vw-32px))] rounded-card border border-line bg-surface p-0 text-ink shadow-card backdrop:bg-[rgba(17,24,39,0.32)]"
    >
      <div>
        <div className="flex items-center gap-2.5 border-b border-line px-3.5 text-sub">
          <Icon.Search size={18} />
          <input
            ref={inputRef}
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => setInField(true)}
            onBlur={() => setInField(false)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                shown[0]?.run?.();
              } else onKeyDown(event);
            }}
            placeholder="Search or jump to…"
            aria-label="Search or jump to"
            autoComplete="off"
            className="h-[50px] min-w-0 flex-1 bg-transparent text-[17px] text-ink outline-none"
          />
          <kbd className="rounded-[5px] border border-line bg-surface-alt px-1.5 py-1 font-sans text-[12px] font-semibold text-sub">
            Esc
          </kbd>
        </div>
        <div ref={listRef} className="max-h-[360px] overflow-y-auto p-1.5">
          {GROUPS.map((group) => {
            const inGroup = shown.filter((c) => c.group === group);
            if (!inGroup.length) return null;
            // An id can't hold a space: aria-labelledby would read "Jump to" as two ids.
            const headingId = `cmd-${group.toLowerCase().replace(/\s+/g, '-')}`;
            return (
              <div key={group} role="group" aria-labelledby={headingId}>
                <h3
                  id={headingId}
                  className="px-2.5 pt-2.5 pb-1 text-[13px] font-semibold text-sub"
                >
                  {group}
                </h3>
                {inGroup.map((command) => {
                  const CommandIcon = command.icon;
                  const first = inField && command === shown[0];
                  const cls = `flex w-full items-center gap-2.5 rounded-[6px] px-2.5 py-2 text-left text-[15px] text-ink no-underline hover:bg-surface-alt focus-visible:bg-surface-alt focus-visible:outline-offset-[-2px] ${first ? 'bg-surface-alt' : ''}`;
                  const content = (
                    <>
                      <CommandIcon size={18} className="shrink-0 text-sub" />
                      <span className="min-w-0 truncate">{command.label}</span>
                      {first && (
                        <span aria-hidden="true" className="ml-auto text-[12px] text-sub">
                          Enter
                        </span>
                      )}
                    </>
                  );
                  return command.href ? (
                    <a
                      key={command.id}
                      data-command
                      href={command.href}
                      className={cls}
                      onKeyDown={onKeyDown}
                      onClick={(event) => {
                        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                        event.preventDefault();
                        command.run?.();
                      }}
                    >
                      {content}
                    </a>
                  ) : (
                    <button
                      key={command.id}
                      type="button"
                      data-command
                      className={cls}
                      onKeyDown={onKeyDown}
                      disabled={command.id === 'create-post' && create.isPending}
                      onClick={() => command.run?.()}
                    >
                      {content}
                      {command.id === 'create-post' && create.isPending && (
                        <span className="ml-auto text-[13px] text-sub">Creating…</span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
          {shown.length === 0 && (
            <p className="px-2.5 py-4 text-[15px] text-sub">
              Nothing matches. Try a page name, like “Subscribers”.
            </p>
          )}
          {create.error && (
            <p role="alert" className="px-2.5 py-2 text-[13px] text-danger">
              The post wasn’t created: {create.error.message}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-3.5 border-t border-line px-3.5 py-2 text-[13px] text-sub">
          <span>Enter to open</span>
          <span>Arrow keys to move</span>
          <span>Esc to close</span>
        </div>
      </div>
    </dialog>
  );
}
