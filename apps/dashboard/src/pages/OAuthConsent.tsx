// The OAuth consent page (/oauth/consent), reached from /oauth/authorize. The signed-in operator
// picks one of their workspaces where they are admin or owner, optionally limits the app to some
// Channels, reviews the scopes and allows or denies. The server checks the request again on both
// the read and the decision; this page only shows it. A Client ID Metadata Document client (an
// MCP client that names itself with a URL) is marked unverified, with the host that describes
// it; a registered app is "Verified" only when its App Directory listing was approved, and
// otherwise just names the workspace that registered it; a loopback redirect gets a warning.
// Contract: docs/oauth.md.
import { PRODUCT_NAME, type AuthorizeParams } from '@swarm/domain';
import {
  Button,
  Checkbox,
  ErrorNotice,
  LoadingRows,
  Pill,
  SelectField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { consentQuery, useConsent } from '../api/oauth';
import * as Icon from '../icons';

const STORAGE_KEY = 'swarm:oauth-consent';

/** Keeps the request across sign-in, whose return path is too short for every request. */
export function stashConsentParams(params: AuthorizeParams): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(params));
  } catch {
    // Storage can be blocked; the app then has to start again after sign-in.
  }
}

function clearConsentParams(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing was stored.
  }
}

export function stashedConsentParams(): AuthorizeParams | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AuthorizeParams) : null;
  } catch {
    return null;
  }
}

function ConsentCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main id="main" className="grid min-h-screen place-items-center px-4 py-12">
      <div className="w-full max-w-[480px]">
        <p className="mb-6 flex items-center justify-center gap-2.5 text-[17px] font-bold">
          <span className="grid size-8 place-items-center rounded-control bg-rail">
            <Icon.LineMark size={22} />
          </span>
          {PRODUCT_NAME}
        </p>
        <section className="card-app p-7 shadow-card">
          <h1 className="text-[22px] leading-[1.2] font-semibold tracking-[-0.01em]">{title}</h1>
          {children}
        </section>
      </div>
    </main>
  );
}

export function OAuthConsentPage({ params }: { params: AuthorizeParams }) {
  const info = useQuery(consentQuery(params));
  const decide = useConsent();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [limit, setLimit] = useState(false);
  const [channels, setChannels] = useState<Set<string>>(new Set());

  if (info.isPending) {
    return (
      <ConsentCard title="Checking the request">
        <div className="mt-4">
          <LoadingRows label="Checking the request" />
        </div>
      </ConsentCard>
    );
  }
  if (info.error) {
    return (
      <ConsentCard title="This request does not work">
        <p className="mt-3 text-[14px] leading-[1.55] text-sub">{info.error.message}</p>
        <p className="mt-3 text-[13px] text-sub">
          Go back to the app and try again, or contact its developer.
        </p>
      </ConsentCard>
    );
  }

  const { app, scopes, workspaces, resource } = info.data;
  const chosen = workspaces.find((w) => w.id === workspaceId) ?? workspaces[0] ?? null;
  const submit = (decision: 'allow' | 'deny') => {
    clearConsentParams();
    decide.mutate(
      {
        ...params,
        decision,
        ...(chosen ? { workspaceId: chosen.id } : {}),
        channelIds: limit && channels.size ? [...channels] : null,
      },
      { onSuccess: ({ redirectUrl }) => window.location.assign(redirectUrl) },
    );
  };
  const toggle = (id: string, on: boolean) =>
    setChannels((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <ConsentCard title={`Allow ${app.name} to use ${PRODUCT_NAME}?`}>
      {app.clientHost === null ? (
        <p className="mt-2 text-[13.5px] leading-[1.55] text-sub">
          {app.verified && (
            <>
              <Pill tone="success">Verified</Pill>{' '}
            </>
          )}
          Registered by {app.registeredBy}
          {app.homepageUrl ? (
            <>
              {' · '}
              <a href={app.homepageUrl} target="_blank" rel="noreferrer noopener">
                {new URL(app.homepageUrl).host}
              </a>
            </>
          ) : null}
          .{' '}
          {app.verified
            ? `${PRODUCT_NAME} reviewed this app for the App Directory.`
            : `${PRODUCT_NAME} has not reviewed this app; the name is the one its developer chose.`}{' '}
          After you decide, you go back to <b className="text-ink">{app.redirectHost}</b>.
        </p>
      ) : (
        <div
          role="note"
          className="mt-3 rounded-[10px] border border-danger-soft bg-danger-soft p-3.5 text-[13.5px] leading-[1.55]"
        >
          <p className="flex flex-wrap items-center gap-2">
            <Pill tone="danger">Unverified app</Pill>
            <span>
              Described by <b className="break-all">{app.clientHost}</b>
            </span>
          </p>
          <p className="mt-2 text-sub">
            Nobody has checked this app. Its name and links come from a file on{' '}
            <b className="text-ink">{app.clientHost}</b>, which anyone can publish. Allow it only if
            you started this connection yourself and trust that site.
          </p>
          <p className="mt-2 text-sub">
            After you decide, you go back to{' '}
            <b className="break-all text-ink">{app.redirectHost}</b>.
          </p>
        </div>
      )}
      {app.localRedirect && (
        <p className="mt-3 text-[13px] leading-[1.5] text-sub">
          This app runs on your own computer: the answer goes to{' '}
          <b className="text-ink">{app.redirectHost}</b>. Any program on this computer could receive
          it, so allow it only if you just started the app here.
        </p>
      )}
      <p className="mt-3 text-[13px] text-sub">
        Access to:{' '}
        <b className="text-ink">
          {resource === 'mcp'
            ? `the ${PRODUCT_NAME} MCP server (AI agents)`
            : `the ${PRODUCT_NAME} API`}
        </b>
        {resource === 'mcp' &&
          '. Its changes follow your workspace’s approval rules: sends and deletions wait for a person.'}
      </p>
      {resource !== 'mcp' && !app.verified && (
        <p role="note" className="mt-2 text-[13px] leading-[1.5] text-sub">
          An app that has not been reviewed can only use the MCP server, where your approval rules
          hold its calls, unless your own workspace registered it. Allowing direct API access to it
          will be refused.
        </p>
      )}

      <h2 className="mt-5 text-[14px] font-semibold">It will be able to</h2>
      <ul className="mt-2 grid gap-1.5 text-[13.5px]">
        {scopes.map((s) => (
          <li key={s.scope} className="flex items-start gap-2">
            <span aria-hidden className="mt-[7px] size-1.5 shrink-0 rounded-full bg-purple" />
            <span>
              {s.label} <span className="font-mono text-[11.5px] text-sub">{s.scope}</span>
            </span>
          </li>
        ))}
      </ul>

      {workspaces.length === 0 ? (
        <p className="mt-5 text-[13.5px] text-sub">
          You need the admin or owner role on a workspace to allow apps. Ask an admin of your
          workspace, or deny the request.
        </p>
      ) : (
        <div className="mt-5 grid gap-4">
          {workspaces.length > 1 ? (
            <SelectField
              label="Workspace"
              value={chosen?.id ?? ''}
              onChange={(e) => {
                setWorkspaceId(e.target.value);
                setChannels(new Set());
              }}
              options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
            />
          ) : (
            <p className="text-[13.5px]">
              Workspace: <b>{chosen?.name}</b>
            </p>
          )}
          {chosen && chosen.channels.length > 0 && (
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-[13px] font-semibold">Publications</legend>
              <Checkbox
                label="Only some publications"
                hint="Without this, the app reaches every publication, including ones created later."
                checked={limit}
                onChange={setLimit}
              />
              {limit &&
                chosen.channels.map((ch) => (
                  <div key={ch.id} className="pl-6">
                    <Checkbox
                      label={ch.name}
                      checked={channels.has(ch.id)}
                      onChange={(on) => toggle(ch.id, on)}
                    />
                  </div>
                ))}
            </fieldset>
          )}
        </div>
      )}

      {decide.error && (
        <div className="mt-4">
          <ErrorNotice title="Not saved" message={decide.error.message} />
        </div>
      )}
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button
          variant="ghost"
          loading={decide.isPending && decide.variables?.decision === 'deny'}
          onClick={() => submit('deny')}
        >
          Deny
        </Button>
        {workspaces.length > 0 && (
          <Button
            loading={decide.isPending && decide.variables?.decision === 'allow'}
            disabled={limit && channels.size === 0}
            onClick={() => submit('allow')}
          >
            Allow
          </Button>
        )}
      </div>
    </ConsentCard>
  );
}
