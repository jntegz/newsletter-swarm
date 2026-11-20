// Settings → Developers (Phase 7): a section with its own tabs. API keys live here; OAuth apps
// and webhooks join DEVELOPER_TABS as their own routes under /settings/developers.
import { PLAN_LIMITS, type ApiKey, type ApiScope, type CreateApiKey } from '@swarm/domain';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  Pill,
  SelectField,
  TextAreaField,
  TextField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link, Outlet } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import {
  API_OPENAPI_URL,
  API_REFERENCE_URL,
  apiKeysQuery,
  useCreateApiKey,
  useKeepApiKey,
  useRevokeApiKey,
} from '../api/developers';
import { channelsQuery } from '../api/queries';
import { useWorkspaceFlag } from '../channel';
import { useSession } from '../session';
import { RESOURCE_LABEL, ScopePicker, scopesOf, type AccessMap } from './ScopePicker';
import { formError, useStepUp } from './StepUp';

/** Developer sub-sections. Add a tab here and a child route of /settings/developers. */
const DEVELOPER_TABS = [
  { to: '/settings/developers/api-keys', label: 'API keys' },
  { to: '/settings/developers/oauth-apps', label: 'OAuth apps' },
  { to: '/settings/developers/webhooks', label: 'Webhooks' },
  { to: '/settings/developers/listings', label: 'Directory listings' },
  { to: '/settings/developers/open-operator', label: 'Open Operator' },
] as const;

const dateTime = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

export function DevelopersLayout() {
  const directoryOn = useWorkspaceFlag('app_directory') === true;
  const mcpOn = useWorkspaceFlag('open_operator_mcp') === true;
  // Copilot's held calls are approved on the Open Operator page, even with the MCP server off.
  const copilotActionsOn = useWorkspaceFlag('copilot_actions') === true;
  const tabs = DEVELOPER_TABS.filter((tab) => {
    if (tab.to === '/settings/developers/listings') return directoryOn;
    if (tab.to === '/settings/developers/open-operator') return mcpOn || copilotActionsOn;
    return true;
  });
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Developer settings" className="flex gap-1">
          {tabs.map((tab) => (
            <Link
              key={tab.to}
              to={tab.to}
              className="rounded-control px-3 py-1.5 text-[13.5px] text-sub no-underline hover:bg-surface-alt hover:text-ink"
              activeProps={{
                className: 'bg-lavender! font-semibold text-purple-deep!',
                'aria-current': 'page',
              }}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
        <p className="flex gap-4 text-[13px]">
          <a href={API_REFERENCE_URL} target="_blank" rel="noreferrer">
            API reference
          </a>
          <a href={API_OPENAPI_URL} target="_blank" rel="noreferrer">
            OpenAPI document
          </a>
        </p>
      </div>
      <Outlet />
    </div>
  );
}

// ---- Scopes --------------------------------------------------------------------------------

function scopeSummary(scopes: ApiScope[]): string {
  return scopes
    .map((scope) => {
      const [resource = '', level] = scope.split(':');
      return `${RESOURCE_LABEL[resource] ?? resource} (${level === 'write' ? 'read and write' : 'read'})`;
    })
    .join(', ');
}

// ---- API keys ------------------------------------------------------------------------------

function statusPill(key: ApiKey) {
  if (key.status === 'revoked') return <Pill tone="danger">Revoked</Pill>;
  if (key.status === 'expired') return <Pill>Expired</Pill>;
  if (key.status === 'suspended') return <Pill tone="danger">Suspended</Pill>;
  return <Pill tone="success">Active</Pill>;
}

export function ApiKeysSettings() {
  const { workspace, can } = useSession();
  const keys = useQuery({ ...apiKeysQuery(workspace.id), enabled: can('admin') });
  const channels = useQuery({ ...channelsQuery(workspace.id), enabled: can('admin') });
  const revoke = useRevokeApiKey(workspace.id);
  const keep = useKeepApiKey(workspace.id);
  const { guard, dialog: stepUp } = useStepUp();
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  if (!can('admin')) {
    return (
      <EmptyState title="Admins only">
        Ask an owner or admin if you need an API key for this workspace.
      </EmptyState>
    );
  }

  const limit = PLAN_LIMITS[workspace.plan].apiKeys;
  const active = keys.data?.filter((key) => key.status === 'active').length ?? 0;
  const channelName = (id: string) => channels.data?.find((ch) => ch.id === id)?.name ?? id;

  return (
    <section aria-labelledby="api-keys-title" className="card-app overflow-x-auto">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
        <div className="max-w-[60ch]">
          <h2 id="api-keys-title" className="text-[16px] font-semibold">
            API keys
          </h2>
          <p className="mt-1 text-[13px] text-sub">
            Keys let your own code use the public API. Give each one only the scopes it needs. The
            secret is shown once; Swarm keeps only a fingerprint of it.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <p className="tabular text-[13px] text-sub">
            {active} of {limit} active
          </p>
          <Button
            onClick={() => setCreating(true)}
            disabled={active >= limit}
            title={active >= limit ? 'Revoke a key to create another' : undefined}
          >
            Create key
          </Button>
        </div>
      </div>
      {keys.isPending && (
        <div className="p-5">
          <LoadingRows label="Loading API keys" rows={3} />
        </div>
      )}
      {keys.error && (
        <div className="p-5">
          <ErrorNotice message={keys.error.message} />
        </div>
      )}
      {keys.data && keys.data.length === 0 && (
        <div className="p-5">
          <EmptyState title="No API keys yet">
            Create a key to connect a script, a no-code tool or your own app to this workspace.
          </EmptyState>
        </div>
      )}
      {keys.data && keys.data.length > 0 && (
        <ul className="mt-4 divide-y divide-line border-t border-line">
          {keys.data.map((key) => (
            <li key={key.id} className="grid gap-2 px-5 py-4 text-[13.5px] sm:grid-cols-[1fr_auto]">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2">
                  <b>{key.name}</b> {statusPill(key)}
                  <code className="font-mono text-[12.5px] text-sub">sk_live_{key.prefix}…</code>
                </p>
                <p className="mt-1 text-[12.5px] text-sub">{scopeSummary(key.scopes)}</p>
                <p className="mt-1 text-[12.5px] text-sub">
                  {key.channelIds
                    ? `Only ${key.channelIds.map(channelName).join(', ')}`
                    : 'Every publication'}
                  {key.ipAllowlist ? ` · from ${key.ipAllowlist.join(', ')}` : ''}
                  {key.rateCap ? ` · up to ${key.rateCap} requests a minute` : ''}
                  {key.surface === 'mcp' ? ' · MCP server only' : ' · MCP and the API directly'}
                </p>
                <p className="mt-1 text-[12.5px] text-sub">
                  Created by {key.createdBy ? key.createdBy.email : 'a teammate who has left'} on{' '}
                  {dateTime.format(new Date(key.createdAt))}
                </p>
                <p className="tabular mt-1 text-[12.5px] text-sub">
                  {key.lastUsedAt
                    ? `Last used ${dateTime.format(new Date(key.lastUsedAt))}${key.lastUsedIpPrefix ? ` from ${key.lastUsedIpPrefix}` : ''}`
                    : 'Never used'}
                  {' · '}
                  {key.revokedAt
                    ? `Revoked ${dateTime.format(new Date(key.revokedAt))}`
                    : key.expiresAt
                      ? `${key.status === 'expired' ? 'Expired' : 'Expires'} ${dateTime.format(new Date(key.expiresAt))}`
                      : 'No expiry'}
                </p>
              </div>
              {key.status === 'suspended' && (
                <p className="text-[12.5px] text-danger sm:col-span-2">
                  The admin who stands behind this key no longer has the admin role, so it is
                  refused. Keep it to stand behind it yourself, or revoke it.
                </p>
              )}
              {(key.status === 'active' || key.status === 'suspended') && (
                <div className="flex gap-2 self-center">
                  {key.status === 'suspended' && (
                    <Button
                      variant="ghost"
                      loading={keep.isPending}
                      onClick={() =>
                        void guard(() => keep.mutateAsync(key)).catch(() => {
                          // Shown from the mutation's error.
                        })
                      }
                    >
                      Keep
                    </Button>
                  )}
                  <Button variant="quiet" onClick={() => setRevoking(key)}>
                    Revoke
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="p-2" />
      {formError(keep.error) && (
        <div className="px-5 pb-4">
          <ErrorNotice message={keep.error!.message} />
        </div>
      )}
      {stepUp}

      {creating && (
        <CreateKeyDialog
          onClose={() => setCreating(false)}
          onCreated={(name, value) => {
            setCreating(false);
            setSecret({ name, value });
          }}
        />
      )}
      <SecretDialog secret={secret} onClose={() => setSecret(null)} />
      <Dialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        title="Revoke this key?"
        description={
          revoking ? (
            <>
              <b>{revoking.name}</b> stops working at once. Anything still using it gets an error.
              This can’t be undone.
            </>
          ) : null
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={revoke.isPending}
              onClick={() =>
                revoking && revoke.mutate(revoking.id, { onSuccess: () => setRevoking(null) })
              }
            >
              Revoke key
            </Button>
          </>
        }
      >
        {revoke.error && <ErrorNotice message={revoke.error.message} />}
      </Dialog>
    </section>
  );
}

const EXPIRY_OPTIONS = [
  { value: '', label: 'Never' },
  { value: '30', label: 'In 30 days' },
  { value: '90', label: 'In 90 days' },
  { value: '365', label: 'In a year' },
];

function CreateKeyDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (name: string, secret: string) => void;
}) {
  const { workspace } = useSession();
  const create = useCreateApiKey(workspace.id);
  const channels = useQuery(channelsQuery(workspace.id));
  const [name, setName] = useState('');
  const [access, setAccess] = useState<AccessMap>({ channels: 'read' });
  const [limited, setLimited] = useState(false);
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('');
  const [allowlist, setAllowlist] = useState('');
  const [rateCap, setRateCap] = useState('');
  // A new key needs a fresh second-factor check.
  const { guard, dialog: stepUp } = useStepUp();
  const error = create.error instanceof ApiError && formError(create.error) ? create.error : null;
  const [surface, setSurface] = useState<'mcp' | 'both'>('mcp');
  const planRate = PLAN_LIMITS[workspace.plan].requestsPerMinute;
  const scopes = scopesOf(access);
  const allowlistError = error?.details.find((d) => d.path.startsWith('ipAllowlist'))?.message;
  const [moreLimits, setMoreLimits] = useState(false);
  const limitError = allowlistError ?? error?.field('rateCap');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const ranges = allowlist
      .split(/[\s,]+/)
      .map((line) => line.trim())
      .filter(Boolean);
    const input: CreateApiKey = {
      name,
      scopes,
      channelIds: limited ? channelIds : null,
      ipAllowlist: ranges.length ? ranges : null,
      rateCap: rateCap ? Number(rateCap) : null,
      expiresAt: expiry ? new Date(Date.now() + Number(expiry) * 86_400_000).toISOString() : null,
      surface,
    };
    void guard(async () => {
      const created = await create.mutateAsync(input);
      onCreated(created.key.name, created.secret);
    }).catch(() => {
      // Shown from the mutation's error.
    });
  };

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        title="Create an API key"
        description="Give it only what it needs. You can revoke it at any time."
        actions={
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="create-api-key"
              loading={create.isPending}
              disabled={!name.trim() || scopes.length === 0 || (limited && channelIds.length === 0)}
            >
              Create key
            </Button>
          </>
        }
      >
        <form id="create-api-key" onSubmit={submit} className="grid gap-4">
          <TextField
            label="Name"
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={error?.field('name')}
            hint="So you can tell keys apart, for example the tool that uses it."
          />
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-[13px] font-semibold">What this key can do</legend>
            <ScopePicker value={access} onChange={setAccess} />
            {scopes.length === 0 && (
              <p className="text-[12.5px] text-sub">Choose at least one to create the key.</p>
            )}
            {error?.field('scopes') && (
              <p role="alert" className="text-[12.5px] font-semibold text-danger">
                {error.field('scopes')}
              </p>
            )}
          </fieldset>
          <SelectField
            label="Who uses it"
            value={surface}
            onChange={(e) => setSurface(e.target.value as 'mcp' | 'both')}
            hint={
              surface === 'mcp'
                ? 'Works only on the MCP server, where your approval rules hold agent calls. Anyone who copies the key can’t use it to call the API directly.'
                : 'Also works on the API directly (/v2), where nothing waits for approval. Choose this only for code you run yourself.'
            }
            options={[
              { value: 'mcp', label: 'An AI agent (MCP server only)' },
              { value: 'both', label: 'An integration (MCP server and the API directly)' },
            ]}
          />
          <SelectField
            label="Which publications"
            value={limited ? 'some' : 'all'}
            onChange={(e) => setLimited(e.target.value === 'some')}
            options={[
              { value: 'all', label: 'Every publication, including new ones' },
              { value: 'some', label: 'Only the publications I pick' },
            ]}
          />
          {limited && (
            <fieldset className="grid gap-1.5">
              <legend className="text-[13px] font-semibold">Publications this key can reach</legend>
              {channels.isPending && <LoadingRows label="Loading publications" rows={2} />}
              {channels.data?.map((channel) => (
                <label key={channel.id} className="flex items-center gap-2 text-[13.5px]">
                  <input
                    type="checkbox"
                    className="size-4 accent-purple"
                    checked={channelIds.includes(channel.id)}
                    onChange={(e) =>
                      setChannelIds((ids) =>
                        e.target.checked
                          ? [...ids, channel.id]
                          : ids.filter((id) => id !== channel.id),
                      )
                    }
                  />
                  {channel.name}
                </label>
              ))}
              {error?.field('channelIds') && (
                <p role="alert" className="text-[12.5px] font-semibold text-danger">
                  {error.field('channelIds')}
                </p>
              )}
            </fieldset>
          )}
          <SelectField
            label="Expires"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
            options={EXPIRY_OPTIONS}
            error={error?.field('expiresAt')}
          />
          <details
            open={moreLimits || !!limitError}
            onToggle={(e) => setMoreLimits(e.currentTarget.open)}
          >
            <summary className="cursor-pointer text-[13px] font-semibold">
              More limits <span className="font-normal text-sub">(optional)</span>
            </summary>
            <div className="mt-3 grid gap-4">
              <TextAreaField
                label="Allowed addresses"
                value={allowlist}
                onChange={(e) => setAllowlist(e.target.value)}
                placeholder={'203.0.113.0/24\n2001:db8::/32'}
                hint="IPv4 or IPv6 addresses or ranges, one per line. Leave empty to allow any address."
                error={allowlistError}
              />
              <TextField
                label="Rate cap"
                type="number"
                inputMode="numeric"
                min={1}
                max={planRate}
                value={rateCap}
                onChange={(e) => setRateCap(e.target.value)}
                error={error?.field('rateCap')}
                hint={`Requests a minute. Your plan allows up to ${planRate.toLocaleString('en-GB')}.`}
              />
            </div>
          </details>
          {error && !error.details.length && <ErrorNotice message={error.message} />}
        </form>
      </Dialog>
      {stepUp}
    </>
  );
}

function SecretDialog({
  secret,
  onClose,
}: {
  secret: { name: string; value: string } | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret.value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Dialog
      open={!!secret}
      onClose={() => {
        setCopied(false);
        onClose();
      }}
      title="Copy your new key"
      description={
        <>
          This is the only time the secret of <b>{secret?.name}</b> is shown. Store it somewhere
          safe, such as your app’s secret settings.
        </>
      }
      actions={
        <Button
          onClick={() => {
            setCopied(false);
            onClose();
          }}
        >
          Done
        </Button>
      }
    >
      <div className="grid gap-2">
        <TextField
          label="Secret"
          readOnly
          value={secret?.value ?? ''}
          className="font-mono text-[13px]"
          onFocus={(e) => e.target.select()}
        />
        <div className="flex items-center gap-3">
          <Button variant="ghost" onClick={() => void copy()}>
            Copy
          </Button>
          <p role="status" className="text-[13px] text-success">
            {copied ? 'Copied.' : ''}
          </p>
        </div>
      </div>
    </Dialog>
  );
}
