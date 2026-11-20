// Settings → Security: passkeys, the authenticator app, recovery codes, the workspace 2FA policy
// and SSO connections. Sensitive changes ask for a fresh second-factor check first (step-up).
import type {
  AccountEvent,
  Require2fa,
  SecondFactorStatus,
  SecurityOverview,
  SsoConnection,
  SsoDomain,
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
import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { usePlatformFlag } from '../api/queries';
import {
  addPasskey,
  addSsoDomain,
  createSsoConnection,
  deleteSsoConnection,
  disableTotp,
  needsStepUp,
  passkeysSupported,
  regenerateRecoveryCodes,
  removePasskey,
  removeSsoDomain,
  renamePasskey,
  securityQuery,
  ssoConnectionsQuery,
  updateSsoConnection,
  useAfterVerify,
  usePauseAllFeeds,
  useSecurityMutation,
  useSsoMutation,
  useWorkspacePolicy,
  verifySsoDomain,
  workspaceSecurityQuery,
} from '../api/security';
import { ROLE_LABEL, useSession } from '../session';
import { RecoveryCodesView, TotpSetup, problemMessage } from './SecurityParts';
import { deviceName } from './Settings';
import { useStepUp } from './StepUp';

const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function Section({
  id,
  title,
  description,
  action,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="card-app p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-[60ch]">
          <h2 id={id} className="text-[16px] font-semibold">
            {title}
          </h2>
          {description && <p className="mt-1 text-[13px] text-sub">{description}</p>}
        </div>
        {action}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </section>
  );
}

export function SecuritySettings() {
  const overview = useQuery(securityQuery);
  const { workspace, can } = useSession();
  const ssoOn = usePlatformFlag('sso');

  if (overview.isPending) {
    return (
      <div className="max-w-[760px]">
        <LoadingRows label="Loading security settings" rows={4} />
      </div>
    );
  }
  if (overview.error) return <ErrorNotice message={overview.error.message} />;
  const data = overview.data;
  const status = data.secondFactor;
  const factors = data.passkeys.length + (data.totp.enabled ? 1 : 0);

  return (
    <div className="grid max-w-[760px] gap-6">
      {status.required && factors === 0 && (
        <div
          role="status"
          className="rounded-card-app border border-lavender-line bg-lavender px-4 py-3 text-[13.5px]"
        >
          <p className="font-semibold text-purple-deep">Your role needs a second factor</p>
          <p className="mt-0.5">
            Add a passkey or an authenticator app
            {status.enrollBy ? ` by ${date.format(new Date(status.enrollBy))}` : ''}. After that
            date, signing in asks you to set one up before anything else.
          </p>
        </div>
      )}
      <FactorSections data={data} />
      <AccountActivity events={data.activity ?? []} />
      <WorkspacePolicy workspaceId={workspace.id} canEdit={workspace.role === 'owner'} />
      {can('admin') && (
        <PauseAllFeeds
          workspaceId={workspace.id}
          methods={status.methods.length ? status.methods : ['totp']}
        />
      )}
      {ssoOn && can('admin') && <SsoSection />}
    </div>
  );
}

const ACCOUNT_EVENT_LABEL: Record<string, string> = {
  'operator.signed_in': 'Signed in',
  'operator.passkey_added': 'Added a passkey',
  'operator.passkey_removed': 'Removed a passkey',
  'operator.totp_enabled': 'Turned on an authenticator app',
  'operator.totp_disabled': 'Turned off an authenticator app',
  'operator.recovery_codes_regenerated': 'Created new recovery codes',
  'operator.recovery_code_used': 'Used a recovery code',
  'operator.signed_out_everywhere': 'Signed out everywhere',
  'operator.first_factor_undone': 'Undid a new second factor with the email link',
};

const METHOD_LABEL: Record<string, string> = {
  quickpass: 'email link',
  google: 'Google',
  sso: 'single sign-on',
  passkey: 'passkey',
  totp: 'authenticator app',
  recovery: 'recovery code',
};

const eventTime = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** The operator's own sign-ins and factor changes, with the network and browser of each. */
function AccountActivity({ events }: { events: AccountEvent[] }) {
  return (
    <Section
      id="account-activity"
      title="Account activity"
      description="Your recent sign-ins and changes to your second factors, with the network and browser each came from. Only you see this. The audit log of each workspace you belong to records the event, its method and the time, without the network or browser."
    >
      {events.length === 0 ? (
        <p className="text-[13px] text-sub">Nothing recorded yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {events.map((event, index) => (
            <li key={`${event.at}-${index}`} className="py-2.5 text-[13.5px]">
              <b>{ACCOUNT_EVENT_LABEL[event.action] ?? event.action}</b>
              {event.method ? ` with ${METHOD_LABEL[event.method] ?? event.method}` : ''}
              <span className="block text-[12px] text-sub">
                {eventTime.format(new Date(event.at))}
                {event.userAgent ? ` · ${deviceName(event.userAgent)}` : ''}
                {event.ipPrefix ? ` · network ${event.ipPrefix}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/**
 * Incident response: stop every export destination and webhook endpoint of the workspace at once,
 * and optionally every API key and connected app. Each feed is resumed on its own page afterwards.
 */
function PauseAllFeeds({
  workspaceId,
  methods,
}: {
  workspaceId: string;
  methods: SecondFactorStatus['methods'];
}) {
  const pause = usePauseAllFeeds(workspaceId);
  const { guard, dialog: stepUp } = useStepUp(methods);
  const [open, setOpen] = useState(false);
  const [revokeApiKeys, setRevokeApiKeys] = useState(false);
  const [revokeApps, setRevokeApps] = useState(false);
  const result = pause.data;
  const submit = () =>
    void guard(async () => {
      await pause.mutateAsync({ revokeApiKeys, revokeApps });
      setOpen(false);
    }).catch(() => {
      // Shown from the mutation's error.
    });
  return (
    <Section
      id="pause-feeds"
      title="Pause all outbound feeds"
      description="If you think someone got into an account, a key or an app, stop everything that sends this workspace’s data elsewhere: every export destination and webhook endpoint. Signing out sessions does not stop these. Every owner and admin is emailed. Afterwards, resume each feed on its own page once you have checked where it points."
      action={
        <Button variant="danger" size="sm" onClick={() => setOpen(true)}>
          Pause all feeds
        </Button>
      }
    >
      {result && (
        <div role="status" className="text-[13px]">
          <p className="font-semibold">
            Paused {result.paused.length} {result.paused.length === 1 ? 'feed' : 'feeds'}
            {result.apiKeysRevoked ? `, revoked ${result.apiKeysRevoked} API keys` : ''}
            {result.appsRevoked ? `, disconnected ${result.appsRevoked} apps` : ''}.
          </p>
          {result.paused.length > 0 && (
            <ul className="mt-2 grid gap-1 text-sub">
              {result.paused.map((feed) => (
                <li key={feed.id} className="break-all">
                  {feed.kind === 'export_destination' ? 'Export destination' : 'Webhook endpoint'}:{' '}
                  {feed.target}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Pause every outbound feed?"
        description="Export destinations and webhook endpoints stop at once. Events that happen while a webhook endpoint is paused are not sent to it later."
        actions={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={pause.isPending} onClick={submit}>
              Pause all feeds
            </Button>
          </>
        }
      >
        <div className="grid gap-3">
          <Checkbox
            label="Also revoke every API key"
            hint="Scripts and integrations using a key stop working until you create a new one."
            checked={revokeApiKeys}
            onChange={setRevokeApiKeys}
          />
          <Checkbox
            label="Also disconnect every app"
            hint="Apps someone connected to this workspace lose access and need to be connected again."
            checked={revokeApps}
            onChange={setRevokeApps}
          />
          {pause.error && !needsStepUp(pause.error) && (
            <ErrorNotice message={pause.error.message} />
          )}
        </div>
      </Dialog>
      {stepUp}
    </Section>
  );
}

function FactorSections({ data }: { data: SecurityOverview }) {
  const methods = data.secondFactor.methods.length
    ? data.secondFactor.methods
    : (['totp'] as SecondFactorStatus['methods']);
  const { guard, dialog } = useStepUp(methods);
  const afterVerify = useAfterVerify();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [totpOpen, setTotpOpen] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<{
    kind: 'passkey' | 'totp';
    id?: string;
    name: string;
  } | null>(null);
  const rename = useSecurityMutation(renamePasskey);
  const remove = useSecurityMutation(async (target: { kind: 'passkey' | 'totp'; id?: string }) =>
    target.kind === 'passkey' ? removePasskey(target.id as string) : disableTotp(),
  );
  const regenerate = useSecurityMutation(regenerateRecoveryCodes);

  const createPasskey = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await guard(async () => {
        const result = await addPasskey(name.trim() || 'Passkey');
        await afterVerify();
        setAdding(false);
        setName('');
        if (result.recoveryCodes) setCodes(result.recoveryCodes);
      });
    } catch (error) {
      setProblem(problemMessage(error, 'The passkey was not added. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const factors = data.passkeys.length + (data.totp.enabled ? 1 : 0);
  const lastFactor = data.secondFactor.required && factors <= 1;

  return (
    <>
      {dialog}
      {codes && (
        <Section id="new-codes-title" title="Save your recovery codes">
          <RecoveryCodesView codes={codes} onDone={() => setCodes(null)} />
        </Section>
      )}

      <Section
        id="passkeys-title"
        title="Passkeys"
        description="Sign-in confirmations with your fingerprint, face or device PIN. They can't be phished."
        action={
          passkeysSupported() && !adding ? (
            <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
              Add a passkey
            </Button>
          ) : undefined
        }
      >
        {!passkeysSupported() && (
          <p className="text-[13px] text-sub">This browser cannot create passkeys.</p>
        )}
        {adding && (
          <form
            onSubmit={(e) => void createPasskey(e)}
            className="mb-4 grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end"
          >
            <TextField
              label="Passkey name"
              maxLength={80}
              value={name}
              placeholder="Work laptop"
              onChange={(e) => setName(e.target.value)}
            />
            <Button type="submit" loading={busy}>
              Create passkey
            </Button>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            {problem && (
              <div className="sm:col-span-3">
                <ErrorNotice title="Passkey not added" message={problem} />
              </div>
            )}
          </form>
        )}
        {data.passkeys.length === 0 ? (
          <p className="text-[13.5px] text-sub">No passkeys yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {data.passkeys.map((key) => (
              <li
                key={key.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3 text-[13.5px]"
              >
                <span>
                  <b>{key.name}</b> {key.backedUp && <Pill tone="neutral">Synced</Pill>}
                  <span className="block text-[12px] text-sub">
                    Added {date.format(new Date(key.createdAt))}
                    {key.lastUsedAt
                      ? ` · last used ${date.format(new Date(key.lastUsedAt))}`
                      : ' · not used yet'}
                  </span>
                </span>
                <span className="flex gap-1">
                  <Button
                    variant="quiet"
                    onClick={() => setRenaming({ id: key.id, name: key.name })}
                  >
                    Rename
                  </Button>
                  <Button
                    variant="quiet"
                    onClick={() => setRemoving({ kind: 'passkey', id: key.id, name: key.name })}
                  >
                    Remove
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        id="totp-title"
        title="Authenticator app"
        description="6-digit codes from an app on your phone."
        action={
          data.totp.enabled ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRemoving({ kind: 'totp', name: 'the authenticator app' })}
            >
              Turn off
            </Button>
          ) : undefined
        }
      >
        {data.totp.enabled ? (
          <p className="text-[13.5px]">
            <Pill tone="success">On</Pill>{' '}
            <span className="text-sub">
              since {date.format(new Date(data.totp.confirmedAt as string))}
            </span>
          </p>
        ) : totpOpen ? (
          <TotpSetup
            guard={guard}
            onDone={async ({ recoveryCodes }) => {
              await afterVerify();
              setTotpOpen(false);
              if (recoveryCodes) setCodes(recoveryCodes);
            }}
            onCancel={() => setTotpOpen(false)}
          />
        ) : (
          <Button variant="ghost" onClick={() => setTotpOpen(true)}>
            Set up an authenticator app
          </Button>
        )}
      </Section>

      <Section
        id="recovery-title"
        title="Recovery codes"
        description="For when you lose your passkey or phone. Each code works once."
        action={
          factors > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              loading={regenerate.isPending}
              onClick={() =>
                void guard(async () =>
                  setCodes((await regenerate.mutateAsync()).recoveryCodes),
                ).catch(() => undefined)
              }
            >
              Create new codes
            </Button>
          ) : undefined
        }
      >
        <p className="text-[13.5px]">
          {factors === 0
            ? 'You get recovery codes when you add your first passkey or authenticator app.'
            : `${data.recoveryCodes.remaining} of 10 unused. Creating new codes stops the old ones working.`}
        </p>
        {regenerate.error && !needsStepUp(regenerate.error) && (
          <div className="mt-3">
            <ErrorNotice message={regenerate.error.message} />
          </div>
        )}
      </Section>

      <Dialog
        open={!!renaming}
        onClose={() => setRenaming(null)}
        title="Rename passkey"
        actions={
          <>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button
              loading={rename.isPending}
              onClick={() =>
                renaming && rename.mutate(renaming, { onSuccess: () => setRenaming(null) })
              }
            >
              Save
            </Button>
          </>
        }
      >
        {renaming && (
          <TextField
            label="Name"
            maxLength={80}
            value={renaming.name}
            onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
            error={rename.error instanceof ApiError ? rename.error.field('name') : undefined}
          />
        )}
      </Dialog>

      <Dialog
        open={!!removing}
        onClose={() => {
          setRemoving(null);
          remove.reset();
        }}
        title={
          removing?.kind === 'totp'
            ? 'Turn off the authenticator app?'
            : `Remove ${removing?.name ?? ''}?`
        }
        description={
          lastFactor
            ? 'Your role needs a second factor, so add another one before removing this one.'
            : 'You will no longer be able to verify with it.'
        }
        actions={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setRemoving(null);
                remove.reset();
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={lastFactor}
              loading={remove.isPending}
              onClick={() => {
                const target = removing;
                if (!target) return;
                setRemoving(null);
                void guard(() => remove.mutateAsync(target)).catch(() => undefined);
              }}
            >
              {removing?.kind === 'totp' ? 'Turn off' : 'Remove'}
            </Button>
          </>
        }
      />
      {remove.error && !needsStepUp(remove.error) && (
        <ErrorNotice title="Not removed" message={remove.error.message} />
      )}
    </>
  );
}

const POLICY_LABEL: Record<Require2fa, string> = {
  admins: 'Owners and admins',
  all: 'Everyone in the workspace',
};

function WorkspacePolicy({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const policy = useQuery(workspaceSecurityQuery(workspaceId));
  const save = useWorkspacePolicy(workspaceId);

  return (
    <Section
      id="policy-title"
      title="Second factor for this workspace"
      description="Owners and admins always need one. You can require it for every teammate. Teammates who have none get 14 days to add one."
    >
      {policy.isPending && <LoadingRows label="Loading policy" rows={1} />}
      {policy.error && <ErrorNotice message={policy.error.message} />}
      {policy.data && (
        <div className="grid gap-3">
          <fieldset disabled={!canEdit || save.isPending}>
            <legend className="sr-only">Who must use a second factor</legend>
            <div className="flex flex-wrap gap-2">
              {(['admins', 'all'] as const).map((value) => (
                <label
                  key={value}
                  className="flex min-h-10 cursor-pointer items-center gap-2 rounded-control border border-line-control px-3 text-[13.5px] has-checked:border-purple has-checked:bg-lavender has-disabled:cursor-default has-focus-visible:outline-2 has-focus-visible:outline-purple"
                >
                  <input
                    type="radio"
                    name="require-2fa"
                    value={value}
                    checked={policy.data.require2fa === value}
                    onChange={() => save.mutate(value)}
                    className="accent-purple"
                  />
                  {POLICY_LABEL[value]}
                </label>
              ))}
            </div>
          </fieldset>
          <p role="status" className="text-[13px] text-sub">
            {!canEdit
              ? 'Only owners can change this.'
              : policy.data.seatsWithoutSecondFactor
                ? `${policy.data.seatsWithoutSecondFactor} ${policy.data.seatsWithoutSecondFactor === 1 ? 'teammate covered by this still needs' : 'teammates covered by this still need'} to add one.`
                : 'Everyone covered by this has a second factor.'}
          </p>
          {save.error && <ErrorNotice title="Not changed" message={save.error.message} />}
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// SSO

const JIT_OPTIONS = [
  { value: '', label: 'Off: invite people yourself' },
  { value: 'viewer', label: `${ROLE_LABEL.viewer}` },
  { value: 'author', label: `${ROLE_LABEL.author}` },
  { value: 'editor', label: `${ROLE_LABEL.editor}` },
  { value: 'admin', label: `${ROLE_LABEL.admin}` },
];

function SsoSection() {
  const { workspace } = useSession();
  const connections = useQuery(ssoConnectionsQuery(workspace.id));
  const create = useSsoMutation(workspace.id, (input: Parameters<typeof createSsoConnection>[1]) =>
    createSsoConnection(workspace.id, input),
  );
  const [form, setForm] = useState({ issuer: '', clientId: '', clientSecret: '', jitRole: '' });
  const [adding, setAdding] = useState(false);
  const paid = workspace.plan !== 'free';
  const error = create.error instanceof ApiError ? create.error : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { ...form, jitRole: form.jitRole || null },
      {
        onSuccess: () => {
          setAdding(false);
          setForm({ issuer: '', clientId: '', clientSecret: '', jitRole: '' });
        },
      },
    );
  };

  return (
    <Section
      id="sso-title"
      title="Single sign-on"
      description="Teammates with addresses on your verified domains sign in through your identity provider (OpenID Connect)."
      action={
        paid && !adding ? (
          <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
            Add a connection
          </Button>
        ) : undefined
      }
    >
      {!paid ? (
        <EmptyState title="Part of the Pro plan">
          Single sign-on with domain capture and seats on first sign-in comes with Pro and up.
        </EmptyState>
      ) : (
        <div className="grid gap-4">
          {adding && (
            <form onSubmit={submit} className="grid gap-3 rounded-card-app border border-line p-4">
              <TextField
                label="Issuer URL"
                required
                type="url"
                placeholder="https://login.example.com"
                value={form.issuer}
                onChange={(e) => setForm({ ...form, issuer: e.target.value })}
                error={error?.field('issuer')}
                hint="Its /.well-known/openid-configuration is read when you activate the connection."
              />
              <TextField
                label="Client ID"
                required
                value={form.clientId}
                onChange={(e) => setForm({ ...form, clientId: e.target.value })}
                error={error?.field('clientId')}
              />
              <TextField
                label="Client secret"
                required
                type="password"
                autoComplete="off"
                value={form.clientSecret}
                onChange={(e) => setForm({ ...form, clientSecret: e.target.value })}
                hint="Stored encrypted and never shown again."
              />
              <SelectField
                label="Seat for new teammates on first sign-in"
                value={form.jitRole}
                onChange={(e) => setForm({ ...form, jitRole: e.target.value })}
                options={JIT_OPTIONS.filter(
                  (o) => o.value !== 'admin' || workspace.role === 'owner',
                )}
              />
              {error && !error.details.length && <ErrorNotice message={error.message} />}
              <div className="flex gap-2">
                <Button type="submit" loading={create.isPending}>
                  Add connection
                </Button>
                <Button variant="ghost" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
          {connections.isPending && <LoadingRows label="Loading connections" rows={1} />}
          {connections.error && <ErrorNotice message={connections.error.message} />}
          {connections.data?.length === 0 && !adding && (
            <p className="text-[13.5px] text-sub">No connections yet.</p>
          )}
          {connections.data?.map((connection) => (
            <SsoConnectionCard key={connection.id} connection={connection} />
          ))}
        </div>
      )}
    </Section>
  );
}

const STATUS_TONE = { draft: 'neutral', active: 'success', disabled: 'danger' } as const;

function SsoConnectionCard({ connection }: { connection: SsoConnection }) {
  const { workspace } = useSession();
  const update = useSsoMutation(workspace.id, (input: Record<string, unknown>) =>
    updateSsoConnection(connection.id, input),
  );
  const remove = useSsoMutation(workspace.id, () => deleteSsoConnection(connection.id));
  const add = useSsoMutation(workspace.id, (domain: string) => addSsoDomain(connection.id, domain));
  const verify = useSsoMutation(workspace.id, (domain: SsoDomain) =>
    verifySsoDomain(connection.id, domain.id),
  );
  const release = useSsoMutation(workspace.id, (domain: SsoDomain) =>
    removeSsoDomain(connection.id, domain.id),
  );
  const [domain, setDomain] = useState('');
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const problem = [update.error, add.error, verify.error, release.error].find(Boolean);

  return (
    <article
      className="rounded-card-app border border-line p-4"
      aria-label={`Connection ${connection.issuer}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold break-all">{connection.issuer}</p>
          <p className="mt-0.5 text-[12.5px] text-sub break-all">
            Client {connection.clientId} · new teammates:{' '}
            {connection.jitRole ? ROLE_LABEL[connection.jitRole] : 'invite only'}
          </p>
        </div>
        <Pill tone={STATUS_TONE[connection.status]}>
          {connection.status === 'draft'
            ? 'Draft'
            : connection.status === 'active'
              ? 'Active'
              : 'Off'}
        </Pill>
      </div>

      <p className="mt-3 text-[12.5px] text-sub">
        Redirect URI for your identity provider:{' '}
        <code className="rounded bg-surface-alt px-1.5 py-0.5 font-mono text-ink">
          {connection.redirectUri}
        </code>
      </p>

      <h3 className="mt-4 text-[13px] font-semibold">Domains</h3>
      <ul className="mt-2 grid gap-2">
        {connection.domains.map((d) => (
          <li key={d.id} className="rounded-card-app bg-surface-alt px-3 py-2.5 text-[13px]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <b>{d.domain}</b>{' '}
                {d.verified ? <Pill tone="success">Verified</Pill> : <Pill>Not verified</Pill>}
              </span>
              <span className="flex gap-1">
                {!d.verified && (
                  <Button
                    variant="quiet"
                    loading={verify.isPending && verify.variables?.id === d.id}
                    onClick={() =>
                      verify.mutate(d, {
                        onSuccess: (result) =>
                          setChecked((c) => ({ ...c, [d.id]: !result.verified })),
                      })
                    }
                  >
                    Check record
                  </Button>
                )}
                <Button variant="quiet" onClick={() => release.mutate(d)}>
                  Remove
                </Button>
              </span>
            </div>
            {!d.verified && (
              <div className="mt-2 grid gap-1 text-[12.5px]">
                <p className="text-sub">Add this TXT record at your DNS provider, then check it:</p>
                <p>
                  Name <code className="font-mono break-all">{d.txtName}</code>
                </p>
                <p>
                  Value <code className="font-mono break-all">{d.txtValue}</code>
                </p>
                <p role="status" className="text-sub">
                  {checked[d.id] ? 'Not found yet. DNS changes can take a while to appear.' : ''}
                </p>
              </div>
            )}
          </li>
        ))}
      </ul>
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          add.mutate(domain, { onSuccess: () => setDomain('') });
        }}
      >
        <div className="min-w-[220px] flex-1">
          <TextField
            label="Add a domain"
            placeholder="example.com"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            error={add.error instanceof ApiError ? add.error.field('domain') : undefined}
          />
        </div>
        <Button type="submit" variant="ghost" loading={add.isPending} disabled={!domain.trim()}>
          Add
        </Button>
      </form>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        {connection.status === 'active' ? (
          <Button variant="ghost" size="sm" onClick={() => update.mutate({ status: 'disabled' })}>
            Turn off
          </Button>
        ) : (
          <Button
            size="sm"
            loading={update.isPending}
            disabled={!connection.domains.some((d) => d.verified)}
            onClick={() => update.mutate({ status: 'active' })}
          >
            Activate
          </Button>
        )}
        <label className="flex min-h-10 items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={connection.enforced}
            onChange={(e) => update.mutate({ enforced: e.target.checked })}
            className="accent-purple"
          />
          Require single sign-on for these domains (owners can still use other sign-in)
        </label>
        <Button variant="quiet" size="sm" onClick={() => setConfirmDelete(true)}>
          Delete connection
        </Button>
      </div>
      {problem && (
        <div className="mt-3">
          <ErrorNotice message={problem.message} />
        </div>
      )}
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this connection?"
        description="Its domains are released. Teammates keep their seats and can sign in another way."
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => remove.mutate(undefined, { onSuccess: () => setConfirmDelete(false) })}
            >
              Delete
            </Button>
          </>
        }
      />
    </article>
  );
}
