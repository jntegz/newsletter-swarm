import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_PORT } from '../workers';
import { newPost, openSection } from './helpers';
import { publication } from './screens';

const DASHBOARD = `http://localhost:${DASHBOARD_PORT}`;

async function api<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const response = await page.request.fetch(`${DASHBOARD}${path}`, {
    method,
    headers: { origin: DASHBOARD, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { data }),
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { data: T }).data;
}

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

test('a writer links a snippet, edits it everywhere, and detaches a copy', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  // The flag goes on before any page reads it: the api keeps a Channel's flags for a minute.
  const channel = await publication(page, request, 'snippets', ['snippets']);
  await api(page, 'POST', `/api/v1/channels/${channel.id}/snippets`, {
    name: 'Sign-off',
    content: doc('Yours, Jan'),
  });

  await page.goto('/');
  await openSection(page, 'Posts');
  await newPost(page);
  const body = page.getByRole('textbox', { name: 'Post body' });
  await body.click();
  await page.keyboard.type('Hello');

  // Insert links by default: the block is labelled, and shows the snippet read-only.
  await page
    .getByRole('toolbar', { name: 'Formatting' })
    .getByRole('button', { name: 'Insert', exact: true })
    .click();
  await page.getByRole('button', { name: 'Snippet', exact: true }).click();
  await page.getByRole('button', { name: 'Insert Sign-off', exact: true }).click();
  const block = body.locator('[data-snippet]');
  await expect(block).toContainText('Sign-off');
  await expect(block).toContainText('Yours, Jan');

  // Editing says what it changes and how many posts use it.
  await block.getByRole('button', { name: 'Edit snippet' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit snippet' });
  await expect(dialog).toContainText('Emails already sent stay as they were');
  const content = dialog.getByRole('textbox', { name: 'Snippet content' });
  await content.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Warmly, Jan');
  await dialog.getByRole('button', { name: 'Save snippet' }).click();
  await expect(dialog).toBeHidden();
  await expect(block).toContainText('Warmly, Jan');

  // Detach leaves an editable copy, no longer linked.
  await block.getByRole('button', { name: 'Detach' }).click();
  await expect(body.locator('[data-snippet]')).toHaveCount(0);
  await expect(body).toContainText('Warmly, Jan');
});
