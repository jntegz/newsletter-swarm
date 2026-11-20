// Growth → Series (flag post_series): Dispatches grouped in reading order, with a "next in
// series" link on the website. Reorder by dragging, or with the Move up / Move down buttons.
import type { DispatchSummary, Series } from '@swarm/domain';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  SelectField,
  TextAreaField,
  TextField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type DragEvent, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import {
  seriesListQuery,
  seriesQuery,
  useCreateSeries,
  useDeleteSeries,
  useUpdateSeries,
} from '../api/growth';
import { dispatchesQuery } from '../api/send';
import { DispatchPill, Section, numberFormat } from '../pages/common';
import { moveItem } from './helpers';
import { OFF_TEXT, QueryState, useGrowth } from './Layout';

const OFF = { title: 'Series are off', text: OFF_TEXT };

export function SeriesListPage() {
  const { channel, canEdit } = useGrowth();
  const series = useQuery(seriesListQuery(channel.id));
  const [creating, setCreating] = useState(false);
  const newButton = (label: string) =>
    canEdit && (
      <Button size="sm" onClick={() => setCreating(true)}>
        {label}
      </Button>
    );
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[65ch] text-[13.5px] text-sub">
          Group posts that belong together. Each one links to the next on your website.
        </p>
        {!!series.data?.length && newButton('New series')}
      </div>
      <QueryState query={series} label="Loading Series" off={OFF}>
        {series.data?.length === 0 ? (
          <EmptyState title="No series yet" action={newButton('Create a series')}>
            A series keeps a run of posts in order, for example a course or a multi-part story.
          </EmptyState>
        ) : (
          <ul className="grid gap-2">
            {series.data?.map((s) => (
              <li key={s.id} className="card-app flex flex-wrap items-center gap-3 px-5 py-4">
                <span className="min-w-0 flex-1">
                  <Link
                    to="/growth/$channelId/series/$seriesId"
                    params={{ channelId: channel.id, seriesId: s.id }}
                    className="font-semibold text-ink no-underline hover:underline"
                  >
                    {s.name}
                  </Link>
                  <span className="block font-mono text-[12px] text-sub">/series/{s.slug}</span>
                </span>
                <span className="tabular text-[13px] text-sub">
                  {numberFormat.format(s.dispatchIds.length)} post
                  {s.dispatchIds.length === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      {creating && <CreateSeriesDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateSeriesDialog({ onClose }: { onClose: () => void }) {
  const { channel } = useGrowth();
  const navigate = useNavigate();
  const create = useCreateSeries(channel.id);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const error = create.error instanceof ApiError ? create.error : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { name: name.trim(), description: description.trim() || null },
      {
        onSuccess: (series) =>
          void navigate({
            to: '/growth/$channelId/series/$seriesId',
            params: { channelId: channel.id, seriesId: series.id },
          }),
      },
    );
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Create a series"
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="create-series" loading={create.isPending}>
            Create
          </Button>
        </>
      }
    >
      <form id="create-series" className="grid gap-4" onSubmit={submit}>
        <TextField
          label="Name"
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={error?.field('name')}
        />
        <TextAreaField
          label="Description (optional)"
          rows={2}
          maxLength={500}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        {error && !error.details.length && <ErrorNotice message={error.message} />}
      </form>
    </Dialog>
  );
}

export function SeriesPage({ seriesId }: { seriesId: string }) {
  const { channel } = useGrowth();
  const series = useQuery(seriesQuery(channel.id, seriesId));
  return (
    <QueryState query={series} label="Loading the Series" off={OFF}>
      {series.data && <SeriesEditor key={series.data.id} series={series.data} />}
    </QueryState>
  );
}

function SeriesEditor({ series }: { series: Series }) {
  const { channel, canEdit } = useGrowth();
  const navigate = useNavigate();
  const update = useUpdateSeries(channel.id, series.id);
  const remove = useDeleteSeries(channel.id, series.id);
  const dispatches = useQuery(dispatchesQuery(channel.id));
  const [name, setName] = useState(series.name);
  const [slug, setSlug] = useState(series.slug);
  const [description, setDescription] = useState(series.description ?? '');
  const [order, setOrder] = useState<string[]>(series.dispatchIds);
  const [adding, setAdding] = useState('');
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [saved, setSaved] = useState(false);
  const error = update.error instanceof ApiError ? update.error : null;
  const byId = new Map((dispatches.data ?? []).map((d) => [d.id, d]));
  const title = (id: string) => byId.get(id)?.subject || 'Untitled post';
  const available = (dispatches.data ?? []).filter((d) => !order.includes(d.id));

  const changeOrder = (next: string[], message: string) => {
    setSaved(false);
    setOrder(next);
    setAnnouncement(message);
  };
  const move = (from: number, to: number) => {
    const id = order[from];
    if (!id || to < 0 || to >= order.length) return;
    changeOrder(
      moveItem(order, from, to),
      `${title(id)} moved to position ${to + 1} of ${order.length}.`,
    );
  };

  const onDrop = (event: DragEvent, to: number) => {
    event.preventDefault();
    if (dragging !== null && dragging !== to) move(dragging, to);
    setDragging(null);
    setOver(null);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate(
      {
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim() || null,
        dispatchIds: order,
      },
      { onSuccess: () => setSaved(true) },
    );
  };

  return (
    <form className="grid gap-5" onSubmit={submit}>
      <div className="text-[13px]">
        <Link
          to="/growth/$channelId/series"
          params={{ channelId: channel.id }}
          className="text-sub no-underline hover:text-ink"
        >
          ← Series
        </Link>
      </div>
      <Section title="Series">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Name"
            required
            maxLength={80}
            readOnly={!canEdit}
            value={name}
            onChange={(e) => {
              setSaved(false);
              setName(e.target.value);
            }}
            error={error?.field('name')}
          />
          <TextField
            label="Web address"
            maxLength={80}
            readOnly={!canEdit}
            value={slug}
            onChange={(e) => {
              setSaved(false);
              setSlug(e.target.value);
            }}
            hint={`Shown at /series/${slug || '…'}`}
            error={error?.field('slug')}
          />
        </div>
        <div className="mt-4">
          <TextAreaField
            label="Description (optional)"
            rows={2}
            maxLength={500}
            readOnly={!canEdit}
            value={description}
            onChange={(e) => {
              setSaved(false);
              setDescription(e.target.value);
            }}
          />
        </div>
      </Section>

      <Section
        title="Reading order"
        description={
          canEdit ? 'Drag a post to move it, or use Move up and Move down.' : 'Part 1 comes first.'
        }
      >
        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>
        {dispatches.error && <ErrorNotice message={dispatches.error.message} />}
        {order.length === 0 ? (
          <p className="text-[13.5px] text-sub">No posts in this series yet.</p>
        ) : (
          <ol className="grid gap-2" aria-label="Posts in reading order">
            {order.map((id, i) => {
              const dispatch: DispatchSummary | undefined = byId.get(id);
              return (
                <li
                  key={id}
                  draggable={canEdit}
                  onDragStart={(e) => {
                    setDragging(i);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', id);
                  }}
                  onDragOver={(e) => {
                    if (dragging === null) return;
                    e.preventDefault();
                    setOver(i);
                  }}
                  onDragLeave={() => setOver((o) => (o === i ? null : o))}
                  onDrop={(e) => onDrop(e, i)}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                  className={`flex flex-wrap items-center gap-3 rounded-card-app border bg-surface px-3 py-2.5 text-[13.5px] ${
                    over === i && dragging !== i ? 'border-purple bg-lavender' : 'border-line-app'
                  } ${dragging === i ? 'opacity-60' : ''} ${canEdit ? 'cursor-grab' : ''}`}
                >
                  {canEdit && (
                    <span aria-hidden="true" className="text-sub select-none">
                      ⋮⋮
                    </span>
                  )}
                  <span className="tabular w-14 shrink-0 text-sub">Part {i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{title(id)}</span>
                  </span>
                  {dispatch && <DispatchPill status={dispatch.status} />}
                  {canEdit && (
                    <span className="flex gap-1">
                      <Button
                        variant="quiet"
                        size="sm"
                        disabled={i === 0}
                        onClick={() => move(i, i - 1)}
                      >
                        Move up<span className="sr-only"> {title(id)}</span>
                      </Button>
                      <Button
                        variant="quiet"
                        size="sm"
                        disabled={i === order.length - 1}
                        onClick={() => move(i, i + 1)}
                      >
                        Move down<span className="sr-only"> {title(id)}</span>
                      </Button>
                      <Button
                        variant="quiet"
                        size="sm"
                        onClick={() =>
                          changeOrder(
                            order.filter((x) => x !== id),
                            `${title(id)} removed from the series.`,
                          )
                        }
                      >
                        Remove<span className="sr-only"> {title(id)}</span>
                      </Button>
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {canEdit && (
          <div className="mt-4 flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 sm:max-w-sm">
              <SelectField
                label="Add a post"
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
                options={[
                  {
                    value: '',
                    label: dispatches.isPending
                      ? 'Loading posts…'
                      : available.length
                        ? 'Choose a post'
                        : 'Every post is in the series',
                  },
                  ...available.map((d) => ({
                    value: d.id,
                    label: d.subject || 'Untitled post',
                  })),
                ]}
              />
            </div>
            <Button
              variant="ghost"
              disabled={!adding}
              onClick={() => {
                changeOrder(
                  [...order, adding],
                  `${title(adding)} added as part ${order.length + 1}.`,
                );
                setAdding('');
              }}
            >
              Add
            </Button>
          </div>
        )}
        {error?.field('dispatchIds') && (
          <p role="alert" className="mt-3 text-[12.5px] font-semibold text-danger">
            {error.field('dispatchIds')}
          </p>
        )}
      </Section>

      {error && !error.details.length && <ErrorNotice title="Not saved" message={error.message} />}
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={update.isPending}>
            Save series
          </Button>
          {saved && (
            <span role="status" className="text-[13px] text-success">
              Saved.
            </span>
          )}
          <Button
            variant="quiet"
            className="ml-auto"
            loading={remove.isPending}
            onClick={() => {
              if (window.confirm(`Delete the series “${series.name}”? Its posts stay.`)) {
                remove.mutate(undefined, {
                  onSuccess: () =>
                    void navigate({
                      to: '/growth/$channelId/series',
                      params: { channelId: channel.id },
                    }),
                });
              }
            }}
          >
            Delete series
          </Button>
        </div>
      ) : (
        <p className="text-[12.5px] text-sub">An editor or admin changes series.</p>
      )}
      {remove.error && <ErrorNotice title="Not deleted" message={remove.error.message} />}
    </form>
  );
}
