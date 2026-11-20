// Phase 8 Link Hub: an operator switches the page on in Site Studio, adds links and a social
// profile, watches the preview follow, and the site serves /links with the links going through
// the click redirect. axe runs on each screen.
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_PORT } from '../workers';
import { enableChannelFlag, expectAccessible, signIn } from './helpers';

const DASHBOARD = `http://localhost:${DASHBOARD_PORT}`;
const SITE_PORT = 8792;
const siteUrl = (slug: string, path = '/') => `http://${slug}.site.localhost:${SITE_PORT}${path}`;

async function api<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(`${DASHBOARD}${path}`, {
    method,
    headers: { origin: DASHBOARD, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { data }),
  });
  expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
  return ((await res.json()) as { data: T }).data;
}

test('an operator publishes a Link Hub page and readers follow its links', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const slug = `hub-${stamp.toString(36)}`;

  await page.goto('/');
  await signIn(page, request, `hub-${stamp}@example.com`);
  const me = await api<{ workspaces: { id: string }[] }>(page, 'GET', '/api/v1/auth/session');
  const channel = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/workspaces/${me.workspaces[0]!.id}/channels`,
    { name: 'Harbour Log', slug },
  );
  enableChannelFlag('link_hub', channel.id);

  // Site Studio shows the Link Hub tab once the flag is on.
  await page.goto(`/site/${channel.id}/general`);
  await page
    .getByRole('navigation', { name: 'Website sections' })
    .getByRole('link', { name: 'Link Hub', exact: true })
    .click();
  await expect(page).toHaveURL(/\/link-hub$/);
  await expect(page.getByRole('heading', { name: 'No links yet' })).toBeVisible();
  await expectAccessible(page);

  // Settings: the preview follows the unsaved title.
  const preview = page.getByRole('complementary', { name: 'Preview' });
  await page.getByLabel('Title').fill('Everything from the harbour');
  await expect(preview.getByText('Everything from the harbour')).toBeVisible();
  await page.getByLabel('Publish the Link Hub page').check();
  await page.getByRole('button', { name: 'Add profile' }).click();
  await page.getByLabel('Network 1').selectOption('mastodon');
  await page.getByLabel('Address 1').fill('https://social.example/@harbour');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();

  // A link: a bad address is refused in place, then a good one is added.
  await page.getByRole('button', { name: 'Add link' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add link' });
  await dialog.getByLabel('Title').fill('Tide tables');
  await dialog.getByLabel('Address').fill('javascript:alert(1)');
  await dialog.getByRole('button', { name: 'Add link' }).click();
  await expect(dialog.getByText('Use an address starting with https:// or http://.')).toBeVisible();
  await dialog.getByLabel('Address').fill('https://tides.example/today');
  await expectAccessible(page);
  await dialog.getByRole('button', { name: 'Add link' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('https://tides.example/today')).toBeVisible();
  await expect(preview.getByText('Tide tables')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Clicks' })).toBeVisible();
  await expectAccessible(page);

  // The site serves /links; the link goes through the first-party redirect.
  await page.goto(siteUrl(slug, '/links'));
  await expect(
    page.getByRole('heading', { level: 1, name: 'Everything from the harbour' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Mastodon' })).toHaveAttribute(
    'href',
    'https://social.example/@harbour',
  );
  const link = page.getByRole('link', { name: 'Tide tables' });
  await expect(link).toHaveAttribute('href', /^\/_swarm\/hub\/lk_[0-9a-f]{32}\?s=direct$/);
  await expectAccessible(page);
  const res = await page.request.get(siteUrl(slug, (await link.getAttribute('href')) ?? ''), {
    maxRedirects: 0,
  });
  expect(res.status()).toBe(302);
  expect(res.headers().location).toBe('https://tides.example/today');
});
