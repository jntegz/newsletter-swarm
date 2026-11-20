// Apps (Phase 8): the App Directory. Operators browse and search reviewed OAuth apps, install
// one through the app's own authorization request (PKCE; the consent page shows the scopes
// again) and manage the apps installed here. Platform staff also get the Review tab.
// Shorthop sits alongside them: Swarm calls it with a pasted key, so it isn't an OAuth listing.
// So does DeBounce (email checks), whose key is a secret of the install, set by its owner.
// Contract: docs/app-directory.md, docs/applications.md.
import {
  APP_CATEGORIES,
  APP_CATEGORY_LABELS,
  SCOPE_LABELS,
  type AppCategory,
  type OAuthGrant,
  type RecipeSubmission,
  type ReviewQueue,
  type WorkspaceDirectoryListing,
} from '@swarm/domain';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  Pill,
  SelectField,
  TextAreaField,
  TextField,
} from '@swarm/ui/components';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import { shorthopConnectionQuery } from '../api/applications';
import { emailCheckStatusQuery } from '../api/emailChecks';
import { useDebounced } from '../api/circles';
import {
  directoryKeys,
  directoryQuery,
  isDirectoryOff,
  reviewQueueQuery,
  useReview,
} from '../api/appDirectory';
import { oauthGrantsQuery, useRevokeOAuthGrant } from '../api/oauth';
import { useWorkspaceFlag } from '../channel';
import { useSession } from '../session';
import { PageHeader } from './Channels';
import { documentText } from './app-directory-helpers';

const ShorthopPanel = lazy(() =>
  import('./Applications').then((m) => ({ default: m.ShorthopPanel })),
);
const DebouncePanel = lazy(() =>
  import('./EmailChecks').then((m) => ({ default: m.DebouncePanel })),
);

type OpenApp = 'shorthop' | 'debounce';

type Tab = 'directory' | 'installed' | 'review';

const SHORTHOP = {
  name: 'Shorthop',
  tagline: 'Shorten the links in your posts, on your own domain.',
  description:
    'A link shortener you host yourself, with click statistics and the revenue each link brought. Connect it, and writers can shorten one link or every link in a post with one click.',
  category: 'analytics',
  iconUrl: '/apps/shorthop.svg',
  websiteUrl: 'https://github.com/jntegz/shorthop',
} as const;

const matchesShorthop = (q: string, category: AppCategory | '') =>
  (!category || category === SHORTHOP.category) &&
  `${SHORTHOP.name} ${SHORTHOP.tagline}`.toLowerCase().includes(q.trim().toLowerCase());

const DEBOUNCE = {
  name: 'DeBounce',
  tagline: 'Check that your subscribers’ addresses are real, before you send.',
  description:
    'An email verification service. Swarm asks it about new signups, imports and your whole list, and marks each address green, orange or red, so fewer emails bounce. Each checked address uses one DeBounce credit.',
  category: 'growth',
  iconUrl: '/apps/debounce.svg',
} as const;

const matchesDebounce = (q: string, category: AppCategory | '') =>
  (!category || category === DEBOUNCE.category) &&
  `${DEBOUNCE.name} ${DEBOUNCE.tagline} email check verification`
    .toLowerCase()
    .includes(q.trim().toLowerCase());

const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export function AppDirectoryPage({ openApp }: { openApp?: OpenApp | undefined }) {
  const { workspace } = useSession();
  const [chosen, setTab] = useState<Tab>('directory');
  const review = useQuery(reviewQueueQuery);
  // The same request the Directory tab opens with. While it's off, apps already installed can
  // still be removed in Settings → Developers → OAuth apps.
  const off = isDirectoryOff(useQuery(directoryQuery(workspace.id, '', '')).error);
  const tab = off && chosen === 'installed' ? 'directory' : chosen;
  const tabs: { id: Tab; label: string }[] = [
    { id: 'directory', label: 'Directory' },
    ...(off ? [] : [{ id: 'installed' as const, label: 'Installed' }]),
    ...(review.data ? [{ id: 'review' as const, label: 'Review' }] : []),
  ];

  return (
    <>
      <PageHeader title="Apps" subtitle="Apps that work with your publications." />
      {tabs.length > 1 && (
        <nav aria-label="Apps sections" className="mb-5 flex gap-1 border-b border-line-app">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? 'page' : undefined}
              className={`-mb-px border-b-2 px-3 pb-3 text-[13.5px] whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple ${
                tab === t.id
                  ? 'border-purple font-semibold text-ink'
                  : 'border-transparent text-sub hover:text-ink'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      )}
      {tab === 'directory' && <Directory openApp={openApp} />}
      {tab === 'installed' && <Installed />}
      {tab === 'review' && review.data && <Review queue={review.data} />}
    </>
  );
}

// ---- Directory -------------------------------------------------------------------------------

function AppIcon({ url, size = 44 }: { url: string | null; size?: number }) {
  return url ? (
    <img
      src={url}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-card-app border border-line-app object-cover"
      style={{ width: size, height: size }}
    />
  ) : (
    <span
      aria-hidden="true"
      className="shrink-0 rounded-card-app border border-line-app bg-surface-alt"
      style={{ width: size, height: size }}
    />
  );
}

function ConnectedPill() {
  return <Pill tone="success">Connected</Pill>;
}

/** Whether Shorthop is connected here, for those allowed to ask. */
function useShorthopConnected(enabled: boolean) {
  const { workspace } = useSession();
  const connection = useQuery({ ...shorthopConnectionQuery(workspace.id), enabled });
  return connection.data?.connected === true;
}

function ShorthopDialog({ onClose }: { onClose: () => void }) {
  const { workspace, can } = useSession();
  return (
    <Dialog
      open
      onClose={onClose}
      title={SHORTHOP.name}
      description={SHORTHOP.tagline}
      actions={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="grid gap-4 text-[13.5px]">
        <p>{SHORTHOP.description}</p>
        {can('admin') ? (
          <Suspense fallback={<LoadingRows label="Loading Shorthop" rows={2} />}>
            <ShorthopPanel />
          </Suspense>
        ) : (
          <p className="text-sub">Ask an admin or owner of {workspace.name} to connect it.</p>
        )}
        <p>
          <a href={SHORTHOP.websiteUrl} target="_blank" rel="noopener noreferrer">
            Website
          </a>
        </p>
      </div>
    </Dialog>
  );
}

function DebounceDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={DEBOUNCE.name}
      description={DEBOUNCE.tagline}
      actions={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="grid gap-4 text-[13.5px]">
        <p>{DEBOUNCE.description}</p>
        <Suspense fallback={<LoadingRows label="Loading DeBounce" rows={2} />}>
          <DebouncePanel />
        </Suspense>
      </div>
    </Dialog>
  );
}

function DebounceCard({ onOpen }: { onOpen: () => void }) {
  const { workspace } = useSession();
  const status = useQuery(emailCheckStatusQuery(workspace.id));
  return (
    <li className="card-app flex gap-3 p-4">
      <AppIcon url={DEBOUNCE.iconUrl} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[15px] font-semibold">{DEBOUNCE.name}</h2>
          {status.data?.available && <ConnectedPill />}
        </div>
        <p className="mt-0.5 text-[13px] text-sub">{DEBOUNCE.tagline}</p>
        <p className="mt-1.5 flex flex-wrap gap-1">
          <Pill>{APP_CATEGORY_LABELS[DEBOUNCE.category]}</Pill>
        </p>
        <Button variant="ghost" size="sm" className="mt-3" onClick={onOpen}>
          View {DEBOUNCE.name}
        </Button>
      </div>
    </li>
  );
}

function ShorthopCard({ onOpen }: { onOpen: () => void }) {
  const { can } = useSession();
  const connected = useShorthopConnected(can('admin'));
  return (
    <li className="card-app flex gap-3 p-4">
      <AppIcon url={SHORTHOP.iconUrl} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[15px] font-semibold">{SHORTHOP.name}</h2>
          {connected && <ConnectedPill />}
        </div>
        <p className="mt-0.5 text-[13px] text-sub">{SHORTHOP.tagline}</p>
        <p className="mt-1.5 flex flex-wrap gap-1">
          <Pill>{APP_CATEGORY_LABELS[SHORTHOP.category]}</Pill>
        </p>
        <Button variant="ghost" size="sm" className="mt-3" onClick={onOpen}>
          View {SHORTHOP.name}
        </Button>
      </div>
    </li>
  );
}

function Directory({ openApp }: { openApp?: OpenApp | undefined }) {
  const { workspace } = useSession();
  const applicationsOn = useWorkspaceFlag('applications') === true;
  const checksOn = useWorkspaceFlag('email_verification') === true;
  const [shorthopOpen, setShorthopOpen] = useState(openApp === 'shorthop');
  const [debounceOpen, setDebounceOpen] = useState(openApp === 'debounce');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<AppCategory | ''>('');
  const q = useDebounced(search, 250);
  const listings = useQuery(directoryQuery(workspace.id, q, category));
  const [open, setOpen] = useState<WorkspaceDirectoryListing | null>(null);

  const directoryOff = isDirectoryOff(listings.error);
  const shorthopDialog = applicationsOn && shorthopOpen && (
    <ShorthopDialog onClose={() => setShorthopOpen(false)} />
  );
  const debounceDialog = checksOn && debounceOpen && (
    <DebounceDialog onClose={() => setDebounceOpen(false)} />
  );

  if (directoryOff) {
    if (applicationsOn || checksOn) {
      return (
        <>
          <ul className="grid gap-3 sm:grid-cols-2">
            {applicationsOn && <ShorthopCard onOpen={() => setShorthopOpen(true)} />}
            {checksOn && <DebounceCard onOpen={() => setDebounceOpen(true)} />}
          </ul>
          {shorthopDialog}
          {debounceDialog}
        </>
      );
    }
    return (
      <EmptyState title="The App Directory is not turned on">
        Ask a workspace owner if you’d like to use it for {workspace.name}. Apps you build can still
        be registered in Settings → Developers.
      </EmptyState>
    );
  }

  const showShorthop = applicationsOn && matchesShorthop(q, category);
  const showDebounce = checksOn && matchesDebounce(q, category);

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_220px]">
        <TextField
          label="Search apps"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <SelectField
          label="Category"
          value={category}
          onChange={(e) => setCategory(e.target.value as AppCategory | '')}
          options={[
            { value: '', label: 'All categories' },
            ...APP_CATEGORIES.map((c) => ({ value: c, label: APP_CATEGORY_LABELS[c] })),
          ]}
        />
      </div>
      {listings.isPending && <LoadingRows label="Loading apps" rows={4} />}
      {listings.error && <ErrorNotice message={listings.error.message} />}
      {listings.data && listings.data.length === 0 && !showShorthop && !showDebounce && (
        <EmptyState title={q || category ? 'No apps match' : 'No apps yet'}>
          {q || category
            ? 'Try another word or category.'
            : 'Reviewed apps appear here as developers list them.'}
        </EmptyState>
      )}
      {(showShorthop || showDebounce || (listings.data && listings.data.length > 0)) && (
        <ul className="grid gap-3 sm:grid-cols-2">
          {showShorthop && <ShorthopCard onOpen={() => setShorthopOpen(true)} />}
          {showDebounce && <DebounceCard onOpen={() => setDebounceOpen(true)} />}
          {listings.data?.map((listing) => (
            <li key={listing.slug} className="card-app flex gap-3 p-4">
              <AppIcon url={listing.iconUrl} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-[15px] font-semibold">{listing.name}</h2>
                  {listing.installedGrantId && <Pill tone="success">Installed</Pill>}
                </div>
                <p className="mt-0.5 text-[13px] text-sub">{listing.tagline}</p>
                <p className="mt-1.5 flex flex-wrap gap-1">
                  {listing.categories.map((c) => (
                    <Pill key={c}>{APP_CATEGORY_LABELS[c]}</Pill>
                  ))}
                </p>
                <Button variant="ghost" size="sm" className="mt-3" onClick={() => setOpen(listing)}>
                  View {listing.name}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {open && <ListingDialog listing={open} onClose={() => setOpen(null)} />}
      {shorthopDialog}
      {debounceDialog}
    </div>
  );
}

function ListingDialog({
  listing,
  onClose,
}: {
  listing: WorkspaceDirectoryListing;
  onClose: () => void;
}) {
  const { workspace, can } = useSession();
  return (
    <Dialog
      open
      onClose={onClose}
      title={listing.name}
      description={listing.tagline}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {listing.installedGrantId ? (
            <Pill tone="success">Installed on {workspace.name}</Pill>
          ) : can('admin') ? (
            // The app starts its own authorization request with PKCE; Swarm's consent page
            // then asks which workspace and Channels it may use.
            <a href={listing.installUrl} rel="noopener noreferrer" className="btn-primary">
              Continue to {listing.name}
            </a>
          ) : null}
        </>
      }
    >
      <div className="grid gap-4 text-[13.5px]">
        {listing.description && <p className="whitespace-pre-line">{listing.description}</p>}
        {listing.screenshotUrls.length > 0 && (
          <div className="flex gap-2 overflow-x-auto">
            {listing.screenshotUrls.map((url, i) => (
              <img
                key={url}
                src={url}
                alt={`${listing.name} screenshot ${i + 1}`}
                className="h-32 rounded-[10px] border border-line-app"
              />
            ))}
          </div>
        )}
        <section aria-label="Permissions">
          <h3 className="font-semibold">If you install it, {listing.name} can</h3>
          <ul className="mt-1.5 grid list-disc gap-1 pl-5">
            {listing.scopes.map((s) => (
              <li key={s.scope}>{s.label}</li>
            ))}
          </ul>
          {listing.extraScopes.length > 0 && (
            <>
              <h4 className="mt-3 font-semibold">May also ask for</h4>
              <ul className="mt-1.5 grid list-disc gap-1 pl-5 text-sub">
                {listing.extraScopes.map((s) => (
                  <li key={s.scope}>{s.label}</li>
                ))}
              </ul>
            </>
          )}
          <p className="mt-2 text-[12.5px] text-sub">
            You choose the workspace and publications on the next screen, and you can revoke access
            at any time under Installed.
          </p>
        </section>
        {listing.webhookEvents.length > 0 && (
          <section aria-label="Events">
            <h3 className="font-semibold">Events it listens for</h3>
            <p className="mt-1.5 flex flex-wrap gap-1">
              {listing.webhookEvents.map((e) => (
                <code key={e} className="rounded bg-surface-alt px-1.5 py-0.5 text-[12px]">
                  {e}
                </code>
              ))}
            </p>
          </section>
        )}
        <p className="flex flex-wrap gap-4">
          <a href={listing.websiteUrl} target="_blank" rel="noopener noreferrer">
            Website
          </a>
          <a href={listing.supportUrl} target="_blank" rel="noopener noreferrer">
            Support
          </a>
          <a href={listing.privacyUrl} target="_blank" rel="noopener noreferrer">
            Privacy policy
          </a>
        </p>
        {!can('admin') && !listing.installedGrantId && (
          <p className="text-sub">Ask an admin or owner of {workspace.name} to install it.</p>
        )}
      </div>
    </Dialog>
  );
}

// ---- Installed -------------------------------------------------------------------------------

function Installed() {
  const { workspace, can } = useSession();
  const client = useQueryClient();
  const grants = useQuery({ ...oauthGrantsQuery(workspace.id), enabled: can('admin') });
  const directory = useQuery({ ...directoryQuery(workspace.id, '', ''), enabled: can('admin') });
  const revoke = useRevokeOAuthGrant(workspace.id);
  const [revoking, setRevoking] = useState<OAuthGrant | null>(null);
  const [managing, setManaging] = useState(false);
  const applicationsOn = useWorkspaceFlag('applications') === true;
  const shorthopConnected = useShorthopConnected(can('admin') && applicationsOn);

  if (!can('admin')) {
    return (
      <EmptyState title="Admins manage installed apps">
        Ask an admin or owner of {workspace.name} to see or revoke the apps installed here.
      </EmptyState>
    );
  }
  const icons = new Map((directory.data ?? []).map((l) => [l.appId, l.iconUrl]));

  return (
    <section aria-labelledby="installed-title" className="card-app p-5">
      <h2 id="installed-title" className="text-[16px] font-semibold">
        Installed on {workspace.name}
      </h2>
      <p className="mt-1 text-[13px] text-sub">
        Every app an admin allowed to use this workspace, listed or not. Revoking one stops it at
        once.
      </p>
      {grants.isPending && (
        <div className="mt-4">
          <LoadingRows label="Loading installed apps" />
        </div>
      )}
      {grants.error && (
        <div className="mt-4">
          <ErrorNotice message={grants.error.message} />
        </div>
      )}
      {grants.data && grants.data.length === 0 && !shorthopConnected && (
        <p className="mt-4 text-[13.5px] text-sub">No apps are installed.</p>
      )}
      {(shorthopConnected || (grants.data && grants.data.length > 0)) && (
        <ul className="mt-3 divide-y divide-line">
          {shorthopConnected && (
            <li className="flex flex-wrap items-start gap-3 py-3.5 text-[13.5px]">
              <AppIcon url={SHORTHOP.iconUrl} size={36} />
              <div className="min-w-0 flex-1">
                <b>{SHORTHOP.name}</b>
                <span className="block text-[12px] text-sub">{SHORTHOP.tagline}</span>
              </div>
              <Button variant="quiet" size="sm" onClick={() => setManaging(true)}>
                Manage
              </Button>
            </li>
          )}
          {grants.data?.map((grant) => (
            <li key={grant.id} className="flex flex-wrap items-start gap-3 py-3.5 text-[13.5px]">
              <AppIcon url={icons.get(grant.app.id) ?? null} size={36} />
              <div className="min-w-0 flex-1">
                <b>{grant.app.name}</b>
                <span className="block text-[12px] text-sub">
                  {grant.channelIds
                    ? `${grant.channelIds.length} ${grant.channelIds.length === 1 ? 'publication' : 'publications'}`
                    : 'Every publication'}{' '}
                  · installed {date.format(new Date(grant.createdAt))}
                  {grant.authorisedBy ? ` by ${grant.authorisedBy}` : ''}
                </span>
                <ul className="mt-1 grid gap-0.5 text-[12.5px] text-sub">
                  {grant.scopes.map((scope) => (
                    <li key={scope}>{SCOPE_LABELS[scope]}</li>
                  ))}
                </ul>
              </div>
              <Button variant="quiet" size="sm" onClick={() => setRevoking(grant)}>
                Revoke access
              </Button>
            </li>
          ))}
        </ul>
      )}
      {managing && <ShorthopDialog onClose={() => setManaging(false)} />}
      <Dialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        title={`Revoke access for ${revoking?.app.name ?? 'this app'}?`}
        description="Its tokens stop working at once. Installing it again means asking for permission again."
        actions={
          <>
            <Button variant="ghost" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={revoke.isPending}
              onClick={() =>
                revoking &&
                revoke.mutate(revoking.id, {
                  onSuccess: () => {
                    setRevoking(null);
                    void client.invalidateQueries({
                      queryKey: directoryKeys.directoryAll(workspace.id),
                    });
                  },
                })
              }
            >
              Revoke access
            </Button>
          </>
        }
      >
        {revoke.error && <ErrorNotice message={revoke.error.message} />}
      </Dialog>
    </section>
  );
}

// ---- Review (platform staff) -----------------------------------------------------------------

type Decision = {
  kind: 'listings' | 'recipes';
  id: string;
  name: string;
  decision: 'approve' | 'reject' | 'delist';
  /** A listing's reviewVersion, so the server refuses a decision on a version not shown here. */
  version?: string;
};

function Review({ queue }: { queue: ReviewQueue }) {
  const [deciding, setDeciding] = useState<Decision | null>(null);
  const empty =
    !queue.listings.length &&
    !queue.recipes.length &&
    !queue.approvedListings.length &&
    !queue.approvedRecipes.length;
  if (empty) return <EmptyState title="Nothing to review">New submissions appear here.</EmptyState>;

  return (
    <div className="grid gap-6">
      <section aria-labelledby="review-listings" className="grid gap-3">
        <h2 id="review-listings" className="text-[16px] font-semibold">
          Listings waiting ({queue.listings.length})
        </h2>
        {queue.listings.length === 0 && <p className="text-[13.5px] text-sub">None.</p>}
        {queue.listings.map((listing) => (
          <ListingReview key={listing.id} listing={listing} onDecide={setDeciding} />
        ))}
      </section>
      <section aria-labelledby="review-recipes" className="grid gap-3">
        <h2 id="review-recipes" className="text-[16px] font-semibold">
          Community recipes waiting ({queue.recipes.length})
        </h2>
        {queue.recipes.length === 0 && <p className="text-[13.5px] text-sub">None.</p>}
        {queue.recipes.map((recipe) => (
          <RecipeReview key={recipe.id} recipe={recipe} onDecide={setDeciding} />
        ))}
      </section>
      <section aria-labelledby="review-listed" className="card-app p-5">
        <h2 id="review-listed" className="text-[16px] font-semibold">
          Listed now
        </h2>
        <ul className="mt-2 divide-y divide-line text-[13.5px]">
          {[
            ...queue.approvedListings.map((l) => ({
              kind: 'listings' as const,
              id: l.id,
              name: l.name,
            })),
            ...queue.approvedRecipes.map((r) => ({
              kind: 'recipes' as const,
              id: r.id,
              name: r.name,
            })),
          ].map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-3 py-2.5">
              <span>
                {item.name}{' '}
                <span className="text-sub">
                  {item.kind === 'listings' ? 'App' : 'Community recipe'}
                </span>
              </span>
              <Button
                variant="quiet"
                size="sm"
                onClick={() => setDeciding({ ...item, decision: 'delist' })}
              >
                Delist
              </Button>
            </li>
          ))}
        </ul>
      </section>
      {deciding && <DecisionDialog decision={deciding} onClose={() => setDeciding(null)} />}
    </div>
  );
}

function DecisionActions({
  onDecide,
  kind,
  id,
  name,
  version,
}: {
  onDecide: (d: Decision) => void;
  kind: Decision['kind'];
  id: string;
  name: string;
  version?: string;
}) {
  const item = { kind, id, name, ...(version ? { version } : {}) };
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      <Button size="sm" onClick={() => onDecide({ ...item, decision: 'approve' })}>
        Approve
      </Button>
      <Button variant="ghost" size="sm" onClick={() => onDecide({ ...item, decision: 'reject' })}>
        Reject
      </Button>
    </div>
  );
}

function ListingReview({
  listing,
  onDecide,
}: {
  listing: ReviewQueue['listings'][number];
  onDecide: (d: Decision) => void;
}) {
  const declared = new Set(listing.scopes);
  return (
    <article className="card-app p-5 text-[13.5px]" aria-label={listing.name}>
      <div className="flex gap-3">
        <AppIcon url={listing.icon?.url ?? null} />
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold">{listing.name}</h3>
          <p className="text-sub">{listing.tagline}</p>
          <p className="text-[12px] text-sub">
            {listing.appName} · {listing.app.clientType} · submitted{' '}
            {listing.submittedAt ? date.format(new Date(listing.submittedAt)) : '—'}
          </p>
        </div>
      </div>
      {listing.description && <p className="mt-3 whitespace-pre-line">{listing.description}</p>}
      <dl className="mt-3 grid gap-2 sm:grid-cols-[180px_1fr]">
        <dt className="font-semibold">Declared scopes</dt>
        <dd>{listing.scopes.map((s) => SCOPE_LABELS[s]).join('; ') || '—'}</dd>
        <dt className="font-semibold">Registered, not declared</dt>
        <dd>
          {listing.app.scopes
            .filter((s) => !declared.has(s))
            .map((s) => SCOPE_LABELS[s])
            .join('; ') || 'None'}
        </dd>
        <dt className="font-semibold">Redirect URIs</dt>
        <dd className="font-mono text-[12px] break-all">{listing.app.redirectUris.join(', ')}</dd>
        <dt className="font-semibold">Install address</dt>
        <dd className="break-all">{listing.installUrl}</dd>
        <dt className="font-semibold">Website, support, privacy</dt>
        <dd className="break-all">
          {[listing.websiteUrl, listing.supportUrl, listing.privacyUrl].join(' · ')}
        </dd>
        <dt className="font-semibold">Events</dt>
        <dd>{listing.webhookEvents.join(', ') || 'None'}</dd>
      </dl>
      {listing.screenshots.length > 0 && (
        <div className="mt-3 flex gap-2 overflow-x-auto">
          {listing.screenshots.map((s, i) => (
            <img
              key={s.mediaId}
              src={s.url}
              alt={`Screenshot ${i + 1}`}
              className="h-24 rounded-[10px] border border-line-app"
            />
          ))}
        </div>
      )}
      <DecisionActions
        onDecide={onDecide}
        kind="listings"
        id={listing.id}
        name={listing.name}
        version={listing.reviewVersion}
      />
    </article>
  );
}

function RecipeReview({
  recipe,
  onDecide,
}: {
  recipe: RecipeSubmission;
  onDecide: (d: Decision) => void;
}) {
  return (
    <article className="card-app p-5 text-[13.5px]" aria-label={recipe.name}>
      <h3 className="text-[15px] font-semibold">{recipe.name}</h3>
      <p className="text-sub">{recipe.description}</p>
      <p className="mt-2 text-[12px] text-sub">
        {recipe.recipe.nodes.length} steps · {recipe.emailCount}{' '}
        {recipe.emailCount === 1 ? 'email' : 'emails'} · starts on {recipe.triggerType}
      </p>
      {recipe.recipe.emails.map((email) => (
        <section key={email.key} className="mt-3 rounded-card-app border border-line-app p-3">
          <h4 className="font-semibold">{email.subject || '(no subject)'}</h4>
          {email.preheader && <p className="text-[12.5px] text-sub">{email.preheader}</p>}
          <div className="mt-2 grid gap-1 whitespace-pre-line">
            {documentText(email.content).map((line, i) => (
              <p key={i}>{line}</p>
            ))}
          </div>
        </section>
      ))}
      <ul className="mt-3 grid gap-1 text-[12.5px] text-sub">
        {recipe.recipe.nodes
          .filter((n) => n.name || n.type === 'notify_author')
          .map((n) => (
            <li key={n.id}>
              {n.name ?? n.type}
              {typeof n.config.message === 'string' ? `: ${n.config.message}` : ''}
            </li>
          ))}
      </ul>
      <DecisionActions onDecide={onDecide} kind="recipes" id={recipe.id} name={recipe.name} />
    </article>
  );
}

const DECISION_COPY = {
  approve: { title: 'Approve', button: 'Approve', note: 'Note for the developer (optional)' },
  reject: { title: 'Reject', button: 'Reject', note: 'What has to change' },
  delist: { title: 'Delist', button: 'Delist', note: 'Why it is being removed' },
} as const;

function DecisionDialog({ decision, onClose }: { decision: Decision; onClose: () => void }) {
  const review = useReview();
  const [note, setNote] = useState('');
  const copy = DECISION_COPY[decision.decision];
  const needsNote = decision.decision !== 'approve';
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${copy.title} ${decision.name}?`}
      description={
        decision.decision === 'approve'
          ? 'It appears in the directory at once.'
          : 'The developer sees your note in their dashboard and audit log.'
      }
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={decision.decision === 'approve' ? 'primary' : 'danger'}
            loading={review.isPending}
            disabled={needsNote && !note.trim()}
            onClick={() =>
              review.mutate(
                {
                  kind: decision.kind,
                  id: decision.id,
                  decision: decision.decision,
                  ...(decision.version ? { version: decision.version } : {}),
                  ...(note.trim() ? { note: note.trim() } : {}),
                },
                { onSuccess: onClose },
              )
            }
          >
            {copy.button}
          </Button>
        </>
      }
    >
      <TextAreaField
        label={copy.note}
        value={note}
        maxLength={1000}
        rows={3}
        onChange={(e) => setNote(e.target.value)}
      />
      {review.error && (
        <div className="mt-3">
          <ErrorNotice message={review.error.message} />
        </div>
      )}
    </Dialog>
  );
}
