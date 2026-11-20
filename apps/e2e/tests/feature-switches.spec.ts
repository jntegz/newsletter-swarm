// Phase 8 exit gate: turning a feature's flag off hides its UI, and going straight to its address
// shows a calm "not turned on" state instead of an error. Each feature has a test with the flag
// off and one with it on. The API side is covered in workers/api/tests.
//
// Flags are cached for a minute, so a test never flips one: each starts with a new workspace.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { DASHBOARD_PORT } from '../workers';
import {
  enableChannelFlag,
  enableWorkspaceFlag,
  expectAccessible,
  openMoreOptions,
  signIn,
} from './helpers';

const DASHBOARD = `http://localhost:${DASHBOARD_PORT}`;

test.describe.configure({ timeout: 120_000 });

async function api<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(`${DASHBOARD}${path}`, {
    method,
    headers: { origin: DASHBOARD, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { data }),
  });
  expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
  return ((await res.json()) as { data: T }).data;
}

let people = 0;

/** Signs in someone new, which makes a new workspace with no publication yet. */
async function newWorkspace(page: Page, request: APIRequestContext, label: string) {
  const stamp = `${Date.now().toString(36)}${process.pid.toString(36)}${people++}`;
  await page.goto('/');
  await signIn(page, request, `switch-${label}-${stamp}@example.com`);
  const me = await api<{ workspaces: { id: string }[] }>(page, 'GET', '/api/v1/auth/session');
  return { workspaceId: me.workspaces[0]!.id, slug: `${label}-${stamp}` };
}

async function newPublication(page: Page, workspaceId: string, slug: string) {
  const channel = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/workspaces/${workspaceId}/channels`,
    { name: 'Field Notes', slug },
  );
  return channel.id;
}

async function newPost(page: Page, channelId: string) {
  const post = await api<{ id: string }>(page, 'POST', `/api/v1/channels/${channelId}/dispatches`, {
    subject: 'Draft',
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  });
  return post.id;
}

/**
 * Opens an address and waits until the publication's flags have been read and drawn, so that
 * something missing afterwards is hidden and not just still on its way.
 */
async function openWithFlags(page: Page, path: string) {
  const flags = page.waitForResponse(
    (res) => /^\/api\/v1\/channels\/[^/]+\/flags$/.test(new URL(res.url()).pathname) && res.ok(),
  );
  await page.goto(path);
  await flags;
  await settle(page);
}

/** Lets React draw what a response just changed. */
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => setTimeout(resolve, 150));
      }),
  );

/** The calm state a switched-off page shows: its title, never an error. */
async function expectTurnedOff(page: Page, title: string) {
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
  await expectAccessible(page);
}

const settingsTabs = (page: Page) => page.getByRole('navigation', { name: 'Settings sections' });
const developerTabs = (page: Page) => page.getByRole('navigation', { name: 'Developer settings' });
const rail = (page: Page) => page.getByRole('navigation', { name: 'Sections' });

/** The Apps link in the command menu, with a link every workspace has to prove it has drawn. */
async function openCommandMenu(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  const menu = page.getByRole('dialog', { name: 'Command menu' });
  await expect(menu.getByRole('link', { name: 'Subscribers', exact: true })).toBeVisible();
  return menu;
}

test.describe('rosters', () => {
  test('off: no link from Subscribers, and the address says it is not turned on', async ({
    page,
    request,
  }) => {
    const { workspaceId, slug } = await newWorkspace(page, request, 'rosters-off');
    const channelId = await newPublication(page, workspaceId, slug);

    await openWithFlags(page, `/members?channel=${channelId}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Subscribers' })).toBeVisible();
    await expect(page.getByRole('main').getByRole('link', { name: 'Rosters' })).toHaveCount(0);

    await page.goto(`/rosters?channel=${channelId}`);
    await expectTurnedOff(page, 'Rosters are not turned on');
    await expect(page.getByRole('button', { name: 'Create a Roster' })).toHaveCount(0);
  });

  test('on: Subscribers links to Rosters', async ({ page, request }) => {
    const { workspaceId, slug } = await newWorkspace(page, request, 'rosters-on');
    const channelId = await newPublication(page, workspaceId, slug);
    enableChannelFlag('rosters', channelId);

    await openWithFlags(page, `/members?channel=${channelId}`);
    await page.getByRole('main').getByRole('link', { name: 'Rosters' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Rosters' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create a Roster' }).first()).toBeVisible();
  });
});

test.describe('feed_sync', () => {
  test('off: no link from Posts, and the address says it is not turned on', async ({
    page,
    request,
  }) => {
    const { workspaceId, slug } = await newWorkspace(page, request, 'feeds-off');
    const channelId = await newPublication(page, workspaceId, slug);

    await openWithFlags(page, `/dispatches?channel=${channelId}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Posts' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Feed Sync' })).toHaveCount(0);

    await page.goto(`/channels/${channelId}/feeds`);
    await expectTurnedOff(page, 'Feed Sync is not turned on');
    await expect(page.getByRole('button', { name: 'Add feed' })).toHaveCount(0);
  });

  test('on: Posts links to Feed Sync', async ({ page, request }) => {
    const { workspaceId, slug } = await newWorkspace(page, request, 'feeds-on');
    const channelId = await newPublication(page, workspaceId, slug);
    enableChannelFlag('feed_sync', channelId);

    await openWithFlags(page, `/dispatches?channel=${channelId}`);
    await page.getByRole('link', { name: 'Feed Sync' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Feed Sync' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No feeds yet' })).toBeVisible();
  });
});

test.describe('link_hub', () => {
  test('off: no Website tab, and the address says it is not turned on', async ({
    page,
    request,
  }) => {
    const { workspaceId, slug } = await newWorkspace(page, request, 'hub-off');
    const channelId = await newPublication(page, workspaceId, slug);
    const tabs = page.getByRole('navigation', { name: 'Website sections' });

    await openWithFlags(page, `/site/${channelId}/general`);
    await expect(tabs.getByRole('link', { name: 'General' })).toBeVisible();
    await expect(tabs.getByRole('link', { name: 'Link Hub' })).toHaveCount(0);

    await page.goto(`/site/${channelId}/link-hub`);
    await expectTurnedOff(page, 'Link Hub is not turned on');
  });

  test('on: Website has the tab', async ({ page, request }) => {
    const { workspaceId, slug } = await newWorkspace(page, request, 'hub-on');
    const channelId = await newPublication(page, workspaceId, slug);
    enableChannelFlag('link_hub', channelId);

    await openWithFlags(page, `/site/${channelId}/general`);
    await page
      .getByRole('navigation', { name: 'Website sections' })
      .getByRole('link', { name: 'Link Hub' })
      .click();
    await expect(page.getByRole('heading', { name: 'No links yet' })).toBeVisible();
  });
});

test.describe('copilot', () => {
  test('off: nothing in the editor, no Settings tab, and the address says it is not turned on', async ({
    page,
    request,
  }) => {
    const { workspaceId, slug } = await newWorkspace(page, request, 'copilot-off');
    const channelId = await newPublication(page, workspaceId, slug);
    const postId = await newPost(page, channelId);

    await openWithFlags(page, `/dispatches/${postId}`);
    await openMoreOptions(page);
    await expect(page.getByRole('region', { name: 'Copilot' })).toHaveCount(0);

    await openWithFlags(page, '/settings/workspace');
    await expect(settingsTabs(page).getByRole('link', { name: 'Team' })).toBeVisible();
    await expect(settingsTabs(page).getByRole('link', { name: 'Copilot' })).toHaveCount(0);

    await page.goto('/settings/copilot');
    await expectTurnedOff(page, 'Copilot is not turned on');
  });

  test('on: the editor has it and Settings has the tab', async ({ page, request }) => {
    const { workspaceId, slug } = await newWorkspace(page, request, 'copilot-on');
    enableWorkspaceFlag('copilot', workspaceId);
    const channelId = await newPublication(page, workspaceId, slug);
    const postId = await newPost(page, channelId);

    await openWithFlags(page, `/dispatches/${postId}`);
    await openMoreOptions(page);
    await expect(page.getByRole('region', { name: 'Copilot' })).toBeVisible();

    await openWithFlags(page, '/settings/workspace');
    await settingsTabs(page).getByRole('link', { name: 'Copilot' }).click();
    await expect(page.getByRole('heading', { name: 'Copilot', exact: true })).toBeVisible();
  });
});

test.describe('open_operator_mcp', () => {
  test('off: no Developers tab, and the address says it is not turned on', async ({
    page,
    request,
  }) => {
    const { workspaceId, slug } = await newWorkspace(page, request, 'operator-off');
    await newPublication(page, workspaceId, slug);

    await openWithFlags(page, '/settings/developers/api-keys');
    await expect(developerTabs(page).getByRole('link', { name: 'API keys' })).toBeVisible();
    await expect(developerTabs(page).getByRole('link', { name: 'Open Operator' })).toHaveCount(0);

    await page.goto('/settings/developers/open-operator');
    await expectTurnedOff(page, 'Open Operator is not turned on');
    await expect(page.getByRole('heading', { name: 'MCP server' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Agent activity' })).toHaveCount(0);
  });

  test('on: Developers has the tab and the MCP server settings', async ({ page, request }) => {
    const { workspaceId, slug } = await newWorkspace(page, request, 'operator-on');
    enableWorkspaceFlag('open_operator_mcp', workspaceId);
    await newPublication(page, workspaceId, slug);

    await openWithFlags(page, '/settings/developers/api-keys');
    await developerTabs(page).getByRole('link', { name: 'Open Operator' }).click();
    await expect(page.getByRole('heading', { name: 'MCP server' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Open Operator is not turned on' })).toHaveCount(
      0,
    );
  });

  // Copilot's held calls are approved on this page, whatever the MCP server's flag says.
  test('off with Copilot actions on: approvals stay, the MCP server does not', async ({
    page,
    request,
  }) => {
    const { workspaceId, slug } = await newWorkspace(page, request, 'operator-copilot');
    enableWorkspaceFlag('copilot', workspaceId);
    enableWorkspaceFlag('copilot_actions', workspaceId);
    await newPublication(page, workspaceId, slug);

    await openWithFlags(page, '/settings/developers/api-keys');
    await developerTabs(page).getByRole('link', { name: 'Open Operator' }).click();
    await expect(page.getByRole('heading', { name: 'Waiting for approval' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'MCP server' })).toHaveCount(0);
    await expect(page.getByText('not available for this workspace')).toHaveCount(0);
  });
});

test.describe('app_directory', () => {
  test('off: no Apps or Connect in the rail or the command menu, and the addresses say so', async ({
    page,
    request,
  }) => {
    const { workspaceId, slug } = await newWorkspace(page, request, 'apps-off');
    await newPublication(page, workspaceId, slug);

    await openWithFlags(page, '/');
    await expect(rail(page).getByRole('link', { name: 'Subscribers', exact: true })).toBeVisible();
    await expect(rail(page).getByRole('link', { name: 'Apps', exact: true })).toHaveCount(0);
    await expect(rail(page).getByText('Connect', { exact: true })).toHaveCount(0);
    const menu = await openCommandMenu(page);
    await expect(menu.getByRole('link', { name: 'Apps', exact: true })).toHaveCount(0);

    await openWithFlags(page, '/settings/developers/api-keys');
    await expect(developerTabs(page).getByRole('link', { name: 'API keys' })).toBeVisible();
    await expect(developerTabs(page).getByRole('link', { name: 'Directory listings' })).toHaveCount(
      0,
    );

    await page.goto('/apps');
    await expectTurnedOff(page, 'The App Directory is not turned on');
    await expect(page.getByRole('button', { name: 'Installed' })).toHaveCount(0);

    await page.goto('/settings/developers/listings');
    await expectTurnedOff(page, 'The App Directory is not turned on');
  });

  test('on: Apps is in the rail, the command menu and Developers', async ({ page, request }) => {
    const { workspaceId, slug } = await newWorkspace(page, request, 'apps-on');
    enableWorkspaceFlag('app_directory', workspaceId);
    await newPublication(page, workspaceId, slug);

    await openWithFlags(page, '/settings/developers/api-keys');
    await expect(
      developerTabs(page).getByRole('link', { name: 'Directory listings' }),
    ).toBeVisible();
    await expect(rail(page).getByText('Connect', { exact: true })).toBeVisible();
    await expect(rail(page).getByRole('link', { name: 'Apps', exact: true })).toBeVisible();

    const menu = await openCommandMenu(page);
    await menu.getByRole('link', { name: 'Apps', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Apps' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Installed' })).toBeVisible();
  });

  // Without a publication there are no publication flags to read, so the rail reads the instance's.
  test('with no publication yet, the rail follows the instance', async ({ page, request }) => {
    await newWorkspace(page, request, 'apps-none');
    // Faked here: a real platform flag would reach every other test sharing this database.
    await page.route('**/api/v1/flags', (route) =>
      route.fulfill({ json: { data: { flags: { app_directory: true } } } }),
    );
    await page.goto('/');
    await expect(rail(page).getByRole('link', { name: 'Apps', exact: true })).toBeVisible();
    await page.unroute('**/api/v1/flags');

    const flags = page.waitForResponse(
      (res) => new URL(res.url()).pathname === '/api/v1/flags' && res.ok(),
    );
    await page.goto('/');
    await flags;
    await settle(page);
    await expect(rail(page).getByRole('link', { name: 'Home', exact: true })).toBeVisible();
    await expect(rail(page).getByRole('link', { name: 'Apps', exact: true })).toHaveCount(0);
  });
});

test.describe('goods', () => {
  // "Add reward" opens a short form in place of the button, not a dialog.
  const kinds = (page: Page) =>
    page
      .getByRole('form', { name: 'Add a reward' })
      .getByLabel('Kind')
      .locator('option')
      .allTextContents();

  test('off: new rewards cannot be Goods, and an existing Goods reward still opens', async ({
    page,
    request,
  }) => {
    const { workspaceId, slug } = await newWorkspace(page, request, 'goods-off');
    const channelId = await newPublication(page, workspaceId, slug);
    await api(page, 'POST', `/api/v1/channels/${channelId}/champions/rewards`, {
      kind: 'goods',
      name: 'Sticker pack',
      goodsRef: 'stickers-1',
    });

    await openWithFlags(page, `/growth/${channelId}/champions`);
    await page.getByRole('button', { name: 'Add reward' }).click();
    await expect(page.getByRole('form', { name: 'Add a reward' })).toBeVisible();
    expect(await kinds(page)).toEqual([
      'Free access to a paid plan',
      'A coupon code',
      'Something you send yourself',
    ]);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('form', { name: 'Add a reward' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add reward' })).toBeFocused();

    await expect(page.getByText('A Goods item', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit Sticker pack' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit reward' });
    await expect(edit.getByLabel('Kind')).toHaveValue('goods');
    await expect(edit.getByLabel('Goods item')).toHaveValue('stickers-1');
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(edit).toBeHidden();
  });

  test('on: new rewards can be Goods', async ({ page, request }) => {
    const { workspaceId, slug } = await newWorkspace(page, request, 'goods-on');
    const channelId = await newPublication(page, workspaceId, slug);
    enableChannelFlag('goods', channelId);

    await openWithFlags(page, `/growth/${channelId}/champions`);
    await page.getByRole('button', { name: 'Add reward' }).click();
    await expect(page.getByRole('form', { name: 'Add a reward' })).toBeVisible();
    await expect
      .poll(() => kinds(page))
      .toEqual([
        'Free access to a paid plan',
        'A coupon code',
        'A Goods item',
        'Something you send yourself',
      ]);
  });
});
