// OAuth consent for a Client ID Metadata Document client (an MCP client that names itself with
// the https URL of a JSON document, docs/oauth.md): the consent page marks it "Unverified app"
// with the host that describes it and warns about a redirect to this computer; allowing it sends
// the browser back with a code. The api worker would fetch the document from the internet, so
// this story puts a fresh copy in its document cache instead. axe runs on the consent page.
import { expect, test } from '@playwright/test';
import { expectAccessible, localSql, signIn } from './helpers';

const REDIRECT = 'http://127.0.0.1:33418/callback';

test('an operator sees an unverified metadata-document client on the consent page and allows it', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const host = `agent-${stamp.toString(36)}.example`;
  const clientId = `https://${host}/oauth/client.json`;
  localSql(
    `INSERT INTO oauth_client_documents (url, status, name, client_uri, redirect_uris_json, error, fetched_by, fetched_at, expires_at) VALUES ('${clientId}', 'ok', 'Agent Desk', 'https://${host}', '${JSON.stringify([REDIRECT])}', NULL, NULL, ${stamp}, ${stamp + 3_600_000})`,
  );

  await page.goto('/');
  await signIn(page, request, `oauth-${stamp}@example.com`);
  const params = new URLSearchParams({
    client_id: clientId,
    // A loopback redirect matches on any port (RFC 8252), since native clients pick one each time.
    redirect_uri: 'http://127.0.0.1:40123/callback',
    response_type: 'code',
    scope: 'members:read',
    state: `s${stamp}`,
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  });

  // Asked for the API (no resource means /v2), an app nobody reviewed is told it gets the MCP
  // server only: allowing direct API access to it would be refused.
  await page.goto(`/oauth/consent?${params}`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Allow Agent Desk to use Swarm?' }),
  ).toBeVisible();
  await expect(
    page.getByRole('note').filter({ hasText: 'can only use the MCP server' }),
  ).toBeVisible();

  // As an MCP client, it asks for the MCP server.
  params.set('resource', `${new URL(page.url()).origin}/mcp`);
  await page.goto(`/oauth/consent?${params}`);

  await expect(
    page.getByRole('heading', { level: 1, name: 'Allow Agent Desk to use Swarm?' }),
  ).toBeVisible();
  const note = page.getByRole('note');
  await expect(note.getByText('Unverified app', { exact: true })).toBeVisible();
  await expect(note.getByText(`Described by ${host}`)).toBeVisible();
  await expect(note).toContainText('Nobody has checked this app.');
  await expect(page.getByText('This app runs on your own computer')).toBeVisible();
  await expect(page.getByText('members:read', { exact: true })).toBeVisible();
  await expect(page.getByText('the Swarm MCP server (AI agents)')).toBeVisible();
  await expectAccessible(page);

  // Allowing it sends the browser back to the app with a code and the same state.
  await page.route('http://127.0.0.1:40123/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Agent Desk</title><p>Connected.</p>',
    }),
  );
  await page.getByRole('button', { name: 'Allow' }).click();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:40123\/callback\?/);
  const back = new URL(page.url());
  expect(back.searchParams.get('state')).toBe(`s${stamp}`);
  expect(back.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
});
