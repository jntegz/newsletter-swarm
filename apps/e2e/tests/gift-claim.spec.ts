// Claiming a Gift Pass grants the gift and stops there (workers/site/src/routes/gifts.ts): no
// reader session is started, whatever address is typed, because a buyer could name their own
// address and pass the claim link on. The Member signs in with the usual emailed link.
import { expect, test, type BrowserContext } from '@playwright/test';
import { enableChannelFlag, forgetCached, signIn } from './helpers';
import {
  linkIn,
  nextMail,
  openUntil,
  paidPublication,
  siteUrl,
  workspaceOf,
} from './subscriber-links';

/** Whether this browser holds a reader session for the publication's website. */
const readerSession = async (context: BrowserContext) =>
  (await context.cookies()).some((c) => c.name.endsWith('swarm_reader'));

test('claiming a Gift Pass signs nobody in; the Member signs in by emailed link', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(180_000);
  const stamp = Date.now() * 10 + test.info().parallelIndex;
  const name = 'Lantern Review';
  const slug = `gift-${stamp.toString(36)}`;
  const buyer = `giver-${stamp}@example.org`;
  const recipient = `lucky-${stamp}@example.org`;

  await page.goto('/');
  await signIn(page, request, `gifts-${stamp}@example.com`);
  const channelId = await paidPublication(page, name, slug, []);
  // The dashboard has read this publication's flags already; the cached copy is shared.
  enableChannelFlag('gift_passes', channelId);
  forgetCached(`flags:v1:${await workspaceOf(page)}:${channelId}`);

  // The buyer pays for three months for someone else, on the dev stand-in for Checkout.
  const giving = await browser.newContext();
  const shop = await giving.newPage();
  const gift = shop.locator('section', {
    has: shop.getByRole('heading', { name: 'Give a gift subscription' }),
  });
  await openUntil(shop, siteUrl(slug, '/subscribe'), gift);
  await gift.getByLabel('Length').selectOption('3');
  await gift.getByLabel('Your email').fill(buyer);
  await gift.getByLabel('Their email').fill(recipient);
  await gift.getByLabel('Message (optional)').fill('Happy reading!');
  await expect(gift.locator('input[name="cf-turnstile-response"]')).toHaveValue(/.+/, {
    timeout: 30_000,
  });
  await gift.getByRole('button', { name: 'Buy a gift subscription' }).click();
  await expect(shop.getByRole('heading', { name: 'Test checkout' })).toBeVisible();
  await shop.getByRole('button', { name: 'Complete test purchase' }).click();
  await expect(
    shop.getByRole('heading', { name: 'Your gift subscription is on its way' }),
  ).toBeVisible({ timeout: 20_000 });
  await giving.close();

  // The recipient opens the claim link from their inbox, in a browser of their own.
  // Mail builds website addresses from PLATFORM_SITE_DOMAIN, which locally has no port.
  const mailed = new URL(
    linkIn(await nextMail(request, recipient, 'gift_pass', null), '/_swarm/gift/'),
  );
  expect(mailed.host).toBe(`${slug}.site.localhost`);
  const claimLink = siteUrl(slug, mailed.pathname);
  const receiving = await browser.newContext();
  const reader = await receiving.newPage();
  await reader.goto(claimLink);
  await expect(reader.getByRole('heading', { name: 'A gift for you' })).toBeVisible();
  await expect(reader.getByText('Happy reading!')).toBeVisible();
  await expect(reader.getByLabel('Your email')).toHaveValue(recipient);
  await reader.getByRole('button', { name: 'Claim the gift' }).click();
  await expect(reader.getByRole('heading', { name: 'Your gift is claimed' })).toBeVisible();
  await expect(
    reader.getByText(
      `3 months of paid subscription are on ${recipient}. Sign in with that address to start reading.`,
    ),
  ).toBeVisible();

  // Claiming signed nobody in: no reader session, and the plans page treats them as a visitor.
  expect(await readerSession(receiving)).toBe(false);
  await reader.goto(siteUrl(slug, '/subscribe'));
  await expect(reader.getByRole('button', { name: 'Sign out on every device' })).toHaveCount(0);
  // The link is single use.
  await reader.goto(claimLink);
  await expect(
    reader.getByRole('heading', { name: 'This gift subscription was already claimed' }),
  ).toBeVisible();

  // Signing in takes the emailed link, which proves the mailbox.
  await reader.getByRole('link', { name: 'sign in' }).click();
  await reader.getByLabel('Email').fill(recipient);
  await reader.getByRole('button', { name: 'Email me a link' }).click();
  await expect(reader.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const signInLink = linkIn(
    await nextMail(request, recipient, 'reader_signin', null),
    '/_swarm/reader/consume',
  );
  await reader.goto(signInLink);
  await expect(reader.getByRole('heading', { name: `Continue to ${name}` })).toBeVisible();
  await expect(reader.getByText(`Sign in as ${recipient} on this device`)).toBeVisible();
  await reader.getByRole('button', { name: 'Continue' }).click();
  await expect.poll(() => readerSession(receiving)).toBe(true);
  await reader.goto(siteUrl(slug, '/subscribe'));
  await expect(reader.getByRole('button', { name: 'Sign out on every device' })).toBeVisible();
  await receiving.close();
});
