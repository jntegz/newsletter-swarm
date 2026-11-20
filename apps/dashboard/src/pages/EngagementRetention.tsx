// Settings → Privacy: how long deliveries, opens and clicks stay tied to a person
// (docs/privacy-controls.md). Admins and owners; the jobs worker does the removing.
import {
  AUDIT_RETENTION_MONTHS,
  ENGAGEMENT_RETENTION_MONTHS,
  LEFT_MEMBER_RETENTION_MONTHS,
  PAYMENT_RECORD_YEARS,
  type AuditRetentionMonths,
  type EngagementRetentionMonths,
  type LeftMemberRetentionMonths,
  type PaymentRecordYears,
} from '@swarm/domain';
import { Button, ErrorNotice, LoadingRows } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  formerTeammatesQuery,
  retentionQuery,
  useRedactTeammate,
  useSetRetention,
} from '../api/retention';
import { useSession } from '../session';
import { Section } from './common';

const LABEL: Record<EngagementRetentionMonths, string> = {
  6: '6 months',
  13: '13 months (default)',
  24: '2 years',
  36: '3 years',
};

const LEFT_LABEL: Record<LeftMemberRetentionMonths, string> = {
  12: '1 year',
  24: '2 years (default)',
  36: '3 years',
  60: '5 years',
};

const PAYMENT_LABEL: Record<PaymentRecordYears, string> = {
  6: '6 years',
  7: '7 years',
  8: '8 years',
  10: '10 years (default)',
};

const AUDIT_LABEL: Record<AuditRetentionMonths, string> = {
  12: '1 year',
  24: '2 years (default)',
  36: '3 years',
  60: '5 years',
};

export function EngagementRetentionSettings() {
  const { workspace, can } = useSession();
  if (!can('admin')) return null;
  return (
    <>
      <EngagementRetention workspaceId={workspace.id} />
      {can('owner') && <FormerTeammates workspaceId={workspace.id} />}
    </>
  );
}

/** Settings → Privacy → Former teammates: owners remove the details of people who left. */
function FormerTeammates({ workspaceId }: { workspaceId: string }) {
  const people = useQuery(formerTeammatesQuery(workspaceId));
  const redact = useRedactTeammate(workspaceId);
  return (
    <Section
      title="Former teammates"
      description="People who worked in this workspace and no longer have a seat or a publication role here. Removing someone’s details shows a placeholder instead of their name and address wherever this workspace shows who did something, and removes their address from old invitations. Their account and other workspaces are not changed. The audit log keeps its entries as written until they reach the audit log’s age limit, and shows them with the placeholder."
    >
      {people.isPending && <LoadingRows label="Loading former teammates" rows={2} />}
      {people.error && <ErrorNotice message={people.error.message} />}
      {people.data && people.data.length === 0 && (
        <p className="text-[13px] text-sub">Nobody has left this workspace.</p>
      )}
      {people.data && people.data.length > 0 && (
        <ul className="grid gap-2 text-[13.5px]">
          {people.data.map((person) => (
            <li key={person.id} className="flex flex-wrap items-center justify-between gap-3">
              <span className="min-w-0 break-all">
                {person.name ? `${person.name} · ` : ''}
                {person.email}
              </span>
              {person.redacted ? (
                <span className="text-[12.5px] text-sub">Details removed</span>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={redact.isPending && redact.variables === person.id}
                  onClick={() => redact.mutate(person.id)}
                >
                  Remove their details
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {redact.error && <ErrorNotice title="Not removed" message={redact.error.message} />}
    </Section>
  );
}

function EngagementRetention({ workspaceId }: { workspaceId: string }) {
  const retention = useQuery(retentionQuery(workspaceId));
  const save = useSetRetention(workspaceId);
  // The choice moves as soon as it's made; the saved value takes over when the save ends.
  const [choosing, setChoosing] = useState<EngagementRetentionMonths | null>(null);
  const picked = choosing ?? retention.data?.months ?? null;
  const [choosingLeft, setChoosingLeft] = useState<LeftMemberRetentionMonths | null>(null);
  const pickedLeft = choosingLeft ?? retention.data?.leftMemberMonths ?? null;
  const [choosingPayment, setChoosingPayment] = useState<PaymentRecordYears | null>(null);
  const pickedPayment = choosingPayment ?? retention.data?.paymentRecordYears ?? null;
  const [choosingAudit, setChoosingAudit] = useState<AuditRetentionMonths | null>(null);
  const pickedAudit = choosingAudit ?? retention.data?.auditLogMonths ?? null;

  return (
    <Section
      title="Engagement history"
      description="How long Swarm keeps who received, opened and clicked each email. After this, those records no longer name the person: their address, network and browser are removed, and send reports keep every number. Suppressed addresses are always kept, so nobody you must not email is mailed again."
    >
      {retention.isPending && <LoadingRows label="Loading engagement history" rows={2} />}
      {retention.error && <ErrorNotice message={retention.error.message} />}
      {picked !== null && (
        <fieldset className="grid gap-2 text-[13.5px]" disabled={save.isPending}>
          <legend className="mb-1 font-semibold">Keep engagement history for</legend>
          {ENGAGEMENT_RETENTION_MONTHS.map((months) => (
            <label key={months} className="flex items-center gap-2.5">
              <input
                type="radio"
                name="engagement-retention"
                checked={picked === months}
                onChange={() => {
                  setChoosing(months);
                  save.mutate({ months }, { onSettled: () => setChoosing(null) });
                }}
                className="size-4 accent-purple"
              />
              {LABEL[months]}
            </label>
          ))}
        </fieldset>
      )}
      <p className="mt-3 text-[12.5px] leading-[1.5] text-sub">
        Engagement scores, segments and best-time sending look back 90 days at most, so a shorter
        time changes none of them. Unsubscribe links in older emails keep working for 2 more years
        through a reference that holds nothing about opens or clicks.
      </p>
      {pickedLeft !== null && (
        <fieldset className="mt-5 grid gap-2 text-[13.5px]" disabled={save.isPending}>
          <legend className="mb-1 font-semibold">
            Keep the full profile of people who left for
          </legend>
          {LEFT_MEMBER_RETENTION_MONTHS.map((months) => (
            <label key={months} className="flex items-center gap-2.5">
              <input
                type="radio"
                name="left-member-retention"
                checked={pickedLeft === months}
                onChange={() => {
                  setChoosingLeft(months);
                  save.mutate(
                    { leftMemberMonths: months },
                    { onSettled: () => setChoosingLeft(null) },
                  );
                }}
                className="size-4 accent-purple"
              />
              {LEFT_LABEL[months]}
            </label>
          ))}
          <p className="text-[12.5px] leading-[1.5] text-sub">
            After this, someone who unsubscribed, bounced or complained keeps only their address,
            status, dates and consent records, so they are still never emailed. Names, profile
            fields, tags and activity are removed.
          </p>
        </fieldset>
      )}
      {pickedPayment !== null && (
        <fieldset className="mt-5 grid gap-2 text-[13.5px]" disabled={save.isPending}>
          <legend className="mb-1 font-semibold">
            Keep payment references after a deletion request for
          </legend>
          {PAYMENT_RECORD_YEARS.map((years) => (
            <label key={years} className="flex items-center gap-2.5">
              <input
                type="radio"
                name="payment-record-years"
                checked={pickedPayment === years}
                onChange={() => {
                  setChoosingPayment(years);
                  save.mutate(
                    { paymentRecordYears: years },
                    { onSettled: () => setChoosingPayment(null) },
                  );
                }}
                className="size-4 accent-purple"
              />
              {PAYMENT_LABEL[years]}
            </label>
          ))}
          <p className="text-[12.5px] leading-[1.5] text-sub">
            When someone’s data is deleted, their payments stay in your books without their name or
            address, with the Stripe or PayPal payment id so refunds, disputes and your accounts can
            still find them. Those ids are removed this long after each payment. Choose the period
            your country’s tax law sets for keeping accounting records.
          </p>
        </fieldset>
      )}
      {pickedAudit !== null && (
        <fieldset className="mt-5 grid gap-2 text-[13.5px]" disabled={save.isPending}>
          <legend className="mb-1 font-semibold">Keep the audit log for</legend>
          {AUDIT_RETENTION_MONTHS.map((months) => (
            <label key={months} className="flex items-center gap-2.5">
              <input
                type="radio"
                name="audit-retention"
                checked={pickedAudit === months}
                onChange={() => {
                  setChoosingAudit(months);
                  save.mutate(
                    { auditLogMonths: months },
                    { onSettled: () => setChoosingAudit(null) },
                  );
                }}
                className="size-4 accent-purple"
              />
              {AUDIT_LABEL[months]}
            </label>
          ))}
          <p className="text-[12.5px] leading-[1.5] text-sub">
            Older entries are removed every day, or sooner where your plan keeps the log for a
            shorter time. The entries that stay can still be checked for changes.
          </p>
        </fieldset>
      )}
      {save.error && <ErrorNotice title="Not saved" message={save.error.message} />}
    </Section>
  );
}
