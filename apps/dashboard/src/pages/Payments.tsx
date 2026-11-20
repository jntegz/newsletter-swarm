// Settings → Payments: connect the Channel's own Stripe account (Connect Standard, 0% platform
// take), see whether it can take charges and pay out, Stripe Tax and the grace period for failed
// payments. The Connect callback returns here with ?connected=1 or ?error=<code>.
import {
  MAX_GRACE_DAYS,
  type Channel,
  type ConnectCallbackError,
  type SeatRole,
} from '@swarm/domain';
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
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import {
  paymentsQuery,
  paypalQuery,
  useConnectPayPal,
  useDisconnectPayPal,
  useConnectStripe,
  useConnectStripeKey,
  useDisconnectStripe,
  useUpdatePayments,
} from '../api/money';
import { ReadOnlyNote, SaveRow } from '../site/controls';
import { Section, WithChannel, formatDateTime } from './common';

const RANK: Record<SeatRole, number> = { viewer: 0, author: 1, editor: 2, admin: 3, owner: 4 };

const CONNECT_ERRORS: Record<ConnectCallbackError, { title: string; message: string }> = {
  cancelled: {
    title: 'Stripe was not connected',
    message:
      'Connecting was cancelled in Stripe, so nothing changed. Try again when you are ready.',
  },
  state: {
    title: 'The connection link has expired',
    message:
      'The link was older than 30 minutes, or someone else started it. Start again from this page.',
  },
  forbidden: {
    title: 'Only an admin can connect Stripe',
    message: 'Ask an admin of this publication to connect the Stripe account.',
  },
  exchange: {
    title: 'Stripe did not confirm the connection',
    message: 'Stripe did not finish the handshake. Wait a moment and try again.',
  },
  account_in_use: {
    title: 'That Stripe account is already in use',
    message:
      'It is connected to another publication. Use a different Stripe account, or disconnect it from the other publication first.',
  },
};

interface PaymentsSearch {
  channel?: string;
  connected?: string;
  error?: string;
}

export function PaymentsSettings({ search }: { search: PaymentsSearch }) {
  const navigate = useNavigate();
  return (
    <WithChannel
      channelId={search.channel}
      onChange={(id) => void navigate({ to: '/settings/payments', search: { channel: id } })}
    >
      {(channel, picker) => (
        <PaymentsForChannel
          key={channel.id}
          channel={channel}
          picker={picker}
          // The callback's message only belongs to the Channel it came back for.
          notice={search.channel === channel.id ? search : {}}
        />
      )}
    </WithChannel>
  );
}

function PaymentsForChannel({
  channel,
  picker,
  notice,
}: {
  channel: Channel;
  picker: ReactNode;
  notice: PaymentsSearch;
}) {
  const status = useQuery(paymentsQuery(channel.id));
  const connect = useConnectStripe(channel.id);
  const canAdmin = RANK[channel.role] >= RANK.admin;
  const callbackError =
    notice.error && notice.error in CONNECT_ERRORS
      ? CONNECT_ERRORS[notice.error as ConnectCallbackError]
      : null;

  const start = () =>
    connect.mutate(undefined, {
      onSuccess: ({ url }) => window.location.assign(url),
    });

  return (
    <div className="grid max-w-[820px] gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13.5px] text-sub">
          Payments for <b className="text-ink">{channel.name}</b> go straight to its own Stripe
          account. Swarm takes no share.
        </p>
        {picker}
      </div>

      {notice.connected === '1' && status.data?.connected && (
        <p
          role="status"
          className="rounded-card-app border border-success-soft bg-success-soft px-4 py-3 text-[13.5px] font-semibold text-success"
        >
          Stripe is connected. You can now create paid plans.
        </p>
      )}
      {callbackError && <ErrorNotice title={callbackError.title} message={callbackError.message} />}

      {status.isPending && <LoadingRows label="Loading payments" rows={3} />}
      {status.error && <ErrorNotice message={status.error.message} />}
      {status.data && !status.data.available && (
        <EmptyState title="Payments are not set up on this deployment">
          Whoever runs this Swarm installation has switched payments off. Paid plans, coupons and
          paywalls for paid subscribers need it on.
        </EmptyState>
      )}

      {status.data?.available && !status.data.connected && status.data.keyAvailable && (
        <StripeKeyForm channel={channel} />
      )}

      {status.data?.available && !status.data.connected && status.data.connectAvailable && (
        <Section
          title="Connect Stripe"
          description="Readers pay with Stripe Checkout and manage billing in the Stripe portal. Card details never reach Swarm."
        >
          <div className="grid gap-3">
            {status.data.state === 'disconnected' && (
              <p className="text-[13.5px] text-sub">
                A Stripe account was disconnected on {formatDateTime(status.data.disconnectedAt)}.
                Connect one again to sell paid plans.
              </p>
            )}
            {canAdmin ? (
              <div>
                <Button onClick={start} loading={connect.isPending}>
                  Connect Stripe
                </Button>
              </div>
            ) : (
              <ReadOnlyNote>An admin of this publication connects Stripe.</ReadOnlyNote>
            )}
            {connect.error instanceof ApiError && connect.error.code === 'unavailable' ? (
              <ErrorNotice
                title="Payments are not set up on this deployment"
                message="Stripe is not configured here, so an account can't be connected."
              />
            ) : (
              connect.error && <ErrorNotice message={connect.error.message} />
            )}
          </div>
        </Section>
      )}

      {status.data?.available && status.data.connected && (
        <ConnectedAccount channel={channel} canAdmin={canAdmin} />
      )}
      <PayPalSection channel={channel} />
    </div>
  );
}

function PayPalSection({ channel }: { channel: Channel }) {
  const status = useQuery(paypalQuery(channel.id));
  const connect = useConnectPayPal(channel.id);
  const disconnect = useDisconnectPayPal(channel.id);
  const [mode, setMode] = useState<'live' | 'sandbox'>('live');
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const isOwner = channel.role === 'owner';
  const error = connect.error instanceof ApiError ? connect.error : null;
  if (!status.data) return null;
  if (!status.data.connected && !status.data.available) return null;

  return (
    <Section
      title="PayPal"
      description="Readers can pay for monthly and yearly memberships with PayPal. Coupons, tax, trials, pay what you want, plan changes and Products stay on Stripe."
    >
      {status.data.connected ? (
        <div className="grid gap-3 text-[13.5px]">
          <p>
            Connected in {status.data.mode} mode, with the secret ending in{' '}
            <code>{status.data.secretLast4}</code>.
          </p>
          {(status.data.unfinishedEvents ?? 0) > 0 && (
            <p className="text-danger">
              {status.data.unfinishedEvents === 1
                ? '1 event from PayPal'
                : `${status.data.unfinishedEvents} events from PayPal`}{' '}
              didn’t finish. PayPal sends them again, and Swarm checks subscriptions with PayPal
              every few minutes; if this stays, look at the subscriptions in PayPal.
            </p>
          )}
          {isOwner && (
            <div>
              <Button
                variant="ghost"
                size="sm"
                loading={disconnect.isPending}
                onClick={() => disconnect.mutate(undefined)}
              >
                Disconnect PayPal
              </Button>
            </div>
          )}
          {disconnect.error && <ErrorNotice message={disconnect.error.message} />}
        </div>
      ) : isOwner ? (
        <form
          className="grid gap-3"
          aria-label="Connect PayPal"
          onSubmit={(event) => {
            event.preventDefault();
            connect.mutate(
              { mode, clientId: clientId.trim(), secret: secret.trim() },
              { onSuccess: () => setSecret('') },
            );
          }}
        >
          <p className="text-[13.5px] leading-[1.5]">
            In PayPal’s developer dashboard, create a REST app used only for this publication, with
            Subscriptions turned on. It has not been tested against PayPal yet, so try sandbox mode
            first.
          </p>
          <SelectField
            label="Mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as 'live' | 'sandbox')}
            options={[
              { value: 'live', label: 'Live' },
              { value: 'sandbox', label: 'Sandbox' },
            ]}
          />
          <TextField
            label="Client ID"
            required
            autoComplete="off"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            error={error?.field('clientId')}
          />
          <TextField
            label="Secret"
            type="password"
            required
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            error={error?.field('secret')}
            hint="It’s stored encrypted and never shown again."
          />
          {error && !error.details.length && <ErrorNotice message={error.message} />}
          <div>
            <Button type="submit" loading={connect.isPending}>
              Connect PayPal
            </Button>
          </div>
        </form>
      ) : (
        <ReadOnlyNote>An owner of this publication connects PayPal.</ReadOnlyNote>
      )}
    </Section>
  );
}

/** What a restricted key needs, in the words of Stripe's key form. */
const KEY_PERMISSIONS = [
  'Write: Products, Prices, Customers, Subscriptions, Checkout Sessions, Customer portal',
  'Write: Coupons, Promotion Codes, Refunds, Webhook Endpoints',
  'Read: Account details, Invoices, Charges',
];

function StripeKeyForm({ channel }: { channel: Channel }) {
  const connect = useConnectStripeKey(channel.id);
  const [apiKey, setApiKey] = useState('');
  const isOwner = channel.role === 'owner';
  const error = connect.error instanceof ApiError ? connect.error : null;

  return (
    <Section
      title="Add Stripe with a restricted key"
      description="Payments go straight to your Stripe account. The key is stored encrypted, and you can revoke it in Stripe at any time."
    >
      {isOwner ? (
        <form
          className="grid gap-3"
          aria-label="Add Stripe key"
          onSubmit={(event) => {
            event.preventDefault();
            connect.mutate({ apiKey: apiKey.trim() }, { onSuccess: () => setApiKey('') });
          }}
        >
          <div className="text-[13.5px] leading-[1.5]">
            <p>
              In Stripe, go to Developers → API keys → Create restricted key, and allow only these:
            </p>
            <ul className="mt-1.5 grid list-disc gap-1 pl-5 text-sub">
              {KEY_PERMISSIONS.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <TextField
            label="Restricted key"
            type="password"
            required
            autoComplete="off"
            placeholder="rk_live_…"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            error={error?.field('apiKey')}
            hint="Full secret keys (sk_…) are refused. A test key (rk_test_…) lets you try it first."
          />
          {error && !error.details.length && <ErrorNotice message={error.message} />}
          <div>
            <Button type="submit" loading={connect.isPending}>
              Add Stripe
            </Button>
          </div>
        </form>
      ) : (
        <ReadOnlyNote>An owner of this publication adds the Stripe key.</ReadOnlyNote>
      )}
    </Section>
  );
}

function StatusRow({
  label,
  ok,
  yes,
  no,
}: {
  label: string;
  ok: boolean;
  yes: string;
  no: string;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-2.5 first:border-t-0">
      <span className="text-[13.5px]">{label}</span>
      <Pill tone={ok ? 'success' : 'scheduled'}>{ok ? yes : no}</Pill>
    </li>
  );
}

function ConnectedAccount({ channel, canAdmin }: { channel: Channel; canAdmin: boolean }) {
  const status = useQuery(paymentsQuery(channel.id)).data!;
  const update = useUpdatePayments(channel.id);
  const disconnect = useDisconnectStripe(channel.id);
  const [tax, setTax] = useState(status.taxEnabled);
  const [grace, setGrace] = useState(String(status.graceDays));
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const graceNumber = Number(grace);
  const graceProblem =
    !/^\d{1,2}$/.test(grace) || graceNumber > MAX_GRACE_DAYS
      ? `Use 0 to ${MAX_GRACE_DAYS} days.`
      : undefined;
  const error = update.error instanceof ApiError ? update.error : null;

  const save = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    if (graceProblem) return;
    const input: { taxEnabled?: boolean; graceDays?: number } = {};
    if (tax !== status.taxEnabled) input.taxEnabled = tax;
    if (graceNumber !== status.graceDays) input.graceDays = graceNumber;
    if (Object.keys(input).length === 0) {
      setSaved(true);
      return;
    }
    update.mutate(input, { onSuccess: () => setSaved(true) });
  };

  return (
    <>
      <Section
        title="Stripe account"
        description={
          <>
            Connected {formatDateTime(status.connectedAt)} ·{' '}
            <span className="font-mono">{status.stripeAccountId}</span>
            {status.keyLast4 && <> · restricted key ending in {status.keyLast4}</>}
          </>
        }
        action={
          <Pill tone={status.livemode ? 'success' : 'brand'}>
            {status.livemode ? 'Live mode' : 'Test mode'}
          </Pill>
        }
      >
        <ul aria-label="Account status">
          <StatusRow label="Take payments" ok={status.chargesEnabled} yes="Enabled" no="Not yet" />
          <StatusRow label="Payouts" ok={status.payoutsEnabled} yes="Enabled" no="Not yet" />
          <StatusRow
            label="Business details"
            ok={status.detailsSubmitted}
            yes="Submitted"
            no="Missing"
          />
        </ul>
        {!status.chargesEnabled && (
          <p className="mt-3 text-[13px] text-sub">
            Stripe needs more details before this account can take payments. Finish onboarding in
            your Stripe dashboard; this page updates when Stripe tells us.
          </p>
        )}
        {status.defaultCurrency && (
          <p className="mt-3 text-[13px] text-sub">
            New paid plans are priced in{' '}
            <b className="text-ink">{status.defaultCurrency.toUpperCase()}</b> unless you choose
            another currency.
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <Link to="/memberships" search={{ channel: channel.id }} className="btn-ghost btn-sm">
            Paid plans
          </Link>
        </div>
      </Section>

      <form onSubmit={save} noValidate>
        <Section title="Checkout" description="How Stripe Checkout charges your readers.">
          <div className="grid gap-4">
            <Checkbox
              label="Collect tax with Stripe Tax"
              hint="Stripe works out and adds sales tax or VAT at checkout. Set up Stripe Tax in your Stripe dashboard first."
              checked={tax}
              disabled={!canAdmin}
              onChange={setTax}
            />
            <div className="max-w-[220px]">
              <TextField
                label="Grace period (days)"
                inputMode="numeric"
                value={grace}
                disabled={!canAdmin}
                onChange={(e) => {
                  setSaved(false);
                  setGrace(e.target.value.trim());
                }}
                hint="How long a subscriber keeps access after a payment fails, while Stripe retries."
                error={graceProblem ?? error?.field('graceDays')}
              />
            </div>
            {canAdmin ? (
              <SaveRow pending={update.isPending} saved={saved} error={update.error} />
            ) : (
              <ReadOnlyNote>An admin of this publication changes payment settings.</ReadOnlyNote>
            )}
          </div>
        </Section>
      </form>

      {canAdmin && (
        <Section
          title="Disconnect Stripe"
          description="New purchases stop. Existing subscribers keep their access until their paid period ends, and Stripe keeps billing them."
        >
          <Button variant="danger" onClick={() => setConfirming(true)}>
            Disconnect Stripe
          </Button>
        </Section>
      )}

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Disconnect this Stripe account?"
        description="Readers can no longer buy paid plans for this publication, and Swarm stops hearing about renewals and cancellations. You can connect an account again later."
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep it connected
            </Button>
            <Button
              variant="danger"
              loading={disconnect.isPending}
              onClick={() =>
                disconnect.mutate(undefined, { onSuccess: () => setConfirming(false) })
              }
            >
              Disconnect
            </Button>
          </>
        }
      >
        {disconnect.error && <ErrorNotice message={disconnect.error.message} />}
      </Dialog>
    </>
  );
}
