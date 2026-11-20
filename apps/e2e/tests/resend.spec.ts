import { expect, test, type Page } from '@playwright/test';
import {
  API,
  chooseEveryone,
  createPublication,
  enableWorkspaceFlag,
  expectAccessible,
  expectPostSaved,
  localSql,
  newPost,
  openMoreOptions,
  openSection,
  openStop,
  postBody,
  postSettings,
  sendNow,
  signIn,
  turnOnTracking,
} from './helpers';

async function addMember(page: Page, channelId: string, email: string) {
  const status = await page.evaluate(
    async ({ channelId, email }) => {
      const res = await fetch(`/api/v1/channels/${channelId}/members`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, consent: true }),
      });
      return res.status;
    },
    { channelId, email },
  );
  expect(status).toBe(201);
}

test('a writer sends a post again to the people who didn’t open it, and leaves a note', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now() * 10 + test.info().parallelIndex;
  const opener = `opener-${stamp}@example.org`;
  const others = [`quiet-a-${stamp}@example.org`, `quiet-b-${stamp}@example.org`];
  const mailTo = async (email: string) => {
    const res = await request.get(`${API}/__dev/mail/latest.json?to=${encodeURIComponent(email)}`);
    if (res.status() !== 200) return null;
    return ((await res.json()) as { data: { subject: string } }).data.subject;
  };

  await page.goto('/');
  await signIn(page, request, `resend-${stamp}@example.com`);
  const workspaceId = await page.evaluate(async () => {
    const res = await fetch('/api/v1/auth/session', { credentials: 'same-origin' });
    return ((await res.json()) as { data: { workspaces: { id: string }[] } }).data.workspaces[0]!
      .id;
  });
  enableWorkspaceFlag('resend_unopens', workspaceId);
  await createPublication(page, 'Second Chances', `resend-${stamp.toString(36)}`);
  const channelId = /\/channels\/(ch_[0-9a-f]{32})/.exec(page.url())![1]!;
  // Who didn't open is known only with open tracking on, which a new publication starts without.
  await turnOnTracking(page, channelId, ['trackOpens']);
  for (const email of [opener, ...others]) await addMember(page, channelId, email);

  await openSection(page, 'Posts');
  await newPost(page);
  await page.getByLabel('Subject').fill('The first try');
  await postBody(page).click();
  await page.keyboard.type('Worth reading twice.');
  await expectPostSaved(page);

  // A note for the team goes with the post and stays when it reloads.
  await openMoreOptions(page);
  const note = page.getByLabel('Note for your team');
  await note.fill('Check the numbers with Sam.');
  await note.blur();
  await expect
    .poll(async () => {
      await page.reload();
      await openMoreOptions(page);
      return page.getByLabel('Note for your team').inputValue();
    })
    .toBe('Check the numbers with Sam.');

  await chooseEveryone(page);
  await sendNow(page, 3);
  await expect(page).toHaveURL(/\/broadcasts\/bc_/);
  await expect(page.getByText('Sent', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => mailTo(opener)).toBe('The first try');

  // One person opens it.
  localSql(`UPDATE deliveries SET human_opened_at = ${Date.now()} WHERE email = '${opener}'`);

  await page.getByRole('button', { name: 'Send again to people who didn’t open' }).click();
  await expect(page).toHaveURL(/\/dispatches\/dp_/);
  await page.getByLabel('Subject').fill('In case you missed it');
  await expectPostSaved(page);
  await openStop(page, 'Who gets it');
  await expect(postSettings(page).getByText('didn’t open or click')).toBeVisible();
  await expectAccessible(page);

  // Choosing "Everyone" here still means everyone who didn't open: the real send proves it.
  await chooseEveryone(page);
  await sendNow(page, 2);
  await expect(page).toHaveURL(/\/broadcasts\/bc_/);
  await expect(page.getByText('Sent', { exact: true })).toBeVisible({ timeout: 60_000 });
  for (const email of others) {
    await expect.poll(() => mailTo(email)).toBe('In case you missed it');
  }
  expect(await mailTo(opener)).toBe('The first try');
});
