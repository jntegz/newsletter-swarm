import { FLOW_RECIPES, type FlowRecipe } from '@swarm/domain';
import { EmptyState } from '@swarm/ui/components';
import type { QueryClient } from '@tanstack/react-query';
import {
  Navigate,
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
  useNavigate,
} from '@tanstack/react-router';
import { Suspense, lazy, type ReactNode } from 'react';
import { LoadingRows } from '@swarm/ui/components';
import { AppShell } from './AppShell';
import { meQuery } from './api/queries';
import { OverviewPage } from './Overview';
import { CheckEmailPage, ContinuePage, InvitePage, SignInPage, UndoFactorPage } from './pages/Auth';
import { InstanceSettingsPage } from './pages/InstanceSettings';
import { SecondFactorPage } from './pages/SecondFactor';
import { SecuritySettings } from './pages/Security';
import { BroadcastPage } from './pages/Broadcast';
import { CaptureFormsPage } from './pages/CaptureForms';
import { ChannelSettingsPage, ChannelsPage, NewChannelPage } from './pages/Channels';
import { CirclePage, NewCirclePage } from './pages/CircleBuilder';
import { CirclesPage } from './pages/Circles';
import { DispatchesPage } from './pages/Dispatches';
import { postsListSearch } from './pages/posts-list';
import { FlowInboxRulesPage } from './pages/FlowInboxRules';
import { FlowsPage } from './pages/Flows';
import { TemplatesPage } from './pages/Templates';
import { MediaPage } from './pages/Media';
import { MembersPage } from './pages/Members';
import { memberListSearch } from './pages/member-views';
import { SendingSettingsPage } from './pages/Sending';
import { DeliverabilityPage } from './pages/Deliverability';
import { FeedSyncPage } from './pages/FeedSync';
import { SiteAnalyticsPage } from './pages/SiteAnalytics';
import { SiteAuthors } from './pages/SiteAuthors';
import { SiteDomains } from './pages/SiteDomains';
import { GoodsPage } from './pages/Goods';
import { PartnersPage, SponsorsPage } from './pages/Partners';
import { SiteLinkHub } from './pages/LinkHub';
import {
  SiteBotRules,
  SiteBranding,
  SiteCookies,
  SiteImport,
  SiteGeneral,
  SiteNavigation,
  SiteRedirects,
  SiteSeo,
  SiteStudioLayout,
} from './pages/SiteStudio';
import { WithChannel } from './pages/common';
import { CouponsPage } from './pages/Coupons';
import { GateSettingsPage } from './pages/GateSettings';
import { GiftPassesPage, PledgesPage } from './pages/GiftsPledges';
import { EditLevelPage, NewLevelPage } from './pages/LevelEditor';
import { LevelsPage, MembershipsLayout } from './pages/Memberships';
import { PaymentsSettings } from './pages/Payments';
import { RevenuePage } from './pages/Revenue';
import {
  AuditSettings,
  SessionsSettings,
  SettingsLayout,
  TeamSettings,
  WorkspaceSettings,
} from './pages/Settings';
import { ApiKeysSettings, DevelopersLayout } from './pages/Developers';
import { OAuthAppsSettings } from './pages/OAuthApps';
import { OAuthConsentPage, stashConsentParams, stashedConsentParams } from './pages/OAuthConsent';
import { GrowthLayout } from './growth/Layout';
import { SessionProvider } from './session';
import { PREVIEW_STATES, type PreviewState } from './preview';
import { RouteError, RouteNotFound } from './shell/RouteError';

/** Only same-site paths are accepted as a place to return to after sign-in. */
const safePath = (value: unknown) =>
  typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : undefined;
const text = (value: unknown) =>
  typeof value === 'string' && value.length < 300 ? value : undefined;

/** Drops absent keys, so search params stay optional under exactOptionalPropertyTypes. */
function compact<T extends Record<string, string | undefined>>(
  value: T,
): { [K in keyof T]?: string } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: string;
  };
}

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Outlet,
  notFoundComponent: () => (
    <main id="main" className="grid min-h-screen place-items-center px-4">
      <RouteNotFound />
    </main>
  ),
});

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in',
  validateSearch: (search: Record<string, unknown>) =>
    compact({
      return: safePath(search.return),
      error: text(search.error),
      email: text(search.email),
    }),
  component: function SignIn() {
    const search = signInRoute.useSearch();
    return (
      <SignInPage
        {...(search.return ? { returnTo: search.return } : {})}
        {...(search.error ? { error: search.error } : {})}
        {...(search.email ? { email: search.email } : {})}
      />
    );
  },
});

const checkEmailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in/check-email',
  validateSearch: (search: Record<string, unknown>) => compact({ email: text(search.email) }),
  component: function CheckEmail() {
    const { email } = checkEmailRoute.useSearch();
    return <CheckEmailPage {...(email ? { email } : {})} />;
  },
});

const continueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in/continue',
  validateSearch: (search: Record<string, unknown>) => compact({ return: safePath(search.return) }),
  component: function Continue() {
    const search = continueRoute.useSearch();
    return <ContinuePage {...(search.return ? { returnTo: search.return } : {})} />;
  },
});

const undoFactorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in/undo-factor',
  component: UndoFactorPage,
});

const secondFactorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in/verify',
  validateSearch: (search: Record<string, unknown>) => compact({ return: safePath(search.return) }),
  component: function SecondFactor() {
    const search = secondFactorRoute.useSearch();
    return <SecondFactorPage {...(search.return ? { returnTo: search.return } : {})} />;
  },
});

const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invite',
  component: InvitePage,
});

// The OAuth consent page sits outside the app shell. Signing in may come first; the request is
// kept in session storage meanwhile, since a sign-in return path is limited to 512 characters.
const AUTHORIZE_KEYS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
  'resource',
] as const;
const oauthConsentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/oauth/consent',
  validateSearch: (search: Record<string, unknown>) =>
    compact(
      Object.fromEntries(
        AUTHORIZE_KEYS.map((key) => {
          const value = search[key];
          return [key, typeof value === 'string' && value.length <= 2000 ? value : undefined];
        }),
      ) as Record<(typeof AUTHORIZE_KEYS)[number], string | undefined>,
    ),
  beforeLoad: async ({ context, search }) => {
    try {
      await context.queryClient.ensureQueryData(meQuery);
    } catch {
      if (search.client_id && search.redirect_uri) {
        stashConsentParams({
          ...search,
          client_id: search.client_id,
          redirect_uri: search.redirect_uri,
        });
      }
      throw redirect({ to: '/sign-in', search: { return: '/oauth/consent' } });
    }
  },
  component: function OAuthConsentRoute() {
    const search = oauthConsentRoute.useSearch();
    const params =
      search.client_id && search.redirect_uri
        ? { ...search, client_id: search.client_id, redirect_uri: search.redirect_uri }
        : stashedConsentParams();
    if (!params) {
      return (
        <main id="main" className="grid min-h-screen place-items-center px-4">
          <EmptyState title="Nothing to authorise">
            Start again from the app that sent you here.
          </EmptyState>
        </main>
      );
    }
    return <OAuthConsentPage params={params} />;
  },
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.ensureQueryData(meQuery).catch(() => null);
    if (!me) throw redirect({ to: '/sign-in', search: { return: location.href } });
    // A session that still owes a second factor (Phase 7) finishes signing in first.
    if (me.secondFactor && me.secondFactor.state !== 'ok') {
      throw redirect({ to: '/sign-in/verify', search: { return: location.href } });
    }
    // Invite-only sign-up: an invited person has no workspace until they accept the invite.
    if (me.workspaces.length === 0) throw redirect({ to: '/invite' });
  },
  component: () => (
    <SessionProvider>
      <AppShell>
        <Outlet />
      </AppShell>
    </SessionProvider>
  ),
  // An address under the app that matches no page keeps the rail and the top bar.
  notFoundComponent: RouteNotFound,
});

const overviewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  validateSearch: (search: Record<string, unknown>): { preview?: PreviewState } =>
    PREVIEW_STATES.some((s) => s.id === search.preview)
      ? { preview: search.preview as PreviewState }
      : {},
  component: function OverviewRoute() {
    // No ?preview= shows the workspace's own data; a preview state shows sample data.
    const { preview } = overviewRoute.useSearch();
    const navigate = useNavigate();
    return (
      <OverviewPage
        preview={preview}
        onPreview={(state) =>
          void navigate({ to: '/', search: state ? { preview: state } : {}, replace: true })
        }
      />
    );
  },
});

const channelsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/channels',
  component: ChannelsPage,
});
const newChannelRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/channels/new',
  component: NewChannelPage,
});
const channelRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/channels/$channelId',
  component: function ChannelRoute() {
    const { channelId } = channelRoute.useParams();
    return <ChannelSettingsPage channelId={channelId} />;
  },
});

// The editor (and TipTap) loads on first use, keeping it out of the main bundle.
const EditorPage = lazy(() => import('./pages/Editor').then((m) => ({ default: m.EditorPage })));

/** ?channel=<id> picks the Channel on the Dispatches and Members pages. */
const channelSearch = (search: Record<string, unknown>) =>
  compact({
    channel:
      typeof search.channel === 'string' && /^ch_[0-9a-f]{32}$/.test(search.channel)
        ? search.channel
        : undefined,
  });

const sendingRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/channels/$channelId/sending',
  component: function SendingRoute() {
    const { channelId } = sendingRoute.useParams();
    return <SendingSettingsPage channelId={channelId} />;
  },
});

const deliverabilityRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/channels/$channelId/deliverability',
  component: function DeliverabilityRoute() {
    const { channelId } = deliverabilityRoute.useParams();
    return <DeliverabilityPage channelId={channelId} />;
  },
});

// Feed Sync (Phase 8): feeds that become Dispatches.
const feedSyncRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/channels/$channelId/feeds',
  component: function FeedSyncRoute() {
    const { channelId } = feedSyncRoute.useParams();
    return <FeedSyncPage key={channelId} channelId={channelId} />;
  },
});

const mediaRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/channels/$channelId/media',
  component: function MediaRoute() {
    const { channelId } = mediaRoute.useParams();
    return <MediaPage channelId={channelId} />;
  },
});

const dispatchesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/dispatches',
  // The posts list's search (q), status chip (show) and Started by filter (by) live in the
  // address, so they survive a reload and coming Back from a post.
  validateSearch: (search: Record<string, unknown>) => ({
    ...channelSearch(search),
    ...postsListSearch(search),
  }),
  component: function DispatchesRoute() {
    const { channel, ...filters } = dispatchesRoute.useSearch();
    return <DispatchesPage channelId={channel} filters={filters} />;
  },
});

const dispatchRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/dispatches/$dispatchId',
  // ?flow=<id>: opened from a Flow. The Dispatch's own kind decides whether it is a Flow email.
  validateSearch: (search: Record<string, unknown>) =>
    compact({
      flow:
        typeof search.flow === 'string' && /^fl_[0-9a-f]{32}$/.test(search.flow)
          ? search.flow
          : undefined,
    }),
  component: function DispatchRoute() {
    const { dispatchId } = dispatchRoute.useParams();
    const { flow } = dispatchRoute.useSearch();
    return (
      <Suspense fallback={<LoadingRows label="Loading the editor" rows={6} />}>
        <EditorPage dispatchId={dispatchId} {...(flow ? { flowId: flow } : {})} />
      </Suspense>
    );
  },
});

const broadcastRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/broadcasts/$broadcastId',
  component: function BroadcastRoute() {
    const { broadcastId } = broadcastRoute.useParams();
    return <BroadcastPage broadcastId={broadcastId} />;
  },
});

// The list's filters live in the URL (pages/member-views.ts), so a view can be bookmarked.
const membersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/members',
  validateSearch: memberListSearch,
  component: function MembersRoute() {
    const search = membersRoute.useSearch();
    return <MembersPage channelId={search.channel} search={search} />;
  },
});

const circlesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/circles',
  validateSearch: channelSearch,
  component: function CirclesRoute() {
    return <CirclesPage channelId={circlesRoute.useSearch().channel} />;
  },
});
const newCircleRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/circles/new',
  // post: the draft that asked for this segment (from its send panel); creating the segment
  // adds it to that post's audience and goes back to the post.
  validateSearch: (search: Record<string, unknown>) => ({
    ...channelSearch(search),
    ...compact({
      post:
        typeof search.post === 'string' && /^di_[0-9a-f]{32}$/.test(search.post)
          ? search.post
          : undefined,
    }),
  }),
  component: function NewCircleRoute() {
    const search = newCircleRoute.useSearch();
    return <NewCirclePage channelId={search.channel} forPost={search.post} />;
  },
});
const circleRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/circles/$circleId',
  component: function CircleRoute() {
    return <CirclePage circleId={circleRoute.useParams().circleId} />;
  },
});

// Phase 8: Rosters (flag rosters).
const RostersPage = lazy(() => import('./pages/Rosters').then((m) => ({ default: m.RostersPage })));
const rostersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/rosters',
  validateSearch: channelSearch,
  component: function RostersRoute() {
    return (
      <Suspense fallback={<LoadingRows label="Loading Rosters" />}>
        <RostersPage channelId={rostersRoute.useSearch().channel} />
      </Suspense>
    );
  },
});

const MemberImportPage = lazy(() =>
  import('./pages/MemberImport').then((m) => ({ default: m.MemberImportPage })),
);
const MemberSettingsPage = lazy(() =>
  import('./pages/MemberSettings').then((m) => ({ default: m.MemberSettingsPage })),
);
const ExportDestinationsPage = lazy(() =>
  import('./pages/ExportDestinations').then((m) => ({ default: m.ExportDestinationsPage })),
);
const PrivacySettings = lazy(() =>
  import('./pages/PrivacyCenter').then((m) => ({ default: m.PrivacySettings })),
);
const EngagementRetentionSettings = lazy(() =>
  import('./pages/EngagementRetention').then((m) => ({
    default: m.EngagementRetentionSettings,
  })),
);

const memberImportRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/members/import',
  validateSearch: (search: Record<string, unknown>) => ({
    ...channelSearch(search),
    ...compact({
      import:
        typeof search.import === 'string' && /^ij_[0-9a-f]{32}$/.test(search.import)
          ? search.import
          : undefined,
    }),
  }),
  component: function MemberImportRoute() {
    const search = memberImportRoute.useSearch();
    return (
      <Suspense fallback={<LoadingRows label="Loading the import" rows={4} />}>
        <MemberImportPage channelId={search.channel} importId={search.import} />
      </Suspense>
    );
  },
});

const memberSettingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/channels/$channelId/members-settings',
  component: function MemberSettingsRoute() {
    const { channelId } = memberSettingsRoute.useParams();
    return (
      <Suspense fallback={<LoadingRows label="Loading publication" rows={4} />}>
        <MemberSettingsPage channelId={channelId} />
      </Suspense>
    );
  },
});

// Phase 7: export destinations per Channel (incremental exports to the operator's bucket).
const exportDestinationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/channels/$channelId/export-destinations',
  component: function ExportDestinationsRoute() {
    const { channelId } = exportDestinationsRoute.useParams();
    return (
      <Suspense fallback={<LoadingRows label="Loading publication" rows={4} />}>
        <ExportDestinationsPage channelId={channelId} />
      </Suspense>
    );
  },
});

// Capture forms: the list per Channel, and the builder (loaded on first use).
const FormBuilderPage = lazy(() =>
  import('./pages/FormBuilder').then((m) => ({ default: m.FormBuilderPage })),
);
const formsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/forms',
  validateSearch: channelSearch,
  component: function FormsRoute() {
    const { channel } = formsRoute.useSearch();
    return <CaptureFormsPage channelId={channel} />;
  },
});
const formRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/forms/$formId',
  component: function FormRoute() {
    const { formId } = formRoute.useParams();
    return (
      <Suspense fallback={<LoadingRows label="Loading the form builder" rows={6} />}>
        <FormBuilderPage formId={formId} />
      </Suspense>
    );
  },
});

// Site Studio: /site picks a Channel, then /site/<channel>/<tab>. Pages load the editor lazily.
const SitePages = lazy(() => import('./pages/SitePages'));
const siteIndexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/site',
  validateSearch: channelSearch,
  component: function SiteIndexRoute() {
    const { channel } = siteIndexRoute.useSearch();
    const navigate = useNavigate();
    return (
      <WithChannel
        channelId={channel}
        onChange={(id) => void navigate({ to: '/site', search: { channel: id } })}
      >
        {(c) => <Navigate to="/site/$channelId/general" params={{ channelId: c.id }} replace />}
      </WithChannel>
    );
  },
});
const siteRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/site/$channelId',
  component: function SiteRoute() {
    return <SiteStudioLayout channelId={siteRoute.useParams().channelId} />;
  },
});
const siteHomeRoute = createRoute({
  getParentRoute: () => siteRoute,
  path: '/',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/site/$channelId/general', params });
  },
});
const siteTab = <P extends `/${string}`>(path: P, component: () => ReactNode) =>
  createRoute({ getParentRoute: () => siteRoute, path, component });
const lazyPage = (node: ReactNode) => (
  <Suspense fallback={<LoadingRows label="Loading pages" rows={4} />}>{node}</Suspense>
);
const sitePagesRoute = siteTab('/pages', () => lazyPage(<SitePages view="list" />));
const siteAboutRoute = siteTab('/pages/about', () => lazyPage(<SitePages view="about" />));
const sitePageRoute = createRoute({
  getParentRoute: () => siteRoute,
  path: '/pages/$pageId',
  component: function SitePageRoute() {
    return lazyPage(<SitePages view="page" pageId={sitePageRoute.useParams().pageId} />);
  },
});
// Website → Design (flag site_templates): the studio and its editor load only when opened.
const SiteDesign = lazy(() => import('./design/DesignStudio'));
const DESIGN_PANELS = ['template', 'style', 'sections', 'code'] as const;
const siteDesignRoute = createRoute({
  getParentRoute: () => siteRoute,
  path: '/design',
  validateSearch: (search: Record<string, unknown>) => {
    const panel = DESIGN_PANELS.find((p) => p === search.panel);
    return {
      ...(panel ? { panel } : {}),
      ...compact({ section: text(search.section), file: text(search.file) }),
    };
  },
  component: function SiteDesignRoute() {
    const search = siteDesignRoute.useSearch();
    const navigate = useNavigate();
    const { channelId } = siteDesignRoute.useParams();
    return (
      <Suspense fallback={<LoadingRows label="Loading the design" rows={5} />}>
        <SiteDesign
          search={search}
          onSearch={(next) =>
            void navigate({
              to: '/site/$channelId/design',
              params: { channelId },
              search: next,
              replace: true,
            })
          }
        />
      </Suspense>
    );
  },
});
const siteChildren = [
  siteHomeRoute,
  siteDesignRoute,
  siteTab('/general', SiteGeneral),
  siteTab('/branding', SiteBranding),
  siteTab('/cookies', SiteCookies),
  siteTab('/import', SiteImport),
  siteTab('/navigation', SiteNavigation),
  sitePagesRoute,
  siteAboutRoute,
  sitePageRoute,
  siteTab('/authors', SiteAuthors),
  siteTab('/domains', SiteDomains),
  siteTab('/seo', SiteSeo),
  siteTab('/bot-rules', SiteBotRules),
  siteTab('/redirects', SiteRedirects),
  siteTab('/analytics', SiteAnalyticsPage),
  siteTab('/link-hub', SiteLinkHub),
];

const goodsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/goods',
  validateSearch: channelSearch,
  component: function GoodsRoute() {
    return <GoodsPage channelId={goodsRoute.useSearch().channel} />;
  },
});

const partnersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/partners',
  validateSearch: channelSearch,
  component: function PartnersRoute() {
    return <PartnersPage channelId={partnersRoute.useSearch().channel} />;
  },
});
const sponsorsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/sponsors',
  validateSearch: channelSearch,
  component: function SponsorsRoute() {
    return <SponsorsPage channelId={sponsorsRoute.useSearch().channel} />;
  },
});

// Memberships: /memberships picks a Channel, then /memberships/<channel>/<tab>.
const membershipsIndexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/memberships',
  validateSearch: channelSearch,
  component: function MembershipsIndexRoute() {
    const { channel } = membershipsIndexRoute.useSearch();
    const navigate = useNavigate();
    return (
      <WithChannel
        channelId={channel}
        onChange={(id) => void navigate({ to: '/memberships', search: { channel: id } })}
      >
        {(c) => (
          <Navigate to="/memberships/$channelId/levels" params={{ channelId: c.id }} replace />
        )}
      </WithChannel>
    );
  },
});
const membershipsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/memberships/$channelId',
  component: function MembershipsRoute() {
    return <MembershipsLayout channelId={membershipsRoute.useParams().channelId} />;
  },
});
const membershipsHomeRoute = createRoute({
  getParentRoute: () => membershipsRoute,
  path: '/',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/memberships/$channelId/levels', params });
  },
});
const membershipsTab = <P extends `/${string}`>(path: P, component: () => ReactNode) =>
  createRoute({ getParentRoute: () => membershipsRoute, path, component });
const levelRoute = createRoute({
  getParentRoute: () => membershipsRoute,
  path: '/levels/$levelId',
  component: function LevelRoute() {
    const { levelId } = levelRoute.useParams();
    return <EditLevelPage key={levelId} levelId={levelId} />;
  },
});
const membershipsChildren = [
  membershipsHomeRoute,
  membershipsTab('/levels', LevelsPage),
  membershipsTab('/levels/new', NewLevelPage),
  levelRoute,
  membershipsTab('/coupons', CouponsPage),
  membershipsTab('/gates', GateSettingsPage),
  membershipsTab('/revenue', RevenuePage),
  membershipsTab('/gift-passes', GiftPassesPage),
  membershipsTab('/pledges', PledgesPage),
];

// Flows: the list per Channel, and the builder (React Flow loads with it, on first use).
const FlowBuilderPage = lazy(() =>
  import('./pages/FlowBuilder').then((m) => ({ default: m.FlowBuilderPage })),
);
const FLOW_TABS = ['stats', 'runs'] as const;
const flowsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/flows',
  // ?recipe= opens New automation with that recipe chosen (Sending's Inactive readers links here).
  validateSearch: (search: Record<string, unknown>): { channel?: string; recipe?: FlowRecipe } => {
    const recipe = FLOW_RECIPES.find((key) => key === search.recipe);
    return { ...channelSearch(search), ...(recipe ? { recipe } : {}) };
  },
  component: function FlowsRoute() {
    const { channel, recipe } = flowsRoute.useSearch();
    return <FlowsPage channelId={channel} recipe={recipe} />;
  },
});
const flowInboxRulesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/flows/inbox-rules',
  validateSearch: channelSearch,
  component: function FlowInboxRulesRoute() {
    return <FlowInboxRulesPage channelId={flowInboxRulesRoute.useSearch().channel} />;
  },
});
const flowRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/flows/$flowId',
  validateSearch: (search: Record<string, unknown>): { tab?: (typeof FLOW_TABS)[number] } =>
    FLOW_TABS.some((t) => t === search.tab)
      ? { tab: search.tab as (typeof FLOW_TABS)[number] }
      : {},
  component: function FlowRoute() {
    const { flowId } = flowRoute.useParams();
    const { tab = 'build' } = flowRoute.useSearch();
    return (
      <Suspense fallback={<LoadingRows label="Loading the automation builder" rows={6} />}>
        <FlowBuilderPage flowId={flowId} tab={tab} />
      </Suspense>
    );
  },
});
const templatesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/templates',
  validateSearch: channelSearch,
  component: function TemplatesRoute() {
    return <TemplatesPage channelId={templatesRoute.useSearch().channel} />;
  },
});
// Growth (Phase 6): /growth picks a Channel, then /growth/<channel>/<tab>. Pages load lazily.
const ChampionsPage = lazy(() =>
  import('./growth/Champions').then((m) => ({ default: m.ChampionsPage })),
);
const AsksPage = lazy(() => import('./growth/Asks').then((m) => ({ default: m.AsksPage })));
const NewAskPage = lazy(() => import('./growth/Asks').then((m) => ({ default: m.NewAskPage })));
const AskPage = lazy(() => import('./growth/Asks').then((m) => ({ default: m.AskPage })));
const JourneysPage = lazy(() =>
  import('./growth/Journeys').then((m) => ({ default: m.JourneysPage })),
);
const JourneyPage = lazy(() =>
  import('./growth/Journeys').then((m) => ({ default: m.JourneyPage })),
);
const SeriesListPage = lazy(() =>
  import('./growth/Series').then((m) => ({ default: m.SeriesListPage })),
);
const SeriesPage = lazy(() => import('./growth/Series').then((m) => ({ default: m.SeriesPage })));
const FunnelPage = lazy(() => import('./growth/Funnel').then((m) => ({ default: m.FunnelPage })));
const growthLazy = (node: ReactNode) => (
  <Suspense fallback={<LoadingRows label="Loading" rows={4} />}>{node}</Suspense>
);
const growthIndexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/growth',
  validateSearch: channelSearch,
  component: function GrowthIndexRoute() {
    const { channel } = growthIndexRoute.useSearch();
    const navigate = useNavigate();
    return (
      <WithChannel
        channelId={channel}
        onChange={(id) => void navigate({ to: '/growth', search: { channel: id } })}
      >
        {(c) => <Navigate to="/growth/$channelId/champions" params={{ channelId: c.id }} replace />}
      </WithChannel>
    );
  },
});
const growthRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/growth/$channelId',
  component: function GrowthRoute() {
    return <GrowthLayout channelId={growthRoute.useParams().channelId} />;
  },
});
const growthHomeRoute = createRoute({
  getParentRoute: () => growthRoute,
  path: '/',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/growth/$channelId/champions', params });
  },
});
const growthTab = <P extends `/${string}`>(path: P, component: () => ReactNode) =>
  createRoute({ getParentRoute: () => growthRoute, path, component });
const askRoute = createRoute({
  getParentRoute: () => growthRoute,
  path: '/ask/$askId',
  component: function AskRoute() {
    const { askId } = askRoute.useParams();
    return growthLazy(<AskPage key={askId} askId={askId} />);
  },
});
const journeyRoute = createRoute({
  getParentRoute: () => growthRoute,
  path: '/journeys/$journeyId',
  component: function JourneyRoute() {
    const { journeyId } = journeyRoute.useParams();
    return growthLazy(<JourneyPage key={journeyId} journeyId={journeyId} />);
  },
});
const seriesRoute = createRoute({
  getParentRoute: () => growthRoute,
  path: '/series/$seriesId',
  component: function SeriesRoute() {
    const { seriesId } = seriesRoute.useParams();
    return growthLazy(<SeriesPage key={seriesId} seriesId={seriesId} />);
  },
});
const growthChildren = [
  growthHomeRoute,
  growthTab('/champions', () => growthLazy(<ChampionsPage />)),
  growthTab('/ask', () => growthLazy(<AsksPage />)),
  growthTab('/ask/new', () => growthLazy(<NewAskPage />)),
  askRoute,
  growthTab('/journeys', () => growthLazy(<JourneysPage />)),
  journeyRoute,
  growthTab('/series', () => growthLazy(<SeriesListPage />)),
  seriesRoute,
  growthTab('/funnel', () => growthLazy(<FunnelPage />)),
];

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings',
  component: SettingsLayout,
});
const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/settings/workspace' });
  },
});
const workspaceSettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/workspace',
  component: WorkspaceSettings,
});
const teamRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/team',
  component: TeamSettings,
});
const sessionsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/sessions',
  component: SessionsSettings,
});
const securityRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/security',
  component: SecuritySettings,
});
const paymentsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/payments',
  validateSearch: (search: Record<string, unknown>) => ({
    ...channelSearch(search),
    ...compact({
      connected: search.connected === '1' || search.connected === 1 ? '1' : undefined,
      error:
        typeof search.error === 'string' && /^[a-z_]{1,40}$/.test(search.error)
          ? search.error
          : undefined,
    }),
  }),
  component: function PaymentsRoute() {
    return <PaymentsSettings search={paymentsRoute.useSearch()} />;
  },
});
const auditRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/audit',
  component: AuditSettings,
});
// Self-hosting: settings for the whole Swarm, for its instance admins.
const instanceSettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/instance',
  component: InstanceSettingsPage,
});
// Settings → Developers (Phase 7): a section with sub-tabs; OAuth apps and webhooks add theirs.
const developersRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/developers',
  component: DevelopersLayout,
});
const developersIndexRoute = createRoute({
  getParentRoute: () => developersRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/settings/developers/api-keys' });
  },
});
const apiKeysRoute = createRoute({
  getParentRoute: () => developersRoute,
  path: '/api-keys',
  component: ApiKeysSettings,
});
const oauthAppsRoute = createRoute({
  getParentRoute: () => developersRoute,
  path: '/oauth-apps',
  component: OAuthAppsSettings,
});
// Phase 7: the Privacy Center (data-request queue).
const privacyRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/privacy',
  component: function PrivacyRoute() {
    return (
      <Suspense fallback={<LoadingRows label="Loading the Privacy Center" rows={4} />}>
        <div className="grid gap-6">
          <PrivacySettings />
          <EngagementRetentionSettings />
        </div>
      </Suspense>
    );
  },
});

// Settings → Copilot (Phase 8), loaded on first use.
// Shorthop moved to its card on the Apps page; old links open it there.
const applicationsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/applications',
  beforeLoad: () => {
    throw redirect({ to: '/apps', search: { app: 'shorthop' } });
  },
});
const CopilotSettings = lazy(() =>
  import('./pages/CopilotSettings').then((m) => ({ default: m.CopilotSettings })),
);
const copilotSettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/copilot',
  component: () => (
    <Suspense fallback={<LoadingRows label="Loading Copilot settings" rows={3} />}>
      <CopilotSettings />
    </Suspense>
  ),
});

// Settings → Developers → Webhooks (Phase 7), loaded on first use.
const WebhooksSettings = lazy(() =>
  import('./pages/Webhooks').then((m) => ({ default: m.WebhooksSettings })),
);
const WebhookEndpointPage = lazy(() =>
  import('./pages/WebhookEndpoint').then((m) => ({ default: m.WebhookEndpointPage })),
);
const webhooksRoute = createRoute({
  getParentRoute: () => developersRoute,
  path: '/webhooks',
  component: () => (
    <Suspense fallback={<LoadingRows label="Loading webhooks" rows={3} />}>
      <WebhooksSettings />
    </Suspense>
  ),
});
const webhookEndpointRoute = createRoute({
  getParentRoute: () => developersRoute,
  path: '/webhooks/$endpointId',
  component: function WebhookEndpointRoute() {
    const { endpointId } = webhookEndpointRoute.useParams();
    return (
      <Suspense fallback={<LoadingRows label="Loading endpoint" rows={3} />}>
        <WebhookEndpointPage key={endpointId} endpointId={endpointId} />
      </Suspense>
    );
  },
});

// Storybook-lite for @swarm/ui: development builds only, so production never ships the page.
function kitRoutes() {
  if (!import.meta.env.DEV) return [];
  const KitPage = lazy(() => import('./pages/Kit').then((m) => ({ default: m.KitPage })));
  return [
    createRoute({
      getParentRoute: () => rootRoute,
      path: '/_kit',
      component: () => (
        <Suspense fallback={<LoadingRows label="Loading the UI kit" rows={6} />}>
          <KitPage />
        </Suspense>
      ),
    }),
  ];
}

// Phase 8: the App Directory (Apps) and Settings → Developers → Directory listings.
const AppDirectoryPage = lazy(() =>
  import('./pages/AppDirectory').then((m) => ({ default: m.AppDirectoryPage })),
);
const AppListingsSettings = lazy(() =>
  import('./pages/AppListings').then((m) => ({ default: m.AppListingsSettings })),
);
const appsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/apps',
  validateSearch: (search: Record<string, unknown>): { app?: 'shorthop' | 'debounce' } =>
    search.app === 'shorthop' || search.app === 'debounce' ? { app: search.app } : {},
  component: function AppsRoute() {
    const { app } = appsRoute.useSearch();
    return (
      <Suspense fallback={<LoadingRows label="Loading apps" rows={4} />}>
        <AppDirectoryPage openApp={app} />
      </Suspense>
    );
  },
});
const appListingsRoute = createRoute({
  getParentRoute: () => developersRoute,
  path: '/listings',
  component: () => (
    <Suspense fallback={<LoadingRows label="Loading listings" rows={3} />}>
      <AppListingsSettings />
    </Suspense>
  ),
});
// Settings → Developers → Open Operator (Phase 8), loaded on first use.
const OpenOperatorSettings = lazy(() =>
  import('./pages/OpenOperator').then((m) => ({ default: m.OpenOperatorSettings })),
);
const openOperatorRoute = createRoute({
  getParentRoute: () => developersRoute,
  path: '/open-operator',
  component: () => (
    <Suspense fallback={<LoadingRows label="Loading Open Operator" rows={3} />}>
      <OpenOperatorSettings />
    </Suspense>
  ),
});

// Any other address, once signed in: "Page not found" inside the shell. Static paths rank first.
const appNotFoundRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '$',
  component: RouteNotFound,
});

const routeTree = rootRoute.addChildren([
  ...kitRoutes(),
  signInRoute,
  checkEmailRoute,
  continueRoute,
  undoFactorRoute,
  secondFactorRoute,
  inviteRoute,
  oauthConsentRoute,
  appRoute.addChildren([
    overviewRoute,
    channelsRoute,
    newChannelRoute,
    channelRoute,
    sendingRoute,
    deliverabilityRoute,
    feedSyncRoute,
    mediaRoute,
    dispatchesRoute,
    dispatchRoute,
    broadcastRoute,
    membersRoute,
    memberImportRoute,
    memberSettingsRoute,
    exportDestinationsRoute,
    circlesRoute,
    newCircleRoute,
    circleRoute,
    rostersRoute,
    formsRoute,
    formRoute,
    siteIndexRoute,
    siteRoute.addChildren(siteChildren),
    goodsRoute,
    partnersRoute,
    sponsorsRoute,
    membershipsIndexRoute,
    membershipsRoute.addChildren(membershipsChildren),
    growthIndexRoute,
    growthRoute.addChildren(growthChildren),
    settingsRoute.addChildren([
      settingsIndexRoute,
      workspaceSettingsRoute,
      teamRoute,
      sessionsRoute,
      securityRoute,
      auditRoute,
      instanceSettingsRoute,
      paymentsRoute,
      developersRoute.addChildren([
        developersIndexRoute,
        apiKeysRoute,
        oauthAppsRoute,
        webhooksRoute,
        webhookEndpointRoute,
        appListingsRoute,
        openOperatorRoute,
      ]),
      privacyRoute,
      applicationsRoute,
      copilotSettingsRoute,
    ]),
    flowsRoute,
    flowInboxRulesRoute,
    flowRoute,
    templatesRoute,
    appsRoute,
    appNotFoundRoute,
  ]),
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    scrollRestoration: true,
    // A page that throws shows this in its place, inside the shell, instead of a blank screen.
    defaultErrorComponent: RouteError,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
