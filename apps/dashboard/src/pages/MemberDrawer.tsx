// The member drawer: profile, status (only the changes a teammate may make), tags, profile fields,
// attribution and the activity timeline. Built on the native modal <dialog>, so focus stays inside,
// Escape closes it and focus returns to the row that opened it.
import {
  BOUNCE_CAUSE_TEXT,
  BOUNCE_KIND_LABEL,
  bounceRuleReason,
  type Channel,
  type MemberActivity,
  type MemberDetail,
  type MemberEngagement,
  type MemberField,
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
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { memberBouncesQuery } from '../api/bounces';
import { useSendConfirmation } from '../api/capture';
import { ApiError } from '../api/client';
import { useChannelFlag } from '../api/queries';
import {
  memberActivityQuery,
  memberFieldsQuery,
  memberQuery,
  tagsQuery,
  useDeleteMember,
  useUpdateMember,
} from '../api/members';
import { MemberFlowsList } from '../flows/MemberFlows';
import * as Icon from '../icons';
import { formatDateTime, numberFormat } from './common';
import { MemberEmailCheckLine } from './EmailChecks';
import { FieldInput } from './MemberFieldInput';
import { MemberChampionPanel } from '../growth/MemberChampion';
import { MembershipPanel } from './MemberMembership';
import { MemberRostersPanel } from '../rosters/MemberRosters';
import { ServerSaid } from '../send/Bounces';
import {
  FIELDS_UNAVAILABLE,
  STATUS_LABEL,
  STATUS_LOCKED,
  STATUS_TONE,
  changedFields,
  engagementDetail,
  engagementText,
  pauseBounds,
  pauseUntilIso,
  statusActions,
  toDraft,
  type FieldDraft,
} from './members-helpers';

const RANK = { viewer: 0, author: 1, editor: 2, admin: 3, owner: 4 } as const;

const dayFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

export function MemberDrawer({
  channel,
  memberId,
  onClose,
  onDeleted,
}: {
  channel: Channel;
  memberId: string | null;
  onClose: () => void;
  onDeleted: (email: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const open = memberId !== null;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className="fixed inset-y-0 right-0 left-auto m-0 h-full max-h-none w-[min(560px,100vw)] max-w-none overflow-y-auto border-0 border-l border-line-app bg-surface p-0 text-ink shadow-card backdrop:bg-[rgba(15,15,18,0.32)]"
    >
      {memberId && (
        <MemberDetailView
          key={memberId}
          channel={channel}
          memberId={memberId}
          titleId={titleId}
          onClose={onClose}
          onDeleted={onDeleted}
        />
      )}
    </dialog>
  );
}

function MemberDetailView({
  channel,
  memberId,
  titleId,
  onClose,
  onDeleted,
}: {
  channel: Channel;
  memberId: string;
  titleId: string;
  onClose: () => void;
  onDeleted: (email: string) => void;
}) {
  const member = useQuery(memberQuery(memberId));
  const canEdit = RANK[channel.role] >= RANK.editor;
  const checksOn = useChannelFlag(channel.id, 'email_verification') === true;
  const data = member.data;
  const name = data ? [data.firstName, data.lastName].filter(Boolean).join(' ') : '';

  return (
    <div className="grid gap-5 p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            id={titleId}
            className="font-mono text-[15px] font-semibold break-all tracking-[-0.01em]"
          >
            {data?.email ?? 'Subscriber'}
          </h2>
          {name && <p className="mt-0.5 text-[14px] text-sub">{name}</p>}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid size-10 shrink-0 place-items-center rounded-full text-sub hover:bg-surface-alt hover:text-ink"
        >
          <Icon.Close size={18} />
        </button>
      </div>

      {member.isPending && <LoadingRows label="Loading subscriber" rows={4} />}
      {member.error && (
        <ErrorNotice title="Subscriber not available" message={member.error.message} />
      )}
      {data && (
        <>
          <StatusPanel channelId={channel.id} member={data} canEdit={canEdit} />
          <BouncesPanel memberId={data.id} />
          {checksOn && <MemberEmailCheckLine memberId={data.id} canEdit={canEdit} />}
          <MembershipPanel channel={channel} member={data} />
          <ProfilePanel channelId={channel.id} member={data} canEdit={canEdit} />
          <TagsPanel channelId={channel.id} member={data} canEdit={canEdit} />
          <MemberRostersPanel channelId={channel.id} memberId={data.id} canEdit={canEdit} />
          <FieldsPanel channel={channel} member={data} canEdit={canEdit} />
          {data.engagement && <EngagementPanel engagement={data.engagement} />}
          <SourcePanel member={data} />
          <MemberChampionPanel channelId={channel.id} memberId={data.id} />
          <Panel title="Automations">
            <MemberFlowsList memberId={data.id} memberStatus={data.status} />
          </Panel>
          <ActivityPanel memberId={data.id} />
          {canEdit && (
            <DeletePanel
              channelId={channel.id}
              member={data}
              onDeleted={() => {
                onDeleted(data.email);
                onClose();
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

function Panel({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="border-t border-line pt-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 id={id} className="text-[14px] font-semibold">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

// ---- Status ----------------------------------------------------------------------------------

function statusSummary(member: MemberDetail): string {
  // Their own choice in subscriber settings, apart from the status and any paid subscription.
  if (member.emailsOffAt && (member.status === 'active' || member.status === 'paused')) {
    return `Turned emails off on ${dayFormat.format(new Date(member.emailsOffAt))}: no posts or automation emails reach them. They stay subscribed, with website access and any paid subscription; receipts, sign-in links and billing notices still go. Only they can turn emails back on, in their subscriber settings.`;
  }
  switch (member.status) {
    case 'pending':
      return 'Waiting for them to confirm their address. Pending subscribers receive nothing, and a teammate can’t confirm for them.';
    case 'active':
      return 'Receives every post sent to this publication.';
    case 'paused':
      return member.pausedUntil
        ? `Paused until ${dayFormat.format(new Date(member.pausedUntil))}. Posts resume after that.`
        : 'Paused. Posts resume when they are resumed.';
    case 'unsubscribed':
      return `Unsubscribed${member.unsubscribedAt ? ` on ${dayFormat.format(new Date(member.unsubscribedAt))}` : ''}. ${STATUS_LOCKED.unsubscribed ?? ''}`;
    case 'bounced':
    case 'complained':
      return STATUS_LOCKED[member.status] ?? '';
  }
}

/** Pending Members confirm themselves; a teammate can only (re)send the email. */
function SendConfirmation({ memberId }: { memberId: string }) {
  const send = useSendConfirmation(memberId);
  return (
    <div className="mt-3 grid gap-2">
      <Button
        variant="ghost"
        size="sm"
        className="w-fit"
        loading={send.isPending}
        disabled={send.isSuccess}
        onClick={() => send.mutate()}
      >
        {send.isSuccess ? 'Confirmation sent' : 'Send confirmation email'}
      </Button>
      <p role="status" className="text-[12.5px] text-sub">
        {send.isSuccess
          ? 'They join once they press Confirm in the email. The link works for 7 days.'
          : null}
      </p>
      {send.error && <ErrorNotice message={send.error.message} />}
    </div>
  );
}

function StatusPanel({
  channelId,
  member,
  canEdit,
}: {
  channelId: string;
  member: MemberDetail;
  canEdit: boolean;
}) {
  const update = useUpdateMember(channelId, member.id);
  const bounds = pauseBounds();
  const [pauseDay, setPauseDay] = useState(
    member.pausedUntil ? member.pausedUntil.slice(0, 10) : bounds.initial,
  );
  const [confirming, setConfirming] = useState(false);
  const actions = canEdit ? statusActions(member.status) : [];
  const canPause = actions.some((a) => a.to === 'paused');
  const error = update.error instanceof ApiError ? update.error : null;

  const pause = (event: FormEvent) => {
    event.preventDefault();
    update.mutate({ status: 'paused', pausedUntil: pauseUntilIso(pauseDay) });
  };

  return (
    <Panel
      title="Status"
      action={<Pill tone={STATUS_TONE[member.status]}>{STATUS_LABEL[member.status]}</Pill>}
    >
      <p className="text-[13.5px] text-sub">{statusSummary(member)}</p>
      {member.unsubscribeReason && (
        <p className="mt-1 text-[13.5px] text-sub">Reason given: {member.unsubscribeReason}</p>
      )}
      {canEdit && member.status === 'pending' && <SendConfirmation memberId={member.id} />}
      {(canPause || (canEdit && member.status === 'paused')) && (
        <form onSubmit={pause} className="mt-3 flex flex-wrap items-end gap-2">
          <div className="w-44">
            <TextField
              label={member.status === 'paused' ? 'Paused until' : 'Pause until'}
              type="date"
              required
              min={bounds.min}
              max={bounds.max}
              value={pauseDay}
              onChange={(e) => setPauseDay(e.target.value)}
              error={error?.field('pausedUntil')}
            />
          </div>
          <Button type="submit" variant="ghost" size="sm" loading={update.isPending}>
            {member.status === 'paused' ? 'Change date' : 'Pause'}
          </Button>
        </form>
      )}
      {actions.some((a) => a.to !== 'paused') && (
        <div className="mt-3 flex flex-wrap gap-2">
          {actions
            .filter((a) => a.to === 'active')
            .map((a) => (
              <Button
                key={a.to}
                size="sm"
                loading={update.isPending}
                onClick={() => update.mutate({ status: 'active' })}
              >
                {a.label}
              </Button>
            ))}
          {actions.some((a) => a.to === 'unsubscribed') && (
            <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
              Unsubscribe
            </Button>
          )}
        </div>
      )}
      {error && !error.field('pausedUntil') && (
        <div className="mt-3">
          <ErrorNotice title="Status not changed" message={error.message} />
        </div>
      )}
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Unsubscribe this subscriber?"
        description={`${member.email} stops receiving posts. Only they can come back, by confirming from an email.`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep subscribed
            </Button>
            <Button
              variant="danger"
              loading={update.isPending}
              onClick={() =>
                update.mutate({ status: 'unsubscribed' }, { onSettled: () => setConfirming(false) })
              }
            >
              Unsubscribe
            </Button>
          </>
        }
      />
    </Panel>
  );
}

// ---- Bounces ---------------------------------------------------------------------------------

const BOUNCE_TONE = { hard: 'danger', soft: 'scheduled', blocked: 'neutral' } as const;

/**
 * Why emails to this address bounce, and what the bounce rules did about it. Shown only once the
 * address has bounced. The rules are the workspace's, so this covers every publication.
 */
function BouncesPanel({ memberId }: { memberId: string }) {
  const bounces = useQuery(memberBouncesQuery(memberId));
  const data = bounces.data;
  if (!data || (!data.events.length && !data.stopped && !data.held)) return null;
  const last = data.events[0];
  return (
    <Panel title="Bounces">
      <div className="grid gap-2 text-[13.5px]">
        {data.stopped ? (
          <p>
            <span className="font-semibold text-danger-ink">
              Not mailed since {dayFormat.format(new Date(data.stopped.createdAt))}.
            </span>{' '}
            {data.stopped.bounce
              ? `${data.stopped.bounce.cause ? `${BOUNCE_CAUSE_TEXT[data.stopped.bounce.cause]}. ` : ''}Stopped after ${bounceRuleReason(data.stopped.bounce.rule, data.stopped.bounce.counted, data.stopped.bounce.days)}.`
              : 'Stopped by a bounce.'}{' '}
            To mail them again once the address works, remove it from Blocked addresses in Sending.
          </p>
        ) : data.held ? (
          <p>
            <span className="font-semibold">Waiting for you.</span> They have a paid plan, so
            instead of stopping after{' '}
            {bounceRuleReason(data.held.rule, data.held.counted, data.held.days)}, Swarm keeps
            mailing them until an admin decides under Needs your attention in Sending.
          </p>
        ) : (
          <p className="text-sub">
            {data.softStreak
              ? `Still mailed. ${numberFormat.format(data.softStreak)} ${data.softStreak === 1 ? 'email' : 'emails'} in a row bounced softly; a delivered email starts the count again.`
              : data.events.every((e) => e.kind === 'blocked')
                ? 'Still mailed. These emails were refused because of the sender, not this address, so Swarm keeps mailing them.'
                : 'Still mailed: their bounces so far don’t meet your bounce rules.'}
          </p>
        )}
        {data.stopped?.detail && !last?.detail && <ServerSaid detail={data.stopped.detail} />}
        {!!data.events.length && (
          <ul className="grid gap-2">
            {data.events.map((event, i) => (
              <li
                key={`${event.at}-${i}`}
                className="grid gap-1 border-b border-line pb-2 last:border-b-0 last:pb-0"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone={BOUNCE_TONE[event.kind]}>{BOUNCE_KIND_LABEL[event.kind]}</Pill>
                  <span className="text-[12.5px] text-sub">{formatDateTime(event.at)}</span>
                </div>
                <p>{BOUNCE_CAUSE_TEXT[event.cause]}</p>
                {event.detail && <ServerSaid detail={event.detail} code={event.code} />}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

// ---- Profile ---------------------------------------------------------------------------------

const DIGEST_OPTIONS = [
  { value: 'every', label: 'Every post' },
  { value: 'weekly', label: 'Weekly digest' },
  { value: 'monthly', label: 'Monthly digest' },
];

function ProfilePanel({
  channelId,
  member,
  canEdit,
}: {
  channelId: string;
  member: MemberDetail;
  canEdit: boolean;
}) {
  const update = useUpdateMember(channelId, member.id);
  const [firstName, setFirstName] = useState(member.firstName ?? '');
  const [lastName, setLastName] = useState(member.lastName ?? '');
  const [digest, setDigest] = useState(member.digest);
  // The choice shows only with the digest flag on: nothing sends digests yet.
  const digestOn = useChannelFlag(channelId, 'digest') === true;
  const error = update.error instanceof ApiError ? update.error : null;
  const dirty =
    firstName.trim() !== (member.firstName ?? '') ||
    lastName.trim() !== (member.lastName ?? '') ||
    digest !== member.digest;

  const save = (event: FormEvent) => {
    event.preventDefault();
    update.mutate({
      firstName: firstName.trim() || null,
      lastName: lastName.trim() || null,
      ...(digestOn ? { digest } : {}),
    });
  };

  return (
    <Panel title="Profile">
      <form onSubmit={save} className="grid gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="First name"
            maxLength={80}
            disabled={!canEdit}
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            error={error?.field('firstName')}
          />
          <TextField
            label="Last name"
            maxLength={80}
            disabled={!canEdit}
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            error={error?.field('lastName')}
          />
        </div>
        {digestOn && (
          <SelectField
            label="Delivery"
            hint="How often this subscriber gets mail from this publication."
            disabled={!canEdit}
            value={digest}
            onChange={(e) => setDigest(e.target.value as MemberDetail['digest'])}
            options={DIGEST_OPTIONS}
          />
        )}
        {error && !error.details.length && <ErrorNotice message={error.message} />}
        {canEdit && (
          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" disabled={!dirty} loading={update.isPending}>
              Save profile
            </Button>
            {update.isSuccess && !dirty && (
              <span role="status" className="text-[13px] text-success">
                Saved
              </span>
            )}
          </div>
        )}
      </form>
    </Panel>
  );
}

// ---- Tags ------------------------------------------------------------------------------------

function TagsPanel({
  channelId,
  member,
  canEdit,
}: {
  channelId: string;
  member: MemberDetail;
  canEdit: boolean;
}) {
  const update = useUpdateMember(channelId, member.id);
  const tags = useQuery({ ...tagsQuery(channelId), enabled: canEdit });
  const [draft, setDraft] = useState('');
  const listId = useId();
  const error = update.error instanceof ApiError ? update.error : null;

  const add = (event: FormEvent) => {
    event.preventDefault();
    const name = draft.trim();
    if (!name) return;
    if (member.tags.some((t) => t.toLowerCase() === name.toLowerCase())) {
      setDraft('');
      return;
    }
    update.mutate({ tags: [...member.tags, name] }, { onSuccess: () => setDraft('') });
  };

  return (
    <Panel title="Tags">
      {member.tags.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Tags">
          {member.tags.map((tag) => (
            <li
              key={tag}
              className="inline-flex items-center gap-1 rounded-pill bg-lavender py-0.5 pr-1 pl-2.5 text-[12.5px] font-semibold text-purple-deep"
            >
              {tag}
              {canEdit && (
                <button
                  type="button"
                  aria-label={`Remove tag ${tag}`}
                  disabled={update.isPending}
                  onClick={() => update.mutate({ tags: member.tags.filter((t) => t !== tag) })}
                  className="grid size-6 place-items-center rounded-full hover:bg-surface"
                >
                  <Icon.Close size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13.5px] text-sub">No tags.</p>
      )}
      {canEdit && (
        <form onSubmit={add} className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <TextField
              label="Add a tag"
              maxLength={60}
              list={listId}
              autoComplete="off"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              error={error?.details.find((d) => d.path.startsWith('tags'))?.message}
            />
            <datalist id={listId}>
              {tags.data
                ?.filter((t) => !member.tags.includes(t.name))
                .map((t) => (
                  <option key={t.id} value={t.name} />
                ))}
            </datalist>
          </div>
          <Button type="submit" variant="ghost" size="sm" loading={update.isPending}>
            Add
          </Button>
        </form>
      )}
      {error && !error.details.length && (
        <div className="mt-3">
          <ErrorNotice message={error.message} />
        </div>
      )}
    </Panel>
  );
}

// ---- Profile fields --------------------------------------------------------------------------

export function FieldsPanel({
  channel,
  member,
  canEdit,
}: {
  channel: Channel;
  member: MemberDetail;
  canEdit: boolean;
}) {
  const fields = useQuery(memberFieldsQuery(channel.id));
  const update = useUpdateMember(channel.id, member.id);
  const [edits, setEdits] = useState<Record<string, FieldDraft>>({});
  const error = update.error instanceof ApiError ? update.error : null;
  // Encrypted fields that couldn't be opened just now are left out, not shown empty.
  const unavailable = member.encryptedUnavailable === true;
  const list = (fields.data ?? []).filter((field) => !(unavailable && field.encrypted));
  const changes = changedFields(list, member.fields, edits);
  const dirty = Object.keys(changes).length > 0;

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!dirty) return;
    update.mutate({ fields: changes }, { onSuccess: () => setEdits({}) });
  };

  const value = (field: MemberField) =>
    edits[field.key] ?? toDraft(field.type, member.fields[field.key]);

  return (
    <Panel title="Profile fields">
      {fields.isPending && <LoadingRows label="Loading profile fields" rows={2} />}
      {fields.error && <ErrorNotice message={fields.error.message} />}
      {unavailable && (
        <p role="status" className="mb-3 text-[13.5px] text-sub">
          {FIELDS_UNAVAILABLE}
        </p>
      )}
      {fields.data && !fields.data.length && (
        <p className="text-[13.5px] text-sub">
          This publication has no profile fields yet.{' '}
          {canEdit && (
            <Link
              to="/channels/$channelId/members-settings"
              params={{ channelId: channel.id }}
              className="font-semibold text-purple-deep underline"
            >
              Add a profile field
            </Link>
          )}
        </p>
      )}
      {list.length > 0 && (
        <form onSubmit={save} className="grid gap-3">
          {list.map((field) => (
            <FieldInput
              key={field.id}
              field={field}
              value={value(field)}
              disabled={!canEdit}
              onChange={(next) => setEdits((prev) => ({ ...prev, [field.key]: next }))}
              error={error?.field(`fields.${field.key}`)}
            />
          ))}
          {error && !error.details.length && <ErrorNotice message={error.message} />}
          {canEdit && (
            <div className="flex items-center gap-3">
              <Button type="submit" size="sm" disabled={!dirty} loading={update.isPending}>
                Save fields
              </Button>
              {dirty && (
                <Button variant="quiet" size="sm" onClick={() => setEdits({})}>
                  Discard changes
                </Button>
              )}
              {update.isSuccess && !dirty && (
                <span role="status" className="text-[13px] text-success">
                  Saved
                </span>
              )}
            </div>
          )}
        </form>
      )}
    </Panel>
  );
}

// ---- Source and attribution ------------------------------------------------------------------

const SOURCE_LABEL: Record<string, string> = {
  utm_source: 'utm_source',
  utm_medium: 'utm_medium',
  utm_campaign: 'utm_campaign',
  utm_term: 'utm_term',
  utm_content: 'utm_content',
  referrer: 'Referrer',
  first_url: 'First page',
  current_url: 'Sign-up page',
  ref: 'Referral code',
};

function EngagementPanel({ engagement }: { engagement: MemberEngagement }) {
  return (
    <Panel title="Engagement">
      <p className="text-[13.5px] font-semibold">{engagementText(engagement)}</p>
      <p className="mt-1 text-[13px] text-sub">{engagementDetail(engagement)}</p>
      {engagement.lastEngagedAt && (
        <p className="mt-1 text-[13px] text-sub">
          Last read or clicked {formatDateTime(engagement.lastEngagedAt)}
        </p>
      )}
    </Panel>
  );
}

/** One line on a consent record: where it came from, the box, and whether they had to confirm. */
function consentSummary(consent: MemberDetail['consents'][number]): string {
  const version = consent.formVersion ? ` version ${consent.formVersion}` : '';
  const where =
    consent.source === 'form'
      ? `Signup form${version}`
      : consent.source === 'operator'
        ? 'Added by a teammate'
        : consent.source === 'import'
          ? 'Imported'
          : consent.source === 'checkout'
            ? 'Checkout'
            : 'Added through the API';
  const box =
    consent.source === 'checkout'
      ? 'address given when paying'
      : consent.source === 'import'
        ? consent.attestedBy?.startsWith('op_') || !consent.attestedBy
          ? 'a teammate stated that everyone on the list agreed'
          : 'the API caller stated that everyone on the list agreed'
        : consent.source !== 'form'
          ? consent.ticked
            ? 'stated that they asked'
            : 'not stated that they asked'
          : consent.ticked === null
            ? 'no consent box'
            : consent.ticked
              ? 'box ticked'
              : 'box not ticked';
  return `${where}, ${box}, ${consent.mustConfirm ? 'had to confirm by email' : 'no email confirmation'}`;
}

function SourcePanel({ member }: { member: MemberDetail }) {
  const how = member.formId
    ? 'Through a signup form'
    : member.source.import_id
      ? 'From an import'
      : 'Added by a teammate or through the API';
  const rows: [string, ReactNode][] = [
    ['Joined', formatDateTime(member.createdAt)],
    ['How', how],
    ['Confirmed', formatDateTime(member.confirmedAt)],
    ['Referred by', member.referredBy ? <code key="r">{member.referredBy}</code> : '—'],
    ['Referrals', numberFormat.format(member.referralCount)],
    ...Object.entries(SOURCE_LABEL)
      .filter(([key]) => member.source[key as keyof MemberDetail['source']])
      .map(([key, label]): [string, ReactNode] => [
        label,
        <span key={key} className="break-all">
          {member.source[key as keyof MemberDetail['source']]}
        </span>,
      ]),
  ];
  return (
    <Panel title="Source">
      <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13.5px]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-sub">{label}</dt>
            <dd className="tabular min-w-0">{value}</dd>
          </div>
        ))}
      </dl>
      {member.consents.length > 0 && (
        <div className="mt-4 border-t border-line-app pt-3">
          <h4 className="text-[13px] font-semibold">What they agreed to</h4>
          <ul className="mt-2 grid gap-3 text-[13px]">
            {member.consents.map((consent) => (
              <li key={`${consent.at}-${consent.source}`}>
                <p className="tabular text-sub">
                  {formatDateTime(consent.at)} · {consentSummary(consent)}
                </p>
                {(consent.verifiedHost || consent.claimedOrigin) && (
                  <p className="mt-0.5 break-all text-sub">
                    {consent.verifiedHost && <>Bot check passed on {consent.verifiedHost}. </>}
                    {consent.claimedOrigin && (
                      <>The form said it was on {consent.claimedOrigin} (not verified).</>
                    )}
                  </p>
                )}
                {consent.wording && (
                  <blockquote className="mt-1 border-l-2 border-line-app pl-2.5">
                    {consent.wording}
                  </blockquote>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

// ---- Activity --------------------------------------------------------------------------------

function activityText(item: MemberActivity): string {
  const subject = item.subject ? `“${item.subject}”` : 'a post';
  switch (item.type) {
    case 'joined':
      return item.formId
        ? item.formName
          ? `Joined through the signup form “${item.formName}”`
          : 'Joined through a signup form'
        : item.importId
          ? 'Joined from an import'
          : 'Joined';
    case 'form':
      return item.formName
        ? `Sent the signup form “${item.formName}” again`
        : 'Sent a signup form again';
    case 'delivery':
      return `Sent ${subject}`;
    case 'open':
      return `Opened ${subject}`;
    case 'click':
      return `Clicked a link in ${subject}`;
    case 'bounce':
      return `${subject} bounced`;
    case 'complaint':
      return `Marked ${subject} as spam`;
    case 'unsubscribe':
      return `Unsubscribed from ${subject}`;
  }
}

function ActivityPanel({ memberId }: { memberId: string }) {
  const activity = useQuery(memberActivityQuery(memberId));
  return (
    <Panel title="Activity">
      {activity.isPending && <LoadingRows label="Loading activity" rows={3} />}
      {activity.error && <ErrorNotice message={activity.error.message} />}
      {activity.data?.length === 0 && <p className="text-[13.5px] text-sub">No activity yet.</p>}
      {!!activity.data?.length && (
        <ol className="grid gap-2.5">
          {activity.data.map((item, index) => (
            <li
              key={`${item.type}-${item.at}-${index}`}
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 text-[13.5px]"
            >
              <span className="min-w-0">
                {item.broadcastId ? (
                  <Link
                    to="/broadcasts/$broadcastId"
                    params={{ broadcastId: item.broadcastId }}
                    className="hover:text-purple-deep hover:underline"
                  >
                    {activityText(item)}
                  </Link>
                ) : (
                  activityText(item)
                )}
                {item.url && (
                  <span className="block truncate font-mono text-[12px] text-sub">{item.url}</span>
                )}
              </span>
              <time dateTime={item.at} className="tabular text-[12.5px] whitespace-nowrap text-sub">
                {formatDateTime(item.at)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

// ---- Delete ----------------------------------------------------------------------------------

function DeletePanel({
  channelId,
  member,
  onDeleted,
}: {
  channelId: string;
  member: MemberDetail;
  onDeleted: () => void;
}) {
  const remove = useDeleteMember(channelId);
  const [confirming, setConfirming] = useState(false);
  return (
    <Panel title="Delete">
      <p className="text-[13.5px] text-sub">
        Removes the subscriber from this publication and erases their address from delivery history.
        If they asked for their data to be deleted, log it under Settings → Privacy Center instead:
        that also clears their tracking history and orders in every publication. You can still do
        that after deleting them, because a request needs only the address.
      </p>
      <div className="mt-3">
        <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
          Delete subscriber
        </Button>
      </div>
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Delete this subscriber?"
        description={
          <>
            {member.email} is removed and their address is erased from delivery history. This can’t
            be undone. Their address stays where it is held without a subscriber: blocked addresses,
            orders, checkouts, gift subscriptions, trial claims, email checks and bounce history. To
            remove those too, file a deletion for the address in the Privacy Center. To stop mail
            but keep the record, unsubscribe them instead.
          </>
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(member.id, {
                  onSuccess: () => {
                    setConfirming(false);
                    onDeleted();
                  },
                })
              }
            >
              Delete subscriber
            </Button>
          </>
        }
      >
        {remove.error && <ErrorNotice message={remove.error.message} />}
      </Dialog>
    </Panel>
  );
}
