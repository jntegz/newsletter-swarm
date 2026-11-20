import type { SignupMode } from '@swarm/domain';
import { Button, ErrorNotice, LoadingRows } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { instanceSettingsQuery, useSaveInstanceSettings } from '../api/instance';
import { useSession } from '../session';
import { EmailService } from './EmailService';
import { InstanceAudit } from './InstanceAudit';
import { InstanceEmailCheckBudgets } from './InstanceEmailCheckBudgets';
import { InstanceFeatures } from './InstanceFeatures';
import { InstanceSiteCode } from './InstanceSiteCode';
import { SendingLimits } from './SendingLimits';

const CHOICES: { value: SignupMode; label: string; help: string }[] = [
  {
    value: 'invite_only',
    label: 'Only people you invite',
    help: 'New people need an invite to a workspace. Everyone who already has an account can still sign in.',
  },
  {
    value: 'open',
    label: 'Anyone with the link',
    help: 'Anyone who can open this Swarm can sign up and gets a workspace of their own.',
  },
];

/** Settings → Instance: settings for the whole Swarm, shown to its owners only. */
export function InstanceSettingsPage() {
  const { me } = useSession();
  if (!me.instanceAdmin) {
    return (
      <div className="card-app max-w-[560px] p-6 text-[14px] text-sub">
        Only the owner of this Swarm can change these settings.
      </div>
    );
  }
  return (
    <div className="grid gap-10">
      <InstanceSettingsForm />
      <InstanceSiteCode />
      <EmailService />
      <SendingLimits />
      <InstanceEmailCheckBudgets />
      <InstanceFeatures />
      <InstanceAudit />
    </div>
  );
}

function InstanceSettingsForm() {
  const settings = useQuery(instanceSettingsQuery);
  const save = useSaveInstanceSettings();
  const [choice, setChoice] = useState<SignupMode | null>(null);
  const [saved, setSaved] = useState(false);

  if (settings.isPending) return <LoadingRows label="Loading instance settings" rows={2} />;
  if (settings.error) return <ErrorNotice message={settings.error.message} />;

  const current = choice ?? settings.data.signup;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    save.mutate({ signup: current }, { onSuccess: () => setSaved(true) });
  };

  return (
    <form onSubmit={submit} className="card-app grid max-w-[560px] gap-5 p-6">
      <fieldset className="grid gap-3">
        <legend className="mb-1 text-[14px] font-semibold">Who can sign up</legend>
        {CHOICES.map((option) => (
          <div key={option.value}>
            <label className="flex items-center gap-2.5 text-[13.5px] font-semibold text-ink">
              <input
                type="radio"
                name="signup"
                value={option.value}
                className="size-4 accent-purple"
                aria-describedby={`signup-${option.value}-help`}
                checked={current === option.value}
                onChange={() => {
                  setChoice(option.value);
                  setSaved(false);
                }}
              />
              {option.label}
            </label>
            <p id={`signup-${option.value}-help`} className="mt-0.5 pl-[26px] text-[13px] text-sub">
              {option.help}
            </p>
          </div>
        ))}
      </fieldset>
      {save.error && <ErrorNotice message={save.error.message} />}
      <div className="flex items-center gap-3">
        <Button type="submit" loading={save.isPending}>
          Save
        </Button>
        <p role="status" className="text-[13px] text-success">
          {saved ? 'Saved.' : ''}
        </p>
      </div>
    </form>
  );
}
