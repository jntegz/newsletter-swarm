// One webhook endpoint: its settings and actions (edit, send a test event, pause or resume,
// rotate the secret, delete), the delivery log with filters and paging, and the delivery drawer
// (payload, headers, response, attempts) with Redrive.
import {
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_EVENTS,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookEventType,
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
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { channelsQuery } from '../api/queries';
import {
  useConfirmWebhook,
  useDeleteWebhook,
  useRedriveDelivery,
  useRedriveFailed,
  useRotateWebhookSecret,
  useSendTestWebhook,
  useUpdateWebhook,
  webhookDeliveriesQuery,
  webhookDeliveryQuery,
  webhookEndpointQuery,
  type DeliveryFilter,
} from '../api/webhooks';
import * as Icon from '../icons';
import { useSession } from '../session';
import { formatDateTime, numberFormat } from './common';
import { SUSPENSION_TEXT, confirmable } from './feed-suspension';
import { formError, useStepUp } from './StepUp';
import {
  AdminsOnly,
  DELIVERY_STATUS,
  ENDPOINT_STATUS,
  EVENT_LABEL,
  EndpointDialog,
  SecretDialog,
} from './Webhooks';

export function WebhookEndpointPage({ endpointId }: { endpointId: string }) {
  const { workspace, can } = useSession();
  const endpoint = useQuery({
    ...webhookEndpointQuery(workspace.id, endpointId),
    enabled: can('admin'),
  });

  if (!can('admin')) return <AdminsOnly />;
  return (
    <div className="grid gap-5">
      <Link
        to="/settings/developers/webhooks"
        className="inline-flex w-fit items-center gap-1 text-[13px] text-sub no-underline hover:text-ink"
      >
        <span aria-hidden="true">←</span> All endpoints
      </Link>
      {endpoint.isPending && <LoadingRows label="Loading endpoint" rows={3} />}
      {endpoint.error && (
        <ErrorNotice
          message={
            endpoint.error instanceof ApiError && endpoint.error.code === 'not_found'
              ? 'This endpoint doesn’t exist any more.'
              : endpoint.error.message
          }
        />
      )}
      {endpoint.data && (
        <>
          <EndpointSummary endpoint={endpoint.data} />
          <DeliveryLog endpoint={endpoint.data} />
        </>
      )}
    </div>
  );
}

function EndpointSummary({ endpoint }: { endpoint: WebhookEndpoint }) {
  const { workspace } = useSession();
  const navigate = useNavigate();
  const channels = useQuery(channelsQuery(workspace.id));
  const update = useUpdateWebhook(workspace.id, endpoint.id);
  const rotate = useRotateWebhookSecret(workspace.id, endpoint.id);
  const remove = useDeleteWebhook(workspace.id);
  const test = useSendTestWebhook(workspace.id, endpoint.id);
  const adopt = useConfirmWebhook(workspace.id, endpoint.id);
  const { guard, dialog: stepUp } = useStepUp();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<'rotate' | 'delete' | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [testType, setTestType] = useState<WebhookEventType>(
    endpoint.events[0] ?? 'member.created',
  );
  const [notice, setNotice] = useState('');
  const failure = formError([update, rotate, remove, test, adopt].find((m) => m.error)?.error);

  const channel = endpoint.channelId
    ? (channels.data?.find((c) => c.id === endpoint.channelId)?.name ?? 'A deleted publication')
    : 'All publications';
  const status = ENDPOINT_STATUS[endpoint.status];

  return (
    <section aria-labelledby="endpoint-title" className="card-app grid gap-4 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            id="endpoint-title"
            className="font-mono text-[15px] font-semibold break-all tracking-[-0.01em]"
          >
            {endpoint.url}
          </h2>
          {endpoint.description && (
            <p className="mt-1 text-[13px] text-sub">{endpoint.description}</p>
          )}
        </div>
        <Pill tone={status.tone}>{status.label}</Pill>
      </div>

      {endpoint.suspendedReason && (
        <div
          role="note"
          className="flex flex-wrap items-center gap-3 rounded-card-app border border-line-app bg-danger-soft p-3 text-[13px] leading-[1.5] text-danger"
        >
          <span className="flex-1">
            <b>Suspended.</b> {SUSPENSION_TEXT[endpoint.suspendedReason]}
          </span>
          {confirmable(endpoint.suspendedReason) && (
            <Button
              variant="ghost"
              loading={adopt.isPending}
              onClick={() =>
                void guard(async () => {
                  await adopt.mutateAsync();
                  setNotice('Endpoint confirmed. It runs on your authority now.');
                }).catch(() => {
                  // Shown from the mutation's error.
                })
              }
            >
              Confirm
            </Button>
          )}
          {stepUp}
        </div>
      )}

      {endpoint.status === 'disabled' && (
        <div
          role="note"
          className="rounded-card-app border border-line-app bg-danger-soft p-3 text-[13px] leading-[1.5] text-danger"
        >
          <b>Nothing is being sent.</b> {endpoint.disabledReason ?? 'Deliveries kept failing.'} Fix
          the endpoint, resume it, then redrive what failed.
        </div>
      )}

      <dl className="grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-[max-content_1fr]">
        <dt className="text-sub">Publication</dt>
        <dd>{channel}</dd>
        <dt className="text-sub">Events</dt>
        <dd className="flex flex-wrap gap-1.5">
          {endpoint.events.map((type) => (
            <code
              key={type}
              className="rounded-[6px] bg-surface-alt px-1.5 py-0.5 font-mono text-[12px]"
            >
              {type}
            </code>
          ))}
        </dd>
        <dt className="text-sub">Failures in a row</dt>
        <dd className="tabular">
          {numberFormat.format(endpoint.failureCount)}
          {endpoint.firstFailureAt && ` since ${formatDateTime(endpoint.firstFailureAt)}`}
        </dd>
        {endpoint.previousSecretExpiresAt && (
          <>
            <dt className="text-sub">Previous secret</dt>
            <dd>Still signs until {formatDateTime(endpoint.previousSecretExpiresAt)}</dd>
          </>
        )}
        <dt className="text-sub">Added</dt>
        <dd className="tabular">{formatDateTime(endpoint.createdAt)}</dd>
      </dl>

      <div className="flex flex-wrap items-end gap-2 border-t border-line pt-4">
        <div className="w-full sm:w-[260px]">
          <SelectField
            label="Test event"
            value={testType}
            onChange={(e) => setTestType(e.target.value as WebhookEventType)}
            options={WEBHOOK_EVENTS.map((type) => ({ value: type, label: type }))}
          />
        </div>
        <Button
          variant="ghost"
          loading={test.isPending}
          onClick={() =>
            test.mutate(testType, {
              onSuccess: () => setNotice('Test event queued. It appears in the log below.'),
            })
          }
        >
          Send test event
        </Button>
        <span className="flex-1" />
        <Button variant="ghost" onClick={() => setEditing(true)}>
          Edit
        </Button>
        <Button
          variant="ghost"
          loading={update.isPending}
          onClick={() =>
            update.mutate(
              { status: endpoint.status === 'active' ? 'paused' : 'active' },
              {
                onSuccess: (next) =>
                  setNotice(next.status === 'active' ? 'Endpoint resumed.' : 'Endpoint paused.'),
              },
            )
          }
        >
          {endpoint.status === 'active' ? 'Pause' : 'Resume'}
        </Button>
        <Button variant="ghost" onClick={() => setConfirm('rotate')}>
          Rotate secret
        </Button>
        <Button variant="danger" onClick={() => setConfirm('delete')}>
          Delete
        </Button>
      </div>
      <p role="status" className="text-[13px] text-success empty:hidden">
        {notice}
      </p>
      {failure && <ErrorNotice message={failure.message} />}

      <EndpointDialog open={editing} endpoint={endpoint} onClose={() => setEditing(false)} />
      <SecretDialog secret={secret} onClose={() => setSecret(null)} />
      <Dialog
        open={confirm === 'rotate'}
        onClose={() => setConfirm(null)}
        title="Rotate the signing secret?"
        description="You get a new secret now. For 24 hours requests are signed with both, so you can deploy the new one without missing events."
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              loading={rotate.isPending}
              onClick={() =>
                rotate.mutate(undefined, {
                  onSuccess: (rotated) => {
                    setConfirm(null);
                    setSecret(rotated.secret);
                  },
                })
              }
            >
              Rotate secret
            </Button>
          </>
        }
      />
      <Dialog
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        title="Delete this endpoint?"
        description="Nothing more is sent to it, and its delivery log is deleted with it."
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(endpoint.id, {
                  onSuccess: () => void navigate({ to: '/settings/developers/webhooks' }),
                })
              }
            >
              Delete endpoint
            </Button>
          </>
        }
      />
    </section>
  );
}

const ALL_FILTER: DeliveryFilter = { status: '', eventType: '' };

function DeliveryLog({ endpoint }: { endpoint: WebhookEndpoint }) {
  const { workspace } = useSession();
  const [filter, setFilter] = useState<DeliveryFilter>(ALL_FILTER);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const log = useQuery(webhookDeliveriesQuery(workspace.id, endpoint.id, filter, cursor));
  const [open, setOpen] = useState<string | null>(null);
  const [redriving, setRedriving] = useState(false);
  const unfiltered = !filter.status && !filter.eventType;

  const changeFilter = (next: Partial<DeliveryFilter>) => {
    setFilter((current) => ({ ...current, ...next }));
    setCursors([null]);
  };

  return (
    <section aria-labelledby="log-title" className="card-app overflow-x-auto">
      <div className="flex flex-wrap items-end justify-between gap-3 px-5 pt-5">
        <div>
          <h2 id="log-title" className="text-[16px] font-semibold">
            Delivery log
          </h2>
          <p className="text-[13px] text-sub">Newest first. Kept for 30 days.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-[150px]">
            <SelectField
              label="Status"
              value={filter.status}
              onChange={(e) => changeFilter({ status: e.target.value as DeliveryFilter['status'] })}
              options={[
                { value: '', label: 'Any status' },
                ...WEBHOOK_DELIVERY_STATUSES.map((s) => ({
                  value: s,
                  label: DELIVERY_STATUS[s].label,
                })),
              ]}
            />
          </div>
          <div className="w-[210px]">
            <SelectField
              label="Event"
              value={filter.eventType}
              onChange={(e) =>
                changeFilter({ eventType: e.target.value as DeliveryFilter['eventType'] })
              }
              options={[
                { value: '', label: 'Any event' },
                ...WEBHOOK_EVENTS.map((type) => ({ value: type, label: type })),
              ]}
            />
          </div>
          <Button
            variant="ghost"
            disabled={endpoint.status !== 'active'}
            title={endpoint.status !== 'active' ? 'Resume the endpoint first' : undefined}
            onClick={() => setRedriving(true)}
          >
            Redrive failed
          </Button>
        </div>
      </div>

      {log.isPending && (
        <div className="p-5">
          <LoadingRows label="Loading deliveries" rows={5} />
        </div>
      )}
      {log.error && (
        <div className="p-5">
          <ErrorNotice message={log.error.message} />
        </div>
      )}
      {log.data && log.data.items.length === 0 && (
        <div className="p-5">
          <EmptyState title={unfiltered ? 'No deliveries yet' : 'No matching deliveries'}>
            {unfiltered
              ? 'Send a test event, or wait for the next event that this endpoint listens to.'
              : 'Try another status or event.'}
          </EmptyState>
        </div>
      )}
      {log.data && log.data.items.length > 0 && (
        <table className="mt-4 w-full text-left text-[13.5px]">
          <thead>
            <tr className="table-head">
              <th scope="col" className="px-5 py-2.5 font-semibold">
                Event
              </th>
              <th scope="col" className="px-3 py-2.5 font-semibold">
                Status
              </th>
              <th scope="col" className="px-3 py-2.5 font-semibold max-sm:hidden">
                Response
              </th>
              <th scope="col" className="px-3 py-2.5 font-semibold max-sm:hidden">
                Latency
              </th>
              <th scope="col" className="px-5 py-2.5 font-semibold">
                Time
              </th>
            </tr>
          </thead>
          <tbody>
            {log.data.items.map((delivery) => (
              <tr key={delivery.id} className="border-t border-line">
                <td className="px-5 py-2.5">
                  <button
                    type="button"
                    onClick={() => setOpen(delivery.id)}
                    className="min-h-10 text-left font-mono text-[12.5px] font-semibold text-ink hover:text-purple-deep"
                  >
                    {delivery.eventType}
                    {delivery.test && (
                      <span className="ml-2 font-sans text-[11.5px] font-normal text-sub">
                        test
                      </span>
                    )}
                  </button>
                </td>
                <td className="px-3 py-2.5">
                  <DeliveryPill delivery={delivery} />
                </td>
                <td className="tabular px-3 py-2.5 text-sub max-sm:hidden">
                  {delivery.responseStatus ?? '—'}
                </td>
                <td className="tabular px-3 py-2.5 text-sub max-sm:hidden">
                  {delivery.latencyMs === null
                    ? '—'
                    : `${numberFormat.format(delivery.latencyMs)} ms`}
                </td>
                <td className="tabular px-5 py-2.5 whitespace-nowrap text-sub">
                  {formatDateTime(delivery.lastAttemptAt ?? delivery.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex justify-between gap-2 p-4">
        <Button
          variant="ghost"
          disabled={cursors.length < 2}
          onClick={() => setCursors((c) => c.slice(0, -1))}
        >
          Newer
        </Button>
        <Button
          variant="ghost"
          disabled={!log.data?.nextCursor}
          onClick={() => log.data?.nextCursor && setCursors((c) => [...c, log.data.nextCursor])}
        >
          Older
        </Button>
      </div>

      <DeliveryDrawer endpoint={endpoint} deliveryId={open} onClose={() => setOpen(null)} />
      {redriving && <RedriveFailedDialog endpoint={endpoint} onClose={() => setRedriving(false)} />}
    </section>
  );
}

function DeliveryPill({ delivery }: { delivery: WebhookDelivery }) {
  const status = DELIVERY_STATUS[delivery.status];
  return <Pill tone={status.tone}>{status.label}</Pill>;
}

function RedriveFailedDialog({
  endpoint,
  onClose,
}: {
  endpoint: WebhookEndpoint;
  onClose: () => void;
}) {
  const { workspace } = useSession();
  const redrive = useRedriveFailed(workspace.id, endpoint.id);
  const [since, setSince] = useState(() => localInput(Date.now() - 24 * 3_600_000));
  const [done, setDone] = useState<number | null>(null);
  const error = redrive.error instanceof ApiError ? redrive.error : null;
  return (
    <Dialog
      open
      onClose={onClose}
      title="Redrive failed deliveries"
      description="Failed and canceled deliveries since this time are sent again with the same event ids, up to 1,000 at a time."
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {done === null ? 'Cancel' : 'Close'}
          </Button>
          {done === null && (
            <Button
              loading={redrive.isPending}
              disabled={!since}
              onClick={() =>
                redrive.mutate(new Date(since).toISOString(), {
                  onSuccess: (result) => setDone(result.redriven),
                })
              }
            >
              Redrive
            </Button>
          )}
        </>
      }
    >
      <div className="grid gap-3">
        <TextField
          label="Since"
          type="datetime-local"
          required
          value={since}
          onChange={(e) => setSince(e.target.value)}
          error={error?.field('since')}
        />
        <p role="status" className="text-[13px] text-success empty:hidden">
          {done === null
            ? ''
            : done === 0
              ? 'Nothing to redrive since then.'
              : `${numberFormat.format(done)} deliveries queued.`}
        </p>
        {error && !error.details.length && <ErrorNotice message={error.message} />}
      </div>
    </Dialog>
  );
}

/** A value for <input type="datetime-local"> in the browser's time zone. */
function localInput(ms: number): string {
  const date = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

function DeliveryDrawer({
  endpoint,
  deliveryId,
  onClose,
}: {
  endpoint: WebhookEndpoint;
  deliveryId: string | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const open = deliveryId !== null;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className="fixed inset-y-0 right-0 left-auto m-0 h-full max-h-none w-[min(600px,100vw)] max-w-none overflow-y-auto border-0 border-l border-line-app bg-surface p-0 text-ink shadow-card backdrop:bg-[rgba(15,15,18,0.32)]"
    >
      {deliveryId && (
        <DeliveryDetail
          endpoint={endpoint}
          deliveryId={deliveryId}
          titleId={titleId}
          onClose={onClose}
        />
      )}
    </dialog>
  );
}

function DeliveryDetail({
  endpoint,
  deliveryId,
  titleId,
  onClose,
}: {
  endpoint: WebhookEndpoint;
  deliveryId: string;
  titleId: string;
  onClose: () => void;
}) {
  const { workspace } = useSession();
  const detail = useQuery(webhookDeliveryQuery(workspace.id, endpoint.id, deliveryId));
  const redrive = useRedriveDelivery(workspace.id, endpoint.id);
  const [notice, setNotice] = useState('');
  const d = detail.data;
  const waiting = d?.status === 'pending' || d?.status === 'retrying';
  const blocked = d && !d.test && endpoint.status !== 'active';

  return (
    <div className="grid gap-5 p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={titleId} className="font-mono text-[16px] font-semibold break-all">
            {d?.eventType ?? 'Delivery'}
          </h2>
          {d && <p className="mt-0.5 text-[13px] text-sub">{EVENT_LABEL[d.eventType]}</p>}
        </div>
        <Button variant="quiet" size="sm" aria-label="Close" onClick={onClose}>
          <Icon.Close size={16} />
        </Button>
      </div>
      {detail.isPending && <LoadingRows label="Loading delivery" rows={4} />}
      {detail.error && <ErrorNotice message={detail.error.message} />}
      {d && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <DeliveryPill delivery={d} />
            {d.test && <Pill tone="brand">Test event</Pill>}
            <span className="flex-1" />
            <Button
              loading={redrive.isPending}
              disabled={waiting || !!blocked}
              title={
                waiting
                  ? 'Already waiting to be sent'
                  : blocked
                    ? 'Resume the endpoint first'
                    : undefined
              }
              onClick={() =>
                redrive.mutate(d.id, {
                  onSuccess: () => {
                    setNotice('Queued to be sent again with the same event id.');
                    void detail.refetch();
                  },
                })
              }
            >
              Redrive
            </Button>
          </div>
          <p role="status" className="text-[13px] text-success empty:hidden">
            {notice}
          </p>
          {redrive.error && <ErrorNotice message={redrive.error.message} />}
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-[13px]">
            <dt className="text-sub">Event id</dt>
            <dd className="font-mono text-[12.5px] break-all">{d.eventId}</dd>
            <dt className="text-sub">Attempts</dt>
            <dd className="tabular">{numberFormat.format(d.attempts)}</dd>
            {d.nextAttemptAt && (
              <>
                <dt className="text-sub">Next attempt</dt>
                <dd className="tabular">{formatDateTime(d.nextAttemptAt)}</dd>
              </>
            )}
            <dt className="text-sub">Response</dt>
            <dd className="tabular">
              {d.responseStatus ?? '—'}
              {d.latencyMs !== null && ` · ${numberFormat.format(d.latencyMs)} ms`}
            </dd>
            <dt className="text-sub">Created</dt>
            <dd className="tabular">{formatDateTime(d.createdAt)}</dd>
          </dl>
          {d.error && <ErrorNotice message={d.error} />}
          <Block title="Payload">
            <Code>{JSON.stringify(d.payload, null, 2)}</Code>
          </Block>
          <Block title="Request headers">
            <Code>
              {Object.entries(d.requestHeaders)
                .map(([name, value]) => `${name}: ${value}`)
                .join('\n')}
            </Code>
            <p className="mt-1 text-[12px] text-sub">
              The signature’s values aren’t shown. Each attempt is signed with a new timestamp.
            </p>
          </Block>
          <Block title="Response">
            {d.responseExcerpt ? (
              <Code>{d.responseExcerpt}</Code>
            ) : (
              <p className="text-[13px] text-sub">No response body.</p>
            )}
          </Block>
          <Block title="Attempts">
            {d.attemptLog.length === 0 ? (
              <p className="text-[13px] text-sub">Not attempted yet.</p>
            ) : (
              <ol className="divide-y divide-line rounded-card-app border border-line-app">
                {d.attemptLog.map((a) => (
                  <li key={a.attempt} className="grid gap-0.5 px-3 py-2 text-[13px]">
                    <span className="flex flex-wrap gap-x-3">
                      <b className="tabular">#{a.attempt}</b>
                      <span className="tabular text-sub">{formatDateTime(a.startedAt)}</span>
                      <span className="tabular">
                        {a.responseStatus ?? 'No response'}
                        {a.latencyMs !== null && ` · ${numberFormat.format(a.latencyMs)} ms`}
                      </span>
                    </span>
                    {a.error && <span className="text-[12.5px] text-danger">{a.error}</span>}
                  </li>
                ))}
              </ol>
            )}
          </Block>
        </>
      )}
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-1.5 text-[13px] font-semibold">{title}</h3>
      {children}
    </div>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-card-app border border-line-app bg-surface-alt p-3 font-mono text-[12px] leading-[1.6] break-all whitespace-pre-wrap">
      <code>{children}</code>
    </pre>
  );
}
