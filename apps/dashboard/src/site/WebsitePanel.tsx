// The Dispatch editor's Website panel: who can read it on the site, its section and address,
// and putting it on (or taking it off) the website without sending.
import { slugify, type Dispatch, type WebVisibility } from '@swarm/domain';
import { Button, Dialog, ErrorNotice, Pill, SelectField, TextField } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import { useSaveDispatch } from '../api/send';
import {
  isFeatureDisabled,
  siteSectionsQuery,
  siteSettingsQuery,
  usePublishWeb,
  useUnpublishWeb,
} from '../api/site';
import { Section } from '../pages/common';
import { GatePanel } from './GatePanel';
import { GATE_HELP, hasGate } from './helpers';

const VISIBILITY_OPTIONS: { value: WebVisibility; label: string }[] = [
  { value: 'public', label: 'Everyone' },
  { value: 'members', label: 'Subscribers only' },
  { value: 'paid', label: 'Paid subscribers only' },
  { value: 'hidden', label: 'Hidden from the website' },
];

export function WebsitePanel({
  dispatch,
  canEdit,
  flush,
}: {
  dispatch: Dispatch;
  canEdit: boolean;
  flush: () => Promise<unknown>;
}) {
  const settings = useQuery(siteSettingsQuery(dispatch.channelId));
  const sections = useQuery(siteSectionsQuery(dispatch.channelId));
  const save = useSaveDispatch(dispatch.id);
  const publish = usePublishWeb(dispatch.id);
  const unpublish = useUnpublishWeb(dispatch.id);
  const [slug, setSlug] = useState(dispatch.slug ?? '');
  const [slugSaved, setSlugSaved] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const saveError = save.error instanceof ApiError ? save.error : null;
  const draft = dispatch.status === 'draft' || dispatch.status === 'scheduled';
  const canceled = dispatch.status === 'canceled';
  const hidden = dispatch.webVisibility === 'hidden';
  const siteUrl = settings.data?.url ?? '';
  const proposedSlug = slug.trim() || dispatch.slug || slugify(dispatch.subject || 'dispatch');
  const address = `${siteUrl}/p/${proposedSlug}`;
  const slugChanged = slug.trim() !== '' && slug.trim() !== dispatch.slug;

  const saveSlug = (event: FormEvent) => {
    event.preventDefault();
    if (!slugChanged) return;
    setSlugSaved(false);
    save.mutate({ slug: slug.trim() }, { onSuccess: () => setSlugSaved(true) });
  };

  const publishNow = async () => {
    // Publishing uses the saved subject, so save the editor first. If that fails, the page says so
    // and nothing goes on the website.
    try {
      await flush();
    } catch {
      return;
    }
    publish.mutate();
  };

  return (
    <Section
      title="Website"
      description={
        dispatch.onSite
          ? 'On your publication’s website, in the archive, feeds and search.'
          : 'Sent posts appear on the website. A draft can go there without sending.'
      }
    >
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          {dispatch.onSite ? (
            <Pill tone="success">On the website</Pill>
          ) : (
            <Pill tone="neutral">{hidden ? 'Hidden' : 'Not on the website'}</Pill>
          )}
          {dispatch.onSite && dispatch.webUrl && (
            <a
              href={dispatch.webUrl}
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-purple-deep"
            >
              View on site<span className="sr-only"> (opens in a new tab)</span>
            </a>
          )}
        </div>

        <SelectField
          label="Who can read it on the website"
          value={dispatch.webVisibility}
          disabled={!canEdit || save.isPending}
          onChange={(e) => save.mutate({ webVisibility: e.target.value as WebVisibility })}
          options={VISIBILITY_OPTIONS}
          hint={
            hasGate(dispatch.content)
              ? GATE_HELP[dispatch.webVisibility]
              : dispatch.webVisibility === 'members' || dispatch.webVisibility === 'paid'
                ? 'There is no paywall break yet, so everyone can read all of it. Add a paywall break in the toolbar where readers without access should stop.'
                : undefined
          }
          error={saveError?.field('webVisibility')}
        />

        {dispatch.webVisibility === 'paid' && (
          <GatePanel dispatchId={dispatch.id} channelId={dispatch.channelId} canEdit={canEdit} />
        )}

        {sections.data && sections.data.length > 0 && (
          <SelectField
            label="Section"
            value={dispatch.sectionId ?? ''}
            disabled={!canEdit || save.isPending}
            onChange={(e) => save.mutate({ sectionId: e.target.value || null })}
            options={[
              { value: '', label: 'No section' },
              ...sections.data.map((s) => ({ value: s.id, label: s.name })),
            ]}
            error={saveError?.field('sectionId')}
          />
        )}
        {sections.error && !isFeatureDisabled(sections.error) && (
          <ErrorNotice message={sections.error.message} />
        )}

        <SearchFields
          dispatch={dispatch}
          canEdit={canEdit}
          onSave={(input) => save.mutate(input)}
        />

        <form onSubmit={saveSlug} className="grid gap-2">
          <TextField
            label="Web address"
            value={slug}
            placeholder={proposedSlug}
            maxLength={120}
            disabled={!canEdit}
            onChange={(e) => {
              setSlugSaved(false);
              setSlug(e.target.value.toLowerCase());
            }}
            className="font-mono text-[13px]"
            hint={
              <span className="break-all">
                {settings.data ? address : 'Loading the site address…'}
                {!dispatch.slug && ' · made from the subject when first published'}
                {dispatch.slug && slugChanged && ' · the old address keeps redirecting'}
              </span>
            }
            error={saveError?.field('slug')}
          />
          {canEdit && slugChanged && (
            <Button type="submit" variant="ghost" size="sm" loading={save.isPending}>
              Save address
            </Button>
          )}
          <p role="status" className="text-[12.5px] text-success">
            {slugSaved ? 'Address saved.' : ''}
          </p>
        </form>

        {saveError && !saveError.details.length && <ErrorNotice message={saveError.message} />}

        {canEdit && !canceled && (
          <div className="grid gap-2">
            {!dispatch.onSite && (
              <Button
                variant={draft ? 'ghost' : 'primary'}
                disabled={hidden}
                loading={publish.isPending}
                onClick={() => void publishNow()}
              >
                {draft ? 'Publish to web only' : 'Publish to web'}
              </Button>
            )}
            {!dispatch.onSite && hidden && (
              <p className="text-[12.5px] text-sub">
                Choose who can read it on the website before publishing.
              </p>
            )}
            {dispatch.onSite && (
              <Button variant="quiet" onClick={() => setConfirmOff(true)}>
                Take off the website
              </Button>
            )}
          </div>
        )}
        {!canEdit && (
          <p className="text-[12.5px] text-sub">
            An editor or admin chooses how posts appear on the website.
          </p>
        )}
        {publish.error && <ErrorNotice message={publish.error.message} />}
        <Link
          to="/site/$channelId/general"
          params={{ channelId: dispatch.channelId }}
          className="text-[13px] text-purple-deep"
        >
          Website settings
        </Link>
      </div>

      <Dialog
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        title="Take this post off the website?"
        description="It leaves the archive, feeds and site search. Its address is kept, so publishing it again brings it back at the same place."
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirmOff(false)}>
              Keep it on
            </Button>
            <Button
              variant="danger"
              loading={unpublish.isPending}
              onClick={() => unpublish.mutate(undefined, { onSuccess: () => setConfirmOff(false) })}
            >
              Take off the website
            </Button>
          </>
        }
      >
        {unpublish.error && <ErrorNotice message={unpublish.error.message} />}
      </Dialog>
    </Section>
  );
}

/** How the post looks in search results and when shared; saved when a field is left. */
function SearchFields({
  dispatch,
  canEdit,
  onSave,
}: {
  dispatch: Dispatch;
  canEdit: boolean;
  onSave: (input: { seoTitle?: string; seoDescription?: string }) => void;
}) {
  const [title, setTitle] = useState(dispatch.seoTitle);
  const [description, setDescription] = useState(dispatch.seoDescription);
  return (
    <div className="grid gap-2">
      <TextField
        label="Search title"
        value={title}
        maxLength={120}
        disabled={!canEdit}
        placeholder={dispatch.subject}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => {
          if (title !== dispatch.seoTitle) onSave({ seoTitle: title });
        }}
        hint="Shown in search results and when shared. Leave empty to use the subject."
      />
      <TextField
        label="Search description"
        value={description}
        maxLength={300}
        disabled={!canEdit}
        placeholder={dispatch.preheader}
        onChange={(e) => setDescription(e.target.value)}
        onBlur={() => {
          if (description !== dispatch.seoDescription) onSave({ seoDescription: description });
        }}
      />
    </div>
  );
}
