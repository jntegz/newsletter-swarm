import type { Channel } from '@swarm/domain';
import { Button, EmptyState, ErrorNotice, LoadingRows } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { circlesQuery } from '../api/circles';
import { CirclePill } from '../circles/status';
import * as Icon from '../icons';
import { PageHeader } from './Channels';
import { WithChannel, formatDateTime, numberFormat } from './common';

export function CirclesPage({ channelId }: { channelId: string | undefined }) {
  const navigate = useNavigate();
  return (
    <WithChannel
      channelId={channelId}
      onChange={(id) => void navigate({ to: '/circles', search: { channel: id } })}
    >
      {(channel, picker) => <CircleList key={channel.id} channel={channel} picker={picker} />}
    </WithChannel>
  );
}

function CircleList({ channel, picker }: { channel: Channel; picker: ReactNode }) {
  // A stack of cursors: the first page has none.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1) ?? null;
  const circles = useQuery(circlesQuery(channel.id, cursor));
  const canWrite = channel.role !== 'viewer';

  const create = canWrite && (
    <Link to="/circles/new" search={{ channel: channel.id }} className="btn-primary btn-sm">
      <Icon.Plus size={16} />
      Create a segment
    </Link>
  );

  return (
    <>
      <PageHeader
        title="Segments"
        subtitle={`Groups of ${channel.name} subscribers, kept up to date by rules.`}
        action={
          <div className="flex flex-wrap items-center gap-3">
            {picker}
            {create}
          </div>
        }
      />
      {circles.isPending && <LoadingRows label="Loading segments" />}
      {circles.error && (
        <ErrorNotice
          message={circles.error.message}
          action={
            <Button variant="ghost" onClick={() => void circles.refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {circles.data?.items.length === 0 && cursors.length === 1 && (
        <EmptyState title="No segments yet" action={create}>
          A segment gathers subscribers by rules, such as a tag, a profile field or recent opens.
          Send a post to it, or leave it out of one.
        </EmptyState>
      )}
      {!!circles.data?.items.length && (
        <div className="card-app overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-[13.5px]">
            <thead>
              <tr className="table-head">
                <th scope="col" className="px-5 py-3 font-semibold">
                  Name
                </th>
                <th scope="col" className="px-3 py-3 text-right font-semibold">
                  Subscribers
                </th>
                <th scope="col" className="px-3 py-3 text-right font-semibold">
                  Active
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  Status
                </th>
                <th scope="col" className="px-5 py-3 font-semibold">
                  Last evaluated
                </th>
              </tr>
            </thead>
            <tbody>
              {circles.data.items.map((circle) => (
                <tr key={circle.id} className="border-t border-line hover:bg-surface-alt">
                  <td className="px-5 py-3.5">
                    <Link
                      to="/circles/$circleId"
                      params={{ circleId: circle.id }}
                      className="font-semibold text-ink no-underline hover:underline"
                    >
                      {circle.name}
                    </Link>
                    {circle.description && (
                      <p className="mt-0.5 line-clamp-1 text-[12.5px] text-sub">
                        {circle.description}
                      </p>
                    )}
                  </td>
                  <td className="tabular px-3 py-3.5 text-right">
                    {numberFormat.format(circle.memberCount)}
                  </td>
                  <td className="tabular px-3 py-3.5 text-right">
                    {numberFormat.format(circle.activeCount)}
                  </td>
                  <td className="px-3 py-3.5">
                    <CirclePill status={circle.status} />
                    {circle.status === 'failed' && circle.error && (
                      <p className="mt-1 max-w-[32ch] text-[12px] text-danger">{circle.error}</p>
                    )}
                  </td>
                  <td className="tabular px-5 py-3.5 text-sub">
                    {formatDateTime(circle.evaluatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(cursors.length > 1 || circles.data?.nextCursor) && (
        <div className="mt-4 flex justify-end gap-2">
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
            disabled={!circles.data?.nextCursor}
            onClick={() => {
              const next = circles.data?.nextCursor;
              if (next) setCursors((list) => [...list, next]);
            }}
          >
            Next
          </Button>
        </div>
      )}
    </>
  );
}
