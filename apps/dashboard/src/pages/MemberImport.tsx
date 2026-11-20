// The import wizard: upload a CSV, map its columns, run the dry run, review the report, import and
// follow the progress. The current import lives in the URL (?import=), so a reload resumes it.
import {
  IMPORT_ATTESTATION_TEXT,
  IMPORT_JSON_MAX_BYTES,
  IMPORT_SOURCES,
  IMPORT_SOURCE_LABELS,
  type Channel,
  type ImportJob,
  type ImportReport,
  type ImportSource,
  type ImportTarget,
  type MemberField,
} from '@swarm/domain';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  Pill,
  SelectField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { useChannelFlag } from '../api/queries';
import {
  importQuery,
  importsQuery,
  memberFieldsQuery,
  useAnalyzeImport,
  useCancelImport,
  useConfirmImport,
  useRefreshWhenImported,
  useSaveImportMapping,
  useUploadImport,
} from '../api/members';
import { ImportWarmup } from '../send/WarmupCallout';
import { PageHeader } from './Channels';
import { WithChannel, formatDateTime, formatDay, numberFormat, percentFormat } from './common';
import {
  IMPORT_MAX_BYTES,
  WARM_IMPORT_AT,
  checkMapping,
  formatBytes,
  mappingIsValid,
  targetOptions,
  targetToValue,
  valueToTarget,
} from './members-helpers';
import {
  ImportEmailCheckOption,
  ImportEmailCheckProgress,
  ImportEmailCheckReport,
} from './EmailChecks';

const RANK = { viewer: 0, author: 1, editor: 2, admin: 3, owner: 4 } as const;

export function MemberImportPage({
  channelId,
  importId,
}: {
  channelId: string | undefined;
  importId: string | undefined;
}) {
  const navigate = useNavigate();
  return (
    <WithChannel
      channelId={channelId}
      onChange={(id) => void navigate({ to: '/members/import', search: { channel: id } })}
    >
      {(channel, picker) => (
        <ImportWizard key={channel.id} channel={channel} picker={picker} importId={importId} />
      )}
    </WithChannel>
  );
}

const STEPS = ['Upload', 'Map columns', 'Review', 'Import'] as const;

function stepOf(job: ImportJob | undefined, editing: boolean): number {
  if (!job) return 0;
  switch (job.status) {
    case 'uploaded':
      return 1;
    case 'analyzing':
    case 'analyzed':
      return editing ? 1 : 2;
    default:
      return 3;
  }
}

function ImportWizard({
  channel,
  picker,
  importId,
}: {
  channel: Channel;
  picker: ReactNode;
  importId: string | undefined;
}) {
  const navigate = useNavigate();
  const canEdit = RANK[channel.role] >= RANK.editor;
  const job = useQuery({ ...importQuery(importId ?? ''), enabled: !!importId });
  const current = importId ? job.data : undefined;
  const [editing, setEditing] = useState(false);
  useRefreshWhenImported(channel.id, current);
  const step = stepOf(current, editing);

  const open = (id: string | undefined) => {
    setEditing(false);
    void navigate({
      to: '/members/import',
      search: id ? { channel: channel.id, import: id } : { channel: channel.id },
    });
  };

  return (
    <>
      <PageHeader
        title="Import subscribers"
        subtitle={`Bring an existing list into ${channel.name}. Nothing changes until you confirm the dry run.`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {picker}
            <Link to="/members" search={{ channel: channel.id }} className="btn-ghost">
              Back to subscribers
            </Link>
          </div>
        }
      />

      {!canEdit ? (
        <EmptyState
          title="Editors import subscribers"
          action={
            <Link to="/members" search={{ channel: channel.id }} className="btn-primary btn-sm">
              Back to subscribers
            </Link>
          }
        >
          Ask an editor, admin or owner of this publication to run the import.
        </EmptyState>
      ) : (
        <div className="grid gap-5">
          <ol aria-label="Import steps" className="flex flex-wrap gap-2">
            {STEPS.map((label, index) => (
              <li
                key={label}
                aria-current={index === step ? 'step' : undefined}
                className={`rounded-pill border px-3 py-1 text-[12.5px] font-semibold ${
                  index === step
                    ? 'border-lavender-line bg-lavender text-purple-deep'
                    : index < step
                      ? 'border-line bg-surface text-ink'
                      : 'border-line bg-surface text-sub'
                }`}
              >
                <span className="tabular">{index + 1}.</span> {label}
                {index < step && <span className="sr-only"> (done)</span>}
              </li>
            ))}
          </ol>

          {importId && job.isPending && <LoadingRows label="Loading the import" rows={3} />}
          {importId && job.error && (
            <ErrorNotice
              title="Import not available"
              message={job.error.message}
              action={
                <Button size="sm" variant="ghost" onClick={() => open(undefined)}>
                  Start a new import
                </Button>
              }
            />
          )}
          {!importId && <UploadStep channelId={channel.id} onUploaded={(j) => open(j.id)} />}
          {current && (
            <JobStep
              channel={channel}
              job={current}
              editing={editing}
              setEditing={setEditing}
              onRestart={() => open(undefined)}
            />
          )}
          {!importId && <RecentImports channelId={channel.id} onOpen={open} />}
        </div>
      )}
    </>
  );
}

// ---- Upload ----------------------------------------------------------------------------------

function UploadStep({
  channelId,
  onUploaded,
}: {
  channelId: string;
  onUploaded: (job: ImportJob) => void;
}) {
  const upload = useUploadImport(channelId);
  const [tooBig, setTooBig] = useState<string | null>(null);
  const [source, setSource] = useState<ImportSource>('csv');
  const inputId = useId();
  const hintId = useId();
  const json = source === 'platform_json';

  const pick = (file: File | undefined) => {
    upload.reset();
    setTooBig(null);
    if (!file) return;
    const max = json ? IMPORT_JSON_MAX_BYTES : IMPORT_MAX_BYTES;
    if (file.size > max) {
      setTooBig(
        `${file.name} is ${formatBytes(file.size)}. ${json ? 'JSON files can be up to 20 MB.' : 'Import files can be up to 50 MB.'}`,
      );
      return;
    }
    upload.mutate({ file, source }, { onSuccess: onUploaded });
  };

  return (
    <section aria-labelledby={`${inputId}-title`} className="card-app grid gap-4 p-5 sm:p-6">
      <div>
        <h2 id={`${inputId}-title`} className="text-[16px] font-semibold">
          Upload a CSV file
        </h2>
        <p id={hintId} className="mt-1 max-w-[65ch] text-[13.5px] text-sub">
          Comma, semicolon or tab separated UTF-8 text, up to 50 MB and 200 columns. A header row
          helps Swarm suggest where each column goes. Only import people who agreed to hear from
          this publication.
        </p>
      </div>
      <div className="max-w-[360px]">
        <SelectField
          label="Where the file comes from"
          value={source}
          onChange={(e) => setSource(e.target.value as ImportSource)}
          disabled={upload.isPending}
          options={IMPORT_SOURCES.map((value) => ({ value, label: IMPORT_SOURCE_LABELS[value] }))}
          hint={
            source === 'csv'
              ? undefined
              : 'An export from another newsletter platform. Its columns are matched for you, and people who unsubscribed there are left out.'
          }
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor={inputId} className="btn-primary btn-sm cursor-pointer">
          {upload.isPending ? 'Uploading…' : json ? 'Choose a JSON file' : 'Choose a CSV file'}
        </label>
        <input
          id={inputId}
          type="file"
          accept={json ? '.json,application/json' : '.csv,.tsv,.txt,text/csv,text/plain'}
          aria-describedby={hintId}
          disabled={upload.isPending}
          className="sr-only"
          onChange={(event) => {
            pick(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        {upload.isPending && (
          <span role="status" className="text-[13px] text-sub">
            Uploading and reading the columns…
          </span>
        )}
      </div>
      {(tooBig || upload.error) && (
        <ErrorNotice
          title="That file can’t be imported"
          message={tooBig ?? upload.error?.message ?? ''}
        />
      )}
    </section>
  );
}

// ---- Steps after upload ------------------------------------------------------------------------

function JobStep({
  channel,
  job,
  editing,
  setEditing,
  onRestart,
}: {
  channel: Channel;
  job: ImportJob;
  editing: boolean;
  setEditing: (editing: boolean) => void;
  onRestart: () => void;
}) {
  const cancel = useCancelImport(channel.id);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const cancellable = ['uploaded', 'analyzing', 'analyzed', 'importing'].includes(job.status);

  let body: ReactNode;
  if (job.status === 'uploaded' || (job.status === 'analyzed' && editing)) {
    body = <MappingStep channelId={channel.id} job={job} onAnalyzing={() => setEditing(false)} />;
  } else if (job.status === 'analyzing') {
    body = (
      <StepCard title="Running the dry run">
        <p role="status" aria-live="polite" className="text-[13.5px] text-sub">
          Checking every row of {job.fileName}. Nothing is written to subscribers yet.
        </p>
        <IndeterminateBar label="Dry run progress" />
      </StepCard>
    );
  } else if (job.status === 'analyzed' && job.report) {
    body = (
      <ReviewStep
        channelId={channel.id}
        job={job}
        report={job.report}
        onEdit={() => setEditing(true)}
      />
    );
  } else if (job.status === 'importing') {
    body = <ProgressStep job={job} />;
  } else if (job.status === 'done') {
    body = <DoneStep channelId={channel.id} job={job} onRestart={onRestart} />;
  } else {
    body = (
      <StepCard title={job.status === 'canceled' ? 'Import canceled' : 'The import stopped'}>
        {job.status === 'failed' ? (
          <ErrorNotice
            title="The import stopped"
            message={job.error ?? 'Something went wrong. Upload the file again.'}
          />
        ) : (
          <p className="text-[13.5px] text-sub">
            The uploaded file was deleted. Subscribers imported before canceling stay.
          </p>
        )}
        <div className="mt-4">
          <Button size="sm" onClick={onRestart}>
            Start a new import
          </Button>
        </div>
      </StepCard>
    );
  }

  return (
    <div className="grid gap-3">
      <p className="text-[13px] text-sub">
        <span className="font-semibold text-ink">{job.fileName}</span> · {formatBytes(job.bytes)} ·
        uploaded {formatDateTime(job.createdAt)}
      </p>
      {body}
      {cancellable && (
        <div>
          <Button variant="quiet" size="sm" onClick={() => setConfirmingCancel(true)}>
            Cancel import
          </Button>
        </div>
      )}
      <Dialog
        open={confirmingCancel}
        onClose={() => setConfirmingCancel(false)}
        title="Cancel this import?"
        description={
          job.status === 'importing'
            ? 'The import stops and the uploaded file is deleted. Subscribers imported so far stay.'
            : 'The uploaded file is deleted. No subscribers have been imported.'
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirmingCancel(false)}>
              Keep going
            </Button>
            <Button
              variant="danger"
              loading={cancel.isPending}
              onClick={() =>
                cancel.mutate(job.id, {
                  onSuccess: () => {
                    setConfirmingCancel(false);
                    setEditing(false);
                  },
                })
              }
            >
              Cancel import
            </Button>
          </>
        }
      >
        {cancel.error && <ErrorNotice message={cancel.error.message} />}
      </Dialog>
    </div>
  );
}

function StepCard({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="card-app p-5 sm:p-6">
      <h2 id={id} className="mb-3 text-[16px] font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function IndeterminateBar({ label }: { label: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      className="mt-3 h-2 overflow-hidden rounded-pill bg-surface-alt"
    >
      <div className="h-full w-1/3 animate-pulse rounded-pill bg-purple" />
    </div>
  );
}

// ---- Mapping ---------------------------------------------------------------------------------

function MappingStep({
  channelId,
  job,
  onAnalyzing,
}: {
  channelId: string;
  job: ImportJob;
  onAnalyzing: () => void;
}) {
  const fields = useQuery(memberFieldsQuery(channelId));
  const save = useSaveImportMapping(channelId);
  const analyze = useAnalyzeImport(channelId);
  const [mapping, setMapping] = useState<Record<string, ImportTarget>>(() =>
    Object.fromEntries(job.columns.map((c) => [c, job.mapping[c] ?? null])),
  );
  const [consent, setConsent] = useState(job.consentAttested);
  const [updateExisting, setUpdateExisting] = useState(job.updateExisting);
  const [touched, setTouched] = useState(false);
  const consentHint = useId();
  const updateHint = useId();
  const fieldList: MemberField[] = fields.data ?? [];
  const check = checkMapping(mapping, fieldList);
  const serverError = save.error instanceof ApiError ? save.error : null;
  const busy = save.isPending || analyze.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!mappingIsValid(check)) return;
    save.mutate(
      { id: job.id, mapping, consentAttested: consent, updateExisting },
      { onSuccess: () => analyze.mutate(job.id, { onSuccess: onAnalyzing }) },
    );
  };

  const rostersOn = useChannelFlag(channelId, 'rosters') === true;
  const options = targetOptions(fieldList, rostersOn);

  return (
    <StepCard title="Map the columns">
      <form onSubmit={submit} className="grid gap-5">
        <p className="max-w-[65ch] text-[13.5px] text-sub">
          Swarm suggested where each column goes. One column must hold email addresses; any number
          of columns can add tags. Columns set to “Don’t import” are skipped.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-left text-[13.5px]">
            <thead>
              <tr className="table-head">
                <th scope="col" className="py-2 pr-3 font-semibold">
                  Column in the file
                </th>
                <th scope="col" className="py-2 font-semibold">
                  Goes to
                </th>
              </tr>
            </thead>
            <tbody>
              {job.columns.map((column) => {
                const problem =
                  (touched ? check.columns[column] : undefined) ??
                  serverError?.field(`mapping.${column}`);
                const errorId = `${job.id}-${column}-error`;
                return (
                  <tr key={column} className="border-t border-line align-top">
                    <th scope="row" className="py-2.5 pr-3 font-mono text-[12.5px] font-normal">
                      {column}
                    </th>
                    <td className="py-2">
                      <select
                        aria-label={`Where “${column}” goes`}
                        aria-invalid={problem ? true : undefined}
                        aria-describedby={problem ? errorId : undefined}
                        value={targetToValue(mapping[column] ?? null)}
                        onChange={(e) =>
                          setMapping((prev) => ({
                            ...prev,
                            [column]: valueToTarget(e.target.value),
                          }))
                        }
                        className={`min-h-10 w-full rounded-control border bg-surface px-3 text-[13.5px] text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-purple ${
                          problem ? 'border-danger' : 'border-line-control'
                        }`}
                      >
                        {options.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      {problem && (
                        <p id={errorId} className="mt-1 text-[12.5px] font-semibold text-danger">
                          {problem}
                        </p>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {touched && check.general && (
          <ErrorNotice title="Check the mapping" message={check.general} />
        )}

        <div className="grid gap-3">
          <div className="rounded-card-app border border-line-app bg-surface-alt p-3.5">
            <label className="flex cursor-pointer items-start gap-2.5 text-[13.5px] font-semibold">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                aria-describedby={consentHint}
                className="mt-0.5 size-4 shrink-0 accent-purple"
              />
              {IMPORT_ATTESTATION_TEXT}
            </label>
            <p id={consentHint} className="mt-1.5 pl-[26px] text-[12.5px] text-sub">
              {consent
                ? 'New subscribers are imported as active and receive the next post. Each one keeps a consent record saying you confirmed this.'
                : 'Without this, new subscribers are imported as pending. No email is sent, and they receive nothing until they confirm.'}
            </p>
          </div>
          <div className="rounded-card-app border border-line-app bg-surface-alt p-3.5">
            <label className="flex cursor-pointer items-start gap-2.5 text-[13.5px] font-semibold">
              <input
                type="checkbox"
                checked={updateExisting}
                onChange={(e) => setUpdateExisting(e.target.checked)}
                aria-describedby={updateHint}
                className="mt-0.5 size-4 shrink-0 accent-purple"
              />
              Update subscribers who are already on the list
            </label>
            <p id={updateHint} className="mt-1.5 pl-[26px] text-[12.5px] text-sub">
              {updateExisting
                ? 'Names and profile fields are replaced with the file’s values and its tags are added. Their status never changes.'
                : 'Subscribers already on the list are left exactly as they are.'}
            </p>
          </div>
        </div>

        {(save.error || analyze.error) && !serverError?.details.length && (
          <ErrorNotice message={(save.error ?? analyze.error)?.message ?? ''} />
        )}
        <div>
          <Button type="submit" loading={busy}>
            Run the dry run
          </Button>
        </div>
      </form>
    </StepCard>
  );
}

// ---- Review ----------------------------------------------------------------------------------

const CLASS_INFO: Record<
  keyof ImportReport['counts'],
  { label: string; detail: string; imported: boolean }
> = {
  new: { label: 'New subscribers', detail: 'Added to the publication.', imported: true },
  updated: {
    label: 'Updated',
    detail: 'Already subscribers; their names, fields or tags change.',
    imported: true,
  },
  unchanged: {
    label: 'Unchanged',
    detail: 'Already subscribers, and nothing in the file changes them.',
    imported: false,
  },
  invalid: { label: 'Invalid', detail: 'Not a usable email address.', imported: false },
  role: {
    label: 'Role addresses',
    detail: 'Addresses like info@ or support@ reach a team, not a person, so they are skipped.',
    imported: false,
  },
  disposable: {
    label: 'Disposable addresses',
    detail: 'Throwaway mailboxes that stop working soon, so they are skipped.',
    imported: false,
  },
  suppressed: {
    label: 'Suppressed',
    detail:
      'Bounced, complained or blocked before. Swarm never mails them again, so they are skipped.',
    imported: false,
  },
  duplicate: {
    label: 'Duplicates',
    detail: 'An earlier row has the same address; only the first counts.',
    imported: false,
  },
};

function ReviewStep({
  channelId,
  job,
  report,
  onEdit,
}: {
  channelId: string;
  job: ImportJob;
  report: ImportReport;
  onEdit: () => void;
}) {
  const confirm = useConfirmImport(channelId);
  const changing = report.counts.new + report.counts.updated;
  const warm = report.warmImport || report.counts.new >= WARM_IMPORT_AT;
  const classes = Object.keys(CLASS_INFO) as (keyof ImportReport['counts'])[];

  return (
    <StepCard title="Review the dry run">
      <p className="text-[13.5px] text-sub">
        {numberFormat.format(report.total)} rows checked. Nothing has been written yet.{' '}
        {job.consentAttested
          ? 'New subscribers will be active.'
          : 'New subscribers will be pending: no email is sent and they receive nothing until they confirm.'}
      </p>

      {report.counts.new > 0 && (
        <div className="mt-4 empty:hidden">
          <ImportWarmup
            channelId={channelId}
            added={report.counts.new}
            becomeActive={job.consentAttested}
            fallback={
              warm ? (
                <div className="rounded-card-app border border-lavender-line bg-lavender px-4 py-3 text-[13.5px] text-purple-deep">
                  <p className="font-semibold">A large import starts warm-up again</p>
                  <p className="mt-0.5">
                    With {numberFormat.format(report.counts.new)} new addresses, a warm-up that had
                    finished goes back to warming: posts reach the new subscribers gradually over
                    the next days, so mailbox providers learn to trust the larger list.
                  </p>
                </div>
              ) : null
            }
          />
        </div>
      )}

      <div className="mt-4 empty:hidden">
        <ImportEmailCheckOption channelId={channelId} job={job} report={report} />
      </div>

      <ul className="mt-4 grid gap-2">
        {classes.map((cls) => (
          <ReportClass
            key={cls}
            label={CLASS_INFO[cls].label}
            detail={CLASS_INFO[cls].detail}
            imported={CLASS_INFO[cls].imported}
            count={report.counts[cls]}
            total={report.total}
            samples={report.samples[cls]}
          />
        ))}
      </ul>

      {report.fieldErrors > 0 && (
        <div className="mt-4">
          <ReportClass
            as="div"
            label="Cells left out"
            detail="These values don’t fit their profile field. The rest of each row still imports."
            imported={false}
            count={report.fieldErrors}
            total={null}
            samples={report.fieldErrorSamples}
          />
        </div>
      )}

      {confirm.error && (
        <div className="mt-4">
          <ErrorNotice message={confirm.error.message} />
        </div>
      )}
      <div className="mt-5 flex flex-wrap gap-2">
        <Button
          loading={confirm.isPending}
          disabled={changing === 0}
          onClick={() => confirm.mutate(job.id)}
        >
          {changing === 0
            ? 'Nothing to import'
            : `Import ${numberFormat.format(changing)} ${changing === 1 ? 'subscriber' : 'subscribers'}`}
        </Button>
        <Button variant="ghost" onClick={onEdit}>
          Change the mapping
        </Button>
      </div>
    </StepCard>
  );
}

function ReportClass({
  label,
  detail,
  imported,
  count,
  total,
  samples,
  as = 'li',
}: {
  label: string;
  detail: string;
  imported: boolean;
  count: number;
  total: number | null;
  samples: ImportReport['fieldErrorSamples'];
  as?: 'li' | 'div';
}) {
  const Tag = as;
  return (
    <Tag className="rounded-card-app border border-line-app px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex items-center gap-2 text-[14px] font-semibold">
          {label}
          {count > 0 && (
            <Pill tone={imported ? 'success' : 'neutral'}>{imported ? 'Imported' : 'Skipped'}</Pill>
          )}
        </span>
        <span className="tabular text-[14px] font-semibold">
          {numberFormat.format(count)}
          {total ? (
            <span className="ml-1.5 font-normal text-sub">
              {percentFormat.format(count / total)}
            </span>
          ) : null}
        </span>
      </div>
      <p className="mt-0.5 text-[12.5px] text-sub">{detail}</p>
      {count > 0 && samples.length > 0 && (
        <details className="mt-2 text-[12.5px]">
          <summary className="cursor-pointer font-semibold text-purple-deep">
            Show {samples.length === 1 ? 'an example' : `${samples.length} examples`}
          </summary>
          <ul className="mt-2 grid gap-1">
            {samples.map((s) => (
              <li key={`${s.line}-${s.email}`} className="grid gap-0.5 sm:flex sm:gap-2">
                <span className="tabular text-sub">Line {numberFormat.format(s.line)}</span>
                <span className="font-mono break-all">{s.email || '(empty)'}</span>
                {s.reason && <span className="text-sub">{s.reason}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Tag>
  );
}

// ---- Progress and summary ----------------------------------------------------------------------

function ProgressStep({ job }: { job: ImportJob }) {
  const fraction = job.totalRows ? job.processedRows / job.totalRows : 0;
  return (
    <StepCard title="Importing">
      <ImportEmailCheckProgress job={job} />
      <div
        role="status"
        aria-live="polite"
        className="flex items-baseline justify-between text-[13.5px]"
      >
        <span className="tabular font-semibold">
          {numberFormat.format(job.processedRows)} of {numberFormat.format(job.totalRows)} rows
        </span>
        <span className="tabular text-sub">{percentFormat.format(fraction)}</span>
      </div>
      <div
        role="progressbar"
        aria-label="Import progress"
        aria-valuemin={0}
        aria-valuemax={job.totalRows}
        aria-valuenow={job.processedRows}
        className="mt-2 h-2 overflow-hidden rounded-pill bg-surface-alt"
      >
        <div
          className="h-full rounded-pill bg-purple transition-[width]"
          style={{ width: `${Math.min(100, fraction * 100)}%` }}
        />
      </div>
      <p className="mt-3 text-[13px] text-sub">
        You can leave this page; the import carries on and resumes after interruptions.
      </p>
    </StepCard>
  );
}

function DoneStep({
  channelId,
  job,
  onRestart,
}: {
  channelId: string;
  job: ImportJob;
  onRestart: () => void;
}) {
  const result = job.report?.result;
  return (
    <StepCard title="Import finished">
      <div role="status">
        {result ? (
          <dl className="grid grid-cols-3 gap-3 sm:max-w-md">
            {(
              [
                ['Added', result.created],
                ['Updated', result.updated],
                ['Skipped', result.skipped],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="rounded-card-app border border-line-app px-3 py-2.5">
                <dt className="text-[12px] text-sub">{label}</dt>
                <dd className="tabular text-[20px] font-bold">{numberFormat.format(value)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-[13.5px] text-sub">Every row was handled.</p>
        )}
        <p className="mt-3 text-[13px] text-sub">
          Imported subscribers carry the tag <code className="font-mono">import:{job.id}</code>, so
          you can find them later.
        </p>
        {job.report && <ImportEmailCheckReport report={job.report} />}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link to="/members" search={{ channel: channelId }} className="btn-primary btn-sm">
          View subscribers
        </Link>
        <Button variant="ghost" size="sm" onClick={onRestart}>
          Import another file
        </Button>
      </div>
    </StepCard>
  );
}

// ---- Recent imports --------------------------------------------------------------------------

const IMPORT_STATUS: Record<
  ImportJob['status'],
  { label: string; tone: 'success' | 'neutral' | 'scheduled' | 'danger' | 'brand' }
> = {
  uploaded: { label: 'Needs mapping', tone: 'brand' },
  analyzing: { label: 'Dry run', tone: 'scheduled' },
  analyzed: { label: 'Ready to review', tone: 'brand' },
  importing: { label: 'Importing', tone: 'scheduled' },
  done: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  canceled: { label: 'Canceled', tone: 'neutral' },
};

function RecentImports({ channelId, onOpen }: { channelId: string; onOpen: (id: string) => void }) {
  const imports = useQuery(importsQuery(channelId));
  const titleId = useId();
  if (!imports.data?.length && !imports.error) return null;
  return (
    <section aria-labelledby={titleId} className="card-app overflow-x-auto">
      <h2 id={titleId} className="px-5 pt-5 text-[16px] font-semibold">
        Recent imports
      </h2>
      {imports.error && (
        <div className="p-5">
          <ErrorNotice message={imports.error.message} />
        </div>
      )}
      {!!imports.data?.length && (
        <table className="mt-2 w-full min-w-[560px] text-left text-[13.5px]">
          <thead>
            <tr className="table-head">
              <th scope="col" className="px-5 py-3 font-semibold">
                File
              </th>
              <th scope="col" className="px-3 py-3 font-semibold">
                Status
              </th>
              <th scope="col" className="px-3 py-3 font-semibold">
                Rows
              </th>
              <th scope="col" className="px-5 py-3 font-semibold">
                Uploaded
              </th>
            </tr>
          </thead>
          <tbody>
            {imports.data.map((item) => (
              <tr key={item.id} className="border-t border-line">
                <td className="px-5 py-2">
                  <button
                    type="button"
                    onClick={() => onOpen(item.id)}
                    className="min-h-9 text-left font-semibold break-all text-ink hover:text-purple-deep hover:underline"
                  >
                    {item.fileName}
                  </button>
                </td>
                <td className="px-3 py-2">
                  <Pill tone={IMPORT_STATUS[item.status].tone}>
                    {IMPORT_STATUS[item.status].label}
                  </Pill>
                </td>
                <td className="tabular px-3 py-2 text-sub">
                  {item.report ? numberFormat.format(item.report.total) : '—'}
                </td>
                <td className="tabular px-5 py-2 text-sub">{formatDay(item.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
