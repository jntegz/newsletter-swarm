// Site Studio: the Channel website's settings. The layout loads the Channel and its site
// settings once; each tab is a child route that reads them from context.
import {
  KNOWN_AI_BOTS,
  MAX_NAV_LINKS,
  MAX_PINNED,
  isHttpsUrl,
  type AiBotsPolicy,
  type BotRules,
  type Channel,
  type MediaAsset,
  type NavLink,
  type SeatRole,
  type SiteRedirect,
  type SiteSection,
  type SiteSettings,
  type SiteTheme,
  type UpdateSiteSettings,
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
import { Link, Outlet } from '@tanstack/react-router';
import {
  Fragment,
  createContext,
  useContext,
  useId,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import { ApiError } from '../api/client';
import { channelQuery, mediaQuery, useChannelFlag } from '../api/queries';
import { dispatchesQuery } from '../api/send';
import {
  botRulesQuery,
  isFeatureDisabled,
  sitePagesQuery,
  siteRedirectsQuery,
  siteSectionsQuery,
  siteSettingsQuery,
  useCreateRedirect,
  useCreateSection,
  useDeleteRedirect,
  useDeleteSection,
  useImportRedirects,
  useUpdateBotRules,
  useUpdateRedirect,
  useUpdateSection,
  useUpdateSiteSettings,
} from '../api/site';
import { CookiesAndCode } from '../site/CookiesAndCode';
import { BrandPanel } from '../site/BrandPanel';
import { ImportArchive } from '../site/ImportArchive';
import { ChoiceCards, ReadOnlyNote, SaveRow } from '../site/controls';
import { botAction, moveItem, navLinkProblem, robotsLines, type BotAction } from '../site/helpers';
import { UnsavedBar } from '../shell/UnsavedBar';
import { PageHeader } from './Channels';
import { Bands, Section, focalStyle, formatDateTime, numberFormat } from './common';
import { MediaPicker } from './MediaPicker';

const RANK: Record<SeatRole, number> = { viewer: 0, author: 1, editor: 2, admin: 3, owner: 4 };

interface SiteStudioValue {
  channel: Channel;
  settings: SiteSettings;
  /** Editor or higher: most website settings. */
  canEdit: boolean;
  /** Admin or higher: domains, Bot Rules and search engine access to gated content. */
  canAdmin: boolean;
}

const SiteStudioContext = createContext<SiteStudioValue | null>(null);

export function useSiteStudio(): SiteStudioValue {
  const value = useContext(SiteStudioContext);
  if (!value) throw new Error('useSiteStudio() outside SiteStudioLayout');
  return value;
}

/**
 * The website's pages, in three groups the row keeps apart with a hairline: what readers see,
 * how the site is set up, and how it is doing. Tabs with a flag show only while it is on.
 */
const TABS = [
  { path: 'design', label: 'Design', group: 0, flag: 'site_templates' },
  { path: 'branding', label: 'Branding', group: 0 },
  { path: 'navigation', label: 'Navigation', group: 0 },
  { path: 'pages', label: 'Pages', group: 0 },
  { path: 'authors', label: 'Authors', group: 0 },
  { path: 'link-hub', label: 'Link Hub', group: 0, flag: 'link_hub' },
  { path: 'import', label: 'Import past issues', group: 0, flag: 'archive_import' },
  { path: 'general', label: 'General', group: 1 },
  { path: 'domains', label: 'Domains', group: 1 },
  { path: 'seo', label: 'SEO', group: 1 },
  { path: 'redirects', label: 'Redirects', group: 1 },
  { path: 'bot-rules', label: 'Bot Rules', group: 1 },
  { path: 'cookies', label: 'Cookies and code', group: 1, flag: 'site_custom_code' },
  { path: 'analytics', label: 'Analytics', group: 2 },
] as const;

export function SiteStudioLayout({ channelId }: { channelId: string }) {
  const channel = useQuery(channelQuery(channelId));
  const settings = useQuery(siteSettingsQuery(channelId));
  const flagOn = {
    link_hub: useChannelFlag(channelId, 'link_hub'),
    site_custom_code: useChannelFlag(channelId, 'site_custom_code'),
    archive_import: useChannelFlag(channelId, 'archive_import'),
    site_templates: useChannelFlag(channelId, 'site_templates'),
  };
  if (channel.isPending || settings.isPending) {
    return <LoadingRows label="Loading website" rows={4} />;
  }
  if (channel.error || settings.error) {
    return (
      <ErrorNotice
        title="Website not available"
        message={(channel.error ?? settings.error)?.message ?? ''}
        action={
          <Link to="/channels" className="btn-ghost">
            Back to publications
          </Link>
        }
      />
    );
  }
  const role = channel.data.role;
  const value: SiteStudioValue = {
    channel: channel.data,
    settings: settings.data,
    canEdit: RANK[role] >= RANK.editor,
    canAdmin: RANK[role] >= RANK.admin,
  };
  return (
    <SiteStudioContext.Provider value={value}>
      <PageHeader
        title="Website"
        subtitle={`The website of ${channel.data.name}.`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <a href={settings.data.url} target="_blank" rel="noreferrer" className="btn-ghost">
              View site<span className="sr-only"> (opens in a new tab)</span>
            </a>
            <Link to="/channels/$channelId" params={{ channelId }} className="btn-ghost">
              Publication settings
            </Link>
          </div>
        }
      />
      <nav
        aria-label="Website sections"
        className="mb-6 flex gap-1 overflow-x-auto border-b border-line-app"
      >
        {TABS.filter((tab) => !('flag' in tab) || flagOn[tab.flag]).map((tab, i, shown) => (
          <Fragment key={tab.path}>
            {i > 0 && shown[i - 1]?.group !== tab.group && (
              <span aria-hidden="true" className="mx-2 mt-1 mb-4 w-px shrink-0 bg-line" />
            )}
            <Link
              to={`/site/$channelId/${tab.path}`}
              params={{ channelId }}
              className="-mb-px border-b-2 border-transparent px-3 pb-3 text-[13.5px] whitespace-nowrap text-sub no-underline hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple"
              activeProps={{
                className: 'border-purple! font-semibold text-ink!',
                'aria-current': 'page',
              }}
            >
              {tab.label}
            </Link>
          </Fragment>
        ))}
      </nav>
      <Outlet />
    </SiteStudioContext.Provider>
  );
}

/** Saves only what changed; with nothing changed it just confirms. */
function useSettingsForm() {
  const { channel } = useSiteStudio();
  const update = useUpdateSiteSettings(channel.id);
  const [saved, setSaved] = useState(false);
  const submit = (input: Parameters<typeof update.mutate>[0] | null) => {
    setSaved(false);
    if (!input || Object.keys(input).length === 0) {
      setSaved(true);
      return;
    }
    update.mutate(input, { onSuccess: () => setSaved(true) });
  };
  return { update, saved, submit, error: update.error };
}

// ---- General -------------------------------------------------------------------------------

export function SiteGeneral() {
  const { channel, settings, canEdit } = useSiteStudio();
  const dispatches = useQuery(dispatchesQuery(channel.id));
  const update = useUpdateSiteSettings(channel.id);
  const formId = useId();
  const [layout, setLayout] = useState(settings.layout);
  const [pinned, setPinned] = useState(settings.pinned);
  const [prevNext, setPrevNext] = useState(settings.prevNextNav);
  const [adding, setAdding] = useState('');
  const onSite = (dispatches.data ?? []).filter(
    (d) => d.webPublishedAt !== null && d.webVisibility !== 'hidden',
  );
  const subjectOf = (id: string) =>
    dispatches.data?.find((d) => d.id === id)?.subject || 'Untitled post';
  const error = update.error;
  // The newspaper layout is an optional feature. While it is off the server refuses it, so it is
  // offered only when it can be saved (or is what the site already uses).
  const layoutsOff = useChannelFlag(channel.id, 'site_homepage_layouts') === false;
  const offerNewspaper = !layoutsOff || settings.layout === 'newspaper';
  const layoutError = isFeatureDisabled(error)
    ? 'The newspaper layout is switched off for this publication.'
    : undefined;
  const changes: UpdateSiteSettings = {
    ...(layout !== settings.layout ? { layout } : {}),
    ...(pinned.join() !== settings.pinned.join() ? { pinned } : {}),
    ...(prevNext !== settings.prevNextNav ? { prevNextNav: prevNext } : {}),
  };
  const dirty = Object.keys(changes).length > 0;

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (dirty) update.mutate(changes);
  };

  return (
    <Bands>
      <Section
        title="Site address"
        description="Where readers find the website. Connect your own domain under Domains."
      >
        <p className="font-mono text-[13.5px] break-all">
          <a href={settings.url} target="_blank" rel="noreferrer" className="text-purple-deep">
            {settings.url}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </p>
        {settings.platformUrl !== settings.url && (
          <p className="mt-1 text-[12.5px] text-sub">
            Also at <span className="font-mono">{settings.platformUrl}</span>, which always works.
          </p>
        )}
      </Section>

      <form id={formId} onSubmit={save} aria-label="Home page settings">
        <Section
          title="Home page"
          description="What readers see first: the layout, the posts pinned to the top, and links between posts."
        >
          <div className="grid gap-5">
            <ChoiceCards
              legend="Layout"
              value={layout}
              disabled={!canEdit}
              onChange={setLayout}
              options={[
                {
                  value: 'magazine',
                  title: 'Magazine',
                  description: 'Pinned posts first, then the latest ones in a grid of cards.',
                },
                ...(offerNewspaper
                  ? [
                      {
                        value: 'newspaper' as const,
                        title: 'Newspaper',
                        description: 'A lead story with columns of headlines, grouped by section.',
                      },
                    ]
                  : []),
              ]}
            />
            {!offerNewspaper && (
              <p className="text-[12.5px] text-sub">
                A newspaper layout is an optional feature that is switched off here. An instance
                admin can switch on Homepage layouts under Settings, Instance, Features.
              </p>
            )}
            {layoutError && <ErrorNotice title="Layout not saved" message={layoutError} />}

            <div className="grid gap-2">
              <h3 className="text-[13px] font-semibold">
                Pinned posts{' '}
                <span className="font-normal text-sub">
                  ({pinned.length} of {MAX_PINNED})
                </span>
              </h3>
              <p className="text-[12.5px] text-sub">
                Shown first on the home page. Only posts on the website can be pinned.
              </p>
              {pinned.length === 0 && (
                <p className="text-[13px] text-sub">Nothing pinned. The newest posts lead.</p>
              )}
              {pinned.length > 0 && (
                <ol className="divide-y divide-line border-y border-line">
                  {pinned.map((id, index) => (
                    <li
                      key={id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2 text-[13.5px]"
                    >
                      <span className="min-w-0 truncate">
                        <span className="tabular mr-2 text-sub">{index + 1}.</span>
                        {subjectOf(id)}
                      </span>
                      {canEdit && (
                        <span className="flex gap-1">
                          <Button
                            variant="quiet"
                            size="sm"
                            disabled={index === 0}
                            aria-label={`Move ${subjectOf(id)} up`}
                            onClick={() => setPinned(moveItem(pinned, index, index - 1))}
                          >
                            Up
                          </Button>
                          <Button
                            variant="quiet"
                            size="sm"
                            disabled={index === pinned.length - 1}
                            aria-label={`Move ${subjectOf(id)} down`}
                            onClick={() => setPinned(moveItem(pinned, index, index + 1))}
                          >
                            Down
                          </Button>
                          <Button
                            variant="quiet"
                            size="sm"
                            aria-label={`Unpin ${subjectOf(id)}`}
                            onClick={() => setPinned(pinned.filter((p) => p !== id))}
                          >
                            Unpin
                          </Button>
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              )}
              {canEdit && pinned.length < MAX_PINNED && (
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-[200px] flex-1">
                    <SelectField
                      label="Pin a post"
                      value={adding}
                      disabled={dispatches.isPending}
                      onChange={(e) => setAdding(e.target.value)}
                      options={[
                        {
                          value: '',
                          label: dispatches.isPending
                            ? 'Loading posts…'
                            : onSite.length
                              ? 'Choose a post on the website'
                              : 'No posts on the website yet',
                        },
                        ...onSite
                          .filter((d) => !pinned.includes(d.id))
                          .map((d) => ({ value: d.id, label: d.subject || 'Untitled post' })),
                      ]}
                    />
                  </div>
                  <Button
                    variant="ghost"
                    disabled={!adding}
                    onClick={() => {
                      setPinned([...pinned, adding]);
                      setAdding('');
                    }}
                  >
                    Pin
                  </Button>
                </div>
              )}
              {dispatches.error && <ErrorNotice message={dispatches.error.message} />}
            </div>

            <Checkbox
              label="Previous and next links"
              hint="Each post page links to the one before and after it."
              checked={prevNext}
              disabled={!canEdit}
              onChange={setPrevNext}
            />
          </div>
        </Section>
        {canEdit ? (
          <UnsavedBar
            label="Unsaved changes to the home page"
            dirty={dirty}
            pending={update.isPending}
            form={formId}
            onDiscard={() => {
              setLayout(settings.layout);
              setPinned(settings.pinned);
              setPrevNext(settings.prevNextNav);
              update.reset();
            }}
            error={error && !isFeatureDisabled(error) ? `Not saved: ${error.message}` : null}
          />
        ) : (
          <div className="pt-4">
            <ReadOnlyNote>An editor or admin changes the website settings.</ReadOnlyNote>
          </div>
        )}
      </form>
    </Bands>
  );
}

// ---- Branding ------------------------------------------------------------------------------

export function SiteImport() {
  const { channel } = useSiteStudio();
  return <ImportArchive channelId={channel.id} admin={RANK[channel.role] >= RANK.admin} />;
}

export function SiteCookies() {
  const { channel, settings } = useSiteStudio();
  return (
    <CookiesAndCode
      channelId={channel.id}
      consent={settings.consent}
      code={settings.code}
      codeAccess={settings.codeAccess}
      platformUrl={settings.platformUrl}
      admin={RANK[channel.role] >= RANK.admin}
    />
  );
}

/** The branding form as the saved settings fill it, so Discard and "changed?" use one source. */
function brandingDraft(settings: SiteSettings) {
  return {
    // The plain layout offers Geist and Inter; any other saved font belongs to a template.
    font: (settings.theme.font === 'inter' ? 'inter' : 'geist') as NonNullable<SiteTheme['font']>,
    scheme: (settings.theme.colorScheme ?? 'auto') as NonNullable<SiteTheme['colorScheme']>,
    dropCaps: settings.theme.dropCaps ?? false,
    customCss: settings.customCss,
  };
}

export function SiteBranding() {
  const { channel, settings, canEdit } = useSiteStudio();
  const update = useUpdateSiteSettings(channel.id);
  const error = update.error;
  const formId = useId();
  const savedFont = settings.theme.font;
  // With website templates on, the design (Website → Design) holds the template, colours, fonts
  // and the home page's words; Branding keeps what isn't the design.
  const templatesOn = useChannelFlag(channel.id, 'site_templates') === true;
  const canAdmin = RANK[channel.role] >= RANK.admin;
  const saved = useMemo(() => brandingDraft(settings), [settings]);
  const [draft, setDraft] = useState(saved);
  const set =
    <K extends keyof typeof draft>(key: K) =>
    (value: (typeof draft)[K]) =>
      setDraft((d) => ({ ...d, [key]: value }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (templatesOn) {
      // Everything else in the theme belongs to the design now and stays as it is.
      update.mutate({
        theme: { ...settings.theme, dropCaps: draft.dropCaps },
        ...(canAdmin && draft.customCss !== settings.customCss
          ? { customCss: draft.customCss }
          : {}),
      });
      return;
    }
    // Geist is the plain layout's default, so a site that never chose a font stays without one.
    const plainFont = !savedFont && draft.font === 'geist' ? undefined : draft.font;
    const theme: SiteTheme = {
      ...settings.theme,
      colorScheme: draft.scheme,
      dropCaps: draft.dropCaps,
    };
    if (plainFont) theme.font = plainFont;
    else delete theme.font;
    update.mutate({ theme });
  };

  return (
    <>
      {/* Outside the form below: the panel has its own form, and saves on its own. */}
      <Bands>
        <BrandPanel channel={channel} canEdit={canEdit} />
      </Bands>
      <form id={formId} onSubmit={save} aria-label="Branding">
        <Bands>
          {templatesOn && (
            <Section
              title="Design"
              description="The template, colours, fonts and the home page’s sections, with a live preview."
            >
              <p className="text-[13.5px] leading-[1.55]">
                The template, its style and the words on the home page (headline, pitch, what
                subscribers get) are in Design now.{' '}
                <Link
                  to="/site/$channelId/design"
                  params={{ channelId: channel.id }}
                  className="font-semibold text-purple-deep"
                >
                  Open Design
                </Link>
              </p>
            </Section>
          )}
          {!templatesOn && (
            <Section
              title="Type and colour scheme"
              description="How text looks on every page, and whether the site is light, dark or follows the reader’s device."
            >
              <div className="grid gap-5">
                <ChoiceCards
                  legend="Font"
                  value={draft.font}
                  disabled={!canEdit}
                  onChange={set('font')}
                  options={[
                    {
                      value: 'geist',
                      title: 'Geist',
                      description: 'Crisp and modern. The default.',
                    },
                    { value: 'inter', title: 'Inter', description: 'Neutral and very readable.' },
                  ]}
                />
                <ChoiceCards
                  legend="Colour scheme"
                  value={draft.scheme}
                  disabled={!canEdit}
                  onChange={set('scheme')}
                  options={[
                    {
                      value: 'auto',
                      title: 'Follow the reader',
                      description: 'Light or dark, as the reader’s device prefers.',
                    },
                    { value: 'light', title: 'Light', description: 'Always light.' },
                    { value: 'dark', title: 'Dark', description: 'Always dark.' },
                  ]}
                />
              </div>
            </Section>
          )}
          <Section title="Posts" description="How each post page starts.">
            <Checkbox
              label="Drop caps"
              hint="Starts each post with a large first letter."
              checked={draft.dropCaps}
              disabled={!canEdit}
              onChange={set('dropCaps')}
            />
          </Section>
          {templatesOn && canAdmin && (
            <Section
              title="Custom CSS"
              description="Your own rules for every page of the site, for what the design’s settings don’t cover."
            >
              <TextAreaField
                label="Custom CSS"
                rows={8}
                maxLength={20000}
                value={draft.customCss}
                onChange={(e) => set('customCss')(e.target.value)}
                error={error instanceof ApiError ? error.field('customCss') : undefined}
                className="font-mono text-[13px]"
                hint="Added after the theme’s CSS, so it wins where both set the same thing. It can’t load files from other sites."
              />
            </Section>
          )}
        </Bands>
        {canEdit ? (
          <UnsavedBar
            label="Unsaved changes to the branding"
            dirty={dirty}
            pending={update.isPending}
            form={formId}
            onDiscard={() => {
              setDraft(saved);
              update.reset();
            }}
            error={
              error instanceof ApiError && error.details.length ? null : (error?.message ?? null)
            }
          />
        ) : (
          <div className="pt-4">
            <ReadOnlyNote>An editor or admin changes the website settings.</ReadOnlyNote>
          </div>
        )}
      </form>
    </>
  );
}

// ---- Navigation and sections ---------------------------------------------------------------

export function SiteNavigation() {
  return (
    <div className="grid max-w-[880px] gap-5">
      <NavLinks />
      <Sections />
    </div>
  );
}

function NavLinks() {
  const { channel, settings, canEdit } = useSiteStudio();
  const pages = useQuery(sitePagesQuery(channel.id));
  const { update, saved, submit, error } = useSettingsForm();
  const [links, setLinks] = useState<NavLink[]>(settings.nav);
  const [showErrors, setShowErrors] = useState(false);
  const problems = links.map(navLinkProblem);
  const suggestions = [
    { label: 'About', href: '/about' },
    { label: 'Archive', href: '/archive' },
    ...(pages.data?.items ?? [])
      .filter((p) => p.status === 'published')
      .map((p) => ({ label: p.title.slice(0, 40), href: `/${p.slug}` })),
  ].filter((s) => !links.some((l) => l.href === s.href));

  const change = (index: number, patch: Partial<NavLink>) =>
    setLinks(links.map((link, i) => (i === index ? { ...link, ...patch } : link)));

  const save = (event: FormEvent) => {
    event.preventDefault();
    setShowErrors(true);
    if (problems.some(Boolean)) return;
    submit({ nav: links.map((l) => ({ label: l.label.trim(), href: l.href.trim() })) });
  };

  return (
    <form onSubmit={save} aria-label="Navigation links">
      <Section
        title="Navigation"
        description="Links in the site header, in this order. Use a path on the site, such as /about, or an https address."
      >
        <div className="grid gap-3">
          {links.length === 0 && (
            <p className="text-[13px] text-sub">
              No links yet. The header shows the publication name and a subscribe button.
            </p>
          )}
          {links.map((link, index) => (
            <div
              key={index}
              className="grid gap-3 rounded-card-app border border-line-app p-3 sm:grid-cols-[1fr_1.4fr_auto] sm:items-start"
            >
              <TextField
                label={`Label ${index + 1}`}
                value={link.label}
                maxLength={40}
                disabled={!canEdit}
                onChange={(e) => change(index, { label: e.target.value })}
              />
              <TextField
                label={`Address ${index + 1}`}
                value={link.href}
                disabled={!canEdit}
                placeholder="/about"
                onChange={(e) => change(index, { href: e.target.value })}
                className="font-mono text-[13px]"
                error={showErrors ? (problems[index] ?? undefined) : undefined}
              />
              {canEdit && (
                <div className="flex gap-1 sm:pt-7">
                  <Button
                    variant="quiet"
                    size="sm"
                    disabled={index === 0}
                    aria-label={`Move ${link.label || `link ${index + 1}`} up`}
                    onClick={() => setLinks(moveItem(links, index, index - 1))}
                  >
                    Up
                  </Button>
                  <Button
                    variant="quiet"
                    size="sm"
                    disabled={index === links.length - 1}
                    aria-label={`Move ${link.label || `link ${index + 1}`} down`}
                    onClick={() => setLinks(moveItem(links, index, index + 1))}
                  >
                    Down
                  </Button>
                  <Button
                    variant="quiet"
                    size="sm"
                    aria-label={`Remove ${link.label || `link ${index + 1}`}`}
                    onClick={() => setLinks(links.filter((_, i) => i !== index))}
                  >
                    Remove
                  </Button>
                </div>
              )}
            </div>
          ))}
          {canEdit && links.length < MAX_NAV_LINKS && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLinks([...links, { label: '', href: '' }])}
              >
                Add link
              </Button>
              {suggestions.slice(0, 6).map((s) => (
                <Button
                  key={s.href}
                  variant="quiet"
                  size="sm"
                  aria-label={`Add ${s.label} (${s.href})`}
                  onClick={() => setLinks([...links, s])}
                >
                  + {s.label}
                </Button>
              ))}
            </div>
          )}
          {canEdit ? (
            <SaveRow
              label="Save navigation"
              pending={update.isPending}
              saved={saved}
              error={error}
            />
          ) : (
            <ReadOnlyNote>An editor or admin changes the navigation.</ReadOnlyNote>
          )}
        </div>
      </Section>
    </form>
  );
}

function Sections() {
  const { channel, settings, canEdit } = useSiteStudio();
  const sections = useQuery(siteSectionsQuery(channel.id));
  const create = useCreateSection(channel.id);
  const updateSection = useUpdateSection(channel.id);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [editing, setEditing] = useState<SiteSection | null>(null);
  const [removing, setRemoving] = useState<SiteSection | null>(null);
  const createError = create.error instanceof ApiError ? create.error : null;

  if (isFeatureDisabled(sections.error)) {
    return (
      <Section title="Sections">
        <EmptyState title="Sections are not available for this publication">
          Sections group posts on the website, each with its own page. They are an optional feature
          that is switched off here.
        </EmptyState>
      </Section>
    );
  }

  const list = sections.data ?? [];
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      {
        name,
        ...(slug.trim() ? { slug: slug.trim() } : {}),
        description: description.trim() || null,
        position: list.length,
      },
      {
        onSuccess: () => {
          setName('');
          setSlug('');
          setDescription('');
        },
      },
    );
  };

  /** Swaps two neighbours' positions. */
  const move = (index: number, to: number) => {
    const a = list[index];
    const b = list[to];
    if (!a || !b) return;
    updateSection.mutate({ id: a.id, position: to });
    updateSection.mutate({ id: b.id, position: index });
  };

  return (
    <Section
      title="Sections"
      description="Group posts on the website. Each section has a page at /s/ followed by its address; choose a post’s section in the editor."
    >
      {sections.isPending && <LoadingRows label="Loading sections" rows={2} />}
      {sections.error && <ErrorNotice message={sections.error.message} />}
      {sections.data && list.length === 0 && (
        <p className="text-[13px] text-sub">No sections yet.</p>
      )}
      {list.length > 0 && (
        <ul className="divide-y divide-line rounded-card-app border border-line-app">
          {list.map((section, index) => (
            <li
              key={section.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-[13.5px]"
            >
              <span className="min-w-0">
                <b>{section.name}</b>{' '}
                <span className="font-mono text-[12.5px] text-sub">/s/{section.slug}</span>
                <span className="block text-[12.5px] text-sub">
                  {section.description ? `${section.description} · ` : ''}
                  {numberFormat.format(section.dispatchCount)}{' '}
                  {section.dispatchCount === 1 ? 'post' : 'posts'} on the website
                </span>
              </span>
              <span className="flex flex-wrap gap-1">
                <a
                  href={`${settings.url}/s/${section.slug}`}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-quiet"
                >
                  View<span className="sr-only"> {section.name} (opens in a new tab)</span>
                </a>
                {canEdit && (
                  <>
                    <Button
                      variant="quiet"
                      size="sm"
                      disabled={index === 0 || updateSection.isPending}
                      aria-label={`Move ${section.name} up`}
                      onClick={() => move(index, index - 1)}
                    >
                      Up
                    </Button>
                    <Button
                      variant="quiet"
                      size="sm"
                      disabled={index === list.length - 1 || updateSection.isPending}
                      aria-label={`Move ${section.name} down`}
                      onClick={() => move(index, index + 1)}
                    >
                      Down
                    </Button>
                    <Button
                      variant="quiet"
                      size="sm"
                      aria-label={`Edit ${section.name}`}
                      onClick={() => setEditing(section)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="quiet"
                      size="sm"
                      aria-label={`Remove ${section.name}`}
                      onClick={() => setRemoving(section)}
                    >
                      Remove
                    </Button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {updateSection.error && !editing && <ErrorNotice message={updateSection.error.message} />}
      {canEdit && sections.data && (
        <form
          onSubmit={submit}
          aria-label="Add a section"
          className="mt-5 grid gap-4 border-t border-line pt-5 sm:grid-cols-2"
        >
          <TextField
            label="Section name"
            required
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={createError?.field('name')}
          />
          <TextField
            label="Address (optional)"
            value={slug}
            maxLength={60}
            placeholder="made from the name"
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            className="font-mono text-[13px]"
            error={createError?.field('slug')}
          />
          <div className="sm:col-span-2">
            <TextField
              label="Description (optional)"
              value={description}
              maxLength={280}
              onChange={(e) => setDescription(e.target.value)}
              error={createError?.field('description')}
            />
          </div>
          {createError && !createError.details.length && (
            <div className="sm:col-span-2">
              <ErrorNotice message={createError.message} />
            </div>
          )}
          <div className="sm:col-span-2">
            <Button type="submit" variant="ghost" loading={create.isPending}>
              Add section
            </Button>
          </div>
        </form>
      )}
      {editing && (
        <SectionDialog
          key={editing.id}
          section={editing}
          channelId={channel.id}
          onClose={() => setEditing(null)}
        />
      )}
      {removing && (
        <RemoveSectionDialog
          section={removing}
          channelId={channel.id}
          onClose={() => setRemoving(null)}
        />
      )}
    </Section>
  );
}

function SectionDialog({
  section,
  channelId,
  onClose,
}: {
  section: SiteSection;
  channelId: string;
  onClose: () => void;
}) {
  const update = useUpdateSection(channelId);
  const [name, setName] = useState(section.name);
  const [slug, setSlug] = useState(section.slug);
  const [description, setDescription] = useState(section.description ?? '');
  const error = update.error instanceof ApiError ? update.error : null;
  const save = () =>
    update.mutate(
      { id: section.id, name, slug, description: description.trim() || null },
      { onSuccess: onClose },
    );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Edit ${section.name}`}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={update.isPending} onClick={save}>
            Save section
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <TextField
          label="Section name"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          error={error?.field('name')}
        />
        <TextField
          label="Address"
          value={slug}
          maxLength={60}
          onChange={(e) => setSlug(e.target.value.toLowerCase())}
          className="font-mono text-[13px]"
          hint="Changing it changes the section’s web address."
          error={error?.field('slug')}
        />
        <TextAreaField
          label="Description"
          value={description}
          maxLength={280}
          onChange={(e) => setDescription(e.target.value)}
          error={error?.field('description')}
        />
        {error && !error.details.length && <ErrorNotice message={error.message} />}
      </div>
    </Dialog>
  );
}

function RemoveSectionDialog({
  section,
  channelId,
  onClose,
}: {
  section: SiteSection;
  channelId: string;
  onClose: () => void;
}) {
  const remove = useDeleteSection(channelId);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Remove ${section.name}?`}
      description="Its posts stay on the website, without a section. The section page stops working."
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep
          </Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() => remove.mutate(section.id, { onSuccess: onClose })}
          >
            Remove section
          </Button>
        </>
      }
    >
      {remove.error && <ErrorNotice message={remove.error.message} />}
    </Dialog>
  );
}

// ---- SEO -----------------------------------------------------------------------------------

/** The SEO form as the saved settings fill it, so Discard and "changed?" use one source. */
function seoDraft(settings: SiteSettings) {
  return {
    ogMediaId: settings.seo.ogMediaId ?? null,
    google: settings.seo.verification?.google ?? '',
    bing: settings.seo.verification?.bing ?? '',
    sameAs: (settings.seo.sameAs ?? []).join('\n'),
    exposeGated: settings.exposeGated,
  };
}

export function SiteSeo() {
  const { channel, settings, canEdit, canAdmin } = useSiteStudio();
  const media = useQuery(mediaQuery(channel.id, '', 'image'));
  const update = useUpdateSiteSettings(channel.id);
  const error = update.error;
  const formId = useId();
  const saved = useMemo(() => seoDraft(settings), [settings]);
  const [draft, setDraft] = useState(saved);
  const set = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const [chosen, setChosen] = useState<MediaAsset | null>(null);
  const [picking, setPicking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const apiError = error instanceof ApiError ? error : null;
  const { ogMediaId } = draft;
  const image = chosen?.id === ogMediaId ? chosen : media.data?.find((m) => m.id === ogMediaId);

  const save = (event: FormEvent) => {
    event.preventDefault();
    const profiles = draft.sameAs
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const bad = profiles.find((url) => !isHttpsUrl(url));
    if (bad) {
      setProblem(`${bad} is not an https address.`);
      return;
    }
    if (profiles.length > 10) {
      setProblem('Add at most 10 profiles.');
      return;
    }
    setProblem(null);
    const verification = {
      ...(draft.google.trim() ? { google: draft.google.trim() } : {}),
      ...(draft.bing.trim() ? { bing: draft.bing.trim() } : {}),
    };
    update.mutate({
      seo: { ogMediaId, verification, sameAs: profiles },
      ...(canAdmin && draft.exposeGated !== settings.exposeGated
        ? { exposeGated: draft.exposeGated }
        : {}),
    });
  };

  return (
    <form id={formId} onSubmit={save} aria-label="Search and sharing">
      <Bands>
        <Section
          title="Social image"
          description="Shown when a page without its own image is shared. Posts with an image use their first one."
        >
          <div className="flex flex-wrap items-center gap-4">
            <div className="grid h-24 w-44 place-items-center overflow-hidden rounded-card-app border border-line-app bg-surface-alt">
              {image ? (
                <img
                  src={image.url}
                  alt={image.altText ?? 'Social image'}
                  className="size-full object-cover"
                  style={focalStyle(image)}
                />
              ) : ogMediaId && media.isPending ? (
                <span className="text-[12px] text-sub">Loading…</span>
              ) : (
                <span className="text-[12px] text-sub">No image</span>
              )}
            </div>
            {canEdit && (
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" size="sm" onClick={() => setPicking(true)}>
                  {ogMediaId ? 'Replace image' : 'Choose image'}
                </Button>
                {ogMediaId && (
                  <Button variant="quiet" size="sm" onClick={() => set('ogMediaId', null)}>
                    Remove image
                  </Button>
                )}
              </div>
            )}
          </div>
          {apiError?.field('seo.ogMediaId') && (
            <p role="alert" className="mt-2 text-[12.5px] font-semibold text-danger">
              {apiError.field('seo.ogMediaId')}
            </p>
          )}
        </Section>

        <Section
          title="Search engines"
          description="Paste only the token from each verification meta tag, not the whole tag."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Google verification token"
              value={draft.google}
              disabled={!canEdit}
              maxLength={120}
              onChange={(e) => set('google', e.target.value)}
              className="font-mono text-[13px]"
              error={apiError?.field('seo.verification.google')}
            />
            <TextField
              label="Bing verification token"
              value={draft.bing}
              disabled={!canEdit}
              maxLength={120}
              onChange={(e) => set('bing', e.target.value)}
              className="font-mono text-[13px]"
              error={apiError?.field('seo.verification.bing')}
            />
            <div className="sm:col-span-2">
              <TextAreaField
                label="Profiles elsewhere"
                value={draft.sameAs}
                disabled={!canEdit}
                placeholder="https://social.example/@yourchannel"
                onChange={(e) => set('sameAs', e.target.value)}
                className="font-mono text-[13px]"
                hint="One https address per line, up to 10. Search engines use them to connect the site to your other profiles."
                error={problem ?? undefined}
              />
            </div>
          </div>
        </Section>

        <Section
          title="Paywalled posts and search"
          description="Verified search crawlers can read posts past the paywall so they rank for their full text. Readers still stop at the paywall."
        >
          <Checkbox
            label="Show paywalled content to verified search engines"
            hint={
              canAdmin
                ? 'Only crawlers the network verifies are let through. This is an optional feature; it may not be available for this publication.'
                : 'An admin changes this.'
            }
            checked={draft.exposeGated}
            disabled={!canAdmin}
            onChange={(value) => set('exposeGated', value)}
          />
        </Section>
      </Bands>

      {canEdit ? (
        <UnsavedBar
          label="Unsaved changes to search and sharing"
          dirty={dirty}
          pending={update.isPending}
          form={formId}
          onDiscard={() => {
            setDraft(saved);
            setProblem(null);
            update.reset();
          }}
          error={
            problem
              ? 'Not saved: a profile address needs attention.'
              : apiError && apiError.details.length
                ? null
                : (error?.message ?? null)
          }
        />
      ) : (
        <div className="pt-4">
          <ReadOnlyNote>An editor or admin changes the website settings.</ReadOnlyNote>
        </div>
      )}

      <Dialog
        open={picking}
        onClose={() => setPicking(false)}
        title="Choose a social image"
        description="A wide image works best, at least 1200 pixels across."
        actions={
          <>
            <Button variant="ghost" onClick={() => setPicking(false)}>
              Cancel
            </Button>
            <Button
              disabled={!chosen}
              onClick={() => {
                if (chosen) set('ogMediaId', chosen.id);
                setPicking(false);
              }}
            >
              Use image
            </Button>
          </>
        }
      >
        {picking && <MediaPicker channelId={channel.id} chosen={chosen} onChoose={setChosen} />}
      </Dialog>
    </form>
  );
}

// ---- Bot Rules -----------------------------------------------------------------------------

export function SiteBotRules() {
  const { channel } = useSiteStudio();
  const rules = useQuery(botRulesQuery(channel.id));
  if (rules.isPending) return <LoadingRows label="Loading Bot Rules" rows={4} />;
  if (rules.error) return <ErrorNotice message={rules.error.message} />;
  return <BotRulesForm rules={rules.data} />;
}

const POLICY_LABEL: Record<AiBotsPolicy, string> = {
  unset: 'Not chosen yet',
  allow: 'Allow AI crawlers',
  block: 'Block AI crawlers',
  custom: 'Choose per crawler',
};

function BotRulesForm({ rules }: { rules: BotRules }) {
  const { channel, canAdmin } = useSiteStudio();
  const update = useUpdateBotRules(channel.id);
  const [policy, setPolicy] = useState<AiBotsPolicy>(rules.policy);
  const [overrides, setOverrides] = useState<Partial<Record<string, BotAction>>>(rules.overrides);
  const [saved, setSaved] = useState(false);
  const robots = robotsLines(policy, overrides);

  const apply = (next: AiBotsPolicy) => {
    setSaved(false);
    setPolicy(next);
    update.mutate(
      {
        policy: next,
        ...(next === 'custom' ? { overrides: overrides as Record<string, BotAction> } : {}),
      },
      { onSuccess: () => setSaved(true) },
    );
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    apply(policy);
  };

  return (
    <div className="grid max-w-[880px] gap-5">
      {rules.policy === 'unset' && (
        <section
          aria-labelledby="bot-setup-title"
          className="rounded-card-app border border-lavender-line bg-lavender p-5 sm:p-6"
        >
          <h2 id="bot-setup-title" className="text-[16px] font-semibold tracking-[-0.02em]">
            Should AI crawlers read your website?
          </h2>
          <p className="mt-1 max-w-[62ch] text-[13.5px] text-[#4a3d8f]">
            Companies crawl the web to train and feed AI models. Search engines are not affected by
            this choice. Until you choose, AI crawlers are allowed.
          </p>
          {canAdmin ? (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                loading={update.isPending && update.variables?.policy === 'block'}
                onClick={() => apply('block')}
              >
                Block AI crawlers
              </Button>
              <Button
                variant="ghost"
                loading={update.isPending && update.variables?.policy === 'allow'}
                onClick={() => apply('allow')}
              >
                Allow AI crawlers
              </Button>
              <Button variant="quiet" onClick={() => setPolicy('custom')}>
                Choose per crawler
              </Button>
            </div>
          ) : (
            <p className="mt-3 text-[13px] text-[#4a3d8f]">An admin makes this choice.</p>
          )}
        </section>
      )}

      <form onSubmit={save} aria-label="Bot Rules">
        <Section
          title="Bot Rules"
          description="Blocked crawlers are refused at the edge and asked to stay away in robots.txt. Well-behaved crawlers read robots.txt; the edge check catches the rest that identify themselves."
          action={
            <Pill
              tone={
                rules.policy === 'block'
                  ? 'danger'
                  : rules.policy === 'unset'
                    ? 'neutral'
                    : 'success'
              }
            >
              {POLICY_LABEL[rules.policy]}
            </Pill>
          }
        >
          <div className="grid gap-5">
            <ChoiceCards<AiBotsPolicy>
              legend="Policy"
              value={policy}
              disabled={!canAdmin}
              onChange={(value) => {
                setSaved(false);
                setPolicy(value);
              }}
              options={[
                {
                  value: 'allow',
                  title: 'Allow',
                  description: 'Every AI crawler may read the website.',
                },
                {
                  value: 'block',
                  title: 'Block',
                  description: 'Every known AI crawler is refused.',
                },
                {
                  value: 'custom',
                  title: 'Custom',
                  description:
                    'Choose for each crawler below. Crawlers without a choice are allowed.',
                },
              ]}
            />

            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-[13px]">
                <caption className="sr-only">AI crawlers and what the site does with each</caption>
                <thead>
                  <tr className="table-head">
                    <th scope="col" className="py-2 pr-3 font-semibold">
                      Crawler
                    </th>
                    <th scope="col" className="px-3 py-2 font-semibold">
                      robots.txt name
                    </th>
                    <th scope="col" className="py-2 pl-3 font-semibold">
                      Access
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rules.agents.map((agent) => {
                    const action = botAction(policy, overrides, agent.key);
                    return (
                      <tr key={agent.key} className="border-t border-line">
                        <td className="py-2 pr-3">{agent.name}</td>
                        <td className="px-3 py-2 font-mono text-[12.5px] text-sub">
                          {agent.robots}
                        </td>
                        <td className="py-2 pl-3">
                          {policy === 'custom' && canAdmin ? (
                            <>
                              <label htmlFor={`bot-${agent.key}`} className="sr-only">
                                Access for {agent.name}
                              </label>
                              <select
                                id={`bot-${agent.key}`}
                                value={overrides[agent.key] ?? 'allow'}
                                onChange={(e) => {
                                  setSaved(false);
                                  setOverrides({
                                    ...overrides,
                                    [agent.key]: e.target.value as BotAction,
                                  });
                                }}
                                className="h-9 rounded-control border border-line-control bg-surface px-3 text-[13px] hover:border-line-control-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-purple"
                              >
                                <option value="allow">Allow</option>
                                <option value="block">Block</option>
                              </select>
                            </>
                          ) : (
                            <Pill tone={action === 'block' ? 'danger' : 'success'}>
                              {action === 'block' ? 'Blocked' : 'Allowed'}
                            </Pill>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="grid gap-1.5">
              <h3 className="text-[13px] font-semibold">What robots.txt says</h3>
              <p className="text-[12.5px] text-sub">
                The site writes this for you at /robots.txt, after the rules for search engines.
              </p>
              <pre className="max-h-56 overflow-auto rounded-card-app bg-surface-alt px-4 py-3 font-mono text-[12.5px] leading-[1.7]">
                {robots.length ? robots.join('\n') : '# No AI crawler is blocked.'}
              </pre>
            </div>

            {canAdmin ? (
              <SaveRow
                label="Save Bot Rules"
                pending={update.isPending}
                saved={saved}
                error={update.error}
                disabled={policy === 'unset'}
              />
            ) : (
              <ReadOnlyNote>An admin changes the Bot Rules.</ReadOnlyNote>
            )}
          </div>
        </Section>
      </form>
      <p className="text-[12.5px] text-sub">
        {KNOWN_AI_BOTS.length} known crawlers. New ones are added as they appear.
      </p>
    </div>
  );
}

// ---- Redirects -----------------------------------------------------------------------------

const STATUS_OPTIONS = [
  { value: '301', label: '301 Permanent' },
  { value: '302', label: '302 Temporary' },
  { value: '308', label: '308 Permanent (keeps the method)' },
  { value: '307', label: '307 Temporary (keeps the method)' },
];

export function SiteRedirects() {
  const { channel, canEdit } = useSiteStudio();
  const redirects = useQuery(siteRedirectsQuery(channel.id));
  const create = useCreateRedirect(channel.id);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState('301');
  const [editing, setEditing] = useState<SiteRedirect | null>(null);
  const [removing, setRemoving] = useState<SiteRedirect | null>(null);
  const error = create.error instanceof ApiError ? create.error : null;
  const items = redirects.data?.items ?? [];
  const limit = redirects.data?.limit ?? null;
  const full = limit !== null && items.length >= limit;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { from, to, statusCode: Number(status) as SiteRedirect['statusCode'] },
      {
        onSuccess: () => {
          setFrom('');
          setTo('');
        },
      },
    );
  };

  return (
    <div className="grid max-w-[960px] gap-5">
      <Section
        title="Redirects"
        description="Send an old address to a new one, for example after moving from another platform. Each path redirects exactly, with or without a trailing slash."
        action={
          redirects.data && (
            <span className="tabular text-[13px] text-sub">
              {limit === null
                ? `${numberFormat.format(items.length)} redirects`
                : `${numberFormat.format(items.length)} of ${numberFormat.format(limit)} on your plan`}
            </span>
          )
        }
      >
        {redirects.isPending && <LoadingRows label="Loading redirects" rows={3} />}
        {redirects.error && <ErrorNotice message={redirects.error.message} />}
        {redirects.data && items.length === 0 && (
          <EmptyState title="No redirects yet">
            Add one below, or import a CSV with the columns from, to and status.
          </EmptyState>
        )}
        {items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <caption className="sr-only">Redirects</caption>
              <thead>
                <tr className="table-head">
                  <th scope="col" className="py-2 pr-3 font-semibold">
                    From
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    To
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Added
                  </th>
                  <th scope="col" className="py-2 pl-3 font-semibold">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id} className="border-t border-line align-top">
                    <td className="py-2.5 pr-3 font-mono text-[12.5px] break-all">{r.from}</td>
                    <td className="px-3 py-2.5 font-mono text-[12.5px] break-all">{r.to}</td>
                    <td className="tabular px-3 py-2.5">{r.statusCode}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-sub">
                      {formatDateTime(r.createdAt)}
                    </td>
                    <td className="py-1.5 pl-3 whitespace-nowrap">
                      {canEdit && (
                        <>
                          <Button
                            variant="quiet"
                            size="sm"
                            aria-label={`Edit redirect from ${r.from}`}
                            onClick={() => setEditing(r)}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="quiet"
                            size="sm"
                            aria-label={`Remove redirect from ${r.from}`}
                            onClick={() => setRemoving(r)}
                          >
                            Remove
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {canEdit && (
          <form
            onSubmit={submit}
            aria-label="Add a redirect"
            className="mt-5 grid gap-4 border-t border-line pt-5 sm:grid-cols-[1fr_1.3fr_200px] sm:items-start"
          >
            <TextField
              label="From path"
              required
              value={from}
              placeholder="/old-post"
              onChange={(e) => setFrom(e.target.value)}
              className="font-mono text-[13px]"
              error={error?.field('from')}
            />
            <TextField
              label="To"
              required
              value={to}
              placeholder="/p/new-post or https://"
              onChange={(e) => setTo(e.target.value)}
              className="font-mono text-[13px]"
              error={error?.field('to')}
            />
            <SelectField
              label="Status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              options={STATUS_OPTIONS}
            />
            {error && !error.details.length && (
              <div className="sm:col-span-3">
                <ErrorNotice message={error.message} />
              </div>
            )}
            <div className="sm:col-span-3">
              <Button type="submit" variant="ghost" loading={create.isPending} disabled={full}>
                Add redirect
              </Button>
              {full && (
                <p className="mt-2 text-[12.5px] text-sub">
                  Your plan includes {limit} redirects. Remove one to add another.
                </p>
              )}
            </div>
          </form>
        )}
        {!canEdit && (
          <div className="mt-4">
            <ReadOnlyNote>An editor or admin manages redirects.</ReadOnlyNote>
          </div>
        )}
      </Section>

      {canEdit && <RedirectImport channelId={channel.id} />}

      {editing && (
        <EditRedirectDialog
          key={editing.id}
          redirect={editing}
          channelId={channel.id}
          onClose={() => setEditing(null)}
        />
      )}
      {removing && (
        <RemoveRedirectDialog
          redirect={removing}
          channelId={channel.id}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}

function RedirectImport({ channelId }: { channelId: string }) {
  const importer = useImportRedirects(channelId);
  const [csv, setCsv] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const result = importer.data;

  const onFile = (file: File | undefined) => {
    setFileError(null);
    if (!file) return;
    if (file.size > 512 * 1024) {
      setFileError('The file is larger than 512 KB. Split it and import the parts.');
      return;
    }
    void file.text().then(setCsv);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!csv.trim()) return;
    importer.mutate(csv);
  };

  return (
    <form onSubmit={submit} aria-label="Import redirects">
      <Section
        title="Import from CSV"
        description="Columns: from, to and optionally status (301 when empty). A header row is optional. A path that already redirects is updated; lines with a problem are skipped and listed."
      >
        <div className="grid gap-4">
          <label className="btn-ghost btn-sm w-fit cursor-pointer focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-purple">
            Choose a CSV file
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              className="sr-only"
              onChange={(event) => {
                onFile(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </label>
          {fileError && <ErrorNotice message={fileError} />}
          <TextAreaField
            label="Or paste the rows"
            value={csv}
            placeholder={'from,to,status\n/old-post,/p/new-post,301'}
            onChange={(e) => setCsv(e.target.value)}
            className="min-h-32 font-mono text-[12.5px]"
          />
          {importer.error && <ErrorNotice title="Import failed" message={importer.error.message} />}
          {result && (
            <div role="status" className="grid gap-2 text-[13.5px]">
              <p>
                <b>{numberFormat.format(result.created)}</b> added,{' '}
                <b>{numberFormat.format(result.updated)}</b> updated
                {result.errors.length > 0 && (
                  <>
                    , <b className="text-danger">{numberFormat.format(result.errors.length)}</b>{' '}
                    skipped
                  </>
                )}
                .
              </p>
              {result.errors.length > 0 && (
                <ul
                  aria-label="Skipped lines"
                  className="max-h-56 divide-y divide-line overflow-y-auto rounded-card-app border border-danger-soft"
                >
                  {result.errors.map((e) => (
                    <li key={e.line} className="flex gap-3 px-3 py-2 text-[12.5px]">
                      <span className="tabular shrink-0 font-semibold text-danger">
                        Line {e.line}
                      </span>
                      <span>{e.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div>
            <Button
              type="submit"
              variant="ghost"
              loading={importer.isPending}
              disabled={!csv.trim()}
            >
              Import redirects
            </Button>
          </div>
        </div>
      </Section>
    </form>
  );
}

function EditRedirectDialog({
  redirect,
  channelId,
  onClose,
}: {
  redirect: SiteRedirect;
  channelId: string;
  onClose: () => void;
}) {
  const update = useUpdateRedirect(channelId);
  const [to, setTo] = useState(redirect.to);
  const [status, setStatus] = useState(String(redirect.statusCode));
  const error = update.error instanceof ApiError ? update.error : null;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Redirect from ${redirect.from}`}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={update.isPending}
            onClick={() =>
              update.mutate(
                {
                  id: redirect.id,
                  to,
                  statusCode: Number(status) as SiteRedirect['statusCode'],
                },
                { onSuccess: onClose },
              )
            }
          >
            Save redirect
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <TextField
          label="To"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="font-mono text-[13px]"
          error={error?.field('to')}
        />
        <SelectField
          label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={STATUS_OPTIONS}
        />
        {error && !error.details.length && <ErrorNotice message={error.message} />}
      </div>
    </Dialog>
  );
}

function RemoveRedirectDialog({
  redirect,
  channelId,
  onClose,
}: {
  redirect: SiteRedirect;
  channelId: string;
  onClose: () => void;
}) {
  const remove = useDeleteRedirect(channelId);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Remove the redirect from ${redirect.from}?`}
      description="Visitors to the old address get the not-found page instead."
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep
          </Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() => remove.mutate(redirect.id, { onSuccess: onClose })}
          >
            Remove redirect
          </Button>
        </>
      }
    >
      {remove.error && <ErrorNotice message={remove.error.message} />}
    </Dialog>
  );
}
