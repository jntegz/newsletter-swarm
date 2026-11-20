import { expect, test, type Page } from '@playwright/test';
import {
  createPublication,
  expectAccessible,
  expectPostSaved,
  insertBlock,
  newPost,
  openMoreOptions,
  openSection,
  postBody,
  signIn,
} from './helpers';

// PAYMENTS=dev (wrangler.jsonc for api and site): the Connect URL goes straight to the callback
// with a dev code, and Checkout is a local page with a "Complete test purchase" button.
const SITE_PORT = 8792;
const siteUrl = (slug: string, path = '/') => `http://${slug}.site.localhost:${SITE_PORT}${path}`;

async function openTab(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: 'Paid subscriptions sections' })
    .getByRole('link', { name, exact: true })
    .click();
}

test('an operator connects Stripe, sells a Membership level and sees a reader buy it', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const slug = `paid-${stamp.toString(36)}`;
  const reader = `reader-${stamp}@example.org`;

  await page.goto('/');
  await signIn(page, request, `memberships-${stamp}@example.com`);
  await createPublication(page, 'Tidewater Notes', slug);
  const channelId = /\/channels\/(ch_[0-9a-f]{32})/.exec(page.url())?.[1];
  expect(channelId).toBeTruthy();

  // Memberships without Stripe: the empty state points at Settings → Payments.
  await openSection(page, 'Paid subscriptions');
  await expect(page).toHaveURL(/\/memberships\/ch_[0-9a-f]+\/levels$/);
  await expect(
    page.getByRole('heading', { name: 'Connect Stripe to start selling' }),
  ).toBeVisible();
  await expectAccessible(page);

  // Settings → Payments: connect (the dev Connect URL returns through the callback at once).
  await page.getByRole('link', { name: 'Connect Stripe' }).click();
  await expect(page).toHaveURL(/\/settings\/payments\?channel=ch_/);
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Connect Stripe' }).click();
  await expect(page).toHaveURL(/connected=1/);
  await expect(page.getByText('Stripe is connected.')).toBeVisible();
  await expect(page.getByText('Test mode')).toBeVisible();
  const accountStatus = page.getByRole('list', { name: 'Account status' });
  await expect(
    accountStatus.getByRole('listitem').filter({ hasText: 'Take payments' }),
  ).toContainText('Enabled');
  await page.getByLabel('Grace period (days)').fill('10');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  await expectAccessible(page);

  // A Membership level with a monthly and a yearly price.
  await page.getByRole('link', { name: 'Paid plans' }).click();
  await expect(page).toHaveURL(/\/memberships\/ch_[0-9a-f]+\/levels$/);
  await page.getByRole('link', { name: 'New paid plan' }).click();
  await page.getByLabel('Name').fill('Supporter');
  await page.getByLabel('Benefit 1', { exact: true }).fill('Every Dispatch, in full');
  await page.getByLabel('Amount (USD, monthly)').fill('5');
  await page.getByLabel('Yearly price').check();
  await page.getByLabel('Amount (USD, yearly)').fill('50');
  const preview = page.getByRole('complementary', { name: 'Plans page preview' });
  await expect(preview).toContainText('Supporter');
  await expect(preview).toContainText('$5 a month');
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Create paid plan' }).click();
  await expect(page).toHaveURL(/\/levels\/lv_[0-9a-f]{32}$/);
  const prices = page.getByRole('list', { name: 'Prices' });
  await expect(prices).toContainText('$5 a month');
  await expect(prices).toContainText('$50 a year');
  await expectAccessible(page);

  // The price change dialog offers now or a date.
  await page.getByRole('button', { name: 'Change price' }).first().click();
  const change = page.getByRole('dialog', { name: 'Change the monthly price' });
  await change.getByRole('radio', { name: /^On a date/ }).check();
  await expect(change.getByLabel('Takes effect on')).toBeVisible();
  await expectAccessible(page);
  await change.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('link', { name: 'All paid plans' }).click();
  const levels = page.getByRole('list', { name: 'Paid plans' });
  await expect(levels).toContainText('Free');
  await expect(levels).toContainText('Supporter');
  await expectAccessible(page);

  // A coupon.
  await openTab(page, 'Coupons');
  await page.getByLabel('Code', { exact: true }).fill('welcome10');
  await page.getByLabel('Percent off').fill('10');
  await page.getByRole('button', { name: 'Create coupon' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Coupon WELCOME10 created.' }),
  ).toBeVisible();
  await expect(page.getByRole('cell', { name: 'WELCOME10', exact: true })).toBeVisible();
  await expectAccessible(page);

  // Gate settings: show the coupon in the Gate.
  await openTab(page, 'Paywall');
  await page.getByLabel('Coupon', { exact: true }).selectOption({ label: 'WELCOME10 · 10% off' });
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Saved.' })
      .or(page.getByText('Coupons in the paywall are not available for this publication.')),
  ).toBeVisible();
  await expectAccessible(page);

  // Revenue starts empty; Gift Passes and pledges show their feature state.
  await openTab(page, 'Revenue');
  await expect(page.getByRole('heading', { name: 'No revenue yet' })).toBeVisible();
  await expectAccessible(page);
  await openTab(page, 'Gift subscriptions');
  await expect(
    page
      .getByRole('heading', { name: 'Gift subscriptions are off for this publication' })
      .or(page.getByRole('heading', { name: 'No gift subscriptions yet' })),
  ).toBeVisible();
  await expectAccessible(page);
  await openTab(page, 'Pledges');
  await expect(
    page
      .getByRole('heading', { name: 'Pledges are off for this publication' })
      .or(page.getByRole('heading', { name: 'No pledges yet' })),
  ).toBeVisible();
  await expectAccessible(page);

  // A paid Dispatch with a Gate for the Supporter level.
  await openSection(page, 'Posts');
  await newPost(page);
  const body = postBody(page);
  await expect(body).toBeVisible();
  await page.getByLabel('Subject').fill('Spring tide tables');
  await body.click();
  await page.keyboard.type('The preview everyone reads.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('The full tables, for Supporters.');
  await body.getByText('The preview everyone reads.').click();
  await insertBlock(page, 'Paywall break');
  await expectPostSaved(page);
  await openMoreOptions(page);
  await page.getByLabel('Who can read it on the website').selectOption('paid');
  const gate = page.getByRole('form', { name: 'Paywall' });
  await expect(gate).toBeVisible();
  await gate.getByLabel('Chosen plans').check();
  await gate.getByLabel('Supporter', { exact: true }).check();
  await gate.getByText('Custom paywall copy').click();
  await gate.getByLabel('Headline').fill('The tables are for Supporters');
  await gate.getByRole('button', { name: 'Save paywall' }).click();
  await expect(gate.getByRole('status').filter({ hasText: 'Paywall saved.' })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Publish to web only' }).click();
  await expect(page.getByText('On the website', { exact: true })).toBeVisible();
  const href = await page.getByRole('link', { name: /View on site/ }).getAttribute('href');
  const dispatchPath = new URL(href!).pathname;
  const editorUrl = page.url();

  // A reader stops at the Gate, then buys the level on the plans page.
  await page.goto(siteUrl(slug, dispatchPath));
  await expect(page.getByRole('heading', { name: 'The tables are for Supporters' })).toBeVisible();
  await expect(page.getByText('The full tables, for Supporters.')).toHaveCount(0);
  await page.goto(siteUrl(slug, '/subscribe'));
  const plan = page.getByRole('listitem').filter({
    has: page.getByRole('heading', { level: 2, name: 'Supporter' }),
  });
  await expect(plan).toContainText('$5 a month');
  await plan.getByLabel('Email').fill(reader);
  // Cloudflare's always-pass test keys fill the token in the widget.
  await expect(plan.locator('input[name="cf-turnstile-response"]')).toHaveValue(/.+/, {
    timeout: 30_000,
  });
  await plan.getByRole('button', { name: /^Subscribe for/ }).click();
  await expect(page.getByRole('heading', { name: 'Test checkout' })).toBeVisible();
  await page.getByRole('button', { name: 'Complete test purchase' }).click();
  await expect(page.getByRole('heading', { name: /You.re in/ })).toBeVisible({ timeout: 20_000 });

  // The Member's Membership in the drawer.
  await page.goto(editorUrl);
  await openSection(page, 'Subscribers');
  await page.getByRole('button', { name: reader }).click();
  const drawer = page.getByRole('dialog', { name: reader });
  const membership = drawer.getByRole('region', { name: 'Paid subscription' });
  await expect(membership).toContainText('Supporter');
  // Where it came from, not the section's heading, which says the same words.
  await expect(membership.locator('dd', { hasText: 'Paid subscription' })).toBeVisible();
  await expect(membership.getByRole('button', { name: 'Give complimentary access' })).toBeVisible();
  await expectAccessible(page);
  await drawer.getByRole('button', { name: 'Close' }).click();

  // Revenue counts the new paid Member.
  await page.goto(`/memberships/${channelId}/revenue`);
  const active = page.getByText('Active paid subscribers').locator('..');
  await expect(active).toContainText('1');
  await expect(page.getByRole('heading', { name: 'Revenue by day' })).toBeVisible();
  await expect(page.getByText('$5', { exact: false }).first()).toBeVisible();
  await expectAccessible(page);
});
