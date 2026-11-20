// Warm-up, said where it matters outside its own section: Home, the import review, the send panel
// and the send report. The words come from ./warmup-notes; this file fetches the ramp and renders.
import type { Ramp } from '@swarm/domain';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { memberCountsQuery } from '../api/members';
import { rampsQuery, sendersQuery } from '../api/send';
import * as Icon from '../icons';
import { useCadence } from './useCadence';
import { primaryRamp } from './warmup-helpers';
import { WARMUP_ANCHOR, importWarmupNote, reportWarmupNote, type WarmupNote } from './warmup-notes';

function WarmupLink({
  channelId,
  className = 'font-semibold underline underline-offset-2',
  children,
}: {
  channelId: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      to="/channels/$channelId/sending"
      params={{ channelId }}
      hash={WARMUP_ANCHOR}
      className={className}
    >
      {children}
    </Link>
  );
}

/**
 * One warm-up note: a title, what it means, what to do and the way to the plan. A paused warm-up
 * is announced; the rest is information next to the thing it is about.
 */
export function WarmupCallout({
  note,
  channelId,
  compact = false,
  className = '',
}: {
  note: WarmupNote;
  channelId: string;
  /** For the narrow send panel: smaller type, no icon column. */
  compact?: boolean;
  className?: string;
}) {
  const paused = note.tone === 'paused';
  const List = paused && note.tips.length > 1 ? 'ol' : 'ul';
  return (
    <div
      role={paused ? 'status' : 'note'}
      aria-label={paused ? undefined : 'Warm-up'}
      className={`min-w-0 rounded-card-app border ${compact ? 'px-3 py-2.5 text-[13px]' : 'px-4 py-3.5 text-[13.5px]'} leading-[1.55] ${
        paused ? 'border-danger bg-danger-soft' : 'border-line-app bg-surface-alt'
      } ${className}`}
    >
      <p
        className={`flex items-start gap-1.5 font-semibold ${paused ? 'text-danger-ink' : 'text-ink'}`}
      >
        {paused ? (
          <Icon.Alert size={16} className="mt-[3px] shrink-0" />
        ) : (
          <Icon.Clock size={16} className="mt-[3px] shrink-0 text-sub" />
        )}
        <span className="min-w-0 [overflow-wrap:anywhere]">{note.title}</span>
      </p>
      <p className="mt-1 max-w-[76ch] text-ink">{note.body}</p>
      {note.tips.length > 0 && (
        <List
          className={`mt-2 grid max-w-[76ch] gap-1 pl-5 ${paused ? 'text-ink' : 'text-sub'} ${
            List === 'ol' ? 'list-decimal' : 'list-disc'
          }`}
        >
          {note.tips.map((tip) => (
            <li key={tip}>{tip}</li>
          ))}
        </List>
      )}
      <p className="mt-2">
        <WarmupLink channelId={channelId}>{note.link}</WarmupLink>
      </p>
    </div>
  );
}

/** The ramp a sender uses: its own domain's, else the shared one. Null until the ramps load. */
export function rampOfDomain(
  ramps: Ramp[] | undefined,
  sendingDomainId: string | null,
): Ramp | null {
  return ramps?.find((r) => r.sendingDomainId === sendingDomainId) ?? null;
}

/**
 * The import review. Says nothing while it loads or when the import changes nothing; `fallback`
 * shows when warm-up could not be read.
 */
export function ImportWarmup({
  channelId,
  added,
  becomeActive,
  fallback,
}: {
  channelId: string;
  added: number;
  becomeActive: boolean;
  fallback: ReactNode;
}) {
  const ramps = useQuery(rampsQuery(channelId));
  const senders = useQuery(sendersQuery(channelId));
  const counts = useQuery(memberCountsQuery(channelId));
  const [cadence] = useCadence(channelId);
  if (ramps.error || counts.error) return <>{fallback}</>;
  if (!ramps.data || !counts.data) return null;
  const ramp = primaryRamp(ramps.data, senders.data?.find((s) => s.isDefault)?.sendingDomainId);
  const note = importWarmupNote(ramp, { active: counts.data.active, added, becomeActive }, cadence);
  return note ? <WarmupCallout note={note} channelId={channelId} /> : null;
}

/** The send report of a post still going out. The ramp is the one of the address it comes from. */
export function ReportWarmup({
  channelId,
  fromAddress,
  total,
  handled,
}: {
  channelId: string;
  fromAddress: string;
  total: number;
  handled: number;
}) {
  // The day's count moves while the post goes out, so this is read again now and then.
  const ramps = useQuery({ ...rampsQuery(channelId), refetchInterval: 30_000 });
  const domain = fromAddress.slice(fromAddress.lastIndexOf('@') + 1).toLowerCase();
  const ramp = ramps.data?.find((r) => r.domain.toLowerCase() === domain) ?? null;
  const note = reportWarmupNote(ramp, total, handled);
  return note ? <WarmupCallout note={note} channelId={channelId} className="mt-4" /> : null;
}
