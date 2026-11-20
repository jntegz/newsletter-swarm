// Site Studio → Authors (flag author_pages): your own author page on the website (name, address,
// bio and avatar), and, for admins, every teammate's page with a way to remove it. Bylines on
// Dispatches link to the page of the teammate who created them.
import type { AuthorProfile, MediaAsset } from '@swarm/domain';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  TextAreaField,
  TextField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import { mediaQuery } from '../api/queries';
import { authorsQuery, isFeatureDisabled, useDeleteAuthor, useSaveAuthor } from '../api/site';
import { useSession } from '../session';
import { ReadOnlyNote, SaveRow } from '../site/controls';
import { Section, focalStyle, numberFormat } from './common';
import { MediaPicker } from './MediaPicker';
import { useSiteStudio } from './SiteStudio';

export function SiteAuthors() {
  const { channel } = useSiteStudio();
  const { me } = useSession();
  const authors = useQuery(authorsQuery(channel.id));
  // Held here: a save changes updatedAt, which remounts the form below with the saved values.
  const [saved, setSaved] = useState(false);

  if (isFeatureDisabled(authors.error)) {
    return (
      <Section title="Author pages">
        <EmptyState title="Author pages are not available for this publication">
          Author pages give each writer a profile on the website, and bylines on their posts link to
          it. They are an optional feature that is switched off here.
        </EmptyState>
      </Section>
    );
  }
  if (authors.isPending) return <LoadingRows label="Loading author pages" rows={3} />;
  if (authors.error) return <ErrorNotice message={authors.error.message} />;

  const mine = authors.data.find((a) => a.operatorId === me.operator.id) ?? null;
  return (
    <div className="grid max-w-[820px] gap-5">
      <OwnAuthorPage
        key={mine?.updatedAt ?? 'new'}
        operatorId={me.operator.id}
        page={mine}
        saved={saved}
        setSaved={setSaved}
      />
      <AuthorList authors={authors.data} />
    </div>
  );
}

function OwnAuthorPage({
  operatorId,
  page,
  saved,
  setSaved,
}: {
  operatorId: string;
  page: AuthorProfile | null;
  saved: boolean;
  setSaved: (saved: boolean) => void;
}) {
  const { channel, settings } = useSiteStudio();
  const canWrite = channel.role !== 'viewer';
  const save = useSaveAuthor(channel.id);
  const remove = useDeleteAuthor(channel.id);
  const media = useQuery(mediaQuery(channel.id, '', 'image'));
  const [name, setName] = useState(page?.name ?? '');
  const [slug, setSlug] = useState(page?.slug ?? '');
  const [bio, setBio] = useState(page?.bio ?? '');
  const [avatarId, setAvatarId] = useState<string | null>(page?.avatarMediaId ?? null);
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<MediaAsset | null>(null);
  const apiError = save.error instanceof ApiError ? save.error : null;
  const avatar =
    chosen?.id === avatarId ? chosen : (media.data?.find((m) => m.id === avatarId) ?? null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    save.mutate(
      {
        operatorId,
        name: name.trim(),
        ...(slug.trim() ? { slug: slug.trim() } : {}),
        bio: bio.trim() || null,
        avatarMediaId: avatarId,
      },
      { onSuccess: () => setSaved(true) },
    );
  };

  return (
    <form onSubmit={submit} aria-label="Your author page">
      <Section
        title="Your author page"
        description={
          page ? (
            <>
              At{' '}
              <a href={page.url} target="_blank" rel="noreferrer" className="font-mono">
                /authors/{page.slug}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
              . Bylines on the {numberFormat.format(page.dispatchCount)}{' '}
              {page.dispatchCount === 1 ? 'post' : 'posts'} you created link here.
            </>
          ) : (
            'Readers see it when they follow the byline on a post you created.'
          )
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Name"
            required
            maxLength={80}
            value={name}
            disabled={!canWrite}
            onChange={(e) => setName(e.target.value)}
            error={apiError?.field('name')}
          />
          <TextField
            label="Address (optional)"
            maxLength={60}
            value={slug}
            disabled={!canWrite}
            placeholder="made from the name"
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            className="font-mono text-[13px]"
            hint={`${settings.url}/authors/${slug || '…'}`}
            error={apiError?.field('slug')}
          />
          <div className="sm:col-span-2">
            <TextAreaField
              label="Bio (optional)"
              maxLength={1000}
              value={bio}
              disabled={!canWrite}
              onChange={(e) => setBio(e.target.value)}
              error={apiError?.field('bio')}
            />
          </div>
          <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
            <div className="grid size-20 place-items-center overflow-hidden rounded-full border border-line-app bg-surface-alt">
              {avatar ? (
                <img
                  src={avatar.url}
                  alt="Your avatar"
                  className="size-full object-cover"
                  style={focalStyle(avatar)}
                />
              ) : avatarId && media.isPending ? (
                <span className="text-[12px] text-sub">Loading…</span>
              ) : (
                <span className="text-[12px] text-sub">No photo</span>
              )}
            </div>
            {canWrite && (
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" size="sm" onClick={() => setPicking(true)}>
                  {avatarId ? 'Replace photo' : 'Choose photo'}
                </Button>
                {avatarId && (
                  <Button variant="quiet" size="sm" onClick={() => setAvatarId(null)}>
                    Remove photo
                  </Button>
                )}
              </div>
            )}
          </div>
          {apiError?.field('avatarMediaId') && (
            <p role="alert" className="text-[12.5px] font-semibold text-danger sm:col-span-2">
              {apiError.field('avatarMediaId')}
            </p>
          )}
        </div>
      </Section>
      <div className="mt-5">
        {canWrite ? (
          <div className="flex flex-wrap items-start gap-3">
            <SaveRow
              label={page ? 'Save author page' : 'Create author page'}
              pending={save.isPending}
              saved={saved}
              error={apiError && !apiError.details.length ? apiError : null}
              disabled={!name.trim()}
            />
            {page && (
              <Button
                variant="quiet"
                loading={remove.isPending}
                onClick={() => {
                  setSaved(false);
                  remove.mutate(operatorId);
                }}
              >
                Remove my author page
              </Button>
            )}
          </div>
        ) : (
          <ReadOnlyNote>Teammates with the author role or higher have an author page.</ReadOnlyNote>
        )}
        {remove.error && <ErrorNotice message={remove.error.message} />}
      </div>
      <Dialog
        open={picking}
        onClose={() => setPicking(false)}
        title="Choose a photo"
        description="A square photo works best, at least 400 pixels across."
        actions={
          <>
            <Button variant="ghost" onClick={() => setPicking(false)}>
              Cancel
            </Button>
            <Button
              disabled={!chosen}
              onClick={() => {
                if (chosen) setAvatarId(chosen.id);
                setPicking(false);
              }}
            >
              Use photo
            </Button>
          </>
        }
      >
        {picking && <MediaPicker channelId={channel.id} chosen={chosen} onChoose={setChosen} />}
      </Dialog>
    </form>
  );
}

function AuthorList({ authors }: { authors: AuthorProfile[] }) {
  const { channel, canAdmin } = useSiteStudio();
  const remove = useDeleteAuthor(channel.id);
  const [removing, setRemoving] = useState<AuthorProfile | null>(null);
  return (
    <Section
      title="Every author page"
      description="One per teammate who writes for this publication."
    >
      {authors.length === 0 ? (
        <p className="text-[13px] text-sub">No author pages yet.</p>
      ) : (
        <ul className="divide-y divide-line rounded-card-app border border-line-app">
          {authors.map((author) => (
            <li
              key={author.operatorId}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-[13.5px]"
            >
              <span className="flex min-w-0 items-center gap-3">
                {author.avatarUrl ? (
                  <img src={author.avatarUrl} alt="" className="size-9 rounded-full object-cover" />
                ) : (
                  <span aria-hidden="true" className="size-9 rounded-full bg-surface-alt" />
                )}
                <span className="min-w-0">
                  <b>{author.name}</b>{' '}
                  <span className="font-mono text-[12.5px] text-sub">/authors/{author.slug}</span>
                  <span className="block text-[12.5px] text-sub">
                    {numberFormat.format(author.dispatchCount)}{' '}
                    {author.dispatchCount === 1 ? 'post' : 'posts'} on the website
                  </span>
                </span>
              </span>
              <span className="flex flex-wrap gap-1">
                <a href={author.url} target="_blank" rel="noreferrer" className="btn-quiet">
                  View<span className="sr-only"> {author.name} (opens in a new tab)</span>
                </a>
                {canAdmin && (
                  <Button
                    variant="quiet"
                    size="sm"
                    aria-label={`Remove the author page of ${author.name}`}
                    onClick={() => setRemoving(author)}
                  >
                    Remove
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={`Remove the author page of ${removing?.name ?? ''}?`}
        description="Their posts stay on the website, without a byline."
        actions={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() =>
                removing &&
                remove.mutate(removing.operatorId, { onSuccess: () => setRemoving(null) })
              }
            >
              Remove author page
            </Button>
          </>
        }
      >
        {remove.error && <ErrorNotice message={remove.error.message} />}
      </Dialog>
    </Section>
  );
}
