// Settings → Instance: the install's own audit log (instance_audit_events, 0113), read only.
// Every change an instance admin makes to an install-wide setting, newest first, a page at a time,
// and whether the hash chain still verifies from the first entry (the API checks it on each read).
import type { InstanceAudit as InstanceAuditData } from '@swarm/domain';
import { Button, ErrorNotice, LoadingRows } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { instanceAuditQuery } from '../api/instance';
import { useSession } from '../session';
import { formatDateTime, numberFormat } from './common';

type Entry = InstanceAuditData['items'][number];

const ACTION_LABEL: Record<string, string> = {
  'instance.setting_changed': 'Changed an install-wide setting',
};

/** What each changing route is about, by the path it was asked at. */
const TARGETS: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^\/api\/v1\/instance\/settings$/, () => 'Who can sign up'],
  [/^\/api\/v1\/instance\/sending-limits$/, () => 'Sending limits'],
  [/^\/api\/v1\/instance\/features\/([^/]+)$/, (m) => `Feature ${decodeURIComponent(m[1]!)}`],
  [/^\/api\/v1\/instance\/site-code$/, () => 'Website code, every workspace'],
  [/^\/api\/v1\/instance\/site-code\/workspaces\/([^/]+)$/, (m) => `Website code, ${m[1]}`],
  [/^\/api\/v1\/instance\/email-checks$/, () => 'DeBounce, every workspace'],
  [/^\/api\/v1\/instance\/email-checks\/workspaces\/([^/]+)$/, (m) => `DeBounce, ${m[1]}`],
];

function target(entry: Entry): string {
  const path = typeof entry.metadata.path === 'string' ? entry.metadata.path : '';
  for (const [pattern, label] of TARGETS) {
    const match = pattern.exec(path);
    if (match) return label(match);
  }
  const method = typeof entry.metadata.method === 'string' ? `${entry.metadata.method} ` : '';
  return path ? `${method}${path}` : '—';
}

const shown = (value: unknown) =>
  typeof value === 'string' ? value : value === null ? 'empty' : JSON.stringify(value);

/** The fields the change asked for, with their values (secret-like ones were never recorded). */
function changedFields(entry: Entry): string[] {
  const request = entry.metadata.request;
  if (!request || typeof request !== 'object' || Array.isArray(request)) return [];
  return Object.entries(request as Record<string, unknown>).map(([key, value]) =>
    `${key}: ${shown(value)}`.slice(0, 200),
  );
}

function Fields({ entry }: { entry: Entry }) {
  const fields = changedFields(entry);
  if (!fields.length) return <span className="text-sub">—</span>;
  return (
    <ul className="grid gap-0.5 break-all">
      {fields.map((field) => (
        <li key={field} className="font-mono text-[12.5px]">
          {field}
        </li>
      ))}
    </ul>
  );
}

function Verification({ verification }: { verification: InstanceAuditData['verification'] }) {
  return (
    <p role="status" className="text-[13px]">
      {verification.ok ? (
        <span className="text-success">
          Intact · {numberFormat.format(verification.checked)} entries checked
        </span>
      ) : (
        <span className="font-semibold text-danger">
          Altered entries found
          {verification.brokenAtSeq !== null ? `, from entry ${verification.brokenAtSeq}` : ''}
        </span>
      )}
    </p>
  );
}

export function InstanceAudit() {
  const { me } = useSession();
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const audit = useQuery({ ...instanceAuditQuery(cursor), enabled: me.instanceAdmin });
  if (!me.instanceAdmin) return null;
  const next = audit.data?.nextCursor ?? null;

  return (
    <section aria-labelledby="instance-audit-title" className="card-app overflow-x-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
        <div>
          <h2 id="instance-audit-title" className="text-[16px] font-semibold">
            Instance audit log
          </h2>
          <p className="text-[13px] text-sub">
            Every change to this Swarm’s install-wide settings, chained so edits to past entries are
            detectable.
          </p>
        </div>
        {audit.data && <Verification verification={audit.data.verification} />}
      </div>
      {audit.isPending && (
        <div className="p-5">
          <LoadingRows label="Loading instance audit log" rows={4} />
        </div>
      )}
      {audit.error && (
        <div className="p-5">
          <ErrorNotice message={audit.error.message} />
        </div>
      )}
      {audit.data && audit.data.items.length === 0 && (
        <p className="px-5 pt-4 text-[13px] text-sub">No changes yet.</p>
      )}
      {audit.data && audit.data.items.length > 0 && (
        <>
          <ol className="mt-3 divide-y divide-line border-t border-line sm:hidden">
            {audit.data.items.map((entry) => (
              <li key={entry.seq} className="grid gap-1 px-5 py-3 text-[13.5px]">
                <span className="font-semibold">
                  {ACTION_LABEL[entry.action] ?? entry.action} · {target(entry)}
                </span>
                <span className="block text-[12.5px] break-all text-sub">
                  {entry.actorEmail ?? 'System'} ·{' '}
                  <span className="tabular">{formatDateTime(entry.at)}</span>
                </span>
                <Fields entry={entry} />
              </li>
            ))}
          </ol>
          <table className="mt-3 w-full text-left text-[13.5px] max-sm:hidden">
            <thead>
              <tr className="table-head">
                <th scope="col" className="px-5 py-2.5 font-semibold">
                  When
                </th>
                <th scope="col" className="px-3 py-2.5 font-semibold">
                  Who
                </th>
                <th scope="col" className="px-3 py-2.5 font-semibold">
                  What
                </th>
                <th scope="col" className="px-3 py-2.5 font-semibold">
                  Setting
                </th>
                <th scope="col" className="px-5 py-2.5 font-semibold">
                  Changed fields
                </th>
              </tr>
            </thead>
            <tbody>
              {audit.data.items.map((entry) => (
                <tr key={entry.seq} className="border-t border-line align-top">
                  <td className="tabular px-5 py-3 whitespace-nowrap text-sub">
                    {formatDateTime(entry.at)}
                  </td>
                  <td className="px-3 py-3 break-all">{entry.actorEmail ?? 'System'}</td>
                  <td className="px-3 py-3">{ACTION_LABEL[entry.action] ?? entry.action}</td>
                  <td className="px-3 py-3 break-all">{target(entry)}</td>
                  <td className="px-5 py-3">
                    <Fields entry={entry} />
                  </td>
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
          disabled={!next}
          onClick={() => next && setCursors((c) => [...c, next])}
        >
          Older
        </Button>
      </div>
    </section>
  );
}
