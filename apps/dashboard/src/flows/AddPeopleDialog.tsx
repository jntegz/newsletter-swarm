// Add people: a segment or chosen subscribers into a live automation. The count comes first, with
// who is left out and why, and the button names the number. A bulk job does the rest.
import {
  BULK_MAX_MEMBERS,
  type BulkSelection,
  type Flow,
  type FlowEnrolPreview,
} from '@swarm/domain';
import { Button, Dialog, ErrorNotice, LoadingRows, TextField } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useDebounced } from '../api/circles';
import { useAddPeople, usePreviewPeople } from '../api/flows';
import { membersQuery, useBulkJob } from '../api/members';
import type { Lookups } from './lookups';
import { addButtonText, addedSentence, enteringSentence, skippedSentence } from './rehearse';
import { SelectField } from './Select';

export function AddPeopleDialog({
  flow,
  lookups,
  onClose,
}: {
  flow: Flow;
  lookups: Lookups;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'circle' | 'members'>('circle');
  const [circleId, setCircleId] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const search = useDebounced(q, 300);
  const members = useQuery({
    ...membersQuery(flow.channelId, { q: search }),
    enabled: mode === 'members',
  });
  const [preview, setPreview] = useState<FlowEnrolPreview | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const count = usePreviewPeople(flow.id);
  const add = useAddPeople(flow.id);
  const { job, error: jobError } = useBulkJob(flow.channelId, jobId);

  const selection: BulkSelection | null =
    mode === 'circle'
      ? circleId
        ? { circleId }
        : null
      : chosen.length
        ? { memberIds: chosen }
        : null;
  const changeSelection = (change: () => void) => {
    change();
    setPreview(null);
    count.reset();
    add.reset();
  };

  if (jobId) {
    const running = !job || job.status === 'queued' || job.status === 'running';
    return (
      <Dialog
        open
        onClose={onClose}
        title={running ? 'Adding people' : job.status === 'failed' ? 'Stopped' : 'People added'}
        actions={<Button onClick={onClose}>Close</Button>}
      >
        <div role="status" aria-live="polite" className="text-[13.5px]">
          {jobError && <ErrorNotice message={jobError.message} />}
          {job && running && (
            <p>
              Checked {job.processed} of {job.total}. {addedSentence(job.entered)}
            </p>
          )}
          {job?.status === 'done' && (
            <>
              <p>{addedSentence(job.entered)}</p>
              {job.entered < job.total && (
                <p className="mt-1 text-sub">
                  The rest were left out by the same rules as before. Check the Runs tab to see who
                  is in.
                </p>
              )}
            </>
          )}
          {job?.status === 'failed' && (
            <p>The automation stopped being live, so nobody else was added.</p>
          )}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add people to this automation"
      description={`They start live version ${flow.liveVersion} now, and get its emails. Inbox rules apply as for anyone else.`}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {preview && preview.entering > 0 ? (
            <Button
              loading={add.isPending}
              onClick={() =>
                selection &&
                add.mutate(
                  { selection, confirmCount: preview.entering },
                  {
                    onSuccess: (started) => setJobId(started.id),
                    // The count moved since it was shown: show the new one before asking again.
                    onError: () => setPreview(null),
                  },
                )
              }
            >
              {addButtonText(preview.entering)}
            </Button>
          ) : (
            <Button
              disabled={!selection || (!!preview && preview.entering === 0)}
              loading={count.isPending}
              onClick={() =>
                selection && count.mutate({ selection }, { onSuccess: (p) => setPreview(p) })
              }
            >
              Count who would enter
            </Button>
          )}
        </>
      }
    >
      <SelectField
        label="Who to add"
        value={mode}
        onChange={(e) => changeSelection(() => setMode(e.target.value as 'circle' | 'members'))}
      >
        <option value="circle">A segment</option>
        <option value="members">Chosen subscribers</option>
      </SelectField>
      {mode === 'circle' ? (
        <div className="mt-3">
          <SelectField
            label="Segment"
            value={circleId}
            onChange={(e) => changeSelection(() => setCircleId(e.target.value))}
          >
            <option value="">Choose a segment</option>
            {lookups.circles.map((circle) => (
              <option key={circle.id} value={circle.id}>
                {circle.name}
              </option>
            ))}
          </SelectField>
        </div>
      ) : (
        <div className="mt-3">
          <TextField
            label="Find subscribers"
            type="search"
            placeholder="Email or name"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="mt-2 max-h-44 overflow-y-auto">
            {members.isPending && <LoadingRows label="Loading subscribers" rows={2} />}
            {members.error && <ErrorNotice message={members.error.message} />}
            {members.data?.items.length === 0 && (
              <p className="text-[13px] text-sub">No subscribers match.</p>
            )}
            {!!members.data?.items.length && (
              <fieldset>
                <legend className="sr-only">Subscribers</legend>
                <ul className="grid gap-0.5">
                  {members.data.items.map((m) => (
                    <li key={m.id}>
                      <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded-[10px] px-2 text-[13px] hover:bg-surface-alt">
                        <input
                          type="checkbox"
                          className="size-4 accent-purple"
                          checked={chosen.includes(m.id)}
                          disabled={!chosen.includes(m.id) && chosen.length >= BULK_MAX_MEMBERS}
                          onChange={(e) =>
                            changeSelection(() =>
                              setChosen((list) =>
                                e.target.checked
                                  ? [...list, m.id]
                                  : list.filter((id) => id !== m.id),
                              ),
                            )
                          }
                        />
                        <span className="min-w-0 truncate">{m.email}</span>
                        <span className="ml-auto text-[12px] text-sub">{m.status}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
            )}
          </div>
          {chosen.length > 0 && (
            <p className="mt-1 text-[12.5px] text-sub">
              {chosen.length === 1
                ? '1 subscriber chosen.'
                : `${chosen.length} subscribers chosen.`}
            </p>
          )}
        </div>
      )}
      <div role="status" aria-live="polite" className="mt-3 empty:hidden">
        {preview && (
          <div className="rounded-card-app bg-surface-alt px-3 py-2 text-[13.5px]">
            <p className="font-semibold">{enteringSentence(preview.entering)}</p>
            {preview.skipped.length > 0 && (
              <>
                <p className="mt-1 text-[13px] text-sub">Some can’t enter:</p>
                <ul className="mt-0.5 grid list-disc gap-0.5 pl-4 text-[13px] text-sub">
                  {preview.skipped.map((s) => (
                    <li key={s.reason}>{skippedSentence(s.reason, s.count)}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
        {count.error && <ErrorNotice title="Could not count" message={count.error.message} />}
        {add.error && <ErrorNotice title="Nobody was added" message={add.error.message} />}
      </div>
    </Dialog>
  );
}
