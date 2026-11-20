// Export (admins and owners): pick a format and an optional status, follow the job, download.
import type { Channel, ExportJob, MemberStatus } from '@swarm/domain';
import { Button, Dialog, ErrorNotice, SelectField } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { exportQuery, exportsQuery, useCancelExport, useCreateExport } from '../api/members';
import { formatDateTime, numberFormat } from './common';
import { MEMBER_STATUSES, STATUS_LABEL } from './members-helpers';

export function ExportDialog({
  channel,
  open,
  onClose,
}: {
  channel: Channel;
  open: boolean;
  onClose: () => void;
}) {
  const create = useCreateExport(channel.id);
  const cancel = useCancelExport(channel.id);
  const [format, setFormat] = useState<'csv' | 'jsonl'>('csv');
  const [status, setStatus] = useState<MemberStatus | ''>('');
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useQuery({ ...exportQuery(jobId ?? ''), enabled: !!jobId });
  const recent = useQuery({ ...exportsQuery(channel.id), enabled: open });

  const close = () => {
    create.reset();
    setJobId(null);
    onClose();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { format, ...(status ? { status } : {}) },
      { onSuccess: (created) => setJobId(created.id) },
    );
  };

  const current = jobId ? job.data : undefined;

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Export subscribers"
      description="The file includes every profile field, decrypted. Each download is recorded in the audit log, and the file is deleted after 72 hours."
      actions={
        jobId ? (
          <Button variant="ghost" onClick={close}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" form="export-members" loading={create.isPending}>
              Start export
            </Button>
          </>
        )
      }
    >
      {!jobId && (
        <form id="export-members" onSubmit={submit} className="grid gap-4">
          <fieldset className="grid gap-1.5">
            <legend className="mb-1 text-[13px] font-semibold">Format</legend>
            {(
              [
                ['csv', 'CSV', 'Opens in any spreadsheet.'],
                ['jsonl', 'JSON Lines', 'One JSON object per subscriber, for scripts.'],
              ] as const
            ).map(([value, label, hint]) => (
              <div key={value} className="flex min-h-9 items-start gap-2.5">
                <input
                  id={`export-format-${value}`}
                  type="radio"
                  name="export-format"
                  value={value}
                  checked={format === value}
                  onChange={() => setFormat(value)}
                  aria-describedby={`export-format-${value}-hint`}
                  className="mt-1 size-4 accent-purple"
                />
                <span className="text-[13.5px]">
                  <label
                    htmlFor={`export-format-${value}`}
                    className="cursor-pointer font-semibold"
                  >
                    {label}
                  </label>
                  <span id={`export-format-${value}-hint`} className="block text-sub">
                    {hint}
                  </span>
                </span>
              </div>
            ))}
          </fieldset>
          <SelectField
            label="Subscribers"
            value={status}
            onChange={(e) => setStatus(e.target.value as MemberStatus | '')}
            options={[
              { value: '', label: 'Every status' },
              ...MEMBER_STATUSES.map((s) => ({ value: s, label: `${STATUS_LABEL[s]} only` })),
            ]}
          />
          {create.error && <ErrorNotice message={create.error.message} />}
        </form>
      )}
      <div role="status" aria-live="polite" className="empty:hidden">
        {jobId && job.error && <ErrorNotice message={job.error.message} />}
        {jobId && !job.error && <ExportProgress job={current} />}
      </div>
      {!jobId && !!recent.data?.length && (
        <div className="mt-5">
          <h3 className="text-[13px] font-semibold">Recent exports</h3>
          <ul className="mt-2 grid gap-1.5 text-[13px]">
            {recent.data.slice(0, 3).map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sub">
                  {item.format.toUpperCase()} · {formatDateTime(item.createdAt)}
                  {item.status === 'done' && ` · ${numberFormat.format(item.rowCount)} rows`}
                </span>
                {item.downloadUrl ? (
                  <a href={item.downloadUrl} className="font-semibold text-purple-deep underline">
                    Download
                  </a>
                ) : (
                  <span className="flex items-center gap-2 text-sub">
                    {item.status === 'failed'
                      ? (item.error ?? 'Failed')
                      : item.status === 'done'
                        ? 'Expired'
                        : 'In progress'}
                    {(item.status === 'queued' || item.status === 'running') && (
                      <Button
                        size="sm"
                        variant="quiet"
                        loading={cancel.isPending && cancel.variables === item.id}
                        onClick={() => cancel.mutate(item.id)}
                      >
                        Cancel
                      </Button>
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}

function ExportProgress({ job }: { job: ExportJob | undefined }) {
  if (!job || job.status === 'queued') {
    return <p className="text-[13.5px] text-sub">Waiting to start…</p>;
  }
  if (job.status === 'running') {
    return (
      <p className="tabular text-[13.5px]">
        Writing the file: {numberFormat.format(job.rowCount)} subscribers so far…
      </p>
    );
  }
  if (job.status === 'failed') {
    return (
      <ErrorNotice
        title="The export failed"
        message={job.error ?? 'Something went wrong. Try again in a moment.'}
      />
    );
  }
  return (
    <div className="grid gap-3">
      <p className="text-[13.5px]">
        Ready: {numberFormat.format(job.rowCount)}{' '}
        {job.rowCount === 1 ? 'subscriber' : 'subscribers'}. The link works for 24 hours while you
        are signed in.
      </p>
      {job.downloadUrl ? (
        <a href={job.downloadUrl} className="btn-primary btn-sm justify-self-start">
          Download {job.format === 'csv' ? 'CSV' : 'JSON Lines'}
        </a>
      ) : (
        <p className="text-[13.5px] text-sub">This export is no longer available.</p>
      )}
    </div>
  );
}
