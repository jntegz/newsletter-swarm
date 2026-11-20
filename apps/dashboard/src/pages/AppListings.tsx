// Settings → Developers → Directory listings (Phase 8): list this workspace's OAuth apps in the
// App Directory. Create a listing or import an app manifest, fill it in (icon and screenshots
// from Media), submit it for review, withdraw or delete it, and export it as a manifest.
// Admins and owners only, as for OAuth apps. Contract: docs/app-directory.md.
import {
  APP_CATEGORIES,
  APP_CATEGORY_LABELS,
  APP_MAX_CATEGORIES,
  APP_MAX_SCREENSHOTS,
  SCOPE_LABELS,
  WEBHOOK_EVENT_GROUPS,
  type ApiScope,
  type AppCategory,
  type AppListing,
  type MediaAsset,
  type OAuthApp,
  type WebhookEventType,
} from '@swarm/domain';
import {
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  Pill,
  SelectField,
  TextAreaField,
  TextField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import {
  appListingsQuery,
  fetchManifest,
  isDirectoryOff,
  useCreateListing,
  useDeleteListing,
  useImportManifest,
  useListingAction,
  useUpdateListing,
} from '../api/appDirectory';
import { oauthAppsQuery } from '../api/oauth';
import { channelsQuery } from '../api/queries';
import { useSession } from '../session';
import {
  STATUS_LABEL,
  STATUS_TONE,
  canSubmit,
  canWithdraw,
  parseManifestText,
} from './app-directory-helpers';
import { MediaPicker } from './MediaPicker';

export function AppListingsSettings() {
  const { workspace, can } = useSession();
  if (!can('admin')) {
    return (
      <EmptyState title="Admins manage directory listings">
        Ask an admin or owner of {workspace.name} to list an app in the App Directory.
      </EmptyState>
    );
  }
  return <Listings workspaceId={workspace.id} />;
}

function Listings({ workspaceId }: { workspaceId: string }) {
  const listings = useQuery(appListingsQuery(workspaceId));
  const apps = useQuery(oauthAppsQuery(workspaceId));
  const action = useListingAction(workspaceId);
  const remove = useDeleteListing(workspaceId);
  const [dialog, setDialog] = useState<'new' | 'import' | null>(null);
  const [editing, setEditing] = useState<AppListing | null>(null);
  const [deleting, setDeleting] = useState<AppListing | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  if (isDirectoryOff(listings.error)) {
    return (
      <EmptyState title="The App Directory is not turned on">
        Your OAuth apps keep working. Ask a workspace owner if you’d like to list them.
      </EmptyState>
    );
  }

  const listed = new Set((listings.data ?? []).map((l) => l.appId));
  const unlisted = (apps.data ?? []).filter((a) => !listed.has(a.id));

  const download = async (listing: AppListing) => {
    setExportError(null);
    try {
      const manifest = await fetchManifest(workspaceId, listing.id);
      const url = URL.createObjectURL(
        new Blob([`${JSON.stringify(manifest, null, 2)}\n`], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `${listing.slug}.swarm-app.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setExportError((error as Error).message);
    }
  };

  return (
    <section aria-labelledby="listings-title" className="card-app overflow-x-auto p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="listings-title" className="text-[16px] font-semibold">
            Directory listings
          </h2>
          <p className="mt-1 max-w-[560px] text-[13px] text-sub">
            List your OAuth apps in the App Directory so other workspaces can find them. Swarm
            reviews every listing before it appears, and again after each change.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" disabled={!apps.data?.length} onClick={() => setDialog('import')}>
            Import a manifest
          </Button>
          <Button disabled={!unlisted.length} onClick={() => setDialog('new')}>
            List an app
          </Button>
        </div>
      </div>
      {(listings.isPending || apps.isPending) && (
        <div className="mt-4">
          <LoadingRows label="Loading listings" />
        </div>
      )}
      {listings.error && (
        <div className="mt-4">
          <ErrorNotice message={listings.error.message} />
        </div>
      )}
      {(action.error ?? exportError) && (
        <div className="mt-4">
          <ErrorNotice
            title="That did not work"
            message={action.error?.message ?? exportError ?? ''}
          />
        </div>
      )}
      {apps.data && apps.data.length === 0 && (
        <p className="mt-4 text-[13.5px] text-sub">
          Register an OAuth app first, under OAuth apps.
        </p>
      )}
      {listings.data && listings.data.length === 0 && !!apps.data?.length && (
        <p className="mt-4 text-[13.5px] text-sub">No listings yet.</p>
      )}
      {listings.data && listings.data.length > 0 && (
        <ul className="mt-3 divide-y divide-line">
          {listings.data.map((listing) => (
            <li
              key={listing.id}
              className="flex flex-wrap items-start justify-between gap-3 py-3.5"
            >
              <div className="min-w-0 text-[13.5px]">
                <b>{listing.name}</b>{' '}
                <Pill tone={STATUS_TONE[listing.status]}>{STATUS_LABEL[listing.status]}</Pill>
                {listing.appRevoked && <Pill tone="danger">App revoked</Pill>}
                <span className="block text-[12px] text-sub">
                  {listing.appName} · /{listing.slug}
                </span>
                {listing.reviewNote && (
                  <span className="mt-1 block text-[12.5px]">
                    <b>Note from Swarm:</b> {listing.reviewNote}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" size="sm" onClick={() => setEditing(listing)}>
                  Edit
                </Button>
                {canSubmit(listing.status) && (
                  <Button
                    size="sm"
                    loading={action.isPending && action.variables?.id === listing.id}
                    onClick={() => action.mutate({ id: listing.id, action: 'submit' })}
                  >
                    Submit for review
                  </Button>
                )}
                {canWithdraw(listing.status) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={action.isPending && action.variables?.id === listing.id}
                    onClick={() => action.mutate({ id: listing.id, action: 'withdraw' })}
                  >
                    Withdraw
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => void download(listing)}>
                  Export manifest
                </Button>
                <Button variant="quiet" size="sm" onClick={() => setDeleting(listing)}>
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {dialog === 'new' && (
        <NewListingDialog
          workspaceId={workspaceId}
          apps={unlisted}
          onClose={() => setDialog(null)}
          onCreated={(listing) => {
            setDialog(null);
            setEditing(listing);
          }}
        />
      )}
      {dialog === 'import' && apps.data && (
        <ImportDialog workspaceId={workspaceId} apps={apps.data} onClose={() => setDialog(null)} />
      )}
      {editing && (
        <ListingDialog
          workspaceId={workspaceId}
          listing={editing}
          appScopes={apps.data?.find((a) => a.id === editing.appId)?.scopes ?? editing.scopes}
          onClose={() => setEditing(null)}
        />
      )}
      <Dialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete the listing for ${deleting?.name ?? 'this app'}?`}
        description="It leaves the directory. The app stays registered and installed apps keep working."
        actions={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() =>
                deleting && remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })
              }
            >
              Delete listing
            </Button>
          </>
        }
      >
        {remove.error && <ErrorNotice message={remove.error.message} />}
      </Dialog>
    </section>
  );
}

function NewListingDialog({
  workspaceId,
  apps,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  apps: OAuthApp[];
  onClose: () => void;
  onCreated: (listing: AppListing) => void;
}) {
  const create = useCreateListing(workspaceId);
  const [appId, setAppId] = useState(apps[0]?.id ?? '');
  const app = apps.find((a) => a.id === appId);
  const [name, setName] = useState(app?.name ?? '');
  const error = create.error instanceof ApiError ? create.error : null;
  return (
    <Dialog
      open
      onClose={onClose}
      title="List an app"
      description="Start a draft. You fill in the rest before submitting it for review."
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={create.isPending}
            disabled={!appId || !name.trim()}
            onClick={() =>
              create.mutate(
                { appId, name: name.trim(), scopes: app?.scopes ?? [] },
                { onSuccess: onCreated },
              )
            }
          >
            Create draft
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <SelectField
          label="OAuth app"
          value={appId}
          onChange={(e) => {
            setAppId(e.target.value);
            setName(apps.find((a) => a.id === e.target.value)?.name ?? name);
          }}
          options={apps.map((a) => ({ value: a.id, label: a.name }))}
        />
        <TextField
          label="Name in the directory"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={error?.field('name')}
        />
        {error && !error.field('name') && <ErrorNotice message={error.message} />}
      </div>
    </Dialog>
  );
}

function ImportDialog({
  workspaceId,
  apps,
  onClose,
}: {
  workspaceId: string;
  apps: OAuthApp[];
  onClose: () => void;
}) {
  const importer = useImportManifest(workspaceId);
  const [appId, setAppId] = useState(apps[0]?.id ?? '');
  const [text, setText] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const error = importer.error instanceof ApiError ? importer.error : null;

  const submit = () => {
    const parsed = parseManifestText(text);
    if ('error' in parsed) {
      setParseError(parsed.error);
      return;
    }
    setParseError(null);
    importer.mutate({ appId, manifest: parsed.manifest }, { onSuccess: onClose });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Import an app manifest"
      description="The manifest has to match the app’s registration: client type, redirect URIs and scopes. The listing becomes a draft."
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={importer.isPending} onClick={submit}>
            Import
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <SelectField
          label="OAuth app"
          value={appId}
          onChange={(e) => setAppId(e.target.value)}
          options={apps.map((a) => ({ value: a.id, label: a.name }))}
        />
        <label className="btn-ghost btn-sm w-fit cursor-pointer focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-purple">
          Choose a file
          <input
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void file.text().then(setText);
              event.target.value = '';
            }}
          />
        </label>
        <TextAreaField
          label="Manifest (JSON)"
          rows={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
          error={parseError ?? undefined}
          hint="Spec and JSON Schema: docs/app-directory.md."
        />
        {error && (
          <ErrorNotice
            title={error.message}
            message={error.details.map((d) => `${d.path}: ${d.message}`).join(' ') || ' '}
          />
        )}
      </div>
    </Dialog>
  );
}

function ListingDialog({
  workspaceId,
  listing,
  appScopes,
  onClose,
}: {
  workspaceId: string;
  listing: AppListing;
  appScopes: ApiScope[];
  onClose: () => void;
}) {
  const update = useUpdateListing(workspaceId);
  const channels = useQuery(channelsQuery(workspaceId));
  const [channelId, setChannelId] = useState('');
  const mediaChannel = channelId || channels.data?.[0]?.id || '';
  const [picking, setPicking] = useState<'icon' | 'screenshot' | null>(null);
  const [form, setForm] = useState({
    name: listing.name,
    slug: listing.slug,
    tagline: listing.tagline,
    description: listing.description,
    websiteUrl: listing.websiteUrl ?? '',
    supportUrl: listing.supportUrl ?? '',
    privacyUrl: listing.privacyUrl ?? '',
    installUrl: listing.installUrl ?? '',
  });
  const [icon, setIcon] = useState(listing.icon);
  const [shots, setShots] = useState(listing.screenshots);
  const [categories, setCategories] = useState<Set<AppCategory>>(new Set(listing.categories));
  const [scopes, setScopes] = useState<Set<ApiScope>>(new Set(listing.scopes));
  const [events, setEvents] = useState<Set<WebhookEventType>>(new Set(listing.webhookEvents));
  const error = update.error instanceof ApiError ? update.error : null;

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  const toggle =
    <T,>(setter: (fn: (current: Set<T>) => Set<T>) => void, value: T) =>
    (on: boolean) =>
      setter((current) => {
        const next = new Set(current);
        if (on) next.add(value);
        else next.delete(value);
        return next;
      });

  const choose = (asset: MediaAsset) => {
    const image = { mediaId: asset.id, url: asset.url };
    if (picking === 'icon') setIcon(image);
    else if (!shots.some((s) => s.mediaId === asset.id)) setShots([...shots, image]);
    setPicking(null);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate(
      {
        id: listing.id,
        ...form,
        websiteUrl: form.websiteUrl.trim() || null,
        supportUrl: form.supportUrl.trim() || null,
        privacyUrl: form.privacyUrl.trim() || null,
        installUrl: form.installUrl.trim() || null,
        iconMediaId: icon?.mediaId ?? null,
        screenshotMediaIds: shots.map((s) => s.mediaId),
        categories: [...categories],
        scopes: [...scopes],
        webhookEvents: [...events],
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Edit ${listing.name}`}
      description={
        listing.status === 'approved'
          ? 'Saving takes the listing out of the directory until Swarm approves it again.'
          : 'Saving keeps it as a draft. Submit it for review when it is complete.'
      }
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="listing-form" loading={update.isPending}>
            Save draft
          </Button>
        </>
      }
    >
      <form id="listing-form" onSubmit={submit} className="grid gap-4">
        <TextField
          label="Name"
          required
          maxLength={80}
          value={form.name}
          onChange={(e) => set('name')(e.target.value)}
          error={error?.field('name')}
        />
        <TextField
          label="Address in the directory"
          maxLength={50}
          value={form.slug}
          onChange={(e) => set('slug')(e.target.value)}
          error={error?.field('slug')}
          hint="Lowercase letters, digits and -."
        />
        <TextField
          label="Tagline"
          maxLength={120}
          value={form.tagline}
          onChange={(e) => set('tagline')(e.target.value)}
          error={error?.field('tagline')}
        />
        <TextAreaField
          label="Description"
          rows={5}
          maxLength={5000}
          value={form.description}
          onChange={(e) => set('description')(e.target.value)}
          hint="Plain text. Line breaks are kept."
        />

        <fieldset className="grid gap-2">
          <legend className="mb-1 text-[13px] font-semibold">Icon and screenshots</legend>
          <div className="flex flex-wrap items-center gap-2">
            {icon ? (
              <img
                src={icon.url}
                alt="Icon"
                className="h-12 w-12 rounded-card-app border border-line-app object-cover"
              />
            ) : (
              <span className="text-[13px] text-sub">No icon yet.</span>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={!mediaChannel}
              onClick={() => setPicking('icon')}
            >
              {icon ? 'Change icon' : 'Choose an icon'}
            </Button>
          </div>
          {error?.field('iconMediaId') && (
            <p role="alert" className="text-[12.5px] font-semibold text-danger">
              {error.field('iconMediaId')}
            </p>
          )}
          <ul className="flex flex-wrap gap-2">
            {shots.map((shot, i) => (
              <li key={shot.mediaId} className="grid gap-1">
                <img
                  src={shot.url}
                  alt={`Screenshot ${i + 1}`}
                  className="h-16 rounded-[8px] border border-line-app"
                />
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => setShots(shots.filter((s) => s.mediaId !== shot.mediaId))}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          <Button
            variant="ghost"
            size="sm"
            className="w-fit"
            disabled={!mediaChannel || shots.length >= APP_MAX_SCREENSHOTS}
            onClick={() => setPicking('screenshot')}
          >
            Add a screenshot
          </Button>
          {picking && (
            <div className="grid gap-3 rounded-card-app border border-line-app p-3">
              {(channels.data?.length ?? 0) > 1 && (
                <SelectField
                  label="Media from"
                  value={mediaChannel}
                  onChange={(e) => setChannelId(e.target.value)}
                  options={(channels.data ?? []).map((ch) => ({ value: ch.id, label: ch.name }))}
                />
              )}
              <MediaPicker channelId={mediaChannel} chosen={null} onChoose={choose} />
              <Button variant="quiet" size="sm" className="w-fit" onClick={() => setPicking(null)}>
                Done
              </Button>
            </div>
          )}
        </fieldset>

        <fieldset className="grid gap-2">
          <legend className="mb-1 text-[13px] font-semibold">
            Categories (up to {APP_MAX_CATEGORIES})
          </legend>
          {APP_CATEGORIES.map((c) => (
            <Checkbox
              key={c}
              label={APP_CATEGORY_LABELS[c]}
              checked={categories.has(c)}
              disabled={!categories.has(c) && categories.size >= APP_MAX_CATEGORIES}
              onChange={toggle(setCategories, c)}
            />
          ))}
        </fieldset>

        <fieldset className="grid gap-2">
          <legend className="mb-1 text-[13px] font-semibold">Scopes the app asks for</legend>
          {appScopes.map((scope) => (
            <Checkbox
              key={scope}
              label={SCOPE_LABELS[scope]}
              hint={scope}
              checked={scopes.has(scope)}
              onChange={toggle(setScopes, scope)}
            />
          ))}
          {error?.details.some((d) => d.path.startsWith('scopes')) && (
            <p role="alert" className="text-[12.5px] font-semibold text-danger">
              {error.details.find((d) => d.path.startsWith('scopes'))?.message}
            </p>
          )}
        </fieldset>

        <fieldset className="grid gap-2">
          <legend className="mb-1 text-[13px] font-semibold">Webhook events it uses</legend>
          {WEBHOOK_EVENT_GROUPS.flatMap((group) => group.events).map((event) => (
            <Checkbox
              key={event}
              label={event}
              checked={events.has(event)}
              onChange={toggle(setEvents, event)}
            />
          ))}
        </fieldset>

        <TextField
          label="Website"
          type="url"
          value={form.websiteUrl}
          onChange={(e) => set('websiteUrl')(e.target.value)}
          error={error?.field('websiteUrl')}
        />
        <TextField
          label="Support"
          value={form.supportUrl}
          onChange={(e) => set('supportUrl')(e.target.value)}
          error={error?.field('supportUrl')}
          hint="A web address or mailto:"
        />
        <TextField
          label="Privacy policy"
          type="url"
          value={form.privacyUrl}
          onChange={(e) => set('privacyUrl')(e.target.value)}
          error={error?.field('privacyUrl')}
        />
        <TextField
          label="Install address"
          type="url"
          value={form.installUrl}
          onChange={(e) => set('installUrl')(e.target.value)}
          error={error?.field('installUrl')}
          hint="Where your app starts the authorization request with PKCE. The Install button opens it."
        />
        {error && !error.details.length && <ErrorNotice message={error.message} />}
      </form>
    </Dialog>
  );
}
