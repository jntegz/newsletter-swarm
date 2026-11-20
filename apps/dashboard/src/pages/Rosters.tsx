// Members → Rosters (flag rosters): opt-in lists inside a Channel. Members join them through
// Capture Forms, the Member Center, imports or a teammate, and Dispatches can go to chosen
// Rosters only (the audience panel). docs/rosters.md.
import type { Channel, Roster, RosterStatus } from '@swarm/domain';
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
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { useChannelFlag } from '../api/queries';
import {
  rosterMembersQuery,
  rostersQuery,
  useCreateRoster,
  useDeleteRoster,
  useUpdateRoster,
} from '../api/rosters';
import * as Icon from '../icons';
import { PageHeader } from './Channels';
import { WithChannel, formatDateTime, numberFormat } from './common';

export function RostersPage({ channelId }: { channelId: string | undefined }) {
  const navigate = useNavigate();
  return (
    <WithChannel
      channelId={channelId}
      onChange={(id) => void navigate({ to: '/rosters', search: { channel: id } })}
    >
      {(channel, picker) => <RosterList key={channel.id} channel={channel} picker={picker} />}
    </WithChannel>
  );
}

function RosterList({ channel, picker }: { channel: Channel; picker: ReactNode }) {
  const flag = useChannelFlag(channel.id, 'rosters');
  // Without the flags, ask the server anyway: it answers feature_disabled when they are off.
  const rosters = useQuery(rostersQuery(channel.id, flag !== false && flag !== undefined));
  const canEdit = channel.role !== 'viewer' && channel.role !== 'author';
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Roster | null>(null);
  const [deleting, setDeleting] = useState<Roster | null>(null);
  const [viewing, setViewing] = useState<Roster | null>(null);
  const off =
    flag === false ||
    (rosters.error instanceof ApiError && rosters.error.code === 'feature_disabled');

  const create = canEdit && !off && (
    <Button size="sm" onClick={() => setCreating(true)}>
      <Icon.Plus size={16} />
      Create a Roster
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Rosters"
        subtitle={`Lists inside ${channel.name} that subscribers choose to be on.`}
        action={
          <div className="flex flex-wrap items-center gap-3">
            {picker}
            {create}
          </div>
        }
      />
      {off ? (
        <EmptyState title="Rosters are not turned on">
          Ask a workspace owner if you’d like to use them for {channel.name}.
        </EmptyState>
      ) : rosters.isPending ? (
        <LoadingRows label="Loading Rosters" />
      ) : rosters.error ? (
        <ErrorNotice
          message={rosters.error.message}
          action={
            <Button variant="ghost" onClick={() => void rosters.refetch()}>
              Try again
            </Button>
          }
        />
      ) : rosters.data.length === 0 ? (
        <EmptyState title="No Rosters yet" action={create}>
          A Roster is a list subscribers opt into, like “Weekly deals” or “Events”. Signup forms and
          Subscriber settings add people to it, and a post can go to its subscribers only.
        </EmptyState>
      ) : (
        <div className="card-app overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-[13.5px]">
            <thead>
              <tr className="table-head">
                <th scope="col" className="px-5 py-3 font-semibold">
                  Name
                </th>
                <th scope="col" className="px-3 py-3 text-right font-semibold">
                  Active
                </th>
                <th scope="col" className="px-3 py-3 text-right font-semibold">
                  Subscribed
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  Subscriber settings
                </th>
                <th scope="col" className="px-5 py-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rosters.data.map((roster) => (
                <tr key={roster.id} className="border-t border-line hover:bg-surface-alt">
                  <td className="px-5 py-3.5">
                    <button
                      type="button"
                      className="cursor-pointer text-left font-semibold text-ink hover:underline focus-visible:outline-2 focus-visible:outline-purple"
                      onClick={() => setViewing(roster)}
                    >
                      {roster.name}
                    </button>
                    {roster.description && (
                      <p className="mt-0.5 line-clamp-1 text-[12.5px] text-sub">
                        {roster.description}
                      </p>
                    )}
                  </td>
                  <td className="tabular px-3 py-3.5 text-right">
                    {numberFormat.format(roster.activeCount)}
                  </td>
                  <td className="tabular px-3 py-3.5 text-right text-sub">
                    {numberFormat.format(roster.subscribedCount)}
                  </td>
                  <td className="px-3 py-3.5">
                    <Pill tone={roster.memberCenter ? 'success' : 'neutral'}>
                      {roster.memberCenter ? 'Listed' : 'Hidden'}
                    </Pill>
                  </td>
                  <td className="px-5 py-3.5 text-right whitespace-nowrap">
                    {canEdit && (
                      <span className="inline-flex gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setEditing(roster)}>
                          Edit<span className="sr-only"> {roster.name}</span>
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setDeleting(roster)}>
                          Delete<span className="sr-only"> {roster.name}</span>
                        </Button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <RosterDialog channelId={channel.id} onClose={() => setCreating(false)} />}
      {editing && (
        <RosterDialog
          key={editing.id}
          channelId={channel.id}
          roster={editing}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <DeleteRosterDialog
          channelId={channel.id}
          roster={deleting}
          onClose={() => setDeleting(null)}
        />
      )}
      {viewing && (
        <RosterMembersDialog
          channelId={channel.id}
          roster={viewing}
          onClose={() => setViewing(null)}
        />
      )}
    </>
  );
}

function RosterDialog({
  channelId,
  roster,
  onClose,
}: {
  channelId: string;
  roster?: Roster;
  onClose: () => void;
}) {
  const create = useCreateRoster(channelId);
  const update = useUpdateRoster(channelId, roster?.id ?? '');
  const save = roster ? update : create;
  const [name, setName] = useState(roster?.name ?? '');
  const [description, setDescription] = useState(roster?.description ?? '');
  const [memberCenter, setMemberCenter] = useState(roster?.memberCenter ?? true);
  const error = save.error instanceof ApiError ? save.error : null;
  const formId = roster ? `roster-${roster.id}` : 'create-roster';
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = { name: name.trim(), description: description.trim() || null, memberCenter };
    if (roster) update.mutate(input, { onSuccess: onClose });
    else create.mutate(input, { onSuccess: onClose });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={roster ? 'Edit Roster' : 'Create a Roster'}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={save.isPending}>
            {roster ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <form id={formId} className="grid gap-4" onSubmit={submit}>
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
          hint="Subscribers see it in Subscriber settings."
          rows={2}
          maxLength={500}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <label className="flex min-h-9 items-center gap-2 text-[13.5px]">
          <input
            type="checkbox"
            className="size-4 accent-purple"
            checked={memberCenter}
            onChange={(e) => setMemberCenter(e.target.checked)}
          />
          List it in Subscriber settings, so subscribers can join and leave it
        </label>
        {error && !error.details.length && <ErrorNotice message={error.message} />}
      </form>
    </Dialog>
  );
}

function DeleteRosterDialog({
  channelId,
  roster,
  onClose,
}: {
  channelId: string;
  roster: Roster;
  onClose: () => void;
}) {
  const remove = useDeleteRoster(channelId, roster.id);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Delete “${roster.name}”?`}
      description="Subscribers stay in the publication. A send already going out finishes; posts that name this Roster need their audience chosen again."
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() => remove.mutate(undefined, { onSuccess: onClose })}
          >
            Delete Roster
          </Button>
        </>
      }
    >
      {remove.error && <ErrorNotice message={remove.error.message} />}
    </Dialog>
  );
}

const STATUS_LABEL: Record<RosterStatus, string> = {
  subscribed: 'Subscribed',
  unsubscribed: 'Left',
};

function RosterMembersDialog({
  channelId,
  roster,
  onClose,
}: {
  channelId: string;
  roster: Roster;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<RosterStatus | 'all'>('subscribed');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1) ?? null;
  const members = useQuery(rosterMembersQuery(channelId, roster.id, status, cursor));
  return (
    <Dialog
      open
      onClose={onClose}
      title={roster.name}
      description={`${numberFormat.format(roster.subscribedCount)} subscribed, ${numberFormat.format(roster.activeCount)} of them active.`}
      actions={
        <>
          <Button
            variant="ghost"
            size="sm"
            disabled={cursors.length === 1}
            onClick={() => setCursors((list) => list.slice(0, -1))}
          >
            Previous
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!members.data?.nextCursor}
            onClick={() => {
              const next = members.data?.nextCursor;
              if (next) setCursors((list) => [...list, next]);
            }}
          >
            Next
          </Button>
          <Button onClick={onClose}>Done</Button>
        </>
      }
    >
      <div className="grid gap-3">
        <label className="flex items-center gap-2 text-[13px]">
          <span className="text-sub">Show</span>
          <select
            className="h-9 rounded-control border border-line-control bg-surface px-3 text-[13px] text-ink hover:border-line-control-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-purple"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as RosterStatus | 'all');
              setCursors([null]);
            }}
          >
            <option value="subscribed">Subscribed</option>
            <option value="unsubscribed">Left</option>
            <option value="all">Everyone who joined</option>
          </select>
        </label>
        {members.isPending && <LoadingRows label="Loading subscribers" rows={3} />}
        {members.error && <ErrorNotice message={members.error.message} />}
        {members.data?.items.length === 0 && (
          <p className="text-[13px] text-sub">Nobody here yet.</p>
        )}
        {!!members.data?.items.length && (
          <ul className="grid max-h-72 gap-1 overflow-y-auto">
            {members.data.items.map((m) => (
              <li key={m.memberId} className="flex items-center gap-2 text-[13px]">
                <span className="min-w-0 flex-1 truncate">{m.email}</span>
                <span className="text-sub">{STATUS_LABEL[m.status]}</span>
                <span className="tabular text-[12px] text-sub">{formatDateTime(m.updatedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
