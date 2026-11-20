// Settings → Sending → Blocked addresses: everyone who won't be emailed and why. Bounces can be
// removed by an admin, which gives the subscribers back the status they had; complaints and erased
// addresses stay, because mailing them again would harm your sender reputation or break a promise.
import { BOUNCE_CAUSE_TEXT, bounceRuleReason, type Channel, type Suppression } from '@swarm/domain';
import { Button, Dialog, ErrorNotice, LoadingRows, Pill, TextField } from '@swarm/ui/components';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError } from '../api/client';
import { Section, formatDateTime } from '../pages/common';
import { InlineAdd } from '../shell/InlineAdd';
import { ServerSaid } from './Bounces';

const key = (channelId: string, email: string) => ['suppressions', channelId, email] as const;

function reasonLabel(reason: Suppression['reason']): string {
  const labels: Partial<Record<Suppression['reason'], string>> = {
    hard_bounce: 'Hard bounce',
    soft_bounce: 'Repeated soft bounces',
    complaint: 'Marked as spam',
    manual: 'Added by a teammate',
  };
  return labels[reason] ?? reason;
}

/** "The mailbox is full. Stopped after 3 emails in a row bounced softly" for a bounce row. */
function suppressionSummary(row: Suppression): string {
  if (!row.bounce) return reasonLabel(row.reason);
  const cause = row.bounce.cause ? `${BOUNCE_CAUSE_TEXT[row.bounce.cause]}. ` : '';
  return `${cause}Stopped after ${bounceRuleReason(row.bounce.rule, row.bounce.counted, row.bounce.days)}`;
}

const isBounce = (row: Suppression) => row.reason === 'hard_bounce' || row.reason === 'soft_bounce';

export function SuppressionsSection({ channel, admin }: { channel: Channel; admin: boolean }) {
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [adding, setAdding] = useState('');
  const base = `/api/v1/channels/${channel.id}/suppressions`;
  const list = useQuery(
    queryOptions({
      queryKey: key(channel.id, applied),
      queryFn: ({ signal }) =>
        api.get<Suppression[]>(
          applied ? `${base}?email=${encodeURIComponent(applied)}` : base,
          signal,
        ),
    }),
  );
  const refresh = () => client.invalidateQueries({ queryKey: ['suppressions', channel.id] });
  const add = useMutation({
    mutationFn: (email: string) => api.post(base, { email, scope: 'channel' }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`${base}/${id}`),
    onSuccess: async () => {
      setConfirming(null);
      await Promise.all([refresh(), client.invalidateQueries({ queryKey: ['members'] })]);
    },
  });
  const [confirming, setConfirming] = useState<Suppression | null>(null);
  const addError = add.error instanceof ApiError ? add.error : null;

  return (
    <Section
      title="Blocked addresses"
      description="These addresses won’t be emailed. Addresses are added for you when they complain, or when they bounce by your bounce rules above. Removing a manual block doesn’t subscribe anyone again; removing a bounce gives its subscribers back the status they had."
    >
      <div className="grid gap-4">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            setApplied(search.trim().toLowerCase());
          }}
        >
          <div className="min-w-[200px] flex-1">
            <TextField
              label="Find an address"
              type="email"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Button type="submit" variant="ghost">
            Find
          </Button>
          {applied && (
            <Button
              variant="ghost"
              onClick={() => {
                setSearch('');
                setApplied('');
              }}
            >
              Show all
            </Button>
          )}
        </form>
        {list.isPending && <LoadingRows label="Loading blocked addresses" />}
        {list.error && <ErrorNotice message={list.error.message} />}
        {list.data?.length === 0 && (
          <p className="text-[13px] text-sub">
            {applied ? 'That address isn’t blocked.' : 'No addresses are blocked.'}
          </p>
        )}
        {!!list.data?.length && (
          <ul className="divide-y divide-line border-y border-line">
            {list.data.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-[13.5px]"
              >
                <div className="grid min-w-0 gap-1">
                  <p className="font-semibold break-all">{row.email ?? 'Erased address'}</p>
                  <p className="text-[12.5px] text-sub">
                    {suppressionSummary(row)} on {formatDateTime(row.createdAt)}
                  </p>
                  {isBounce(row) && row.detail && <ServerSaid detail={row.detail} />}
                </div>
                <div className="flex items-center gap-2">
                  {row.scope === 'workspace' && <Pill tone="scheduled">All publications</Pill>}
                  {admin && row.removable && (
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={remove.isPending && remove.variables === row.id}
                      onClick={() => (isBounce(row) ? setConfirming(row) : remove.mutate(row.id))}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {remove.error && (
          <ErrorNotice
            message={remove.error instanceof ApiError ? remove.error.message : 'That didn’t work.'}
          />
        )}
        <Dialog
          open={confirming !== null}
          onClose={() => setConfirming(null)}
          title={`Mail ${confirming?.email ?? 'this address'} again?`}
          description="Do this only once you know the address works, for example after the reader emptied their mailbox or fixed a typo with you. Their subscriptions get back the status they had before the bounce, and the bounce counts start again from zero. If it bounces again, your bounce rules apply as usual."
          actions={
            <>
              <Button variant="ghost" onClick={() => setConfirming(null)}>
                Keep blocked
              </Button>
              <Button
                loading={remove.isPending}
                onClick={() => confirming && remove.mutate(confirming.id)}
              >
                Mail again
              </Button>
            </>
          }
        />
        {admin && (
          <InlineAdd
            label="Block an address"
            submitLabel="Block"
            pending={add.isPending}
            onCancel={() => {
              setAdding('');
              add.reset();
            }}
            onSubmit={(done) => {
              const email = adding.trim();
              if (!email) return;
              add.mutate(email, {
                onSuccess: () => {
                  setAdding('');
                  done(`Blocked ${email.toLowerCase()}.`);
                },
              });
            }}
          >
            <TextField
              label="Address to block"
              type="email"
              required
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
              error={addError?.field('email') ?? (add.error ? add.error.message : undefined)}
            />
          </InlineAdd>
        )}
      </div>
    </Section>
  );
}

const SUNSET_CHOICES = [
  { value: 'off', label: 'Keep everyone (off)' },
  { value: '180', label: 'After 6 months with no opens or clicks' },
  { value: '365', label: 'After 1 year with no opens or clicks' },
  { value: '730', label: 'After 2 years with no opens or clicks' },
];

/**
 * Settings → Sending → Inactive readers: optional, off until the owner picks a time. The choice
 * saves as it changes; `note` says so next to it (SavedNote).
 */
export function InactiveReadersSection({
  channel,
  value,
  admin,
  onChange,
  note,
  reengage,
  historyMonths,
}: {
  channel: Channel;
  value: number | null;
  admin: boolean;
  onChange: (days: number | null) => void;
  note?: ReactNode;
  /** A way to ask inactive readers first: the re-engagement automation. */
  reengage?: ReactNode;
  /** Months of engagement history the workspace keeps (Settings → Privacy), when known. */
  historyMonths?: number | null;
}) {
  const labelId = useId();
  // retention.ts MONTH_MS: an average month. A longer period can't be seen in full.
  const waits =
    value !== null && !!historyMonths && value * 86_400_000 > historyMonths * 2_629_746_000;
  return (
    <Section
      title="Inactive readers"
      description={`Mailing people who never read hurts delivery for everyone else. Readers of ${channel.name} who have been sent at least 5 emails can be unsubscribed automatically. Each is emailed 14 days before, can stay with one click, and can join again whenever they like. Readers whose mail app hides opens are never removed, and the cleanup only reads engagement history the workspace still keeps, so a period longer than that history waits. Needs engagement scores.`}
    >
      <div className="grid gap-4">
        {/* The group is named by the line above it, so the save note can sit beside the name. */}
        <fieldset
          aria-labelledby={labelId}
          className="grid gap-0.5 text-[13.5px]"
          disabled={!admin}
        >
          <div className="mb-1 flex flex-wrap items-center gap-x-3">
            <p id={labelId} className="text-[13px] font-semibold">
              When to unsubscribe inactive readers
            </p>
            {note}
          </div>
          {SUNSET_CHOICES.map((choice) => (
            <label
              key={choice.value}
              className="-mx-2 flex min-h-9 items-center gap-2.5 rounded-control px-2 hover:bg-surface-alt has-[:disabled]:hover:bg-transparent"
            >
              <input
                type="radio"
                name="sunset"
                checked={(value === null ? 'off' : String(value)) === choice.value}
                onChange={() => onChange(choice.value === 'off' ? null : Number(choice.value))}
                className="size-4 accent-purple"
              />
              {choice.label}
            </label>
          ))}
        </fieldset>
        {waits && (
          <p className="rounded-control bg-surface-alt px-3 py-2.5 text-[13px] leading-[1.5]">
            <span className="font-semibold">Nobody is unsubscribed yet.</span> The workspace keeps
            engagement history for {historyMonths} months (Settings → Privacy), which is shorter
            than this period. Older emails no longer say who opened them, so Swarm can’t tell
            whether someone read during the whole period, and the cleanup waits. Pick a shorter
            period, or keep engagement history for longer.
          </p>
        )}
        {reengage && <div className="border-t border-line pt-4">{reengage}</div>}
      </div>
    </Section>
  );
}
