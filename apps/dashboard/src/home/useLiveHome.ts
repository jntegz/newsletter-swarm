// Home from the API. Everything here comes from queries the dashboard already had; what has no
// API yet (a referrals summary, a daily subscriber trend) is left out, never filled with samples.
import type { Channel, DispatchSummary } from '@swarm/domain';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { deliverabilityQuery } from '../api/deliverability';
import { memberCountsQuery } from '../api/members';
import { paymentsQuery, revenueQuery } from '../api/money';
import {
  broadcastQuery,
  broadcastStatsQuery,
  channelOverviewQuery,
  dispatchesQuery,
  domainsQuery,
  preflightQuery,
  rampsQuery,
  sendersQuery,
} from '../api/send';
import { PROVIDER_LABEL } from '../send/deliverability-helpers';
import { waitNeed } from '../send/sending-limits';
import { useCadence } from '../send/useCadence';
import { dayNumber, primaryRamp } from '../send/warmup-helpers';
import { firstPostWarmupLine, homeWarmupNote, warmupHref } from '../send/warmup-notes';
import { dayOf, lastDays } from '../site/helpers';
import { paidState, rateTrends, subscriberDelta } from './helpers';
import type { HealthItem, HomeModel, NeedItem, NextItem, SetupStation } from './model';

const number = new Intl.NumberFormat('en-US');
const dayFormat = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});
const shortDay = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

const sendDay = (iso: string) => dayFormat.format(new Date(iso));
const sendTime = (iso: string) => timeFormat.format(new Date(iso));

/** "2 hours ago", "yesterday", "3 days ago". */
function ago(iso: string, now = Date.now()): string {
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour');
  return relative.format(Math.round(hours / 24), 'day');
}

const sentPosts = (list: readonly DispatchSummary[]) =>
  list
    .filter((d) => d.kind === 'broadcast' && d.status === 'sent' && d.latestBroadcastId)
    .sort((a, b) => (b.sentAt ?? b.updatedAt).localeCompare(a.sentAt ?? a.updatedAt));

interface LiveHome {
  model: HomeModel | null;
  pending: boolean;
  error: Error | null;
}

export function useLiveHome(channel: Channel): LiveHome {
  const id = channel.id;
  const [today] = useState(() => dayOf(Date.now()));
  const range = lastDays(30, today);
  const dispatches = useQuery(dispatchesQuery(id));
  const counts = useQuery(memberCountsQuery(id));
  const domains = useQuery(domainsQuery(id));
  const ramps = useQuery(rampsQuery(id));
  const senders = useQuery(sendersQuery(id));
  const [cadence] = useCadence(id);
  const deliverability = useQuery(deliverabilityQuery(id, range));
  const payments = useQuery(paymentsQuery(id));
  const revenue = useQuery({
    ...revenueQuery(id, range),
    enabled: payments.data?.connected === true,
  });
  // Growth and rate changes. Home still works without them, so a failure only hides the changes.
  const overview = useQuery(channelOverviewQuery(id));

  const list = dispatches.data ?? [];
  const sent = sentPosts(list);
  const last = sent[0];
  const lastBroadcast = useQuery({
    ...broadcastQuery(last?.latestBroadcastId ?? ''),
    enabled: !!last,
  });
  const lastEight = sent.slice(0, 8).reverse();
  const stats = useQueries({
    queries: lastEight.map((d) => broadcastStatsQuery(d.latestBroadcastId ?? '', false)),
  });
  const lastStats = stats[stats.length - 1];

  // Sends going out now: Home says so while one waits for a sending limit.
  const going = list.filter(
    (d) => d.kind === 'broadcast' && d.status === 'sending' && d.latestBroadcastId,
  );
  const goingReports = useQueries({
    queries: going.slice(0, 3).map((d) => ({
      ...broadcastQuery(d.latestBroadcastId ?? ''),
      refetchInterval: 60_000,
    })),
  });

  const scheduled = list
    .filter((d) => d.kind === 'broadcast' && d.status === 'scheduled' && d.publishAt)
    .sort((a, b) => (a.publishAt ?? '').localeCompare(b.publishAt ?? ''));
  const next = scheduled[0];
  const preflight = useQuery({ ...preflightQuery(next?.id ?? ''), enabled: !!next });

  const pending = dispatches.isPending || counts.isPending || domains.isPending;
  if (pending || dispatches.error) {
    return { model: null, pending, error: dispatches.error };
  }

  // ---- Setup route -------------------------------------------------------------------------
  const emailDomains = (domains.data ?? []).filter((d) => d.kind === 'email');
  const verified = emailDomains.find((d) => d.status === 'verified');
  const domain = verified ?? emailDomains[0];
  const dmarcOk =
    !!domain && (domain.dmarcPolicy === 'quarantine' || domain.dmarcPolicy === 'reject');
  const active = counts.data?.active ?? 0;
  const pendingMembers = counts.data?.pending ?? 0;
  // The warm-up of the domain posts go out from: the default sender's own, else the shared one.
  const ramp = primaryRamp(
    ramps.data ?? [],
    senders.data?.find((sender) => sender.isDefault)?.sendingDomainId,
  );
  const firstPostLine = sent.length === 0 ? firstPostWarmupLine(ramp) : null;
  const stations: SetupStation[] = [
    {
      id: 'domain',
      title: 'Sending domain',
      done: !!verified,
      summary: verified
        ? `${verified.domain} verified${verified.dkimStatus === 'success' ? ', DKIM signing on' : ''}`
        : domain
          ? `${domain.domain} is waiting for its DNS records.`
          : 'Add the domain your posts come from.',
    },
    {
      id: 'dmarc',
      title: 'DMARC set to quarantine',
      done: dmarcOk,
      summary: dmarcOk
        ? `p=${domain?.dmarcPolicy ?? 'quarantine'} found`
        : domain?.dmarcPolicy === 'none'
          ? 'Your record says p=none. Add this TXT record at your DNS host, then check again.'
          : domain
            ? 'No DMARC record found yet. Add this TXT record at your DNS host, then check again.'
            : 'Set after the sending domain.',
    },
    {
      id: 'subscribers',
      title: 'First subscribers',
      done: active > 0,
      summary:
        active > 0
          ? `${number.format(active)} active${pendingMembers ? `, ${number.format(pendingMembers)} waiting to confirm` : ''}`
          : 'Import a list, or add a signup form.',
    },
    {
      id: 'post',
      title: 'First post',
      done: sent.length > 0,
      summary: `Write it now. It sends once the steps above are done.${firstPostLine ? ` ${firstPostLine}` : ''}`,
    },
  ];
  const dmarcRecord = domain?.records.find((r) => r.purpose === 'dmarc');
  const dmarc =
    domain && !dmarcOk && dmarcRecord
      ? { host: dmarcRecord.name, value: dmarcRecord.value, domainId: domain.id }
      : null;

  const sendingHref = `/channels/${id}/sending`;
  const editorHref = (d: DispatchSummary) => `/dispatches/${d.id}`;

  // ---- Needs you ---------------------------------------------------------------------------
  const needs: NeedItem[] = [];
  for (const report of goingReports) {
    const waiting = report.data?.waiting;
    // Waiting for its share of the capacity goes on by itself: the send report says so, Home doesn't.
    if (!report.data || !waiting || waiting.reason === 'share') continue;
    needs.push({
      id: `waiting-${report.data.id}`,
      ...waitNeed(report.data.subject, waiting),
      action: { label: 'Open send report', href: `/broadcasts/${report.data.id}` },
    });
  }
  const warmup = homeWarmupNote(ramp, cadence);
  if (warmup?.tone === 'paused') {
    needs.push({
      id: 'ramp',
      title: `${warmup.title}.`,
      detail:
        'Nothing goes out from it until someone resumes sending. What to do is at the top of this page.',
      action: { label: 'Open warm-up', href: warmupHref(id) },
    });
  }
  // A verified domain does nothing until a sender uses it: posts keep going out from the shared
  // address, while the setup route above already shows the domain as done.
  if (verified && senders.data && !senders.data.some((s) => s.sendingDomainId === verified.id)) {
    needs.push({
      id: 'sender',
      title: `${verified.domain} is verified, but no sender uses it yet.`,
      detail: 'Posts still go out from the shared address. Add a sender on your domain.',
      action: { label: 'Add a sender', href: sendingHref },
    });
  }
  if (next) {
    const when = `${sendDay(next.publishAt!)}, ${sendTime(next.publishAt!)}`;
    const name = next.subject || 'An untitled post';
    if (!next.preheader.trim()) {
      needs.push({
        id: `preview-${next.id}`,
        title: `${name} sends ${when}, and its preview text is empty.`,
        detail: 'Inboxes will show the first line of the post instead.',
        action: { label: 'Add preview text', href: editorHref(next) },
      });
    }
    for (const check of preflight.data?.checks.filter((c) => !c.ok) ?? []) {
      needs.push({
        id: `check-${next.id}-${check.key}`,
        title: `${name} can’t send ${when} yet.`,
        detail: check.message,
        action: { label: 'Open the post', href: editorHref(next) },
      });
    }
  }
  const complaints = deliverability.data?.complaints;
  if (complaints && complaints.standing !== 'good' && complaints.rate !== null) {
    needs.push({
      id: 'complaints',
      title: `Spam complaints are at ${(complaints.rate * 100).toFixed(2)}% over the last 30 days.`,
      detail: 'Above 0.1% mailbox providers start to filter. Check who you send to and how often.',
      action: { label: 'See deliverability', href: `/channels/${id}/deliverability` },
    });
  }

  // ---- Up next -----------------------------------------------------------------------------
  const drafts = list
    .filter((d) => d.kind === 'broadcast' && d.status === 'draft' && !d.importedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const upNext: NextItem[] = [
    ...scheduled.slice(0, 2).map<NextItem>((d) => ({
      id: d.id,
      title: d.subject || 'Untitled post',
      href: editorHref(d),
      when: {
        kind: 'scheduled',
        day: sendDay(d.publishAt!),
        time: sendTime(d.publishAt!),
        iso: d.publishAt!,
      },
      meta:
        d.id === next?.id && preflight.data
          ? `Scheduled · to ${number.format(preflight.data.recipientCount)} subscribers`
          : 'Scheduled',
    })),
    ...drafts.slice(0, 3).map<NextItem>((d) => ({
      id: d.id,
      title: d.subject || 'Untitled post',
      href: editorHref(d),
      when: { kind: 'draft', edited: `edited ${ago(d.updatedAt)}` },
      meta: 'Not scheduled',
    })),
  ];

  // ---- Last send ---------------------------------------------------------------------------
  const s = lastStats?.data;
  const b = lastBroadcast.data;
  const lastSend =
    last && s
      ? {
          title: last.subject || 'Untitled post',
          href: editorHref(last),
          reportHref: `/broadcasts/${last.latestBroadcastId}`,
          sentAt: last.sentAt ? `${sendDay(last.sentAt)}, ${sendTime(last.sentAt)}` : '',
          queued: b?.recipientCount ?? s.sent,
          delivered: s.delivered,
          opened: Math.round(s.openRate * s.delivered),
          // People, as on the send report: uniqueClicks also counts link scanners.
          clicked: s.humanClicks,
          bounced: s.bounced,
          unsubscribed: s.unsubscribed,
          complained: s.complained,
        }
      : null;

  const providers = (deliverability.data?.providers ?? []).filter((p) => p.sent > 0);
  const placement = providers.length
    ? {
        items: providers.map((p) => ({
          label: PROVIDER_LABEL[p.provider],
          rate: p.delivered / p.sent,
        })),
        note: 'Delivered by provider, last 30 days',
      }
    : null;

  const sends = lastEight.flatMap((d, i) => {
    const data = stats[i]?.data;
    if (!data) return [];
    const when = d.sentAt ? shortDay.format(new Date(d.sentAt)) : '';
    return [
      {
        label: when,
        name: d.subject || 'Untitled post',
        open: data.openRate * 100,
        click: data.delivered ? (data.humanClicks / data.delivered) * 100 : 0,
      },
    ];
  });

  // ---- Growth and money --------------------------------------------------------------------
  const c = counts.data;
  const delta = overview.data ? subscriberDelta(overview.data.members) : undefined;
  const subscribers = c
    ? {
        total: c.active,
        ...(delta ? { delta } : {}),
        facts: [
          { label: 'Waiting to confirm', value: number.format(c.pending) },
          { label: 'Unsubscribed', value: number.format(c.unsubscribed), note: 'all time' },
          {
            label: 'Bounced or complained',
            value: number.format(c.bounced + c.complained),
            note: 'not mailed',
          },
        ],
      }
    : null;

  const paid = paidState({
    connected: payments.data?.connected,
    paymentsError: payments.error,
    revenue: revenue.data,
    revenueError: revenue.error,
  });

  // ---- Sending health ----------------------------------------------------------------------
  const health: HealthItem[] = [];
  if (domain) {
    health.push(
      verified
        ? {
            tone: 'ok',
            text: `${verified.domain} verified${verified.dkimStatus === 'success' ? ', DKIM signing on' : ''}`,
          }
        : { tone: 'warn', text: `${domain.domain} is not verified yet` },
    );
    health.push(
      dmarcOk
        ? { tone: 'ok', text: `DMARC p=${domain.dmarcPolicy}` }
        : {
            tone: 'warn',
            text: `DMARC is ${domain.dmarcPolicy ? `p=${domain.dmarcPolicy}` : 'missing'}`,
          },
    );
  } else {
    health.push({
      tone: 'wait',
      text: 'No sending domain yet: posts go out from the shared domain',
    });
  }
  if (ramp) {
    health.push(
      ramp.status === 'complete'
        ? {
            tone: 'ok',
            text: ramp.skipped
              ? 'Warm-up skipped: no daily limit'
              : 'Warm-up finished: no daily limit',
          }
        : ramp.status === 'paused'
          ? { tone: 'warn', text: 'Warm-up paused' }
          : {
              tone: 'ok',
              text: `Warm-up day ${dayNumber(ramp)}: up to ${number.format(ramp.plan.days[0]?.cap ?? ramp.capToday)} emails today`,
            },
    );
  } else if (domain) {
    health.push({ tone: 'wait', text: 'Warm-up starts with your first send' });
  }

  const mode = sent.length > 0 ? 'established' : 'setup';
  const remaining = stations.filter((st) => !st.done).length;
  const subtitle =
    mode === 'established' && lastSend
      ? `Your last send reached ${((lastSend.delivered / Math.max(1, lastSend.queued)) * 100).toFixed(1)}% of inboxes.${
          next ? ` Next send ${sendDay(next.publishAt!)}, ${sendTime(next.publishAt!)}.` : ''
        }`
      : mode === 'established'
        ? `${channel.name}: what needs you, what’s next and how the last send did.`
        : remaining === 1
          ? 'One step left before you can send.'
          : `${remaining} steps to your first send.`;

  return {
    pending: false,
    error: null,
    model: {
      mode,
      subtitle,
      setup: { stations, dmarc },
      warmup,
      needs,
      upNext,
      lastSend,
      placement,
      sends,
      rates: overview.data ? rateTrends(overview.data.broadcasts) : null,
      subscribers,
      automations: 'live',
      referrals: null,
      paid,
      health,
      links: {
        posts: `/dispatches?channel=${id}`,
        reports: `/dispatches?channel=${id}`,
        subscribers: `/members?channel=${id}`,
        sending: sendingHref,
        forms: `/forms?channel=${id}`,
        paid: `/memberships?channel=${id}`,
        import: `/members/import?channel=${id}`,
      },
    },
  };
}
