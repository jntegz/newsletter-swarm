// The public "Your data" page (workers/capture/src/routes/privacy.ts), linked from every website's
// footer: anyone can ask for a copy of what a publication holds about an address, subscriber or
// not. The answer is the same for any address; the request only goes ahead from a single-use link
// mailed to the address.
import { expect, test } from '@playwright/test';
import { expectAccessible, signIn } from './helpers';
import {
  CAPTURE,
  api,
  lastMailId,
  linkIn,
  masked,
  nextMail,
  ownCaptureClient,
  siteUrl,
  workspaceOf,
} from './subscriber-links';

test('someone who is not a subscriber asks for their data from the website footer and confirms once', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now() * 10 + test.info().parallelIndex;
  const name = 'Harbour Notes';
  const slug = `data-${stamp.toString(36)}`;
  const stranger = `stranger-${stamp}@example.org`;

  await page.goto('/');
  await signIn(page, request, `rights-${stamp}@example.com`);
  const channel = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/workspaces/${await workspaceOf(page)}/channels`,
    { name, slug },
  );

  const visitor = await (await browser.newContext()).newPage();
  await ownCaptureClient(visitor);
  await visitor.goto(siteUrl(slug));
  await visitor
    .getByRole('navigation', { name: 'Footer' })
    .getByRole('link', { name: 'Your data' })
    .click();
  await expect(visitor).toHaveURL(`${CAPTURE}/privacy/${channel.id}`);
  await expect(visitor.getByRole('heading', { name: 'Ask about your data' })).toBeVisible();
  await expectAccessible(visitor);

  // The address isn't on any list; the answer doesn't say so.
  const ask = async () => {
    await visitor.getByLabel('Email address').fill(stranger);
    await visitor.getByLabel('A copy of my data').check();
    await visitor.getByRole('button', { name: 'Email me a link to confirm' }).click();
    await expect(visitor.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
    await expect(
      visitor.getByText(`If ${masked(stranger)} can receive our emails, a link to confirm`),
    ).toBeVisible();
  };
  await ask();
  await expectAccessible(visitor);
  const mail = await nextMail(request, stranger, 'privacy_confirm', null);
  expect(mail.subject).toBe(`Confirm your request for your data from ${name}`);
  const link = linkIn(mail, '/privacy/confirm/');

  // Asking again straight away gets the same answer, and no second link while the first is open.
  await visitor.goto(`${CAPTURE}/privacy/${channel.id}`);
  await ask();
  await visitor.waitForTimeout(3000);
  expect(await lastMailId(request, stranger)).toBe(mail.id);

  // Opening the link changes nothing until the button is pressed.
  await visitor.goto(link);
  await expect(visitor.getByRole('heading', { name: 'Get a copy of your data' })).toBeVisible();
  await expectAccessible(visitor);
  await visitor.getByRole('button', { name: 'Send me a copy' }).click();
  await expect(visitor.getByRole('heading', { name: 'Your request was received' })).toBeVisible();

  // The link works once.
  const again = await visitor.goto(link);
  expect(again?.status()).toBe(404);
  await expect(visitor.getByRole('heading', { name: 'This link does not work' })).toBeVisible();
  await visitor.context().close();
});
