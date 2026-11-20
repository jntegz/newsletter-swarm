// Sending & delivery: senders, domains, warm-up, blocked addresses and inactive readers, as bands.
// Add forms open from a button; a single choice saves as it changes (see DESIGN.md).
import type {
  Channel,
  CheckedSendingDomain,
  DnsRecord,
  MailServiceKey,
  RecordState,
  SendingDomain,
} from '@swarm/domain';
import {
  Button,
  Dialog,
  ErrorNotice,
  LoadingRows,
  Pill,
  SelectField,
  TextField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { flowsQuery } from '../api/flows';
import { channelQuery, useUpdateChannel } from '../api/queries';
import { retentionQuery } from '../api/retention';
import {
  domainsQuery,
  rampsQuery,
  sendersQuery,
  useAddDomain,
  useAddSender,
  useMakeDefaultSender,
  useRemoveDomain,
  useRemoveSender,
  useVerifyDomain,
} from '../api/send';
import * as Icon from '../icons';
import { BOUNCES_ANCHOR, BounceRulesSection, NeedsAttentionSection } from '../send/Bounces';
import { EmailCssSection } from '../send/EmailCss';
import { EmailDesignSection } from '../send/EmailDesign';
import { InactiveReadersSection, SuppressionsSection } from '../send/Suppressions';
import { SystemEmailsSection } from '../send/SystemEmails';
import { InactiveReadersPaused, TRACKING_ANCHOR, TrackingSection } from '../send/Tracking';
import { DOMAINS_ANCHOR, WarmupSection } from '../send/Warmup';
import { PACE_NAMES, growthPercent, todaysLimit } from '../send/warmup-helpers';
import { WARMUP_ANCHOR } from '../send/warmup-notes';
import { InlineAdd } from '../shell/InlineAdd';
import { SavedNote, useSaveState } from '../shell/SavedNote';
import { PageHeader } from './Channels';
import { Bands, Section, formatDateTime, formatDay, numberFormat } from './common';
import { SERVICE_NAMES } from './email-service';

export function SendingSettingsPage({ channelId }: { channelId: string }) {
  const channel = useQuery(channelQuery(channelId));
  if (channel.isPending) return <LoadingRows label="Loading publication" rows={4} />;
  if (channel.error)
    return <ErrorNotice title="Publication not available" message={channel.error.message} />;
  return <SendingSettings channel={channel.data} />;
}

function SendingSettings({ channel }: { channel: Channel }) {
  const admin = channel.role === 'admin' || channel.role === 'owner';
  // Links from Home, the send panel and the import review land on a section of this page. The
  // sections only exist once the publication has loaded, so the browser's own jump comes too early.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if ([WARMUP_ANCHOR, DOMAINS_ANCHOR, TRACKING_ANCHOR, BOUNCES_ANCHOR].includes(id)) {
      document.getElementById(id)?.scrollIntoView();
    }
  }, []);
  return (
    <>
      <PageHeader
        title="Sending"
        subtitle={`Who ${channel.name} sends from, and how fast.`}
        action={
          <div className="flex flex-wrap gap-2">
            <Link
              to="/channels/$channelId/deliverability"
              params={{ channelId: channel.id }}
              className="btn-ghost"
            >
              Deliverability
            </Link>
            <Link
              to="/channels/$channelId"
              params={{ channelId: channel.id }}
              className="btn-ghost"
            >
              Publication settings
            </Link>
          </div>
        }
      />
      <Bands ruled>
        <Senders channel={channel} admin={admin} />
        <div id={DOMAINS_ANCHOR} className="min-w-0 scroll-mt-20">
          <Domains channel={channel} admin={admin} />
        </div>
        <div id={WARMUP_ANCHOR} className="min-w-0 scroll-mt-20">
          <WarmupSection channel={channel} admin={admin} />
        </div>
        <EmailDesignSection channel={channel} admin={admin} />
        <EmailCssSection channel={channel} admin={admin} />
        <SystemEmailsSection channel={channel} admin={admin} />
        <div id={TRACKING_ANCHOR} className="min-w-0 scroll-mt-20">
          <TrackingSection channel={channel} admin={admin} />
        </div>
        <div id={BOUNCES_ANCHOR} className="grid min-w-0 scroll-mt-20 gap-5">
          <NeedsAttentionSection channel={channel} />
          <BounceRulesSection channel={channel} />
        </div>
        <SuppressionsSection channel={channel} admin={admin} />
        <div className="grid min-w-0 gap-3">
          <InactiveReadersPaused channel={channel} />
          <InactiveReaders channel={channel} admin={admin} />
        </div>
      </Bands>
    </>
  );
}

function InactiveReaders({ channel, admin }: { channel: Channel; admin: boolean }) {
  const update = useUpdateChannel(channel.id);
  // Admins only: the cleanup waits when the period is longer than the history kept.
  const retention = useQuery({ ...retentionQuery(channel.workspaceId), enabled: admin });
  const note = useSaveState();
  // The choice moves as soon as it's made, and goes back if the save fails.
  const [picked, setPicked] = useState(channel.sunsetDays);
  const [before, setBefore] = useState<number | null>(channel.sunsetDays);
  const save = (sunsetDays: number | null, previous: number | null, undoable: boolean) => {
    setPicked(sunsetDays);
    note.saving();
    update.mutate(
      { sunsetDays },
      {
        onSuccess: () => {
          setBefore(undoable ? previous : sunsetDays);
          if (undoable) note.saved();
          else note.reset();
        },
        onError: () => {
          setPicked(previous);
          note.failed();
        },
      },
    );
  };
  return (
    <InactiveReadersSection
      channel={channel}
      value={picked}
      admin={admin}
      onChange={(sunsetDays) => save(sunsetDays, picked, true)}
      note={
        <SavedNote
          state={note.state}
          onUndo={() => save(before, picked, false)}
          failedText={`Not saved: ${update.error?.message ?? 'try again'}.`}
        />
      }
      reengage={<ReengageLink channel={channel} />}
      historyMonths={retention.data?.months ?? null}
    />
  );
}

/**
 * Inactive readers are best asked first. Opens the re-engagement automation if there is one, else
 * the New automation dialog with the Re-engagement recipe chosen.
 */
function ReengageLink({ channel }: { channel: Channel }) {
  const flows = useQuery(flowsQuery(channel.id));
  const existing = flows.data?.find(
    (flow) => flow.triggerType === 'unengaged' || flow.triggerTypes.includes('unengaged'),
  );
  return (
    <div className="grid gap-1.5 text-[13px] leading-[1.55]">
      <p className="text-sub">
        Try winning them back first: a re-engagement automation checks in with readers who haven’t
        opened anything for 60 days.
      </p>
      {existing ? (
        <Link
          to="/flows/$flowId"
          params={{ flowId: existing.id }}
          className="justify-self-start font-semibold text-purple"
        >
          Open {existing.name}
        </Link>
      ) : (
        <Link
          to="/flows"
          search={{ channel: channel.id, recipe: 'reengagement' }}
          className="justify-self-start font-semibold text-purple"
        >
          Start a re-engagement automation
        </Link>
      )}
    </div>
  );
}

// ---- Senders -------------------------------------------------------------------------------

function Senders({ channel, admin }: { channel: Channel; admin: boolean }) {
  const senders = useQuery(sendersQuery(channel.id));
  const makeDefault = useMakeDefaultSender(channel.id);
  const remove = useRemoveSender(channel.id);

  return (
    <Section
      title="Senders"
      description="The name and address subscribers see. Without your own domain, mail comes from the shared Swarm domain at your publication's address."
    >
      {senders.isPending && <LoadingRows label="Loading senders" rows={2} />}
      {senders.error && <ErrorNotice message={senders.error.message} />}
      {senders.data?.length === 0 && (
        <p className="text-[13.5px] text-sub">
          No senders yet. Posts go out from {channel.name} on the shared domain.
        </p>
      )}
      {!!senders.data?.length && (
        <ul className="divide-y divide-line border-b border-line">
          {senders.data.map((sender) => (
            <li
              key={sender.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3 text-[13.5px] first:pt-0"
            >
              <span className="min-w-0 break-words">
                <b className="block">{sender.fromName}</b>
                <span className="font-mono text-[12.5px] break-all text-sub">
                  {sender.fromAddress}
                </span>
                {sender.replyTo && <span className="text-sub"> · replies to {sender.replyTo}</span>}
              </span>
              <span className="flex items-center gap-2">
                {sender.isDefault ? (
                  <Pill tone="brand">Default</Pill>
                ) : (
                  admin && (
                    <Button
                      variant="quiet"
                      size="sm"
                      loading={makeDefault.isPending && makeDefault.variables === sender.id}
                      onClick={() => makeDefault.mutate(sender.id)}
                    >
                      Make default
                    </Button>
                  )
                )}
                {admin && (
                  <Button
                    variant="quiet"
                    size="sm"
                    aria-label={`Remove ${sender.fromAddress}`}
                    onClick={() => remove.mutate(sender.id)}
                  >
                    Remove
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {admin && (
        <div className="mt-4">
          <AddSender channel={channel} />
        </div>
      )}
    </Section>
  );
}

function AddSender({ channel }: { channel: Channel }) {
  const domains = useQuery(domainsQuery(channel.id));
  const add = useAddSender(channel.id);
  const [fromName, setFromName] = useState(channel.name);
  const [fromLocal, setFromLocal] = useState('hello');
  const [domainId, setDomainId] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const error = add.error instanceof ApiError ? add.error : null;
  const emailDomains = (domains.data ?? []).filter((d) => d.kind === 'email');
  const clear = () => {
    setFromName(channel.name);
    setFromLocal('hello');
    setDomainId('');
    setReplyTo('');
    add.reset();
  };

  return (
    <InlineAdd
      label="Add sender"
      formLabel="Add a sender"
      pending={add.isPending}
      onCancel={clear}
      onSubmit={(done) =>
        add.mutate(
          {
            fromName,
            fromLocal,
            sendingDomainId: domainId || null,
            replyTo: replyTo.trim() || null,
          },
          {
            onSuccess: (sender) => {
              clear();
              done(`Added ${sender.fromName} <${sender.fromAddress}>.`);
            },
          },
        )
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Sender name"
          required
          maxLength={80}
          value={fromName}
          onChange={(e) => setFromName(e.target.value)}
          error={error?.field('fromName')}
        />
        <SelectField
          label="Domain"
          value={domainId}
          onChange={(e) => setDomainId(e.target.value)}
          options={[
            { value: '', label: `Shared domain (${channel.slug}@…)` },
            ...emailDomains.map((d) => ({
              value: d.id,
              label: `${d.domain}${d.status === 'verified' ? '' : ' (not verified)'}`,
            })),
          ]}
        />
        {domainId && (
          <TextField
            label="Address before @"
            required
            value={fromLocal}
            onChange={(e) => setFromLocal(e.target.value)}
            error={error?.field('fromLocal')}
            className="font-mono text-[13px]"
          />
        )}
        <TextField
          label="Reply-to (optional)"
          type="email"
          value={replyTo}
          onChange={(e) => setReplyTo(e.target.value)}
          error={error?.field('replyTo')}
          hint="Where replies go. Defaults to the sender address."
        />
      </div>
      {error && !error.details.length && <ErrorNotice message={error.message} />}
    </InlineAdd>
  );
}

// ---- Domains -------------------------------------------------------------------------------

const DOMAIN_TONE = { verified: 'success', pending: 'scheduled', failed: 'danger' } as const;

function Domains({ channel, admin }: { channel: Channel; admin: boolean }) {
  const domains = useQuery(domainsQuery(channel.id));
  return (
    <Section
      title="Domains"
      description="Send from your own domain for the best deliverability, and brand your links. A sending domain must publish DMARC at quarantine or reject before its first send."
    >
      {domains.isPending && <LoadingRows label="Loading domains" rows={2} />}
      {domains.error && <ErrorNotice message={domains.error.message} />}
      {domains.data?.length === 0 && (
        <p className="text-[13.5px] text-sub">
          No domains yet. Mail goes out on the shared domain.
        </p>
      )}
      {!!domains.data?.length && (
        <div className="divide-y divide-line border-b border-line">
          {domains.data.map((d) => (
            <DomainBlock key={d.id} domain={d} channelId={channel.id} admin={admin} />
          ))}
        </div>
      )}
      {admin && (
        <div className="mt-4">
          <AddDomain channel={channel} />
        </div>
      )}
    </Section>
  );
}

function AddDomain({ channel }: { channel: Channel }) {
  const add = useAddDomain(channel.id);
  const [domain, setDomain] = useState('');
  const [kind, setKind] = useState<'email' | 'link'>('email');
  const error = add.error instanceof ApiError ? add.error : null;
  const clear = () => {
    setDomain('');
    setKind('email');
    add.reset();
  };
  return (
    <InlineAdd
      label="Add domain"
      formLabel="Add a domain"
      pending={add.isPending}
      onCancel={clear}
      onSubmit={(done) =>
        add.mutate(
          { domain, kind },
          {
            onSuccess: (added) => {
              clear();
              done(`Added ${added.domain}. Its DNS records are listed above.`);
            },
          },
        )
      }
    >
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_220px]">
        <TextField
          label="Domain"
          required
          placeholder={kind === 'email' ? 'news.example.com' : 'links.example.com'}
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          // A conflict's message says which TXT record proves the domain is yours; its details
          // only list it.
          error={
            error && (error.code === 'conflict' || !error.details.length)
              ? error.message
              : error?.field('domain')
          }
          className="font-mono text-[13px]"
        />
        <SelectField
          label="Use"
          value={kind}
          onChange={(e) => setKind(e.target.value as 'email' | 'link')}
          options={[
            { value: 'email', label: 'Sending (From address)' },
            { value: 'link', label: 'Branded links' },
          ]}
        />
      </div>
    </InlineAdd>
  );
}

function DomainBlock({
  domain,
  channelId,
  admin,
}: {
  domain: SendingDomain;
  channelId: string;
  admin: boolean;
}) {
  const verify = useVerifyDomain(channelId);
  const remove = useRemoveDomain(channelId);
  const [confirming, setConfirming] = useState(false);
  const dmarcOk = domain.dmarcPolicy === 'quarantine' || domain.dmarcPolicy === 'reject';

  return (
    <div className="min-w-0 py-4 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-mono text-[13.5px] font-semibold break-all">{domain.domain}</span>
          <Pill tone={DOMAIN_TONE[domain.status]}>
            {domain.status === 'verified'
              ? 'Verified'
              : domain.status === 'failed'
                ? 'Failed'
                : 'Waiting for DNS'}
          </Pill>
          <Pill tone="neutral">{domain.kind === 'email' ? 'Sending' : 'Links'}</Pill>
          {domain.kind === 'email' && (
            <Pill tone={dmarcOk ? 'success' : 'danger'}>
              DMARC {domain.dmarcPolicy ?? 'missing'}
            </Pill>
          )}
        </div>
        {admin && (
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              loading={verify.isPending}
              onClick={() => verify.mutate(domain.id)}
            >
              Check now
            </Button>
            <Button variant="quiet" size="sm" onClick={() => setConfirming(true)}>
              Remove
            </Button>
          </div>
        )}
      </div>
      <p className="mt-2 mb-2 text-[12.5px] text-sub">
        {domain.status === 'verified'
          ? `Verified ${formatDay(domain.verifiedAt)}. Keep these records published.`
          : `Add these records at your DNS provider. Swarm checks every few minutes${domain.lastCheckedAt ? `; last checked ${formatDateTime(domain.lastCheckedAt)}` : ''}.`}
      </p>
      <DnsTable records={domain.records} checks={verify.data?.recordChecks} />
      {domain.kind === 'email' && domain.status === 'verified' && (
        <DomainWarmup domain={domain} channelId={channelId} admin={admin} />
      )}
      {domain.pendingChange && (
        <div className="mt-4 border-t border-line pt-3">
          <p className="mb-2 text-[13px] font-semibold">
            This Swarm is moving to {SERVICE_NAMES[domain.pendingChange.service as MailServiceKey]}
          </p>
          <p className="mb-2 text-[12.5px] text-sub">
            Add these records as well, and keep the ones above until the move is done. Without them,
            this domain can’t send after the move. “Check now” looks for them too.
          </p>
          <DnsTable records={domain.pendingChange.records} checks={verify.data?.pendingChecks} />
        </div>
      )}
      {verify.error && <ErrorNotice message={verify.error.message} />}
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Remove ${domain.domain}?`}
        description="Senders on this domain are removed too, and posts using them fall back to the default sender."
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => remove.mutate(domain.id, { onSuccess: () => setConfirming(false) })}
            >
              Remove domain
            </Button>
          </>
        }
      >
        {remove.error && <ErrorNotice message={remove.error.message} />}
      </Dialog>
    </div>
  );
}

/**
 * Under a verified sending domain: that it is warming up, at what pace, and where its plan and the
 * pace choice are. Says nothing once warm-up is complete or was skipped.
 */
function DomainWarmup({
  domain,
  channelId,
  admin,
}: {
  domain: SendingDomain;
  channelId: string;
  admin: boolean;
}) {
  const ramps = useQuery(rampsQuery(channelId));
  const ramp = ramps.data?.find((r) => r.sendingDomainId === domain.id);
  if (ramps.isPending || ramp?.status === 'complete') return null;
  const link = (
    <a href={`#${WARMUP_ANCHOR}`} className="font-semibold underline underline-offset-2">
      {admin ? 'See the plan and choose a pace' : 'See the plan'}
    </a>
  );
  return (
    <p className="mt-3 rounded-control bg-surface-alt px-3 py-2.5 text-[13px] leading-[1.5]">
      {!ramp ? (
        <>
          <span className="font-semibold">Next: warm-up.</span> A new sending domain starts with a
          small daily limit that grows after each good day.{' '}
        </>
      ) : ramp.status === 'paused' ? (
        <>
          <span className="font-semibold text-danger-ink">Sending from this domain is paused.</span>{' '}
          Nothing goes out from it until someone resumes sending.{' '}
        </>
      ) : (
        <>
          <span className="font-semibold">This domain is warming up.</span> It can send up to{' '}
          {numberFormat.format(todaysLimit(ramp).cap)} emails today, and the limit grows by{' '}
          {growthPercent(ramp.growth)} after each good day ({PACE_NAMES[ramp.pace]} pace). A post to
          more people than the limit goes out over several days.{' '}
        </>
      )}
      {link}
    </p>
  );
}

const PURPOSE: Record<DnsRecord['purpose'], string> = {
  dkim: 'DKIM',
  mail_from_mx: 'Bounces',
  mail_from_spf: 'SPF',
  dmarc: 'DMARC',
  link: 'Link host',
};

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="grid size-7 shrink-0 place-items-center rounded-[8px] text-sub hover:bg-surface-alt hover:text-ink"
    >
      {copied ? <Icon.Check size={14} /> : <Icon.Copy size={14} />}
    </button>
  );
}

const RECORD_STATE: Record<RecordState, { label: string; tone: 'success' | 'danger' | 'neutral' }> =
  {
    ok: { label: 'Found', tone: 'success' },
    missing: { label: 'Missing', tone: 'danger' },
    different: { label: 'Wrong value', tone: 'danger' },
    conflict: { label: 'Conflict', tone: 'danger' },
    unknown: { label: 'Couldn’t check', tone: 'neutral' },
  };

export function RecordStatePill({ state }: { state: RecordState }) {
  return <Pill tone={RECORD_STATE[state].tone}>{RECORD_STATE[state].label}</Pill>;
}

/** With `checks`, from a check just made, each record also says what DNS has for it. */
function DnsTable({
  records,
  checks,
}: {
  records: DnsRecord[];
  checks?: CheckedSendingDomain['recordChecks'] | undefined;
}) {
  const checkFor = (record: DnsRecord) =>
    checks?.find((check) => check.name === record.name && check.type === record.type);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[620px] text-left text-[12.5px]">
        <thead>
          <tr className="table-head">
            <th scope="col" className="py-1.5 pr-3 font-semibold">
              For
            </th>
            <th scope="col" className="px-2 py-1.5 font-semibold">
              Type
            </th>
            <th scope="col" className="px-2 py-1.5 font-semibold">
              Name
            </th>
            <th scope="col" className="py-1.5 pl-2 font-semibold">
              Value
            </th>
            {checks && (
              <th scope="col" className="py-1.5 pl-2 font-semibold">
                In DNS now
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr
              key={`${record.type}-${record.name}-${record.value}`}
              className="border-t border-line align-top"
            >
              <td className="py-2 pr-3 whitespace-nowrap">{PURPOSE[record.purpose]}</td>
              <td className="px-2 py-2 font-mono">{record.type}</td>
              <td className="px-2 py-2">
                <span className="flex items-start gap-1 font-mono break-all">
                  {record.name}
                  <CopyButton value={record.name} label={`${PURPOSE[record.purpose]} name`} />
                </span>
              </td>
              <td className="py-2 pl-2">
                <span className="flex items-start gap-1 font-mono break-all">
                  {record.priority !== undefined ? `${record.priority} ` : ''}
                  {record.value}
                  <CopyButton value={record.value} label={`${PURPOSE[record.purpose]} value`} />
                </span>
              </td>
              {checks && (
                <td className="py-2 pl-2 whitespace-nowrap">
                  {checkFor(record) ? (
                    <RecordStatePill state={checkFor(record)?.state ?? 'unknown'} />
                  ) : (
                    '-'
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
