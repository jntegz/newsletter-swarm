// Sending settings → Tracking: what Swarm records about each subscriber when they read
// (docs/privacy-controls.md). Each switch saves at once; admins and owners change them.
import type { Channel, UpdateChannel } from '@swarm/domain';
import { ErrorNotice, Switch } from '@swarm/ui/components';
import { useState } from 'react';
import { useUpdateChannel } from '../api/queries';
import { Section } from '../pages/common';

type Key = 'trackOpens' | 'trackClicks' | 'profileReaders';

export const TRACKING_ANCHOR = 'tracking';

export function TrackingSection({ channel, admin }: { channel: Channel; admin: boolean }) {
  const update = useUpdateChannel(channel.id);
  // A switch moves as soon as it's pressed, and goes back if the save fails.
  const [shown, setShown] = useState<Record<Key, boolean>>({
    trackOpens: channel.trackOpens,
    trackClicks: channel.trackClicks,
    profileReaders: channel.profileReaders,
  });
  const [saving, setSaving] = useState<Key | null>(null);
  const change = (key: Key, value: boolean) => {
    const before = shown;
    // Profiles read opens: turning open tracking off turns them off too.
    const next = { ...shown, [key]: value };
    if (key === 'trackOpens' && !value) next.profileReaders = false;
    setShown(next);
    setSaving(key);
    const input: UpdateChannel = { [key]: value };
    update.mutate(input, {
      onSuccess: (saved) =>
        setShown({
          trackOpens: saved.trackOpens,
          trackClicks: saved.trackClicks,
          profileReaders: saved.profileReaders,
        }),
      onError: () => setShown(before),
      onSettled: () => setSaving(null),
    });
  };
  const locked = admin ? '' : ' Only admins can change this.';

  return (
    <Section
      title="Tracking"
      description={`What Swarm records about each subscriber when they read ${channel.name}. All three start off. Get your subscribers’ consent before turning them on (in the EU, a tracking image or tracked links in email generally need it), for example with a consent box on your sign-up form, and say in your privacy notice what you record. Subscribers can also turn tracking off for themselves in their subscriber settings. Network addresses are shortened and no cookies are set either way.`}
    >
      <div className="grid gap-5">
        <Switch
          label="Open tracking"
          checked={shown.trackOpens}
          disabled={!admin}
          loading={saving === 'trackOpens'}
          onChange={(value) => change('trackOpens', value)}
          hint={`Each email carries a tiny image that shows who opened it. Off: no image, and send reports show no opens or open rate.${locked}`}
        />
        <Switch
          label="Click tracking"
          checked={shown.trackClicks}
          disabled={!admin}
          loading={saving === 'trackClicks'}
          onChange={(value) => change('trackClicks', value)}
          hint={`Links go through Swarm, so you can see who clicked what. Off: links go straight to their address, send reports show no clicks, and automations can't start or wait on a click.${locked}`}
        />
        <Switch
          label="Reader profiles"
          checked={shown.profileReaders}
          disabled={!admin || !shown.trackOpens}
          loading={saving === 'profileReaders'}
          onChange={(value) => change('profileReaders', value)}
          hint={
            shown.trackOpens
              ? `An engagement score for each subscriber and the hour they usually read, worked out from their opens and clicks. Used by segments on engagement, the inactive-reader cleanup and sending at each reader’s best time. Off: none of these, and existing scores are deleted within a day.${locked}`
              : 'Needs open tracking. With open tracking off there are no scores, no best-time sending and no inactive-reader cleanup.'
          }
        />
      </div>
      {update.error && (
        <div className="mt-4">
          <ErrorNotice title="Not saved" message={update.error.message} />
        </div>
      )}
    </Section>
  );
}

/** Above the inactive-reader choice when it can't run: it works from opens. */
export function InactiveReadersPaused({ channel }: { channel: Channel }) {
  if (channel.profileReaders) return null;
  return (
    <p className="rounded-control bg-surface-alt px-3 py-2.5 text-[13px] leading-[1.5]">
      <span className="font-semibold">The inactive-reader cleanup is not running.</span> It needs
      open tracking and reader profiles, so nobody is unsubscribed for not opening.{' '}
      <a href={`#${TRACKING_ANCHOR}`} className="font-semibold underline underline-offset-2">
        Tracking settings
      </a>
    </p>
  );
}
