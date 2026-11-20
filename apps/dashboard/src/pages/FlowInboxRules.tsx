// Inbox rules: a publication's limits on automated email, in the automations area. Every rule is
// off until someone turns it on here. The engine applies them at each automation email.
import type { Channel, InboxRuleSettings } from '@swarm/domain';
import { Checkbox, ErrorNotice, LoadingRows, TextField } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import { inboxRulesQuery, useSaveInboxRules } from '../api/flows';
import {
  fromDraft,
  heldNowSentence,
  rulesProblems,
  toDraft,
  type RulesDraft,
} from '../flows/inbox-rules';
import { SelectField } from '../flows/Select';
import { ReadOnlyNote, SaveRow } from '../site/controls';
import { PageHeader } from './Channels';
import { FlatSectionsProvider, Section, WithChannel } from './common';

const TIMEZONES: string[] = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'Europe/London', 'Europe/Prague', 'America/New_York', 'America/Los_Angeles'];
  }
})();

export function FlowInboxRulesPage({ channelId }: { channelId: string | undefined }) {
  const navigate = useNavigate();
  return (
    <WithChannel
      channelId={channelId}
      onChange={(id) => void navigate({ to: '/flows/inbox-rules', search: { channel: id } })}
    >
      {(channel) => <InboxRulesLoader key={channel.id} channel={channel} />}
    </WithChannel>
  );
}

function InboxRulesLoader({ channel }: { channel: Channel }) {
  const settings = useQuery(inboxRulesQuery(channel.id));
  return (
    <>
      <div className="mb-2 text-[13px]">
        <Link
          to="/flows"
          search={{ channel: channel.id }}
          className="text-sub no-underline hover:text-ink"
        >
          ← Automations
        </Link>
      </div>
      <PageHeader
        title="Inbox rules"
        subtitle={`Limits on automated email for ${channel.name} subscribers. Nothing is held until you turn a rule on.`}
      />
      {settings.isPending && <LoadingRows label="Loading inbox rules" rows={4} />}
      {settings.error && <ErrorNotice message={settings.error.message} />}
      {settings.data && <InboxRulesForm channel={channel} settings={settings.data} />}
    </>
  );
}

function InboxRulesForm({ channel, settings }: { channel: Channel; settings: InboxRuleSettings }) {
  const canEdit = ['editor', 'admin', 'owner'].includes(channel.role);
  const save = useSaveInboxRules(channel.id);
  const [draft, setDraft] = useState<RulesDraft>(() => toDraft(settings.rules, settings.timezone));
  const [checked, setChecked] = useState(false);
  const [saved, setSaved] = useState(false);
  const problems = checked ? rulesProblems(draft) : {};
  const apiError = save.error instanceof ApiError ? save.error : null;
  const set = (patch: Partial<RulesDraft>) => {
    setSaved(false);
    setDraft((d) => ({ ...d, ...patch }));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    setSaved(false);
    if (Object.keys(rulesProblems(draft)).length) return;
    save.mutate(
      { rules: fromDraft(draft), timezone: draft.timezone || null },
      { onSuccess: () => setSaved(true) },
    );
  };

  return (
    <form onSubmit={submit} noValidate className="grid max-w-[720px] gap-2">
      {!canEdit && <ReadOnlyNote>Editors can change these rules.</ReadOnlyNote>}
      <p className="text-[14px]">{heldNowSentence(settings.heldNow)}</p>
      <FlatSectionsProvider>
        <Section
          title="Email limit"
          description="Emails over the limit wait, then go out in the order they were held, spaced by the limit. A day is any 24 hours and a week is any 7 days."
        >
          <div className="grid gap-4">
            <Checkbox
              label="Limit automated emails per subscriber"
              checked={draft.limitOn}
              disabled={!canEdit}
              onChange={(limitOn) =>
                set(
                  limitOn && !draft.perDay && !draft.perWeek
                    ? { limitOn, perDay: '2' }
                    : { limitOn },
                )
              }
            />
            {draft.limitOn && (
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label="Per day"
                  inputMode="numeric"
                  value={draft.perDay}
                  disabled={!canEdit}
                  hint="Leave empty for no daily limit."
                  error={problems.perDay}
                  onChange={(e) => set({ perDay: e.target.value })}
                />
                <TextField
                  label="Per week"
                  inputMode="numeric"
                  value={draft.perWeek}
                  disabled={!canEdit}
                  hint="Leave empty for no weekly limit."
                  error={problems.perWeek}
                  onChange={(e) => set({ perWeek: e.target.value })}
                />
              </div>
            )}
          </div>
        </Section>

        <Section
          title="Quiet hours"
          description="Times follow the subscriber’s timezone where it is known, and the publication’s otherwise."
        >
          <div className="grid gap-4">
            <Checkbox
              label="No automated email between these times"
              checked={draft.quietOn}
              disabled={!canEdit}
              onChange={(quietOn) => set({ quietOn })}
            />
            {draft.quietOn && (
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label="From"
                  type="time"
                  value={draft.quietStart}
                  disabled={!canEdit}
                  error={problems.quietStart}
                  onChange={(e) => set({ quietStart: e.target.value })}
                />
                <TextField
                  label="Until"
                  type="time"
                  value={draft.quietEnd}
                  disabled={!canEdit}
                  error={problems.quietEnd}
                  onChange={(e) => set({ quietEnd: e.target.value })}
                />
              </div>
            )}
          </div>
        </Section>

        <Section
          title="Newsletter day"
          description="Automated email waits until the next day when a subscriber gets a post that day, whether it was sent or is scheduled."
        >
          <div className="grid gap-4">
            <Checkbox
              label="No automated email on a day a subscriber gets a post"
              checked={draft.postDayOn}
              disabled={!canEdit}
              onChange={(postDayOn) => set({ postDayOn })}
            />
            {draft.postDayOn && (
              <div className="sm:w-1/2">
                <TextField
                  label="Hours around a post"
                  inputMode="numeric"
                  value={draft.hoursAround}
                  disabled={!canEdit}
                  hint="Also hold this long before and after a post. Use 0 to hold on the day only."
                  error={problems.hoursAround}
                  onChange={(e) => set({ hoursAround: e.target.value })}
                />
              </div>
            )}
          </div>
        </Section>

        <Section
          title="How long an email can wait"
          description="An email that would wait longer than this is not sent, and its run says why. Other automation steps after it don’t run."
        >
          <div className="sm:w-1/2">
            <TextField
              label="Days"
              inputMode="numeric"
              value={draft.maxHoldDays}
              disabled={!canEdit}
              error={problems.maxHoldDays}
              onChange={(e) => set({ maxHoldDays: e.target.value })}
            />
          </div>
        </Section>

        <Section
          title="Publication timezone"
          description="Used when a subscriber’s own timezone is not known. Automation steps that wait until a day and time in the subscriber’s timezone use it too."
        >
          <div className="sm:w-1/2">
            <SelectField
              label="Timezone"
              value={draft.timezone}
              disabled={!canEdit}
              error={apiError?.field('timezone')}
              onChange={(e) => set({ timezone: e.target.value })}
            >
              <option value="">Not set (UTC)</option>
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </SelectField>
          </div>
        </Section>

        <Section
          title="Emails that always go"
          description="Mark an email Send regardless in the automation builder and no rule holds it. It still counts toward the limit, so the emails after it may wait. The first email of an automation that only starts when someone confirms or joins starts out marked, and every other email starts out unmarked."
        >
          <p className="text-[13px] text-sub">
            Test runs are never held and don’t count toward the limit.
          </p>
        </Section>
      </FlatSectionsProvider>
      {canEdit && <SaveRow pending={save.isPending} saved={saved} error={save.error} />}
    </form>
  );
}
