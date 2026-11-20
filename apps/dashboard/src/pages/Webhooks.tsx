// Settings → Developers → Webhooks: the endpoint list, the add and edit dialog with the grouped
// event checklist and Channel filter, and the show-once secret. Endpoint detail and the delivery
// log are in WebhookEndpoint.tsx. Admins and owners only (the API refuses everyone else).
import {
  WEBHOOK_EVENTS,
  WEBHOOK_EVENT_GROUPS,
  type WebhookDeliveryStatus,
  type WebhookEndpoint,
  type WebhookEndpointStatus,
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
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import { channelsQuery } from '../api/queries';
import { useCreateWebhook, useUpdateWebhook, webhookEndpointsQuery } from '../api/webhooks';
import * as Icon from '../icons';
import { useSession } from '../session';
import { formatDateTime } from './common';
import { formError, useStepUp } from './StepUp';

export const EVENT_LABEL: Record<WebhookEventType, string> = {
  'member.created': 'A subscriber was added',
  'member.confirmed': 'A subscriber confirmed',
  'member.updated': 'A subscriber changed',
  'member.unsubscribed': 'A subscriber unsubscribed',
  'member.deleted': 'A subscriber was deleted',
  'level.purchased': 'Paid access started',
  'level.canceled': 'Paid access ended',
  'dispatch.scheduled': 'A post was scheduled',
  'dispatch.sent': 'A post was sent',
  'broadcast.completed': 'A send finished',
  'ask.response': 'A poll or survey was answered',
  'flow.completed': 'An automation run completed',
  'capture_form.submitted': 'A signup form was submitted',
  'roster.subscribed': 'A subscriber joined a roster',
  'roster.unsubscribed': 'A subscriber left a roster',
  'good.purchased': 'A product was bought',
  'good.refunded': 'A product order was refunded',
};

export const ENDPOINT_STATUS: Record<
  WebhookEndpointStatus,
  { label: string; tone: 'success' | 'neutral' | 'danger' }
> = {
  active: { label: 'Active', tone: 'success' },
  paused: { label: 'Paused', tone: 'neutral' },
  disabled: { label: 'Turned off', tone: 'danger' },
};

export const DELIVERY_STATUS: Record<
  WebhookDeliveryStatus,
  { label: string; tone: 'success' | 'neutral' | 'danger' | 'scheduled' }
> = {
  pending: { label: 'Pending', tone: 'neutral' },
  retrying: { label: 'Retrying', tone: 'scheduled' },
  succeeded: { label: 'Delivered', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  canceled: { label: 'Canceled', tone: 'neutral' },
};

export function AdminsOnly() {
  return (
    <EmptyState title="Admins only">
      Ask an owner or admin if you need to manage webhooks.
    </EmptyState>
  );
}

export function WebhooksSettings() {
  const { workspace, can } = useSession();
  const endpoints = useQuery({ ...webhookEndpointsQuery(workspace.id), enabled: can('admin') });
  const channels = useQuery({ ...channelsQuery(workspace.id), enabled: can('admin') });
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);

  if (!can('admin')) return <AdminsOnly />;
  const channelName = (id: string | null) =>
    id
      ? (channels.data?.find((c) => c.id === id)?.name ?? 'A deleted publication')
      : 'All publications';

  return (
    <section aria-labelledby="webhooks-title" className="card-app overflow-x-auto">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
        <div>
          <h2 id="webhooks-title" className="text-[16px] font-semibold">
            Webhooks
          </h2>
          <p className="max-w-[560px] text-[13px] leading-[1.5] text-sub">
            Swarm sends a signed request to these URLs when something happens in this workspace.
            Every delivery is logged, and failed ones can be sent again.
          </p>
        </div>
        <Button icon={<Icon.Plus size={15} />} onClick={() => setAdding(true)}>
          Add endpoint
        </Button>
      </div>

      {endpoints.isPending && (
        <div className="p-5">
          <LoadingRows label="Loading webhook endpoints" rows={3} />
        </div>
      )}
      {endpoints.error && (
        <div className="p-5">
          <ErrorNotice message={endpoints.error.message} />
        </div>
      )}
      {endpoints.data && endpoints.data.length === 0 && (
        <div className="p-5">
          <EmptyState title="No endpoints yet">
            Add the URL of a server that should hear about new subscribers, sent posts and more.
          </EmptyState>
        </div>
      )}
      {endpoints.data && endpoints.data.length > 0 && (
        <>
          <ul className="mt-4 divide-y divide-line border-t border-line sm:hidden">
            {endpoints.data.map((endpoint) => (
              <li key={endpoint.id} className="px-5 py-3">
                <EndpointLink endpoint={endpoint} />
                <p className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-sub">
                  <Pill tone={ENDPOINT_STATUS[endpoint.status].tone}>
                    {ENDPOINT_STATUS[endpoint.status].label}
                  </Pill>
                  {endpoint.suspendedReason && <Pill tone="danger">Suspended</Pill>}
                  {eventSummary(endpoint.events)} · {channelName(endpoint.channelId)}
                </p>
              </li>
            ))}
          </ul>
          <table className="mt-4 w-full text-left text-[13.5px] max-sm:hidden">
            <thead>
              <tr className="table-head">
                <th scope="col" className="px-5 py-2.5 font-semibold">
                  Endpoint
                </th>
                <th scope="col" className="px-3 py-2.5 font-semibold">
                  Events
                </th>
                <th scope="col" className="px-3 py-2.5 font-semibold">
                  Publication
                </th>
                <th scope="col" className="px-3 py-2.5 font-semibold">
                  Status
                </th>
                <th scope="col" className="px-5 py-2.5 font-semibold">
                  Last delivery
                </th>
              </tr>
            </thead>
            <tbody>
              {endpoints.data.map((endpoint) => (
                <tr key={endpoint.id} className="border-t border-line">
                  <td className="max-w-[320px] px-5 py-3">
                    <EndpointLink endpoint={endpoint} />
                  </td>
                  <td className="px-3 py-3 text-sub">{eventSummary(endpoint.events)}</td>
                  <td className="px-3 py-3 text-sub">{channelName(endpoint.channelId)}</td>
                  <td className="px-3 py-3">
                    <Pill tone={ENDPOINT_STATUS[endpoint.status].tone}>
                      {ENDPOINT_STATUS[endpoint.status].label}
                    </Pill>{' '}
                    {endpoint.suspendedReason && <Pill tone="danger">Suspended</Pill>}
                  </td>
                  <td className="tabular px-5 py-3 whitespace-nowrap text-sub">
                    {endpoint.lastDeliveryStatus ? (
                      <>
                        {DELIVERY_STATUS[endpoint.lastDeliveryStatus].label} ·{' '}
                        {formatDateTime(endpoint.lastDeliveryAt)}
                      </>
                    ) : (
                      'None yet'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <EndpointDialog
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={(created) => {
          setAdding(false);
          setSecret(created);
        }}
      />
      <SecretDialog secret={secret} onClose={() => setSecret(null)} />
    </section>
  );
}

function EndpointLink({ endpoint }: { endpoint: WebhookEndpoint }) {
  return (
    <Link
      to="/settings/developers/webhooks/$endpointId"
      params={{ endpointId: endpoint.id }}
      className="block font-mono text-[13px] font-semibold break-all text-ink hover:text-purple-deep"
    >
      {endpoint.url}
      {endpoint.description && (
        <span className="mt-0.5 block font-sans text-[12.5px] font-normal text-sub">
          {endpoint.description}
        </span>
      )}
    </Link>
  );
}

const eventSummary = (events: readonly WebhookEventType[]) =>
  events.length === WEBHOOK_EVENTS.length
    ? 'All events'
    : events.length === 1
      ? events[0]
      : `${events.length} events`;

/** Add (no endpoint) or edit (with one). */
export function EndpointDialog({
  open,
  endpoint,
  onClose,
  onCreated,
}: {
  open: boolean;
  endpoint?: WebhookEndpoint;
  onClose: () => void;
  onCreated?: (secret: string) => void;
}) {
  // Remounting on open resets the form to the endpoint's current values.
  return open ? (
    <EndpointForm endpoint={endpoint} onClose={onClose} {...(onCreated ? { onCreated } : {})} />
  ) : null;
}

function EndpointForm({
  endpoint,
  onClose,
  onCreated,
}: {
  endpoint: WebhookEndpoint | undefined;
  onClose: () => void;
  onCreated?: (secret: string) => void;
}) {
  const { workspace } = useSession();
  const channels = useQuery(channelsQuery(workspace.id));
  const create = useCreateWebhook(workspace.id);
  const update = useUpdateWebhook(workspace.id, endpoint?.id ?? '');
  const [url, setUrl] = useState(endpoint?.url ?? 'https://');
  const [description, setDescription] = useState(endpoint?.description ?? '');
  const [channelId, setChannelId] = useState(endpoint?.channelId ?? '');
  const [events, setEvents] = useState<WebhookEventType[]>(
    endpoint?.events ?? ['member.created', 'member.confirmed', 'member.unsubscribed'],
  );
  const mutation = endpoint ? update : create;
  // A new or repointed endpoint needs a fresh second-factor check.
  const { guard, dialog: stepUp } = useStepUp();
  const error =
    mutation.error instanceof ApiError && formError(mutation.error) ? mutation.error : null;

  const toggle = (type: WebhookEventType, on: boolean) =>
    setEvents((current) =>
      on ? [...new Set([...current, type])] : current.filter((t) => t !== type),
    );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = {
      url: url.trim(),
      description: description.trim() || null,
      events,
      channelId: channelId || null,
    };
    void guard(async () => {
      if (endpoint) {
        await update.mutateAsync(input);
        onClose();
      } else {
        const created = await create.mutateAsync(input);
        onCreated?.(created.secret);
      }
    }).catch(() => {
      // Shown from the mutation's error.
    });
  };

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        title={endpoint ? 'Edit endpoint' : 'Add endpoint'}
        description="Requests are signed with this endpoint’s secret. Use an https URL with a public host name."
        actions={
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="webhook-endpoint-form"
              loading={mutation.isPending}
              disabled={!events.length}
            >
              {endpoint ? 'Save' : 'Add endpoint'}
            </Button>
          </>
        }
      >
        <form id="webhook-endpoint-form" onSubmit={submit} className="grid gap-4">
          <TextField
            label="URL"
            type="url"
            required
            maxLength={2048}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            error={error?.field('url')}
          />
          <TextField
            label="Description"
            maxLength={200}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            hint="Optional. What this endpoint is for, for your team."
          />
          <SelectField
            label="Publication"
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            error={error?.field('channelId')}
            options={[
              { value: '', label: 'All publications' },
              ...(channels.data ?? []).map((c) => ({ value: c.id, label: c.name })),
            ]}
            hint="Only events from this publication are sent."
          />
          <div className="grid gap-3">
            {WEBHOOK_EVENT_GROUPS.map((group) => (
              <fieldset key={group.label} className="grid gap-0.5">
                <legend className="mb-1 text-[13px] font-semibold">{group.label}</legend>
                {group.events.map((type) => (
                  <label key={type} className="flex min-h-9 items-center gap-2 text-[13.5px]">
                    <input
                      type="checkbox"
                      className="size-4 shrink-0 accent-purple"
                      checked={events.includes(type)}
                      onChange={(e) => toggle(type, e.target.checked)}
                    />
                    <span className="min-w-0 flex-1">{EVENT_LABEL[type]}</span>
                    <code className="font-mono text-[11.5px] text-sub">{type}</code>
                  </label>
                ))}
              </fieldset>
            ))}
            <p role="status" className="text-[12.5px] text-sub">
              {events.length ? `${events.length} selected` : 'Pick at least one event.'}
            </p>
          </div>
          {error && !error.details.length && <ErrorNotice message={error.message} />}
        </form>
      </Dialog>
      {stepUp}
    </>
  );
}

/** The signing secret, shown once after create or rotate. */
export function SecretDialog({ secret, onClose }: { secret: string | null; onClose: () => void }) {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const copy = () => {
    if (!secret) return;
    const done = navigator.clipboard?.writeText(secret);
    if (!done) {
      setCopied('failed');
      return;
    }
    done.then(
      () => setCopied('yes'),
      () => setCopied('failed'),
    );
  };
  return (
    <Dialog
      open={secret !== null}
      onClose={() => {
        setCopied(null);
        onClose();
      }}
      title="Signing secret"
      description="Copy it now and keep it on your server. It won’t be shown again; if it is lost, rotate it."
      actions={<Button onClick={onClose}>Done</Button>}
    >
      <div className="grid gap-2">
        <pre className="overflow-auto rounded-card-app border border-line-app bg-surface-alt p-3 font-mono text-[12.5px] break-all whitespace-pre-wrap">
          <code>{secret}</code>
        </pre>
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={copy}>
            {copied === 'yes' ? <Icon.Check size={14} /> : <Icon.Copy size={14} />}
            Copy secret
          </Button>
          <span role="status" className="text-[12.5px] text-sub">
            {copied === 'yes'
              ? 'Copied.'
              : copied === 'failed'
                ? 'Copying isn’t available here. Select the text and copy it.'
                : ''}
          </span>
        </div>
      </div>
    </Dialog>
  );
}
