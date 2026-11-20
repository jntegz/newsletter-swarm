// Settings → Sending → Bounces: how the workspace reacts when an email can't be delivered, with a
// preview of what new rules would do, and the subscribers on a paid plan waiting for a decision.
// The rules are the workspace's: only its owners and admins change them (docs/deliverability.md
// "Bounces").
import {
  BOUNCE_CAUSE_TEXT,
  BOUNCE_KIND_LABEL,
  BOUNCE_LIMITS,
  DEFAULT_BOUNCE_POLICY,
  bounceRuleReason,
  type BounceHold,
  type BouncePolicy,
  type BouncePolicySaved,
  type BouncePolicySettings,
  type Channel,
} from '@swarm/domain';
import { Button, Checkbox, Dialog, ErrorNotice, LoadingRows, Pill } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  bounceHoldsQuery,
  bouncePolicyQuery,
  bouncePreviewQuery,
  useDecideBounceHold,
  useSaveBouncePolicy,
} from '../api/bounces';
import { Section, formatDateTime, numberFormat } from '../pages/common';
import { useSession } from '../session';

export const BOUNCES_ANCHOR = 'bounces';

const KIND_TONE = { hard: 'danger', soft: 'scheduled', blocked: 'neutral' } as const;

const policyOf = (value: BouncePolicy): BouncePolicy => ({
  hardBounces: value.hardBounces,
  softStreak: value.softStreak,
  softWindow: value.softWindow ? { ...value.softWindow } : null,
  askForPaid: value.askForPaid,
});
const same = (a: BouncePolicy, b: BouncePolicy) =>
  JSON.stringify(policyOf(a)) === JSON.stringify(policyOf(b));

const plural = (n: number, one: string, many: string) =>
  `${numberFormat.format(n)} ${n === 1 ? one : many}`;

/** The value after a short pause, so the preview isn't asked for on every click. */
function useSettled<T>(value: T, ms = 350): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

const STREAKS = Array.from(
  { length: BOUNCE_LIMITS.softStreakMax - BOUNCE_LIMITS.softStreakMin + 1 },
  (_, i) => i + BOUNCE_LIMITS.softStreakMin,
);
const WINDOW_COUNTS = Array.from(
  { length: BOUNCE_LIMITS.softWindowCountMax - BOUNCE_LIMITS.softWindowCountMin + 1 },
  (_, i) => i + BOUNCE_LIMITS.softWindowCountMin,
);

function Inline({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  options: readonly { value: number; label: string }[];
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-8 rounded-control border border-line-app bg-surface px-2 text-[13.5px] font-semibold disabled:cursor-not-allowed disabled:text-sub"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** A choice whose label holds a select: a native checkbox, its sentence and a hint. */
function SentenceCheck({
  checked,
  label,
  disabled,
  onChange,
  children,
  hint,
}: {
  checked: boolean;
  label: string;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  hint: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5 text-[13.5px]">
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-2 size-4 shrink-0 accent-purple disabled:cursor-not-allowed"
      />
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 font-semibold">{children}</p>
        <p className="text-[12.5px] leading-[1.5] text-sub">{hint}</p>
      </div>
    </div>
  );
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-control bg-danger-soft px-3 py-2.5 text-[12.5px] leading-[1.5] text-danger-ink">
      {children}
    </p>
  );
}

export function BounceRulesSection({ channel }: { channel: Channel }) {
  const { workspace, can } = useSession();
  const editable = workspace.id === channel.workspaceId && can('admin');
  const saved = useQuery(bouncePolicyQuery(channel.workspaceId));
  return (
    <Section
      title="Bounces"
      description="When an email can’t be delivered, the receiving server says why. Swarm sorts each bounce into hard, soft or blocked, and stops mailing an address by the rules below. They apply to every publication in the workspace."
    >
      {saved.isPending && <LoadingRows label="Loading bounce rules" rows={3} />}
      {saved.error && <ErrorNotice message={saved.error.message} />}
      {saved.data && (
        <BounceRulesForm
          workspaceId={channel.workspaceId}
          settings={saved.data}
          editable={editable}
        />
      )}
    </Section>
  );
}

function BounceRulesForm({
  workspaceId,
  settings,
  editable,
}: {
  workspaceId: string;
  settings: BouncePolicySettings;
  editable: boolean;
}) {
  const saved = useMemo(() => policyOf(settings), [settings]);
  const [draft, setDraft] = useState<BouncePolicy>(saved);
  const [applyToPast, setApplyToPast] = useState(false);
  const [done, setDone] = useState<BouncePolicySaved['applied'] | 'saved' | null>(null);
  const save = useSaveBouncePolicy(workspaceId);
  // The saved rules take over after a save, or when someone else changed them.
  const [base, setBase] = useState(saved);
  if (base !== saved) {
    setBase(saved);
    setDraft(saved);
  }
  const dirty = !same(draft, saved);
  const settled = useSettled(draft);
  const preview = useQuery({
    ...bouncePreviewQuery(workspaceId, settled),
    enabled: editable && dirty && same(settled, draft),
  });
  const change = (next: Partial<BouncePolicy>) => {
    setDone(null);
    setDraft((current) => ({ ...current, ...next }));
  };
  const softOff = draft.softStreak === null && draft.softWindow === null;
  const disabled = !editable || save.isPending;

  return (
    <div className="grid gap-5">
      <fieldset className="grid gap-2.5" disabled={disabled}>
        <legend className="mb-1 text-[14px] font-semibold">
          Hard bounces: the address or its domain doesn’t exist
        </legend>
        {(
          [
            [1, 'Stop mailing at the first hard bounce (recommended)'],
            [2, `Stop after 2 hard bounces within ${BOUNCE_LIMITS.hardRepeatDays} days`],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex items-center gap-2.5 text-[13.5px]">
            <input
              type="radio"
              name="hard-bounces"
              checked={draft.hardBounces === value}
              onChange={() => change({ hardBounces: value })}
              className="size-4 accent-purple"
            />
            {label}
          </label>
        ))}
        <p className="text-[12.5px] leading-[1.5] text-sub">
          Mailbox providers judge senders by how many hard bounces they cause, so mailing a dead
          address again hurts delivery for the rest of your list.
        </p>
        {draft.hardBounces === 2 && (
          <Warning>
            Only for a list where your email service sometimes calls a working address dead. Amazon
            SES, Resend, Mailgun and Postmark stop sending to an address after its first hard bounce
            on their own, so the second try usually comes straight back from them without reaching
            anyone.
          </Warning>
        )}
      </fieldset>

      <fieldset className="grid gap-3" disabled={disabled}>
        <legend className="mb-1 text-[14px] font-semibold">
          Soft bounces: a full mailbox, a mailbox that is off for now, an email too large, a server
          that asks to try later
        </legend>
        <SentenceCheck
          label="Stop after a number of emails in a row bounced softly"
          checked={draft.softStreak !== null}
          disabled={disabled}
          onChange={(on) => change({ softStreak: on ? (saved.softStreak ?? 3) : null })}
          hint="A delivered email starts the count again, so this works whether you send every day or once a month. Recommended: 3."
        >
          Stop after
          <Inline
            label="How many emails in a row"
            value={draft.softStreak ?? 3}
            disabled={disabled || draft.softStreak === null}
            options={STREAKS.map((n) => ({ value: n, label: String(n) }))}
            onChange={(softStreak) => change({ softStreak })}
          />
          emails in a row bounced softly
        </SentenceCheck>
        <SentenceCheck
          label="Stop after a number of soft bounces within a number of days"
          checked={draft.softWindow !== null}
          disabled={disabled}
          onChange={(on) =>
            change({ softWindow: on ? (saved.softWindow ?? { count: 3, days: 7 }) : null })
          }
          hint="Counts every soft bounce in that time, even with delivered emails in between. Before bounce rules existed, Swarm always used 3 within 7 days."
        >
          Stop after
          <Inline
            label="How many soft bounces"
            value={draft.softWindow?.count ?? 3}
            disabled={disabled || draft.softWindow === null}
            options={WINDOW_COUNTS.map((n) => ({ value: n, label: String(n) }))}
            onChange={(count) =>
              change({ softWindow: { days: draft.softWindow?.days ?? 7, count } })
            }
          />
          soft bounces within
          <Inline
            label="Within how many days"
            value={draft.softWindow?.days ?? 7}
            disabled={disabled || draft.softWindow === null}
            options={BOUNCE_LIMITS.softWindowDays.map((d) => ({ value: d, label: `${d} days` }))}
            onChange={(days) =>
              change({
                softWindow: {
                  count: draft.softWindow?.count ?? 3,
                  days: days as NonNullable<BouncePolicy['softWindow']>['days'],
                },
              })
            }
          />
        </SentenceCheck>
        {softOff && (
          <Warning>
            Swarm will never stop mailing an address for soft bounces. A mailbox that is full for
            good, or a domain that only ever says “try later”, stays on your list and keeps raising
            your bounce rate.
          </Warning>
        )}
      </fieldset>

      <div className="grid gap-2 text-[12.5px] leading-[1.5] text-sub">
        <p>
          <span className="font-semibold text-ink">Blocked:</span> the receiving server refused
          because of the sender (your reputation, a blocklist, the content, or SPF, DKIM or DMARC),
          not because of the address. Swarm never stops mailing a subscriber for a block. Blocks
          count towards your bounce rate and warm-up, and the check-up names the mailbox provider
          that is refusing you.
        </p>
        <p>
          <span className="font-semibold text-ink">Spam complaints:</span> the first one always
          stops mailing that address. This can’t be changed: mailing someone who reported you as
          spam goes against the law in many countries and hurts your reputation the most.
        </p>
      </div>

      <fieldset disabled={disabled}>
        <legend className="sr-only">Subscribers on a paid plan</legend>
        <Checkbox
          label="Ask me before stopping a subscriber on a paid plan"
          checked={draft.askForPaid}
          disabled={disabled}
          onChange={(askForPaid) => change({ askForPaid })}
          hint="Swarm lists them under Needs your attention and emails the workspace’s owners and admins. They keep getting your emails until you decide, because quietly stopping a paid subscription’s email is worse than one more bounce. Gifts and free grants of a paid plan count too."
        />
      </fieldset>

      {!editable && (
        <p className="text-[12.5px] text-sub">
          Only the workspace’s owners and admins can change these rules.
        </p>
      )}

      {editable && (
        <div className="grid gap-3 border-t border-line pt-4">
          {dirty && (
            <div className="grid gap-3 rounded-control bg-surface-alt px-3 py-3">
              <p role="status" className="text-[13.5px] leading-[1.5]">
                {preview.data ? (
                  <PreviewText stopped={preview.data.stopped} held={preview.data.held} />
                ) : preview.error ? (
                  'Swarm couldn’t count who these rules would stop. You can still save them.'
                ) : (
                  'Counting who these rules would stop…'
                )}
              </p>
              <Checkbox
                label="Apply to past bounces too"
                checked={applyToPast}
                onChange={setApplyToPast}
                hint={`Stops them now. Without this, the new rules count from each address’s next bounce, using its bounces so far. Bounce history goes back ${BOUNCE_LIMITS.historyDays} days.`}
              />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={!dirty}
              loading={save.isPending}
              onClick={() =>
                save.mutate(
                  { ...draft, applyToPast: dirty && applyToPast },
                  {
                    onSuccess: (result) => {
                      setApplyToPast(false);
                      setDone(result.applied ?? 'saved');
                    },
                  },
                )
              }
            >
              Save bounce rules
            </Button>
            {dirty && (
              <Button variant="ghost" disabled={save.isPending} onClick={() => setDraft(saved)}>
                Undo changes
              </Button>
            )}
            {!dirty && !same(saved, DEFAULT_BOUNCE_POLICY) && (
              <Button variant="quiet" onClick={() => change(DEFAULT_BOUNCE_POLICY)}>
                Use the recommended rules
              </Button>
            )}
            {done && (
              <span role="status" className="text-[13px] text-success">
                {done === 'saved' ? 'Saved.' : <AppliedText applied={done} />}
              </span>
            )}
          </div>
          {save.error && <ErrorNotice title="Not saved" message={save.error.message} />}
        </div>
      )}
    </div>
  );
}

function PreviewText({ stopped, held }: { stopped: number; held: number }) {
  if (!stopped && !held) {
    return <>With these rules, nobody who is still being mailed would be stopped.</>;
  }
  return (
    <>
      With these rules,{' '}
      <span className="font-semibold">{plural(stopped, 'subscriber', 'subscribers')}</span> would be
      stopped
      {held ? (
        <>
          , and{' '}
          <span className="font-semibold">
            {plural(held, 'subscriber', 'subscribers')} on a paid plan
          </span>{' '}
          would be listed for you to decide
        </>
      ) : null}
      .
    </>
  );
}

function AppliedText({ applied }: { applied: NonNullable<BouncePolicySaved['applied']> }) {
  const parts = [`${plural(applied.stopped, 'subscriber was', 'subscribers were')} stopped`];
  if (applied.held)
    parts.push(`${plural(applied.held, 'is', 'are')} listed under Needs your attention`);
  const more = applied.remaining
    ? ` ${plural(applied.remaining, 'more is', 'more are')} left: save again with “Apply to past bounces too” to go on.`
    : '';
  return <>{`Saved. ${parts.join(', and ')}.${more}`}</>;
}

// ---- Needs your attention --------------------------------------------------------------------

export function NeedsAttentionSection({ channel }: { channel: Channel }) {
  const { workspace, can } = useSession();
  const admin = workspace.id === channel.workspaceId && can('admin');
  const holds = useQuery(bounceHoldsQuery(channel.id));
  if (holds.isPending || holds.error || !holds.data.length) {
    return holds.error ? <ErrorNotice message={holds.error.message} /> : null;
  }
  return (
    <Section
      title="Needs your attention"
      description="Subscribers on a paid plan whose emails bounce. Your bounce rules would stop mailing them, and you asked to decide yourself. They keep getting your emails until you do. Check the address with them first: a typo, a full mailbox or a changed job is common."
    >
      <ul className="grid gap-3">
        {holds.data.map((hold) => (
          <HoldRow key={hold.id} channelId={channel.id} hold={hold} admin={admin} />
        ))}
      </ul>
    </Section>
  );
}

function HoldRow({
  channelId,
  hold,
  admin,
}: {
  channelId: string;
  hold: BounceHold;
  admin: boolean;
}) {
  const decide = useDecideBounceHold(channelId);
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="grid gap-2 rounded-card-app border border-line-app px-4 py-3 text-[13.5px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 font-semibold break-all">{hold.email}</span>
        <Pill tone={KIND_TONE[hold.last.kind]}>{BOUNCE_KIND_LABEL[hold.last.kind]}</Pill>
      </div>
      <p className="text-sub">
        {BOUNCE_CAUSE_TEXT[hold.last.cause]}. Your rules would stop mailing them after{' '}
        {bounceRuleReason(hold.rule, hold.counted, hold.days)}. Last bounce{' '}
        {formatDateTime(hold.last.at)}.
      </p>
      {hold.last.detail && <ServerSaid detail={hold.last.detail} code={hold.last.code} />}
      {admin ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            loading={decide.isPending && decide.variables?.decision === 'keep'}
            onClick={() => decide.mutate({ holdId: hold.id, decision: 'keep' })}
          >
            Keep mailing
          </Button>
          <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
            Stop mailing
          </Button>
        </div>
      ) : (
        <p className="text-[12.5px] text-sub">A workspace owner or admin decides.</p>
      )}
      {decide.error && <ErrorNotice message={decide.error.message} />}
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Stop mailing ${hold.email}?`}
        description="They become bounced in every publication of the workspace and get no more email, paid plan or not. If the address works again later, remove it from Blocked addresses to mail it again."
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep mailing
            </Button>
            <Button
              variant="danger"
              loading={decide.isPending}
              onClick={() =>
                decide.mutate(
                  { holdId: hold.id, decision: 'stop' },
                  { onSettled: () => setConfirming(false) },
                )
              }
            >
              Stop mailing
            </Button>
          </>
        }
      />
    </li>
  );
}

/** What the receiving server said, folded away: it is long and technical. */
export function ServerSaid({ detail, code }: { detail: string; code?: string | null }) {
  return (
    <details className="text-[12.5px]">
      <summary className="cursor-pointer font-semibold text-sub hover:text-ink">
        What the receiving server said{code ? ` (${code})` : ''}
      </summary>
      <p className="mt-1.5 rounded-control bg-surface-alt px-3 py-2 font-mono break-words">
        {detail}
      </p>
    </details>
  );
}
