import { expect, test, type Page } from '@playwright/test';
import { createPublication, expectPostSaved, newPost, openSection, signIn } from './helpers';
import { publication } from './screens';

/** The text of the top-level blocks, in order, without the labels drawn between them. */
const blocks = (page: Page) =>
  page
    .getByRole('textbox', { name: 'Post body' })
    .locator('> :not(.editor-show-on)')
    .allInnerTexts();

test('a writer moves blocks by handle and by keyboard', async ({ page, request }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  await page.goto('/');
  await signIn(page, request, `blocks-${stamp}@example.com`);
  await createPublication(page, 'Moving Blocks', `blocks-${stamp.toString(36)}`);
  await openSection(page, 'Posts');
  await newPost(page);

  const body = page.getByRole('textbox', { name: 'Post body' });
  await body.click();
  await page.keyboard.type('First');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Third');
  await expect.poll(() => blocks(page)).toEqual(['First', 'Second', 'Third']);

  // By keyboard: Alt with an arrow moves the block holding the cursor, cursor and all.
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => blocks(page)).toEqual(['First', 'Third', 'Second']);
  await page.keyboard.type('!');
  await expect.poll(() => blocks(page)).toEqual(['First', 'Third!', 'Second']);

  // By the handle's menu.
  const handle = page.getByRole('button', { name: 'Move this block or choose where it shows' });
  await handle.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Move up', exact: true }).click();
  await expect.poll(() => blocks(page)).toEqual(['Third!', 'First', 'Second']);
  await page.keyboard.press('Escape');

  // By dragging the handle to below the last block.
  const first = body.locator('> p').first();
  await first.hover();
  const last = body.locator('> p').last();
  const box = (await last.boundingBox())!;
  await handle.hover();
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y + box.height + 2, { steps: 6 });
  // Entering an element fires dragenter. A browser then repeats dragover by itself on a timer, but
  // Playwright fires one only when the mouse moves again.
  await page.mouse.move(box.x + 20, box.y + box.height + 3);
  await expect(page.getByTestId('block-drop-line')).toBeVisible();
  await page.mouse.up();
  await expect.poll(() => blocks(page)).toEqual(['First', 'Second', 'Third!']);
  await expectPostSaved(page);
});

test('a writer keeps a block to the email, and checks the dark preview', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  // The flag goes on before any page reads it: the api keeps a Channel's flags for a minute.
  await publication(page, request, 'showon', ['block_visibility']);
  await page.goto('/');
  await openSection(page, 'Posts');
  await newPost(page);

  const body = page.getByRole('textbox', { name: 'Post body' });
  await body.click();
  await page.keyboard.type('For everyone');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Website words');

  await page.getByRole('button', { name: 'Move this block or choose where it shows' }).click();
  await page.getByRole('button', { name: 'Website only', exact: true }).click();
  await expect(body.locator('.editor-show-on')).toHaveText('Website only');
  await page.keyboard.press('Escape');
  await expectPostSaved(page);

  await page.getByRole('radio', { name: 'Email · desktop' }).check({ force: true });
  const mail = page.frameLocator('iframe[title="Email preview"]');
  await expect(mail.getByText('For everyone')).toBeVisible();
  await expect(mail.getByText('Website words')).toHaveCount(0);

  await page.getByRole('radio', { name: 'Email · dark' }).check({ force: true });
  await expect(page.getByText('An approximation of the forced dark colours')).toBeVisible();
  await expect(mail.getByText('For everyone')).toBeVisible();
});
