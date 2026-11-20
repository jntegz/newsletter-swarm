// Connecting Shorthop to this workspace, from its card on the Apps page: writers can then shorten
// the links in a post. Contract: docs/applications.md.
import {
  SLUG_FORMAT_DEFAULT,
  SlugFormatSchema,
  renderSlug,
  type ShorthopConnection,
} from '@swarm/domain';
import { Button, ErrorNotice, LoadingRows, TextField } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  shorthopConnectionQuery,
  useConnectShorthop,
  useDisconnectShorthop,
  useUpdateShorthop,
} from '../api/applications';
import { ApiError } from '../api/client';
import { useSession } from '../session';

const EXAMPLE = {
  publication: 'Field Notes',
  post: 'The slow web, revisited',
  url: 'https://example.com/article',
  random: 'x7k2q9',
  now: Date.UTC(2026, 10, 4),
};

function SlugFormatField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
}) {
  const parsed = SlugFormatSchema.safeParse(value);
  const problem = error ?? (value && !parsed.success ? parsed.error.issues[0]?.message : undefined);
  return (
    <div className="grid gap-1.5">
      <TextField
        label="Slug format"
        value={value}
        maxLength={64}
        className="font-mono text-[13px]"
        onChange={(e) => onChange(e.target.value)}
        error={problem}
        hint="The part of the link after the domain. You can use {publication}, {post}, {date}, {domain} and {random}."
      />
      {parsed.success && (
        <p className="text-[12.5px] break-all text-sub">
          For example: <code>{renderSlug(parsed.data, EXAMPLE)}</code>
        </p>
      )}
    </div>
  );
}

function ConnectForm({ workspaceId }: { workspaceId: string }) {
  const connect = useConnectShorthop(workspaceId);
  const [baseUrl, setBaseUrl] = useState('https://');
  const [apiKey, setApiKey] = useState('');
  const [slugFormat, setSlugFormat] = useState(SLUG_FORMAT_DEFAULT);
  const [domain, setDomain] = useState('');
  const error = connect.error instanceof ApiError ? connect.error : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    connect.mutate({
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      slugFormat: slugFormat.trim(),
      domain: domain.trim() || null,
    });
  };

  return (
    <form onSubmit={submit} className="grid max-w-[520px] gap-4" aria-label="Connect Shorthop">
      <TextField
        label="Shorthop address"
        type="url"
        required
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        error={error?.field('baseUrl')}
        hint="Where your Shorthop runs. Swarm uses its MCP server, at /api/mcp."
      />
      <TextField
        label="API key"
        type="password"
        required
        autoComplete="off"
        value={apiKey}
        placeholder="shp_…"
        onChange={(e) => setApiKey(e.target.value)}
        error={error?.field('apiKey')}
        hint="Create one in Shorthop under Settings → API, MCP & webhooks, allowed to read and create links. It’s stored encrypted and never shown again."
      />
      <SlugFormatField
        value={slugFormat}
        onChange={setSlugFormat}
        error={error?.field('slugFormat')}
      />
      <TextField
        label="Short domain (optional)"
        value={domain}
        placeholder="go.example.com"
        onChange={(e) => setDomain(e.target.value)}
        error={error?.field('domain')}
        hint="Leave empty to use your Shorthop’s primary domain."
      />
      {error && !error.details.length && <ErrorNotice message={error.message} />}
      <Button type="submit" className="justify-self-start" loading={connect.isPending}>
        Connect Shorthop
      </Button>
    </form>
  );
}

function Connected({
  workspaceId,
  connection,
}: {
  workspaceId: string;
  connection: ShorthopConnection;
}) {
  const update = useUpdateShorthop(workspaceId);
  const disconnect = useDisconnectShorthop(workspaceId);
  const [slugFormat, setSlugFormat] = useState(connection.slugFormat);
  const [domain, setDomain] = useState(connection.domain ?? '');
  const [confirming, setConfirming] = useState(false);
  const error = update.error instanceof ApiError ? update.error : null;

  return (
    <div className="grid max-w-[520px] gap-4">
      <p className="text-[13.5px] leading-[1.5]">
        Connected to <b className="break-all">{connection.baseUrl}</b>, with the key ending in{' '}
        <code>{connection.last4}</code>. Writers now get <b>Shorten link</b> when they add a link,
        and <b>Shorten all links</b> in a post’s toolbar.
      </p>
      <form
        className="grid gap-4"
        aria-label="Shorthop settings"
        onSubmit={(event) => {
          event.preventDefault();
          update.mutate({ slugFormat: slugFormat.trim(), domain: domain.trim() || null });
        }}
      >
        <SlugFormatField
          value={slugFormat}
          onChange={setSlugFormat}
          error={error?.field('slugFormat')}
        />
        <TextField
          label="Short domain (optional)"
          value={domain}
          placeholder="go.example.com"
          onChange={(e) => setDomain(e.target.value)}
          error={error?.field('domain')}
          hint="Applies to new links. Links already made keep their address."
        />
        {error && !error.details.length && <ErrorNotice message={error.message} />}
        {update.isSuccess && <p role="status">Saved.</p>}
        <Button type="submit" className="justify-self-start" loading={update.isPending}>
          Save
        </Button>
      </form>
      <div className="border-t border-line pt-4">
        {confirming ? (
          <div role="group" aria-labelledby="disconnect-q" className="grid gap-3">
            <p id="disconnect-q" className="text-[13.5px]">
              Disconnect Shorthop? Links already in posts keep working, because they live in your
              Shorthop.
            </p>
            <div className="flex gap-2">
              <Button
                variant="danger"
                size="sm"
                loading={disconnect.isPending}
                onClick={() => disconnect.mutate(undefined)}
              >
                Disconnect
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Keep it
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
            Disconnect Shorthop
          </Button>
        )}
      </div>
    </div>
  );
}

/** The connect form, or the settings of the connection. Admins only: the API refuses others. */
export function ShorthopPanel() {
  const { workspace } = useSession();
  const connection = useQuery(shorthopConnectionQuery(workspace.id));

  if (connection.isPending) return <LoadingRows label="Loading Shorthop" rows={2} />;
  if (connection.error) return <ErrorNotice message={connection.error.message} />;
  return connection.data.connected ? (
    <Connected
      key={connection.data.updatedAt}
      workspaceId={workspace.id}
      connection={connection.data}
    />
  ) : (
    <ConnectForm workspaceId={workspace.id} />
  );
}
