import type { Channel, SignupPath } from '@swarm/domain';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  Pill,
  TextAreaField,
  TextField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import {
  channelQuery,
  channelsQuery,
  mediaQuery,
  useCreateChannel,
  useDeleteChannel,
  useRestoreChannel,
  useUpdateChannel,
  useChannelFlag,
  useUploadMedia,
} from '../api/queries';
import * as Icon from '../icons';
import { ROLE_LABEL, useSession } from '../session';

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div className="min-w-0">
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-sub">{subtitle}</p>}
      </div>
      {action && <div className="page-actions">{action}</div>}
    </div>
  );
}

export function ChannelsPage() {
  const { workspace, can } = useSession();
  const channels = useQuery(channelsQuery(workspace.id));
  const deleted = useQuery({ ...channelsQuery(workspace.id, true), enabled: can('admin') });
  const restore = useRestoreChannel(workspace.id);

  return (
    <>
      <PageHeader
        title="Publications"
        subtitle={`Newsletters in ${workspace.name}.`}
        action={
          can('admin') && (
            <Link to="/channels/new" className="btn-primary">
              <Icon.Plus size={16} />
              Create publication
            </Link>
          )
        }
      />
      {channels.isPending && <LoadingRows label="Loading publications" />}
      {channels.error && (
        <ErrorNotice
          message={channels.error.message}
          action={
            <Button variant="ghost" onClick={() => void channels.refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {channels.data?.length === 0 && (
        <EmptyState
          title="No publications yet"
          action={
            can('admin') && (
              <Link to="/channels/new" className="btn-primary btn-sm">
                Create your first publication
              </Link>
            )
          }
        >
          A publication is one newsletter: its posts, subscribers and site. Most writers start with
          one.
        </EmptyState>
      )}
      {!!channels.data?.length && (
        <div className="card-app overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-[13.5px]">
            <thead>
              <tr className="table-head">
                <th scope="col" className="px-5 py-3 font-semibold">
                  Publication
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  Address
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  Your role
                </th>
                <th scope="col" className="px-5 py-3 font-semibold">
                  Created
                </th>
              </tr>
            </thead>
            <tbody>
              {channels.data.map((channel) => (
                <tr key={channel.id} className="border-t border-line hover:bg-surface-alt">
                  <td className="px-5 py-3.5">
                    <Link
                      to="/channels/$channelId"
                      params={{ channelId: channel.id }}
                      className="flex items-center gap-3 font-semibold text-ink no-underline hover:underline"
                    >
                      <ChannelMark channel={channel} />
                      {channel.name}
                    </Link>
                  </td>
                  <td className="px-3 py-3.5 font-mono text-[12.5px] text-sub">{channel.slug}</td>
                  <td className="px-3 py-3.5">{ROLE_LABEL[channel.role]}</td>
                  <td className="tabular px-5 py-3.5 text-sub">
                    {dateFormat.format(new Date(channel.createdAt))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!!deleted.data?.length && (
        <section aria-labelledby="deleted-title" className="mt-8">
          <h2 id="deleted-title" className="text-[16px] font-semibold">
            Recently deleted
          </h2>
          <p className="mt-1 text-[13px] text-sub">
            Restorable for 30 days after deletion. The address stays reserved until then.
          </p>
          <ul className="mt-3 divide-y divide-line rounded-card-app border border-line-app">
            {deleted.data.map((channel) => (
              <li
                key={channel.id}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-[13.5px]"
              >
                <span>
                  <b>{channel.name}</b>{' '}
                  <span className="text-sub">
                    · deleted {dateFormat.format(new Date(channel.deletedAt ?? channel.updatedAt))}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  loading={restore.isPending && restore.variables === channel.id}
                  onClick={() => restore.mutate(channel.id)}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function ChannelMark({ channel }: { channel: Channel }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-8 shrink-0 place-items-center rounded-[10px] text-[12px] font-bold text-white"
      style={{ background: channel.branding.accentColor ?? 'var(--purple)' }}
    >
      {channel.name.slice(0, 2).toUpperCase()}
    </span>
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function NewChannelPage() {
  const { workspace } = useSession();
  const navigate = useNavigate();
  const create = useCreateChannel(workspace.id);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState('');
  const error = create.error instanceof ApiError ? create.error : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { name, slug, description: description.trim() || null },
      {
        onSuccess: (channel) =>
          void navigate({ to: '/channels/$channelId', params: { channelId: channel.id } }),
      },
    );
  };

  return (
    <>
      <PageHeader
        title="Create publication"
        subtitle="You can change the name and description later. The address is permanent."
      />
      <form onSubmit={submit} className="card-app grid max-w-[620px] gap-5 p-6">
        <TextField
          label="Name"
          required
          maxLength={80}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            if (!slugTouched) setSlug(slugify(event.target.value));
          }}
          error={error?.field('name')}
        />
        <TextField
          label="Address"
          required
          value={slug}
          onChange={(event) => {
            setSlugTouched(true);
            setSlug(event.target.value.toLowerCase());
          }}
          hint={
            slug
              ? `Your site will live at ${slug}.swarm.example`
              : 'Lowercase letters, numbers and dashes.'
          }
          error={error?.field('slug') ?? (error?.code === 'conflict' ? error.message : undefined)}
          className="font-mono text-[13px]"
        />
        <TextAreaField
          label="Description"
          maxLength={280}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          hint="One or two sentences readers see on your site."
        />
        {error && !error.details.length && error.code !== 'conflict' && (
          <ErrorNotice message={error.message} />
        )}
        <div className="flex gap-2">
          <Button type="submit" loading={create.isPending}>
            Create publication
          </Button>
          <Link to="/channels" className="btn-ghost">
            Cancel
          </Link>
        </div>
      </form>
    </>
  );
}

export function ChannelSettingsPage({ channelId }: { channelId: string }) {
  const channel = useQuery(channelQuery(channelId));
  if (channel.isPending) return <LoadingRows label="Loading publication" rows={4} />;
  if (channel.error) {
    return (
      <ErrorNotice
        title="Publication not available"
        message={channel.error.message}
        action={
          <Link to="/channels" className="btn-ghost">
            Back to publications
          </Link>
        }
      />
    );
  }
  return <ChannelSettings key={channel.data.updatedAt} channel={channel.data} />;
}

const RANK = { viewer: 0, author: 1, editor: 2, admin: 3, owner: 4 } as const;

const SIGNUP_PATH_CHOICES: { value: SignupPath; label: string; hint: string }[] = [
  { value: 'email', label: 'Email only', hint: 'The form on your website asks for an address.' },
  {
    value: 'email_name',
    label: 'Email, then name',
    hint: 'The address is saved first, then the next page asks for a first and last name.',
  },
  {
    value: 'email_name_plan',
    label: 'Email, name, then plan',
    hint: 'A last page offers free or a paid level. It’s skipped until you can take payments.',
  },
];

function ChannelSettings({ channel }: { channel: Channel }) {
  const navigate = useNavigate();
  const update = useUpdateChannel(channel.id);
  const remove = useDeleteChannel(channel);
  const upload = useUploadMedia(channel.id);
  const media = useQuery(mediaQuery(channel.id));
  const [name, setName] = useState(channel.name);
  const [description, setDescription] = useState(channel.description ?? '');
  const [styleGuide, setStyleGuide] = useState(channel.styleGuide);
  const [accent, setAccent] = useState(channel.branding.accentColor ?? '#6c4cf1');
  const [doubleOptIn, setDoubleOptIn] = useState(channel.doubleOptIn);
  const [requireConfirmation, setRequireConfirmation] = useState(channel.requireConfirmation);
  const [signupPath, setSignupPath] = useState(channel.signupPath);
  const signupSteps = useChannelFlag(channel.id, 'signup_paths') === true;
  const [confirmDays, setConfirmDays] = useState(String(channel.confirmDays));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saved, setSaved] = useState(false);
  const canEdit = RANK[channel.role] >= RANK.editor;
  const canAdmin = RANK[channel.role] >= RANK.admin;
  const logo = media.data?.find((m) => m.id === channel.branding.logoMediaId);
  const error = update.error instanceof ApiError ? update.error : null;

  const save = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    update.mutate(
      {
        name,
        description: description.trim() || null,
        styleGuide,
        // Only send the colour when it changed, so a Channel without one isn't pinned to the default.
        ...(accent !== (channel.branding.accentColor ?? '#6c4cf1')
          ? { branding: { accentColor: accent } }
          : {}),
        doubleOptIn,
        requireConfirmation: doubleOptIn && requireConfirmation,
        ...(signupSteps && signupPath !== channel.signupPath ? { signupPath } : {}),
        confirmDays: Number(confirmDays),
      },
      { onSuccess: () => setSaved(true) },
    );
  };

  const onLogo = (file: File | undefined) => {
    if (!file) return;
    upload.mutate(file, {
      onSuccess: (asset) => update.mutate({ branding: { logoMediaId: asset.id } }),
    });
  };

  return (
    <>
      <PageHeader
        title={channel.name}
        subtitle={`${channel.slug} · your role: ${ROLE_LABEL[channel.role]}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {channel.status === 'paused' ? (
              <Pill tone="scheduled">Paused</Pill>
            ) : (
              <Pill tone="success">Active</Pill>
            )}
            <Link
              to="/channels/$channelId/sending"
              params={{ channelId: channel.id }}
              className="btn-ghost btn-sm"
            >
              Sending settings
            </Link>
            <Link
              to="/channels/$channelId/deliverability"
              params={{ channelId: channel.id }}
              className="btn-ghost btn-sm"
            >
              Deliverability
            </Link>
            <Link
              to="/site/$channelId/general"
              params={{ channelId: channel.id }}
              className="btn-ghost btn-sm"
            >
              Website
            </Link>
            <Link
              to="/channels/$channelId/media"
              params={{ channelId: channel.id }}
              className="btn-ghost btn-sm"
            >
              Media
            </Link>
            <Link
              to="/channels/$channelId/members-settings"
              params={{ channelId: channel.id }}
              className="btn-ghost btn-sm"
            >
              Fields and tags
            </Link>
          </div>
        }
      />
      <div className="grid max-w-[760px] gap-5">
        <form onSubmit={save} className="card-app grid gap-5 p-6" aria-labelledby="general-title">
          <h2 id="general-title" className="text-[16px] font-semibold">
            General
          </h2>
          <TextField
            label="Name"
            required
            maxLength={80}
            value={name}
            disabled={!canEdit}
            onChange={(e) => setName(e.target.value)}
            error={error?.field('name')}
          />
          <TextAreaField
            label="Description"
            maxLength={280}
            value={description}
            disabled={!canEdit}
            onChange={(e) => setDescription(e.target.value)}
            error={error?.field('description')}
          />
          <TextAreaField
            label="Style guide"
            maxLength={4000}
            rows={5}
            value={styleGuide}
            disabled={!canEdit}
            onChange={(e) => setStyleGuide(e.target.value)}
            error={error?.field('styleGuide')}
            hint="Voice, format and rules an AI agent working in this publication should follow. Agents read it as publication context before they write."
          />
          <div className="grid gap-1.5">
            <label htmlFor="accent" className="text-[13px] font-semibold">
              Accent colour
            </label>
            <div className="flex items-center gap-3">
              <input
                id="accent"
                type="color"
                value={accent}
                disabled={!canEdit}
                onChange={(e) => setAccent(e.target.value)}
                className="h-11 w-14 cursor-pointer rounded-control border border-line-control bg-surface p-1"
              />
              <span className="font-mono text-[13px] text-sub">{accent}</span>
            </div>
          </div>
          <div className="flex items-start gap-2.5 text-[13.5px]">
            <input
              id="double-opt-in"
              type="checkbox"
              checked={doubleOptIn}
              disabled={!canEdit}
              onChange={(e) => setDoubleOptIn(e.target.checked)}
              aria-describedby="double-opt-in-hint"
              className="mt-1 size-4 accent-purple"
            />
            <div>
              <label htmlFor="double-opt-in" className="font-semibold">
                Double opt-in
              </label>
              <p id="double-opt-in-hint" className="text-[12.5px] text-sub">
                New subscribers confirm by email before they receive anything. Signup forms follow
                this unless they set their own.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2.5 pl-[26px] text-[13.5px]">
            <input
              id="require-confirmation"
              type="checkbox"
              checked={doubleOptIn && requireConfirmation}
              disabled={!canEdit || !doubleOptIn}
              onChange={(e) => setRequireConfirmation(e.target.checked)}
              aria-describedby="require-confirmation-hint"
              className="mt-1 size-4 accent-purple"
            />
            <div>
              <label htmlFor="require-confirmation" className="font-semibold">
                Every subscriber must confirm
              </label>
              <p id="require-confirmation-hint" className="text-[12.5px] text-sub">
                Forms can’t turn this off, and people you add by hand or through the API are emailed
                a confirmation. Two exceptions: imported lists, where you state they agreed, and
                people who pay at checkout.
              </p>
            </div>
          </div>
          {signupSteps && (
            <fieldset className="grid gap-2 text-[13.5px]">
              <legend className="mb-1 font-semibold">Website signup</legend>
              {SIGNUP_PATH_CHOICES.map((choice) => (
                <div key={choice.value} className="flex items-start gap-2.5">
                  <input
                    id={`signup-path-${choice.value}`}
                    type="radio"
                    name="signup-path"
                    value={choice.value}
                    checked={signupPath === choice.value}
                    disabled={!canEdit}
                    onChange={() => setSignupPath(choice.value)}
                    aria-describedby={`signup-path-${choice.value}-hint`}
                    className="mt-1 size-4 accent-purple"
                  />
                  <div>
                    <label htmlFor={`signup-path-${choice.value}`} className="font-semibold">
                      {choice.label}
                    </label>
                    <p id={`signup-path-${choice.value}-hint`} className="text-[12.5px] text-sub">
                      {choice.hint}
                    </p>
                  </div>
                </div>
              ))}
              <p className="text-[12.5px] text-sub">
                To collect emails now and sell later, choose Email only and start the upsell recipe
                in{' '}
                <Link to="/flows" search={{ channel: channel.id }} className="text-purple-deep">
                  Automations
                </Link>
                .
              </p>
            </fieldset>
          )}
          <div className="max-w-[220px]">
            <TextField
              label="Confirm links work for (days)"
              type="number"
              min={1}
              max={30}
              required
              disabled={!canEdit}
              value={confirmDays}
              onChange={(e) => setConfirmDays(e.target.value)}
            />
          </div>
          {error && !error.details.length && <ErrorNotice message={error.message} />}
          {canEdit && (
            <div className="flex items-center gap-3">
              <Button type="submit" loading={update.isPending}>
                Save changes
              </Button>
              <p role="status" className="text-[13px] text-success">
                {saved ? 'Saved.' : ''}
              </p>
            </div>
          )}
        </form>

        <section className="card-app grid gap-4 p-6" aria-labelledby="logo-title">
          <div>
            <h2 id="logo-title" className="text-[16px] font-semibold">
              Logo
            </h2>
            <p className="mt-1 text-[13px] text-sub">
              PNG, JPEG, WebP or GIF up to 10 MB. Square images work best.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <span className="grid size-20 place-items-center overflow-hidden rounded-[18px] border border-line-app bg-surface-alt">
              {logo ? (
                <img
                  src={logo.url}
                  alt={`${channel.name} logo`}
                  className="size-full object-cover"
                />
              ) : (
                <span className="text-[12px] text-sub">No logo</span>
              )}
            </span>
            {RANK[channel.role] >= RANK.author && canEdit && (
              <label className="btn-ghost cursor-pointer has-focus-visible:outline-2 has-focus-visible:outline-purple">
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
                  className="sr-only"
                  onChange={(e) => onLogo(e.target.files?.[0])}
                />
                {upload.isPending ? 'Uploading…' : logo ? 'Replace logo' : 'Upload logo'}
              </label>
            )}
          </div>
          {upload.error && <ErrorNotice title="Upload failed" message={upload.error.message} />}
        </section>

        {canAdmin && (
          <section
            className="card-app grid gap-3 border-danger-soft p-6"
            aria-labelledby="danger-title"
          >
            <h2 id="danger-title" className="text-[16px] font-semibold">
              Delete this publication
            </h2>
            <p className="text-[13.5px] text-sub">
              The publication disappears for everyone straight away, and any email it is still
              sending stops. You can restore it from the Publications page for 30 days.
            </p>
            <div>
              <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                Delete publication
              </Button>
            </div>
          </section>
        )}
      </div>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${channel.name}?`}
        description="It can be restored for 30 days from the Publications page."
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep publication
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(undefined, { onSuccess: () => void navigate({ to: '/channels' }) })
              }
            >
              Delete publication
            </Button>
          </>
        }
      >
        {remove.error && <ErrorNotice message={remove.error.message} />}
      </Dialog>
    </>
  );
}
