import { expect, test } from '@playwright/test';
import { createPublication, expectAccessible, openSection, signIn } from './helpers';

test('inbox rules start off, and a writer can set quiet hours and a limit', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now();

  await page.goto('/');
  await signIn(page, request, `inbox-rules-${stamp}@example.com`);
  await createPublication(page, 'Field Notes', `rules-${stamp.toString(36)}`);

  await openSection(page, 'Automations');
  await page.getByRole('link', { name: 'Inbox rules' }).click();
  await expect(page.getByRole('heading', { name: 'Inbox rules' })).toBeVisible();
  await expect(page.getByText('No emails are held right now.')).toBeVisible();

  // Nothing is on until a person turns it on.
  const limit = page.getByRole('checkbox', { name: 'Limit automated emails per subscriber' });
  const quiet = page.getByRole('checkbox', { name: 'No automated email between these times' });
  const postDay = page.getByRole('checkbox', {
    name: 'No automated email on a day a subscriber gets a post',
  });
  await expect(limit).not.toBeChecked();
  await expect(quiet).not.toBeChecked();
  await expect(postDay).not.toBeChecked();
  await expectAccessible(page);

  await limit.check();
  await page.getByLabel('Per day').fill('2');
  await quiet.check();
  await page.getByLabel('From').fill('22:00');
  await page.getByLabel('Until').fill('08:00');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  await page.reload();
  await expect(limit).toBeChecked();
  await expect(page.getByLabel('Per day')).toHaveValue('2');
  await expect(quiet).toBeChecked();
  await expect(page.getByLabel('From')).toHaveValue('22:00');
  await expect(postDay).not.toBeChecked();
});
