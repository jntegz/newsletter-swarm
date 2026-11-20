import { expect, test, type Page } from '@playwright/test';
import { createPublication, enableWorkspaceFlag, expectAccessible, signIn } from './helpers';

const siteUrl = (slug: string, path = '/') => `http://${slug}.site.localhost:8792${path}`;

async function setUp(page: Page, request: Parameters<typeof signIn>[1], stamp: number) {
  const slug = `deals-${stamp}`;
  await page.goto('/');
  await signIn(page, request, `deals-${stamp}@example.com`);
  const session = await page.evaluate(async () => {
    const res = await fetch('/api/v1/auth/session', { credentials: 'same-origin' });
    return ((await res.json()) as { data: { workspaces: { id: string }[] } }).data;
  });
  enableWorkspaceFlag('partner_exchange', session.workspaces[0]!.id);
  enableWorkspaceFlag('sponsor_match', session.workspaces[0]!.id);
  await createPublication(page, 'Field Notes', slug);
  const channelId = /\/channels\/(ch_[0-9a-f]{32})/.exec(page.url())![1]!;
  return { slug, channelId };
}

test('a writer recommends a publication, and a reader finds it on the website', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now() * 10 + test.info().parallelIndex;
  const { slug, channelId } = await setUp(page, request, stamp);

  await page.goto(`/partners?channel=${channelId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Partners' })).toBeVisible();
  await page.getByLabel('Name').fill('Good Reads Weekly');
  await page.getByLabel('Web address').fill('https://example.com/');
  await page.getByLabel('Why you recommend it').fill('Sharp and short.');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('Sharp and short.')).toBeVisible();
  await expectAccessible(page);

  const reader = await browser.newContext();
  const visit = await reader.newPage();
  await visit.goto(siteUrl(slug, '/partners'));
  const link = visit.getByRole('link', { name: 'Good Reads Weekly' });
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  const res = await reader.request.get(new URL(href!, visit.url()).toString(), {
    maxRedirects: 0,
    headers: {
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    },
  });
  expect(res.status()).toBe(302);
  expect(res.headers().location).toContain('utm_medium=partner_exchange');
  await reader.close();

  await expect(async () => {
    await page.reload();
    await expect(page.getByText('1 click', { exact: true })).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
});

test('a sponsor books a placement, the writer accepts it and adds it to a post', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(150_000);
  const stamp = Date.now() * 10 + test.info().parallelIndex;
  const { slug, channelId } = await setUp(page, request, stamp);

  await page.goto(`/sponsors?channel=${channelId}`);
  await page.getByLabel('Take bookings').check();
  await page.getByLabel('Headline').fill('Reach our readers');
  await page.getByRole('button', { name: 'Add a placement' }).click();
  await page.getByLabel('Placement', { exact: true }).fill('Top of post');
  await page.getByLabel('Asking price').fill('250');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Remove' })).toBeVisible();
  await expectAccessible(page);

  const sponsor = await browser.newContext();
  const form = await sponsor.newPage();
  await form.goto(siteUrl(slug, '/sponsor'));
  await expect(form.getByRole('heading', { name: 'Reach our readers' })).toBeVisible();
  await form
    .getByLabel('Date you’d like it to run')
    .or(form.getByLabel("Date you'd like it to run"))
    .fill('2099-01-15');
  await form.getByLabel('Your company').fill('Acme');
  await form.getByLabel('Your email').fill(`ads-${stamp}@example.com`);
  await form.getByLabel('Ad headline').fill('Try Acme');
  await form.getByLabel('Where it should lead').fill('https://example.com/acme');
  await expect(form.locator('input[name="cf-turnstile-response"]')).toHaveValue(/.+/, {
    timeout: 30_000,
  });
  await form.getByRole('button', { name: 'Send request' }).click();
  await expect(form.getByRole('heading', { name: 'Request sent' })).toBeVisible();
  await sponsor.close();

  await page.reload();
  await page.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByText('Accepted')).toBeVisible();
  await expect(page.getByRole('link', { name: /Report to share/ })).toBeVisible();
});
