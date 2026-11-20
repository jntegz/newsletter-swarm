// Memberships → Gift Passes and Pledges: read-only views of what readers bought for others and
// what they pledged before paid Memberships opened. Both are optional features; while one is off
// for the Channel the page says so instead of showing an error.
import type { GiftPass, Pledge } from '@swarm/domain';
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
import { useState, type ReactNode } from 'react';
import {
  giftPassesQuery,
  isFeatureDisabled,
  levelsQuery,
  pledgesQuery,
  useNotifyPledgers,
  type PledgeNotifyResult,
} from '../api/money';
import { formatMoney } from '../money/helpers';
import { ReadOnlyNote } from '../site/controls';
import { Section, numberFormat } from './common';
import { dayLabel, useMemberships } from './Memberships';

function useLevelName(channelId: string) {
  const levels = useQuery(levelsQuery(channelId, true));
  return (id: string | null) =>
    (id && levels.data?.items.find((l) => l.id === id)?.name) || 'A removed plan';
}

function FeatureOff({ title, children }: { title: string; children: ReactNode }) {
  return <EmptyState title={title}>{children}</EmptyState>;
}

function Table({
  caption,
  headers,
  children,
}: {
  caption: string;
  headers: string[];
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[600px] text-left text-[13px]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="table-head">
            {headers.map((h, i) => (
              <th key={h} scope="col" className={`py-2 font-semibold ${i ? 'px-3' : 'pr-3'}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

// ---- Gift Passes ---------------------------------------------------------------------------

const GIFT_STATUS: Record<
  GiftPass['status'],
  { label: string; tone: 'success' | 'scheduled' | 'neutral' | 'danger' | 'brand' }
> = {
  pending_payment: { label: 'Awaiting payment', tone: 'neutral' },
  paid: { label: 'Not claimed yet', tone: 'scheduled' },
  claimed: { label: 'Claimed', tone: 'success' },
  expired: { label: 'Expired', tone: 'neutral' },
  refunded: { label: 'Refunded', tone: 'danger' },
};

export function GiftPassesPage() {
  const { channel } = useMemberships();
  const [status, setStatus] = useState('');
  const passes = useQuery(giftPassesQuery(channel.id, status));
  const levelName = useLevelName(channel.id);

  if (isFeatureDisabled(passes.error)) {
    return (
      <FeatureOff title="Gift subscriptions are off for this publication">
        With gift subscriptions on, readers can buy a paid subscription for someone else from the
        plans page.
      </FeatureOff>
    );
  }

  return (
    <Section
      title="Gift subscriptions"
      description="Paid subscriptions readers bought for someone else. The recipient claims it from an email link."
      action={
        <div className="w-48">
          <SelectField
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[
              { value: '', label: 'All' },
              ...Object.entries(GIFT_STATUS).map(([value, s]) => ({ value, label: s.label })),
            ]}
          />
        </div>
      }
    >
      {passes.isPending && <LoadingRows label="Loading gift subscriptions" rows={3} />}
      {passes.error ? <ErrorNotice message={(passes.error as Error).message} /> : null}
      {passes.data && passes.data.items.length === 0 && (
        <EmptyState
          title={status ? 'No gift subscriptions with this status' : 'No gift subscriptions yet'}
        >
          Readers buy them on the plans page, under “Give a gift subscription”.
        </EmptyState>
      )}
      {passes.data && passes.data.items.length > 0 && (
        <Table
          caption="Gift subscriptions"
          headers={['Bought by', 'For', 'Paid plan', 'Length', 'Status', 'Bought']}
        >
          {passes.data.items.map((pass) => (
            <tr key={pass.id} className="border-t border-line">
              <td className="py-2.5 pr-3 font-mono text-[12.5px] break-all">
                {pass.purchaserEmail}
              </td>
              <td className="px-3 py-2.5 font-mono text-[12.5px] break-all">
                {pass.recipientEmail ?? '—'}
              </td>
              <td className="px-3 py-2.5">{levelName(pass.levelId)}</td>
              <td className="tabular px-3 py-2.5">
                {pass.months} month{pass.months === 1 ? '' : 's'}
              </td>
              <td className="px-3 py-2.5">
                <Pill tone={GIFT_STATUS[pass.status].tone}>{GIFT_STATUS[pass.status].label}</Pill>
                {pass.status === 'paid' && pass.claimBy && (
                  <span className="block text-[12px] text-sub">
                    Claim by {dayLabel(pass.claimBy)}
                  </span>
                )}
                {pass.status === 'claimed' && (
                  <span className="block text-[12px] text-sub">{dayLabel(pass.claimedAt)}</span>
                )}
              </td>
              <td className="tabular px-3 py-2.5 text-sub">{dayLabel(pass.createdAt)}</td>
            </tr>
          ))}
        </Table>
      )}
      {passes.data?.nextCursor && (
        <p className="mt-3 text-[12.5px] text-sub">Showing the newest 100.</p>
      )}
    </Section>
  );
}

// ---- Pledges -------------------------------------------------------------------------------

const PLEDGE_STATUS: Record<
  Pledge['status'],
  { label: string; tone: 'success' | 'scheduled' | 'neutral' | 'brand' }
> = {
  open: { label: 'Waiting', tone: 'scheduled' },
  notified: { label: 'Notified', tone: 'brand' },
  converted: { label: 'Became paid', tone: 'success' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
};

export function PledgesPage() {
  const { channel, canAdmin } = useMemberships();
  const [status, setStatus] = useState('');
  const pledges = useQuery(pledgesQuery(channel.id, status));
  const notify = useNotifyPledgers(channel.id);
  const levelName = useLevelName(channel.id);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<PledgeNotifyResult | null>(null);
  const open = pledges.data?.items.filter((p) => p.status === 'open').length ?? 0;

  if (isFeatureDisabled(pledges.error)) {
    return (
      <FeatureOff title="Pledges are off for this publication">
        With pledges on, readers can promise to pay before paid subscriptions open, and you can tell
        them the moment they do.
      </FeatureOff>
    );
  }

  const send = () =>
    notify.mutate(undefined, {
      onSuccess: (data) => {
        setResult(data);
        setConfirming(false);
      },
    });

  return (
    <div className="grid gap-5">
      <Section
        title="Notify pledgers"
        description="Email everyone with a waiting pledge a link to the plans page. Subscribers who unsubscribed or bounced are marked without an email."
      >
        <div className="grid gap-3">
          {canAdmin ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => setConfirming(true)} disabled={pledges.isPending}>
                {result && result.remaining > 0 ? 'Notify the rest' : 'Notify pledgers'}
              </Button>
              <p role="status" className="text-[13px] text-success">
                {result
                  ? `${numberFormat.format(result.notified)} pledgers notified, ${numberFormat.format(result.emailed)} by email.${result.remaining > 0 ? ` ${numberFormat.format(result.remaining)} still waiting.` : ''}`
                  : ''}
              </p>
            </div>
          ) : (
            <ReadOnlyNote>An admin of this publication notifies pledgers.</ReadOnlyNote>
          )}
          {notify.error && !confirming && <ErrorNotice message={notify.error.message} />}
        </div>
      </Section>

      <Section
        title="Pledges"
        description="Promises to pay, made on the plans page while the publication couldn't take payments yet."
        action={
          <div className="w-48">
            <SelectField
              label="Status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              options={[
                { value: '', label: 'All' },
                ...Object.entries(PLEDGE_STATUS).map(([value, s]) => ({ value, label: s.label })),
              ]}
            />
          </div>
        }
      >
        {pledges.isPending && <LoadingRows label="Loading pledges" rows={3} />}
        {pledges.error ? <ErrorNotice message={(pledges.error as Error).message} /> : null}
        {pledges.data && pledges.data.items.length === 0 && (
          <EmptyState title={status ? 'No pledges with this status' : 'No pledges yet'}>
            Readers pledge on the plans page while paid subscriptions aren’t open.
          </EmptyState>
        )}
        {pledges.data && pledges.data.items.length > 0 && (
          <Table
            caption="Pledges"
            headers={['Subscriber', 'Paid plan', 'Pledge', 'Status', 'Pledged']}
          >
            {pledges.data.items.map((pledge) => (
              <tr key={pledge.id} className="border-t border-line">
                <td className="py-2.5 pr-3 font-mono text-[12.5px] break-all">
                  {pledge.memberEmail ?? 'A removed subscriber'}
                </td>
                <td className="px-3 py-2.5">{levelName(pledge.levelId)}</td>
                <td className="tabular px-3 py-2.5 font-semibold">
                  {formatMoney(pledge.amount, pledge.currency)} a {pledge.interval}
                </td>
                <td className="px-3 py-2.5">
                  <Pill tone={PLEDGE_STATUS[pledge.status].tone}>
                    {PLEDGE_STATUS[pledge.status].label}
                  </Pill>
                </td>
                <td className="tabular px-3 py-2.5 text-sub">{dayLabel(pledge.createdAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Email your pledgers?"
        description={
          open > 0 && !status
            ? `${numberFormat.format(open)} waiting pledges get an email with a link to the plans page. It goes out once per pledge.`
            : 'Everyone with a waiting pledge gets an email with a link to the plans page. It goes out once per pledge.'
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Not yet
            </Button>
            <Button loading={notify.isPending} onClick={send}>
              Send emails
            </Button>
          </>
        }
      >
        {notify.error && <ErrorNotice message={notify.error.message} />}
      </Dialog>
    </div>
  );
}
