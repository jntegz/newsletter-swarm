// A Broadcast's Split Test results per variant, or its Cohort Sample's health. Kept apart from
// ./HoldBack (the setup, which loads the editor) so the Broadcast page stays light.
import type { BroadcastDetail, CohortSample, SplitTest } from '@swarm/domain';
import { Pill } from '@swarm/ui/components';
import { Section, formatDateTime, numberFormat, percentFormat } from '../pages/common';

const COHORT_PILL: Record<
  CohortSample['status'],
  { tone: 'brand' | 'scheduled' | 'success' | 'neutral' | 'danger'; label: string }
> = {
  draft: { tone: 'brand', label: 'Ready' },
  sampling: { tone: 'scheduled', label: 'Sampling' },
  extended: { tone: 'success', label: 'Sent to everyone' },
  halted: { tone: 'danger', label: 'Halted' },
  canceled: { tone: 'neutral', label: 'Canceled' },
};

export function CohortPill({ status }: { status: CohortSample['status'] }) {
  return <Pill tone={COHORT_PILL[status].tone}>{COHORT_PILL[status].label}</Pill>;
}
// ---- Broadcast results ---------------------------------------------------------------------

export function HoldBackResults({ broadcast }: { broadcast: BroadcastDetail }) {
  if (broadcast.splitTest) return <SplitTestResults test={broadcast.splitTest} />;
  if (broadcast.cohortSample) return <CohortResults sample={broadcast.cohortSample} />;
  return null;
}

function SplitTestResults({ test }: { test: SplitTest }) {
  const metric = { opens: 'Opens', clicks: 'Clicks', goal: 'Conversions' }[test.metric];
  const best = Math.max(0, ...test.variants.map((v) => v.rate));
  const winner = test.variants.find((v) => v.id === test.winnerVariantId);
  const status =
    test.status === 'testing'
      ? test.decideAt
        ? `Testing on ${test.testPercent}% of the audience. The winner is picked around ${formatDateTime(test.decideAt)}.`
        : `Testing on ${test.testPercent}% of the audience. The clock starts once the test part has gone out.`
      : test.status === 'promoted'
        ? winner
          ? `Variant ${winner.label} won on ${metric.toLowerCase()}${test.decidedAt ? ` (${formatDateTime(test.decidedAt)})` : ''}${test.testPercent < 100 ? ' and went to the rest of the audience.' : '.'}`
          : 'The winner was sent to the rest of the audience.'
        : test.status === 'canceled'
          ? 'The Split Test was canceled.'
          : 'The Split Test starts when the post is sent.';
  return (
    <Section title="Split Test" description={status}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-[13px]">
          <caption className="sr-only">Results per variant</caption>
          <thead>
            <tr className="table-head">
              <th scope="col" className="py-2 pr-3 font-semibold">
                Variant
              </th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">
                Recipients
              </th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">
                Delivered
              </th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">
                {metric}
              </th>
              <th scope="col" className="py-2 pl-3 font-semibold">
                Rate
              </th>
            </tr>
          </thead>
          <tbody>
            {test.variants.map((v) => (
              <tr key={v.id} className="border-t border-line align-top">
                <td className="py-2.5 pr-3">
                  <span className="font-semibold">{v.label}</span>{' '}
                  {v.id === test.winnerVariantId && <Pill tone="success">Winner</Pill>}
                  <span className="block max-w-[28ch] truncate text-[12.5px] text-sub">
                    {test.variable === 'subject'
                      ? (v.subject ?? 'The post’s subject')
                      : v.label === 'A'
                        ? 'The post as written'
                        : `Content ${v.label}`}
                  </span>
                </td>
                <td className="tabular px-3 py-2.5 text-right">
                  {numberFormat.format(v.recipients)}
                </td>
                <td className="tabular px-3 py-2.5 text-right">
                  {numberFormat.format(v.delivered)}
                </td>
                <td className="tabular px-3 py-2.5 text-right">{numberFormat.format(v.value)}</td>
                <td className="py-2.5 pl-3">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-24 overflow-hidden rounded-pill bg-surface-alt">
                      <span
                        className="block h-full rounded-pill bg-purple"
                        style={{ width: `${best > 0 ? (v.rate / best) * 100 : 0}%` }}
                      />
                    </span>
                    <span className="tabular">{percentFormat.format(v.rate)}</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function CohortResults({ sample }: { sample: CohortSample }) {
  const m = sample.metrics;
  const rows: { label: string; value: number; limit: string; ok: boolean }[] = m
    ? [
        ...(sample.minOpenRate !== null
          ? [
              {
                label: 'Open rate',
                value: m.openRate,
                limit: `at least ${percentFormat.format(sample.minOpenRate)}`,
                ok: m.openRate >= sample.minOpenRate,
              },
            ]
          : []),
        {
          label: 'Bounce rate',
          value: m.bounceRate,
          limit: `at most ${percentFormat.format(sample.maxBounceRate)}`,
          ok: m.bounceRate <= sample.maxBounceRate,
        },
        {
          label: 'Complaint rate',
          value: m.complaintRate,
          limit: `at most ${percentFormat.format(sample.maxComplaintRate)}`,
          ok: m.complaintRate <= sample.maxComplaintRate,
        },
        {
          label: 'Unsubscribe rate',
          value: m.unsubscribeRate,
          limit: `at most ${percentFormat.format(sample.maxUnsubscribeRate)}`,
          ok: m.unsubscribeRate <= sample.maxUnsubscribeRate,
        },
      ]
    : [];
  const description = {
    draft: 'Cohort Sampling starts when the post is sent.',
    sampling: sample.decideAt
      ? `Sent to ${sample.samplePercent}% first. The rest follow around ${formatDateTime(sample.decideAt)} if the sample stays healthy.`
      : `Sent to ${sample.samplePercent}% first. The clock starts once the sample has gone out.`,
    extended: 'The sample stayed healthy, so the rest of the audience got it too.',
    halted: 'The sample missed a threshold, so the rest of the audience was not sent.',
    canceled: 'Cohort Sampling was canceled.',
  }[sample.status];
  return (
    <Section
      title="Cohort Sampling"
      description={description}
      action={<CohortPill status={sample.status} />}
    >
      {!m && <p className="text-[13px] text-sub">No numbers from the sample yet.</p>}
      {m && (
        <>
          <p className="mb-3 text-[13px] text-sub">
            {numberFormat.format(m.delivered)} delivered of {numberFormat.format(m.sent)} sent in
            the sample.
          </p>
          <ul className="grid gap-1.5 text-[13px]">
            {rows.map((row) => (
              <li key={row.label} className="flex flex-wrap items-center gap-2">
                <Pill tone={row.ok ? 'success' : 'danger'}>{row.ok ? 'Within' : 'Missed'}</Pill>
                <span>
                  {row.label} <b className="tabular">{percentFormat.format(row.value)}</b>{' '}
                  <span className="text-sub">({row.limit})</span>
                </span>
              </li>
            ))}
          </ul>
          {m.reasons.length > 0 && (
            <ul className="mt-3 grid gap-1 rounded-card-app bg-danger-soft px-3 py-2 text-[12.5px]">
              {m.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </Section>
  );
}
