// The member drawer's Membership panel: the level a Member holds now and where it comes from;
// for admins, complimentary access to grant or revoke; for editors, extra free reads on the meter.
import type { Channel, CompGrant, MemberDetail, SeatRole } from '@swarm/domain';
import { Button, Dialog, ErrorNotice, Pill, SelectField, TextField } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import {
  gateSettingsQuery,
  levelsQuery,
  memberCompQuery,
  useGrantComp,
  useMeterGrant,
  useRevokeComp,
} from '../api/money';
import { sourceLabel } from '../money/helpers';
import { dayLabel } from './Memberships';

const RANK: Record<SeatRole, number> = { viewer: 0, author: 1, editor: 2, admin: 3, owner: 4 };

export function MembershipPanel({ channel, member }: { channel: Channel; member: MemberDetail }) {
  const id = useId();
  const canAdmin = RANK[channel.role] >= RANK.admin;
  const canEdit = RANK[channel.role] >= RANK.editor;
  const membership = member.membership;
  const grants = useQuery(memberCompQuery(channel.id, member.id));
  const settings = useQuery(gateSettingsQuery(channel.id));
  const active = (grants.data ?? []).filter((g) => g.active);
  const meterOn = (settings.data?.meterLimit ?? 0) > 0;

  return (
    <section aria-labelledby={id} className="border-t border-line pt-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 id={id} className="text-[14px] font-semibold">
          Paid subscription
        </h3>
        <Pill tone={membership ? 'brand' : 'neutral'}>
          {membership ? (membership.levelName ?? 'Paid') : 'Free'}
        </Pill>
      </div>
      {membership ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13.5px]">
          <dt className="text-sub">Plan</dt>
          <dd>{membership.levelName ?? 'A plan that was removed'}</dd>
          <dt className="text-sub">Source</dt>
          <dd>{sourceLabel(membership.source)}</dd>
          <dt className="text-sub">Since</dt>
          <dd>{dayLabel(membership.startsAt)}</dd>
          <dt className="text-sub">Until</dt>
          <dd>{membership.expiresAt ? dayLabel(membership.expiresAt) : 'No end date'}</dd>
        </dl>
      ) : (
        <p className="text-[13.5px] text-sub">
          On the free plan: reads public and subscriber-only posts, not paid ones.
        </p>
      )}

      {active.length > 0 && (
        <ul className="mt-3 grid gap-2" aria-label="Complimentary access">
          {active.map((grant) => (
            <CompRow
              key={grant.id}
              channelId={channel.id}
              memberId={member.id}
              grant={grant}
              canAdmin={canAdmin}
            />
          ))}
        </ul>
      )}
      {grants.error && (
        <div className="mt-3">
          <ErrorNotice message={grants.error.message} />
        </div>
      )}
      {canAdmin && <GrantComp channelId={channel.id} memberId={member.id} />}
      {canEdit && meterOn && settings.data && (
        <MeterGrant
          channelId={channel.id}
          memberId={member.id}
          period={settings.data.meterPeriod}
        />
      )}
    </section>
  );
}

function CompRow({
  channelId,
  memberId,
  grant,
  canAdmin,
}: {
  channelId: string;
  memberId: string;
  grant: CompGrant;
  canAdmin: boolean;
}) {
  const revoke = useRevokeComp(channelId, memberId);
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-card-app bg-surface-alt px-3 py-2 text-[13px]">
      <span>
        <b>Complimentary {grant.levelName ?? 'access'}</b>
        <span className="block text-sub">
          {grant.expiresAt ? `Until ${dayLabel(grant.expiresAt)}` : 'No end date'}
          {grant.note ? ` · ${grant.note}` : ''}
        </span>
      </span>
      {canAdmin && (
        <Button variant="quiet" size="sm" onClick={() => setConfirming(true)}>
          Revoke
        </Button>
      )}
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Revoke complimentary access?"
        description="Access from this grant ends now. A paid subscription or gift subscription they hold is not affected."
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep access
            </Button>
            <Button
              variant="danger"
              loading={revoke.isPending}
              onClick={() => revoke.mutate(grant.id, { onSuccess: () => setConfirming(false) })}
            >
              Revoke access
            </Button>
          </>
        }
      >
        {revoke.error && <ErrorNotice message={revoke.error.message} />}
      </Dialog>
    </li>
  );
}

function GrantComp({ channelId, memberId }: { channelId: string; memberId: string }) {
  const levels = useQuery(levelsQuery(channelId));
  const grant = useGrantComp(channelId, memberId);
  const [open, setOpen] = useState(false);
  const [levelId, setLevelId] = useState('');
  const [until, setUntil] = useState('');
  const [note, setNote] = useState('');
  const [done, setDone] = useState(false);
  const error = grant.error instanceof ApiError ? grant.error : null;
  const active = levels.data?.items.filter((l) => l.status === 'active') ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const chosen = levelId || active[0]?.id || '';

  if (levels.data && active.length === 0) {
    return (
      <p className="mt-3 text-[12.5px] text-sub">
        Create a paid plan to give complimentary access.
      </p>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!chosen) return;
    setDone(false);
    grant.mutate(
      {
        levelId: chosen,
        expiresAt: until ? new Date(`${until}T23:59:59Z`).toISOString() : null,
        note: note.trim() || null,
      },
      {
        onSuccess: () => {
          setDone(true);
          setOpen(false);
          setUntil('');
          setNote('');
        },
      },
    );
  };

  return (
    <div className="mt-3 grid gap-2">
      {!open ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
            Give complimentary access
          </Button>
          <p role="status" className="text-[12.5px] text-success">
            {done ? 'Complimentary access given.' : ''}
          </p>
        </div>
      ) : (
        <form
          onSubmit={submit}
          noValidate
          className="grid gap-3 rounded-card-app border border-line-app p-4"
        >
          <SelectField
            label="Paid plan"
            value={chosen}
            onChange={(e) => setLevelId(e.target.value)}
            options={active.map((l) => ({ value: l.id, label: l.name }))}
            error={error?.field('levelId')}
          />
          <TextField
            label="Ends on (optional)"
            type="date"
            min={today}
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            error={error?.field('expiresAt')}
            hint="Leave empty for no end date."
          />
          <TextField
            label="Note (optional)"
            maxLength={280}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            hint="For your team, like why access was given."
          />
          {error && !error.details.length && <ErrorNotice message={error.message} />}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" loading={grant.isPending}>
              Give access
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function MeterGrant({
  channelId,
  memberId,
  period,
}: {
  channelId: string;
  memberId: string;
  period: 'week' | 'month';
}) {
  const grant = useMeterGrant(channelId, memberId);
  const [extra, setExtra] = useState('1');
  const value = Number(extra);
  const problem =
    !/^\d{1,3}$/.test(extra) || value < 1 || value > 100 ? 'Use 1 to 100.' : undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (problem) return;
    grant.mutate(value);
  };

  return (
    <form onSubmit={submit} noValidate className="mt-3 flex flex-wrap items-end gap-2">
      <div className="w-40">
        <TextField
          label={`Extra free reads this ${period}`}
          inputMode="numeric"
          value={extra}
          onChange={(e) => {
            grant.reset();
            setExtra(e.target.value.trim());
          }}
          error={problem}
        />
      </div>
      <Button type="submit" variant="ghost" size="sm" loading={grant.isPending}>
        Give extra reads
      </Button>
      <p role="status" className="w-full text-[12.5px] text-success">
        {grant.data
          ? `${grant.data.extra} extra read${grant.data.extra === 1 ? '' : 's'} given for ${grant.data.period}.`
          : ''}
      </p>
      {grant.error && (
        <div className="w-full">
          <ErrorNotice message={grant.error.message} />
        </div>
      )}
    </form>
  );
}
