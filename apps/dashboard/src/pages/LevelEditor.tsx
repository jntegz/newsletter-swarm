// The Membership level editor: details, benefits, Founding Level, visibility and trial, and
// prices. A new level sets its first prices here; afterwards prices change through the price
// change dialog (now or on a date, with existing Members kept or moved) so nobody's bill changes
// by surprise. A live preview shows the level on the public plans page.
import {
  MAX_BENEFITS,
  type LevelPrice,
  type MembershipLevel,
  type PriceInterval,
} from '@swarm/domain';
import {
  Button,
  Checkbox,
  Dialog,
  ErrorNotice,
  LoadingRows,
  Pill,
  TextAreaField,
  TextField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import {
  isFeatureDisabled,
  levelQuery,
  useAddPrice,
  useCreateLevel,
  useRetirePrice,
  useUpdateLevel,
} from '../api/money';
import {
  INTERVAL_LABEL,
  emptyPrice,
  levelInput,
  majorValue,
  parseAmount,
  priceChange,
  priceLabel,
  pricesFor,
  cleanBenefits,
  benefitsProblem,
  type LevelDraft,
  type PriceChangeDraft,
  type PriceDraft,
} from '../money/helpers';
import { ChoiceCards, ReadOnlyNote, SaveRow } from '../site/controls';
import { Section } from './common';
import {
  ConnectFirst,
  PlansPreview,
  dayLabel,
  useMemberships,
  type PreviewLevel,
} from './Memberships';

const INTERVALS: PriceInterval[] = ['month', 'year', 'lifetime'];
const INTERVAL_NOUN: Record<PriceInterval, string> = {
  month: 'monthly',
  year: 'yearly',
  lifetime: 'lifetime',
};

/** Remembers which optional features the API said are off, so the form can say so. */
function featureOff(error: unknown, draft: { founding: boolean }) {
  if (!isFeatureDisabled(error)) return { founding: false, pwyw: false };
  const founding = draft.founding && /founding/i.test(error.message);
  return { founding, pwyw: !founding };
}

// ---- Shared fields -------------------------------------------------------------------------

interface DetailsDraft {
  name: string;
  description: string;
  benefits: string[];
  founding: boolean;
  visibility: 'public' | 'hidden';
  trialDays: string;
}

function BenefitsEditor({
  benefits,
  disabled,
  error,
  onChange,
}: {
  benefits: string[];
  disabled: boolean;
  error: string | undefined;
  onChange: (benefits: string[]) => void;
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-[13px] font-semibold">Benefits</legend>
      <p className="text-[12.5px] text-sub">One line each, shown as a list on the plans page.</p>
      {benefits.map((benefit, index) => (
        <div key={index} className="flex items-end gap-2">
          <div className="flex-1">
            <TextField
              label={`Benefit ${index + 1}`}
              value={benefit}
              maxLength={120}
              disabled={disabled}
              onChange={(e) => onChange(benefits.map((b, i) => (i === index ? e.target.value : b)))}
            />
          </div>
          {!disabled && (
            <Button
              variant="quiet"
              size="sm"
              aria-label={`Remove benefit ${index + 1}`}
              onClick={() => onChange(benefits.filter((_, i) => i !== index))}
            >
              Remove
            </Button>
          )}
        </div>
      ))}
      {!disabled && benefits.length < MAX_BENEFITS && (
        <div>
          <Button variant="ghost" size="sm" onClick={() => onChange([...benefits, ''])}>
            Add benefit
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-[12.5px] font-semibold text-danger">
          {error}
        </p>
      )}
    </fieldset>
  );
}

function DetailsFields({
  draft,
  disabled,
  errors,
  foundingOff,
  onChange,
}: {
  draft: DetailsDraft;
  disabled: boolean;
  errors: {
    name?: string | undefined;
    description?: string | undefined;
    benefits?: string | undefined;
    trialDays?: string | undefined;
    founding?: string | undefined;
  };
  foundingOff: boolean;
  onChange: (patch: Partial<DetailsDraft>) => void;
}) {
  return (
    <div className="grid gap-4">
      <TextField
        label="Name"
        required
        maxLength={60}
        value={draft.name}
        disabled={disabled}
        onChange={(e) => onChange({ name: e.target.value })}
        error={errors.name}
        hint="Readers see it on the plans page and their receipts."
      />
      <TextAreaField
        label="Description"
        maxLength={500}
        value={draft.description}
        disabled={disabled}
        onChange={(e) => onChange({ description: e.target.value })}
        error={errors.description}
      />
      <BenefitsEditor
        benefits={draft.benefits}
        disabled={disabled}
        error={errors.benefits}
        onChange={(benefits) => onChange({ benefits })}
      />
      <Checkbox
        label="Founding plan"
        hint={
          foundingOff
            ? 'Founding plans are not available for this publication.'
            : 'For your strongest supporters: one per publication, priced at or above every other plan, shown first.'
        }
        checked={draft.founding}
        disabled={disabled || (foundingOff && !draft.founding)}
        onChange={(founding) => onChange({ founding })}
      />
      {errors.founding && (
        <p role="alert" className="text-[12.5px] font-semibold text-danger">
          {errors.founding}
        </p>
      )}
      <ChoiceCards
        legend="Visibility"
        value={draft.visibility}
        disabled={disabled}
        onChange={(visibility) => onChange({ visibility })}
        options={[
          { value: 'public', title: 'Public', description: 'Listed on the plans page.' },
          {
            value: 'hidden',
            title: 'Hidden',
            description: 'Offered by link only (/subscribe?level=…).',
          },
        ]}
      />
      <div className="max-w-[220px]">
        <TextField
          label="Free trial (days)"
          inputMode="numeric"
          value={draft.trialDays}
          disabled={disabled}
          onChange={(e) => onChange({ trialDays: e.target.value.trim() })}
          error={errors.trialDays}
          hint="0 for no trial. Trials need a card and are once per address, so readers give their email before Checkout; without it they pay from day one."
        />
      </div>
    </div>
  );
}

function PriceFields({
  draft,
  currency,
  disabled,
  pwywOff,
  founding,
  errors,
  onChange,
}: {
  draft: PriceDraft;
  currency: string;
  disabled: boolean;
  pwywOff: boolean;
  founding: boolean;
  errors: { amount?: string | undefined; minAmount?: string | undefined };
  onChange: (patch: Partial<PriceDraft>) => void;
}) {
  const label = INTERVAL_LABEL[draft.interval];
  const code = currency.toUpperCase();
  return (
    <div className="grid gap-3 rounded-card-app border border-line-app p-4">
      <Checkbox
        label={`${label} price`}
        checked={draft.enabled}
        disabled={disabled || (founding && draft.interval === 'lifetime')}
        hint={
          draft.interval === 'lifetime'
            ? founding
              ? 'A founding plan has a monthly or yearly price.'
              : 'Paid once, never renews.'
            : undefined
        }
        onChange={(enabled) => onChange({ enabled })}
      />
      {draft.enabled && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label={`${draft.customAmount ? 'Suggested amount' : 'Amount'} (${code}, ${label.toLowerCase()})`}
              inputMode="decimal"
              value={draft.amount}
              disabled={disabled}
              placeholder="5"
              onChange={(e) => onChange({ amount: e.target.value })}
              error={errors.amount}
            />
            {draft.customAmount && (
              <TextField
                label={`Smallest amount (${code}, ${label.toLowerCase()})`}
                inputMode="decimal"
                value={draft.minAmount}
                disabled={disabled}
                placeholder="3"
                onChange={(e) => onChange({ minAmount: e.target.value })}
                error={errors.minAmount}
              />
            )}
          </div>
          {!founding && (
            <Checkbox
              label="Pay what you want"
              hint={
                pwywOff
                  ? 'Pay what you want is not available for this publication.'
                  : 'Readers choose the amount at checkout, from the smallest amount up.'
              }
              checked={draft.customAmount}
              disabled={disabled || (pwywOff && !draft.customAmount)}
              onChange={(customAmount) => onChange({ customAmount })}
            />
          )}
        </>
      )}
    </div>
  );
}

/** The editor's draft as a preview card. */
function previewOf(
  id: string,
  details: DetailsDraft,
  prices: PreviewLevel['prices'],
): PreviewLevel {
  return {
    id,
    name: details.name.trim(),
    description: details.description.trim() || null,
    benefits: cleanBenefits(details.benefits),
    founding: details.founding,
    visibility: details.visibility,
    trialDays: Number(details.trialDays) || 0,
    prices,
  };
}

// ---- New level -----------------------------------------------------------------------------

export function NewLevelPage() {
  const { channel, payments, canAdmin, canSell } = useMemberships();
  const navigate = useNavigate();
  const create = useCreateLevel(channel.id);
  const [draft, setDraft] = useState<LevelDraft>({
    name: '',
    description: '',
    benefits: [''],
    founding: false,
    visibility: 'public',
    trialDays: '0',
    currency: payments.defaultCurrency ?? 'usd',
    prices: INTERVALS.map(emptyPrice),
  });
  const [submitted, setSubmitted] = useState(false);
  const [off, setOff] = useState({ founding: false, pwyw: false });
  const { input, problems } = levelInput(draft);
  const show = submitted ? problems : { price: {} };
  const apiError = create.error instanceof ApiError ? create.error : null;
  const currency = /^[a-z]{3}$/i.test(draft.currency) ? draft.currency.toLowerCase() : 'usd';

  if (!canSell) return <ConnectFirst what="paid plans" />;
  if (!canAdmin) {
    return <ReadOnlyNote>An admin of this publication creates paid plans.</ReadOnlyNote>;
  }

  const patch = (next: Partial<LevelDraft>) => setDraft((d) => ({ ...d, ...next }));
  const patchPrice = (interval: PriceInterval, next: Partial<PriceDraft>) =>
    setDraft((d) => ({
      ...d,
      prices: d.prices.map((p) => (p.interval === interval ? { ...p, ...next } : p)),
    }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (!input) return;
    create.mutate(input, {
      onSuccess: (level) =>
        void navigate({
          to: '/memberships/$channelId/levels/$levelId',
          params: { channelId: channel.id, levelId: level.id },
        }),
      onError: (error) =>
        setOff((o) => {
          const found = featureOff(error, draft);
          return { founding: o.founding || found.founding, pwyw: o.pwyw || found.pwyw };
        }),
    });
  };

  const preview = previewOf(
    'draft',
    draft,
    draft.prices
      .filter((p) => p.enabled && parseAmount(p.amount, currency) !== null)
      .map((p) => ({
        interval: p.interval,
        amount: parseAmount(p.amount, currency)!,
        currency,
        customAmount: p.customAmount,
        minAmount: p.customAmount ? parseAmount(p.minAmount, currency) : null,
      })),
  );

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
      <form onSubmit={submit} noValidate className="grid gap-5">
        <Section title="New paid plan">
          <DetailsFields
            draft={draft}
            disabled={false}
            foundingOff={off.founding}
            errors={{
              name: show.name ?? apiError?.field('name'),
              description: show.description,
              benefits: show.benefits ?? apiError?.field('benefits'),
              trialDays: show.trialDays,
              founding: apiError?.field('founding'),
            }}
            onChange={patch}
          />
        </Section>
        <Section
          title="Prices"
          description="Give the plan a monthly price, a yearly price, a lifetime price, or any of them."
        >
          <div className="grid gap-3">
            <div className="max-w-[220px]">
              <TextField
                label="Currency"
                value={draft.currency}
                maxLength={3}
                onChange={(e) => patch({ currency: e.target.value.toLowerCase().trim() })}
                error={show.currency ?? apiError?.field('currency')}
                hint="Three letters, like usd or eur."
                // uppercase-allow: a currency code reads in capitals (USD); the value stays lowercase.
                className="font-mono uppercase"
              />
            </div>
            {draft.prices.map((price) => (
              <PriceFields
                key={price.interval}
                draft={price}
                currency={currency}
                disabled={false}
                founding={draft.founding}
                pwywOff={off.pwyw}
                errors={show.price[price.interval] ?? {}}
                onChange={(next) => patchPrice(price.interval, next)}
              />
            ))}
            {(show.prices ?? apiError?.field('prices')) && (
              <p role="alert" className="text-[12.5px] font-semibold text-danger">
                {show.prices ?? apiError?.field('prices')}
              </p>
            )}
          </div>
        </Section>
        {isFeatureDisabled(create.error) && (
          <ErrorNotice
            title="This option is off for this publication"
            message={create.error.message}
          />
        )}
        <div className="flex flex-wrap items-center gap-3">
          <SaveRow
            label="Create paid plan"
            pending={create.isPending}
            saved={false}
            error={isFeatureDisabled(create.error) ? null : create.error}
          />
          <Link
            to="/memberships/$channelId/levels"
            params={{ channelId: channel.id }}
            className="btn-ghost"
          >
            Cancel
          </Link>
        </div>
      </form>
      <PlansPreview levels={[preview]} highlight="draft" />
    </div>
  );
}

// ---- Edit level ----------------------------------------------------------------------------

export function EditLevelPage({ levelId }: { levelId: string }) {
  const { channel } = useMemberships();
  const level = useQuery(levelQuery(channel.id, levelId));
  if (level.isPending) return <LoadingRows label="Loading the paid plan" rows={4} />;
  if (level.error) {
    return (
      <ErrorNotice
        title="Paid plan not available"
        message={level.error.message}
        action={
          <Link
            to="/memberships/$channelId/levels"
            params={{ channelId: channel.id }}
            className="btn-ghost"
          >
            Back to paid plans
          </Link>
        }
      />
    );
  }
  return <LevelEditor key={level.data.id} level={level.data} />;
}

const detailsOf = (level: MembershipLevel): DetailsDraft => ({
  name: level.name,
  description: level.description ?? '',
  benefits: level.benefits.length ? level.benefits : [''],
  founding: level.founding,
  visibility: level.visibility,
  trialDays: String(level.trialDays),
});

function LevelEditor({ level }: { level: MembershipLevel }) {
  const { channel, canAdmin } = useMemberships();
  const update = useUpdateLevel(channel.id, level.id);
  const [draft, setDraft] = useState(detailsOf(level));
  const [saved, setSaved] = useState(false);
  const [foundingOff, setFoundingOff] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const apiError = update.error instanceof ApiError ? update.error : null;
  const archived = level.status === 'archived';
  const disabled = !canAdmin || archived;

  const name = draft.name.trim();
  const trial = Number(draft.trialDays);
  const problems = {
    name: !name
      ? 'Name the plan.'
      : name.length > 60
        ? 'Keep the name under 60 characters.'
        : undefined,
    benefits: benefitsProblem(draft.benefits) ?? undefined,
    trialDays: !/^\d{1,3}$/.test(draft.trialDays) || trial > 365 ? 'Use 0 to 365 days.' : undefined,
    description:
      draft.description.trim().length > 500
        ? 'Keep the description under 500 characters.'
        : undefined,
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    if (Object.values(problems).some(Boolean)) return;
    const input: Parameters<typeof update.mutate>[0] = {};
    const before = detailsOf(level);
    if (name !== level.name) input.name = name;
    if (draft.description.trim() !== before.description) {
      input.description = draft.description.trim() || null;
    }
    const benefits = cleanBenefits(draft.benefits);
    if (benefits.join('\n') !== level.benefits.join('\n')) input.benefits = benefits;
    if (draft.founding !== level.founding) input.founding = draft.founding;
    if (draft.visibility !== level.visibility) input.visibility = draft.visibility;
    if (trial !== level.trialDays) input.trialDays = trial;
    if (Object.keys(input).length === 0) {
      setSaved(true);
      return;
    }
    update.mutate(input, {
      onSuccess: () => setSaved(true),
      onError: (error) => {
        if (featureOff(error, draft).founding) setFoundingOff(true);
      },
    });
  };

  const preview = previewOf(
    level.id,
    draft,
    level.prices.filter((p) => p.status === 'active'),
  );

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
      <div className="grid gap-5">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/memberships/$channelId/levels"
            params={{ channelId: channel.id }}
            className="text-[13px] text-purple-deep"
          >
            All paid plans
          </Link>
          {archived && <Pill>Archived</Pill>}
          {level.founding && <Pill tone="brand">Founding plan</Pill>}
        </div>
        <form onSubmit={save} noValidate>
          <Section
            title={level.name}
            description={`${level.memberCount} subscribers hold this plan now.`}
          >
            <div className="grid gap-4">
              <DetailsFields
                draft={draft}
                disabled={disabled}
                foundingOff={foundingOff}
                errors={{
                  name: problems.name ?? apiError?.field('name'),
                  description: problems.description,
                  benefits: problems.benefits ?? apiError?.field('benefits'),
                  trialDays: problems.trialDays ?? apiError?.field('trialDays'),
                  founding: apiError?.field('founding'),
                }}
                onChange={(next) => {
                  setSaved(false);
                  setDraft((d) => ({ ...d, ...next }));
                }}
              />
              {isFeatureDisabled(update.error) && (
                <ErrorNotice
                  title="This option is off for this publication"
                  message={update.error.message}
                />
              )}
              {!canAdmin && (
                <ReadOnlyNote>An admin of this publication changes paid plans.</ReadOnlyNote>
              )}
              {canAdmin && !archived && (
                <SaveRow
                  pending={update.isPending}
                  saved={saved}
                  error={isFeatureDisabled(update.error) ? null : update.error}
                />
              )}
            </div>
          </Section>
        </form>

        <PricesSection level={level} disabled={disabled} />

        {canAdmin && (
          <Section
            title={archived ? 'Restore this plan' : 'Archive this plan'}
            description={
              archived
                ? 'It can be bought again from the plans page.'
                : 'Nobody can buy it any more. Subscribers who hold it keep their access and their billing.'
            }
          >
            {archived ? (
              <Button
                variant="ghost"
                loading={update.isPending}
                onClick={() => update.mutate({ status: 'active' })}
              >
                Restore plan
              </Button>
            ) : (
              <Button variant="danger" onClick={() => setConfirmArchive(true)}>
                Archive plan
              </Button>
            )}
          </Section>
        )}
      </div>
      <PlansPreview levels={[preview]} highlight={level.id} />

      <Dialog
        open={confirmArchive}
        onClose={() => setConfirmArchive(false)}
        title={`Archive ${level.name}?`}
        description="It leaves the plans page and checkout. Subscribers who hold it keep it, and you can restore it later."
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirmArchive(false)}>
              Keep selling it
            </Button>
            <Button
              variant="danger"
              loading={update.isPending}
              onClick={() =>
                update.mutate({ status: 'archived' }, { onSuccess: () => setConfirmArchive(false) })
              }
            >
              Archive plan
            </Button>
          </>
        }
      >
        {update.error && <ErrorNotice message={update.error.message} />}
      </Dialog>
    </div>
  );
}

// ---- Prices --------------------------------------------------------------------------------

function PricesSection({ level, disabled }: { level: MembershipLevel; disabled: boolean }) {
  const { channel } = useMemberships();
  const retire = useRetirePrice(channel.id, level.id);
  const [changing, setChanging] = useState<{
    interval: PriceInterval;
    from: LevelPrice | null;
  } | null>(null);
  const [retiring, setRetiring] = useState<LevelPrice | null>(null);
  const activeCount = level.prices.filter((p) => p.status === 'active').length;
  const retired = level.prices.filter((p) => p.status === 'retired');
  const currency = level.currency ?? level.prices[0]?.currency ?? 'usd';

  return (
    <Section
      title="Prices"
      description="A new price applies to new checkouts. Existing subscribers keep what they pay unless you schedule a change that moves them."
    >
      <ul className="grid gap-2" aria-label="Prices">
        {INTERVALS.filter((i) => !(level.founding && i === 'lifetime')).map((interval) => {
          const { active, scheduled } = pricesFor(level.prices, interval);
          return (
            <li
              key={interval}
              className="grid gap-2 rounded-card-app border border-line-app px-4 py-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-[13px] text-sub">{INTERVAL_LABEL[interval]}</p>
                  <p className="tabular text-[15px] font-semibold">
                    {active ? priceLabel(active) : 'Not offered'}
                  </p>
                </div>
                {!disabled && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setChanging({ interval, from: active })}
                    >
                      {active ? 'Change price' : `Add ${INTERVAL_NOUN[interval]} price`}
                    </Button>
                    {active && (
                      <Button
                        variant="quiet"
                        size="sm"
                        disabled={activeCount <= 1}
                        title={activeCount <= 1 ? 'A plan keeps at least one price.' : undefined}
                        onClick={() => setRetiring(active)}
                      >
                        Stop offering
                      </Button>
                    )}
                  </div>
                )}
              </div>
              {scheduled && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-card-app bg-surface-alt px-3 py-2 text-[13px]">
                  <p>
                    <Pill tone="scheduled">Scheduled</Pill>{' '}
                    <span className="tabular font-semibold">{priceLabel(scheduled)}</span> from{' '}
                    {dayLabel(scheduled.effectiveAt)} ·{' '}
                    {scheduled.existing === 'migrate'
                      ? 'existing subscribers move at renewal'
                      : 'existing subscribers keep their price'}
                  </p>
                  {!disabled && (
                    <Button
                      variant="quiet"
                      size="sm"
                      loading={retire.isPending && retire.variables === scheduled.id}
                      onClick={() => retire.mutate(scheduled.id)}
                    >
                      Cancel scheduled change
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {retire.error && !retiring && (
        <div className="mt-3">
          <ErrorNotice message={retire.error.message} />
        </div>
      )}
      {retired.length > 0 && (
        <details className="mt-3 text-[13px]">
          <summary className="cursor-pointer font-semibold text-sub">
            Earlier prices ({retired.length})
          </summary>
          <ul className="mt-2 grid gap-1 text-sub">
            {retired.map((p) => (
              <li key={p.id} className="tabular">
                {priceLabel(p)} · retired {dayLabel(p.retiredAt)} · subscribers who bought it keep
                it
              </li>
            ))}
          </ul>
        </details>
      )}

      {changing && (
        <PriceChangeDialog
          level={level}
          interval={changing.interval}
          from={changing.from}
          currency={currency}
          onClose={() => setChanging(null)}
        />
      )}
      <Dialog
        open={retiring !== null}
        onClose={() => setRetiring(null)}
        title={`Stop offering the ${retiring ? INTERVAL_NOUN[retiring.interval] : ''} price?`}
        description="New readers can't choose it any more. Subscribers already on it keep paying it."
        actions={
          <>
            <Button variant="ghost" onClick={() => setRetiring(null)}>
              Keep offering it
            </Button>
            <Button
              variant="danger"
              loading={retire.isPending}
              onClick={() =>
                retiring && retire.mutate(retiring.id, { onSuccess: () => setRetiring(null) })
              }
            >
              Stop offering
            </Button>
          </>
        }
      >
        {retire.error && <ErrorNotice message={retire.error.message} />}
      </Dialog>
    </Section>
  );
}

const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

function PriceChangeDialog({
  level,
  interval,
  from,
  currency,
  onClose,
}: {
  level: MembershipLevel;
  interval: PriceInterval;
  from: LevelPrice | null;
  currency: string;
  onClose: () => void;
}) {
  const { channel } = useMemberships();
  const add = useAddPrice(channel.id, level.id);
  const [draft, setDraft] = useState<PriceChangeDraft>({
    amount: from ? majorValue(from.amount, currency) : '',
    customAmount: from?.customAmount ?? false,
    minAmount:
      from?.minAmount !== null && from?.minAmount !== undefined
        ? majorValue(from.minAmount, currency)
        : '',
    when: 'now',
    day: tomorrow(),
    existing: 'grandfather',
  });
  const [submitted, setSubmitted] = useState(false);
  const { input, problems } = priceChange(interval, draft, currency);
  const shown = submitted ? problems : {};
  const apiError = add.error instanceof ApiError ? add.error : null;
  const code = currency.toUpperCase();
  const noun = INTERVAL_NOUN[interval];
  const canMigrate = draft.when === 'scheduled' && interval !== 'lifetime' && from !== null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (!input) return;
    add.mutate(input, { onSuccess: onClose });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={from ? `Change the ${noun} price` : `Add a ${noun} price`}
      description={from ? `Now ${priceLabel(from)}.` : `${level.name} has no ${noun} price yet.`}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="price-change" loading={add.isPending}>
            {draft.when === 'scheduled' ? 'Schedule change' : from ? 'Change price' : 'Add price'}
          </Button>
        </>
      }
    >
      <form id="price-change" onSubmit={submit} noValidate className="grid gap-4">
        <TextField
          label={`${draft.customAmount ? 'Suggested amount' : 'New amount'} (${code})`}
          inputMode="decimal"
          value={draft.amount}
          onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
          error={shown.amount ?? apiError?.field('amount')}
        />
        {draft.customAmount && (
          <TextField
            label={`Smallest amount (${code})`}
            inputMode="decimal"
            value={draft.minAmount}
            onChange={(e) => setDraft({ ...draft, minAmount: e.target.value })}
            error={shown.minAmount ?? apiError?.field('minAmount')}
          />
        )}
        {from && (
          <ChoiceCards
            legend="When"
            value={draft.when}
            onChange={(when) => setDraft({ ...draft, when })}
            options={[
              { value: 'now', title: 'Now', description: 'New checkouts use it straight away.' },
              { value: 'scheduled', title: 'On a date', description: 'Announce it first.' },
            ]}
          />
        )}
        {draft.when === 'scheduled' && (
          <TextField
            label="Takes effect on"
            type="date"
            min={tomorrow()}
            value={draft.day}
            onChange={(e) => setDraft({ ...draft, day: e.target.value })}
            error={shown.day ?? apiError?.field('effectiveAt')}
            hint="At midnight UTC. Replaces any change already scheduled for this price."
          />
        )}
        {from && (
          <ChoiceCards
            legend="Subscribers already paying"
            value={canMigrate ? draft.existing : 'grandfather'}
            onChange={(existing) => setDraft({ ...draft, existing })}
            disabled={!canMigrate}
            options={[
              {
                value: 'grandfather',
                title: 'Keep their price',
                description: 'Only new subscribers pay the new amount.',
              },
              {
                value: 'migrate',
                title: 'Move them',
                description: canMigrate
                  ? 'They pay the new amount from their next renewal.'
                  : interval === 'lifetime'
                    ? 'Lifetime purchases never renew.'
                    : 'Schedule the change on a date to move them.',
              },
            ]}
          />
        )}
        {apiError && !apiError.details.length && <ErrorNotice message={apiError.message} />}
      </form>
    </Dialog>
  );
}
