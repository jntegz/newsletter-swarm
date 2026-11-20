// Partners: publications recommended by hand. Sponsors: the sponsor page, its placements and the
// bookings that come in. Both are direct deals; nothing here charges or matches anyone.
import type { Channel, PartnerPick, SponsorBooking, SponsorSettings } from '@swarm/domain';
import {
  Button,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  Pill,
  TextField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  partnerPicksQuery,
  sponsorBookingsQuery,
  sponsorSettingsQuery,
  useDeletePartnerPick,
  useSavePartnerPick,
  useSaveSponsorSettings,
  useSendReportLink,
  useUpdateBooking,
} from '../api/partners';
import { majorValue, parseAmount } from '../money/helpers';
import { Section, WithChannel } from './common';
import { BOOKING_STATUS_LABEL, clickCount } from './partners-helpers';

const RANK = { viewer: 0, author: 1, editor: 2, admin: 3, owner: 4 } as const;
type WithRole = Channel & { role: keyof typeof RANK };

export function PartnersPage({ channelId }: { channelId: string | undefined }) {
  return (
    <WithChannel channelId={channelId}>{(channel) => <Partners channel={channel} />}</WithChannel>
  );
}

export function SponsorsPage({ channelId }: { channelId: string | undefined }) {
  return (
    <WithChannel channelId={channelId}>{(channel) => <Sponsors channel={channel} />}</WithChannel>
  );
}

function Partners({ channel }: { channel: WithRole }) {
  const picks = useQuery(partnerPicksQuery(channel.id));
  const save = useSavePartnerPick(channel.id);
  const remove = useDeletePartnerPick(channel.id);
  const canEdit = RANK[channel.role] >= RANK.editor;
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');

  const add = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(
      { create: { name, url, description } },
      {
        onSuccess: () => {
          setName('');
          setUrl('');
          setDescription('');
        },
      },
    );
  };

  const toggle = (pick: PartnerPick, field: 'onSite' | 'onSignup', label: string) => (
    <label className="flex items-center gap-2 text-[13px]">
      <input
        type="checkbox"
        className="size-4 accent-purple"
        disabled={!canEdit || save.isPending}
        checked={pick[field]}
        onChange={(e) => save.mutate({ id: pick.id, patch: { [field]: e.target.checked } })}
      />
      {label}
    </label>
  );

  return (
    <div className="grid gap-5">
      <header>
        <h1 className="page-title">Partners</h1>
        <p className="mt-1 text-[14px] text-sub">
          Recommend publications you like, after someone subscribes and on your website. You choose
          them yourself and agree any swap with them directly.
        </p>
      </header>
      {canEdit && (
        <Section title="Recommend a publication">
          <form className="grid gap-3" onSubmit={add}>
            <TextField
              label="Name"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <TextField
              label="Web address"
              type="url"
              required
              placeholder="https://"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <TextField
              label="Why you recommend it"
              maxLength={280}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            {save.error && <ErrorNotice message={save.error.message} />}
            <Button type="submit" className="w-fit" disabled={save.isPending}>
              Add
            </Button>
          </form>
        </Section>
      )}
      <Section title="Your recommendations">
        {picks.isPending && <LoadingRows label="Loading recommendations" rows={2} />}
        {picks.error && <ErrorNotice message={picks.error.message} />}
        {picks.data?.length === 0 && (
          <EmptyState title="None yet">
            To show them after signup, add a “Recommended publications” step to a signup journey.
          </EmptyState>
        )}
        <ul className="grid gap-2">
          {picks.data?.map((pick) => (
            <li key={pick.id} className="grid gap-2 rounded-[10px] border border-line px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0">
                  <span className="block font-semibold">{pick.name}</span>
                  <span className="block text-[13px] break-all text-sub">{pick.url}</span>
                </span>
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(pick.id)}
                  >
                    Remove
                  </Button>
                )}
              </div>
              {pick.description && <p className="text-[13.5px]">{pick.description}</p>}
              <div className="flex flex-wrap items-center gap-4">
                {toggle(pick, 'onSite', 'On your website')}
                {toggle(pick, 'onSignup', 'After signup')}
                <span className="tabular text-[13px] text-sub">
                  {clickCount(pick.siteClicks + pick.signupClicks)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function Sponsors({ channel }: { channel: WithRole }) {
  const settings = useQuery(sponsorSettingsQuery(channel.id));
  const canAdmin = RANK[channel.role] >= RANK.admin;
  return (
    <div className="grid gap-5">
      <header>
        <h1 className="page-title">Sponsors</h1>
        <p className="mt-1 text-[14px] text-sub">
          Sponsors book from a page on your website. You accept what you want to run, add it to a
          post, and bill them yourself. Swarm takes nothing and handles no money here.
        </p>
      </header>
      {settings.isPending && <LoadingRows label="Loading" rows={3} />}
      {settings.error && <ErrorNotice message={settings.error.message} />}
      {settings.data && canAdmin && (
        <SponsorSettingsForm
          key={settings.dataUpdatedAt}
          channelId={channel.id}
          settings={settings.data}
        />
      )}
      {RANK[channel.role] >= RANK.editor && <Bookings channelId={channel.id} canAdmin={canAdmin} />}
    </div>
  );
}

interface SlotDraft {
  id?: string;
  name: string;
  description: string;
  amount: string;
  currency: string;
}

function SponsorSettingsForm({
  channelId,
  settings,
}: {
  channelId: string;
  settings: SponsorSettings;
}) {
  const save = useSaveSponsorSettings(channelId);
  const [accepting, setAccepting] = useState(settings.accepting);
  const [headline, setHeadline] = useState(settings.headline);
  const [pitch, setPitch] = useState(settings.pitch);
  const [problem, setProblem] = useState<string | null>(null);
  const [slots, setSlots] = useState<SlotDraft[]>(
    settings.slots.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      amount: majorValue(s.amount, s.currency),
      currency: s.currency,
    })),
  );
  const change = (i: number, patch: Partial<SlotDraft>) =>
    setSlots((list) => list.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = [];
    for (const slot of slots) {
      const amount = parseAmount(slot.amount || '0', slot.currency);
      if (amount === null) {
        setProblem(`Enter a price for “${slot.name || 'this placement'}”.`);
        return;
      }
      parsed.push({
        ...(slot.id ? { id: slot.id } : {}),
        name: slot.name,
        description: slot.description,
        amount,
        currency: slot.currency,
      });
    }
    setProblem(null);
    save.mutate({ accepting, headline, pitch, slots: parsed });
  };

  return (
    <Section title="Your sponsor page" description={settings.url}>
      <form className="grid gap-3" onSubmit={submit}>
        <label className="flex items-center gap-2.5 text-[13.5px]">
          <input
            type="checkbox"
            className="size-4 accent-purple"
            checked={accepting}
            onChange={(e) => setAccepting(e.target.checked)}
          />
          Take bookings
        </label>
        <TextField
          label="Headline"
          maxLength={120}
          value={headline}
          onChange={(e) => setHeadline(e.target.value)}
        />
        <label className="grid gap-1 text-[13.5px] font-medium">
          What sponsors should know
          <textarea
            className="line-input min-h-24 py-2 font-normal"
            maxLength={2000}
            value={pitch}
            onChange={(e) => setPitch(e.target.value)}
          />
        </label>
        <fieldset className="grid gap-2">
          <legend className="text-[13.5px] font-medium">Placements</legend>
          {slots.map((slot, i) => (
            <div key={slot.id ?? i} className="flex flex-wrap items-end gap-2">
              <TextField
                label="Placement"
                maxLength={80}
                value={slot.name}
                onChange={(e) => change(i, { name: e.target.value })}
              />
              <TextField
                label="Asking price"
                inputMode="decimal"
                value={slot.amount}
                onChange={(e) => change(i, { amount: e.target.value })}
              />
              <TextField
                label="Currency"
                maxLength={3}
                value={slot.currency}
                onChange={(e) => change(i, { currency: e.target.value.toLowerCase() })}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSlots((list) => list.filter((_, j) => j !== i))}
              >
                Remove
              </Button>
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="w-fit"
            onClick={() =>
              setSlots((list) => [
                ...list,
                { name: '', description: '', amount: '', currency: 'usd' },
              ])
            }
          >
            Add a placement
          </Button>
        </fieldset>
        {problem && <ErrorNotice message={problem} />}
        {save.error && <ErrorNotice message={save.error.message} />}
        <Button type="submit" className="w-fit" disabled={save.isPending}>
          Save
        </Button>
      </form>
    </Section>
  );
}

function Bookings({ channelId, canAdmin }: { channelId: string; canAdmin: boolean }) {
  const bookings = useQuery(sponsorBookingsQuery(channelId));
  const update = useUpdateBooking(channelId);
  const sendLink = useSendReportLink(channelId);
  const act = (booking: SponsorBooking, status: SponsorBooking['status']) =>
    update.mutate({ id: booking.id, patch: { status } });
  return (
    <Section title="Bookings">
      {bookings.isPending && <LoadingRows label="Loading bookings" rows={2} />}
      {bookings.error && <ErrorNotice message={bookings.error.message} />}
      {update.error && <ErrorNotice message={update.error.message} />}
      {sendLink.error && <ErrorNotice message={sendLink.error.message} />}
      {bookings.data?.items.length === 0 && (
        <EmptyState title="No bookings yet">
          Requests from your sponsor page appear here, and owners and admins get an email.
        </EmptyState>
      )}
      <ul className="grid gap-2">
        {bookings.data?.items.map((booking) => (
          <li key={booking.id} className="grid gap-2 rounded-[10px] border border-line px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0">
                <span className="block font-semibold">{booking.sponsorName}</span>
                <span className="block text-[13px] break-all text-sub">
                  {booking.sponsorEmail} · {booking.slotName} · {booking.runOn}
                </span>
              </span>
              <Pill tone={booking.status === 'accepted' ? 'success' : 'neutral'}>
                {BOOKING_STATUS_LABEL[booking.status]}
              </Pill>
            </div>
            <p className="text-[13.5px]">
              <strong>{booking.adTitle}</strong>
              {booking.adBody && ` ${booking.adBody}`}
            </p>
            <p className="text-[13px] break-all text-sub">Leads to {booking.adUrl}</p>
            {booking.status === 'accepted' && (
              <p className="text-[13px] text-sub">
                {clickCount(booking.clicks)} ·{' '}
                <a className="underline" href={booking.reportUrl} target="_blank" rel="noreferrer">
                  Report to share with the sponsor
                </a>
              </p>
            )}
            {canAdmin && (
              <div className="flex flex-wrap items-center gap-2">
                {booking.status === 'requested' && (
                  <>
                    <Button
                      size="sm"
                      disabled={update.isPending}
                      onClick={() => act(booking, 'accepted')}
                    >
                      Accept
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={update.isPending}
                      onClick={() => act(booking, 'declined')}
                    >
                      Decline
                    </Button>
                  </>
                )}
                {booking.status === 'accepted' && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={update.isPending}
                      onClick={() => act(booking, 'canceled')}
                    >
                      Cancel
                    </Button>
                    <label className="flex items-center gap-2 text-[13px]">
                      <input
                        type="checkbox"
                        className="size-4 accent-purple"
                        checked={booking.paid}
                        disabled={update.isPending}
                        onChange={(e) =>
                          update.mutate({ id: booking.id, patch: { paid: e.target.checked } })
                        }
                      />
                      They’ve paid me
                    </label>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={sendLink.isPending}
                      onClick={() => sendLink.mutate(booking.id)}
                    >
                      Send a new report link
                    </Button>
                    {sendLink.isSuccess && sendLink.variables === booking.id && (
                      <span role="status" className="text-[13px] text-sub">
                        Sent to {booking.sponsorEmail}. It works for 90 days.
                      </span>
                    )}
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}
