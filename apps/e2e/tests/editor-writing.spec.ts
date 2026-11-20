// Writing in the post editor: a new post starts in the title, Enter moves on to the preview text
// and the body, opening a post changes nothing, the insert menu searches, the selection bar
// formats, Ctrl/⌘ S saves, and focus mode clears the screen and gives it back.
import { expect, test } from '@playwright/test';
import {
  createPublication,
  expectAccessible,
  expectPostSaved,
  newPost,
  openSection,
  postBody,
  signIn,
} from './helpers';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

test('a writer goes from the title to the body with the keyboard and works without the rail', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  await page.goto('/');
  await signIn(page, request, `writing-${stamp}@example.com`);
  await createPublication(page, 'Quiet Pages', `writing-${stamp.toString(36)}`);
  await openSection(page, 'Posts');
  await newPost(page);

  // A new post starts in the title; Enter goes to the preview text, then into the body.
  const subject = page.getByLabel('Subject', { exact: true });
  await expect(subject).toBeFocused();
  await page.keyboard.type('Low water');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Preview text', { exact: true })).toBeFocused();
  await page.keyboard.type('What the tide leaves behind');
  await page.keyboard.press('Enter');
  await expect(postBody(page)).toBeFocused();
  await page.keyboard.type('Shells, mostly. And one boot.');
  await expect(page.getByText(/5 words · 1 min read/)).toBeVisible();

  // Ctrl/⌘ S saves now instead of saving the web page.
  await page.keyboard.press(`${mod}+s`);
  await expectPostSaved(page);

  // Opening the post again changes nothing, so there is nothing to save.
  await page.reload();
  await expect(postBody(page)).toContainText('Shells, mostly.');
  await expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible();
  await page.waitForTimeout(2_000);
  await expect(page.getByRole('status').filter({ hasText: 'Unsaved changes' })).toHaveCount(0);

  // The insert menu searches, like the "/" menu.
  const toolbar = page.getByRole('toolbar', { name: 'Formatting' });
  await postBody(page).click();
  await toolbar.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(toolbar.getByLabel('Find a block')).toBeFocused();
  await page.keyboard.type('callo');
  await expect(toolbar.getByRole('button', { name: 'Callout', exact: true })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Image', exact: true })).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(postBody(page).locator('aside[data-callout]')).toHaveCount(1);

  // Selecting text shows a small bar that formats it.
  // On the first word: the middle of the line is past the text, where a double click selects only
  // the line break on Windows.
  await postBody(page)
    .getByText('Shells, mostly.')
    .dblclick({ position: { x: 20, y: 10 } });
  const bar = page.getByRole('toolbar', { name: 'Format the selection' });
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Bold' }).click();
  await expect(postBody(page).locator('strong')).toHaveCount(1);

  // The shortcuts are listed.
  await page.keyboard.press(`${mod}+/`);
  const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(shortcuts).toBeVisible();
  await expectAccessible(page);
  await shortcuts.getByRole('button', { name: 'Close' }).click();

  // Focus mode: the rail, the top bar and the send panel step away; Escape brings them back.
  await postBody(page).click();
  await page.keyboard.press(`${mod}+\\`);
  await expect(page.getByRole('complementary', { name: 'Main navigation' })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Post settings' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Leave focus' })).toBeVisible();
  await expectAccessible(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('complementary', { name: 'Main navigation' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Post settings' })).toBeVisible();
  await expectPostSaved(page);
});
