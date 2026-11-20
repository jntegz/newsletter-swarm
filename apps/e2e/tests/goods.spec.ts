import { expect, test } from '@playwright/test';
import {
  createPublication,
  enableWorkspaceFlag,
  expectAccessible,
  mailLink,
  signIn,
} from './helpers';

const siteUrl = (slug: string, path = '/') => `http://${slug}.site.localhost:8792${path}`;
const PDF = Buffer.from('%PDF-1.4\n%the paid file\n');

test('a writer sells a PDF, a reader buys and downloads it, and a refund ends access', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(180_000);
  const stamp = Date.now() * 10 + test.info().parallelIndex;
  const slug = `shop-${stamp}`;
  const buyer = `buyer-${stamp}@example.com`;
  await page.goto('/');
  await signIn(page, request, `shop-owner-${stamp}@example.com`);
  const session = await page.evaluate(async () => {
    const res = await fetch('/api/v1/auth/session', { credentials: 'same-origin' });
    return ((await res.json()) as { data: { workspaces: { id: string }[] } }).data;
  });
  enableWorkspaceFlag('goods', session.workspaces[0]!.id);
  await createPublication(page, 'Field Notes', slug);
  const channelId = /\/channels\/(ch_[0-9a-f]{32})/.exec(page.url())![1]!;

  // Stripe first: the dev Connect URL returns through the callback at once.
  await page.goto(`/settings/payments?channel=${channelId}`);
  await page.getByRole('button', { name: 'Connect Stripe' }).click();
  await expect(page).toHaveURL(/connected=1/);

  await page.goto(`/goods?channel=${channelId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Products' })).toBeVisible();
  await page.getByRole('button', { name: 'New product' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Field Guide');
  await dialog.getByLabel('Amount').fill('9');
  await dialog.locator('input[type=file]').setInputFiles({
    name: 'guide.pdf',
    mimeType: 'application/pdf',
    buffer: PDF,
  });
  await expect(dialog.getByLabel('File name')).toHaveValue('guide');
  await dialog.getByLabel('Give each buyer a license key').check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Put on sale' }).click();
  await expect(page.getByText('On sale')).toBeVisible();
  // The row shows before the save settles, and its button then fades in from disabled. Audit after.
  await expect(page.getByRole('button', { name: 'Stop selling' })).toBeEnabled();
  await expectAccessible(page);

  // A reader buys it, on the dev stand-in for Stripe Checkout.
  const reader = await browser.newContext();
  const shop = await reader.newPage();
  await shop.goto(siteUrl(slug, '/goods/field-guide'));
  await shop.getByLabel('Your email').fill(buyer);
  // Cloudflare's always-pass test keys fill the token in the widget.
  await expect(shop.locator('input[name="cf-turnstile-response"]')).toHaveValue(/.+/, {
    timeout: 30_000,
  });
  await shop.getByRole('button', { name: 'Buy' }).click();
  await expect(shop.getByRole('heading', { name: 'Test checkout' })).toBeVisible();
  await shop.getByRole('button', { name: 'Complete test purchase' }).click();
  // An anonymous buyer's thank-you link covers this order only; the whole library comes by email.
  await shop.getByRole('link', { name: 'Get your files now' }).click();
  await expect(shop.getByRole('heading', { name: 'Field Guide' })).toBeVisible();
  await expect(shop.locator('code')).toHaveText(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
  const file = await shop.getByRole('link', { name: 'guide' }).getAttribute('href');
  const library = shop.url();
  const download = await reader.request.get(new URL(file!, library).toString());
  expect(download.status()).toBe(200);
  expect(await download.text()).toContain('the paid file');

  // The same link arrives by email.
  expect(await mailLink(request, buyer, '/_swarm/library')).toContain('/_swarm/library/');

  // The writer refunds it, and the buyer's link stops giving the file.
  await page.reload();
  await page.getByRole('button', { name: 'Refund' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Refund' }).click();
  await expect(page.getByRole('cell', { name: 'Refunded' })).toBeVisible();
  expect((await reader.request.get(new URL(file!, library).toString())).status()).toBe(404);
  await reader.close();
});
