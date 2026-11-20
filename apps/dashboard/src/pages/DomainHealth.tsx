import type { DmarcDomainSummary, DomainHealth } from '@swarm/domain';
import { ErrorNotice, LoadingRows, Pill, SelectField } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { dedicatedQuery, domainHealthQuery, type DayRange } from '../api/deliverability';
import { Section, numberFormat } from './common';
import { RecordStatePill } from './Sending';

/** Gmail's lines for spam complaints (support.google.com/a/answer/81126). */
const COMPLAINT_TARGET = 0.001;
const COMPLAINT_LIMIT = 0.003;
/** The rate past which Swarm pauses a warming domain (ramp.ts). */
const BOUNCE_LIMIT = 0.02;

const percent = (rate: number) => `${(rate * 100).toFixed(rate < 0.01 ? 2 : 1)}%`;

/** A rate with what it came from. No sends means no rate, and never a reassuring 0%. */
export function describeRate(rate: number | null, count: number, sent: number, noun: string) {
  if (rate === null) return 'Nothing sent in this range';
  return `${percent(rate)} (${numberFormat.format(count)} ${noun} of ${numberFormat.format(sent)})`;
}

export function complaintTone(rate: number | null): 'success' | 'neutral' | 'danger' {
  if (rate === null) return 'neutral';
  if (rate >= COMPLAINT_LIMIT) return 'danger';
  return rate >= COMPLAINT_TARGET ? 'neutral' : 'success';
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 border-t border-line py-2.5 text-[13px] sm:grid-cols-[160px_1fr]">
      <dt className="text-sub">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function Health({ health }: { health: DomainHealth }) {
  const { sending, dmarc, ramp } = health;
  const toFix = health.records.filter(
    (record) => record.state !== 'ok' && record.state !== 'unknown',
  );
  return (
    <dl>
      <Row label="Verification">
        <Pill tone={health.status === 'verified' ? 'success' : 'danger'}>
          {health.status === 'verified'
            ? 'Verified'
            : health.status === 'failed'
              ? 'Failed'
              : 'Waiting for DNS'}
        </Pill>
      </Row>
      <Row label="DNS records">
        {toFix.length === 0 ? (
          <span>
            {health.records.length ? 'Nothing to fix.' : 'This service has no records to check.'}
          </span>
        ) : (
          <ul className="grid gap-1.5">
            {toFix.map((record) => (
              <li
                key={`${record.type}-${record.name}`}
                className="flex flex-wrap items-center gap-2"
              >
                <RecordStatePill state={record.state} />
                <span className="font-mono text-[12.5px] break-all">{record.name}</span>
              </li>
            ))}
          </ul>
        )}
      </Row>
      <Row label="Warm-up">
        {ramp === null
          ? 'Starts with the first send.'
          : ramp.status === 'paused'
            ? `Paused. ${ramp.pausedReason ?? ''}`
            : ramp.status === 'complete'
              ? 'Complete.'
              : `Warming up, up to ${numberFormat.format(ramp.capToday)} emails today.`}
      </Row>
      <Row label="Bounces">
        <span
          className={
            sending.bounceRate !== null && sending.bounceRate > BOUNCE_LIMIT ? 'text-danger' : ''
          }
        >
          {describeRate(sending.bounceRate, sending.bounces, sending.sent, 'bounced')}
        </span>
      </Row>
      <Row label="Spam complaints">
        <span className="mr-2">
          {describeRate(sending.complaintRate, sending.complaints, sending.sent, 'complained')}
        </span>
        {sending.complaintRate !== null && (
          <Pill tone={complaintTone(sending.complaintRate)}>
            {sending.complaintRate >= COMPLAINT_LIMIT
              ? 'Over Gmail’s limit'
              : sending.complaintRate >= COMPLAINT_TARGET
                ? 'Above Gmail’s target'
                : 'Within Gmail’s target'}
          </Pill>
        )}
      </Row>
      <Row label="DMARC">
        {dmarc.alignmentRate === null
          ? `No reports yet. Policy: ${health.dmarcPolicy ?? 'none found'}.`
          : `${percent(dmarc.alignmentRate)} aligned across ${numberFormat.format(dmarc.messages)} reported messages. Policy: ${health.dmarcPolicy ?? 'none found'}.`}
      </Row>
    </dl>
  );
}

/** One sending domain's records, warm-up, rates and DMARC together. */
export function DomainHealthSection({
  domains,
  range,
}: {
  domains: DmarcDomainSummary[];
  range: DayRange;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const selected = domains.find((d) => d.sendingDomainId === picked) ?? domains[0];
  const health = useQuery({
    ...domainHealthQuery(selected?.sendingDomainId ?? '', range),
    enabled: !!selected,
  });
  if (!selected) return null;
  return (
    <Section
      title="Domain health"
      description="Rates here come from finished warm-up days, so today isn’t counted until it’s over."
      action={
        domains.length > 1 ? (
          <div className="w-[240px]">
            <SelectField
              label="Domain"
              value={selected.sendingDomainId}
              onChange={(event) => setPicked(event.target.value)}
              options={domains.map((d) => ({ value: d.sendingDomainId, label: d.domain }))}
            />
          </div>
        ) : undefined
      }
    >
      {health.isPending && <LoadingRows label="Checking this domain" rows={4} />}
      {health.error && <ErrorNotice message={health.error.message} />}
      {health.data && <Health health={health.data} />}
    </Section>
  );
}

const STEP = 'text-[13px] text-sub';
const LINK = 'underline underline-offset-2 hover:text-ink';

/** Where to see how mailbox providers rate you, which Swarm can't see for you. */
export function ReputationGuide({
  channelId,
  domains,
}: {
  channelId: string;
  domains: DmarcDomainSummary[];
}) {
  const dedicated = useQuery(dedicatedQuery(channelId));
  const status = dedicated.data?.dedicatedIp.status;
  const hasIp = status === 'warming' || status === 'active';
  const domain = domains[0]?.domain ?? 'your sending domain';
  return (
    <Section
      title="See what mailbox providers see"
      description="Swarm reports what happens to your email. Only the mailbox providers know how they rate you, and they show it for free."
    >
      <div className="grid gap-5">
        <div>
          <h3 className="text-[14px] font-semibold">Gmail Postmaster Tools</h3>
          <ol className="mt-2 grid list-decimal gap-1.5 pl-5">
            <li className={STEP}>
              Open{' '}
              <a
                className={LINK}
                href="https://postmaster.google.com/"
                target="_blank"
                rel="noreferrer"
              >
                Postmaster Tools
              </a>{' '}
              and sign in with any Google account.
            </li>
            <li className={STEP}>
              Add <span className="font-mono text-[12.5px] text-ink">{domain}</span>, and publish
              the TXT record Google shows you to prove it’s yours.
            </li>
            <li className={STEP}>
              Check it once you’re sending to Gmail regularly. Google only shows figures for domains
              with enough volume, so it can look empty at first.
            </li>
          </ol>
          <p className={`${STEP} mt-2`}>
            Keep spam complaints under {percent(COMPLAINT_TARGET)}, and never let them reach{' '}
            {percent(COMPLAINT_LIMIT)}. Gmail’s{' '}
            <a
              className={LINK}
              href="https://support.google.com/a/answer/81126"
              target="_blank"
              rel="noreferrer"
            >
              sender guidelines
            </a>{' '}
            explain the rules.
          </p>
        </div>
        {hasIp && (
          <div>
            <h3 className="text-[14px] font-semibold">Microsoft SNDS</h3>
            <p className={`${STEP} mt-2`}>
              Outlook and Hotmail report by IP address, so this helps now that you have a dedicated
              IP. Sign in at{' '}
              <a
                className={LINK}
                href="https://sendersupport.olc.protection.outlook.com/snds/"
                target="_blank"
                rel="noreferrer"
              >
                Smart Network Data Services
              </a>{' '}
              with a Microsoft account, and ask for access to your IP address.
            </p>
          </div>
        )}
      </div>
    </Section>
  );
}
