// Copilot (Phase 8) with the dev adapter: subject lines streamed into the editor panel and used
// with a click, a grammar fix that replaces the selection only when accepted, and Settings →
// Copilot with a workspace key shown as its last four characters. axe runs on each screen.
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_PORT } from '../workers';
import {
  enableWorkspaceFlag,
  expectAccessible,
  openMoreOptions,
  postBody,
  signIn,
} from './helpers';

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

test('an operator takes a Copilot subject line, accepts a grammar fix and adds a model key', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  await page.goto('/');
  await signIn(page, request, `copilot-${stamp}@example.com`);
  const me = await api<{ workspaces: { id: string }[] }>(page, 'GET', '/api/v1/auth/session');
  const workspaceId = me.workspaces[0]!.id;
  enableWorkspaceFlag('copilot', workspaceId);
  enableWorkspaceFlag('copilot_byok', workspaceId);
  const channel = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/workspaces/${workspaceId}/channels`,
    {
      name: 'Field Notes',
      slug: `copilot-${stamp.toString(36)}`,
    },
  );
  const dispatch = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/channels/${channel.id}/dispatches`,
    {
      subject: 'Draft',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'spring is here and the bees are back' }],
          },
        ],
      },
    },
  );

  // Subject lines stream into the panel; the subject changes only on "Use".
  await page.goto(`/dispatches/${dispatch.id}`);
  await openMoreOptions(page);
  const copilot = page.getByRole('region', { name: 'Copilot' });
  await expect(copilot).toBeVisible();
  await copilot.getByRole('button', { name: 'Subject lines' }).click();
  const first = 'Subject idea 1: spring is here and the bees';
  await expect(copilot.getByText(first)).toBeVisible();
  await expect(page.getByLabel('Subject')).toHaveValue('Draft');
  await expectAccessible(page);
  await copilot.getByRole('button', { name: 'Use' }).first().click();
  await expect(page.getByLabel('Subject')).toHaveValue(first);

  // A grammar fix on the selection is shown first and replaces it only when accepted.
  const body = postBody(page);
  await body.click();
  await page.keyboard.press('ControlOrMeta+a');
  await copilot.getByRole('button', { name: 'Fix grammar' }).click();
  await expect(copilot.getByRole('button', { name: 'Replace selection' })).toBeVisible();
  await expect(body).toContainText('spring is here');
  await copilot.getByRole('button', { name: 'Replace selection' }).click();
  await expect(body).toContainText('Spring is here and the bees are back');

  // Settings → Copilot: usage, then a workspace key shown only by its last four characters.
  await page.goto('/settings/copilot');
  await expect(page.getByRole('heading', { name: 'Copilot', exact: true })).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel('Anthropic API key').fill('sk-ant-dev-e2e-key-000000ABCD');
  await page.getByRole('button', { name: 'Check and save' }).click();
  await expect(page.getByText('ABCD')).toBeVisible();
  await expect(page.getByText('sk-ant-dev-e2e-key')).toHaveCount(0);
  await expect(page.getByText('Your workspace’s key')).toBeVisible();
  await expectAccessible(page);
});

test('an operator copies Share Kit posts and confirms a deletion Copilot proposed', async ({
  page,
  request,
  context,
}) => {
  test.setTimeout(120_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: DASHBOARD });
  const stamp = Date.now();
  await page.goto('/');
  await signIn(page, request, `copilot-act-${stamp}@example.com`);
  const me = await api<{ workspaces: { id: string }[] }>(page, 'GET', '/api/v1/auth/session');
  const workspaceId = me.workspaces[0]!.id;
  enableWorkspaceFlag('copilot', workspaceId);
  enableWorkspaceFlag('copilot_actions', workspaceId);
  // The approval mode is changed through Open Operator's settings, which need this flag too.
  enableWorkspaceFlag('open_operator_mcp', workspaceId);
  const channel = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/workspaces/${workspaceId}/channels`,
    { name: 'Field Notes', slug: `copilot-act-${stamp.toString(36)}` },
  );
  const member = await api<{ id: string }>(page, 'POST', `/api/v1/channels/${channel.id}/members`, {
    email: `reader-${stamp}@example.com`,
    consent: true,
  });
  const dispatch = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/channels/${channel.id}/dispatches`,
    {
      subject: 'Spring',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'spring is here and the bees are back' }],
          },
        ],
      },
    },
  );

  // Share Kit: posts appear in the panel and are only ever copied.
  await page.goto(`/dispatches/${dispatch.id}`);
  await openMoreOptions(page);
  const copilot = page.getByRole('region', { name: 'Copilot' });
  await copilot.getByRole('button', { name: 'Social posts' }).click();
  await expect(copilot.getByText('Short post')).toBeVisible();
  await expectAccessible(page);
  await copilot.getByRole('button', { name: 'Copy the short post' }).click();
  await expect(copilot.getByRole('button', { name: 'Copy the short post' })).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
    /^Short: spring is here and the bees/,
  );

  // Ask Copilot to do it: the dev model calls what the request names; a deletion waits for a
  // click even though the approval mode doesn't hold it. New workspaces start in "destructive",
  // which holds it for an admin instead, so turn that off first.
  await api(page, 'PUT', `/api/v1/workspaces/${workspaceId}/agent-settings`, {
    approvalMode: 'never',
  });
  await copilot
    .getByLabel('What should Copilot do?')
    .fill(`dev:call delete_member {"channelId":"${channel.id}","memberId":"${member.id}"}`);
  await copilot.getByRole('button', { name: 'Ask Copilot' }).click();
  await expect(copilot.getByText('Waiting')).toBeVisible();
  await expect(
    copilot.getByText(
      'Copilot always asks before it deletes, sends or makes a change that is hard to undo.',
    ),
  ).toBeVisible();
  await expectAccessible(page);
  await copilot.getByRole('button', { name: 'Confirm and run' }).click();
  await expect(copilot.getByText('Done', { exact: true })).toBeVisible();
});
