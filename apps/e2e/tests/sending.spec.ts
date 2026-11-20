import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  API,
  chooseEveryone,
  createPublication,
  expectAccessible,
  expectPostSaved,
  newPost,
  openSection,
  openStop,
  postBody,
  postSettings,
  sendNow,
  signIn,
  turnOnTracking,
} from './helpers';

interface StoredMail {
  subject: string;
  html: string;
  text: string;
  category: string;
  headers?: Record<string, string>;
}

async function latestMail(
  request: APIRequestContext,
  to: string,
  category: string,
): Promise<StoredMail> {
  let mail: StoredMail | null = null;
  await expect
    .poll(
      async () => {
        const res = await request.get(`${API}/__dev/mail/latest.json?to=${encodeURIComponent(to)}`);
        if (res.status() !== 200) return null;
        mail = ((await res.json()) as { data: StoredMail }).data;
        return mail.category;
      },
      { timeout: 30_000 },
    )
    .toBe(category);
  return mail as unknown as StoredMail;
}

test('an operator writes a Dispatch, tests it, sends it to Members and a Member unsubscribes with one click', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now() * 10 + test.info().parallelIndex;
  const owner = `writer-${stamp}@example.com`;
  const readers = [`reader-a-${stamp}@example.org`, `reader-b-${stamp}@example.org`];

  await page.goto('/');
  await signIn(page, request, owner);
  await createPublication(page, 'Field Notes', `notes-${stamp.toString(36)}`);
  // The mail's links go through the track worker only with click tracking on, which a new
  // publication starts without.
  await turnOnTracking(page, /\/channels\/(ch_[0-9a-f]{32})/.exec(page.url())![1]!, [
    'trackClicks',
  ]);

  // Subscribers
  await openSection(page, 'Subscribers');
  await expect(page.getByRole('heading', { name: 'No subscribers yet' })).toBeVisible();
  for (const [index, email] of readers.entries()) {
    await page.getByRole('button', { name: 'Add subscriber' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add a subscriber' });
    await dialog.getByLabel('Email').fill(email);
    if (index === 0) await dialog.getByLabel('First name').fill('Ada');
    // Without consent a subscriber starts pending and isn't sent to.
    await dialog.getByLabel('They asked to receive this publication').check();
    await dialog.getByRole('button', { name: 'Add subscriber' }).click();
    await expect(page.getByRole('cell', { name: email, exact: true })).toBeVisible();
  }
  await expectAccessible(page);

  // Write a post
  await openSection(page, 'Posts');
  await expect(page.getByRole('heading', { name: 'No posts yet' })).toBeVisible();
  await expectAccessible(page);
  await newPost(page);

  await page.getByLabel('Subject').fill('Field Notes, issue 1');
  await page.getByLabel('Preview text').fill('What we found this week');
  const body = postBody(page);
  await body.click();
  await page.keyboard.type('Hi ');
  await page.getByLabel('Insert a merge tag').selectOption({ label: 'First name' });
  await page.keyboard.type(', read the essay.');
  // Select "the essay" and link it through the link dialog.
  await page.keyboard.press('ArrowLeft');
  for (let i = 0; i < 'the essay'.length; i++) await page.keyboard.press('Shift+ArrowLeft');
  // The selection bar offers the same button over the selected text; this is the toolbar's.
  await page
    .getByRole('toolbar', { name: 'Formatting' })
    .getByRole('button', { name: 'Add link' })
    .click();
  const linkDialog = page.getByRole('dialog', { name: 'Link' });
  await linkDialog.getByLabel('Web address').fill('https://essay.example/issue-1');
  await linkDialog.getByRole('button', { name: 'Apply' }).click();
  await expect(body.getByRole('link', { name: 'the essay' })).toBeVisible();
  await expectPostSaved(page);
  await expectAccessible(page);

  // Test send, from the last stop of the send route.
  await openStop(page, 'Check & send');
  const route = postSettings(page);
  await expect(route.getByLabel('Send a test')).toHaveValue(owner);
  await route.getByRole('button', { name: 'Send test' }).click();
  await expect(route.getByText(`Sent to ${owner}.`)).toBeVisible();
  const testMail = await latestMail(request, owner, 'test');
  expect(testMail.subject).toBe('[Test] Field Notes, issue 1');
  expect(testMail.html).toContain('href="https://essay.example/issue-1"');

  // Who gets it is a deliberate choice: the send button says so until it is made.
  const send = route.getByRole('button', { name: 'Send to 2 subscribers' });
  await expect(send).toBeDisabled();
  await expect(route.getByText('Choose who gets this post first.')).toBeVisible();
  await chooseEveryone(page);

  // Check and send: the exact count is shown, then the send runs on the queue.
  await sendNow(page, 2);

  await expect(page).toHaveURL(/\/broadcasts\/bc_/);
  await expect(page.getByRole('heading', { level: 1, name: 'Field Notes, issue 1' })).toBeVisible();
  await expect(page.getByText('Sent', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('2 of 2')).toBeVisible();
  await expectAccessible(page);

  // What a subscriber receives
  const mail = await latestMail(request, readers[0]!, 'broadcast');
  expect(mail.subject).toBe('Field Notes, issue 1');
  expect(mail.html).toContain('Hi Ada, read');
  expect(mail.html).not.toContain('essay.example');
  expect(mail.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  const unsubscribeUrl = /<(http[^>]+\/u\/[^>]+)>/.exec(
    mail.headers?.['List-Unsubscribe'] ?? '',
  )?.[1];
  expect(unsubscribeUrl).toBeTruthy();
  const clickUrl = /href="(http[^"]+\/c\/[^"]+)"/.exec(mail.html)?.[1];
  const click = await request.get(clickUrl!.replace(/&amp;/g, '&'), { maxRedirects: 0 });
  expect(click.status()).toBe(302);
  expect(click.headers().location).toBe('https://essay.example/issue-1');

  // The mailbox provider's One-Click POST unsubscribes immediately.
  const unsubscribe = await request.post(unsubscribeUrl!, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    data: 'List-Unsubscribe=One-Click',
  });
  expect(unsubscribe.status()).toBe(200);

  await openSection(page, 'Subscribers');
  await page.getByRole('button', { name: /^Unsubscribed/ }).click();
  await expect(page.getByRole('cell', { name: readers[0]!, exact: true })).toBeVisible();
});
