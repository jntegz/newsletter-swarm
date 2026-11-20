// Growth: how a Channel finds and keeps readers. The layout loads the Channel once; each tab
// (Champions, Ask, Signup Journeys, Series, Funnel Explorer) is a child route that reads it, and
// the operator's role, from context.
import type { Channel, SeatRole } from '@swarm/domain';
import { EmptyState, ErrorNotice, LoadingRows } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link, Outlet } from '@tanstack/react-router';
import { createContext, useContext, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { isFeatureDisabled } from '../api/growth';
import { channelQuery } from '../api/queries';
import { PageHeader } from '../pages/Channels';

const RANK: Record<SeatRole, number> = { viewer: 0, author: 1, editor: 2, admin: 3, owner: 4 };

interface GrowthValue {
  channel: Channel;
  /** Author or higher. */
  canAuthor: boolean;
  /** Editor or higher: Asks, Signup Journeys, Series, referral review. */
  canEdit: boolean;
  /** Admin or higher: Champions settings, rewards, milestones, awards, Ask exports. */
  canAdmin: boolean;
}

const GrowthContext = createContext<GrowthValue | null>(null);

export function useGrowth(): GrowthValue {
  const value = useContext(GrowthContext);
  if (!value) throw new Error('useGrowth() outside GrowthLayout');
  return value;
}

const TABS = [
  { path: 'champions', label: 'Referrals' },
  { path: 'ask', label: 'Polls & surveys' },
  { path: 'journeys', label: 'Signup journeys' },
  { path: 'series', label: 'Series' },
  { path: 'funnel', label: 'Funnel explorer' },
] as const;

export function GrowthLayout({ channelId }: { channelId: string }) {
  const channel = useQuery(channelQuery(channelId));
  if (channel.isPending) return <LoadingRows label="Loading Growth" rows={4} />;
  if (channel.error) {
    return (
      <ErrorNotice
        title="Growth not available"
        message={channel.error.message}
        action={
          <Link to="/channels" className="btn-ghost">
            Back to publications
          </Link>
        }
      />
    );
  }
  const role = channel.data.role;
  const value: GrowthValue = {
    channel: channel.data,
    canAuthor: RANK[role] >= RANK.author,
    canEdit: RANK[role] >= RANK.editor,
    canAdmin: RANK[role] >= RANK.admin,
  };
  return (
    <GrowthContext.Provider value={value}>
      <PageHeader
        title="Referrals & growth"
        subtitle={`How ${channel.data.name} finds and keeps readers.`}
      />
      <nav
        aria-label="Growth sections"
        className="mb-6 flex gap-1 overflow-x-auto border-b border-line-app"
      >
        {TABS.map((tab) => (
          <Link
            key={tab.path}
            to={`/growth/$channelId/${tab.path}`}
            params={{ channelId }}
            className="-mb-px border-b-2 border-transparent px-3 pb-3 text-[13.5px] whitespace-nowrap text-sub no-underline hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple"
            activeProps={{
              className: 'border-purple! font-semibold text-ink!',
              'aria-current': 'page',
            }}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </GrowthContext.Provider>
  );
}

/**
 * The shared states of a growth query: loading, a feature that is off for this Channel (404
 * feature_disabled), or another error with a retry. Renders `children` once there is data.
 */
export function QueryState({
  query,
  label,
  off,
  children,
}: {
  query: { isPending: boolean; error: Error | null; refetch: () => unknown };
  label: string;
  /** Title and text for the feature_disabled answer. */
  off?: { title: string; text: ReactNode };
  children: ReactNode;
}) {
  if (query.isPending) return <LoadingRows label={label} rows={4} />;
  if (query.error) {
    if (off && isFeatureDisabled(query.error)) {
      return <EmptyState title={off.title}>{off.text}</EmptyState>;
    }
    return (
      <ErrorNotice
        message={query.error.message}
        action={
          query.error instanceof ApiError && query.error.code === 'not_found' ? undefined : (
            <button type="button" className="btn-ghost btn-sm" onClick={() => void query.refetch()}>
              Try again
            </button>
          )
        }
      />
    );
  }
  return <>{children}</>;
}

/** Shown when an optional feature is off: who can turn it on. */
export const OFF_TEXT =
  'It is an optional feature that is off for this publication. Whoever runs this Swarm installation can turn it on.';
