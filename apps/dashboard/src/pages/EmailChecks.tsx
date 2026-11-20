// Email checks with DeBounce (docs/email-verification.md): the DeBounce card's panel on the Apps
// page, the colour dot and filter on the Subscribers page, checking a list (plan, run in parts,
// results, what to do with red addresses), one subscriber's check, and the import option.
import {
  DEBOUNCE_API_SETTINGS_URL,
  DEBOUNCE_SIGNUP_URL,
  EMAIL_CHECK_COLOURS,
  EMAIL_CHECK_ORIGIN_ACTIONS,
  EMAIL_CHECK_RUN_FINAL,
  EMAIL_CHECK_STATE_LABELS,
  EMAIL_CHECK_VALID_MONTHS,
  type Channel,
  type EmailCheckAction,
  type EmailCheckColour,
  type EmailCheckOrigin,
  type EmailCheckRedAction,
  type EmailCheckRedResult,
  type EmailCheckRun,
  type EmailCheckSettings,
  type EmailCheckState,
  type EmailCheckSummary,
  type ImportJob,
  type ImportReport,
  type MemberEmailCheck,
} from '@swarm/domain';
import {
  Button,
  Checkbox,
  Dialog,
  ErrorNotice,
  LoadingRows,
  Progress,
  SelectField,
  Switch,
  TextField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { circlesQuery } from '../api/circles';
import { ApiError } from '../api/client';
import {
  emailCheckRunQuery,
  emailCheckStatusQuery,
  importEmailCheckQuery,
  useImportCheckAction,
  emailCheckSummaryQuery,
  instanceEmailChecksQuery,
  memberEmailCheckQuery,
  useCheckMemberAgain,
  useImportEmailCheck,
  useInstanceEmailChecks,
  usePlanEmailCheck,
  useRedAction,
  useRunAction,
  useSaveEmailCheckSettings,
} from '../api/emailChecks';
import { useSession } from '../session';
import { formatDateTime, numberFormat } from './common';

/** A UTC day, for when a workspace's list checks start again. */
const resetDay = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});

// ---- The colour ------------------------------------------------------------------------------

const DOT: Record<EmailCheckState, string> = {
  green: 'bg-success border-success',
  orange: 'bg-caution border-caution',
  red: 'bg-danger border-danger',
  unchecked: 'bg-transparent border-[var(--text-muted)]',
};

const STATE_TEXT: Record<EmailCheckState, string> = {
  green: 'text-success',
  orange: 'text-caution',
  red: 'text-danger',
  unchecked: 'text-sub',
};

/** What a colour says, for people who don't read colours. */
export const STATE_MEANING: Record<EmailCheckState, string> = {
  green: 'Deliverable',
  orange: 'Worth a look',
  red: 'Will bounce or is not real',
  unchecked: 'Not checked yet',
};

/** A small dot with its words for screen readers and on hover: never colour alone. */
export function EmailCheckDot({
  check,
  showUnchecked = true,
}: {
  check: MemberEmailCheck | null | undefined;
  showUnchecked?: boolean;
}) {
  const state: EmailCheckState = check?.state ?? 'unchecked';
  if (!check && !showUnchecked) return null;
  const words = check
    ? `Email check: ${EMAIL_CHECK_STATE_LABELS[state]}, ${check.reason}${check.stale ? ' (old result)' : ''}`
    : 'Email check: not checked';
  return (
    <span className="inline-flex shrink-0 items-center" title={words}>
      <span
        aria-hidden="true"
        className={`inline-block size-2.5 rounded-full border-2 ${DOT[state]}`}
      />
      <span className="sr-only">{words}</span>
    </span>
  );
}

function StateLabel({ state, children }: { state: EmailCheckState; children?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className={`inline-block size-2.5 rounded-full border-2 ${DOT[state]}`}
      />
      <span className={`font-semibold ${STATE_TEXT[state]}`}>
        {EMAIL_CHECK_STATE_LABELS[state]}
      </span>
      {children}
    </span>
  );
}

// ---- A mention that can be put away -----------------------------------------------------------

function readDismissed(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

/** One suggestion, put away for good on this browser with its own button. */
export function Suggestion({ id, children }: { id: string; children: ReactNode }) {
  const key = `swarm:dismissed:${id}`;
  const [hidden, setHidden] = useState(() => readDismissed(key));
  if (hidden) return null;
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-[14px] border border-lavender-line bg-lavender px-4 py-3 text-[13.5px] text-purple-deep">
      <div className="min-w-0 flex-1">{children}</div>
      <Button
        variant="quiet"
        size="sm"
        onClick={() => {
          setHidden(true);
          try {
            window.localStorage.setItem(key, '1');
          } catch {
            // Storage can be blocked; it stays hidden for this page.
          }
        }}
      >
        Dismiss
      </Button>
    </div>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="font-semibold underline">
      {children}
    </a>
  );
}

// ---- The DeBounce card on the Apps page ---------------------------------------------------------

/** The setup guide: where the key comes from and where it goes. Instance admins only. */
function SetupGuide() {
  return (
    <div className="grid gap-3">
      <p className="font-semibold">Set up DeBounce for this Swarm</p>
      <ol className="grid list-decimal gap-2 pl-5">
        <li>
          Create a DeBounce account. You buy credits there: each checked address uses one.
          <div className="mt-2">
            <a
              href={DEBOUNCE_SIGNUP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary btn-sm"
            >
              Create a DeBounce account
            </a>
          </div>
        </li>
        <li>
          Open <ExternalLink href={DEBOUNCE_API_SETTINGS_URL}>API settings</ExternalLink> in
          DeBounce and copy the API key.
        </li>
        <li>
          On the computer you installed Swarm from, run{' '}
          <code className="whitespace-nowrap">pnpm swarm enable debounce</code> and paste the key.
          It is kept as a secret of the api, capture and jobs workers, never in the database.
          <details className="mt-1.5 text-[12.5px] text-sub">
            <summary className="cursor-pointer font-semibold text-purple-deep">
              Installed by hand?
            </summary>
            <p className="mt-1">
              Run this in <code>workers/api</code>, <code>workers/capture</code> and{' '}
              <code>workers/jobs</code>, then deploy them:
            </p>
            <pre className="mt-1 overflow-x-auto rounded-[10px] bg-surface-alt p-2 text-[12px]">
              wrangler secret put DEBOUNCE_API_KEY --env production
            </pre>
          </details>
        </li>
        <li>Reload this page to see your credit balance.</li>
      </ol>
    </div>
  );
}

function WhoCanUse() {
  const { me } = useSession();
  const instance = useQuery(instanceEmailChecksQuery(me.instanceAdmin));
  const change = useInstanceEmailChecks();
  if (!me.instanceAdmin) return null;
  if (instance.isPending) return <LoadingRows label="Loading DeBounce" rows={2} />;
  if (instance.error) return <ErrorNotice message={instance.error.message} />;
  const data = instance.data;
  return (
    <div className="grid gap-4">
      {!data.keySet ? (
        <SetupGuide />
      ) : data.keyRejected ? (
        <ErrorNotice message="DeBounce didn’t accept the key. Copy it again from DeBounce’s API settings and run pnpm swarm enable debounce." />
      ) : (
        <p>
          DeBounce is set up.{' '}
          {data.balance === null ? (
            'Its balance can’t be read right now.'
          ) : (
            <>
              <b className="tabular">{numberFormat.format(data.balance)}</b> credits left.
            </>
          )}{' '}
          <ExternalLink href={DEBOUNCE_SIGNUP_URL}>Open DeBounce</ExternalLink> to add credits.
        </p>
      )}
      <fieldset className="grid gap-2">
        <legend className="mb-1 font-semibold">Who can use DeBounce</legend>
        <p className="text-[12.5px] text-sub">
          The credits are yours. A workspace an instance admin makes is allowed when it is made.
          Anyone else’s needs you to allow it here, even after they make you an owner of it.
        </p>
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name="debounce-who"
            className="mt-1 accent-purple"
            checked={!data.everyWorkspace}
            onChange={() => change.everyWorkspace.mutate(false)}
          />
          <span>Only the workspaces you allow below</span>
        </label>
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name="debounce-who"
            className="mt-1 accent-purple"
            checked={data.everyWorkspace}
            onChange={() => change.everyWorkspace.mutate(true)}
          />
          <span>Every workspace on this Swarm</span>
        </label>
        {!data.everyWorkspace && data.workspaces.length > 0 && (
          <details className="mt-1">
            <summary className="cursor-pointer font-semibold text-purple-deep">
              Allowed workspaces (
              {numberFormat.format(data.workspaces.filter((w) => w.allowed).length)} of{' '}
              {numberFormat.format(data.workspaces.length)})
            </summary>
            <ul className="mt-2 grid gap-2">
              {data.workspaces.map((w) => (
                <li key={w.id}>
                  <Checkbox
                    label={w.name}
                    hint={[
                      w.ownedByInstanceAdmin
                        ? 'An instance admin is an owner here. It can use the credits only while this is ticked.'
                        : null,
                      w.dailyChecks !== undefined
                        ? `${numberFormat.format(w.usedToday ?? 0)} of ${numberFormat.format(w.dailyChecks)} single checks used today.`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    checked={w.allowed}
                    disabled={change.workspace.isPending}
                    onChange={(allowed) => change.workspace.mutate({ id: w.id, allowed })}
                  />
                </li>
              ))}
            </ul>
          </details>
        )}
        {(change.everyWorkspace.error ?? change.workspace.error) && (
          <ErrorNotice
            message={(change.everyWorkspace.error ?? change.workspace.error)?.message ?? ''}
          />
        )}
      </fieldset>
    </div>
  );
}

const ORIGIN_LABEL: Record<EmailCheckOrigin, string> = {
  signup: 'Signup forms',
  import: 'Imports',
  manual: 'Added by hand or through the API',
};

const ACTION_LABEL: Record<EmailCheckOrigin, Record<EmailCheckAction, string>> = {
  signup: {
    accept: 'Accept',
    tag: 'Accept and tag',
    confirm: 'Ask them to confirm by email',
    refuse: 'Refuse at the form; once confirmed, stop mailing them',
  },
  import: {
    accept: 'Import',
    tag: 'Import and tag',
    confirm: 'Import as pending, to confirm by email',
    refuse: 'Skip, and list them in the report',
  },
  manual: { accept: 'Keep', tag: 'Keep and tag', confirm: 'Keep', refuse: 'Keep' },
};

function RulesForm({
  workspaceId,
  settings,
}: {
  workspaceId: string;
  settings: EmailCheckSettings;
}) {
  const save = useSaveEmailCheckSettings(workspaceId);
  const [draft, setDraft] = useState(settings);
  const error = save.error instanceof ApiError ? save.error : null;
  const setRule = (origin: EmailCheckOrigin, colour: EmailCheckColour, action: EmailCheckAction) =>
    setDraft((d) => ({ ...d, [origin]: { ...d[origin], [colour]: action } }));

  return (
    <form
      className="grid gap-4"
      aria-label="What to do with each colour"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(draft);
      }}
    >
      <p className="font-semibold">What to do with each colour</p>
      <p className="text-[12.5px] text-sub">
        Green: deliverable. Orange: can’t be confirmed, a team address or a temporary one. Red: will
        bounce, not an address, or a spam trap. Tags are named email-green, email-orange and
        email-red.
      </p>
      {(Object.keys(ORIGIN_LABEL) as EmailCheckOrigin[]).map((origin) => (
        <fieldset key={origin} className="grid gap-2 rounded-[14px] border border-line-app p-3">
          <legend className="px-1 font-semibold">{ORIGIN_LABEL[origin]}</legend>
          {origin === 'signup' && (
            <>
              <Switch
                label="Check signups once they confirm"
                hint="Forms that ask people to confirm by email. The address goes to DeBounce only after its owner has clicked the confirmation link; then these rules apply, and a refusal stops mailing them (undo it on the Sending page)."
                checked={draft.checkConfirmed}
                onChange={(checkConfirmed) => setDraft((d) => ({ ...d, checkConfirmed }))}
              />
              <Switch
                label="Check signups at single opt-in forms while they wait"
                hint="Off unless you turn it on. These forms have no confirmation step, so each address typed into them goes to DeBounce at signup, before anyone has confirmed it, even when the signup is then refused: say so in your privacy notice. Up to 4 seconds; if DeBounce is slow, down or out of credits, the person is let in unchecked."
                checked={draft.checkSignups}
                onChange={(checkSignups) => setDraft((d) => ({ ...d, checkSignups }))}
              />
              <Switch
                label="Tell people at the form what the check found"
                hint="Off: a refused address gets the same answer as any signup and is simply not added, so nobody can use your form to test someone else's address. On: the form says the address can't receive email and offers DeBounce's spelling suggestion."
                checked={draft.showSignupVerdict}
                onChange={(showSignupVerdict) => setDraft((d) => ({ ...d, showSignupVerdict }))}
              />
            </>
          )}
          {origin === 'manual' && (
            <Switch
              label="Check them in the background"
              hint="They are added straight away; the check follows a few seconds later."
              checked={draft.checkManual}
              onChange={(checkManual) => setDraft((d) => ({ ...d, checkManual }))}
            />
          )}
          {origin === 'import' && (
            <p className="text-[12.5px] text-sub">When an import is set to check its addresses.</p>
          )}
          <div className="grid gap-2">
            {EMAIL_CHECK_COLOURS.map((colour) => (
              <SelectField
                key={colour}
                label={EMAIL_CHECK_STATE_LABELS[colour]}
                value={draft[origin][colour]}
                error={error?.field(`${origin}.${colour}`)}
                onChange={(e) => setRule(origin, colour, e.target.value as EmailCheckAction)}
                options={EMAIL_CHECK_ORIGIN_ACTIONS[origin].map((action) => ({
                  value: action,
                  label: ACTION_LABEL[origin][action],
                }))}
              />
            ))}
          </div>
        </fieldset>
      ))}
      <TextField
        label="A result counts for (months)"
        type="number"
        min={EMAIL_CHECK_VALID_MONTHS.min}
        max={EMAIL_CHECK_VALID_MONTHS.max}
        value={draft.validMonths}
        onChange={(e) => setDraft((d) => ({ ...d, validMonths: Number(e.target.value) }))}
        error={error?.field('validMonths')}
        hint="A later check asks DeBounce again only about addresses with an older result or none."
      />
      {error && !error.details.length && <ErrorNotice message={error.message} />}
      {save.isSuccess && <p role="status">Saved.</p>}
      <Button type="submit" className="justify-self-start" loading={save.isPending}>
        Save
      </Button>
    </form>
  );
}

/** The DeBounce dialog's body. */
export function DebouncePanel() {
  const { workspace, me, can } = useSession();
  const status = useQuery(emailCheckStatusQuery(workspace.id));
  if (status.isPending) return <LoadingRows label="Loading DeBounce" rows={2} />;
  if (status.error) return <ErrorNotice message={status.error.message} />;
  const s = status.data;
  return (
    <div className="grid gap-5">
      {me.instanceAdmin ? (
        <WhoCanUse />
      ) : !s.keySet ? (
        <p className="text-sub">
          The owner of this Swarm hasn’t set up DeBounce yet. They create an account and add its key
          once, for every workspace.
        </p>
      ) : null}
      {s.keySet && !me.instanceAdmin && (
        <p>
          {s.available
            ? `Addresses in ${workspace.name} can be checked with DeBounce.`
            : `The owner of this Swarm hasn’t let ${workspace.name} use DeBounce yet. Ask them to allow it.`}
          {s.available && s.balance !== null && (
            <>
              {' '}
              <b className="tabular">{numberFormat.format(s.balance)}</b> credits left.
            </>
          )}
        </p>
      )}
      {s.available && s.budget && (
        <p className={s.budget.exhausted ? 'text-danger' : 'text-sub'}>
          {s.budget.exhausted
            ? `${workspace.name} has used today’s ${numberFormat.format(s.budget.dailyChecks)} checks. Until tomorrow (UTC), signups pass unchecked and added subscribers aren’t checked; a check of the list catches them up later.`
            : `${numberFormat.format(s.budget.usedToday)} of ${numberFormat.format(s.budget.dailyChecks)} single checks used today. The owner of this Swarm sets this number.`}
        </p>
      )}
      {s.available && can('admin') && (
        <div className="border-t border-line pt-4">
          <RulesForm
            key={JSON.stringify(s.settings)}
            workspaceId={workspace.id}
            settings={s.settings}
          />
        </div>
      )}
      {s.available && !can('admin') && (
        <p className="text-sub">
          Ask an admin or owner of {workspace.name} to change what happens to each colour.
        </p>
      )}
    </div>
  );
}

// ---- The Subscribers page --------------------------------------------------------------------------

export interface EmailCheckFilter {
  state?: EmailCheckState | undefined;
  code?: number | undefined;
}

/**
 * The colour filter, the reasons under it, and "Check addresses". Shows nothing while email checks
 * are off; without DeBounce, one suggestion that can be put away.
 */
export function EmailCheckBar({
  channel,
  filter,
  onFilter,
}: {
  channel: Channel;
  filter: EmailCheckFilter;
  onFilter: (next: EmailCheckFilter) => void;
}) {
  const { workspace, can } = useSession();
  const summary = useQuery(emailCheckSummaryQuery(channel.id));
  const [open, setOpen] = useState(false);
  const data = summary.data;
  if (!data?.enabled) return null;
  if (!data.available) {
    return (
      <div className="mb-4">
        <Suggestion id="email-check-subscribers">
          <p className="font-semibold">Find the addresses that will bounce</p>
          <p className="mt-0.5">
            Swarm can check your subscribers’ addresses with DeBounce.{' '}
            <Link to="/apps" search={{ app: 'debounce' }} className="font-semibold underline">
              Set up DeBounce
            </Link>
          </p>
        </Suggestion>
      </div>
    );
  }
  const counts = data.counts;
  const run = data.run;
  const moving = run && !EMAIL_CHECK_RUN_FINAL.includes(run.status);
  const reasons = filter.state ? data.reasons.filter((r) => r.state === filter.state) : [];
  const isAdmin = can('admin') && (channel.role === 'admin' || channel.role === 'owner');

  return (
    <div className="mb-4 grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Filter by email check" className="flex flex-wrap gap-2">
          {([undefined, 'green', 'orange', 'red', 'unchecked'] as const).map((value) => {
            const count = value ? counts[value] : null;
            return (
              <button
                key={value ?? 'all'}
                type="button"
                aria-pressed={filter.state === value}
                onClick={() => onFilter({ state: value })}
                className={`inline-flex min-h-9 items-center gap-1.5 rounded-pill border px-3 py-1 text-[12.5px] font-semibold ${
                  filter.state === value
                    ? 'border-lavender-line bg-lavender text-purple-deep'
                    : 'border-line bg-surface text-sub hover:text-ink'
                }`}
              >
                {value && (
                  <span
                    aria-hidden="true"
                    className={`inline-block size-2.5 rounded-full border-2 ${DOT[value]}`}
                  />
                )}
                {value ? EMAIL_CHECK_STATE_LABELS[value] : 'Any email check'}
                {count !== null && (
                  <span className="tabular font-normal">{numberFormat.format(count)}</span>
                )}
              </button>
            );
          })}
        </div>
        {reasons.length > 1 && (
          <div className="w-full sm:w-56">
            <SelectField
              label="Reason"
              value={filter.code ? String(filter.code) : ''}
              onChange={(e) =>
                onFilter({
                  state: filter.state,
                  code: e.target.value ? Number(e.target.value) : undefined,
                })
              }
              options={[
                { value: '', label: 'Any reason' },
                ...reasons.map((r) => ({
                  value: String(r.code),
                  label: `${r.label} (${numberFormat.format(r.count)})`,
                })),
              ]}
            />
          </div>
        )}
        {isAdmin && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setOpen(true)}>
            {moving ? 'See the check' : 'Check addresses'}
          </Button>
        )}
      </div>
      {moving && run && (
        <p role="status" className="text-[12.5px] text-sub">
          {runLine(run)}
        </p>
      )}
      {filter.state === 'red' && isAdmin && <RedActions channelId={channel.id} />}
      {open && (
        <CheckDialog
          channel={channel}
          workspaceId={workspace.id}
          summary={data}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function runLine(run: EmailCheckRun): string {
  switch (run.status) {
    case 'planning':
      return 'Counting addresses for an email check…';
    case 'planned':
      return `An email check of ${numberFormat.format(run.plan.toCheck)} addresses is waiting to start.`;
    case 'paused':
      return run.pausedReason === 'credits'
        ? 'The email check is paused: the DeBounce account is out of credits.'
        : 'The email check is paused: DeBounce didn’t accept the key.';
    case 'stopping':
      return 'Stopping the email check after the part DeBounce is checking now.';
    default:
      return run.plan.method === 'single'
        ? `Checking addresses: ${numberFormat.format(run.progress.checked)} of ${numberFormat.format(run.plan.toCheck + run.plan.local)} done.`
        : `Checking addresses: part ${run.progress.part} of ${run.progress.parts}, ${numberFormat.format(run.progress.creditsUsed)} credits used so far.`;
  }
}

// ---- Checking a list ---------------------------------------------------------------------------------

type Scope = 'workspace' | 'channel' | 'segment';

function CheckDialog({
  channel,
  workspaceId,
  summary,
  onClose,
}: {
  channel: Channel;
  workspaceId: string;
  summary: EmailCheckSummary;
  onClose: () => void;
}) {
  // The running check, or the results of the last one; a fresh plan after a canceled one.
  const current = summary.run && summary.run.status !== 'canceled' ? summary.run.id : null;
  const [runId, setRunId] = useState<string | null>(current);
  const run = useQuery(emailCheckRunQuery(workspaceId, runId));
  const shown = run.data ?? (runId ? null : undefined);
  const title = !shown
    ? 'Check addresses'
    : shown.status === 'planning' || shown.status === 'planned'
      ? 'The plan'
      : EMAIL_CHECK_RUN_FINAL.includes(shown.status)
        ? 'Results'
        : 'Checking addresses';
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description="With DeBounce. Each address it checks uses one credit; Swarm’s own checks are free."
      actions={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="grid gap-4 text-[13.5px]">
        {runId && run.isPending && <LoadingRows label="Loading the check" rows={3} />}
        {run.error && <ErrorNotice message={run.error.message} />}
        {!runId && (
          <ScopeStep channel={channel} workspaceId={workspaceId} onPlanned={(id) => setRunId(id)} />
        )}
        {shown && (
          <RunView
            run={shown}
            channel={channel}
            workspaceId={workspaceId}
            onAgain={() => setRunId(null)}
          />
        )}
      </div>
    </Dialog>
  );
}

function ScopeStep({
  channel,
  workspaceId,
  onPlanned,
}: {
  channel: Channel;
  workspaceId: string;
  onPlanned: (runId: string) => void;
}) {
  const [scope, setScope] = useState<Scope>('channel');
  const [circleId, setCircleId] = useState('');
  const [onlyNeverChecked, setOnlyNeverChecked] = useState(false);
  const circles = useQuery({ ...circlesQuery(channel.id, null), enabled: scope === 'segment' });
  const plan = usePlanEmailCheck(workspaceId);
  const segments = circles.data?.items ?? [];
  const choices: { value: Scope; label: string; hint: string }[] = [
    {
      value: 'channel',
      label: `Subscribers of ${channel.name}`,
      hint: 'Everyone who may be mailed.',
    },
    {
      value: 'workspace',
      label: 'Every publication in this workspace',
      hint: 'An address in two publications is checked once.',
    },
    { value: 'segment', label: 'A segment', hint: `One of ${channel.name}’s segments.` },
  ];
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        plan.mutate(
          {
            scope,
            ...(scope !== 'workspace' ? { channelId: channel.id } : {}),
            ...(scope === 'segment' ? { circleId } : {}),
            onlyNeverChecked,
          },
          { onSuccess: (run) => onPlanned(run.id) },
        );
      }}
    >
      <fieldset className="grid gap-2">
        <legend className="mb-1 font-semibold">Which addresses</legend>
        {choices.map((choice) => (
          <label key={choice.value} className="flex items-start gap-2">
            <input
              type="radio"
              name="check-scope"
              className="mt-1 accent-purple"
              checked={scope === choice.value}
              onChange={() => setScope(choice.value)}
            />
            <span>
              {choice.label}
              <span className="block text-[12.5px] text-sub">{choice.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {scope === 'segment' &&
        (circles.isPending ? (
          <LoadingRows label="Loading segments" rows={1} />
        ) : segments.length ? (
          <SelectField
            label="Segment"
            required
            value={circleId}
            onChange={(e) => setCircleId(e.target.value)}
            options={[
              { value: '', label: 'Choose a segment' },
              ...segments.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
        ) : (
          <p className="text-sub">{channel.name} has no segments yet.</p>
        ))}
      <Checkbox
        label="Only addresses that were never checked"
        hint="Otherwise addresses with an old result are checked again too."
        checked={onlyNeverChecked}
        onChange={setOnlyNeverChecked}
      />
      {plan.error && <ErrorNotice message={plan.error.message} />}
      <Button
        type="submit"
        className="justify-self-start"
        loading={plan.isPending}
        disabled={scope === 'segment' && !circleId}
      >
        Count addresses
      </Button>
      <p className="text-[12.5px] text-sub">
        Counting sends nothing to DeBounce. You see how many credits it takes before it starts.
      </p>
    </form>
  );
}

function Row({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: ReactNode;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line py-2 last:border-0">
      <dt className={strong ? 'font-semibold' : 'text-sub'}>{label}</dt>
      <dd className={`tabular ${strong ? 'font-semibold' : ''}`}>{value}</dd>
    </div>
  );
}

function RunView({
  run,
  channel,
  workspaceId,
  onAgain,
}: {
  run: EmailCheckRun;
  channel: Channel;
  workspaceId: string;
  onAgain: () => void;
}) {
  const act = useRunAction(workspaceId);
  const [stopping, setStopping] = useState(false);
  const status = useQuery(emailCheckStatusQuery(workspaceId));
  const n = numberFormat.format;

  if (run.status === 'planning') {
    return (
      <p role="status" aria-live="polite">
        Counting addresses and settling what Swarm can tell for free…
      </p>
    );
  }

  if (run.status === 'planned' || run.status === 'canceled') {
    const enough = run.balance === null ? null : run.balance >= run.plan.toCheck;
    // This workspace's list checks for the month, set by the owner of this Swarm.
    const budget = status.data?.budget;
    const listLeft = budget ? Math.max(0, budget.listChecks - budget.listUsedThisMonth) : null;
    const overBudget = listLeft !== null && run.plan.toCheck > listLeft;
    return (
      <div className="grid gap-3">
        <dl>
          <Row label="Different addresses" value={n(run.plan.addresses)} />
          <Row label="Checked recently, skipped" value={n(run.plan.fresh)} />
          <Row label="Settled by Swarm for free" value={n(run.plan.local)} />
          <Row label="For DeBounce: credits needed" value={n(run.plan.toCheck)} strong />
          {run.plan.method === 'bulk' && (
            <Row label="Sent in parts of 5,000" value={`${n(run.plan.parts)} parts`} />
          )}
          <Row
            label="Your DeBounce balance"
            value={run.balance === null ? 'Can’t be read' : `${n(run.balance)} credits`}
          />
          {budget && listLeft !== null && (
            <Row
              label="This workspace’s list checks left this month"
              value={`${n(listLeft)} of ${n(budget.listChecks)}`}
            />
          )}
        </dl>
        {overBudget && run.status === 'planned' ? (
          <p className="text-danger" role="alert">
            This check needs {n(run.plan.toCheck)} credits, more than the {n(listLeft)} list checks
            this workspace has left this month, so it can’t start. Check a segment or only addresses
            never checked, wait until {resetDay.format(new Date(budget!.listResetsAt))}, or ask the
            owner of this Swarm for more.
          </p>
        ) : run.plan.toCheck === 0 ? (
          <p>Nothing needs DeBounce. Starting stores Swarm’s own results.</p>
        ) : enough === false ? (
          <p className="text-danger" role="alert">
            Not enough credits for all of them. The check pauses when they run out: add credits in
            DeBounce, then resume it.
          </p>
        ) : enough ? (
          <p className="text-success">Enough credits for this check.</p>
        ) : null}
        {act.error && <ErrorNotice message={act.error.message} />}
        {run.status === 'planned' ? (
          <div className="flex flex-wrap gap-2">
            <Button
              loading={act.isPending}
              disabled={overBudget}
              onClick={() => act.mutate({ id: run.id, action: 'start' })}
            >
              {run.plan.toCheck
                ? `Start the check (${n(run.plan.toCheck)} credits)`
                : 'Store the results'}
            </Button>
            <Button variant="ghost" onClick={() => act.mutate({ id: run.id, action: 'stop' })}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button variant="ghost" className="justify-self-start" onClick={onAgain}>
            Plan another check
          </Button>
        )}
      </div>
    );
  }

  if (run.status === 'running' || run.status === 'stopping' || run.status === 'paused') {
    const total = run.plan.toCheck + run.plan.local;
    return (
      <div className="grid gap-3" aria-live="polite">
        <Progress
          label={
            run.plan.method === 'single'
              ? 'Checked'
              : `Part ${Math.max(1, run.progress.part)} of ${run.progress.parts}`
          }
          value={run.progress.checked}
          max={total}
          valueText={`${n(run.progress.checked)} of ${n(total)}`}
          meta={`${n(run.progress.creditsUsed)} credits used${run.plan.method === 'bulk' && run.progress.partPercent ? `, DeBounce is ${run.progress.partPercent}% through this part` : ''}`}
        />
        {run.status === 'paused' && (
          <div role="alert" className="rounded-[14px] border border-line-app px-4 py-3">
            <p className="font-semibold">
              {run.pausedReason === 'credits'
                ? 'Paused: out of credits'
                : 'Paused: DeBounce refused the key'}
            </p>
            <p className="mt-0.5 text-sub">
              {run.pausedReason === 'credits'
                ? 'Add credits in DeBounce, then resume. Nothing is lost: it carries on with the next addresses.'
                : 'The owner of this Swarm runs pnpm swarm enable debounce with a working key, then you resume.'}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                size="sm"
                loading={act.isPending}
                onClick={() => act.mutate({ id: run.id, action: 'resume' })}
              >
                Resume
              </Button>
              {run.pausedReason === 'credits' && (
                <a
                  href={DEBOUNCE_SIGNUP_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-ghost btn-sm"
                >
                  Open DeBounce
                </a>
              )}
            </div>
          </div>
        )}
        {run.status === 'stopping' ? (
          <p role="status">
            Stopping. No further part is sent; DeBounce finishes the part it has, and its results
            are kept.
          </p>
        ) : stopping ? (
          <div
            role="group"
            aria-labelledby="stop-q"
            className="grid gap-2 rounded-[14px] border border-line-app px-4 py-3"
          >
            <p id="stop-q">
              Stop the check? No further part is sent. DeBounce can’t cancel the part it already
              has, so that part finishes, uses its credits, and its results are still stored.
            </p>
            <div className="flex gap-2">
              <Button
                variant="danger"
                size="sm"
                loading={act.isPending}
                onClick={() =>
                  act.mutate(
                    { id: run.id, action: 'stop' },
                    { onSuccess: () => setStopping(false) },
                  )
                }
              >
                Stop
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setStopping(false)}>
                Keep checking
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="justify-self-start"
            onClick={() => setStopping(true)}
          >
            Stop
          </Button>
        )}
        {act.error && <ErrorNotice message={act.error.message} />}
        <p className="text-[12.5px] text-sub">You can close this. The check carries on.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <p>
        {run.status === 'stopped'
          ? 'Stopped. '
          : run.status === 'failed'
            ? 'This check failed. '
            : 'Done. '}
        {run.error && <span className="text-danger">{run.error} </span>}
        {n(run.progress.checked)} addresses got a result, {n(run.progress.creditsUsed)} credits
        used.
      </p>
      <ul className="grid gap-1.5">
        {EMAIL_CHECK_COLOURS.map((colour) => (
          <li key={colour} className="flex items-baseline justify-between gap-3">
            <StateLabel state={colour}>
              <span className="text-sub">{STATE_MEANING[colour]}</span>
            </StateLabel>
            <span className="tabular font-semibold">{n(run.results[colour])}</span>
          </li>
        ))}
      </ul>
      <RedActions channelId={channel.id} />
      <OrangeAdvice channelId={channel.id} />
      <Button variant="ghost" className="justify-self-start" onClick={onAgain}>
        Plan another check
      </Button>
    </div>
  );
}

function OrangeAdvice({ channelId }: { channelId: string }) {
  const summary = useQuery(emailCheckSummaryQuery(channelId));
  const orange = summary.data?.counts.orange ?? 0;
  if (!orange) return null;
  return (
    <div className="rounded-[14px] border border-line-app px-4 py-3">
      <p className="font-semibold">
        <StateLabel state="orange" /> {numberFormat.format(orange)} worth a look
      </p>
      <p className="mt-0.5 text-sub">
        Many of them are real people, so don’t remove them. Make a segment where{' '}
        <b>Email check is Orange</b> and send them a re-engagement automation: keep those who open,
        let the inactive-reader cleanup take the rest.
      </p>
      <Link to="/circles" search={{ channel: channelId }} className="btn-ghost btn-sm mt-2">
        Open segments
      </Link>
    </div>
  );
}

/** What to do with this publication's red subscribers: counted first, confirmed, never paying ones. */
export function RedActions({ channelId }: { channelId: string }) {
  const preview = useRedAction(channelId);
  const act = useRedAction(channelId);
  const [asked, setAsked] = useState<EmailCheckRedAction | null>(null);
  const [counted, setCounted] = useState<EmailCheckRedResult | null>(null);
  const [done, setDone] = useState<{ action: EmailCheckRedAction; count: number } | null>(null);
  const summary = useQuery(emailCheckSummaryQuery(channelId));
  const red = summary.data?.counts.red ?? 0;
  if (!red && !done) return null;

  const ask = (action: EmailCheckRedAction) => {
    setAsked(action);
    preview.mutate({ action, confirm: false }, { onSuccess: setCounted });
  };
  const confirm = async (action: EmailCheckRedAction) => {
    let total = 0;
    for (let i = 0; i < 50; i++) {
      const result = await act.mutateAsync({ action, confirm: true });
      total += result.done;
      if (!result.remaining || action === 'delete') break;
    }
    setDone({ action, count: total });
    setAsked(null);
  };

  return (
    <div className="grid gap-3 rounded-[14px] border border-line-app px-4 py-3">
      <p className="font-semibold">
        <StateLabel state="red" /> {numberFormat.format(red)} will bounce or are not real
      </p>
      {done ? (
        <p role="status">
          {done.action === 'suppress'
            ? `Swarm stops mailing ${numberFormat.format(done.count)} of them. To mail one again, remove it from the suppressions on the Sending page.`
            : `${numberFormat.format(done.count)} are being deleted.`}
        </p>
      ) : asked && counted ? (
        <div role="group" aria-labelledby="red-q" className="grid gap-2">
          <p id="red-q">
            {asked === 'suppress'
              ? `Stop mailing ${numberFormat.format(counted.actionable)} subscribers? Each gets a suppression for this publication. You can remove them later on the Sending page.`
              : `Delete ${numberFormat.format(counted.actionable)} subscribers? This can’t be undone.`}
          </p>
          {counted.paying > 0 && <NeedsAttention result={counted} />}
          <div className="flex flex-wrap gap-2">
            <Button
              variant={asked === 'delete' ? 'danger' : 'primary'}
              size="sm"
              loading={act.isPending}
              disabled={!counted.actionable}
              onClick={() => void confirm(asked)}
            >
              {asked === 'suppress' ? 'Stop mailing them' : 'Delete them'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAsked(null)}>
              Not now
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-sub">
            Mailing them only adds bounces. Stopping is the safer choice: it can be undone.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              loading={preview.isPending && asked === 'suppress'}
              onClick={() => ask('suppress')}
            >
              Stop mailing them (recommended)
            </Button>
            <Button
              variant="ghost"
              size="sm"
              loading={preview.isPending && asked === 'delete'}
              onClick={() => ask('delete')}
            >
              Delete them
            </Button>
          </div>
        </>
      )}
      {(preview.error ?? act.error) && (
        <ErrorNotice message={(preview.error ?? act.error)?.message ?? ''} />
      )}
    </div>
  );
}

function NeedsAttention({ result }: { result: EmailCheckRedResult }) {
  return (
    <div className="rounded-[12px] bg-surface-alt px-3 py-2">
      <p className="font-semibold">
        Needs your attention: {numberFormat.format(result.paying)} paying
      </p>
      <p className="text-[12.5px] text-sub">
        They have a paid subscription, so Swarm leaves them alone. Look at them one by one: the
        address may have a typo, or they may pay with another one.
      </p>
      <ul className="mt-1.5 grid gap-0.5 font-mono text-[12.5px]">
        {result.needsAttention.map((m) => (
          <li key={m.id} className="break-all">
            {m.email}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- One subscriber ------------------------------------------------------------------------------------

/** The drawer's line: the colour, the reason, DeBounce's suggestion, and "Check again". */
export function MemberEmailCheckLine({
  memberId,
  canEdit,
}: {
  memberId: string;
  canEdit: boolean;
}) {
  const view = useQuery(memberEmailCheckQuery(memberId));
  const again = useCheckMemberAgain(memberId);
  if (!view.data) return null;
  const { check, available } = view.data;
  if (!check && !available) return null;
  return (
    <section
      aria-labelledby={`email-check-${memberId}`}
      className="grid gap-2 border-t border-line pt-4 text-[13.5px]"
    >
      <h3 id={`email-check-${memberId}`} className="text-[14px] font-semibold">
        Email check
      </h3>
      {check ? (
        <p>
          <StateLabel state={check.state}>
            <span>{check.reason}</span>
          </StateLabel>
          <span className="block text-[12.5px] text-sub">
            {check.source === 'swarm' ? 'Swarm’s own check' : 'DeBounce'},{' '}
            {formatDateTime(check.checkedAt)}
            {check.stale ? '. This result is old.' : ''}
          </span>
          {check.didYouMean && (
            <span className="block text-[12.5px]">
              DeBounce suggests <span className="font-mono">{check.didYouMean}</span>.
            </span>
          )}
        </p>
      ) : (
        <p>
          <StateLabel state="unchecked" />
        </p>
      )}
      {available && canEdit && (
        <Button
          variant="ghost"
          size="sm"
          className="justify-self-start"
          loading={again.isPending}
          disabled={again.isSuccess}
          onClick={() => again.mutate()}
        >
          {again.isSuccess ? 'Checking…' : check ? 'Check again' : 'Check now'}
        </Button>
      )}
      {again.error && <ErrorNotice message={again.error.message} />}
    </section>
  );
}

// ---- Imports --------------------------------------------------------------------------------------------

/** On the review step: the option, with what it costs. Without DeBounce, one suggestion. */
export function ImportEmailCheckOption({
  channelId,
  job,
  report,
}: {
  channelId: string;
  job: ImportJob;
  report: ImportReport;
}) {
  const summary = useQuery(emailCheckSummaryQuery(channelId));
  const toggle = useImportEmailCheck(channelId);
  const data = summary.data;
  if (!data?.enabled || report.counts.new === 0) return null;
  if (!data.available) {
    return (
      <Suggestion id="email-check-import">
        <p className="font-semibold">Check these addresses before they are imported</p>
        <p className="mt-0.5">
          Old lists hold addresses that bounce. DeBounce can find them first.{' '}
          <Link to="/apps" search={{ app: 'debounce' }} className="font-semibold underline">
            Set up DeBounce
          </Link>
        </p>
      </Suggestion>
    );
  }
  return (
    <div className="rounded-[14px] border border-line-app px-4 py-3">
      <Checkbox
        label="Check addresses during import"
        hint={`Up to ${numberFormat.format(report.counts.new)} credits, one per new address. Swarm’s own checks are free, and addresses checked in the last ${data.validMonths} months are skipped. Red ones are skipped and listed in the report; orange ones are imported with their colour, unless you changed that on the DeBounce card.`}
        checked={job.checkAddresses}
        disabled={toggle.isPending}
        onChange={(checkAddresses) => toggle.mutate({ id: job.id, checkAddresses })}
      />
      {toggle.error && <ErrorNotice message={toggle.error.message} />}
    </div>
  );
}

/** While the import waits for its email check. */
export function ImportEmailCheckProgress({ job }: { job: ImportJob }) {
  const run = useQuery(importEmailCheckQuery(job.id, job.checkAddresses && !!job.emailCheckRunId));
  const act = useImportCheckAction(job.id);
  const data = run.data;
  if (!job.checkAddresses || !job.emailCheckRunId || !data) return null;
  if (EMAIL_CHECK_RUN_FINAL.includes(data.status)) return null;
  return (
    <div role="status" className="mb-3 grid gap-2 text-[13.5px]">
      <p className="text-sub">
        {data.status === 'paused'
          ? runLine(data)
          : `${runLine(data)} The import starts when it is done.`}
      </p>
      {data.status === 'paused' && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" loading={act.isPending} onClick={() => act.mutate('resume')}>
            Resume the check
          </Button>
          <Button variant="ghost" size="sm" onClick={() => act.mutate('stop')}>
            Import without checking the rest
          </Button>
        </div>
      )}
      {act.error && <ErrorNotice message={act.error.message} />}
    </div>
  );
}

/** After the import: what the email check left out. */
export function ImportEmailCheckReport({ report }: { report: ImportReport }) {
  const ec = report.emailCheck;
  if (!ec || !(ec.skipped || ec.tagged || ec.confirm)) return null;
  return (
    <div className="mt-4 rounded-[14px] border border-line-app px-4 py-3 text-[13.5px]">
      <p className="font-semibold">Email check</p>
      <ul className="mt-1 grid gap-0.5">
        {ec.skipped > 0 && <li>{numberFormat.format(ec.skipped)} skipped for their colour</li>}
        {ec.tagged > 0 && <li>{numberFormat.format(ec.tagged)} imported and tagged</li>}
        {ec.confirm > 0 && (
          <li>{numberFormat.format(ec.confirm)} imported as pending, to confirm</li>
        )}
      </ul>
      {ec.samples.length > 0 && (
        <details className="mt-2 text-[12.5px]">
          <summary className="cursor-pointer font-semibold text-purple-deep">
            Show the skipped ones
          </summary>
          <ul className="mt-2 grid gap-1">
            {ec.samples.map((s) => (
              <li key={`${s.line}-${s.email}`} className="grid gap-0.5 sm:flex sm:gap-2">
                <span className="font-mono break-all">{s.email}</span>
                {s.reason && <span className="text-sub">{s.reason}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
