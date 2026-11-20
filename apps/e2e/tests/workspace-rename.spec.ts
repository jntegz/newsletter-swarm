import { expect, test } from '@playwright/test';
import { createPublication, signIn } from './helpers';

test('renaming a workspace can rename its only publication too', async ({ page, request }) => {
  const stamp = Date.now() * 10 + test.info().parallelIndex;
  await page.goto('/');
  await signIn(page, request, `rename-${stamp}@example.com`);
  await createPublication(page, 'Old Publication', `rename-${stamp.toString(36)}`);

  await page.goto('/settings/workspace');
  await page.getByLabel('Workspace name').fill('New Name');
  const also = page.getByLabel('Also rename the publication “Old Publication”');
  await expect(also).toBeVisible();
  await also.check();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  await page.goto('/channels');
  await expect(page.getByText('New Name').first()).toBeVisible();
  await expect(page.getByText('Old Publication')).toHaveCount(0);
});
