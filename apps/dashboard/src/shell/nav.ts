// The shell's map of the app: grouped navigation (the stations on the rail), the command menu's
// "Jump to" list and the breadcrumb titles all come from here.

export interface NavItem {
  label: string;
  /** Builds the address for the current publication. */
  href: (channelId: string | undefined) => string;
  /** Whether the item is "you are here" for a path. */
  matches: (pathname: string) => boolean;
  /** The feature flag this item needs; without one it always shows. */
  flag?: string;
}

export interface NavGroup {
  /** Null for Home, which is its own station. */
  label: string | null;
  items: NavItem[];
}

const under =
  (...prefixes: string[]) =>
  (pathname: string) =>
    prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));

const withChannel = (path: string) => (channelId: string | undefined) =>
  channelId ? `${path}?channel=${channelId}` : path;

const CHANNEL_SETTINGS = /^\/channels\/ch_[0-9a-f]{32}\/(sending|deliverability)$/;

export const HOME: NavItem = {
  label: 'Home',
  href: () => '/',
  matches: (pathname) => pathname === '/',
};

export const NAV: NavGroup[] = [
  {
    label: 'Write',
    items: [
      {
        label: 'Posts',
        href: withChannel('/dispatches'),
        matches: (pathname) =>
          under('/dispatches', '/broadcasts')(pathname) ||
          /^\/channels\/ch_[0-9a-f]{32}\/feeds$/.test(pathname),
      },
      { label: 'Templates', href: withChannel('/templates'), matches: under('/templates') },
    ],
  },
  {
    label: 'Audience',
    items: [
      {
        label: 'Subscribers',
        href: withChannel('/members'),
        matches: (pathname) =>
          under('/members', '/rosters')(pathname) ||
          /^\/channels\/ch_[0-9a-f]{32}\/(members-settings|export-destinations)$/.test(pathname),
      },
      { label: 'Segments', href: withChannel('/circles'), matches: under('/circles') },
      { label: 'Signup forms', href: withChannel('/forms'), matches: under('/forms') },
    ],
  },
  {
    label: 'Grow',
    items: [
      { label: 'Automations', href: withChannel('/flows'), matches: under('/flows') },
      { label: 'Referrals & growth', href: withChannel('/growth'), matches: under('/growth') },
      {
        label: 'Partners',
        flag: 'partner_exchange',
        href: withChannel('/partners'),
        matches: under('/partners'),
      },
    ],
  },
  {
    label: 'Earn',
    items: [
      {
        label: 'Paid subscriptions',
        href: withChannel('/memberships'),
        matches: under('/memberships'),
      },
      { label: 'Products', flag: 'goods', href: withChannel('/goods'), matches: under('/goods') },
      {
        label: 'Sponsors',
        flag: 'sponsor_match',
        href: withChannel('/sponsors'),
        matches: under('/sponsors'),
      },
    ],
  },
  {
    label: 'Publish',
    items: [
      { label: 'Website', href: withChannel('/site'), matches: under('/site') },
      {
        label: 'Sending & delivery',
        href: (channelId) => (channelId ? `/channels/${channelId}/sending` : '/channels'),
        matches: (pathname) => CHANNEL_SETTINGS.test(pathname),
      },
    ],
  },
  {
    label: 'Connect',
    items: [{ label: 'Apps', flag: 'app_directory', href: () => '/apps', matches: under('/apps') }],
  },
];

export const SETTINGS: NavItem = {
  label: 'Settings',
  href: () => '/settings/workspace',
  matches: under('/settings'),
};

const ALL_NAV: NavItem[] = [HOME, ...NAV.flatMap((g) => g.items), SETTINGS];

/** The rail for the features that are on: an item that is off goes, and so does a group it empties. */
export function visibleNav(isOn: (flag: string) => boolean): NavGroup[] {
  return NAV.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.flag || isOn(item.flag)),
  })).filter((group) => group.items.length > 0);
}

interface Crumb {
  label: string;
  href?: string;
}

const SETTINGS_TABS: Record<string, string> = {
  workspace: 'Workspace',
  team: 'Team',
  sessions: 'Sessions',
  security: 'Security',
  audit: 'Audit log',
  payments: 'Payments',
  developers: 'Developers',
  privacy: 'Privacy',
  copilot: 'Copilot',
  instance: 'Instance',
};

/**
 * The breadcrumb after the publication (or workspace) name, from the path. A page can name its
 * last crumb itself (a post's subject) through usePageTitle().
 */
export function crumbsFor(pathname: string, channelId: string | undefined): Crumb[] {
  const parts = pathname.split('/').filter(Boolean);
  const [first, second, third] = parts;
  const item = ALL_NAV.find((n) => n.matches(pathname));
  const section = item ? { label: item.label, href: item.href(channelId) } : null;

  if (!first) return [{ label: 'Home' }];
  if (first === 'settings') {
    // Own keys only: /settings/constructor is no tab.
    const tab = second && Object.hasOwn(SETTINGS_TABS, second) ? SETTINGS_TABS[second] : undefined;
    return tab
      ? [{ label: 'Settings', href: '/settings/workspace' }, { label: tab }]
      : [{ label: 'Settings' }];
  }
  if (first === 'channels') {
    if (!second) return [{ label: 'Publications' }];
    if (second === 'new')
      return [{ label: 'Publications', href: '/channels' }, { label: 'New publication' }];
    const sub: Record<string, Crumb[]> = {
      sending: [{ label: 'Sending & delivery' }],
      deliverability: [
        { label: 'Sending & delivery', href: `/channels/${second}/sending` },
        { label: 'Deliverability' },
      ],
      media: [{ label: 'Media library' }],
      feeds: [{ label: 'Posts', href: withChannel('/dispatches')(second) }, { label: 'Feed Sync' }],
      'members-settings': [
        { label: 'Subscribers', href: withChannel('/members')(second) },
        { label: 'Subscriber settings' },
      ],
      'export-destinations': [
        { label: 'Subscribers', href: withChannel('/members')(second) },
        { label: 'Export destinations' },
      ],
    };
    return third && Object.hasOwn(sub, third)
      ? (sub[third] ?? [{ label: 'Publication settings' }])
      : [{ label: 'Publication settings' }];
  }
  if (!section) return [];
  if (first === 'rosters') return [section, { label: 'Rosters' }];
  // A page inside a section: the section links back to its list.
  const detail: Record<string, string> = {
    dispatches: 'Post',
    broadcasts: 'Send report',
    members: 'Import',
    circles: second === 'new' ? 'New segment' : 'Segment',
    forms: 'Signup form',
    flows: second === 'inbox-rules' ? 'Inbox rules' : 'Automation',
  };
  const inner = first === 'broadcasts' || (second && !/^ch_/.test(second));
  if (inner && detail[first]) return [section, { label: detail[first] }];
  return [{ label: section.label }];
}

/** Splits an address from this file into what a router Link takes. */
export function linkTarget(href: string): { to: string; search: Record<string, string> } {
  const [to = '/', query = ''] = href.split('?');
  return { to, search: Object.fromEntries(new URLSearchParams(query)) };
}
