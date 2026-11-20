// The Line shell: a dark rail drawn as a transit line (publication switcher, grouped stations,
// Settings and the signed-in person), and a top bar with the breadcrumb and the command menu.
// Below 1020px the rail folds into a top bar whose menu button opens it as a drawer.
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { api } from './api/client';
import { CurrentChannelProvider, useCurrentChannel } from './channel';
import * as Icon from './icons';
import { ROLE_LABEL, useSession } from './session';
import { CommandMenu } from './shell/CommandMenu';
import { ToastProvider } from './shell/toast';
import { HOME, SETTINGS, crumbsFor, linkTarget, type NavItem } from './shell/nav';
import { useVisibleNav } from './shell/useVisibleNav';
import { PageTitleProvider, usePageTitleValue } from './shell/pageTitle';
import { useDisclosure } from './shell/useDisclosure';
import { useWritingFocus } from './shell/focusMode';
import { tabTitle, useTabStatusValue } from './shell/tabStatus';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <CurrentChannelProvider>
      <PageTitleProvider>
        <Frame>{children}</Frame>
      </PageTitleProvider>
    </CurrentChannelProvider>
  );
}

function Frame({ children }: { children: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Close the drawer whenever navigation happens.
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setDrawerOpen(false);
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Focus mode (the editor's): the rail and the top bar step away. Ctrl/⌘K still works.
  const focus = useWritingFocus();

  return (
    <div
      className={`min-h-screen ${focus ? '' : 'min-[1020px]:grid min-[1020px]:grid-cols-[240px_minmax(0,1fr)]'}`}
    >
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-control focus:bg-surface focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      {!focus && (
        <Rail
          open={drawerOpen}
          onToggle={() => setDrawerOpen((o) => !o)}
          onClose={() => setDrawerOpen(false)}
        />
      )}
      <ToastProvider>
        <div className="flex min-w-0 flex-col">
          {!focus && <TopBar onSearch={() => setCommandOpen(true)} />}
          <main id="main" className="w-full flex-1 px-4 pt-6 pb-12 sm:px-8">
            {children}
          </main>
          {!focus && (
            <footer className="px-4 pb-6 text-[13px] text-sub sm:px-8">
              Created by{' '}
              <a
                href="https://github.com/jntegz"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sub underline-offset-2 hover:underline"
              >
                Jan Tegze
              </a>
            </footer>
          )}
        </div>
        <CommandMenu open={commandOpen} onClose={() => setCommandOpen(false)} />
        <DocumentTitle />
      </ToastProvider>
    </div>
  );
}

// ---- Rail -------------------------------------------------------------------------------------

function Rail({
  open,
  onToggle,
  onClose,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { channel } = useCurrentChannel();
  const nav = useVisibleNav();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const station = (item: NavItem, className?: string) => (
    <Link
      {...linkTarget(item.href(channel?.id))}
      className={className}
      activeOptions={{ exact: true, includeSearch: false }}
      {...(item.matches(pathname) ? { 'aria-current': 'page' as const } : {})}
    >
      {item.label}
    </Link>
  );

  return (
    <aside
      aria-label="Main navigation"
      className="on-rail sticky top-0 z-30 flex flex-col bg-rail text-rail-text min-[1020px]:h-screen"
    >
      <div className="flex h-14 shrink-0 items-center gap-2 pr-2 pl-4 min-[1020px]:h-[60px] min-[1020px]:px-5">
        <Link
          to="/"
          className="inline-flex items-center gap-2.5 text-[17px] font-bold tracking-[-0.01em] text-white no-underline"
        >
          <Icon.LineMark />
          Swarm
        </Link>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls="rail-body"
          aria-label={open ? 'Close navigation' : 'Open navigation'}
          className="ml-auto grid size-10 place-items-center rounded-control text-rail-text transition-colors hover:bg-rail-2 hover:text-white min-[1020px]:hidden"
        >
          {open ? <Icon.Close /> : <Icon.Menu />}
        </button>
      </div>
      <div
        id="rail-body"
        className={`flex-1 flex-col overflow-y-auto px-4 pt-3 pb-5 max-[1019px]:fixed max-[1019px]:inset-x-0 max-[1019px]:top-14 max-[1019px]:bottom-0 max-[1019px]:border-t max-[1019px]:border-rail-line max-[1019px]:bg-rail min-[1020px]:flex min-[1020px]:px-3 min-[1020px]:pt-0.5 min-[1020px]:pb-3 ${
          open ? 'flex' : 'hidden'
        }`}
      >
        <PublicationSwitcher />
        <nav aria-label="Sections">
          <ol className="line-nav">
            <li className="line-stn">{station(HOME, 'line-stn-label')}</li>
            {nav.map((group) => (
              <li key={group.label} className="line-stn">
                <span className="line-stn-label">{group.label}</span>
                <ul className="line-items">
                  {group.items.map((item) => (
                    <li key={item.label}>{station(item)}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </nav>
        <div className="mt-auto pt-[18px]">
          <Link
            to={SETTINGS.href(undefined)}
            activeOptions={{ exact: false, includeSearch: false }}
            className="flex min-h-9 items-center gap-2.5 rounded-[6px] px-2.5 text-rail-text no-underline transition-colors hover:bg-white/5 hover:text-white aria-[current=page]:bg-rail-2 aria-[current=page]:font-semibold aria-[current=page]:text-white"
            {...(SETTINGS.matches(pathname) ? { 'aria-current': 'page' as const } : {})}
          >
            <Icon.Sliders className="text-rail-muted" />
            Settings
          </Link>
          <PersonMenu />
        </div>
      </div>
    </aside>
  );
}

function PublicationSwitcher() {
  const { channels, channel, select, isPending } = useCurrentChannel();
  const { can } = useSession();
  const menu = useDisclosure();

  if (isPending) {
    return (
      <div
        aria-hidden="true"
        className="mb-[18px] h-[50px] rounded-control border border-rail-line"
      />
    );
  }
  if (!channel) {
    return can('admin') ? (
      <Link
        to="/channels/new"
        className="mb-[18px] flex items-center gap-2 rounded-control border border-rail-line px-2.5 py-2.5 text-[15px] font-semibold text-white no-underline hover:bg-rail-2"
      >
        <Icon.Plus />
        Create a publication
      </Link>
    ) : null;
  }

  return (
    <div className="relative mb-[18px]">
      <button
        type="button"
        {...menu.buttonProps}
        aria-label={`Publication: ${channel.name}. Switch publication`}
        className="flex w-full items-center gap-2 rounded-control border border-rail-line px-2.5 py-[7px] text-left text-[15px] leading-[1.3] font-semibold text-white transition-colors hover:bg-rail-2 aria-expanded:bg-rail-2"
      >
        <span className="min-w-0">
          <span className="block truncate">{channel.name}</span>
          <small className="block truncate text-[13px] font-normal text-rail-muted">
            {channel.slug}
          </small>
        </span>
        <Icon.ChevronDown className="ml-auto shrink-0 text-rail-muted" />
      </button>
      <div {...menu.panelProps} className="line-menu absolute inset-x-0 top-[calc(100%+6px)]">
        <ul aria-label="Publications">
          {channels.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="line-menu-item"
                aria-current={c.id === channel.id ? 'true' : undefined}
                onClick={() => {
                  menu.close();
                  if (c.id !== channel.id) select(c.id);
                }}
              >
                <span className="min-w-0">
                  <span className="block truncate">{c.name}</span>
                  <small className="block truncate text-[13px] text-sub">{c.slug}</small>
                </span>
                {c.id === channel.id && <Icon.Check className="ml-auto shrink-0 text-success" />}
              </button>
            </li>
          ))}
        </ul>
        <hr className="my-1.5 border-line" />
        {can('admin') && (
          <Link to="/channels/new" className="line-menu-item" onClick={() => menu.close()}>
            <Icon.Plus className="text-sub" />
            New publication
          </Link>
        )}
        <Link to="/channels" className="line-menu-item" onClick={() => menu.close()}>
          <Icon.Sliders className="text-sub" />
          Manage publications
        </Link>
      </div>
    </div>
  );
}

function PersonMenu() {
  const { me, workspace, setWorkspaceId } = useSession();
  const menu = useDisclosure();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [signingOut, setSigningOut] = useState(false);
  const name = me.operator.name ?? me.operator.email;
  const initials = (me.operator.name ?? me.operator.email)
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');

  const signOut = async () => {
    setSigningOut(true);
    try {
      await api.post('/api/v1/auth/logout');
    } finally {
      client.clear();
      await navigate({ to: '/sign-in', search: {} });
    }
  };

  return (
    <div className="relative mt-2 border-t border-rail-line pt-2">
      <button
        type="button"
        {...menu.buttonProps}
        className="flex w-full items-center gap-2.5 rounded-[6px] px-2.5 py-2 text-left transition-colors hover:bg-white/5 aria-expanded:bg-rail-2"
      >
        <span
          aria-hidden="true"
          className="grid size-8 shrink-0 place-items-center rounded-full bg-rail-3 text-[13px] font-bold text-white"
        >
          {initials}
        </span>
        <span className="min-w-0 leading-tight">
          <span className="block truncate font-semibold text-white">{name}</span>
          <small className="block truncate text-[13px] text-rail-muted">
            {ROLE_LABEL[workspace.role]} · {workspace.name}
          </small>
        </span>
        <Icon.ChevronDown className="ml-auto shrink-0 text-rail-muted" />
      </button>
      <div {...menu.panelProps} className="line-menu absolute inset-x-0 bottom-[calc(100%+6px)]">
        {me.workspaces.length > 1 && (
          <>
            <p className="px-2.5 pt-1.5 pb-1 text-[13px] text-sub">Workspace</p>
            <ul aria-label="Workspaces">
              {me.workspaces.map((w) => (
                <li key={w.id}>
                  <button
                    type="button"
                    className="line-menu-item"
                    aria-current={w.id === workspace.id ? 'true' : undefined}
                    onClick={() => {
                      menu.close();
                      if (w.id !== workspace.id) {
                        setWorkspaceId(w.id);
                        void navigate({ to: '/' });
                      }
                    }}
                  >
                    <span className="min-w-0 truncate">{w.name}</span>
                    {w.id === workspace.id && (
                      <Icon.Check className="ml-auto shrink-0 text-success" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
            <hr className="my-1.5 border-line" />
          </>
        )}
        <Link to="/settings/security" className="line-menu-item" onClick={() => menu.close()}>
          <Icon.Settings className="text-sub" />
          Your account and security
        </Link>
        <button
          type="button"
          className="line-menu-item"
          disabled={signingOut}
          onClick={() => void signOut()}
        >
          <Icon.SignOut className="text-sub" />
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </div>
  );
}

// ---- Top bar ------------------------------------------------------------------------------------

/** The breadcrumb: the publication (or workspace in Settings), then the section, then the page. */
function useTrail() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { channel } = useCurrentChannel();
  const { workspace } = useSession();
  const title = usePageTitleValue();
  const crumbs = crumbsFor(pathname, channel?.id);
  if (title && crumbs.length) crumbs[crumbs.length - 1] = { label: title };
  const root = pathname.startsWith('/settings')
    ? { label: workspace.name, href: '/settings/workspace' }
    : { label: channel?.name ?? workspace.name, href: '/' };
  const trail = pathname === '/' ? [{ label: root.label }, ...crumbs] : [root, ...crumbs];
  return { pathname, root, trail };
}

/** The tab names the page too, so a row of Swarm tabs can be told apart; focus mode included. */
function DocumentTitle() {
  const { root, trail } = useTrail();
  const status = useTabStatusValue();
  const page = trail.length > 1 ? (trail[trail.length - 1]?.label ?? null) : 'Home';
  const text = tabTitle({ status, page, place: root.label });
  useEffect(() => {
    document.title = text;
  }, [text]);
  return null;
}

function TopBar({ onSearch }: { onSearch: () => void }) {
  const navigate = useNavigate();
  const { trail } = useTrail();
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <header className="sticky top-14 z-20 border-b border-line bg-surface/95 min-[1020px]:top-0">
      <div className="flex h-[52px] items-center gap-4 px-4 sm:px-8 min-[1020px]:h-14">
        <nav aria-label="Breadcrumb" className="min-w-0">
          <ol className="flex min-w-0 items-center gap-2 text-[15px] whitespace-nowrap text-sub">
            {trail.map((crumb, i) => {
              const last = i === trail.length - 1;
              const href = 'href' in crumb ? crumb.href : undefined;
              return (
                <Fragment key={`${crumb.label}-${i}`}>
                  {i > 0 && (
                    <li aria-hidden="true" className="text-line-control max-sm:hidden">
                      /
                    </li>
                  )}
                  <li className={last ? 'min-w-0 truncate' : 'max-sm:hidden'}>
                    {last || !href ? (
                      <span
                        aria-current={last ? 'page' : undefined}
                        className={last ? 'font-semibold text-ink' : undefined}
                      >
                        {crumb.label}
                      </span>
                    ) : (
                      <a
                        href={href}
                        className="text-sub no-underline hover:text-ink hover:underline"
                        onClick={(event) => {
                          if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                          event.preventDefault();
                          void navigate({ href });
                        }}
                      >
                        {crumb.label}
                      </a>
                    )}
                  </li>
                </Fragment>
              );
            })}
          </ol>
        </nav>
        <button
          type="button"
          onClick={onSearch}
          aria-label={`Search or jump to (${mac ? '⌘' : 'Ctrl'} K)`}
          className="ml-auto flex h-9 shrink-0 items-center gap-2 rounded-control border border-line-control bg-surface px-2.5 text-sub transition-colors hover:border-line-control-hover max-md:w-9 max-md:justify-center max-md:border-transparent max-md:px-0 md:w-[300px] md:pr-1.5"
        >
          <Icon.Search size={18} />
          <span className="flex-1 text-left max-md:hidden">Search or jump to…</span>
          <kbd className="rounded-[5px] border border-line bg-surface-alt px-1.5 py-1 font-sans text-[12px] font-semibold text-sub max-md:hidden">
            {mac ? '⌘ K' : 'Ctrl K'}
          </kbd>
        </button>
      </div>
    </header>
  );
}
