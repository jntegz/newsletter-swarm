// The posts list as a tool: search by subject that stays in the address, status chips with counts,
// Started by in the Filter menu, who wrote each post, opens and clicks of the latest send, the
// keyboard (arrow keys, Enter, x, / and c), the whole row as the target, and archive with Undo.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, localSql } from './helpers';
import { api, publication, shot, type Publication } from './screens';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const hex = () => randomUUID().replace(/-/g, '');
const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const newPost = (page: Page, channel: Publication, subject: string) =>
  api<{ id: string }>(page, 'POST', `/api/v1/channels/${channel.id}/dispatches`, {
    subject,
    content: doc(`The body of ${subject}.`),
  });

/** A finished send: two delivered, one opened by a person, one opened only by a privacy proxy. */
function seedSend(workspaceId: string, channel: Publication, dispatchId: string) {
  const broadcast = `bc_${hex()}`;
  const now = Date.now();
  localSql(
    `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text,
       from_name, from_address, track_opens, created_at, last_progress_at)
     VALUES ('${broadcast}', '${dispatchId}', '${channel.id}', '${workspaceId}', 'sent', 'Summer letter', '', '', '',
       'Field Notes', 'notes@example.com', 1, ${now}, ${now})`,
  );
  localSql(
    `INSERT INTO deliveries (id, broadcast_id, channel_id, email, status, sent_at, opened_at, human_opened_at)
     VALUES ('dl_${hex()}', '${broadcast}', '${channel.id}', 'a@example.com', 'delivered', ${now}, ${now}, ${now}),
            ('dl_${hex()}', '${broadcast}', '${channel.id}', 'b@example.com', 'delivered', ${now}, ${now}, NULL)`,
  );
  localSql(`UPDATE dispatches SET status = 'sent', sent_at = ${now} WHERE id = '${dispatchId}'`);
}

const rowLink = (page: Page, subject: string) =>
  page.getByRole('table').getByRole('link', { name: subject, exact: true });
const chip = (page: Page, label: string) =>
  page
    .getByRole('group', { name: 'Filter by status' })
    .getByRole('button', { name: new RegExp(`^${label}\\b`) });

test('find, filter, move by keyboard and archive with Undo', async ({ page, request }) => {
  test.setTimeout(180_000);
  const channel = await publication(page, request, 'postslist', ['post_archive']);
  const me = await api<{ workspaces: { id: string }[]; operator: { email: string } }>(
    page,
    'GET',
    '/api/v1/auth/session',
  );
  const spring = await newPost(page, channel, 'Spring letter');
  const summer = await newPost(page, channel, 'Summer letter');
  await newPost(page, channel, 'Autumn draft');
  const agent = await newPost(page, channel, 'An agent idea');
  localSql(
    `UPDATE dispatches SET status = 'sent', sent_at = ${Date.now()} WHERE id = '${spring.id}'`,
  );
  localSql(`UPDATE dispatches SET created_via = 'agent' WHERE id = '${agent.id}'`);
  seedSend(me.workspaces[0]!.id, channel, summer.id);

  await page.goto(`/dispatches?channel=${channel.id}`);
  await expect(page.getByRole('heading', { name: 'Posts', level: 1 })).toBeVisible();

  // Who wrote it, and how the latest send did: one of two people opened it; the proxy's open
  // doesn't count.
  const summerRow = page.getByRole('row', { name: /Summer letter/ });
  await expect(summerRow).toContainText('50.0%');
  await expect(summerRow).toContainText('0.0%');
  await expect(summerRow).toContainText(me.operator.email);
  await expect(page.getByRole('row', { name: /An agent idea/ })).toContainText('Agent');
  await expect(chip(page, 'All')).toContainText('4');
  await expect(chip(page, 'Sent')).toContainText('2');
  await shot(page, 'posts-list');

  // / goes to the search; what is typed lands in the address and survives a reload.
  await page.locator('body').press('/');
  const search = page.getByRole('searchbox', { name: 'Search posts by subject' });
  await expect(search).toBeFocused();
  await page.keyboard.type('summer');
  await expect(page).toHaveURL(/q=summer/);
  await expect(rowLink(page, 'Spring letter')).toHaveCount(0);
  await page.reload();
  await expect(search).toHaveValue('summer');
  await expect(rowLink(page, 'Summer letter')).toBeVisible();
  await expect(rowLink(page, 'Spring letter')).toHaveCount(0);
  await search.fill('');
  await expect(page).not.toHaveURL(/q=/);

  // Chips, kept when coming Back from a post.
  await chip(page, 'Drafts').click();
  await expect(rowLink(page, 'Autumn draft')).toBeVisible();
  await expect(rowLink(page, 'Summer letter')).toHaveCount(0);
  await rowLink(page, 'Autumn draft').click();
  await expect(page).toHaveURL(/\/dispatches\/dp_/);
  await page.goBack();
  await expect(chip(page, 'Drafts')).toHaveAttribute('aria-pressed', 'true');
  await chip(page, 'All').click();

  // Started by sits in the Filter menu.
  await page.getByRole('button', { name: 'Filter' }).click();
  await page.getByRole('radio', { name: 'An agent or the API' }).check();
  await expect(page.getByRole('button', { name: 'Started by an agent or the API' })).toBeVisible();
  await expect(rowLink(page, 'An agent idea')).toBeVisible();
  await expect(rowLink(page, 'Autumn draft')).toHaveCount(0);
  await page.getByRole('button', { name: 'Started by an agent or the API' }).click();
  await page.getByRole('radio', { name: 'Anyone' }).check();

  // Arrow keys move between rows, x selects, Enter opens.
  await search.focus();
  await page.keyboard.press('ArrowDown');
  const links = page.getByRole('table').locator('a[data-row-link]');
  await expect(links.first()).toBeFocused();
  const summerAt = (await links.allTextContents()).indexOf('Summer letter');
  for (let i = 0; i < summerAt; i++) await page.keyboard.press('ArrowDown');
  await expect(rowLink(page, 'Summer letter')).toBeFocused();
  await page.keyboard.press('x');
  await expect(page.getByRole('checkbox', { name: 'Select Summer letter' })).toBeChecked();
  await page.keyboard.press('x');
  await expect(page.getByRole('checkbox', { name: 'Select Summer letter' })).not.toBeChecked();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/dispatches/${summer.id}`));
  await page.goBack();

  // The whole row opens the post; its checkbox doesn't.
  await page.getByRole('checkbox', { name: 'Select Spring letter' }).check();
  await expect(page).toHaveURL(/\/dispatches\?/);
  await page.getByRole('checkbox', { name: 'Select Spring letter' }).uncheck();
  await page
    .getByRole('row', { name: /Spring letter/ })
    .getByText('Sent', { exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/dispatches/${spring.id}`));
  await page.goBack();

  // c opens New post, unless someone is typing.
  await page.locator('body').press('c');
  await expect(page.getByRole('button', { name: 'New post' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await page.keyboard.press('Escape');

  // Archive acts at once; Undo puts it back, from the toast or with Ctrl/⌘ Z.
  await page.getByRole('button', { name: 'Archive Summer letter' }).click();
  const archived = page.getByRole('status').filter({ hasText: 'Archived 1 post' });
  await expect(archived).toBeVisible();
  await expect(rowLink(page, 'Summer letter')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo' })).not.toBeFocused();
  await shot(page, 'posts-list-undo');
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Restored 1 post' })).toBeVisible();
  await expect(rowLink(page, 'Summer letter')).toBeVisible();

  await page.getByRole('checkbox', { name: 'Select Summer letter' }).check();
  await page.getByRole('checkbox', { name: 'Select Spring letter' }).check();
  await page.getByRole('button', { name: 'Archive 2 posts' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Archived 2 posts' })).toBeVisible();
  await expect(chip(page, 'Archived')).toContainText('2');
  await page.locator('body').press(`${mod}+z`);
  await expect(page.getByRole('status').filter({ hasText: 'Restored 2 posts' })).toBeVisible();
  await expect(rowLink(page, 'Spring letter')).toBeVisible();

  // The toast goes by itself after about six seconds.
  await expect(page.getByRole('status').filter({ hasText: 'Restored 2 posts' })).toHaveCount(0, {
    timeout: 10_000,
  });

  // On a phone the page doesn't scroll sideways, and the toast runs along the bottom.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Archive Spring letter' }).click();
  const toast = page.getByRole('status').filter({ hasText: 'Archived 1 post' });
  await expect(toast).toBeVisible();
  const box = await toast.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(380);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(
    0,
  );
  await expectAccessible(page);
});
