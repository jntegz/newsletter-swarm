// Channel settings → Export destinations: incremental exports of Members and their events to the
// operator's own R2 or S3 bucket, on paid plans. Keys are write-only: they are sent once and never
// shown again. Admins and owners only.
import {
  EXPORT_SCOPE_DEFAULT,
  PLAN_LIMITS,
  type Channel,
  type CreateExportDestination,
  type ExportDestination,
  type ExportDestinationStatus,
  type ExportDestinationTest,
  type ExportScope,
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
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import {
  exportDestinationsQuery,
  useConfirmExportDestination,
  useCreateExportDestination,
  useDeleteExportDestination,
  useTestExportDestination,
  useUpdateExportDestination,
} from '../api/privacy';
import { memberFieldsQuery } from '../api/members';
import { channelQuery } from '../api/queries';
import { useSession } from '../session';
import { PageHeader } from './Channels';
import { Section, formatDateTime } from './common';
import { SUSPENSION_TEXT, confirmable } from './feed-suspension';
import { formError, useStepUp } from './StepUp';
import { lastRunLabel } from './privacy-helpers';

const RANK = { viewer: 0, author: 1, editor: 2, admin: 3, owner: 4 } as const;

const STATUS_PILL: Record<
  ExportDestinationStatus,
  { tone: 'success' | 'neutral' | 'danger'; label: string }
> = {
  active: { tone: 'success', label: 'Active' },
  paused: { tone: 'neutral', label: 'Paused' },
  failing: { tone: 'danger', label: 'Failing' },
};

/** What a scope sends, for the destination's row. */
function scopeLabel(scope: ExportScope): string {
  const who =
    scope.members === 'all' ? 'Everyone, including people who left' : 'Subscribed readers';
  const fields =
    scope.fields === 'all'
      ? 'all profile fields'
      : scope.fields.length
        ? `profile fields: ${scope.fields.join(', ')}`
        : 'no profile fields';
  return `${who}, ${fields}`;
}

export function ExportDestinationsPage({ channelId }: { channelId: string }) {
  const channel = useQuery(channelQuery(channelId));
  if (channel.isPending) return <LoadingRows label="Loading publication" rows={4} />;
  if (channel.error)
    return <ErrorNotice title="Publication not available" message={channel.error.message} />;
  return <ExportDestinations channel={channel.data} />;
}

function ExportDestinations({ channel }: { channel: Channel }) {
  const { workspace } = useSession();
  const admin = RANK[channel.role] >= RANK.admin;
  const limit = PLAN_LIMITS[workspace.plan].exportDestinations;
  return (
    <>
      <PageHeader
        title="Export destinations"
        subtitle={`Keep a copy of ${channel.name}’s subscribers and their activity in your own storage bucket.`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/channels/$channelId/members-settings"
              params={{ channelId: channel.id }}
              className="btn-ghost"
            >
              Fields and tags
            </Link>
            <Link to="/members" search={{ channel: channel.id }} className="btn-ghost">
              Subscribers
            </Link>
          </div>
        }
      />
      <div className="grid max-w-[880px] gap-5">
        {!admin ? (
          <EmptyState title="Admins only">
            Ask an owner or admin of this publication to set up an export destination.
          </EmptyState>
        ) : limit === 0 ? (
          <EmptyState
            title="Part of the paid plans"
            action={
              <Link to="/settings/workspace" className="btn-ghost btn-sm">
                See your plan
              </Link>
            }
          >
            On a paid plan Swarm writes changed subscribers and new activity to your own R2 or S3
            bucket every hour or every day.
          </EmptyState>
        ) : (
          <DestinationsSection channelId={channel.id} limit={limit} />
        )}
      </div>
    </>
  );
}

type FormState = { mode: 'create' } | { mode: 'edit'; destination: ExportDestination } | null;

function DestinationsSection({ channelId, limit }: { channelId: string; limit: number }) {
  const destinations = useQuery(exportDestinationsQuery(channelId));
  const [form, setForm] = useState<FormState>(null);
  const [removing, setRemoving] = useState<ExportDestination | null>(null);
  const [formKey, setFormKey] = useState(0);
  const remove = useDeleteExportDestination(channelId);
  const open = (state: FormState) => {
    setFormKey((k) => k + 1);
    setForm(state);
  };
  const add = (
    <Button size="sm" onClick={() => open({ mode: 'create' })}>
      Add destination
    </Button>
  );

  return (
    <Section
      title="Destinations"
      description="Each run writes JSON Lines files under the prefix: members/ for subscribers changed since the last run (with tags and the profile fields you pick), events/ for their new activity, and deletions/ for subscribers erased at their request. By default only subscribed readers are sent in full; someone who unsubscribed or bounced is sent with their id, status and dates only. Files are named after where the run started, so a retried run rewrites the same files."
      action={!!destinations.data?.length && destinations.data.length < limit && add}
    >
      {destinations.isPending && <LoadingRows label="Loading export destinations" rows={2} />}
      {destinations.error && <ErrorNotice message={destinations.error.message} />}
      {destinations.data?.length === 0 && (
        <EmptyState title="No export destinations yet" action={add}>
          Connect an R2 or S3 bucket with an access key that can write objects.
        </EmptyState>
      )}
      {!!destinations.data?.length && (
        <ul className="grid gap-3">
          {destinations.data.map((destination) => (
            <DestinationRow
              key={destination.id}
              channelId={channelId}
              destination={destination}
              fetchedAt={destinations.dataUpdatedAt}
              onEdit={() => open({ mode: 'edit', destination })}
              onRemove={() => setRemoving(destination)}
            />
          ))}
        </ul>
      )}
      {!!destinations.data?.length && destinations.data.length >= limit && (
        <p className="mt-3 text-[13px] text-sub">
          Your plan allows {limit} export destinations in this workspace.
        </p>
      )}

      <DestinationDialog
        key={formKey}
        channelId={channelId}
        state={form}
        onClose={() => setForm(null)}
      />
      <Dialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title="Remove this export destination?"
        description="Swarm stops writing to the bucket. Files already there stay where they are."
        actions={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() =>
                removing && remove.mutate(removing.id, { onSuccess: () => setRemoving(null) })
              }
            >
              Remove destination
            </Button>
          </>
        }
      >
        {remove.error && <ErrorNotice message={remove.error.message} />}
      </Dialog>
    </Section>
  );
}

function DestinationRow({
  channelId,
  destination,
  fetchedAt,
  onEdit,
  onRemove,
}: {
  channelId: string;
  destination: ExportDestination;
  /** When the list was fetched: "last run" counts from there. */
  fetchedAt: number;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const test = useTestExportDestination();
  const update = useUpdateExportDestination(channelId);
  const adopt = useConfirmExportDestination(channelId);
  const { guard, dialog: stepUp } = useStepUp();
  const [result, setResult] = useState<ExportDestinationTest | null>(null);
  const pill = STATUS_PILL[destination.status];
  const where = destination.endpoint
    ? new URL(destination.endpoint).host
    : `S3 · ${destination.region}`;

  return (
    <li className="rounded-card-app border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[14px] font-semibold break-all">
            {destination.bucket}/{destination.prefix}
          </p>
          <p className="mt-0.5 text-[12.5px] text-sub">
            {destination.kind === 'r2' ? 'R2' : 'S3'} · {where} ·{' '}
            {destination.schedule === 'hourly' ? 'Every hour' : 'Every day'}
          </p>
        </div>
        <Pill tone={pill.tone}>{pill.label}</Pill>
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-1 text-[13px] sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="text-sub">Last run</dt>
          <dd className="tabular">{lastRunLabel(destination.lastRunAt, fetchedAt)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-sub">Subscribers exported through</dt>
          <dd className="tabular">{formatDateTime(destination.exportedThrough)}</dd>
        </div>
        <div className="flex gap-2 sm:col-span-2">
          <dt className="text-sub">Sends</dt>
          <dd>{scopeLabel(destination.scope)}</dd>
        </div>
      </dl>
      {destination.legacyScope && (
        <div
          role="note"
          className="mt-3 flex flex-wrap items-center gap-3 rounded-card-app border border-line-app bg-lavender p-3 text-[13px] leading-[1.5]"
        >
          <span className="flex-1">
            <b>Older scope: everything.</b> This destination was added before you could choose what
            it sends, so it still sends every subscriber, including people who left, with all their
            profile fields. New destinations send subscribed readers without profile fields unless
            you pick some.
          </span>
          <Button size="sm" variant="ghost" onClick={onEdit}>
            Choose what it sends
          </Button>
        </div>
      )}
      {destination.suspendedReason && (
        <div
          role="note"
          className="mt-3 flex flex-wrap items-center gap-3 rounded-card-app border border-line-app bg-danger-soft p-3 text-[13px] leading-[1.5] text-danger"
        >
          <span className="flex-1">
            <b>Suspended.</b> {SUSPENSION_TEXT[destination.suspendedReason]}
          </span>
          {confirmable(destination.suspendedReason) && (
            <Button
              size="sm"
              variant="ghost"
              loading={adopt.isPending}
              onClick={() =>
                void guard(() => adopt.mutateAsync(destination.id)).catch(() => {
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
      {formError(adopt.error) && <ErrorNotice message={adopt.error!.message} />}
      {destination.lastError && (
        <div className="mt-3">
          <ErrorNotice
            title="The last run failed"
            message={`${destination.lastError} It is retried on the next run.`}
          />
        </div>
      )}
      <div role="status" className="mt-3 text-[13px]">
        {result && (
          <span className={result.ok ? 'text-success' : 'font-semibold text-danger'}>
            {result.message}
          </span>
        )}
      </div>
      {test.error && <ErrorNotice message={test.error.message} />}
      {update.error && <ErrorNotice message={update.error.message} />}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="ghost"
          loading={test.isPending}
          onClick={() => {
            setResult(null);
            test.mutate(destination.id, { onSuccess: setResult });
          }}
        >
          Test connection
        </Button>
        <Button
          size="sm"
          variant="ghost"
          loading={update.isPending}
          onClick={() =>
            update.mutate({
              id: destination.id,
              status: destination.status === 'paused' ? 'active' : 'paused',
            })
          }
        >
          {destination.status === 'paused' ? 'Resume' : 'Pause'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          Edit
        </Button>
        <Button size="sm" variant="quiet" onClick={onRemove}>
          Remove
        </Button>
      </div>
    </li>
  );
}

function DestinationDialog({
  channelId,
  state,
  onClose,
}: {
  channelId: string;
  state: FormState;
  onClose: () => void;
}) {
  const create = useCreateExportDestination(channelId);
  const update = useUpdateExportDestination(channelId);
  const editing = state?.mode === 'edit' ? state.destination : null;
  const [kind, setKind] = useState<'s3' | 'r2'>(editing?.kind ?? 'r2');
  const [endpoint, setEndpoint] = useState(editing?.endpoint ?? '');
  const [region, setRegion] = useState(editing?.region ?? 'auto');
  const [bucket, setBucket] = useState(editing?.bucket ?? '');
  const [prefix, setPrefix] = useState(editing?.prefix ?? 'swarm/');
  const [schedule, setSchedule] = useState<'hourly' | 'daily'>(editing?.schedule ?? 'daily');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [members, setMembers] = useState<ExportScope['members']>(
    editing?.scope.members ?? EXPORT_SCOPE_DEFAULT.members,
  );
  const [fields, setFields] = useState<ExportScope['fields']>(
    editing?.scope.fields ?? EXPORT_SCOPE_DEFAULT.fields,
  );
  const fieldList = useQuery({ ...memberFieldsQuery(channelId), enabled: !!state });
  const mutation = editing ? update : create;
  // A new or moved destination needs a fresh second-factor check.
  const { guard, dialog: stepUp } = useStepUp();
  const error =
    mutation.error instanceof ApiError && formError(mutation.error) ? mutation.error : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const where = {
      region: region.trim(),
      bucket: bucket.trim(),
      prefix: prefix.trim(),
      schedule,
    };
    const scope: ExportScope = { members, fields };
    const scopeChanged =
      !editing || editing.legacyScope || JSON.stringify(editing.scope) !== JSON.stringify(scope);
    void guard(async () => {
      if (editing) {
        await update.mutateAsync({
          id: editing.id,
          ...where,
          endpoint: endpoint.trim() || null,
          ...(accessKeyId || secretAccessKey ? { accessKeyId, secretAccessKey } : {}),
          ...(scopeChanged ? { scope } : {}),
        });
      } else {
        const input: CreateExportDestination = {
          kind,
          ...where,
          ...(endpoint.trim() ? { endpoint: endpoint.trim() } : {}),
          scope,
          accessKeyId,
          secretAccessKey,
        };
        await create.mutateAsync(input);
      }
      onClose();
    }).catch(() => {
      // Shown from the mutation's error.
    });
  };

  return (
    <>
      <Dialog
        open={!!state}
        onClose={onClose}
        title={editing ? 'Edit export destination' : 'Add export destination'}
        description="The access key needs permission to write objects in the bucket, and to delete them if you want to use Test connection. Keys are stored encrypted and never shown again."
        actions={
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form="export-destination" loading={mutation.isPending}>
              {editing ? 'Save' : 'Add destination'}
            </Button>
          </>
        }
      >
        <form id="export-destination" onSubmit={submit} className="grid gap-4">
          {!editing && (
            <SelectField
              label="Storage"
              value={kind}
              options={[
                { value: 'r2', label: 'Cloudflare R2' },
                { value: 's3', label: 'Amazon S3 or S3-compatible' },
              ]}
              onChange={(e) => {
                const next = e.target.value as 's3' | 'r2';
                setKind(next);
                if (next === 'r2' && !region) setRegion('auto');
              }}
            />
          )}
          <TextField
            label={kind === 'r2' ? 'S3 endpoint' : 'Endpoint (optional)'}
            required={kind === 'r2'}
            type="url"
            placeholder={
              kind === 'r2'
                ? 'https://<account id>.r2.cloudflarestorage.com'
                : 'Leave empty for AWS'
            }
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            error={error?.field('endpoint')}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Bucket"
              required
              value={bucket}
              onChange={(e) => setBucket(e.target.value)}
              error={error?.field('bucket')}
            />
            <TextField
              label="Region"
              required
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              hint={kind === 'r2' ? 'auto for R2' : 'For example eu-west-1'}
              error={error?.field('region')}
            />
          </div>
          <TextField
            label="Prefix"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            hint="Folders end with a slash. Leave empty to write at the top of the bucket."
            error={error?.field('prefix')}
          />
          <SelectField
            label="How often"
            value={schedule}
            options={[
              { value: 'daily', label: 'Every day' },
              { value: 'hourly', label: 'Every hour' },
            ]}
            onChange={(e) => setSchedule(e.target.value as 'hourly' | 'daily')}
          />
          <fieldset className="grid gap-3">
            <legend className="mb-1 text-[13.5px] font-semibold">What it sends</legend>
            <SelectField
              label="Who"
              value={members}
              options={[
                { value: 'active', label: 'Subscribed readers only' },
                { value: 'all', label: 'Everyone, including people who unsubscribed or bounced' },
              ]}
              onChange={(e) => setMembers(e.target.value as ExportScope['members'])}
              hint={
                members === 'active'
                  ? 'Anyone else is sent with their id, status and dates only, so your copy can drop them.'
                  : 'Use this for a full backup.'
              }
            />
            <Checkbox
              label="All profile fields"
              hint="Includes fields added later, and encrypted fields in readable form."
              checked={fields === 'all'}
              onChange={(checked) => setFields(checked ? 'all' : [])}
            />
            {fields !== 'all' &&
              (fieldList.data?.length ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  {fieldList.data.map((field) => (
                    <Checkbox
                      key={field.id}
                      label={field.label}
                      hint={field.encrypted ? 'Encrypted here; sent in readable form' : undefined}
                      checked={fields.includes(field.key)}
                      onChange={(checked) =>
                        setFields(
                          checked
                            ? [...fields, field.key]
                            : fields.filter((key) => key !== field.key),
                        )
                      }
                    />
                  ))}
                </div>
              ) : (
                <p className="text-[12.5px] text-sub">
                  {fieldList.isPending ? 'Loading profile fields…' : 'No profile fields yet.'}
                </p>
              ))}
          </fieldset>
          <TextField
            label="Access key ID"
            required={!editing}
            autoComplete="off"
            value={accessKeyId}
            placeholder={editing ? 'Stored. Enter new keys to replace them.' : undefined}
            onChange={(e) => setAccessKeyId(e.target.value)}
            error={error?.field('accessKeyId')}
          />
          <TextField
            label="Secret access key"
            type="password"
            required={!editing}
            autoComplete="new-password"
            value={secretAccessKey}
            placeholder={editing ? 'Stored. Enter new keys to replace them.' : undefined}
            onChange={(e) => setSecretAccessKey(e.target.value)}
            error={error?.field('secretAccessKey')}
          />
          {error && !error.details.length && <ErrorNotice message={error.message} />}
        </form>
      </Dialog>
      {stepUp}
    </>
  );
}
