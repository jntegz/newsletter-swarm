// Memberships → Coupons: codes readers type at checkout. A coupon's discount can't change once
// made (Stripe coupons are immutable), so the page offers create and archive only.
import type { Coupon } from '@swarm/domain';
import {
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  Pill,
  SelectField,
  TextField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import {
  couponsQuery,
  gateSettingsQuery,
  levelsQuery,
  useCreateCoupon,
  useUpdateCoupon,
} from '../api/money';
import { couponInput, discountLabel, durationLabel, type CouponDraft } from '../money/helpers';
import { ChoiceCards, ReadOnlyNote } from '../site/controls';
import { Section, numberFormat } from './common';
import { ConnectFirst, dayLabel, useMemberships } from './Memberships';

export function CouponsPage() {
  const { channel, canAdmin, canSell } = useMemberships();
  const coupons = useQuery(couponsQuery(channel.id));
  const levels = useQuery(levelsQuery(channel.id));
  const gate = useQuery(gateSettingsQuery(channel.id));
  const update = useUpdateCoupon(channel.id);
  const [showArchived, setShowArchived] = useState(false);
  const [archiving, setArchiving] = useState<Coupon | null>(null);
  const levelName = (id: string) =>
    levels.data?.items.find((l) => l.id === id)?.name ?? 'A paid plan';
  const list = (coupons.data ?? []).filter((c) => showArchived || c.status === 'active');
  const gateCouponId = gate.data?.gateCouponId ?? null;

  return (
    <div className="grid gap-5">
      {!canSell && <ConnectFirst what="coupons" />}
      {canAdmin && canSell && <NewCoupon />}
      <Section
        title="Coupons"
        description="Readers type the code at checkout. The coupon shown in the paywall is offered to everyone who hits it."
        action={
          <Link
            to="/memberships/$channelId/gates"
            params={{ channelId: channel.id }}
            className="btn-ghost btn-sm"
          >
            Paywall coupon
          </Link>
        }
      >
        {coupons.isPending && <LoadingRows label="Loading coupons" rows={3} />}
        {coupons.error && <ErrorNotice message={coupons.error.message} />}
        {coupons.data && coupons.data.length === 0 && (
          <EmptyState title="No coupons yet">
            {canAdmin
              ? 'Create a code above to offer a discount for launch week, a partner or a paywall.'
              : 'An admin of this publication creates coupons.'}
          </EmptyState>
        )}
        {coupons.data && coupons.data.length > 0 && (
          <div className="grid gap-3">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-[13px]">
                <caption className="sr-only">Coupons</caption>
                <thead>
                  <tr className="table-head">
                    <th scope="col" className="py-2 pr-3 font-semibold">
                      Code
                    </th>
                    <th scope="col" className="px-3 py-2 font-semibold">
                      Discount
                    </th>
                    <th scope="col" className="px-3 py-2 font-semibold">
                      Paid plans
                    </th>
                    <th scope="col" className="px-3 py-2 font-semibold">
                      Limits
                    </th>
                    <th scope="col" className="px-3 py-2 font-semibold">
                      Status
                    </th>
                    <th scope="col" className="py-2 pl-3">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((coupon) => (
                    <tr key={coupon.id} className="border-t border-line align-top">
                      <td className="py-2.5 pr-3">
                        <span className="font-mono font-semibold">{coupon.code}</span>
                        {coupon.name && <span className="block text-sub">{coupon.name}</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="tabular font-semibold">{discountLabel(coupon)}</span>
                        <span className="block text-sub">{durationLabel(coupon)}</span>
                      </td>
                      <td className="px-3 py-2.5 text-sub">
                        {coupon.levelIds.length === 0
                          ? 'Every paid plan'
                          : coupon.levelIds.map(levelName).join(', ')}
                      </td>
                      <td className="tabular px-3 py-2.5 text-sub">
                        {coupon.maxRedemptions
                          ? `${numberFormat.format(coupon.maxRedemptions)} uses`
                          : 'No use limit'}
                        <span className="block">
                          {coupon.expiresAt ? `Until ${dayLabel(coupon.expiresAt)}` : 'No end date'}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="flex flex-wrap gap-1">
                          <Pill tone={coupon.status === 'active' ? 'success' : 'neutral'}>
                            {coupon.status === 'active' ? 'Active' : 'Archived'}
                          </Pill>
                          {coupon.id === gateCouponId && (
                            <Pill tone="brand">Shown in the paywall</Pill>
                          )}
                        </span>
                      </td>
                      <td className="py-2.5 pl-3 text-right">
                        {canAdmin && coupon.status === 'active' && (
                          <Button
                            variant="quiet"
                            size="sm"
                            aria-label={`Archive ${coupon.code}`}
                            onClick={() => setArchiving(coupon)}
                          >
                            Archive
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {list.length === 0 && <p className="text-[13px] text-sub">Every coupon is archived.</p>}
            <Checkbox
              label="Show archived coupons"
              checked={showArchived}
              onChange={setShowArchived}
            />
          </div>
        )}
        {!canAdmin && coupons.data && coupons.data.length > 0 && (
          <div className="mt-3">
            <ReadOnlyNote>An admin of this publication creates and archives coupons.</ReadOnlyNote>
          </div>
        )}
      </Section>

      <Dialog
        open={archiving !== null}
        onClose={() => setArchiving(null)}
        title={`Archive ${archiving?.code ?? 'this coupon'}?`}
        description={
          archiving?.id === gateCouponId
            ? 'The code stops working at checkout and leaves the paywall. Discounts already running keep going.'
            : 'The code stops working at checkout. Discounts already running keep going.'
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => setArchiving(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={update.isPending}
              onClick={() =>
                archiving &&
                update.mutate(
                  { id: archiving.id, status: 'archived' },
                  { onSuccess: () => setArchiving(null) },
                )
              }
            >
              Archive coupon
            </Button>
          </>
        }
      >
        {update.error && <ErrorNotice message={update.error.message} />}
      </Dialog>
    </div>
  );
}

function NewCoupon() {
  const { channel, payments } = useMemberships();
  const levels = useQuery(levelsQuery(channel.id));
  const create = useCreateCoupon(channel.id);
  const blank = (): CouponDraft => ({
    code: '',
    name: '',
    kind: 'percent',
    value: '',
    currency: payments.defaultCurrency ?? 'usd',
    duration: 'once',
    months: '3',
    maxRedemptions: '',
    expires: '',
    levelIds: [],
  });
  const [draft, setDraft] = useState<CouponDraft>(blank);
  const [submitted, setSubmitted] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const { input, problems } = couponInput(draft);
  const shown = submitted ? problems : {};
  const apiError = create.error instanceof ApiError ? create.error : null;
  const patch = (next: Partial<CouponDraft>) => {
    setCreated(null);
    setDraft((d) => ({ ...d, ...next }));
  };
  const today = new Date().toISOString().slice(0, 10);
  const active = levels.data?.items.filter((l) => l.status === 'active') ?? [];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (!input) return;
    create.mutate(input, {
      onSuccess: (coupon) => {
        setCreated(coupon.code);
        setSubmitted(false);
        setDraft(blank());
      },
    });
  };

  return (
    <form onSubmit={submit} noValidate>
      <Section
        title="New coupon"
        description="The discount can't be changed later; archive the coupon and make another."
      >
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Code"
              required
              maxLength={40}
              value={draft.code}
              onChange={(e) => patch({ code: e.target.value.toUpperCase().replace(/\s/g, '') })}
              error={shown.code ?? apiError?.field('code')}
              hint="3 to 40 letters and digits, like LAUNCH20."
              className="font-mono"
            />
            <TextField
              label="Name (optional)"
              maxLength={60}
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
              error={shown.name}
              hint="For your team; readers see the code."
            />
          </div>
          <ChoiceCards
            legend="Discount"
            value={draft.kind}
            onChange={(kind) => patch({ kind })}
            options={[
              { value: 'percent', title: 'A percentage', description: 'Like 20% off.' },
              { value: 'amount', title: 'An amount', description: 'Like 5 off, in one currency.' },
            ]}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label={
                draft.kind === 'percent'
                  ? 'Percent off'
                  : `Amount off (${draft.currency.toUpperCase()})`
              }
              inputMode={draft.kind === 'percent' ? 'numeric' : 'decimal'}
              value={draft.value}
              onChange={(e) => patch({ value: e.target.value })}
              error={shown.value ?? apiError?.field('percentOff') ?? apiError?.field('amountOff')}
            />
            {draft.kind === 'amount' && (
              <TextField
                label="Currency"
                maxLength={3}
                value={draft.currency}
                onChange={(e) => patch({ currency: e.target.value.toLowerCase().trim() })}
                error={shown.currency ?? apiError?.field('currency')}
                // uppercase-allow: a currency code reads in capitals (USD); the value stays lowercase.
                className="font-mono uppercase"
              />
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label="Applies to"
              value={draft.duration}
              onChange={(e) => patch({ duration: e.target.value as CouponDraft['duration'] })}
              options={[
                { value: 'once', label: 'The first payment' },
                { value: 'repeating', label: 'A number of months' },
                { value: 'forever', label: 'Every payment' },
              ]}
            />
            {draft.duration === 'repeating' && (
              <TextField
                label="Months"
                inputMode="numeric"
                value={draft.months}
                onChange={(e) => patch({ months: e.target.value })}
                error={shown.months ?? apiError?.field('durationMonths')}
              />
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Most uses (optional)"
              inputMode="numeric"
              value={draft.maxRedemptions}
              onChange={(e) => patch({ maxRedemptions: e.target.value })}
              error={shown.maxRedemptions ?? apiError?.field('maxRedemptions')}
            />
            <TextField
              label="Works until (optional)"
              type="date"
              min={today}
              value={draft.expires}
              onChange={(e) => patch({ expires: e.target.value })}
              error={shown.expires ?? apiError?.field('expiresAt')}
            />
          </div>
          {active.length > 0 && (
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-[13px] font-semibold">Paid plans</legend>
              <p className="text-[12.5px] text-sub">Leave all unticked for every paid plan.</p>
              {active.map((level) => (
                <Checkbox
                  key={level.id}
                  label={level.name}
                  checked={draft.levelIds.includes(level.id)}
                  onChange={(checked) =>
                    patch({
                      levelIds: checked
                        ? [...draft.levelIds, level.id]
                        : draft.levelIds.filter((id) => id !== level.id),
                    })
                  }
                />
              ))}
            </fieldset>
          )}
          {apiError && !apiError.details.length && <ErrorNotice message={apiError.message} />}
          <div className="flex items-center gap-3">
            <Button type="submit" loading={create.isPending}>
              Create coupon
            </Button>
            <p role="status" className="text-[13px] text-success">
              {created ? `Coupon ${created} created.` : ''}
            </p>
          </div>
        </div>
      </Section>
    </form>
  );
}
