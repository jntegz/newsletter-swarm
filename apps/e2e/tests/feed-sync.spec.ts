// Phase 8 Feed Sync: an editor adds a feed from the Dispatches page, the first check fails (the
// host does not exist, so no outside network is needed), the error is shown, and the feed is
// paused and deleted. axe runs on the list and the dialog.
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_PORT } from '../workers';
import { enableChannelFlag, expectAccessible, signIn } from './helpers';

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

test('an editor adds a feed, sees why its check failed, pauses and deletes it', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  await page.goto('/');
  await signIn(page, request, `feeds-${stamp}@example.com`);
  const me = await api<{ workspaces: { id: string }[] }>(page, 'GET', '/api/v1/auth/session');
  const channel = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/workspaces/${me.workspaces[0]!.id}/channels`,
    { name: 'Field Notes', slug: `feeds-${stamp.toString(36)}` },
  );
  enableChannelFlag('feed_sync', channel.id);

  await page.goto(`/dispatches?channel=${channel.id}`);
  await page.getByRole('link', { name: 'Feed Sync' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Feed Sync' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No feeds yet' })).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Add feed' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add feed' });
  await dialog.getByLabel('Feed URL').fill('https://feeds.example.invalid/rss.xml');
  await dialog.getByLabel('Name').fill('Fox Blog');
  // A digest on a set day: the time only matters once a day is chosen.
  await dialog.getByLabel('Group posts').selectOption('digest');
  await dialog.getByRole('group', { name: 'Digest days' }).getByLabel('Fri').check();
  await dialog.getByLabel('At', { exact: true }).fill('09:30');
  await expectAccessible(page);
  await dialog.getByRole('button', { name: 'Add feed' }).click();

  await expect(page.getByText('Fox Blog')).toBeVisible();
  await expect(page.getByText(/Fri at 09:30/)).toBeVisible();
  await expect(page.getByText(/Last check failed/)).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByText('Paused', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete feed' }).click();
  await expect(page.getByRole('heading', { name: 'No feeds yet' })).toBeVisible();
});

test('an editor sends a feed to one Roster only and chooses who wins a conflict', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  await page.goto('/');
  await signIn(page, request, `feeds-rosters-${stamp}@example.com`);
  const me = await api<{ workspaces: { id: string }[] }>(page, 'GET', '/api/v1/auth/session');
  const channel = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/workspaces/${me.workspaces[0]!.id}/channels`,
    { name: 'Field Notes', slug: `feeds-rs-${stamp.toString(36)}` },
  );
  enableChannelFlag('feed_sync', channel.id);
  enableChannelFlag('rosters', channel.id);
  const base = `/api/v1/channels/${channel.id}`;
  const deals = await api<{ id: string }>(page, 'POST', `${base}/rosters`, {
    name: 'Weekly deals',
  });
  const events = await api<{ id: string }>(page, 'POST', `${base}/rosters`, { name: 'Events' });
  const member = await api<{ id: string }>(page, 'POST', `${base}/members`, {
    email: `both-${stamp}@example.org`,
    consent: true,
  });
  for (const roster of [deals, events]) {
    await api(page, 'PUT', `${base}/members/${member.id}/rosters/${roster.id}`, {
      status: 'subscribed',
    });
  }

  // The feed dialog has the same Roster part as a post's audience.
  await page.goto(`/dispatches?channel=${channel.id}`);
  await page.getByRole('link', { name: 'Feed Sync' }).click();
  await page.getByRole('button', { name: 'Add feed' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add feed' });
  await dialog.getByLabel('Feed URL').fill('https://feeds.example.invalid/deals.xml');
  await dialog.getByLabel('Name').fill('Deals Blog');
  await dialog
    .getByRole('group', { name: 'Only subscribers on' })
    .getByLabel('Weekly deals')
    .check();
  await dialog
    .getByRole('group', { name: 'Leave out subscribers on' })
    .getByLabel('Events')
    .check();
  await expect(dialog.getByText('is on both an included and an excluded Roster')).toBeVisible({
    timeout: 15_000,
  });
  await expect(dialog.getByText('The Rosters let through 0 active subscribers')).toBeVisible();
  await dialog.getByLabel('Send to them').check();
  await expect(dialog.getByText('The Rosters let through 1 active subscriber')).toBeVisible({
    timeout: 15_000,
  });
  await expectAccessible(page);
  await dialog.getByRole('button', { name: 'Add feed' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Deals Blog')).toBeVisible();

  // Saved on the feed, and shown again when it is edited.
  const sources = await api<
    { audience: { rosters?: { include: string[]; exclude: string[]; conflict: string } } }[]
  >(page, 'GET', `${base}/feed-sources`);
  expect(sources[0]!.audience.rosters).toEqual({
    include: [deals.id],
    exclude: [events.id],
    conflict: 'include_wins',
  });
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit feed' });
  await expect(
    edit.getByRole('group', { name: 'Only subscribers on' }).getByLabel('Weekly deals'),
  ).toBeChecked();
  await expect(
    edit.getByRole('group', { name: 'Leave out subscribers on' }).getByLabel('Events'),
  ).toBeChecked();
  await expect(edit.getByLabel('Send to them')).toBeChecked();
  await expectAccessible(page);
});
