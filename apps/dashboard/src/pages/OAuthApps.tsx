// Settings → Developers → OAuth apps: apps this workspace registered (client id, redirect URIs,
// scopes, a secret shown once) and the apps other developers were authorised to use here.
// Admins and owners only; the API refuses everyone else.
import { OAUTH_MAX_REDIRECT_URIS, type OAuthApp, type OAuthGrant } from '@swarm/domain';
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
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import {
  oauthAppsQuery,
  oauthGrantsQuery,
  useCreateOAuthApp,
  useRevokeOAuthApp,
  useRevokeOAuthGrant,
  useRotateOAuthSecret,
  useUpdateOAuthApp,
} from '../api/oauth';
import { useSession } from '../session';
import { accessOf, allScopesOf, ScopePicker, type AccessMap } from './ScopePicker';

const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export function OAuthAppsSettings() {
  const { workspace, can } = useSession();
  if (!can('admin')) {
    return (
      <EmptyState title="Admins manage OAuth apps">
        Ask an admin or owner of {workspace.name} to register an app or review authorised apps.
      </EmptyState>
    );
  }
  return (
    <div className="grid gap-6">
      <RegisteredApps workspaceId={workspace.id} />
      <AuthorisedApps workspaceId={workspace.id} />
    </div>
  );
}

function RegisteredApps({ workspaceId }: { workspaceId: string }) {
  const apps = useQuery(oauthAppsQuery(workspaceId));
  const [editing, setEditing] = useState<OAuthApp | 'new' | null>(null);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [revoking, setRevoking] = useState<OAuthApp | null>(null);
  const rotate = useRotateOAuthSecret(workspaceId);
  const revoke = useRevokeOAuthApp(workspaceId);

  return (
    <section aria-labelledby="oauth-apps-title" className="card-app overflow-x-auto p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="oauth-apps-title" className="text-[16px] font-semibold">
            OAuth apps
          </h2>
          <p className="mt-1 max-w-[560px] text-[13px] text-sub">
            Apps you build for other workspaces. Each one asks an admin for permission, then calls
            the API with its own token. PKCE is required for every app.
          </p>
        </div>
        <Button onClick={() => setEditing('new')}>Register an app</Button>
      </div>

      {apps.isPending && (
        <div className="mt-4">
          <LoadingRows label="Loading OAuth apps" />
        </div>
      )}
      {apps.error && (
        <div className="mt-4">
          <ErrorNotice message={apps.error.message} />
        </div>
      )}
      {rotate.error && (
        <div className="mt-4">
          <ErrorNotice title="Secret not replaced" message={rotate.error.message} />
        </div>
      )}
      {apps.data && apps.data.length === 0 && (
        <p className="mt-4 text-[13.5px] text-sub">No apps yet.</p>
      )}
      {apps.data && apps.data.length > 0 && (
        <ul className="mt-3 divide-y divide-line">
          {apps.data.map((app) => (
            <li key={app.id} className="flex flex-wrap items-start justify-between gap-3 py-3.5">
              <div className="min-w-0 text-[13.5px]">
                <b>{app.name}</b>{' '}
                <Pill tone={app.clientType === 'confidential' ? 'brand' : 'neutral'}>
                  {app.clientType === 'confidential' ? 'Confidential' : 'Public'}
                </Pill>
                <span className="block font-mono text-[12px] break-all text-sub">
                  {app.clientId}
                </span>
                <span className="block text-[12px] text-sub">
                  {app.scopes.length} {app.scopes.length === 1 ? 'scope' : 'scopes'} ·{' '}
                  {app.redirectUris.length} redirect{' '}
                  {app.redirectUris.length === 1 ? 'URI' : 'URIs'} · registered{' '}
                  {date.format(new Date(app.createdAt))}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" size="sm" onClick={() => setEditing(app)}>
                  Edit
                </Button>
                {app.clientType === 'confidential' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={rotate.isPending && rotate.variables === app.id}
                    onClick={() =>
                      rotate.mutate(app.id, {
                        onSuccess: (result) =>
                          setSecret({ name: app.name, value: result.clientSecret ?? '' }),
                      })
                    }
                  >
                    Replace secret
                  </Button>
                )}
                <Button variant="quiet" size="sm" onClick={() => setRevoking(app)}>
                  Revoke
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <AppDialog
          workspaceId={workspaceId}
          app={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onCreated={(name, value) => setSecret({ name, value })}
        />
      )}

      <Dialog
        open={!!secret}
        onClose={() => setSecret(null)}
        title="Copy the client secret"
        description={
          <>
            This is the only time the secret for <b>{secret?.name}</b> is shown. Store it on your
            server; it never belongs in a browser or mobile app.
          </>
        }
        actions={<Button onClick={() => setSecret(null)}>I have stored it</Button>}
      >
        <TextField
          label="Client secret"
          readOnly
          value={secret?.value ?? ''}
          onFocus={(e) => e.target.select()}
          className="font-mono"
        />
      </Dialog>

      <Dialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        title={`Revoke ${revoking?.name ?? 'this app'}?`}
        description="Every workspace that authorised it loses access at once, and its tokens stop working. This cannot be undone."
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
              Revoke app
            </Button>
          </>
        }
      >
        {revoke.error && <ErrorNotice message={revoke.error.message} />}
      </Dialog>
    </section>
  );
}

function AppDialog({
  workspaceId,
  app,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  app: OAuthApp | null;
  onClose: () => void;
  onCreated: (name: string, secret: string) => void;
}) {
  const create = useCreateOAuthApp(workspaceId);
  const update = useUpdateOAuthApp(workspaceId);
  const [name, setName] = useState(app?.name ?? '');
  const [homepage, setHomepage] = useState(app?.homepageUrl ?? '');
  const [clientType, setClientType] = useState<'public' | 'confidential'>(
    app?.clientType ?? 'confidential',
  );
  const [uris, setUris] = useState(app?.redirectUris.join('\n') ?? '');
  const [access, setAccess] = useState<AccessMap>(accessOf(app?.scopes ?? []));
  const scopes = allScopesOf(access);
  const mutation = app ? update : create;
  const error = mutation.error instanceof ApiError ? mutation.error : null;
  const uriError =
    error?.details.find((d) => d.path.startsWith('redirectUris'))?.message ?? undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const redirectUris = uris
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const body = {
      name,
      redirectUris,
      scopes,
      homepageUrl: homepage.trim() || null,
    };
    if (app) {
      update.mutate({ id: app.id, ...body }, { onSuccess: onClose });
    } else {
      create.mutate(
        { ...body, clientType },
        {
          onSuccess: (result) => {
            onClose();
            if (result.clientSecret) onCreated(result.app.name, result.clientSecret);
          },
        },
      );
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={app ? `Edit ${app.name}` : 'Register an OAuth app'}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="oauth-app-form" loading={mutation.isPending}>
            {app ? 'Save' : 'Register'}
          </Button>
        </>
      }
    >
      <form id="oauth-app-form" onSubmit={submit} className="grid gap-4">
        <TextField
          label="App name"
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={error?.field('name')}
          hint="Shown to admins when the app asks for permission."
        />
        <TextField
          label="Homepage"
          type="url"
          value={homepage}
          onChange={(e) => setHomepage(e.target.value)}
          error={error?.field('homepageUrl')}
        />
        {!app && (
          <SelectField
            label="Client type"
            value={clientType}
            onChange={(e) => setClientType(e.target.value as 'public' | 'confidential')}
            options={[
              { value: 'confidential', label: 'Confidential: runs on a server, has a secret' },
              { value: 'public', label: 'Public: runs in a browser or on a device, no secret' },
            ]}
          />
        )}
        <TextAreaField
          label="Redirect URIs"
          required
          value={uris}
          onChange={(e) => setUris(e.target.value)}
          error={uriError ?? error?.field('redirectUris')}
          hint={`One per line, up to ${OAUTH_MAX_REDIRECT_URIS}. Matched exactly; https only, no wildcards or fragments.`}
        />
        <fieldset className="grid gap-1.5">
          <legend className="mb-1.5 text-[13px] font-semibold">What the app may ask for</legend>
          <ScopePicker value={access} onChange={setAccess} />
          <p className="text-[12.5px] text-sub">
            {scopes.length > 0 ? (
              <>
                Request these in your authorization URL:{' '}
                <code className="font-mono text-[12px] break-words">{scopes.join(' ')}</code>
              </>
            ) : (
              'Nothing yet. Choose what the app needs.'
            )}
          </p>
          {error?.field('scopes') && (
            <p role="alert" className="text-[12.5px] font-semibold text-danger">
              {error.field('scopes')}
            </p>
          )}
        </fieldset>
        {error && !error.details.length && <ErrorNotice message={error.message} />}
      </form>
    </Dialog>
  );
}

function AuthorisedApps({ workspaceId }: { workspaceId: string }) {
  const grants = useQuery(oauthGrantsQuery(workspaceId));
  const revoke = useRevokeOAuthGrant(workspaceId);
  const [revoking, setRevoking] = useState<OAuthGrant | null>(null);

  return (
    <section aria-labelledby="authorised-apps-title" className="card-app p-5">
      <h2 id="authorised-apps-title" className="text-[16px] font-semibold">
        Authorised apps
      </h2>
      <p className="mt-1 text-[13px] text-sub">
        Apps an admin allowed to use this workspace. Revoking one stops it at once.
      </p>
      {grants.isPending && (
        <div className="mt-4">
          <LoadingRows label="Loading authorised apps" />
        </div>
      )}
      {grants.error && (
        <div className="mt-4">
          <ErrorNotice message={grants.error.message} />
        </div>
      )}
      {grants.data && grants.data.length === 0 && (
        <p className="mt-4 text-[13.5px] text-sub">No apps are authorised.</p>
      )}
      {grants.data && grants.data.length > 0 && (
        <ul className="mt-3 divide-y divide-line">
          {grants.data.map((grant) => (
            <li
              key={grant.id}
              className="flex flex-wrap items-start justify-between gap-3 py-3.5 text-[13.5px]"
            >
              <div className="min-w-0">
                <span className="flex flex-wrap items-center gap-1.5">
                  <b>{grant.app.name}</b>
                  {grant.app.clientUrl && <Pill tone="danger">Unverified</Pill>}
                  <Pill tone="brand">{grant.resource === 'mcp' ? 'MCP server' : 'API'}</Pill>
                </span>
                {grant.app.clientUrl && (
                  <span className="block break-all text-[12px] text-sub">
                    Client metadata from {new URL(grant.app.clientUrl).host}
                  </span>
                )}
                <span className="block text-[12px] text-sub">
                  {grant.channelIds
                    ? `${grant.channelIds.length} ${grant.channelIds.length === 1 ? 'publication' : 'publications'}`
                    : 'Every publication'}{' '}
                  · authorised {date.format(new Date(grant.createdAt))}
                  {grant.authorisedBy ? ` by ${grant.authorisedBy}` : ''}
                  {grant.lastUsedAt
                    ? ` · last used ${date.format(new Date(grant.lastUsedAt))}`
                    : ' · not used yet'}
                </span>
                <span className="mt-1 flex flex-wrap gap-1">
                  {grant.scopes.map((scope) => (
                    <Pill key={scope}>{scope}</Pill>
                  ))}
                </span>
              </div>
              <Button variant="quiet" size="sm" onClick={() => setRevoking(grant)}>
                Revoke access
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        title={`Revoke access for ${revoking?.app.name ?? 'this app'}?`}
        description="Its tokens stop working at once. The app has to ask an admin again to get back in."
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
              Revoke access
            </Button>
          </>
        }
      >
        {revoke.error && <ErrorNotice message={revoke.error.message} />}
      </Dialog>
    </section>
  );
}
