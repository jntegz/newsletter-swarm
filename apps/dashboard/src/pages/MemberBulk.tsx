// The bulk bar: tag, untag, set a profile field, unsubscribe or delete the selected Members or a
// whole Circle, run as a bulk job whose progress is announced as it goes.
import type { BulkJob, CreateBulkJob } from '@swarm/domain';
import { Button, Dialog, ErrorNotice, SelectField, TextField } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import { memberFieldsQuery, tagsQuery, useBulkJob, useStartBulkJob } from '../api/members';
import { numberFormat, percentFormat } from './common';
import { FieldInput } from './MemberFieldInput';
import { fromDraft, type FieldDraft } from './members-helpers';

type Action = CreateBulkJob['action'];

const ACTION_BUTTON: Record<Action, string> = {
  tag: 'Add tag',
  untag: 'Remove tag',
  set_field: 'Set field',
  unsubscribe: 'Unsubscribe',
  delete: 'Delete',
};

const plural = (n: number) => `${numberFormat.format(n)} ${n === 1 ? 'subscriber' : 'subscribers'}`;

function describeRunning(job: BulkJob): string {
  const tag = job.params.tag ? ` “${job.params.tag}”` : '';
  switch (job.action) {
    case 'tag':
      return `Adding the tag${tag}`;
    case 'untag':
      return `Removing the tag${tag}`;
    case 'set_field':
      return `Setting ${job.params.field ?? 'the field'}`;
    case 'unsubscribe':
      return 'Unsubscribing';
    case 'delete':
      return 'Deleting';
    case 'flow_enrol':
      return 'Adding to an automation';
  }
}

function describeDone(job: BulkJob): string {
  const who = plural(job.total);
  const tag = job.params.tag ? `“${job.params.tag}”` : 'the tag';
  switch (job.action) {
    case 'tag':
      return `Tagged ${who} with ${tag}.`;
    case 'untag':
      return `Removed ${tag} from ${who}.`;
    case 'set_field':
      return `Set ${job.params.field ?? 'the field'} on ${who}.`;
    case 'unsubscribe':
      return `Unsubscribed ${who}. Subscribers who had bounced, complained or already unsubscribed were left as they were.`;
    case 'delete':
      return `Deleted ${who}.`;
    case 'flow_enrol':
      return `Added ${plural(job.entered)} to an automation.`;
  }
}

export function BulkBar({
  channelId,
  selected,
  circle,
  onClear,
  onStarted,
}: {
  channelId: string;
  /** The ticked Members. */
  selected?: ReadonlySet<string>;
  /** Or everyone in a Circle, as of its last evaluation. */
  circle?: { id: string; name: string; memberCount: number };
  onClear?: () => void;
  onStarted: () => void;
}) {
  // The dialog stays mounted while it closes, so the browser can return focus to its trigger.
  const [dialog, setDialog] = useState<{ action: Action; open: boolean; n: number } | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const { job, error } = useBulkJob(channelId, jobId);
  const count = circle ? circle.memberCount : (selected?.size ?? 0);

  if (!count && !jobId) return null;

  return (
    <div className="mb-4 grid gap-3">
      {count > 0 && (
        <section
          aria-label="Bulk actions"
          className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-card-app border border-lavender-line bg-lavender px-3 py-2"
        >
          <p className="tabular mr-2 pl-1 text-[13.5px] font-semibold text-purple-deep">
            {circle
              ? `Everyone in ${circle.name}: ${plural(count)}`
              : `${numberFormat.format(count)} selected`}
          </p>
          {(Object.keys(ACTION_BUTTON) as Action[]).map((a) => (
            <Button
              key={a}
              size="sm"
              variant={a === 'delete' ? 'danger' : 'ghost'}
              onClick={() => setDialog((d) => ({ action: a, open: true, n: (d?.n ?? 0) + 1 }))}
            >
              {ACTION_BUTTON[a]}
            </Button>
          ))}
          {onClear && (
            <Button variant="quiet" size="sm" onClick={onClear} className="ml-auto">
              Clear selection
            </Button>
          )}
        </section>
      )}
      <div role="status" aria-live="polite" className="empty:hidden">
        {jobId && (
          <BulkProgress job={job} error={error?.message} onDismiss={() => setJobId(null)} />
        )}
      </div>
      {dialog && (
        <BulkDialog
          key={dialog.n}
          channelId={channelId}
          action={dialog.action}
          open={dialog.open}
          selection={circle ? { circleId: circle.id } : { memberIds: [...(selected ?? [])] }}
          count={count}
          onClose={() => setDialog((d) => d && { ...d, open: false })}
          onStarted={(id) => {
            setJobId(id);
            setDialog((d) => d && { ...d, open: false });
            onStarted();
          }}
        />
      )}
    </div>
  );
}

function BulkProgress({
  job,
  error,
  onDismiss,
}: {
  job: BulkJob | undefined;
  error: string | undefined;
  onDismiss: () => void;
}) {
  if (error) return <ErrorNotice title="Progress unavailable" message={error} />;
  if (!job) return <p className="text-[13.5px] text-sub">Starting…</p>;
  const running = job.status === 'queued' || job.status === 'running';
  const fraction = job.total ? job.processed / job.total : running ? 0 : 1;
  return (
    <div className="card-app p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-[13.5px]">
        <p className="font-semibold">
          {job.status === 'failed'
            ? 'The bulk action stopped'
            : running
              ? `${describeRunning(job)}: ${numberFormat.format(job.processed)} of ${plural(job.total)}`
              : describeDone(job)}
        </p>
        {running ? (
          <span className="tabular text-sub">{percentFormat.format(fraction)}</span>
        ) : (
          <Button variant="quiet" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        )}
      </div>
      {job.status === 'failed' && (
        <p className="mt-1 text-[13px] text-danger">
          {job.error ?? 'Something went wrong.'} Subscribers handled before it stopped keep the
          change.
        </p>
      )}
      {running && (
        <div
          role="progressbar"
          aria-label="Bulk action progress"
          aria-valuemin={0}
          aria-valuemax={job.total}
          aria-valuenow={job.processed}
          className="mt-2 h-2 overflow-hidden rounded-pill bg-surface-alt"
        >
          <div
            className="h-full rounded-pill bg-purple transition-[width]"
            style={{ width: `${Math.min(100, fraction * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

function BulkDialog({
  channelId,
  action,
  open,
  selection,
  count,
  onClose,
  onStarted,
}: {
  channelId: string;
  action: Action;
  open: boolean;
  selection: CreateBulkJob['selection'];
  count: number;
  onClose: () => void;
  onStarted: (jobId: string) => void;
}) {
  const start = useStartBulkJob(channelId);
  const tags = useQuery({
    ...tagsQuery(channelId),
    enabled: action === 'tag' || action === 'untag',
  });
  const fields = useQuery({ ...memberFieldsQuery(channelId), enabled: action === 'set_field' });
  const [tag, setTag] = useState('');
  const [fieldKey, setFieldKey] = useState('');
  const [draft, setDraft] = useState<FieldDraft>('');
  const listId = useId();
  const error = start.error instanceof ApiError ? start.error : null;
  const who = plural(count);
  const field = fields.data?.find((f) => f.key === fieldKey) ?? fields.data?.[0];

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const input: CreateBulkJob = { selection, action };
    if (action === 'tag' || action === 'untag') input.tag = tag.trim();
    if (action === 'set_field' && field) {
      input.field = field.key;
      input.value = fromDraft(field.type, draft);
    }
    start.mutate(input, { onSuccess: (job) => onStarted(job.id) });
  };

  const title = {
    tag: `Add a tag to ${who}`,
    untag: `Remove a tag from ${who}`,
    set_field: `Set a profile field on ${who}`,
    unsubscribe: `Unsubscribe ${who}?`,
    delete: `Delete ${who}?`,
  }[action];

  const description = {
    tag: 'The tag is created if it doesn’t exist yet.',
    untag: 'Subscribers without the tag are left as they are.',
    set_field: 'An empty value clears the field.',
    unsubscribe:
      'They stop receiving posts. Only they can come back, by confirming from an email. Subscribers who bounced, complained or already unsubscribed are left as they are.',
    delete:
      'They are removed and their addresses are erased from delivery history. This can’t be undone. To stop mail but keep the records, unsubscribe them instead.',
  }[action];

  const submitLabel = {
    tag: 'Add tag',
    untag: 'Remove tag',
    set_field: 'Set field',
    unsubscribe: `Unsubscribe ${who}`,
    delete: `Delete ${who}`,
  }[action];

  const needsForm = action === 'tag' || action === 'untag' || action === 'set_field';
  const blocked =
    ((action === 'tag' || action === 'untag') && !tag.trim()) || (action === 'set_field' && !field);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type={needsForm ? 'submit' : 'button'}
            form={needsForm ? 'bulk-action' : undefined}
            variant={action === 'delete' || action === 'unsubscribe' ? 'danger' : 'primary'}
            loading={start.isPending}
            disabled={blocked}
            onClick={needsForm ? undefined : () => submit()}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      {needsForm && (
        <form id="bulk-action" onSubmit={submit} className="grid gap-4">
          {(action === 'tag' || action === 'untag') && (
            <>
              <TextField
                label="Tag"
                required
                maxLength={60}
                list={listId}
                autoComplete="off"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                error={error?.field('tag')}
              />
              <datalist id={listId}>
                {tags.data?.map((t) => (
                  <option key={t.id} value={t.name} />
                ))}
              </datalist>
            </>
          )}
          {action === 'set_field' && fields.data?.length === 0 && (
            <p className="text-[13.5px] text-sub">
              This publication has no profile fields yet. Add one under Fields and tags first.
            </p>
          )}
          {action === 'set_field' && field && fields.data && (
            <>
              <SelectField
                label="Field"
                value={field.key}
                onChange={(e) => {
                  setFieldKey(e.target.value);
                  const next = fields.data.find((f) => f.key === e.target.value);
                  setDraft(next?.type === 'multi_select' ? [] : '');
                }}
                options={fields.data.map((f) => ({ value: f.key, label: f.label }))}
                error={error?.field('field')}
              />
              <FieldInput
                key={field.key}
                field={{ ...field, label: 'Value' }}
                value={draft}
                onChange={setDraft}
                error={error?.field('value')}
              />
            </>
          )}
        </form>
      )}
      {error && !error.details.length && (
        <div className="mt-3">
          <ErrorNotice message={error.message} />
        </div>
      )}
    </Dialog>
  );
}
