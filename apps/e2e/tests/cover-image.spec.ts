import { expect, test } from '@playwright/test';
import {
  PNG,
  createPublication,
  expectAccessible,
  expectPostSaved,
  newPost,
  openSection,
  signIn,
} from './helpers';

test('a writer adds, describes, previews and removes a cover image', async ({ page, request }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  await page.goto('/');
  await signIn(page, request, `cover-${stamp}@example.com`);
  await createPublication(page, 'Cover Letters', `cover-${stamp.toString(36)}`);
  await openSection(page, 'Posts');
  await newPost(page);

  const cover = page.getByRole('region', { name: 'Cover image' });
  await cover.getByRole('button', { name: 'Add cover image' }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Choose a cover image' });
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'cover.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  await expect(dialog.getByRole('button', { name: 'Use this image' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Use this image' }).click();

  const alt = cover.getByLabel('Alt text');
  await expect(alt).toBeFocused();
  await alt.fill('A fox at dawn');
  await expectPostSaved(page);
  await expect(cover.getByRole('img', { name: 'A fox at dawn' })).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('radio', { name: 'Email · desktop' }).check({ force: true });
  const preview = page.frameLocator('iframe[title="Email preview"]');
  await expect(preview.getByRole('img', { name: 'A fox at dawn' })).toBeAttached();
  await page.getByRole('radio', { name: 'Edit' }).check({ force: true });

  // Works at 390 wide without scrolling sideways.
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(cover.getByRole('button', { name: 'Change image' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await cover.getByRole('button', { name: 'Remove image' }).click();
  await expect(cover.getByRole('button', { name: 'Add cover image' })).toBeFocused();
  await expectPostSaved(page);
});
