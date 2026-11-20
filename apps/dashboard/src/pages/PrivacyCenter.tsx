// Settings → Privacy Center: the queue of data requests (exports and erasures) with their SLA
// timers, filing one on behalf of a person, and approve, reject or retry. Admins and owners only.
import {
  SUBPROCESSORS_URL,
  type DsrKind,
  type DsrRequest,
  type DsrSource,
  type DsrStatus,
} from '@swarm/domain';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  Pill,
  SelectField,
  TextAreaField,
  TextField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import {
  privacyRequestsQuery,
  useApprovePrivacyRequest,
  useCreatePrivacyRequest,
  useRejectPrivacyRequest,
  useRetryPrivacyRequest,
} from '../api/privacy';
import { useSession } from '../session';
import { formatDateTime } from './common';
import { dueLabel } from './privacy-helpers';

/**
 * Downloads a finished export (a POST, because each download is audited). For an address that
 * can't receive email this is the only way the person gets their copy.
 */
function DownloadExport({ workspaceId, request }: { workspaceId: string; request: DsrRequest }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const download = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(
        `/api/v1/workspaces/${workspaceId}/privacy/requests/${request.id}/download`,
        { method: 'POST', credentials: 'same-origin' },
      );
      if (!res.ok) throw new Error(String(res.status));
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `data-request-${request.createdAt.slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="grid justify-items-end gap-1">
      <Button size="sm" variant="ghost" loading={busy} onClick={() => void download()}>
        Download file
      </Button>
      {failed && (
        <span role="status" className="text-[12px] font-semibold text-danger">
          The download did not work. Try again.
        </span>
      )}
    </span>
  );
}

const KIND_LABEL: Record<DsrKind, string> = { export: 'Export', erase: 'Erasure' };
const SOURCE_LABEL: Record<DsrSource, string> = {
  member_center: 'Subscriber settings',
  member_center_unverified: 'Subscriber settings, unverified link',
  operator: 'Your team',
  api: 'API',
  address_form: 'Request page, confirmed by email',
};
/** A footer link proves nothing about who holds it: anyone it was forwarded to can file this. */
const UNVERIFIED_WARNING =
  'This came from a link that may have been forwarded. Confirm with the person another way before erasing.';

function UnverifiedWarning({ request }: { request: DsrRequest }) {
  if (request.source !== 'member_center_unverified' || request.status !== 'pending') return null;
  return (
    <p className="mt-1 max-w-[320px] text-[12.5px] font-semibold text-danger">
      {UNVERIFIED_WARNING}
    </p>
  );
}
const STATUS_PILL: Record<
  DsrStatus,
  { tone: 'success' | 'scheduled' | 'brand' | 'neutral' | 'danger'; label: string }
> = {
  pending: { tone: 'brand', label: 'Waiting for approval' },
  processing: { tone: 'scheduled', label: 'In progress' },
  completed: { tone: 'success', label: 'Done' },
  rejected: { tone: 'neutral', label: 'Rejected' },
  failed: { tone: 'danger', label: 'Failed' },
};

const STATUS_OPTIONS = [
  { value: '', label: 'Any status' },
  ...(Object.keys(STATUS_PILL) as DsrStatus[]).map((s) => ({
    value: s,
    label: STATUS_PILL[s].label,
  })),
];
const KIND_OPTIONS = [
  { value: '', label: 'Exports and erasures' },
  { value: 'export', label: 'Exports' },
  { value: 'erase', label: 'Erasures' },
];

type Decision = { kind: 'approve' | 'reject'; request: DsrRequest } | null;

export function PrivacySettings() {
  const { workspace, can } = useSession();
  if (!can('admin')) {
    return (
      <EmptyState title="Admins only">
        Ask an owner or admin if someone wants a copy of their data or wants it deleted.
      </EmptyState>
    );
  }
  return <PrivacyCenter workspaceId={workspace.id} />;
}

function PrivacyCenter({ workspaceId }: { workspaceId: string }) {
  const [status, setStatus] = useState<DsrStatus | ''>('');
  const [kind, setKind] = useState<DsrKind | ''>('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const requests = useQuery(
    privacyRequestsQuery(workspaceId, {
      cursor,
      status: status || undefined,
      kind: kind || undefined,
    }),
  );
  const retry = useRetryPrivacyRequest(workspaceId);
  const [creating, setCreating] = useState(false);
  const [decision, setDecision] = useState<Decision>(null);
  const [dialogKey, setDialogKey] = useState(0);
  // Timers count from when the queue was last fetched (every 30 seconds while it's open).
  const now = requests.dataUpdatedAt;
  const filtered = !!status || !!kind;
  const resetPages = () => setCursors([null]);

  const actions = (request: DsrRequest) => (
    <div className="flex flex-wrap justify-end gap-1.5">
      {request.status === 'pending' && (
        <>
          <Button
            size="sm"
            onClick={() => {
              setDialogKey((k) => k + 1);
              setDecision({ kind: 'approve', request });
            }}
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDialogKey((k) => k + 1);
              setDecision({ kind: 'reject', request });
            }}
          >
            Reject
          </Button>
        </>
      )}
      {request.status === 'failed' && (
        <Button
          size="sm"
          variant="ghost"
          loading={retry.isPending && retry.variables === request.id}
          onClick={() => retry.mutate(request.id)}
        >
          Retry
        </Button>
      )}
      {request.kind === 'export' &&
        request.status === 'completed' &&
        request.exportExpiresAt &&
        Date.parse(request.exportExpiresAt) > now && (
          <DownloadExport workspaceId={workspaceId} request={request} />
        )}
    </div>
  );

  return (
    <div className="grid gap-6">
      <section aria-labelledby="privacy-title" className="card-app overflow-x-auto">
        <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
          <div className="max-w-[640px]">
            <h2 id="privacy-title" className="text-[16px] font-semibold">
              Privacy Center
            </h2>
            <p className="mt-1 text-[13px] leading-[1.5] text-sub">
              Requests from people for a copy of their data or for its deletion, across every
              publication in this workspace. Exports are due within 24 hours and erasures within 30
              days. Requests made from subscriber settings run on their own; ones you file wait for
              an approval.{' '}
              <a href={SUBPROCESSORS_URL} target="_blank" rel="noopener noreferrer">
                Subprocessors
              </a>
            </p>
          </div>
          <Button
            onClick={() => {
              setDialogKey((k) => k + 1);
              setCreating(true);
            }}
          >
            New request
          </Button>
        </div>

        <div className="flex flex-wrap gap-3 px-5 pt-4">
          <div className="w-[200px]">
            <SelectField
              label="Status"
              value={status}
              options={STATUS_OPTIONS}
              onChange={(e) => {
                setStatus(e.target.value as DsrStatus | '');
                resetPages();
              }}
            />
          </div>
          <div className="w-[200px]">
            <SelectField
              label="Kind"
              value={kind}
              options={KIND_OPTIONS}
              onChange={(e) => {
                setKind(e.target.value as DsrKind | '');
                resetPages();
              }}
            />
          </div>
        </div>

        {retry.error && (
          <div className="px-5 pt-3">
            <ErrorNotice title="Not retried" message={retry.error.message} />
          </div>
        )}
        {requests.isPending && (
          <div className="p-5">
            <LoadingRows label="Loading requests" rows={4} />
          </div>
        )}
        {requests.error && (
          <div className="p-5">
            <ErrorNotice
              message={requests.error.message}
              action={
                <Button variant="ghost" size="sm" onClick={() => void requests.refetch()}>
                  Try again
                </Button>
              }
            />
          </div>
        )}
        {requests.data?.items.length === 0 && (
          <div className="p-5">
            <EmptyState title={filtered ? 'No requests match' : 'No data requests yet'}>
              {filtered
                ? 'Change the filters to see other requests.'
                : 'When someone asks for their data or its deletion from their subscriber settings, or you file a request for them, it shows here with its due date.'}
            </EmptyState>
          </div>
        )}

        {!!requests.data?.items.length && (
          <>
            <ol className="mt-3 divide-y divide-line border-t border-line sm:hidden">
              {requests.data.items.map((request) => (
                <li key={request.id} className="grid gap-1.5 px-5 py-3 text-[13.5px]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold">{KIND_LABEL[request.kind]}</span>
                    <Pill tone={STATUS_PILL[request.status].tone}>
                      {STATUS_PILL[request.status].label}
                    </Pill>
                  </div>
                  <Person request={request} />
                  <UnverifiedWarning request={request} />
                  <Due request={request} now={now} />
                  {actions(request)}
                </li>
              ))}
            </ol>
            <table className="mt-3 w-full min-w-[760px] text-left text-[13.5px] max-sm:hidden">
              <thead>
                <tr className="table-head">
                  <th scope="col" className="px-5 py-2.5 font-semibold">
                    Request
                  </th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">
                    Person
                  </th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">
                    Due
                  </th>
                  <th scope="col" className="px-5 py-2.5 text-right font-semibold">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {requests.data.items.map((request) => (
                  <tr key={request.id} className="border-t border-line align-top">
                    <td className="px-5 py-3">
                      <span className="font-semibold">{KIND_LABEL[request.kind]}</span>
                      <span className="block text-[12px] text-sub">
                        {SOURCE_LABEL[request.source]} ·{' '}
                        <span className="tabular">{formatDateTime(request.createdAt)}</span>
                      </span>
                      <UnverifiedWarning request={request} />
                    </td>
                    <td className="px-3 py-3">
                      <Person request={request} />
                    </td>
                    <td className="px-3 py-3">
                      <Pill tone={STATUS_PILL[request.status].tone}>
                        {STATUS_PILL[request.status].label}
                      </Pill>
                      {request.error && request.status !== 'completed' && (
                        <span className="mt-1 block max-w-[220px] text-[12px] text-sub">
                          {request.error}
                        </span>
                      )}
                      {request.note && (
                        <span className="mt-1 block max-w-[260px] text-[12px] text-sub">
                          {request.note}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <Due request={request} now={now} />
                    </td>
                    <td className="px-5 py-3">{actions(request)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
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
            disabled={!requests.data?.nextCursor}
            onClick={() =>
              requests.data?.nextCursor && setCursors((c) => [...c, requests.data.nextCursor])
            }
          >
            Older
          </Button>
        </div>
      </section>

      <NewRequestDialog
        key={`new-${dialogKey}`}
        workspaceId={workspaceId}
        open={creating}
        onClose={() => setCreating(false)}
      />
      <DecisionDialog
        key={`decide-${dialogKey}`}
        workspaceId={workspaceId}
        decision={decision}
        onClose={() => setDecision(null)}
      />
    </div>
  );
}

function Person({ request }: { request: DsrRequest }) {
  if (request.member) return <span className="break-all">{request.member.email}</span>;
  return (
    <span className="text-sub">
      Address erased · <span className="tabular">{request.emailHash.slice(0, 12)}</span>
    </span>
  );
}

function Due({ request, now }: { request: DsrRequest; now: number }) {
  const label = dueLabel(request, now);
  return (
    <span className={`tabular ${request.overdue ? 'font-semibold text-danger' : 'text-sub'}`}>
      {label}
    </span>
  );
}

function NewRequestDialog({
  workspaceId,
  open,
  onClose,
}: {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
}) {
  const create = useCreatePrivacyRequest(workspaceId);
  const [email, setEmail] = useState('');
  const [kind, setKind] = useState<DsrKind>('export');
  const [note, setNote] = useState('');
  const error = create.error instanceof ApiError ? create.error : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { email, kind, ...(note.trim() ? { note: note.trim() } : {}) },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New data request"
      description="For someone who asked by email or another way. It covers every subscriber with the address in this workspace, and waits for an approval before it runs."
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="new-privacy-request" loading={create.isPending}>
            File request
          </Button>
        </>
      }
    >
      <form id="new-privacy-request" onSubmit={submit} className="grid gap-4">
        <TextField
          label="Their email"
          type="email"
          required
          autoComplete="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={error?.field('email')}
        />
        <SelectField
          label="They asked for"
          value={kind}
          options={[
            { value: 'export', label: 'A copy of their data' },
            { value: 'erase', label: 'Their data to be deleted' },
          ]}
          onChange={(e) => setKind(e.target.value as DsrKind)}
        />
        <TextAreaField
          label="Note (optional)"
          maxLength={500}
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          hint="For your team, for example how you checked who asked. Don’t include the address."
        />
        {error && !error.details.length && <ErrorNotice message={error.message} />}
      </form>
    </Dialog>
  );
}

function DecisionDialog({
  workspaceId,
  decision,
  onClose,
}: {
  workspaceId: string;
  decision: Decision;
  onClose: () => void;
}) {
  const approve = useApprovePrivacyRequest(workspaceId);
  const reject = useRejectPrivacyRequest(workspaceId);
  const [note, setNote] = useState('');
  const [typed, setTyped] = useState('');
  const request = decision?.request;
  const erasing = decision?.kind === 'approve' && request?.kind === 'erase';
  const pending = approve.isPending || reject.isPending;
  const error =
    (approve.error ?? reject.error) instanceof ApiError
      ? ((approve.error ?? reject.error) as ApiError)
      : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!decision || !request) return;
    if (decision.kind === 'reject') {
      reject.mutate({ id: request.id, note: note.trim() }, { onSuccess: onClose });
      return;
    }
    approve.mutate(
      {
        id: request.id,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(erasing ? { confirm: 'erase' as const } : {}),
      },
      { onSuccess: onClose },
    );
  };

  const person = request?.member?.email ?? 'this person';
  return (
    <Dialog
      open={!!decision}
      onClose={onClose}
      title={
        decision?.kind === 'reject'
          ? 'Reject this request?'
          : erasing
            ? `Erase ${person}?`
            : `Send ${person} their data?`
      }
      description={
        decision?.kind === 'reject'
          ? 'Say why. The reason stays with the request for your records.'
          : erasing
            ? 'Every subscriber with this address, in every publication, is deleted with their history. Stats keep their counts. The address can’t be added again. This can’t be undone.'
            : 'Swarm gathers everything held about the address and emails them a download link that works for 7 days.'
      }
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="privacy-decision"
            variant={erasing || decision?.kind === 'reject' ? 'danger' : 'primary'}
            loading={pending}
            disabled={erasing && typed.trim() !== 'erase'}
          >
            {decision?.kind === 'reject' ? 'Reject' : erasing ? 'Erase for good' : 'Approve'}
          </Button>
        </>
      }
    >
      <form id="privacy-decision" onSubmit={submit} className="grid gap-4">
        {erasing && request?.source === 'member_center_unverified' && (
          <div
            role="alert"
            className="rounded-[12px] bg-danger-soft px-3 py-2 text-[13px] font-semibold text-danger"
          >
            {UNVERIFIED_WARNING}
          </div>
        )}
        {erasing && (
          <TextField
            label="Type erase to confirm"
            required
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            error={error?.field('confirm')}
          />
        )}
        <TextAreaField
          label={decision?.kind === 'reject' ? 'Reason' : 'Note (optional)'}
          required={decision?.kind === 'reject'}
          maxLength={500}
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          error={error?.field('note')}
        />
        {error && !error.details.length && <ErrorNotice message={error.message} />}
      </form>
    </Dialog>
  );
}
