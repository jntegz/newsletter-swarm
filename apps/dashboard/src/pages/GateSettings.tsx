// Memberships → Gates: the Channel's meter (free gated reads per period for readers without
// access), the default Gate copy, and the coupon shown inside the Gate.
import type { GateSettings, UpdateGateSettings } from '@swarm/domain';
import { ErrorNotice, LoadingRows, SelectField, TextField } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import {
  couponsQuery,
  gateSettingsQuery,
  isFeatureDisabled,
  useUpdateGateSettings,
} from '../api/money';
import { GateDesignFields } from '../money/GateDesignFields';
import {
  designDraft,
  designInput,
  designProblems,
  discountLabel,
  type GateDesignDraft,
} from '../money/helpers';
import { ChoiceCards, ReadOnlyNote, SaveRow } from '../site/controls';
import { Section } from './common';
import { useMemberships } from './Memberships';

export function GateSettingsPage() {
  const { channel } = useMemberships();
  const settings = useQuery(gateSettingsQuery(channel.id));
  if (settings.isPending) return <LoadingRows label="Loading paywall settings" rows={4} />;
  if (settings.error) return <ErrorNotice message={settings.error.message} />;
  return <GateSettingsForm key={settings.data.channelId} settings={settings.data} />;
}

function GateSettingsForm({ settings }: { settings: GateSettings }) {
  const { channel, canEdit } = useMemberships();
  const coupons = useQuery(couponsQuery(channel.id));
  const update = useUpdateGateSettings(channel.id);
  const [limit, setLimit] = useState(String(settings.meterLimit));
  const [period, setPeriod] = useState(settings.meterPeriod);
  const [mode, setMode] = useState(settings.meterMode);
  const [design, setDesign] = useState<GateDesignDraft>(designDraft(settings.design));
  const [couponId, setCouponId] = useState(settings.gateCouponId ?? '');
  const [saved, setSaved] = useState(false);
  const [couponOff, setCouponOff] = useState(false);
  const apiError = update.error instanceof ApiError ? update.error : null;
  const limitNumber = Number(limit);
  const limitProblem =
    !/^\d{1,3}$/.test(limit) || limitNumber > 100 ? 'Use 0 to 100 posts.' : undefined;
  const designErrors = designProblems(design);
  const meterOn = limitNumber > 0 && !limitProblem;
  const activeCoupons = (coupons.data ?? []).filter((c) => c.status === 'active');
  const disabled = !canEdit;

  const save = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    if (limitProblem || Object.keys(designErrors).length) return;
    const input: UpdateGateSettings = {};
    if (limitNumber !== settings.meterLimit) input.meterLimit = limitNumber;
    if (period !== settings.meterPeriod) input.meterPeriod = period;
    if (mode !== settings.meterMode) input.meterMode = mode;
    const nextDesign = designInput(design);
    if (JSON.stringify(nextDesign) !== JSON.stringify(designInput(designDraft(settings.design)))) {
      input.design = nextDesign;
    }
    if ((couponId || null) !== settings.gateCouponId) input.gateCouponId = couponId || null;
    if (Object.keys(input).length === 0) {
      setSaved(true);
      return;
    }
    update.mutate(input, {
      onSuccess: () => setSaved(true),
      onError: (error) => {
        if (isFeatureDisabled(error) && input.gateCouponId !== undefined) setCouponOff(true);
      },
    });
  };

  return (
    <form onSubmit={save} noValidate className="grid max-w-[820px] gap-5">
      <Section
        title="Meter"
        description="Let readers without access read a few paywalled posts each period before the paywall stops them. Each post's paywall can opt out. Free reads are a prompt, not a lock: a visitor who isn't signed in is counted in their own browser and can clear it to read again. To keep a post for paying readers only, turn the meter off for its paywall."
      >
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Free paywalled posts per period"
              inputMode="numeric"
              value={limit}
              disabled={disabled}
              onChange={(e) => {
                setSaved(false);
                setLimit(e.target.value.trim());
              }}
              error={limitProblem ?? apiError?.field('meterLimit')}
              hint={meterOn ? 'The meter is on.' : '0 turns the meter off.'}
            />
            <SelectField
              label="Period"
              value={period}
              disabled={disabled || !meterOn}
              onChange={(e) => setPeriod(e.target.value as GateSettings['meterPeriod'])}
              options={[
                { value: 'week', label: 'Each week (ISO, from Monday)' },
                { value: 'month', label: 'Each calendar month' },
              ]}
              hint={`Periods run in UTC. Now: ${settings.currentPeriod}.`}
            />
          </div>
          <ChoiceCards
            legend="Once the free reads are used"
            value={mode}
            disabled={disabled || !meterOn}
            onChange={setMode}
            options={[
              {
                value: 'hard',
                title: 'The paywall stays',
                description: 'Readers must join or sign in to read on.',
              },
              {
                value: 'soft',
                title: 'The paywall can be closed',
                description: 'Readers see the offer, then may dismiss it and read on, every time.',
              },
            ]}
          />
        </div>
      </Section>

      <Section
        title="Default paywall"
        description="What readers see where a paid post stops. A post can override any of it in its Website panel."
      >
        <GateDesignFields
          draft={design}
          fallback={{}}
          disabled={disabled}
          errors={designErrors}
          onChange={(next) => {
            setSaved(false);
            setDesign((d) => ({ ...d, ...next }));
          }}
        />
      </Section>

      <Section
        title="Coupon in the paywall"
        description="Show one active coupon inside the paywall, so readers see the discount right where they stop."
      >
        <div className="grid gap-3">
          <SelectField
            label="Coupon"
            value={couponId}
            disabled={disabled || couponOff}
            onChange={(e) => {
              setSaved(false);
              setCouponId(e.target.value);
            }}
            options={[
              { value: '', label: 'No coupon' },
              ...activeCoupons.map((c) => ({
                value: c.id,
                label: `${c.code} · ${discountLabel(c)}`,
              })),
            ]}
            hint={
              couponOff
                ? 'Coupons in the paywall are not available for this publication.'
                : activeCoupons.length === 0
                  ? 'Create a coupon first.'
                  : undefined
            }
            error={apiError?.field('gateCouponId')}
          />
          <Link
            to="/memberships/$channelId/coupons"
            params={{ channelId: channel.id }}
            className="text-[13px] text-purple-deep"
          >
            Manage coupons
          </Link>
        </div>
      </Section>

      {isFeatureDisabled(update.error) && (
        <ErrorNotice
          title="This option is off for this publication"
          message={update.error.message}
        />
      )}
      {canEdit ? (
        <SaveRow
          pending={update.isPending}
          saved={saved}
          error={isFeatureDisabled(update.error) ? null : update.error}
        />
      ) : (
        <ReadOnlyNote>
          An editor or admin of this publication changes the paywall and the meter.
        </ReadOnlyNote>
      )}
    </form>
  );
}
