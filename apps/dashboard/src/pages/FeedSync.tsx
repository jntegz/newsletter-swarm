// Dispatches → Feed Sync (Phase 8, flag feed_sync): the feeds a Channel follows, with their
// status and last error, Check now, the preview of the next Dispatch, the items seen, and the
// add and edit dialog (mode, grouping, Template, audience, caps, quiet window). Viewers read;
// editors and above change. Contract: docs/feed-sync.md.
import type {
  Channel,
  CreateFeedSource,
  FeedItemStatus,
  FeedSource,
  FeedSourceStatus,
} from '@swarm/domain';
import {
  Button,
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
import { useState, type FormEvent, type ReactNode } from 'react';
import { allCirclesQuery } from '../api/circles';
import { ApiError } from '../api/client';
import {
  feedItemsQuery,
  feedPreviewQuery,
  feedSourcesQuery,
  useCheckFeedSource,
  useCreateFeedSource,
  useDeleteFeedSource,
  useUpdateFeedSource,
} from '../api/feeds';
import { templatesQuery } from '../api/flows';
import { isFeatureDisabled } from '../api/site';
import { WEEKDAY_SHORT } from '../flows/summary';
import { RosterAudience } from '../rosters/RosterAudience';
import { sendersQuery } from '../api/send';
import * as Icon from '../icons';
import { useSession } from '../session';
import { PageHeader } from './Channels';
import { WithChannel, formatDateTime, numberFormat } from './common';

const STATUS: Record<FeedSourceStatus, { label: string; tone: 'success' | 'neutral' | 'danger' }> =
  {
    active: { label: 'Active', tone: 'success' },
    paused: { label: 'Paused', tone: 'neutral' },
    disabled: { label: 'Turned off after errors', tone: 'danger' },
  };

const ITEM_STATUS: Record<
  FeedItemStatus,
  { label: string; tone: 'brand' | 'success' | 'neutral' }
> = {
  new: { label: 'Waiting', tone: 'brand' },
  dispatched: { label: 'In a post', tone: 'success' },
  skipped: { label: 'Already in the feed', tone: 'neutral' },
};

const INTERVALS = [15, 30, 60, 180, 360, 720, 1440];

const minutesLabel = (minutes: number) =>
  minutes < 60
    ? `${minutes} minutes`
    : minutes === 60
      ? 'hour'
      : minutes === 1440
        ? 'day'
        : `${minutes / 60} hours`;

const sourceName = (source: FeedSource) =>
  source.name || source.title || new URL(source.url).hostname;

/** Editors and above change feed sources: a feed in send mode sends Dispatches. */
const canChange = (channel: Channel) =>
  channel.role === 'editor' || channel.role === 'admin' || channel.role === 'owner';

export function FeedSyncPage({ channelId }: { channelId: string }) {
  const navigate = useNavigate();
  return (
    <WithChannel
      channelId={channelId}
      onChange={(id) =>
        void navigate({ to: '/channels/$channelId/feeds', params: { channelId: id } })
      }
    >
      {(channel, picker) => <FeedSourceList channel={channel} picker={picker} />}
    </WithChannel>
  );
}

function FeedSourceList({ channel, picker }: { channel: Channel; picker: ReactNode }) {
  const sources = useQuery(feedSourcesQuery(channel.id));
  const [editing, setEditing] = useState<FeedSource | 'new' | null>(null);
  const writable = canChange(channel);
  const disabled = isFeatureDisabled(sources.error);

  const addButton = writable && !disabled && (
    <Button size="sm" icon={<Icon.Plus size={16} />} onClick={() => setEditing('new')}>
      Add feed
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Feed Sync"
        subtitle={`Posts drafted or sent from the RSS, Atom and JSON feeds ${channel.name} follows.`}
        action={
          <div className="flex flex-wrap items-center gap-3">
            {picker}
            <Link
              to="/dispatches"
              search={{ channel: channel.id }}
              className="btn-ghost no-underline"
            >
              Posts
            </Link>
            {addButton}
          </div>
        }
      />
      {sources.isPending && <LoadingRows label="Loading feeds" />}
      {disabled && (
        <EmptyState title="Feed Sync is not turned on">
          Ask a workspace owner if you’d like to use it for {channel.name}.
        </EmptyState>
      )}
      {sources.error && !disabled && (
        <ErrorNotice
          message={sources.error.message}
          action={
            <Button variant="ghost" onClick={() => void sources.refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {sources.data?.length === 0 && (
        <EmptyState title="No feeds yet" action={addButton}>
          Add a feed and new items become posts: drafts for you to finish, or sent on their own.
          Posts already in the feed are left out.
        </EmptyState>
      )}
      {!!sources.data?.length && (
        <ul className="card-app divide-y divide-line">
          {sources.data.map((source) => (
            <FeedSourceRow
              key={source.id}
              channel={channel}
              source={source}
              writable={writable}
              onEdit={() => setEditing(source)}
            />
          ))}
        </ul>
      )}
      {editing && (
        <FeedSourceForm
          channel={channel}
          source={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function FeedSourceRow({
  channel,
  source,
  writable,
  onEdit,
}: {
  channel: Channel;
  source: FeedSource;
  writable: boolean;
  onEdit: () => void;
}) {
  const check = useCheckFeedSource(channel.id);
  const update = useUpdateFeedSource(channel.id, source.id);
  const [open, setOpen] = useState<'preview' | 'items' | 'delete' | null>(null);
  const result = check.data;
  const status = STATUS[source.status];

  const summary = [
    source.mode === 'send' ? 'Sends on its own' : 'Drafts only',
    source.grouping === 'digest' ? `digest of up to ${source.digestLimit}` : 'one per post',
    `checked every ${minutesLabel(source.intervalMinutes)}`,
    `at most ${source.maxPerDay} a day`,
    ...(source.grouping === 'digest' && source.digestSchedule
      ? [
          `${source.digestSchedule.weekdays.map((day) => WEEKDAY_SHORT[day]).join(', ')} at ${source.digestSchedule.time} (${source.timezone})`,
        ]
      : []),
    ...(source.quietStart && source.quietEnd
      ? [`quiet ${source.quietStart}–${source.quietEnd} (${source.timezone})`]
      : []),
  ].join(' · ');

  return (
    <li className="grid gap-3 px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-semibold">{sourceName(source)}</span>
            <Pill tone={status.tone}>{status.label}</Pill>
            {source.pendingItems > 0 && (
              <Pill tone="brand">{numberFormat.format(source.pendingItems)} waiting</Pill>
            )}
          </p>
          <p className="mt-0.5 font-mono text-[12.5px] break-all text-sub">{source.url}</p>
          <p className="mt-1 text-[13px] text-sub">{summary}</p>
          <p className="tabular mt-0.5 text-[12.5px] text-sub">
            Last checked {source.lastCheckedAt ? formatDateTime(source.lastCheckedAt) : 'never'}
            {source.lastDispatchAt && ` · last post ${formatDateTime(source.lastDispatchAt)}`}
            {source.nextCheckAt && ` · next check ${formatDateTime(source.nextCheckAt)}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {writable && (
            <Button
              size="sm"
              variant="ghost"
              loading={check.isPending}
              onClick={() => check.mutate(source.id)}
            >
              Check now
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setOpen('preview')}>
            Preview next post
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen('items')}>
            Posts
          </Button>
          {writable && (
            <>
              <Button size="sm" variant="ghost" onClick={onEdit}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                loading={update.isPending}
                onClick={() =>
                  update.mutate({ status: source.status === 'active' ? 'paused' : 'active' })
                }
              >
                {source.status === 'active' ? 'Pause' : 'Resume'}
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setOpen('delete')}>
                Delete
              </Button>
            </>
          )}
        </div>
      </div>
      {source.lastError && (
        <ErrorNotice
          message={`${source.status === 'disabled' ? 'Turned off after repeated errors. ' : ''}Last check failed: ${source.lastError}${source.failureCount > 1 ? ` (${source.failureCount} times in a row)` : ''}`}
        />
      )}
      <p role="status" className="text-[13px] text-sub empty:hidden">
        {check.error
          ? check.error.message
          : result && !result.error
            ? `${
                result.notModified
                  ? 'Checked: the feed has not changed.'
                  : `Checked: ${result.newItems === 1 ? '1 new item' : `${numberFormat.format(result.newItems)} new items`}${result.dispatchIds.length ? ', 1 post made.' : '.'}`
              }${result.resumeRequired ? ' The feed works again, but this source sends on its own, so it stays turned off until you resume it.' : ''}`
            : ''}
        {update.error?.message}
      </p>
      {open === 'preview' && (
        <PreviewDialog channelId={channel.id} source={source} onClose={() => setOpen(null)} />
      )}
      {open === 'items' && (
        <ItemsDialog channelId={channel.id} source={source} onClose={() => setOpen(null)} />
      )}
      {open === 'delete' && (
        <DeleteDialog channelId={channel.id} source={source} onClose={() => setOpen(null)} />
      )}
    </li>
  );
}

function PreviewDialog({
  channelId,
  source,
  onClose,
}: {
  channelId: string;
  source: FeedSource;
  onClose: () => void;
}) {
  const preview = useQuery(feedPreviewQuery(channelId, source.id));
  return (
    <Dialog
      open
      onClose={onClose}
      title="Next post"
      description={`What ${sourceName(source)} would make next, with its Template and settings.`}
      actions={<Button onClick={onClose}>Done</Button>}
    >
      {preview.isPending && <LoadingRows label="Rendering the preview" rows={2} />}
      {preview.error && <ErrorNotice message={preview.error.message} />}
      {preview.data && (
        <div className="grid gap-3">
          {preview.data.sample && (
            <p className="text-[13px] text-sub">
              No new posts are waiting, so this uses the newest post in the feed.
            </p>
          )}
          <dl className="grid gap-1 text-[13.5px]">
            <dt className="text-[12px] text-sub">Subject</dt>
            <dd className="font-semibold">{preview.data.subject || 'No subject'}</dd>
            {preview.data.preheader && (
              <>
                <dt className="text-[12px] text-sub">Preview text</dt>
                <dd>{preview.data.preheader}</dd>
              </>
            )}
          </dl>
          {/* No scripts, no same-origin access, no forms: the preview can only paint. */}
          <iframe
            title="Post preview"
            sandbox=""
            srcDoc={preview.data.html}
            className="h-80 w-full rounded-[10px] border border-line-app bg-white"
          />
          {preview.data.warnings.length > 0 && (
            <ul className="list-disc pl-5 text-[12.5px] text-sub">
              {preview.data.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  );
}

function ItemsDialog({
  channelId,
  source,
  onClose,
}: {
  channelId: string;
  source: FeedSource;
  onClose: () => void;
}) {
  const items = useQuery(feedItemsQuery(channelId, source.id));
  return (
    <Dialog
      open
      onClose={onClose}
      title="Posts"
      description="The newest 100 posts seen in this feed."
      actions={<Button onClick={onClose}>Done</Button>}
    >
      {items.isPending && <LoadingRows label="Loading posts" rows={3} />}
      {items.error && <ErrorNotice message={items.error.message} />}
      {items.data?.length === 0 && (
        <p className="text-[13.5px] text-sub">Nothing yet. The first check reads the feed.</p>
      )}
      {!!items.data?.length && (
        <ul className="grid max-h-[50vh] gap-2 overflow-y-auto">
          {items.data.map((item) => (
            <li key={item.id} className="grid gap-0.5 text-[13.5px]">
              <span className="font-semibold break-words">{item.title || item.link}</span>
              <span className="flex flex-wrap items-center gap-2 text-[12.5px] text-sub">
                <Pill tone={ITEM_STATUS[item.status].tone}>{ITEM_STATUS[item.status].label}</Pill>
                {item.dispatchId && (
                  <Link
                    to="/dispatches/$dispatchId"
                    params={{ dispatchId: item.dispatchId }}
                    className="text-purple-deep"
                  >
                    Open the post
                  </Link>
                )}
                <span className="tabular">Seen {formatDateTime(item.firstSeenAt)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function DeleteDialog({
  channelId,
  source,
  onClose,
}: {
  channelId: string;
  source: FeedSource;
  onClose: () => void;
}) {
  const remove = useDeleteFeedSource(channelId);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Stop following this feed?"
      description="Its item history goes with it. Posts it already made stay."
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() => remove.mutate(source.id, { onSuccess: onClose })}
          >
            Delete feed
          </Button>
        </>
      }
    >
      {remove.error && <ErrorNotice message={remove.error.message} />}
    </Dialog>
  );
}

/** Add (no source) or edit (with one). */
function FeedSourceForm({
  channel,
  source,
  onClose,
}: {
  channel: Channel;
  source: FeedSource | null;
  onClose: () => void;
}) {
  const { workspace } = useSession();
  const templates = useQuery(templatesQuery(workspace.id, channel.id));
  const senders = useQuery(sendersQuery(channel.id));
  const circles = useQuery(allCirclesQuery(channel.id));
  const create = useCreateFeedSource(channel.id);
  const update = useUpdateFeedSource(channel.id, source?.id ?? '');
  const check = useCheckFeedSource(channel.id);
  const mutation = source ? update : create;
  const error = mutation.error instanceof ApiError ? mutation.error : null;

  const [form, setForm] = useState({
    url: source?.url ?? 'https://',
    name: source?.name ?? '',
    mode: source?.mode ?? 'draft',
    grouping: source?.grouping ?? 'each',
    contentMode: source?.contentMode ?? 'full',
    templateId: source?.templateId ?? '',
    senderIdentityId: source?.senderIdentityId ?? '',
    subjectTemplate: source?.subjectTemplate ?? '',
    intervalMinutes: String(source?.intervalMinutes ?? 60),
    minGapMinutes: String(source?.minGapMinutes ?? 0),
    maxPerDay: String(source?.maxPerDay ?? 3),
    digestLimit: String(source?.digestLimit ?? 10),
    quietStart: source?.quietStart ?? '',
    quietEnd: source?.quietEnd ?? '',
    digestDays: source?.digestSchedule?.weekdays ?? ([] as number[]),
    digestTime: source?.digestSchedule?.time ?? '09:00',
    timezone: source?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
    include: source?.audience.include ?? [],
    // Rosters (flag rosters): the same part as a Dispatch's audience; the panel hides itself
    // while the flag is off and nothing is chosen.
    rosters: source?.audience.rosters,
  });
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const quietIncomplete = !form.quietStart !== !form.quietEnd;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = {
      url: form.url.trim(),
      name: form.name.trim() || null,
      mode: form.mode,
      grouping: form.grouping,
      contentMode: form.contentMode,
      templateId: form.templateId || null,
      senderIdentityId: form.senderIdentityId || null,
      subjectTemplate: form.subjectTemplate.trim() || null,
      intervalMinutes: Number(form.intervalMinutes),
      minGapMinutes: Number(form.minGapMinutes),
      maxPerDay: Number(form.maxPerDay),
      digestLimit: Number(form.digestLimit),
      quietStart: form.quietStart || null,
      quietEnd: form.quietEnd || null,
      digestSchedule:
        form.grouping === 'digest' && form.digestDays.length
          ? { weekdays: form.digestDays, time: form.digestTime }
          : null,
      timezone: form.timezone.trim() || 'UTC',
      audience: {
        include: form.include,
        exclude: source?.audience.exclude ?? [],
        ...(form.rosters ? { rosters: form.rosters } : {}),
      },
    } satisfies CreateFeedSource;
    if (source) update.mutate(input, { onSuccess: onClose });
    else
      create.mutate(input, {
        // The first check reads the feed now and sets the baseline.
        onSuccess: (created) => check.mutate(created.id, { onSettled: onClose }),
      });
  };

  const dispatchTemplates = (templates.data ?? []).filter((t) => t.kind === 'dispatch');

  return (
    <Dialog
      open
      onClose={onClose}
      title={source ? 'Edit feed' : 'Add feed'}
      description="Use the https address of an RSS, Atom or JSON feed. Items already in it are left out; new ones become posts."
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="feed-source-form"
            loading={mutation.isPending || check.isPending}
            disabled={quietIncomplete}
          >
            {source ? 'Save' : 'Add feed'}
          </Button>
        </>
      }
    >
      <form id="feed-source-form" onSubmit={submit} className="grid gap-4">
        <TextField
          label="Feed URL"
          type="url"
          required
          maxLength={2048}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={form.url}
          onChange={(e) => set('url', e.target.value)}
          error={error?.field('url')}
        />
        <TextField
          label="Name"
          maxLength={120}
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          hint="Optional. The feed’s own title is used when empty."
        />
        <SelectField
          label="When a new post appears"
          value={form.mode}
          onChange={(e) => set('mode', e.target.value as 'draft' | 'send')}
          options={[
            { value: 'draft', label: 'Draft a post for me to finish' },
            { value: 'send', label: 'Send it on its own' },
          ]}
          hint={
            form.mode === 'send'
              ? 'It goes out through the usual checklist: sender, domain and audience.'
              : undefined
          }
        />
        <SelectField
          label="Group posts"
          value={form.grouping}
          onChange={(e) => set('grouping', e.target.value as 'each' | 'digest')}
          options={[
            { value: 'each', label: 'One post per feed item' },
            { value: 'digest', label: 'A digest of the new posts' },
          ]}
        />
        <SelectField
          label="Content"
          value={form.contentMode}
          onChange={(e) => set('contentMode', e.target.value as 'full' | 'summary')}
          options={[
            { value: 'full', label: 'The whole post' },
            { value: 'summary', label: 'A summary with a link' },
          ]}
        />
        <SelectField
          label="Template"
          value={form.templateId}
          onChange={(e) => set('templateId', e.target.value)}
          error={error?.field('templateId')}
          options={[
            { value: '', label: 'None' },
            ...dispatchTemplates.map((t) => ({ value: t.id, label: t.name })),
          ]}
          hint="Posts go where the Template has a paragraph reading {{feed.items}}, else after its content."
        />
        <TextField
          label="Subject"
          maxLength={200}
          value={form.subjectTemplate}
          placeholder={
            form.grouping === 'digest' ? '{{feed.title}}: {{count}} new' : '{{item.title}}'
          }
          onChange={(e) => set('subjectTemplate', e.target.value)}
          hint="Can use {{item.title}}, {{feed.title}}, {{count}} and {{date}}."
        />
        <SelectField
          label="Sender"
          value={form.senderIdentityId}
          onChange={(e) => set('senderIdentityId', e.target.value)}
          error={error?.field('senderIdentityId')}
          options={[
            { value: '', label: 'The publication’s default sender' },
            ...(senders.data ?? []).map((s) => ({
              value: s.id,
              label: `${s.fromName} <${s.fromAddress}>`,
            })),
          ]}
        />
        <fieldset className="grid gap-1">
          <legend className="mb-1 text-[13px] font-semibold">Send to</legend>
          <p className="text-[12.5px] text-sub">
            {form.include.length
              ? 'Active subscribers in the ticked segments.'
              : 'Every active subscriber. Tick segments to narrow it.'}
          </p>
          {(circles.data ?? []).map((circle) => (
            <label key={circle.id} className="flex min-h-9 items-center gap-2 text-[13.5px]">
              <input
                type="checkbox"
                className="size-4 shrink-0 accent-purple"
                checked={form.include.includes(circle.id)}
                onChange={(e) =>
                  set(
                    'include',
                    e.target.checked
                      ? [...form.include, circle.id]
                      : form.include.filter((id) => id !== circle.id),
                  )
                }
              />
              {circle.name}
            </label>
          ))}
          {error?.field('audience') && (
            <p className="text-[12.5px] text-danger">{error.field('audience')}</p>
          )}
        </fieldset>
        <RosterAudience
          channelId={channel.id}
          audience={{
            include: form.include,
            exclude: source?.audience.exclude ?? [],
            ...(form.rosters ? { rosters: form.rosters } : {}),
          }}
          disabled={mutation.isPending}
          onChange={(next) => set('rosters', next.rosters)}
        />
        {error?.field('audience.rosters') && (
          <p className="text-[12.5px] text-danger">{error.field('audience.rosters')}</p>
        )}
        <SelectField
          label="Check the feed every"
          value={form.intervalMinutes}
          onChange={(e) => set('intervalMinutes', e.target.value)}
          options={INTERVALS.map((m) => ({ value: String(m), label: minutesLabel(m) }))}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="At most a day"
            type="number"
            min={1}
            max={48}
            required
            value={form.maxPerDay}
            onChange={(e) => set('maxPerDay', e.target.value)}
            error={error?.field('maxPerDay')}
          />
          <TextField
            label="Minutes between posts"
            type="number"
            min={0}
            max={10080}
            required
            value={form.minGapMinutes}
            onChange={(e) => set('minGapMinutes', e.target.value)}
            error={error?.field('minGapMinutes')}
          />
        </div>
        {form.grouping === 'digest' && (
          <TextField
            label="Posts in one digest"
            type="number"
            min={1}
            max={30}
            required
            value={form.digestLimit}
            onChange={(e) => set('digestLimit', e.target.value)}
          />
        )}
        {form.grouping === 'digest' && (
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-[13px] font-semibold">Digest days</legend>
            <p className="text-[12.5px] text-sub">
              Make the digest on these days. Leave them all empty to make one as soon as the limits
              above allow.
            </p>
            <div className="flex flex-wrap gap-2">
              {WEEKDAY_SHORT.map((label, day) => (
                <label key={label} className="flex min-h-8 items-center gap-1.5 text-[13px]">
                  <input
                    type="checkbox"
                    className="size-4 accent-purple"
                    checked={form.digestDays.includes(day)}
                    onChange={(e) =>
                      set(
                        'digestDays',
                        e.target.checked
                          ? [...form.digestDays, day].sort()
                          : form.digestDays.filter((d) => d !== day),
                      )
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
            {form.digestDays.length > 0 && (
              <TextField
                label="At"
                type="time"
                required
                value={form.digestTime}
                onChange={(e) => set('digestTime', e.target.value)}
                error={error?.field('digestSchedule.time')}
                hint={`In ${form.timezone || 'UTC'}. If nothing new is waiting that day, there’s no digest until the next one.`}
              />
            )}
          </fieldset>
        )}
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-[13px] font-semibold">Quiet window</legend>
          <p className="text-[12.5px] text-sub">
            Nothing is sent between these times. Leave both empty to send at any hour.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="From"
              type="time"
              value={form.quietStart}
              onChange={(e) => set('quietStart', e.target.value)}
            />
            <TextField
              label="Until"
              type="time"
              value={form.quietEnd}
              onChange={(e) => set('quietEnd', e.target.value)}
              error={quietIncomplete ? 'Set both times, or neither.' : error?.field('quietEnd')}
            />
          </div>
          <TextField
            label="Time zone"
            maxLength={64}
            value={form.timezone}
            onChange={(e) => set('timezone', e.target.value)}
            error={error?.field('timezone')}
            hint="For the quiet window and {{date}}, e.g. Europe/Prague."
          />
        </fieldset>
        {error && !error.details.length && <ErrorNotice message={error.message} />}
      </form>
    </Dialog>
  );
}
