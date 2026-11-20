// The publication (Channel) the operator is working in, resolved once for the whole shell:
// the URL first (?channel=<id>, or a /…/$channelId path), then the last one used, then the first.
// The URL stays the source of truth; the switcher in the rail changes it.
import type { Channel } from '@swarm/domain';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useRouterState, useSearch } from '@tanstack/react-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { channelsQuery, useChannelFlag, useInstanceFlag, workspaceFlag } from './api/queries';
import { useSession } from './session';

const STORAGE_KEY = 'swarm:channel';

function readStoredChannel(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeChannel(id: string) {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Storage can be blocked; the choice then lasts for this visit only.
  }
}

interface CurrentChannelValue {
  /** Every publication in the workspace (empty while loading). */
  channels: Channel[];
  channel: Channel | undefined;
  isPending: boolean;
  error: Error | null;
  /** Switches publication, keeping the operator on the same kind of page. */
  select: (id: string) => void;
  /** Records a publication without navigating, e.g. the one a post being edited belongs to. */
  remember: (id: string) => void;
}

const CurrentChannelContext = createContext<CurrentChannelValue | null>(null);

/** Routes whose search accepts ?channel=. */
const CHANNEL_SEARCH =
  /^\/(dispatches|members|members\/import|rosters|circles|circles\/new|forms|flows|flows\/inbox-rules|templates|site|memberships|growth|settings\/payments)$/;

/**
 * Where to go when the publication changes on a page, or null to stay put (the page reads the
 * stored choice). Pages that carry the publication in the path start again at that section's
 * first page, since what was open belongs to the old one.
 */
function hrefForChannel(pathname: string, id: string): string | null {
  const channelPath = /^\/channels\/ch_[0-9a-f]{32}(\/[a-z-]+)?$/.exec(pathname);
  if (channelPath) return `/channels/${id}${channelPath[1] ?? ''}`;
  const section = /^\/(site|memberships|growth)\/ch_[0-9a-f]{32}/.exec(pathname);
  if (section) return `/${section[1]}?channel=${id}`;
  // An open post, automation, form or segment belongs to the old publication: back to its list.
  const detail = /^\/(dispatches|flows|forms|circles)\/[a-z]+_[0-9a-f]{32}/.exec(pathname);
  if (detail) return `/${detail[1]}?channel=${id}`;
  if (pathname.startsWith('/broadcasts/')) return `/dispatches?channel=${id}`;
  if (CHANNEL_SEARCH.test(pathname)) return `${pathname}?channel=${id}`;
  return null;
}

export function CurrentChannelProvider({ children }: { children: ReactNode }) {
  const { workspace } = useSession();
  const channels = useQuery(channelsQuery(workspace.id));
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const search = useSearch({ strict: false }) as { channel?: string };
  const params = useParams({ strict: false }) as { channelId?: string };
  const [stored, setStored] = useState<string | null>(readStoredChannel);

  const list = useMemo(() => channels.data ?? [], [channels.data]);
  const fromUrl = params.channelId ?? search.channel;
  const channel =
    list.find((c) => c.id === fromUrl) ?? list.find((c) => c.id === stored) ?? list[0];

  useEffect(() => {
    if (channel && channel.id !== readStoredChannel()) storeChannel(channel.id);
  }, [channel]);

  const remember = useCallback((id: string) => {
    storeChannel(id);
    setStored(id);
  }, []);

  const select = useCallback(
    (id: string) => {
      remember(id);
      const href = hrefForChannel(pathname, id);
      if (href) void navigate({ href });
    },
    [navigate, pathname, remember],
  );

  const value = useMemo<CurrentChannelValue>(
    () => ({
      channels: list,
      channel,
      isPending: channels.isPending,
      error: channels.error,
      select,
      remember,
    }),
    [list, channel, channels.isPending, channels.error, select, remember],
  );

  return <CurrentChannelContext.Provider value={value}>{children}</CurrentChannelContext.Provider>;
}

export function useCurrentChannel(): CurrentChannelValue {
  const value = useContext(CurrentChannelContext);
  if (!value) throw new Error('useCurrentChannel() outside CurrentChannelProvider');
  return value;
}

/**
 * Whether a feature that belongs to no one publication (Apps in the rail, a Settings tab) is on
 * here, to decide if it shows. The server checks these per workspace, and the current publication's
 * flags include the workspace's. Undefined while loading, null when the flags could not be read.
 */
export function useWorkspaceFlag(key: string): boolean | null | undefined {
  const { channel, isPending } = useCurrentChannel();
  const forChannel = useChannelFlag(channel?.id, key);
  const instance = useInstanceFlag(key);
  return isPending ? undefined : workspaceFlag(!!channel, forChannel, instance);
}
