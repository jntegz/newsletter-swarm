// Site Studio → Link Hub (Phase 8, flag link_hub): the Channel's link-in-bio page at /links.
// Settings and links on the left, a live preview of the page on the right that follows unsaved
// settings, and the click report below. Viewers and authors see everything read-only.
import {
  HUB_SOCIAL_LABELS,
  HUB_SOCIAL_NETWORKS,
  MAX_HUB_LATEST_DISPATCHES,
  MAX_HUB_LINKS,
  MAX_HUB_SOCIALS,
  type HubLink,
  type HubSocial,
  type HubSocialNetwork,
  type LinkHub,
  type LinkHubAnalytics,
  type MediaAsset,
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
import { useId, useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import { captureFormsQuery } from '../api/capture';
import {
  linkHubAnalyticsQuery,
  linkHubQuery,
  useCreateHubLink,
  useDeleteHubLink,
  useReorderHubLinks,
  useUpdateHubLink,
  useUpdateLinkHub,
} from '../api/linkHub';
import { mediaQuery } from '../api/queries';
import { isFeatureDisabled } from '../api/site';
import { ReadOnlyNote, SaveRow } from '../site/controls';
import { dayOf, lastDays, moveItem, niceMax, tickIndexes } from '../site/helpers';
import {
  SITE_PALETTE,
  clickThrough,
  hubLinkProblem,
  hubLinkStatus,
  isoFromLocalInput,
  localInputValue,
  onAccent,
  siteAccent,
} from '../site/link-hub-helpers';
import { Section, formatDateTime, numberFormat } from './common';
import { MediaPicker } from './MediaPicker';
import { useSiteStudio } from './SiteStudio';

export function SiteLinkHub() {
  const { channel } = useSiteStudio();
  const hub = useQuery(linkHubQuery(channel.id));
  if (hub.isPending) return <LoadingRows label="Loading Link Hub" rows={4} />;
  if (isFeatureDisabled(hub.error)) {
    return (
      <EmptyState title="Link Hub is not turned on">
        Ask a workspace owner if you’d like to use it for {channel.name}.
      </EmptyState>
    );
  }
  if (hub.error) return <ErrorNotice message={hub.error.message} />;
  return <LinkHubEditor hub={hub.data} />;
}

interface SettingsDraft {
  enabled: boolean;
  title: string;
  bio: string;
  socials: HubSocial[];
  latestDispatches: number;
  showCaptureForm: boolean;
  captureFormId: string;
}

const draftOf = (hub: LinkHub): SettingsDraft => ({
  enabled: hub.enabled,
  title: hub.title ?? '',
  bio: hub.bio ?? '',
  socials: hub.socials,
  latestDispatches: hub.latestDispatches,
  showCaptureForm: hub.showCaptureForm,
  captureFormId: hub.captureFormId ?? '',
});

function LinkHubEditor({ hub }: { hub: LinkHub }) {
  const { channel, canEdit } = useSiteStudio();
  const [draft, setDraft] = useState(() => draftOf(hub));
  return (
    <div className="grid gap-5">
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid gap-5">
          <SettingsForm hub={hub} draft={draft} onDraft={setDraft} />
          <LinksSection hub={hub} />
        </div>
        <aside aria-label="Preview" className="lg:sticky lg:top-6">
          <Preview hub={hub} draft={draft} />
          <p className="mt-2 text-[12.5px] text-sub">
            {hub.enabled ? (
              <>
                Live at{' '}
                <a href={hub.url} target="_blank" rel="noreferrer" className="text-purple-deep">
                  <span className="font-mono break-all">{hub.url}</span>
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </>
            ) : (
              'Not published yet. Switch the page on and save to put it on the website.'
            )}
          </p>
        </aside>
      </div>
      <Report channelId={channel.id} links={hub.links} />
      {!canEdit && <ReadOnlyNote>An editor or admin changes the Link Hub.</ReadOnlyNote>}
    </div>
  );
}

// ---- Settings ------------------------------------------------------------------------------

function SettingsForm({
  hub,
  draft,
  onDraft,
}: {
  hub: LinkHub;
  draft: SettingsDraft;
  onDraft: (draft: SettingsDraft) => void;
}) {
  const { channel, canEdit } = useSiteStudio();
  const update = useUpdateLinkHub(channel.id);
  const forms = useQuery(captureFormsQuery(channel.id));
  const [saved, setSaved] = useState(false);
  const apiError = update.error instanceof ApiError ? update.error : null;
  const set = (patch: Partial<SettingsDraft>) => {
    setSaved(false);
    onDraft({ ...draft, ...patch });
  };
  const published = (forms.data ?? []).filter((f) => f.kind === 'form' && f.status === 'published');
  const socialProblem = draft.socials.findIndex((s) => !/^https:\/\/[^\s/]+/.test(s.url.trim()));

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (socialProblem >= 0) return;
    const before = draftOf(hub);
    const input: Parameters<typeof update.mutate>[0] = {};
    if (draft.enabled !== before.enabled) input.enabled = draft.enabled;
    if (draft.title.trim() !== before.title) input.title = draft.title.trim() || null;
    if (draft.bio.trim() !== before.bio) input.bio = draft.bio.trim() || null;
    const socials = draft.socials.map((s) => ({ network: s.network, url: s.url.trim() }));
    if (JSON.stringify(socials) !== JSON.stringify(before.socials)) input.socials = socials;
    if (draft.latestDispatches !== before.latestDispatches) {
      input.latestDispatches = draft.latestDispatches;
    }
    if (draft.showCaptureForm !== before.showCaptureForm) {
      input.showCaptureForm = draft.showCaptureForm;
    }
    if (draft.captureFormId !== before.captureFormId) {
      input.captureFormId = draft.captureFormId || null;
    }
    setSaved(false);
    if (Object.keys(input).length === 0) {
      setSaved(true);
      return;
    }
    update.mutate(input, {
      onSuccess: (next) => {
        onDraft(draftOf(next));
        setSaved(true);
      },
    });
  };

  return (
    <form onSubmit={save} className="grid gap-5" aria-label="Link Hub settings">
      <Section
        title="Page"
        description="A page of links for your social profiles, at /links on the website. It uses the site's colours and fonts."
      >
        <div className="grid gap-4">
          <Checkbox
            label="Publish the Link Hub page"
            hint="While this is off, /links shows the site's not-found page."
            checked={draft.enabled}
            disabled={!canEdit}
            onChange={(enabled) => set({ enabled })}
          />
          <TextField
            label="Title"
            value={draft.title}
            maxLength={80}
            disabled={!canEdit}
            placeholder={channel.name}
            hint="Leave empty to use the publication name."
            onChange={(e) => set({ title: e.target.value })}
            error={apiError?.field('title')}
          />
          <TextAreaField
            label="Bio"
            value={draft.bio}
            maxLength={280}
            disabled={!canEdit}
            placeholder={channel.description ?? 'What readers get from you, in a sentence.'}
            hint={`${draft.bio.length} of 280 characters.`}
            onChange={(e) => set({ bio: e.target.value })}
            error={apiError?.field('bio')}
          />
          <SelectField
            label="Latest posts"
            value={String(draft.latestDispatches)}
            disabled={!canEdit}
            onChange={(e) => set({ latestDispatches: Number(e.target.value) })}
            options={Array.from({ length: MAX_HUB_LATEST_DISPATCHES + 1 }, (_, n) => ({
              value: String(n),
              label: n === 0 ? 'Don’t show posts' : `Show the newest ${n}`,
            }))}
          />
          <Checkbox
            label="Show a subscribe form"
            checked={draft.showCaptureForm}
            disabled={!canEdit}
            onChange={(showCaptureForm) => set({ showCaptureForm })}
          />
          {draft.showCaptureForm && (
            <SelectField
              label="Signup form"
              value={draft.captureFormId}
              disabled={!canEdit || forms.isPending}
              onChange={(e) => set({ captureFormId: e.target.value })}
              hint="Only published forms can be chosen. The site form is the one the rest of the website shows."
              error={apiError?.field('captureFormId')}
              options={[
                { value: '', label: 'The site’s form' },
                ...published.map((f) => ({ value: f.id, label: f.name })),
              ]}
            />
          )}
        </div>
      </Section>

      <Section
        title="Social profiles"
        description={`Shown as buttons under the bio, up to ${MAX_HUB_SOCIALS}. Use https addresses.`}
        action={
          canEdit && draft.socials.length < MAX_HUB_SOCIALS ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                set({ socials: [...draft.socials, { network: 'website', url: 'https://' }] })
              }
            >
              Add profile
            </Button>
          ) : undefined
        }
      >
        {draft.socials.length === 0 ? (
          <p className="text-[13px] text-sub">No profiles yet.</p>
        ) : (
          <ul className="grid gap-3">
            {draft.socials.map((social, index) => (
              <li
                key={index}
                className="grid gap-2 sm:grid-cols-[160px_minmax(0,1fr)_auto] sm:items-start"
              >
                <SelectField
                  label={`Network ${index + 1}`}
                  value={social.network}
                  disabled={!canEdit}
                  onChange={(e) =>
                    set({
                      socials: draft.socials.map((s, i) =>
                        i === index ? { ...s, network: e.target.value as HubSocialNetwork } : s,
                      ),
                    })
                  }
                  options={HUB_SOCIAL_NETWORKS.map((n) => ({
                    value: n,
                    label: HUB_SOCIAL_LABELS[n],
                  }))}
                />
                <TextField
                  label={`Address ${index + 1}`}
                  type="url"
                  value={social.url}
                  disabled={!canEdit}
                  className="font-mono text-[13px]"
                  onChange={(e) =>
                    set({
                      socials: draft.socials.map((s, i) =>
                        i === index ? { ...s, url: e.target.value } : s,
                      ),
                    })
                  }
                  error={
                    apiError?.field(`socials.${index}.url`) ??
                    (socialProblem === index ? 'Use an https address.' : undefined)
                  }
                />
                {canEdit && (
                  <Button
                    variant="quiet"
                    size="sm"
                    className="sm:mt-7"
                    aria-label={`Remove profile ${index + 1}`}
                    onClick={() => set({ socials: draft.socials.filter((_, i) => i !== index) })}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {canEdit && (
        <SaveRow
          pending={update.isPending}
          saved={saved}
          error={update.error}
          disabled={socialProblem >= 0}
        />
      )}
    </form>
  );
}

// ---- Links ---------------------------------------------------------------------------------

const STATUS: Record<
  ReturnType<typeof hubLinkStatus>,
  { label: string; tone: 'success' | 'scheduled' | 'neutral' }
> = {
  live: { label: 'Live', tone: 'success' },
  scheduled: { label: 'Scheduled', tone: 'scheduled' },
  ended: { label: 'Ended', tone: 'neutral' },
};

function LinksSection({ hub }: { hub: LinkHub }) {
  const { channel, canEdit } = useSiteStudio();
  const reorder = useReorderHubLinks(channel.id);
  const remove = useDeleteHubLink(channel.id);
  const [editing, setEditing] = useState<HubLink | 'new' | null>(null);
  const [removing, setRemoving] = useState<HubLink | null>(null);
  const [now] = useState(() => Date.now());
  const links = hub.links;
  const move = (from: number, to: number) =>
    reorder.mutate(moveItem(links, from, to).map((l) => l.id));

  return (
    <Section
      title="Links"
      description={`In the order they appear, up to ${MAX_HUB_LINKS}. Clicks are counted on the way through, without cookies.`}
      action={
        canEdit ? (
          <Button
            size="sm"
            disabled={links.length >= MAX_HUB_LINKS}
            onClick={() => setEditing('new')}
          >
            Add link
          </Button>
        ) : undefined
      }
    >
      {reorder.error && <ErrorNotice message={reorder.error.message} />}
      {links.length === 0 ? (
        <EmptyState title="No links yet">
          Add the places you want readers to go: your shop, a podcast, the latest post.
        </EmptyState>
      ) : (
        <ol className="grid gap-2" aria-busy={reorder.isPending}>
          {links.map((link, index) => {
            const status = STATUS[hubLinkStatus(link, now)];
            return (
              <li
                key={link.id}
                className="flex flex-wrap items-center gap-3 rounded-card-app border border-line-app bg-surface px-3.5 py-3"
              >
                {link.thumbnailUrl ? (
                  <img
                    src={link.thumbnailUrl}
                    alt=""
                    className="size-10 flex-none rounded-[10px] object-cover"
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className="size-10 flex-none rounded-[10px] bg-surface-alt"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-semibold">{link.title}</p>
                  <p className="truncate font-mono text-[12px] text-sub">{link.url}</p>
                  {(link.startsAt || link.endsAt) && (
                    <p className="text-[12px] text-sub">
                      {link.startsAt && `From ${formatDateTime(link.startsAt)}`}
                      {link.startsAt && link.endsAt && ' · '}
                      {link.endsAt && `Until ${formatDateTime(link.endsAt)}`}
                    </p>
                  )}
                </div>
                <Pill tone={status.tone}>{status.label}</Pill>
                {canEdit && (
                  <div className="flex flex-wrap gap-1">
                    <Button
                      variant="quiet"
                      size="sm"
                      disabled={index === 0 || reorder.isPending}
                      aria-label={`Move ${link.title} up`}
                      onClick={() => move(index, index - 1)}
                    >
                      Up
                    </Button>
                    <Button
                      variant="quiet"
                      size="sm"
                      disabled={index === links.length - 1 || reorder.isPending}
                      aria-label={`Move ${link.title} down`}
                      onClick={() => move(index, index + 1)}
                    >
                      Down
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Edit ${link.title}`}
                      onClick={() => setEditing(link)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="quiet"
                      size="sm"
                      aria-label={`Remove ${link.title}`}
                      onClick={() => setRemoving(link)}
                    >
                      Remove
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {editing && (
        <LinkDialog
          key={editing === 'new' ? 'new' : editing.id}
          link={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="Remove this link?"
        description="It leaves the page right away. Its clicks stay in the report."
        actions={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() =>
                removing && remove.mutate(removing.id, { onSuccess: () => setRemoving(null) })
              }
            >
              Remove link
            </Button>
          </>
        }
      >
        {removing && <p className="text-[13.5px]">{removing.title}</p>}
        {remove.error && <ErrorNotice message={remove.error.message} />}
      </Dialog>
    </Section>
  );
}

function LinkDialog({ link, onClose }: { link: HubLink | null; onClose: () => void }) {
  const { channel } = useSiteStudio();
  const create = useCreateHubLink(channel.id);
  const update = useUpdateHubLink(channel.id);
  const mutation = link ? update : create;
  const [title, setTitle] = useState(link?.title ?? '');
  const [url, setUrl] = useState(link?.url ?? 'https://');
  const [startsAt, setStartsAt] = useState(localInputValue(link?.startsAt ?? null));
  const [endsAt, setEndsAt] = useState(localInputValue(link?.endsAt ?? null));
  const [thumbnail, setThumbnail] = useState<{ id: string; url: string } | null>(
    link?.thumbnailMediaId && link.thumbnailUrl
      ? { id: link.thumbnailMediaId, url: link.thumbnailUrl }
      : null,
  );
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<MediaAsset | null>(null);
  const [touched, setTouched] = useState(false);
  const formId = useId();
  const problem = hubLinkProblem({ title, url, startsAt, endsAt });
  const apiError = mutation.error instanceof ApiError ? mutation.error : null;
  const fieldError = (field: 'title' | 'url' | 'endsAt') =>
    apiError?.field(field) ?? (touched && problem?.field === field ? problem.message : undefined);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (problem) return;
    const body = {
      title: title.trim(),
      url: url.trim(),
      thumbnailMediaId: thumbnail?.id ?? null,
      startsAt: isoFromLocalInput(startsAt),
      endsAt: isoFromLocalInput(endsAt),
    };
    if (link) update.mutate({ id: link.id, ...body }, { onSuccess: onClose });
    else create.mutate(body, { onSuccess: onClose });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={link ? 'Edit link' : 'Add link'}
      description="Readers go through a counter on your site, then on to this address."
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={mutation.isPending}>
            {link ? 'Save link' : 'Add link'}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={submit}
        className="grid gap-4"
        aria-label={link ? 'Edit link' : 'Add link'}
      >
        <TextField
          label="Title"
          value={title}
          maxLength={80}
          onChange={(e) => setTitle(e.target.value)}
          error={fieldError('title')}
        />
        <TextField
          label="Address"
          type="url"
          value={url}
          className="font-mono text-[13px]"
          hint="An https or http address."
          onChange={(e) => setUrl(e.target.value)}
          error={fieldError('url')}
        />
        <div className="flex flex-wrap items-center gap-3">
          {thumbnail ? (
            <img src={thumbnail.url} alt="" className="size-12 rounded-[10px] object-cover" />
          ) : (
            <span aria-hidden="true" className="size-12 rounded-[10px] bg-surface-alt" />
          )}
          <Button variant="ghost" size="sm" onClick={() => setPicking(true)}>
            {thumbnail ? 'Change thumbnail' : 'Choose thumbnail'}
          </Button>
          {thumbnail && (
            <Button variant="quiet" size="sm" onClick={() => setThumbnail(null)}>
              Remove thumbnail
            </Button>
          )}
        </div>
        {picking && (
          <div
            role="group"
            aria-label="Choose a thumbnail"
            className="grid gap-3 rounded-card-app border border-line-app p-3"
          >
            <p className="text-[12.5px] text-sub">
              A square image works best. It shows small, next to the title.
            </p>
            <MediaPicker channelId={channel.id} chosen={chosen} onChoose={setChosen} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPicking(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!chosen}
                onClick={() => {
                  if (chosen) setThumbnail({ id: chosen.id, url: chosen.url });
                  setPicking(false);
                }}
              >
                Use image
              </Button>
            </div>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Show from"
            type="datetime-local"
            value={startsAt}
            hint="Optional. Your local time."
            onChange={(e) => setStartsAt(e.target.value)}
            error={apiError?.field('startsAt')}
          />
          <TextField
            label="Show until"
            type="datetime-local"
            value={endsAt}
            hint="Optional. Your local time."
            onChange={(e) => setEndsAt(e.target.value)}
            error={fieldError('endsAt')}
          />
        </div>
        {apiError && !apiError.details.length && <ErrorNotice message={apiError.message} />}
      </form>
    </Dialog>
  );
}

// ---- Preview -------------------------------------------------------------------------------

/** The page as readers will see it, drawn with the site's palette and the Channel's accent. */
function Preview({ hub, draft }: { hub: LinkHub; draft: SettingsDraft }) {
  const { channel, settings } = useSiteStudio();
  const logoId = channel.branding.logoMediaId;
  const media = useQuery({ ...mediaQuery(channel.id, '', 'image'), enabled: !!logoId });
  const logo = logoId ? media.data?.find((m) => m.id === logoId) : undefined;
  const [now] = useState(() => Date.now());
  const prefersDark =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const scheme = settings.theme.colorScheme ?? 'auto';
  const palette =
    SITE_PALETTE[scheme === 'dark' || (scheme === 'auto' && prefersDark) ? 'dark' : 'light'];
  const accent = siteAccent(channel.branding.accentColor);
  const live = hub.links.filter((l) => hubLinkStatus(l, now) === 'live');
  const socials = draft.socials.filter((s) => /^https:\/\/[^\s/]+/.test(s.url.trim()));
  const bio = draft.bio.trim() || channel.description || '';

  return (
    <figure className="overflow-hidden rounded-[22px] border border-line-app shadow-soft">
      <figcaption className="sr-only">Preview of the Link Hub page</figcaption>
      <div
        className="grid max-h-[640px] gap-4 overflow-y-auto px-5 py-7"
        style={{ background: palette.page, color: palette.ink }}
      >
        <div className="text-center">
          {logo ? (
            <img src={logo.url} alt="" className="mx-auto size-16 rounded-[18px] object-cover" />
          ) : null}
          <p className="mt-2 text-[19px] font-bold tracking-[-0.02em]">
            {draft.title.trim() || channel.name}
          </p>
          {bio && (
            <p className="mt-1 text-[13px]" style={{ color: palette.sub }}>
              {bio}
            </p>
          )}
        </div>
        {socials.length > 0 && (
          <div className="flex flex-wrap justify-center gap-1.5">
            {socials.map((s, i) => (
              <span
                key={i}
                className="rounded-pill border px-3 py-1 text-[12px]"
                style={{ borderColor: palette.line }}
              >
                {HUB_SOCIAL_LABELS[s.network]}
              </span>
            ))}
          </div>
        )}
        {live.length > 0 ? (
          <ul className="grid gap-2">
            {live.map((link) => (
              <li
                key={link.id}
                className="flex min-h-11 items-center gap-2.5 rounded-card-app border px-3 py-2 text-[13.5px] font-semibold"
                style={{ background: palette.surface, borderColor: palette.line }}
              >
                {link.thumbnailUrl && (
                  <img
                    src={link.thumbnailUrl}
                    alt=""
                    className="size-8 rounded-[8px] object-cover"
                  />
                )}
                <span className={link.thumbnailUrl ? 'flex-1' : 'flex-1 text-center'}>
                  {link.title}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-center text-[12.5px]" style={{ color: palette.sub }}>
            Links you add appear here.
          </p>
        )}
        {draft.latestDispatches > 0 && (
          <p
            // uppercase-allow: the preview copies the website's own section title (sw-section-title).
            className="border-t pt-3 text-[11px] font-semibold tracking-[0.12em] uppercase"
            style={{ borderColor: palette.line, color: palette.sub }}
          >
            Latest posts · up to {draft.latestDispatches}
          </p>
        )}
        {draft.showCaptureForm && (
          <div
            className="grid gap-2 rounded-card-app border p-3"
            style={{ background: palette.surface, borderColor: palette.line }}
          >
            <p className="text-[13px] font-semibold">Get {channel.name} by email</p>
            <span
              className="rounded-pill px-3 py-1.5 text-center text-[12.5px] font-semibold"
              style={{ background: accent, color: onAccent(accent) }}
            >
              Subscribe
            </span>
          </div>
        )}
      </div>
    </figure>
  );
}

// ---- Report --------------------------------------------------------------------------------

type Preset = '7' | '30' | '90';

const shortDay = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const formatDay = (day: string) => shortDay.format(new Date(`${day}T00:00:00Z`));

function Report({ channelId, links }: { channelId: string; links: HubLink[] }) {
  const [today] = useState(() => dayOf(Date.now()));
  const [preset, setPreset] = useState<Preset>('30');
  const [linkId, setLinkId] = useState('');
  const range = { ...lastDays(Number(preset), today), linkId: linkId || undefined };
  const stats = useQuery(linkHubAnalyticsQuery(channelId, range));

  return (
    <Section
      title="Clicks"
      description="Counted at the edge without cookies, in UTC days. Bots and link previews are left out."
    >
      <div className="mb-5 grid gap-4 sm:grid-cols-[200px_minmax(0,320px)]">
        <SelectField
          label="Date range"
          value={preset}
          onChange={(e) => setPreset(e.target.value as Preset)}
          options={[
            { value: '7', label: 'Last 7 days' },
            { value: '30', label: 'Last 30 days' },
            { value: '90', label: 'Last 90 days' },
          ]}
        />
        <SelectField
          label="Link"
          value={linkId}
          onChange={(e) => setLinkId(e.target.value)}
          options={[
            { value: '', label: 'All links' },
            ...links.map((l) => ({ value: l.id, label: l.title })),
          ]}
        />
      </div>
      {stats.isPending && <LoadingRows label="Loading clicks" rows={3} />}
      {stats.error && <ErrorNotice message={stats.error.message} />}
      {stats.data && <ReportBody stats={stats.data} refreshing={stats.isFetching} />}
    </Section>
  );
}

function ReportBody({ stats, refreshing }: { stats: LinkHubAnalytics; refreshing: boolean }) {
  return (
    <div
      className={`grid gap-5 transition-opacity ${refreshing ? 'opacity-70' : ''}`}
      aria-busy={refreshing}
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Clicks" value={numberFormat.format(stats.clicks)} />
        <Kpi label="Page views" value={numberFormat.format(stats.pageViews)} />
        <Kpi
          label="Click-through"
          value={clickThrough(stats.clicks, stats.pageViews)}
          detail="Clicks per page view"
        />
        <Kpi
          label="Visitors"
          value={numberFormat.format(stats.pageVisitors)}
          detail="Approximate"
        />
      </div>
      {stats.clicks === 0 ? (
        <p className="text-[13px] text-sub">
          No clicks in this range. They appear here once readers use the links on your page.
        </p>
      ) : (
        <>
          <DayChart stats={stats} />
          <div className="grid gap-5 lg:grid-cols-3">
            <ClickTable
              title="By link"
              column="Link"
              rows={stats.byLink.map((r) => ({
                key: r.linkId,
                label: r.title ?? 'Deleted link',
                clicks: r.clicks,
              }))}
            />
            <ClickTable
              title="Sources"
              column="Source"
              rows={stats.sources.map((r) => ({
                key: r.source,
                label: r.source,
                clicks: r.clicks,
              }))}
            />
            <ClickTable
              title="Countries"
              column="Country"
              rows={stats.countries.map((r) => ({
                key: r.country,
                label: r.country === 'XX' ? 'Unknown' : r.country,
                clicks: r.clicks,
              }))}
            />
          </div>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-card-app border border-line-app bg-surface p-4">
      <p className="text-[11px] text-sub">{label}</p>
      <p className="tabular mt-1 text-[25px] leading-tight font-bold tracking-[-0.03em]">{value}</p>
      {detail && <p className="tabular mt-1 text-[12px] text-sub">{detail}</p>}
    </div>
  );
}

function DayChart({ stats }: { stats: LinkHubAnalytics }) {
  const days = stats.byDay;
  const peak = Math.max(0, ...days.map((d) => d.clicks));
  const max = niceMax(peak);
  const width = 720;
  const height = 150;
  const left = 36;
  const slot = (width - left) / Math.max(1, days.length);
  const bar = Math.max(2, Math.min(18, slot * 0.6));
  const ticks = new Set(tickIndexes(days.length));
  return (
    <figure>
      <svg
        viewBox={`0 0 ${width} ${height + 20}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Clicks per day from ${formatDay(stats.from)} to ${formatDay(stats.to)}, peaking at ${numberFormat.format(peak)}`}
      >
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line
              x1={left}
              x2={width}
              y1={height - f * height}
              y2={height - f * height}
              stroke="var(--chart-grid)"
            />
            <text
              x={left - 6}
              y={height - f * height + 4}
              textAnchor="end"
              fontSize="10"
              fill="var(--text-muted)"
            >
              {numberFormat.format(Math.round(max * f))}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const x = left + i * slot + slot / 2;
          const h = (d.clicks / max) * height;
          return (
            <g key={d.day}>
              <rect
                x={x - bar / 2}
                y={height - h}
                width={bar}
                height={h}
                rx={2}
                fill="var(--chart-1)"
              >
                <title>{`${formatDay(d.day)}: ${numberFormat.format(d.clicks)} clicks`}</title>
              </rect>
              {ticks.has(i) && (
                <text
                  x={x}
                  y={height + 15}
                  textAnchor="middle"
                  fontSize="10"
                  fill="var(--text-muted)"
                >
                  {formatDay(d.day)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-1 flex items-center gap-1.5 text-[11.5px] text-sub">
        <span aria-hidden="true" className="inline-block size-2.5 rounded-[3px] bg-purple" /> Clicks
        per UTC day
      </figcaption>
      <table className="sr-only">
        <caption>Clicks by day</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Clicks</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.day}>
              <td>{d.day}</td>
              <td>{d.clicks}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function ClickTable({
  title,
  column,
  rows,
}: {
  title: string;
  column: string;
  rows: { key: string; label: string; clicks: number }[];
}) {
  const top = Math.max(0, ...rows.map((r) => r.clicks));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[220px] text-left text-[13px]">
        <caption className="mb-2 text-left text-[13.5px] font-semibold">{title}</caption>
        <thead>
          <tr className="table-head">
            <th scope="col" className="py-2 pr-3 font-semibold">
              {column}
            </th>
            <th scope="col" className="py-2 pl-3 text-right font-semibold">
              Clicks
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr className="border-t border-line">
              <td colSpan={2} className="py-2 text-sub">
                Nothing recorded.
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.key} className="border-t border-line">
                <td className="max-w-[220px] py-2 pr-3">
                  <span className="relative block">
                    <span
                      aria-hidden="true"
                      className="absolute inset-y-0 left-0 rounded-[6px] bg-lavender"
                      style={{ width: `${top ? (row.clicks / top) * 100 : 0}%` }}
                    />
                    <span className="relative block truncate px-1.5 py-0.5">{row.label}</span>
                  </span>
                </td>
                <td className="tabular py-2 pl-3 text-right font-semibold">
                  {numberFormat.format(row.clicks)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
