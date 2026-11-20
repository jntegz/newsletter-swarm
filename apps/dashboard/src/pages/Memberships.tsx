// Memberships: everything a Channel sells. The layout loads the Channel, its payments status and
// site address once; each tab (Levels, Coupons, Gates, Revenue, Gift Passes, Pledges) is a child
// route that reads them from context.
import type { Channel, MembershipLevel, PaymentsStatus, SeatRole } from '@swarm/domain';
import { Checkbox, EmptyState, ErrorNotice, LoadingRows, Pill } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link, Outlet } from '@tanstack/react-router';
import { createContext, useContext, useState } from 'react';
import { levelsQuery, paymentsQuery } from '../api/money';
import { channelQuery } from '../api/queries';
import { siteSettingsQuery } from '../api/site';
import { INTERVAL_LABEL, formatMoney, priceLabel, pricesFor } from '../money/helpers';
import { PageHeader } from './Channels';
import { Section, numberFormat } from './common';

const RANK: Record<SeatRole, number> = { viewer: 0, author: 1, editor: 2, admin: 3, owner: 4 };

interface MembershipsValue {
  channel: Channel;
  payments: PaymentsStatus;
  /** The public site's address, once known. */
  siteUrl: string | null;
  /** Editor or higher: Gates and the meter. */
  canEdit: boolean;
  /** Admin or higher: levels, prices, coupons, comp access and pledges. */
  canAdmin: boolean;
  /** A connected Stripe account that can take payments. */
  canSell: boolean;
}

const MembershipsContext = createContext<MembershipsValue | null>(null);

export function useMemberships(): MembershipsValue {
  const value = useContext(MembershipsContext);
  if (!value) throw new Error('useMemberships() outside MembershipsLayout');
  return value;
}

const TABS = [
  { path: 'levels', label: 'Plans' },
  { path: 'coupons', label: 'Coupons' },
  { path: 'gates', label: 'Paywall' },
  { path: 'revenue', label: 'Revenue' },
  { path: 'gift-passes', label: 'Gift subscriptions' },
  { path: 'pledges', label: 'Pledges' },
] as const;

export function MembershipsLayout({ channelId }: { channelId: string }) {
  const channel = useQuery(channelQuery(channelId));
  const payments = useQuery(paymentsQuery(channelId));
  const site = useQuery(siteSettingsQuery(channelId));
  if (channel.isPending || payments.isPending) {
    return <LoadingRows label="Loading paid subscriptions" rows={4} />;
  }
  if (channel.error || payments.error) {
    return (
      <ErrorNotice
        title="Paid subscriptions not available"
        message={(channel.error ?? payments.error)?.message ?? ''}
        action={
          <Link to="/channels" className="btn-ghost">
            Back to publications
          </Link>
        }
      />
    );
  }
  const role = channel.data.role;
  const value: MembershipsValue = {
    channel: channel.data,
    payments: payments.data,
    siteUrl: site.data?.url ?? null,
    canEdit: RANK[role] >= RANK.editor,
    canAdmin: RANK[role] >= RANK.admin,
    canSell: payments.data.available && payments.data.connected && payments.data.chargesEnabled,
  };
  return (
    <MembershipsContext.Provider value={value}>
      <PageHeader
        title="Paid subscriptions"
        subtitle={`What readers of ${channel.data.name} can pay for.`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {value.siteUrl && (
              <a
                href={`${value.siteUrl}/subscribe`}
                target="_blank"
                rel="noreferrer"
                className="btn-ghost"
              >
                View plans page<span className="sr-only"> (opens in a new tab)</span>
              </a>
            )}
            <Link to="/settings/payments" search={{ channel: channelId }} className="btn-ghost">
              Payments settings
            </Link>
          </div>
        }
      />
      <nav
        aria-label="Paid subscriptions sections"
        className="mb-6 flex gap-1 overflow-x-auto border-b border-line-app"
      >
        {TABS.map((tab) => (
          <Link
            key={tab.path}
            to={`/memberships/$channelId/${tab.path}`}
            params={{ channelId }}
            className="-mb-px border-b-2 border-transparent px-3 pb-3 text-[13.5px] whitespace-nowrap text-sub no-underline hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple"
            activeProps={{
              className: 'border-purple! font-semibold text-ink!',
              'aria-current': 'page',
            }}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </MembershipsContext.Provider>
  );
}

/** Shown where selling needs a connected Stripe account. */
export function ConnectFirst({ what }: { what: string }) {
  const { channel, payments, canAdmin } = useMemberships();
  if (!payments.available) {
    return (
      <EmptyState title="Payments are not set up on this deployment">
        Whoever runs this Swarm installation has switched payments off, so {what} can't be sold.
      </EmptyState>
    );
  }
  const waiting = payments.connected && !payments.chargesEnabled;
  return (
    <EmptyState
      title={waiting ? 'Stripe is not ready to take payments' : 'Connect Stripe to start selling'}
      action={
        <Link
          to="/settings/payments"
          search={{ channel: channel.id }}
          className="btn-primary btn-sm"
        >
          {canAdmin && !waiting ? 'Connect Stripe' : 'Open Payments settings'}
        </Link>
      }
    >
      {waiting
        ? 'Finish onboarding in your Stripe dashboard. Once Stripe enables payments you can create ' +
          what +
          '.'
        : `Readers pay through this publication's own Stripe account. Connect it in Settings → Payments to create ${what}.`}
    </EmptyState>
  );
}

// ---- Levels list ---------------------------------------------------------------------------

export function LevelsPage() {
  const { channel, canAdmin, canSell } = useMemberships();
  const [showArchived, setShowArchived] = useState(false);
  const levels = useQuery(levelsQuery(channel.id, showArchived));
  const list = levels.data;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
      <div className="grid gap-5">
        {!canSell && <ConnectFirst what="paid plans" />}
        <Section
          title="Paid plans"
          description="Every subscriber starts on Free. Paid plans unlock posts behind a paywall."
          action={
            canAdmin &&
            canSell && (
              <Link
                to="/memberships/$channelId/levels/new"
                params={{ channelId: channel.id }}
                className="btn-primary btn-sm"
              >
                New paid plan
              </Link>
            )
          }
        >
          {levels.isPending && <LoadingRows label="Loading paid plans" rows={3} />}
          {levels.error && <ErrorNotice message={levels.error.message} />}
          {list && (
            <div className="grid gap-3">
              <ul className="grid border-t border-line" aria-label="Paid plans">
                <li className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-3">
                  <div>
                    <p className="text-[14px] font-semibold">{list.free.name || 'Free'}</p>
                    <p className="text-[12.5px] text-sub">No charge · everyone who signs up</p>
                  </div>
                  <p className="tabular text-[13px] text-sub">
                    {numberFormat.format(list.free.memberCount)} subscribers
                  </p>
                </li>
                {list.items.map((level) => (
                  <LevelRow key={level.id} level={level} />
                ))}
              </ul>
              {list.items.length === 0 && canSell && (
                <p className="text-[13px] text-sub">
                  No paid plans yet.{' '}
                  {canAdmin
                    ? 'Create one with a monthly or yearly price.'
                    : 'An admin creates them.'}
                </p>
              )}
              <Checkbox
                label="Show archived plans"
                checked={showArchived}
                onChange={setShowArchived}
              />
            </div>
          )}
        </Section>
      </div>
      {list && (
        <PlansPreview
          levels={list.items
            .filter((l) => l.status === 'active')
            .map((l) => ({ ...l, prices: l.prices.filter((p) => p.status === 'active') }))}
        />
      )}
    </div>
  );
}

function LevelRow({ level }: { level: MembershipLevel }) {
  const { channel } = useMemberships();
  const shown = (['month', 'year', 'lifetime'] as const)
    .map((interval) => pricesFor(level.prices, interval))
    .filter((p) => p.active || p.scheduled);
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-3">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold">
          <Link
            to="/memberships/$channelId/levels/$levelId"
            params={{ channelId: channel.id, levelId: level.id }}
            className="text-ink hover:text-purple-deep"
          >
            {level.name}
          </Link>
          {level.founding && <Pill tone="brand">Founding plan</Pill>}
          {level.visibility === 'hidden' && <Pill>Hidden</Pill>}
          {level.status === 'archived' && <Pill>Archived</Pill>}
        </p>
        <p className="tabular text-[12.5px] text-sub">
          {shown.length === 0
            ? 'No price'
            : shown
                .map(({ active, scheduled }) =>
                  [
                    active ? priceLabel(active) : null,
                    scheduled
                      ? `${priceLabel(scheduled)} from ${dayLabel(scheduled.effectiveAt)}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(', then '),
                )
                .join(' · ')}
          {level.trialDays > 0 && ` · ${level.trialDays}-day trial`}
        </p>
      </div>
      <p className="tabular text-[13px] text-sub">
        {numberFormat.format(level.memberCount)} subscribers
      </p>
    </li>
  );
}

const dayFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
export const dayLabel = (iso: string | null) => (iso ? dayFormat.format(new Date(iso)) : '—');

// ---- Plans preview -------------------------------------------------------------------------

export interface PreviewLevel {
  id: string;
  name: string;
  description: string | null;
  benefits: string[];
  founding: boolean;
  visibility: 'public' | 'hidden';
  trialDays: number;
  prices: {
    interval: 'month' | 'year' | 'lifetime';
    amount: number;
    currency: string;
    customAmount: boolean;
    minAmount: number | null;
  }[];
}

/**
 * How the plans card looks on the public site's /subscribe page: Free first, then the Founding
 * Level and the other public levels, with the monthly (or yearly) price. A drawing in the
 * dashboard's style; the site uses the Channel's own brand.
 */
export function PlansPreview({
  levels,
  highlight,
}: {
  levels: readonly PreviewLevel[];
  highlight?: string;
}) {
  const { siteUrl } = useMemberships();
  const [billing, setBilling] = useState<'month' | 'year'>('month');
  const visible = levels
    .filter((l) => l.visibility === 'public' || l.id === highlight)
    .sort((a, b) => Number(b.founding) - Number(a.founding));
  const hasYear = visible.some((l) => l.prices.some((p) => p.interval === 'year'));
  const currency = visible[0]?.prices[0]?.currency ?? 'usd';
  const active = hasYear ? billing : 'month';

  return (
    <aside aria-label="Plans page preview" className="card-app grid gap-3 p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold">Plans page preview</h2>
        {siteUrl && (
          <a
            href={`${siteUrl}/subscribe`}
            target="_blank"
            rel="noreferrer"
            className="text-[12.5px] font-semibold text-purple-deep"
          >
            View plans page<span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
      </div>
      {hasYear && (
        <div
          role="group"
          aria-label="Billing"
          className="flex gap-1 rounded-pill bg-surface-alt p-1"
        >
          {(['month', 'year'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={active === value}
              onClick={() => setBilling(value)}
              className={`min-h-8 flex-1 rounded-pill text-[12.5px] font-semibold ${
                active === value ? 'bg-surface text-ink shadow-soft' : 'text-sub hover:text-ink'
              }`}
            >
              {INTERVAL_LABEL[value]}
            </button>
          ))}
        </div>
      )}
      <ul className="grid gap-2.5">
        <li className="rounded-card-app border border-line-app p-4">
          <p className="text-[14px] font-semibold">Free</p>
          <p className="tabular text-[18px] font-bold">{formatMoney(0, currency)}</p>
          <ul className="mt-1 list-disc pl-5 text-[12.5px] text-sub">
            <li>Public posts by email</li>
            <li>Subscriber-only posts on the website</li>
          </ul>
        </li>
        {visible.map((level) => {
          const recurring = level.prices.find((p) => p.interval === active);
          const lifetime = level.prices.find((p) => p.interval === 'lifetime');
          const shown = recurring ?? lifetime;
          return (
            <li
              key={level.id}
              className={`rounded-card-app border p-4 ${
                level.id === highlight ? 'border-purple bg-lavender' : 'border-line-app'
              }`}
            >
              {level.founding && (
                <span className="mb-1 inline-block">
                  <Pill tone="brand">Founding plan</Pill>
                </span>
              )}
              <p className="text-[14px] font-semibold break-words">
                {level.name || 'Untitled plan'}
              </p>
              {shown ? (
                <p className="tabular text-[18px] font-bold">{priceLabel(shown)}</p>
              ) : (
                <p className="text-[12.5px] text-sub">Add a price to show it.</p>
              )}
              {level.trialDays > 0 && shown?.interval !== 'lifetime' && (
                <p className="text-[12px] text-sub">{level.trialDays}-day free trial</p>
              )}
              {level.description && (
                <p className="mt-1 text-[12.5px] break-words text-sub">{level.description}</p>
              )}
              {level.benefits.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-[12.5px] break-words text-sub">
                  {level.benefits.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              )}
              {level.visibility === 'hidden' && (
                <p className="mt-1 text-[12px] text-sub">Hidden: offered by link only.</p>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-[12px] text-sub">
        The website shows these in your publication’s colours and fonts.
      </p>
    </aside>
  );
}
