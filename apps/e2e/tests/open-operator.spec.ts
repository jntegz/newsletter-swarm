// Open Operator (Phase 8): an agent connected over MCP asks to delete a Member, the call is held,
// and the owner reviews the exact request and approves it in Settings → Developers. axe runs on
// each state.
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_PORT } from '../workers';
import { API, addAuthenticatorApp, enableWorkspaceFlag, expectAccessible, signIn } from './helpers';

const DASHBOARD = `http://localhost:${DASHBOARD_PORT}`;

async function api<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(`${DASHBOARD}${path}`, {
    method,
    headers: { origin: DASHBOARD, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { data }),
  });
  expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
  return ((await res.json()) as { data: T }).data;
}

test('an agent’s destructive call waits for approval, and the owner approves it', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  await page.goto('/');
  await signIn(page, request, `operator-${stamp}@example.com`);
  // An API key gives standing access, so it needs a second factor of the operator's own, and a
  // fresh check with it: adding the first one is that check.
  await addAuthenticatorApp(page);
  const me = await api<{ workspaces: { id: string }[] }>(page, 'GET', '/api/v1/auth/session');
  const workspaceId = me.workspaces[0]!.id;
  // Copilot stays off: approvals belong to the MCP server.
  enableWorkspaceFlag('open_operator_mcp', workspaceId);
  const channel = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/workspaces/${workspaceId}/channels`,
    {
      name: 'Field Notes',
      slug: `agent-${stamp.toString(36)}`,
    },
  );
  const member = await api<{ id: string }>(page, 'POST', `/api/v1/channels/${channel.id}/members`, {
    email: `reader-${stamp}@example.org`,
    consent: true,
  });
  const { secret } = await api<{ secret: string }>(
    page,
    'POST',
    `/api/v1/workspaces/${workspaceId}/api-keys`,
    { name: 'Agent', scopes: ['members:write', 'channels:read'] },
  );

  // The agent's call, as an MCP client sends it.
  const params = {
    name: 'delete_member',
    arguments: { channelId: channel.id, memberId: member.id },
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'E2E agent', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  };
  const held = await request.post(`${API}/mcp`, {
    headers: {
      authorization: `Bearer ${secret}`,
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': 'delete_member',
    },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params },
  });
  expect(held.status()).toBe(200);
  const body = (await held.json()) as { result: { structuredContent: { status: string } } };
  expect(body.result.structuredContent.status).toBe('pending_approval');

  await page.goto('/settings/developers/open-operator');
  await expect(page.getByRole('heading', { name: 'MCP server' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Waiting for approval' })).toBeVisible();
  await expect(page.getByText('delete_member').first()).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Review' }).click();
  const dialog = page.getByRole('dialog', { name: 'Approve this call?' });
  await expect(
    dialog.getByText(`DELETE /v2/channels/${channel.id}/members/${member.id}`),
  ).toBeVisible();
  await expectAccessible(page);
  await dialog.getByRole('button', { name: 'Approve and run' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Nothing is waiting' })).toBeVisible();

  // The activity log shows the held call and the approved run, and the chain verifies.
  await expect(page.getByRole('table').getByText('Held for approval')).toBeVisible();
  await expect(page.getByText('delete_member (approved)')).toBeVisible();
  await expect(page.getByText('Chain verified')).toBeVisible();
  await expectAccessible(page);
});

test('an agent reads the publication context and its draft is marked as agent work', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  await page.goto('/');
  await signIn(page, request, `operator-${stamp}@example.com`);
  // An API key gives standing access, so it needs a second factor of the operator's own, and a
  // fresh check with it: adding the first one is that check.
  await addAuthenticatorApp(page);
  const me = await api<{ workspaces: { id: string }[] }>(page, 'GET', '/api/v1/auth/session');
  const workspaceId = me.workspaces[0]!.id;
  enableWorkspaceFlag('open_operator_mcp', workspaceId);
  const channel = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/workspaces/${workspaceId}/channels`,
    { name: 'Field Notes', slug: `ctx-${stamp.toString(36)}` },
  );
  await api(page, 'PATCH', `/api/v1/channels/${channel.id}`, {
    styleGuide: 'Plain sentences. One idea per post.',
  });
  const { secret } = await api<{ secret: string }>(
    page,
    'POST',
    `/api/v1/workspaces/${workspaceId}/api-keys`,
    { name: 'Writer agent', scopes: ['channels:read', 'dispatches:write'] },
  );

  // The agent reads the context pack first: the style guide the operator wrote comes back.
  const call = async (tool: string, args: Record<string, unknown>) => {
    const res = await request.post(`${API}/mcp`, {
      headers: {
        authorization: `Bearer ${secret}`,
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': tool,
      },
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: tool,
          arguments: args,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'E2E agent', version: '1' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      },
    });
    expect(res.status()).toBe(200);
    return (await res.json()) as { result: { structuredContent: unknown } };
  };
  const context = (await call('get_channel_context', { channelId: channel.id })).result
    .structuredContent as { data: { styleGuide: string; publication: { name: string } } };
  expect(context.data.styleGuide).toBe('Plain sentences. One idea per post.');
  expect(context.data.publication.name).toBe('Field Notes');

  // The agent starts a draft; the Posts list shows it as agent work.
  const draft = (
    await call('create_dispatch', {
      channelId: channel.id,
      body: { subject: 'Written by the agent' },
    })
  ).result.structuredContent as { data: { id: string } };
  expect(draft.data.id).toBeTruthy();

  await page.goto(`/dispatches?channel=${channel.id}`);
  await expect(page.getByRole('link', { name: 'Written by the agent' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Agent', exact: true })).toBeVisible();
  const startedBy = async (option: string) => {
    await page.getByRole('button', { name: /^(Filter|Started by)/ }).click();
    await page.getByRole('radio', { name: option }).check();
  };
  await startedBy('An agent or the API');
  await expect(page.getByRole('link', { name: 'Written by the agent' })).toBeVisible();
  await startedBy('A teammate');
  await expect(page.getByRole('heading', { name: 'No posts match' })).toBeVisible();
  await expectAccessible(page);
});
