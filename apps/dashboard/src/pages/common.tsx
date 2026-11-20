// Pieces shared by the Phase 2 pages: the publication wrapper, status pills and formatting.
import type { BroadcastStatus, Channel, DispatchStatus, MediaAsset } from '@swarm/domain';
import { EmptyState, ErrorNotice, LoadingRows, Pill } from '@swarm/ui/components';
import { Link } from '@tanstack/react-router';
import { createContext, useContext, useId, type ReactNode } from 'react';
import { useCurrentChannel } from '../channel';
import { useSession } from '../session';

/**
 * Renders `children` with the publication chosen in the URL (?channel=), else the shell's
 * current one (see ../channel.tsx). Handles the loading, error and no-publication states for every
 * page that uses it. The publication switcher lives in the rail now, so `picker` is always null;
 * it stays in the signature for the pages that still place it.
 */
export function WithChannel({
  channelId,
  children,
}: {
  channelId: string | undefined;
  /** Kept for callers; switching happens in the rail. */
  onChange?: (channelId: string) => void;
  children: (channel: Channel, picker: ReactNode) => ReactNode;
}) {
  const { can } = useSession();
  const current = useCurrentChannel();
  const channel = current.channels.find((c) => c.id === channelId) ?? current.channel;

  if (current.isPending) return <LoadingRows label="Loading publications" />;
  if (current.error) return <ErrorNotice message={current.error.message} />;
  if (!channel) {
    return (
      <EmptyState
        title="Create a publication first"
        action={
          can('admin') && (
            <Link to="/channels/new" className="btn-primary btn-sm">
              Create publication
            </Link>
          )
        }
      >
        Posts, subscribers and sending settings all belong to a publication.
      </EmptyState>
    );
  }

  return <>{children(channel, null)}</>;
}

const DISPATCH_PILL: Record<
  DispatchStatus,
  { tone: 'success' | 'scheduled' | 'brand' | 'neutral' | 'danger'; label: string }
> = {
  draft: { tone: 'brand', label: 'Draft' },
  scheduled: { tone: 'scheduled', label: 'Scheduled' },
  sending: { tone: 'scheduled', label: 'Sending' },
  sent: { tone: 'success', label: 'Sent' },
  canceled: { tone: 'neutral', label: 'Canceled' },
};

/** `imported`: an issue from another platform is a draft in the table, and never one to send. */
export function DispatchPill({ status, imported }: { status: DispatchStatus; imported?: boolean }) {
  if (imported && status === 'draft') return <Pill tone="neutral">Past issue</Pill>;
  const pill = DISPATCH_PILL[status];
  return <Pill tone={pill.tone}>{pill.label}</Pill>;
}

const BROADCAST_PILL: Record<
  BroadcastStatus,
  { tone: 'success' | 'scheduled' | 'brand' | 'neutral' | 'danger'; label: string }
> = {
  queued: { tone: 'scheduled', label: 'Queued' },
  sending: { tone: 'scheduled', label: 'Sending' },
  sent: { tone: 'success', label: 'Sent' },
  partially_failed: { tone: 'danger', label: 'Partly failed' },
  failed: { tone: 'danger', label: 'Failed' },
  canceled: { tone: 'neutral', label: 'Canceled' },
};

export function BroadcastPill({ status }: { status: BroadcastStatus }) {
  const pill = BROADCAST_PILL[status];
  return <Pill tone={pill.tone}>{pill.label}</Pill>;
}

export const numberFormat = new Intl.NumberFormat('en-US');
export const percentFormat = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 1,
});
const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export const formatDateTime = (iso: string | null) =>
  iso ? dateTimeFormat.format(new Date(iso)) : '—';

const dayFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const dayYearFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const dayTimeFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const thisYear = (date: Date, now: Date) => date.getFullYear() === now.getFullYear();

/** A day for a list: "5 Nov" this year, "5 Nov 2025" before. Minutes are noise in a list. */
export function formatDay(iso: string | null, now = new Date()): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return (thisYear(date, now) ? dayFormat : dayYearFormat).format(date);
}

/** A day and time, for something that hasn't happened yet: "12 Nov, 14:23". */
function formatDayTime(iso: string | null, now = new Date()): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return thisYear(date, now) ? dayTimeFormat.format(date) : dateTimeFormat.format(date);
}

/**
 * A date in a list: the day (with its time when `time` is set), and the full date and time on
 * hover and for machines. Tabular figures, so a column of dates lines up.
 */
export function When({ iso, time = false }: { iso: string | null; time?: boolean }) {
  if (!iso) return <>—</>;
  return (
    <time dateTime={iso} title={formatDateTime(iso)}>
      {time ? formatDayTime(iso) : formatDay(iso)}
    </time>
  );
}

/**
 * How a Section draws itself. On its own it is a card. Inside a panel that already draws its own
 * frame (the editor's send route, More options) it is a ruled block, so cards never nest. Inside
 * `Bands` (settings-style pages) it is a band. See DESIGN.md, Layout.
 */
type SectionLayout = 'card' | 'flat' | 'band';
const SectionLayoutContext = createContext<SectionLayout>('card');

export function FlatSectionsProvider({ children }: { children: ReactNode }) {
  return <SectionLayoutContext.Provider value="flat">{children}</SectionLayoutContext.Provider>;
}

/**
 * A page made of bands: every Section inside, shared parts included, draws as a band with a
 * hairline under it. `ruled` adds a hairline above the first band too, for a page whose header has
 * no rule of its own (a page with tabs already has the tab row's).
 */
export function Bands({ ruled = false, children }: { ruled?: boolean; children: ReactNode }) {
  return (
    <SectionLayoutContext.Provider value="band">
      <div className={`min-w-0 ${ruled ? 'border-t border-line' : '-mt-2'}`}>{children}</div>
    </SectionLayoutContext.Provider>
  );
}

interface SectionProps {
  title: ReactNode;
  description?: ReactNode;
  /** Something that belongs to the heading: a filter or a count. Not an add button. */
  action?: ReactNode;
  children: ReactNode;
}

/**
 * One band of a settings-style page: the heading, a one-line description and any `action` on the
 * left, 280px wide from 1020px up; the controls on the right; a hairline under it. No border or
 * background of its own. Below 1020px the two parts stack.
 */
export function Band(props: SectionProps) {
  return <BandBody id={useId()} {...props} />;
}

function BandBody({ id, title, description, action, children }: SectionProps & { id: string }) {
  return (
    <section
      aria-labelledby={id}
      className="grid min-w-0 gap-x-10 gap-y-4 border-b border-line py-6 min-[1020px]:grid-cols-[280px_minmax(0,1fr)]"
    >
      <div className="min-w-0">
        <h2 id={id} className="text-[17px] leading-[1.3] font-[650] tracking-[-0.005em]">
          {title}
        </h2>
        {description && <p className="mt-1.5 text-[13px] leading-[1.55] text-sub">{description}</p>}
        {action && <div className="mt-3 max-w-[260px]">{action}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

export function Section({ title, description, action, children }: SectionProps) {
  const id = useId();
  const layout = useContext(SectionLayoutContext);
  if (layout === 'band') {
    return (
      <BandBody id={id} title={title} description={description} action={action}>
        {children}
      </BandBody>
    );
  }
  const flat = layout === 'flat';
  return (
    <section
      aria-labelledby={id}
      className={
        // min-w-0: a wide table inside scrolls in its own box instead of widening the page.
        flat
          ? 'min-w-0 border-t border-line py-4 first:border-t-0 first:pt-1'
          : 'card-app min-w-0 p-5 sm:p-6'
      }
    >
      <div className={`${flat ? 'mb-3' : 'mb-4'} flex flex-wrap items-start justify-between gap-3`}>
        <div>
          <h2
            id={id}
            className={
              flat ? 'text-[15px] font-semibold' : 'text-[16px] font-semibold tracking-[-0.01em]'
            }
          >
            {title}
          </h2>
          {description && <p className="mt-1 text-[13px] leading-[1.5] text-sub">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Crops thumbnails around the image's focal point, when it has one. */
export const focalStyle = (asset: MediaAsset) =>
  asset.focalPoint
    ? { objectPosition: `${asset.focalPoint.x * 100}% ${asset.focalPoint.y * 100}%` }
    : undefined;
