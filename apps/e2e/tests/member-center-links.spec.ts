// The footer link in every email opens a Member Center summary only (workers/capture/src/routes/
// member.ts): it travels with forwarded mail. Low-harm changes stay one click; anything that shows
// personal or billing detail, or can't be taken back, emails a fresh link first. Every change
// made through a link is mailed to the address, and older links can be turned off.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { expectAccessible, signIn } from './helpers';
import {
  CAPTURE,
  buySupporter,
  centerForm,
  lastMailId,
  linkIn,
  masked,
  nextMail,
  ownCaptureClient,
  paidPublication,
  sendBroadcast,
} from './subscriber-links';

/** Presses a footer-link action that needs a fresh link; returns the link that was mailed. */
async function askForFreshLink(
  page: Page,
  request: APIRequestContext,
  email: string,
  press: () => Promise<void>,
  reason: string,
): Promise<string> {
  const before = await lastMailId(request, email);
  await press();
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
  await expect(page.getByText(`${reason} needs a fresh link.`)).toContainText(masked(email));
  const mail = await nextMail(request, email, 'member_center', before);
  return linkIn(mail, '/m/');
}

test('a footer link shows a summary, keeps the small changes one click and asks for a fresh link for the rest', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(300_000);
  const stamp = Date.now() * 10 + test.info().parallelIndex;
  const name = 'Garden Letters';
  const paid = `paid-${stamp}@example.org`;
  const free = `free-${stamp}@example.org`;

  await page.goto('/');
  await signIn(page, request, `center-${stamp}@example.com`);
  const slug = `center-${stamp.toString(36)}`;
  await paidPublication(page, name, slug, [paid, free]);
  await buySupporter(browser, slug, paid);
  await sendBroadcast(page, 'Garden Letters, issue 1', 2);
  const footer = {
    paid: linkIn(await nextMail(request, paid, 'broadcast', null), '/m/'),
    free: linkIn(await nextMail(request, free, 'broadcast', null), '/m/'),
  };
  expect(footer.paid.startsWith(`${CAPTURE}/m/`)).toBe(true);

  const reader = await (await browser.newContext()).newPage();
  await ownCaptureClient(reader);

  await test.step('the footer link shows a masked summary', async () => {
    await reader.goto(footer.paid);
    await expect(
      reader.getByRole('heading', { level: 1, name: 'Subscriber settings' }),
    ).toBeVisible();
    await expect(reader.getByText(`You receive ${name} at ${masked(paid)}.`)).toBeVisible();
    await expect(reader.locator('body')).not.toContainText(paid);
    await expect(reader.getByRole('heading', { name: 'Your paid subscription' })).toBeVisible();
    await expect(reader.getByText('Supporter', { exact: true })).toBeVisible();
    // No profile values and no invoices, only a way to ask for them.
    await expect(reader.getByLabel('First name')).toHaveCount(0);
    await expect(
      reader.getByText('To see or change your details, open a link we email you.'),
    ).toBeVisible();
    await expect(reader.getByText('To see your invoices, open a link we email you.')).toBeVisible();
    await expectAccessible(reader);
  });

  await test.step('canceling at period end and keeping it are one click, and each is mailed', async () => {
    let before = await lastMailId(request, paid);
    await reader.getByRole('button', { name: 'Cancel at the end of the period' }).click();
    await expect(reader.getByRole('status')).toHaveText(
      'Your paid subscription will end when the period you paid for ends.',
    );
    await expect(reader.getByText(/^Canceled\. You keep access until/)).toBeVisible();
    let notice = await nextMail(request, paid, 'member_change', before);
    expect(notice.subject).toBe(`A change to your subscription to ${name}`);
    expect(notice.text).toContain(
      'Your paid subscription was set to end when the current period ends.',
    );

    before = notice.id;
    await reader.getByRole('button', { name: 'Keep my subscription' }).click();
    await expect(reader.getByRole('status')).toHaveText('Your paid subscription continues.');
    await expect(reader.getByText(/^Renews on /)).toBeVisible();
    notice = await nextMail(request, paid, 'member_change', before);
    expect(notice.text).toContain(
      'Your paid subscription was set to continue after the current period.',
    );
  });

  await test.step('invoices need a fresh link, which then shows them', async () => {
    await reader.goto(footer.paid);
    const fresh = await askForFreshLink(
      reader,
      request,
      paid,
      () => centerForm(reader, 'invoices').getByRole('button', { name: 'Email me a link' }).click(),
      'Seeing your invoices',
    );
    await expectAccessible(reader);
    await reader.goto(fresh);
    // The whole address and the invoices, on a link that was just emailed.
    await expect(reader.getByText(`You receive ${name} at ${paid}.`)).toBeVisible();
    await expect(reader.getByRole('heading', { name: 'Invoices' })).toBeVisible();
    await expect(reader.getByText('No invoices yet.')).toBeVisible();
  });

  await test.step('the payment portal needs a fresh link, which then opens it', async () => {
    await reader.goto(footer.paid);
    const fresh = await askForFreshLink(
      reader,
      request,
      paid,
      () => reader.getByRole('button', { name: 'Update payment method' }).click(),
      'Changing your payment method',
    );
    await reader.goto(fresh);
    const before = await lastMailId(request, paid);
    await reader.getByRole('button', { name: 'Update payment method' }).click();
    // The dev Billing Portal sends the Member straight back, to an address without a token.
    await expect(reader).toHaveURL(`${CAPTURE}/m/back`);
    await expect(
      reader.getByRole('heading', { name: 'You are back from the payment page' }),
    ).toBeVisible();
    const notice = await nextMail(request, paid, 'member_change', before);
    expect(notice.text).toContain(
      'Someone opened the page to change the payment method for your paid subscription.',
    );
  });

  await test.step('profile edits need a fresh link, and the change is mailed', async () => {
    await reader.goto(footer.paid);
    const fresh = await askForFreshLink(
      reader,
      request,
      paid,
      () => centerForm(reader, 'profile').getByRole('button', { name: 'Email me a link' }).click(),
      'Seeing or changing your details',
    );
    await reader.goto(fresh);
    await reader.getByLabel('First name').fill('Ada');
    const before = await lastMailId(request, paid);
    await reader.getByRole('button', { name: 'Save details' }).click();
    await expect(reader.getByRole('status')).toHaveText('Your details are saved.');
    await expect(reader.getByLabel('First name')).toHaveValue('Ada');
    const notice = await nextMail(request, paid, 'member_change', before);
    expect(notice.text).toContain('Your name or profile details were changed.');
  });

  await test.step('turning tracking off needs a fresh link, and the change is mailed', async () => {
    await reader.goto(footer.free);
    await expect(reader.getByText(`You receive ${name} at ${masked(free)}.`)).toBeVisible();
    const tracking = centerForm(reader, 'tracking');
    const fresh = await askForFreshLink(
      reader,
      request,
      free,
      async () => {
        await tracking.getByLabel('Don’t track my opens and clicks').check();
        await tracking.getByRole('button', { name: 'Save' }).click();
      },
      'Turning tracking off',
    );
    await reader.goto(fresh);
    await tracking.getByLabel('Don’t track my opens and clicks').check();
    const before = await lastMailId(request, free);
    await tracking.getByRole('button', { name: 'Save' }).click();
    await expect(reader.getByRole('status')).toHaveText('Your choice is saved.');
    await expect(tracking.getByLabel('Don’t track my opens and clicks')).toBeChecked();
    const notice = await nextMail(request, free, 'member_change', before);
    expect(notice.text).toContain('Tracking of your opens and clicks was turned off');
  });

  await test.step('turning off older links ends the footer link', async () => {
    await reader.goto(footer.free);
    const fresh = await askForFreshLink(
      reader,
      request,
      free,
      () => reader.getByRole('button', { name: 'Turn off older links' }).click(),
      'Turning off older links',
    );
    await reader.goto(fresh);
    await expect(reader.getByText('This link keeps working.')).toBeVisible();
    const before = await lastMailId(request, free);
    await reader.getByRole('button', { name: 'Turn off older links' }).click();
    await expect(reader.getByRole('status')).toHaveText('Older links to this page no longer work.');
    const notice = await nextMail(request, free, 'member_change', before);
    expect(notice.text).toContain('Older links to your subscriber settings were turned off.');

    // The footer link from the Broadcast no longer opens anything; the link in use still does.
    const old = await reader.goto(footer.free);
    expect(old?.status()).toBe(404);
    await expect(reader.getByRole('heading', { name: 'This link does not work' })).toBeVisible();
    await expectAccessible(reader);
    await reader.goto(fresh);
    await expect(
      reader.getByRole('heading', { level: 1, name: 'Subscriber settings' }),
    ).toBeVisible();
    // So does the link in the notice, issued after the cut.
    await reader.goto(linkIn(notice, '/m/'));
    await expect(reader.getByText(`You receive ${name} at ${free}.`)).toBeVisible();
  });

  await reader.context().close();
});
