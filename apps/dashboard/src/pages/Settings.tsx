import type { SeatRole } from '@swarm/domain';
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
import { Link, Outlet, useLocation } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import {
  auditQuery,
  channelsQuery,
  invitesQuery,
  seatAccessQuery,
  seatsQuery,
  sessionsQuery,
  useChangeRole,
  useInvite,
  useRemoveSeat,
  useRenameWorkspace,
  useRevokeInvite,
  useRevokeSession,
  useUpdateChannel,
  verifyChain,
} from '../api/queries';
import { useSignOutEverywhere } from '../api/security';
import { useWorkspaceFlag } from '../channel';
import { ROLE_LABEL, useSession } from '../session';
import { PageHeader } from './Channels';
import { Band, Bands } from './common';

const dateTime = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const TABS = [
  { to: '/settings/workspace', label: 'Workspace' },
  { to: '/settings/team', label: 'Team' },
  { to: '/settings/sessions', label: 'Devices' },
  { to: '/settings/security', label: 'Security' },
  { to: '/settings/audit', label: 'Audit log' },
  { to: '/settings/payments', label: 'Payments' },
  { to: '/settings/privacy', label: 'Privacy Center' },
  { to: '/settings/developers', label: 'Developers' },
  // Shown only while its flag is on.
  { to: '/settings/copilot', label: 'Copilot', flag: 'copilot' },
] as const;

/** Settings for the whole Swarm (self-hosting): its owners only. */
const INSTANCE_TAB = { to: '/settings/instance', label: 'Instance' } as const;

export function SettingsLayout() {
  const { me } = useSession();
  const copilotOn = useWorkspaceFlag('copilot') === true;
  const shown = TABS.filter((tab) => !('flag' in tab) || copilotOn);
  const tabs = me.instanceAdmin ? [...shown, INSTANCE_TAB] : shown;
  // On a phone the row scrolls sideways inside itself; keep the current tab in view.
  const row = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  useEffect(() => {
    const nav = row.current;
    const current = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !current) return;
    const left = current.getBoundingClientRect().left - nav.getBoundingClientRect().left;
    if (left < 0 || left + current.offsetWidth > nav.clientWidth) nav.scrollLeft += left - 16;
  }, [pathname]);
  return (
    <>
      <PageHeader title="Settings" />
      <nav
        ref={row}
        aria-label="Settings sections"
        // The rule is an inset shadow, not a border, so the current tab's line covers it without
        // poking out of the scroll box.
        className="mb-6 flex gap-1 overflow-x-auto overscroll-x-contain shadow-[inset_0_-1px_0_var(--line-app)]"
      >
        {tabs.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            className="shrink-0 border-b-2 border-transparent px-3 pb-3 text-[13.5px] whitespace-nowrap text-sub no-underline hover:text-ink"
            activeProps={{
              className: 'border-purple! font-semibold text-ink!',
              'aria-current': 'page',
            }}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </>
  );
}

export function WorkspaceSettings() {
  const { workspace, can } = useSession();
  const rename = useRenameWorkspace(workspace.id);
  const [name, setName] = useState(workspace.name);
  const [saved, setSaved] = useState(false);
  const channels = useQuery({ ...channelsQuery(workspace.id), enabled: can('admin') });
  // With one publication the two names usually mean the same thing, so offer to change both.
  const only = channels.data?.length === 1 ? channels.data[0] : undefined;
  const updateChannel = useUpdateChannel(only?.id ?? '');
  const [alsoChosen, setAlsoChosen] = useState<boolean | null>(null);
  const also = alsoChosen ?? only?.name === workspace.name;
  const offerAlso = !!only && name.trim() !== only.name && name.trim() !== workspace.name;
  const error = rename.error instanceof ApiError ? rename.error : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    const done = () => {
      setAlsoChosen(null);
      setSaved(true);
    };
    rename.mutate(name, {
      onSuccess: () => {
        if (offerAlso && also) updateChannel.mutate({ name: name.trim() }, { onSuccess: done });
        else done();
      },
    });
  };

  return (
    <Bands>
      <Band
        title="Workspace"
        description={
          <>
            Plan: <b className="text-ink capitalize">{workspace.plan}</b> · your role:{' '}
            <b className="text-ink">{ROLE_LABEL[workspace.role]}</b>
          </>
        }
      >
        <form onSubmit={submit} className="grid max-w-[560px] gap-5">
          <TextField
            label="Workspace name"
            required
            maxLength={80}
            value={name}
            disabled={!can('admin')}
            onChange={(e) => setName(e.target.value)}
            error={error?.field('name')}
            hint="Shown to your team, never to readers."
          />
          {can('admin') && offerAlso && only && (
            <Checkbox
              label={`Also rename the publication “${only.name}”`}
              hint="Readers see the publication’s name, on your site and in your emails."
              checked={also}
              onChange={setAlsoChosen}
            />
          )}
          <p className="text-[13px] text-sub">
            Readers see each publication’s own name.{' '}
            <Link to="/channels" className="font-semibold text-ink underline">
              Change it under Publications
            </Link>
            .
          </p>
          {error && !error.details.length && <ErrorNotice message={error.message} />}
          {updateChannel.error && (
            <ErrorNotice
              title="The publication kept its name"
              message={updateChannel.error.message}
            />
          )}
          {can('admin') && (
            <div className="flex items-center gap-3">
              <Button type="submit" loading={rename.isPending || updateChannel.isPending}>
                Save
              </Button>
              <p role="status" className="text-[13px] text-success">
                {saved ? 'Saved.' : ''}
              </p>
            </div>
          )}
        </form>
      </Band>
    </Bands>
  );
}

const ASSIGNABLE: SeatRole[] = ['viewer', 'author', 'editor', 'admin', 'owner'];
const ROLE_HELP: Record<SeatRole, string> = {
  owner: 'Everything, including ownership and billing',
  admin: 'Team, publications and settings',
  editor: 'Edit publications, posts and subscribers',
  author: 'Write draft posts and upload media',
  viewer: 'Read only',
};

export function TeamSettings() {
  const { workspace, me, can } = useSession();
  const seats = useQuery(seatsQuery(workspace.id));
  const invites = useQuery({ ...invitesQuery(workspace.id), enabled: can('admin') });
  const changeRole = useChangeRole(workspace.id);
  const removeSeat = useRemoveSeat(workspace.id);
  const revokeInvite = useRevokeInvite(workspace.id);
  const [removing, setRemoving] = useState<{ id: string; email: string; self: boolean } | null>(
    null,
  );
  // Only owners give or take away the admin role and ownership (the API holds the same rule).
  const ownerOnly = (role: SeatRole) => role === 'owner' || role === 'admin';
  const isOwner = workspace.role === 'owner';
  const roleOptions = ASSIGNABLE.filter((role) => !ownerOnly(role) || isOwner);
  // The last owner cannot leave; the API refuses it, so the button is not offered.
  const ownerCount = seats.data?.filter((s) => s.role === 'owner').length ?? 0;

  return (
    <Bands>
      <Band
        title="Team"
        description="Everyone who can open this workspace, and what each of them can do."
      >
        {seats.isPending && <LoadingRows label="Loading team" />}
        {seats.error && <ErrorNotice message={seats.error.message} />}
        {changeRole.error && (
          <div className="mb-3">
            <ErrorNotice title="Role not changed" message={changeRole.error.message} />
          </div>
        )}
        {seats.data && (
          // A region you can reach with Tab, so the keyboard can scroll it on a phone.
          <div
            className="relative overflow-x-auto"
            role="region"
            aria-label="Team table"
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrolling region
            tabIndex={0}
          >
            <table className="w-full min-w-[520px] text-left text-[13.5px]">
              <caption className="sr-only">Team</caption>
              <thead>
                <tr className="table-head">
                  <th scope="col" className="py-2.5 pr-3 font-semibold">
                    Teammate
                  </th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">
                    Role
                  </th>
                  <th scope="col" className="py-2.5 pl-3 text-right font-semibold">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {seats.data.map((seat) => {
                  const self = seat.operator.id === me.operator.id;
                  return (
                    <tr key={seat.id} className="border-t border-line">
                      <td className="py-2.5 pr-3">
                        {seat.operator.name && (
                          <span className="block font-semibold">{seat.operator.name}</span>
                        )}
                        <span className={seat.operator.name ? 'text-[13px] text-sub' : ''}>
                          {seat.operator.email}
                        </span>
                        {self && (
                          <span className="ml-2">
                            <Pill tone="brand">You</Pill>
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {can('admin') && !self && (!ownerOnly(seat.role) || isOwner) ? (
                          <>
                            <label htmlFor={`role-${seat.id}`} className="sr-only">
                              Role for {seat.operator.email}
                            </label>
                            <select
                              id={`role-${seat.id}`}
                              value={seat.role}
                              onChange={(e) =>
                                changeRole.mutate({
                                  seatId: seat.id,
                                  role: e.target.value as SeatRole,
                                })
                              }
                              className="min-h-9 rounded-control border border-line-control bg-surface px-2.5 text-[13.5px]"
                            >
                              {roleOptions.map((role) => (
                                <option key={role} value={role}>
                                  {ROLE_LABEL[role]}
                                </option>
                              ))}
                            </select>
                          </>
                        ) : (
                          ROLE_LABEL[seat.role]
                        )}
                      </td>
                      <td className="py-2.5 pl-3 text-right">
                        {((self && !(seat.role === 'owner' && ownerCount <= 1)) ||
                          (!self && can('admin') && (!ownerOnly(seat.role) || isOwner))) && (
                          <Button
                            variant="quiet"
                            onClick={() =>
                              setRemoving({ id: seat.id, email: seat.operator.email, self })
                            }
                          >
                            {self ? 'Leave' : 'Remove'}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Band>

      {can('admin') && (
        <Band
          title="Invite a teammate"
          description="They get an email with a link to join. It works for 7 days."
        >
          <InviteForm workspaceId={workspace.id} canInviteAdmin={workspace.role === 'owner'} />
        </Band>
      )}

      {can('admin') && !!invites.data?.filter((i) => i.status === 'pending').length && (
        <Band title="Pending invites" description="Invites nobody has accepted yet.">
          <ul className="divide-y divide-line border-y border-line">
            {invites.data
              .filter((invite) => invite.status === 'pending')
              .map((invite) => (
                <li
                  key={invite.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3 text-[13.5px]"
                >
                  <span>
                    {invite.email} · {ROLE_LABEL[invite.role]}
                    <span className="block text-[12px] text-sub">
                      Expires {dateTime.format(new Date(invite.expiresAt))}
                    </span>
                  </span>
                  <Button
                    variant="quiet"
                    loading={revokeInvite.isPending && revokeInvite.variables === invite.id}
                    onClick={() => revokeInvite.mutate(invite.id)}
                  >
                    Withdraw
                  </Button>
                </li>
              ))}
          </ul>
        </Band>
      )}

      <Dialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={removing?.self ? 'Leave this workspace?' : `Remove ${removing?.email ?? ''}?`}
        description={
          removing?.self
            ? 'You will lose access until someone invites you again.'
            : 'They lose access straight away. You can invite them again later.'
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={removeSeat.isPending}
              onClick={() =>
                removing &&
                removeSeat.mutate(removing.id, {
                  onSuccess: () => {
                    if (removing.self) window.location.assign('/');
                    setRemoving(null);
                  },
                })
              }
            >
              {removing?.self ? 'Leave workspace' : 'Remove'}
            </Button>
          </>
        }
      >
        {removing && (
          <RevokedWithSeat workspaceId={workspace.id} seatId={removing.id} self={removing.self} />
        )}
        {removeSeat.error && <ErrorNotice message={removeSeat.error.message} />}
      </Dialog>
    </Bands>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "This also revokes 2 API keys they created": what goes with the seat, counted by the API. */
function RevokedWithSeat({
  workspaceId,
  seatId,
  self,
}: {
  workspaceId: string;
  seatId: string;
  self: boolean;
}) {
  const access = useQuery(seatAccessQuery(workspaceId, seatId));
  if (access.isPending) {
    return <p className="text-[13px] text-sub">Checking their API keys and apps…</p>;
  }
  if (access.error) {
    return (
      <p className="text-[13px] text-sub">
        Any API keys {self ? 'you' : 'they'} created here and apps {self ? 'you' : 'they'} installed
        here are revoked too.
      </p>
    );
  }
  const { apiKeys, apps } = access.data;
  if (apiKeys === 0 && apps === 0) return null;
  const who = self ? 'you' : 'they';
  const parts = [
    apiKeys > 0 ? `${plural(apiKeys, 'API key', 'API keys')} ${who} created` : null,
    apps > 0 ? `${plural(apps, 'app', 'apps')} ${who} installed` : null,
  ].filter(Boolean);
  return (
    <p className="text-[13.5px]" data-testid="revoked-with-seat">
      This also revokes {parts.join(' and ')}. Anything using {apiKeys + apps === 1 ? 'it' : 'them'}{' '}
      stops working at once.
    </p>
  );
}

function InviteForm({
  workspaceId,
  canInviteAdmin,
}: {
  workspaceId: string;
  canInviteAdmin: boolean;
}) {
  const invite = useInvite(workspaceId);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Exclude<SeatRole, 'owner'>>('editor');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const error = invite.error instanceof ApiError ? invite.error : null;
  const roles = (
    ['editor', 'author', 'viewer', ...(canInviteAdmin ? ['admin'] : [])] as Exclude<
      SeatRole,
      'owner'
    >[]
  ).map((value) => ({
    value,
    label: `${ROLE_LABEL[value]}: ${ROLE_HELP[value]}`,
  }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSentTo(null);
    invite.mutate(
      { email, role },
      {
        onSuccess: () => {
          setSentTo(email);
          setEmail('');
        },
      },
    );
  };

  return (
    <form
      onSubmit={submit}
      className="grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end"
      aria-label="Invite a teammate"
    >
      <TextField
        label="Email address"
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={error?.field('email')}
      />
      <SelectField
        label="Role"
        value={role}
        onChange={(e) => setRole(e.target.value as Exclude<SeatRole, 'owner'>)}
        options={roles}
      />
      <Button type="submit" loading={invite.isPending}>
        Send invite
      </Button>
      <p role="status" className="text-[13px] md:col-span-3">
        {sentTo && (
          <span className="text-success">Invite sent to {sentTo}. It expires in 7 days.</span>
        )}
        {error && !error.field('email') && (
          <span className="font-semibold text-danger">{error.message}</span>
        )}
      </p>
    </form>
  );
}

export function deviceName(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Firefox\//.test(userAgent)
      ? 'Firefox'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : 'Browser';
  const os = /Windows/.test(userAgent)
    ? 'Windows'
    : /Mac OS X/.test(userAgent)
      ? 'macOS'
      : /Android/.test(userAgent)
        ? 'Android'
        : /iPhone|iPad/.test(userAgent)
          ? 'iOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : '';
  return os ? `${browser} on ${os}` : browser;
}

export function SessionsSettings() {
  const sessions = useQuery(sessionsQuery);
  const revoke = useRevokeSession();
  const everywhere = useSignOutEverywhere();
  const [confirmAll, setConfirmAll] = useState(false);
  const [signedOut, setSignedOut] = useState<number | null>(null);

  return (
    <section aria-labelledby="devices-title" className="card-app max-w-[720px] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="devices-title" className="text-[16px] font-semibold">
            Signed-in devices
          </h2>
          <p className="mt-1 text-[13px] text-sub">
            Sessions last 30 days from last use. Sign out any device you do not recognise.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setConfirmAll(true)}>
          Sign out everywhere
        </Button>
      </div>
      <p role="status" className="mt-2 text-[13px] text-success">
        {signedOut !== null
          ? `Signed out of ${signedOut} other ${signedOut === 1 ? 'device' : 'devices'}.`
          : ''}
      </p>
      <Dialog
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        title="Sign out everywhere?"
        description="Every other device is signed out straight away. This device stays signed in. If you think someone else has access, also check your second factors in Security."
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirmAll(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={everywhere.isPending}
              onClick={() =>
                everywhere.mutate(true, {
                  onSuccess: ({ revoked }) => {
                    setSignedOut(revoked);
                    setConfirmAll(false);
                  },
                })
              }
            >
              Sign out other devices
            </Button>
          </>
        }
      >
        {everywhere.error && <ErrorNotice message={everywhere.error.message} />}
      </Dialog>
      {sessions.isPending && (
        <div className="mt-4">
          <LoadingRows label="Loading devices" />
        </div>
      )}
      {sessions.error && (
        <div className="mt-4">
          <ErrorNotice message={sessions.error.message} />
        </div>
      )}
      <ul className="mt-3 divide-y divide-line">
        {sessions.data?.map((session) => (
          <li
            key={session.id}
            className="flex flex-wrap items-center justify-between gap-3 py-3.5 text-[13.5px]"
          >
            <span>
              <b>{deviceName(session.userAgent)}</b>{' '}
              {session.current && <Pill tone="brand">This device</Pill>}
              <span className="block text-[12px] text-sub">
                Last active {dateTime.format(new Date(session.lastSeenAt))}
                {session.ipPrefix ? ` · network ${session.ipPrefix}` : ''}
              </span>
            </span>
            {!session.current && (
              <Button
                variant="quiet"
                loading={revoke.isPending && revoke.variables === session.id}
                onClick={() => revoke.mutate(session.id)}
              >
                Sign out
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const ACTION_LABEL: Record<string, string> = {
  'workspace.created': 'Created the workspace',
  'workspace.renamed': 'Renamed the workspace',
  'operator.signed_in': 'Signed in',
  'channel.created': 'Created a publication',
  'channel.updated': 'Updated a publication',
  'channel.deleted': 'Deleted a publication',
  'channel.restored': 'Restored a publication',
  'media.uploaded': 'Uploaded media',
  'media.deleted': 'Deleted media',
  'invite.sent': 'Sent an invite',
  'invite.revoked': 'Withdrew an invite',
  'invite.accepted': 'Joined via invite',
  'seat.role_changed': 'Changed a role',
  'seat.removed': 'Removed a teammate',
  'seat.left': 'Left the workspace',
  'api_key.created': 'Created an API key',
  'api_key.updated': 'Changed an API key',
  'api_key.revoked': 'Revoked an API key',
  'audit.exported': 'Downloaded the audit log',
  'audit.pruned': 'Removed entries past the retention period',
  'webhook.created': 'Added a webhook endpoint',
  'webhook.updated': 'Changed a webhook endpoint',
  'webhook.deleted': 'Deleted a webhook endpoint',
  'webhook.secret_rotated': 'Rotated a webhook secret',
  'webhook.test_sent': 'Sent a test webhook',
  'webhook.redriven': 'Redrove webhook deliveries',
  'seat.provisioned': 'Joined through single sign-on',
  'operator.passkey_added': 'Added a passkey',
  'operator.passkey_removed': 'Removed a passkey',
  'operator.totp_enabled': 'Turned on an authenticator app',
  'operator.totp_disabled': 'Turned off an authenticator app',
  'operator.recovery_codes_regenerated': 'Created new recovery codes',
  'operator.recovery_code_used': 'Used a recovery code',
  'operator.signed_out_everywhere': 'Signed out everywhere',
  'operator.first_factor_undone': 'Undid a new second factor with the email link',
  'feeds.paused_all': 'Paused all outbound feeds',
  'export_destination.paused': 'Paused an export destination',
  'webhook.paused': 'Paused a webhook endpoint',
  'workspace.require_2fa_changed': 'Changed who needs a second factor',
  'sso.connection_created': 'Added an SSO connection',
  'sso.connection_updated': 'Changed an SSO connection',
  'sso.connection_deleted': 'Deleted an SSO connection',
  'sso.domain_verified': 'Verified an SSO domain',
  'sso.domain_removed': 'Released an SSO domain',
};

/** Downloads the log (Phase 7). A POST, because the export is itself audited. */
function AuditExportButtons({ workspaceId }: { workspaceId: string }) {
  const [busy, setBusy] = useState<'csv' | 'jsonl' | null>(null);
  const [failed, setFailed] = useState(false);
  const download = async (format: 'csv' | 'jsonl') => {
    setBusy(format);
    setFailed(false);
    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/audit/export`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ format }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `audit-${new Date().toISOString().slice(0, 10)}.${format}`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <Button variant="ghost" loading={busy === 'csv'} onClick={() => void download('csv')}>
        Download CSV
      </Button>
      <Button variant="ghost" loading={busy === 'jsonl'} onClick={() => void download('jsonl')}>
        Download JSONL
      </Button>
      <p role="status" className="text-[13px] font-semibold text-danger">
        {failed ? 'The download didn’t work. Try again.' : ''}
      </p>
    </>
  );
}

export function AuditSettings() {
  const { workspace, can } = useSession();
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const audit = useQuery({ ...auditQuery(workspace.id, cursor), enabled: can('admin') });
  const [verification, setVerification] = useState<{ ok: boolean; checked: number } | null>(null);
  const [verifying, setVerifying] = useState(false);

  if (!can('admin')) {
    return (
      <EmptyState title="Admins only">
        Ask an owner or admin if you need to see the audit log.
      </EmptyState>
    );
  }

  const verify = async () => {
    setVerifying(true);
    try {
      setVerification(await verifyChain(`/api/v1/workspaces/${workspace.id}/audit/verify`));
    } finally {
      setVerifying(false);
    }
  };

  return (
    <section aria-labelledby="audit-title" className="card-app overflow-x-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
        <div>
          <h2 id="audit-title" className="text-[16px] font-semibold">
            Audit log
          </h2>
          <p className="text-[13px] text-sub">
            Every change in this workspace, chained so edits to past entries are detectable.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <p role="status" className="text-[13px]">
            {verification &&
              (verification.ok ? (
                <span className="text-success">
                  Intact · {verification.checked} entries checked
                </span>
              ) : (
                <span className="font-semibold text-danger">Altered entries found</span>
              ))}
          </p>
          <Button variant="ghost" loading={verifying} onClick={() => void verify()}>
            Verify log
          </Button>
          <AuditExportButtons workspaceId={workspace.id} />
        </div>
      </div>
      {audit.isPending && (
        <div className="p-5">
          <LoadingRows label="Loading audit log" rows={5} />
        </div>
      )}
      {audit.error && (
        <div className="p-5">
          <ErrorNotice message={audit.error.message} />
        </div>
      )}
      {audit.data && (
        <ol className="mt-3 divide-y divide-line border-t border-line sm:hidden">
          {audit.data.items.map((event) => (
            <li key={event.id} className="px-5 py-3 text-[13.5px]">
              <span className="font-semibold">{ACTION_LABEL[event.action] ?? event.action}</span>
              <span className="mt-0.5 block text-[12.5px] break-all text-sub">
                {event.actor?.email ?? 'System'} ·{' '}
                <span className="tabular">{dateTime.format(new Date(event.createdAt))}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
      {audit.data && (
        <table className="mt-3 w-full text-left text-[13.5px] max-sm:hidden">
          <thead>
            <tr className="table-head">
              <th scope="col" className="px-5 py-2.5 font-semibold">
                When
              </th>
              <th scope="col" className="px-3 py-2.5 font-semibold">
                Who
              </th>
              <th scope="col" className="px-5 py-2.5 font-semibold">
                What
              </th>
            </tr>
          </thead>
          <tbody>
            {audit.data.items.map((event) => (
              <tr key={event.id} className="border-t border-line">
                <td className="tabular px-5 py-3 whitespace-nowrap text-sub">
                  {dateTime.format(new Date(event.createdAt))}
                </td>
                <td className="px-3 py-3">{event.actor?.email ?? 'System'}</td>
                <td className="px-5 py-3">{ACTION_LABEL[event.action] ?? event.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex justify-between gap-2 p-4">
        <Button
          variant="ghost"
          disabled={cursors.length < 2}
          onClick={() => setCursors((c) => c.slice(0, -1))}
        >
          Newer
        </Button>
        <Button
          variant="ghost"
          disabled={!audit.data?.nextCursor}
          onClick={() => audit.data?.nextCursor && setCursors((c) => [...c, audit.data.nextCursor])}
        >
          Older
        </Button>
      </div>
    </section>
  );
}
