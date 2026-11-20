// "Stop emails, keep my membership" (workers/capture/src/routes/member.ts): one click from the
// footer link, since it only reduces mail. Posts skip the subscriber from then on, while their
// subscription and paid plan stay as they are.
import { expect, test } from '@playwright/test';
import { expectAccessible, openSection, signIn } from './helpers';
import {
  buySupporter,
  lastMailId,
  linkIn,
  masked,
  nextMail,
  ownCaptureClient,
  paidPublication,
  sendBroadcast,
} from './subscriber-links';

test('a paying subscriber stops emails from the footer link and keeps their paid subscription', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(240_000);
  const stamp = Date.now() * 10 + test.info().parallelIndex;
  const name = 'Orchard Post';
  const paid = `paid-${stamp}@example.org`;
  const free = `free-${stamp}@example.org`;

  await page.goto('/');
  await signIn(page, request, `quiet-${stamp}@example.com`);
  const slug = `quiet-${stamp.toString(36)}`;
  await paidPublication(page, name, slug, [paid, free]);
  await buySupporter(browser, slug, paid);
  await sendBroadcast(page, 'Orchard Post, issue 1', 2);
  const footer = linkIn(await nextMail(request, paid, 'broadcast', null), '/m/');
  const dashboard = page.url();

  const reader = await (await browser.newContext()).newPage();
  await ownCaptureClient(reader);
  await reader.goto(footer);
  await expect(
    reader.getByRole('heading', { name: 'Stop emails, keep my membership' }),
  ).toBeVisible();
  const before = await lastMailId(request, paid);
  // One click, even from a footer link.
  await reader.getByRole('button', { name: 'Stop emails, keep my membership' }).click();
  await expect(reader.getByRole('status')).toHaveText(
    'Emails are off. Your subscription stays as it is.',
  );
  await expect(
    reader.getByText(
      `Emails are off: ${name} sends no posts or automation emails to ${masked(paid)}.`,
    ),
  ).toBeVisible();
  // The paid subscription is untouched, and pausing (which is about emails) is no longer offered.
  await expect(reader.getByRole('heading', { name: 'Your paid subscription' })).toBeVisible();
  await expect(reader.getByText(/^Renews on /)).toBeVisible();
  await expect(
    reader.getByRole('button', { name: 'Cancel at the end of the period' }),
  ).toBeVisible();
  await expect(reader.getByRole('heading', { name: 'Take a break' })).toHaveCount(0);
  await expect(reader.getByRole('button', { name: 'Turn emails back on' })).toBeVisible();
  await expectAccessible(reader);
  const notice = await nextMail(request, paid, 'member_change', before);
  expect(notice.subject).toBe(`A change to your subscription to ${name}`);
  expect(notice.text).toContain('Emails were turned off');

  // The team sees the choice and the paid subscription side by side.
  await page.goto(dashboard);
  await openSection(page, 'Subscribers');
  await page.getByRole('button', { name: paid }).click();
  const drawer = page.getByRole('dialog', { name: paid });
  await expect(drawer.getByText(/^Turned emails off on /)).toBeVisible();
  await expect(drawer.getByRole('region', { name: 'Paid subscription' })).toContainText(
    'Supporter',
  );
  await expectAccessible(page);
  await drawer.getByRole('button', { name: 'Close' }).click();

  // The next post goes to the other subscriber only: the audience counts one.
  const freeBefore = await lastMailId(request, free);
  await sendBroadcast(page, 'Orchard Post, issue 2', 1);
  const next = await nextMail(request, free, 'broadcast', freeBefore);
  expect(next.subject).toBe('Orchard Post, issue 2');
  expect((await nextMail(request, paid, 'member_change', null)).id).toBe(notice.id);

  // And they can turn emails back on whenever they like.
  await reader.goto(footer);
  await reader.getByRole('button', { name: 'Turn emails back on' }).click();
  await expect(reader.getByRole('status')).toHaveText(
    'Emails are on again. You will receive the next post.',
  );
  await expect(reader.getByText(`You receive ${name} at ${masked(paid)}.`)).toBeVisible();
  await reader.context().close();
});
