// Site Studio → Pages: custom pages and the About page, written in the Dispatch editor (without
// merge tags or the gate). Loaded on first use, with TipTap.
import {
  EMPTY_DOCUMENT,
  LANDING_TEMPLATES,
  type DispatchDocument,
  type LandingTemplateId,
  type SitePage,
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
  TextField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { captureFormsQuery } from '../api/capture';
import { ApiError } from '../api/client';
import { useChannelFlag } from '../api/queries';
import {
  sitePageQuery,
  sitePagesQuery,
  useCreatePage,
  useDeletePage,
  useUpdatePage,
  useUpdateSiteSettings,
} from '../api/site';
import { dispatchExtensions } from '../editor/extensions';
import { ReadOnlyNote } from '../site/controls';
import { formatDateTime } from './common';
import { SnippetTools, Toolbar } from './Editor';
import { useSiteStudio } from './SiteStudio';

const nonEmpty = (doc: DispatchDocument): DispatchDocument =>
  doc.content.length ? doc : EMPTY_DOCUMENT;

// ---- List ----------------------------------------------------------------------------------

export function SitePagesList() {
  const { channel, settings, canEdit } = useSiteStudio();
  const pages = useQuery(sitePagesQuery(channel.id));
  const [creating, setCreating] = useState(false);
  const items = pages.data?.items ?? [];
  const limit = pages.data?.limit ?? null;
  const full = limit !== null && items.length >= limit;

  return (
    <div className="grid max-w-[880px] gap-5">
      <section aria-labelledby="pages-title" className="card-app p-5 sm:p-6">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="pages-title" className="text-[16px] font-semibold tracking-[-0.02em]">
              Pages
            </h2>
            <p className="mt-1 text-[13px] text-sub">
              Pages that aren’t posts, such as a contact page or a colophon. Published pages can
              appear in the site navigation.
              {pages.data && limit !== null && (
                <span className="tabular">
                  {' '}
                  {items.length} of {limit} pages on your plan.
                </span>
              )}
            </p>
          </div>
          {canEdit && (
            <Button size="sm" disabled={full} onClick={() => setCreating(true)}>
              New page
            </Button>
          )}
        </div>

        <ul className="divide-y divide-line rounded-card-app border border-line-app">
          <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-[13.5px]">
            <span>
              <b>About</b> <span className="font-mono text-[12.5px] text-sub">/about</span>
              <span className="block text-[12.5px] text-sub">
                {settings.about.content.length
                  ? 'Your own words about the publication.'
                  : 'Not written yet: the page shows the publication description.'}
              </span>
            </span>
            <Link
              to="/site/$channelId/pages/about"
              params={{ channelId: channel.id }}
              className="btn-ghost btn-sm"
              aria-label="Edit the About page"
            >
              {canEdit ? 'Edit' : 'View'}
            </Link>
          </li>
          {pages.isPending && (
            <li className="p-3">
              <LoadingRows label="Loading pages" rows={2} />
            </li>
          )}
          {items.map((page) => (
            <li
              key={page.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-[13.5px]"
            >
              <span className="min-w-0">
                <b>{page.title}</b>{' '}
                <span className="font-mono text-[12.5px] text-sub">/{page.slug}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-2 text-[12.5px] text-sub">
                  <Pill tone={page.status === 'published' ? 'success' : 'brand'}>
                    {page.status === 'published' ? 'Published' : 'Draft'}
                  </Pill>
                  {page.inNav && <Pill tone="neutral">In navigation</Pill>}
                  {page.landingFormId && <Pill tone="neutral">Landing page</Pill>}
                  Updated {formatDateTime(page.updatedAt)}
                </span>
              </span>
              <Link
                to="/site/$channelId/pages/$pageId"
                params={{ channelId: channel.id, pageId: page.id }}
                className="btn-ghost btn-sm"
                aria-label={`Edit ${page.title}`}
              >
                {canEdit ? 'Edit' : 'View'}
              </Link>
            </li>
          ))}
        </ul>
        {pages.error && (
          <div className="mt-3">
            <ErrorNotice message={pages.error.message} />
          </div>
        )}
        {pages.data && items.length === 0 && (
          <div className="mt-4">
            <EmptyState title="No custom pages yet">
              {canEdit
                ? 'Create one for anything that isn’t a post.'
                : 'An editor or admin creates pages.'}
            </EmptyState>
          </div>
        )}
        {full && canEdit && (
          <p className="mt-3 text-[12.5px] text-sub">
            Your plan includes {limit} pages per publication. Remove one to add another.
          </p>
        )}
      </section>
      {creating && <NewPageDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function useLandingForms(channelId: string, enabled: boolean) {
  const forms = useQuery({ ...captureFormsQuery(channelId), enabled });
  return (forms.data ?? []).filter((form) => form.kind === 'form' && form.status === 'published');
}

function LandingFormField({
  forms,
  value,
  onChange,
  error,
  disabled,
  allowNone,
}: {
  channelId: string;
  forms: { id: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
  error?: string | undefined;
  disabled?: boolean;
  allowNone?: boolean;
}) {
  return (
    <SelectField
      label="Signup form"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      options={[
        { value: '', label: allowNone ? 'None: this is an ordinary page' : 'Choose a form…' },
        ...forms.map((form) => ({ value: form.id, label: form.name })),
      ]}
      error={error}
      hint={
        forms.length
          ? 'Give each landing page its own form, so its signups are counted on their own.'
          : 'No published forms yet. Publish one under Forms first.'
      }
    />
  );
}

function NewPageDialog({ onClose }: { onClose: () => void }) {
  const { channel } = useSiteStudio();
  const create = useCreatePage(channel.id);
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const landingOn = useChannelFlag(channel.id, 'landing_pages') === true;
  const forms = useLandingForms(channel.id, landingOn);
  const [kind, setKind] = useState<'page' | LandingTemplateId>('page');
  const [formId, setFormId] = useState('');
  const template = LANDING_TEMPLATES.find((t) => t.id === kind) ?? null;
  const error = create.error instanceof ApiError ? create.error : null;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    create.mutate(
      {
        title,
        ...(slug.trim() ? { slug: slug.trim() } : {}),
        status: 'draft',
        ...(template
          ? { content: template.content as unknown as DispatchDocument, landingFormId: formId }
          : {}),
      },
      {
        onSuccess: (page) =>
          void navigate({
            to: '/site/$channelId/pages/$pageId',
            params: { channelId: channel.id, pageId: page.id },
          }),
      },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="New page"
      description="It starts as a draft. Publish it when it’s ready."
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={create.isPending}
            disabled={!title.trim() || (!!template && !formId)}
            onClick={() => submit()}
          >
            Create page
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="grid gap-4">
        {landingOn && (
          <SelectField
            label="Kind of page"
            value={kind}
            onChange={(e) => {
              const next = e.target.value as typeof kind;
              const starter = LANDING_TEMPLATES.find((t) => t.id === next);
              setKind(next);
              if (starter && !title.trim()) setTitle(starter.title);
            }}
            options={[
              { value: 'page', label: 'An ordinary page' },
              ...LANDING_TEMPLATES.map((t) => ({
                value: t.id,
                label: `Landing page: ${t.name}`,
              })),
            ]}
            hint={
              template
                ? `${template.description} It has no site navigation, so nothing leads people away from the form.`
                : undefined
            }
          />
        )}
        {template && (
          <LandingFormField
            channelId={channel.id}
            forms={forms}
            value={formId}
            onChange={setFormId}
            error={error?.field('landingFormId')}
          />
        )}
        <TextField
          label="Title"
          required
          maxLength={120}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          error={error?.field('title')}
        />
        <TextField
          label="Address (optional)"
          maxLength={60}
          value={slug}
          placeholder="made from the title"
          onChange={(e) => setSlug(e.target.value.toLowerCase())}
          className="font-mono text-[13px]"
          error={error?.field('slug')}
        />
        {error && !error.details.length && <ErrorNotice message={error.message} />}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

// ---- Content editor ------------------------------------------------------------------------

function useContentEditor({
  content,
  editable,
  label,
  onChange,
}: {
  content: DispatchDocument;
  editable: boolean;
  label: string;
  onChange: () => void;
}): Editor | null {
  const editor = useEditor({
    extensions: dispatchExtensions({ gate: false, placeholder: 'Write the page…' }),
    content: nonEmpty(content),
    editable,
    immediatelyRender: false,
    // Only real edits count; TipTap also emits "update" when nothing in the page changed.
    onUpdate: ({ transaction }) => {
      if (transaction.docChanged) onChange();
    },
    editorProps: {
      attributes: {
        class: 'dispatch-prose',
        'aria-label': label,
        'aria-multiline': 'true',
        role: 'textbox',
      },
    },
  });
  useEffect(() => {
    editor?.setEditable(editable, false);
  }, [editor, editable]);
  useEffect(() => {
    // A transaction that changes nothing gives the toolbar its first reading of the page.
    if (editor && !editor.isDestroyed) {
      editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false));
    }
  }, [editor]);
  return editor;
}

/** Warns before leaving with unsaved changes. */
function useLeaveWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);
}

function ContentCard({
  editor,
  channelId,
  editable,
}: {
  editor: Editor | null;
  channelId: string;
  editable: boolean;
}) {
  return (
    <div className="card-app overflow-hidden">
      {editable && editor && (
        <Toolbar editor={editor} channelId={channelId} htmlAllowed={false} variant="page" />
      )}
      <div className="px-5 py-6 sm:px-8">
        <SnippetTools channelId={channelId}>
          <EditorContent editor={editor} />
        </SnippetTools>
      </div>
    </div>
  );
}

function BackToPages() {
  const { channel } = useSiteStudio();
  return (
    <Link
      to="/site/$channelId/pages"
      params={{ channelId: channel.id }}
      className="text-[13px] text-sub no-underline hover:text-ink"
    >
      ← Pages
    </Link>
  );
}

// ---- About ---------------------------------------------------------------------------------

export function SiteAboutEditor() {
  const { channel, settings, canEdit } = useSiteStudio();
  const update = useUpdateSiteSettings(channel.id);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const editor = useContentEditor({
    content: settings.about,
    editable: canEdit,
    label: 'About page',
    onChange: () => {
      setDirty(true);
      setSaved(false);
    },
  });
  useLeaveWarning(dirty);

  const save = () => {
    if (!editor) return;
    update.mutate(
      { about: editor.getJSON() as DispatchDocument },
      {
        onSuccess: () => {
          setDirty(false);
          setSaved(true);
        },
      },
    );
  };

  return (
    <div className="grid max-w-[880px] gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <BackToPages />
        <a
          href={`${settings.url}/about`}
          target="_blank"
          rel="noreferrer"
          className="text-[13px] font-semibold text-purple-deep"
        >
          View the About page<span className="sr-only"> (opens in a new tab)</span>
        </a>
      </div>
      <h2 className="text-[19px] font-semibold tracking-[-0.025em]">About</h2>
      <p className="-mt-2 text-[13px] text-sub">
        Tell readers what the publication is about and who writes it. Shown at /about.
      </p>
      <ContentCard editor={editor} channelId={channel.id} editable={canEdit} />
      {update.error && <ErrorNotice title="Not saved" message={update.error.message} />}
      {canEdit ? (
        <div className="flex items-center gap-3">
          <Button loading={update.isPending} disabled={!dirty} onClick={save}>
            Save About page
          </Button>
          <p role="status" className="text-[13px] text-success">
            {saved ? 'Saved.' : ''}
          </p>
        </div>
      ) : (
        <ReadOnlyNote>An editor or admin changes the About page.</ReadOnlyNote>
      )}
    </div>
  );
}

// ---- One page ------------------------------------------------------------------------------

export function SitePageEditor({ pageId }: { pageId: string }) {
  const { channel } = useSiteStudio();
  const page = useQuery(sitePageQuery(channel.id, pageId));
  if (page.isPending) return <LoadingRows label="Loading the page" rows={5} />;
  if (page.error) {
    return (
      <ErrorNotice
        title="Page not available"
        message={page.error.message}
        action={<BackToPages />}
      />
    );
  }
  return <PageForm key={page.data.id} page={page.data} />;
}

function PageForm({ page }: { page: SitePage }) {
  const { channel, settings, canEdit } = useSiteStudio();
  const update = useUpdatePage(channel.id, page.id);
  const remove = useDeletePage(channel.id);
  const navigate = useNavigate();
  const [title, setTitle] = useState(page.title);
  const [slug, setSlug] = useState(page.slug);
  const [inNav, setInNav] = useState(page.inNav);
  const landingOn = useChannelFlag(channel.id, 'landing_pages') === true;
  const forms = useLandingForms(channel.id, landingOn);
  const [landingFormId, setLandingFormId] = useState(page.landingFormId ?? '');
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const contentChanged = useRef(false);
  const error = update.error instanceof ApiError ? update.error : null;
  const editor = useContentEditor({
    content: page.content,
    editable: canEdit,
    label: 'Page content',
    onChange: () => {
      contentChanged.current = true;
      setDirty(true);
      setSaved(null);
    },
  });
  useLeaveWarning(dirty);
  const published = page.status === 'published';

  const touch = () => {
    setDirty(true);
    setSaved(null);
  };

  const save = (status?: SitePage['status']) => {
    if (!editor) return;
    update.mutate(
      {
        title,
        slug: slug.trim(),
        inNav,
        ...(landingOn ? { landingFormId: landingFormId || null } : {}),
        ...(contentChanged.current ? { content: editor.getJSON() as DispatchDocument } : {}),
        ...(status ? { status } : {}),
      },
      {
        onSuccess: (next) => {
          contentChanged.current = false;
          setDirty(false);
          setSaved(
            status === 'published'
              ? 'Published.'
              : status === 'draft'
                ? 'Moved back to draft.'
                : 'Saved.',
          );
          setSlug(next.slug);
        },
      },
    );
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save();
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="grid min-w-0 content-start gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <BackToPages />
          <Pill tone={published ? 'success' : 'brand'}>{published ? 'Published' : 'Draft'}</Pill>
          {canEdit && (
            <span role="status" className="text-[13px] text-sub">
              {dirty ? 'Unsaved changes' : (saved ?? '')}
            </span>
          )}
        </div>
        <ContentCard editor={editor} channelId={channel.id} editable={canEdit} />
      </div>

      <form onSubmit={submit} aria-label="Page settings" className="grid content-start gap-4">
        <section className="card-app grid gap-4 p-5">
          <TextField
            label="Title"
            required
            maxLength={120}
            value={title}
            disabled={!canEdit}
            onChange={(e) => {
              setTitle(e.target.value);
              touch();
            }}
            error={error?.field('title')}
          />
          <TextField
            label="Address"
            required
            maxLength={60}
            value={slug}
            disabled={!canEdit}
            onChange={(e) => {
              setSlug(e.target.value.toLowerCase());
              touch();
            }}
            className="font-mono text-[13px]"
            hint={<span className="break-all">{`${settings.url}/${slug || '…'}`}</span>}
            error={error?.field('slug')}
          />
          <p className="text-[13px] text-sub">
            {published
              ? 'Published: anyone can read it on the website.'
              : 'Draft: only your team sees it here.'}
          </p>
          <Checkbox
            label="Show in the navigation"
            hint="Adds a link to the site header while the page is published."
            checked={inNav}
            disabled={!canEdit}
            onChange={(checked) => {
              setInNav(checked);
              touch();
            }}
          />
          {landingOn && (
            <LandingFormField
              channelId={channel.id}
              forms={forms}
              value={landingFormId}
              disabled={!canEdit}
              allowNone
              onChange={(id) => {
                setLandingFormId(id);
                touch();
              }}
              error={error?.field('landingFormId')}
            />
          )}
          {error && !error.details.length && <ErrorNotice message={error.message} />}
          {canEdit ? (
            <div className="grid gap-2">
              {published ? (
                <>
                  <Button type="submit" loading={update.isPending && !update.variables?.status}>
                    Save changes
                  </Button>
                  <Button
                    variant="ghost"
                    loading={update.isPending && update.variables?.status === 'draft'}
                    onClick={() => save('draft')}
                  >
                    Unpublish
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    loading={update.isPending && update.variables?.status === 'published'}
                    onClick={() => save('published')}
                  >
                    Publish page
                  </Button>
                  <Button
                    type="submit"
                    variant="ghost"
                    loading={update.isPending && !update.variables?.status}
                  >
                    Save draft
                  </Button>
                </>
              )}
              {published && (
                <a
                  href={page.url}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-quiet justify-center"
                >
                  View on site<span className="sr-only"> (opens in a new tab)</span>
                </a>
              )}
              <Button variant="quiet" onClick={() => setConfirmDelete(true)}>
                Delete page
              </Button>
            </div>
          ) : (
            <ReadOnlyNote>An editor or admin changes pages.</ReadOnlyNote>
          )}
        </section>
      </form>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${page.title}?`}
        description="The page leaves the website and the navigation. This can’t be undone."
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(page.id, {
                  onSuccess: () =>
                    void navigate({
                      to: '/site/$channelId/pages',
                      params: { channelId: channel.id },
                    }),
                })
              }
            >
              Delete page
            </Button>
          </>
        }
      >
        {remove.error && <ErrorNotice message={remove.error.message} />}
      </Dialog>
    </div>
  );
}

/** The lazy-loaded entry: one module for the list, the About page and a single page. */
export default function SitePages(
  props: { view: 'list' } | { view: 'about' } | { view: 'page'; pageId: string },
) {
  if (props.view === 'about') return <SiteAboutEditor />;
  if (props.view === 'page') return <SitePageEditor pageId={props.pageId} />;
  return <SitePagesList />;
}
