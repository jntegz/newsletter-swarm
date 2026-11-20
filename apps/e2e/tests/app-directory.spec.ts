// Phase 8 App Directory: a developer lists their OAuth app (Settings → Developers → Directory
// listings) and submits it; once approved it shows in Apps with its scopes in plain language and
// an Install link to the app's own authorization start. axe runs on each screen. Staff review
// needs a second factor on the session, so this story approves the listing with SQL; the review
// itself is covered by workers/api/tests/app-directory.test.ts.
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_PORT } from '../workers';
import { enableWorkspaceFlag, expectAccessible, localSql, PNG, signIn } from './helpers';

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

test('a developer lists an OAuth app and an operator finds it in Apps', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  // Approved listings stay in the local D1 and show in every workspace, so the name must be new.
  const app = `Sheet Sync ${stamp}`;
  await page.goto('/');
  await signIn(page, request, `apps-${stamp}@example.com`);
  const me = await api<{ workspaces: { id: string }[] }>(page, 'GET', '/api/v1/auth/session');
  const workspaceId = me.workspaces[0]!.id;
  // Before anything reads the workspace's flags (cached for a minute).
  enableWorkspaceFlag('app_directory', workspaceId);
  const channel = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/workspaces/${workspaceId}/channels`,
    { name: 'Field Notes', slug: `apps-${stamp.toString(36)}` },
  );
  await api(page, 'POST', `/api/v1/workspaces/${workspaceId}/oauth-apps`, {
    name: app,
    clientType: 'public',
    redirectUris: ['https://sheets.example/callback'],
    scopes: ['members:read'],
  });
  const upload = await page.request.post(`${DASHBOARD}/api/v1/channels/${channel.id}/media`, {
    headers: { origin: DASHBOARD },
    multipart: { file: { name: 'icon.png', mimeType: 'image/png', buffer: PNG }, alt: 'App icon' },
  });
  expect(upload.ok()).toBe(true);

  // Settings → Developers → Directory listings: start a draft and fill it in.
  await page.goto('/settings/developers/listings');
  await expect(page.getByRole('heading', { name: 'Directory listings' })).toBeVisible();
  // Enabled once the workspace's apps have loaded; the button fades from grey to purple then.
  await expect(page.getByRole('button', { name: 'List an app' })).toBeEnabled();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'List an app' }).click();
  await page.getByRole('button', { name: 'Create draft' }).click();
  const edit = page.getByRole('dialog', { name: `Edit ${app}` });
  await expect(edit).toBeVisible();
  await edit.getByLabel('Address in the directory').fill(`sheet-sync-${stamp.toString(36)}`);
  await edit.getByLabel('Tagline').fill('A spreadsheet row for every Member');
  await edit.getByRole('button', { name: 'Choose an icon' }).click();
  // Choosing an image closes the picker and sets the icon.
  await edit.getByRole('radio', { name: 'App icon' }).click();
  await expect(edit.getByRole('button', { name: 'Change icon' })).toBeVisible();
  await edit.getByLabel('Productivity').check();
  await edit.getByLabel('Website').fill('https://sheets.example');
  await edit.getByLabel('Support').fill('mailto:help@sheets.example');
  await edit.getByLabel('Privacy policy').fill('https://sheets.example/privacy');
  await edit.getByLabel('Install address').fill('https://sheets.example/install');
  await expectAccessible(page);
  await edit.getByRole('button', { name: 'Save draft' }).click();
  await expect(edit).toBeHidden();
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByText('In review')).toBeVisible();

  // Platform staff approve it (see the note at the top).
  localSql(
    `UPDATE app_listings SET status = 'approved', reviewed_at = ${Date.now()} WHERE workspace_id = '${workspaceId}'`,
  );

  // Apps: the listing, its scopes in plain language and the Install link.
  await page.getByRole('link', { name: 'Apps', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Apps' })).toBeVisible();
  await page.getByLabel('Search apps').fill('spreadsheet');
  await page.getByRole('button', { name: `View ${app}` }).click();
  const listing = page.getByRole('dialog', { name: app });
  await expect(listing.getByText('See subscribers, their tags and profile fields')).toBeVisible();
  await expect(listing.getByRole('link', { name: `Continue to ${app}` })).toHaveAttribute(
    'href',
    'https://sheets.example/install',
  );
  await expectAccessible(page);
  await listing.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: 'Installed' }).click();
  await expect(page.getByText('No apps are installed.')).toBeVisible();
});
