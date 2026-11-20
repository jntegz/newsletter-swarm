// Settings → Sending: Email design, Blocked addresses and Inactive readers, through their screens.
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, expectPostSaved, newPost, openSection, postBody } from './helpers';
import { api, publication, shot } from './screens';

const section = (page: Page, name: string) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name, exact: true }) });

test('Email design: saved, it survives a reload and shows in the post preview', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const site = await publication(page, request, 'design', ['email_design']);
  await page.goto(`/channels/${site.id}/sending`);
  const root = section(page, 'Email design');
  await expect(root.getByLabel('Font')).toBeVisible();
  await expectAccessible(page);

  await root.getByLabel('Font').selectOption('serif');
  await root.getByLabel('Line under your name').fill('Notes from the hill');
  await root.getByLabel('Postal address').fill('12 Hill Road, Oxford');
  await root.getByLabel('Page', { exact: true }).fill('#eef6ff');
  await root.getByLabel('Message', { exact: true }).fill('#fdfdf0');
  await root.getByLabel('Text', { exact: true }).fill('#223344');
  // Several fields save together: the Unsaved changes bar holds Save.
  await expect(root.getByText('Unsaved changes to the email design')).toBeVisible();
  await root.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(root.getByRole('status')).toHaveText('Saved');
  await expect(root.getByText('Unsaved changes to the email design')).toBeHidden();
  await shot(page, 'email-design');

  await page.reload();
  await expect(root.getByLabel('Font')).toHaveValue('serif');
  await expect(root.getByLabel('Line under your name')).toHaveValue('Notes from the hill');
  await expect(root.getByLabel('Postal address')).toHaveValue('12 Hill Road, Oxford');
  await expect(root.getByLabel('Page', { exact: true })).toHaveValue('#eef6ff');

  // A colour can go back to the default: the second one, Message.
  await root.getByRole('button', { name: 'Default' }).nth(1).click();
  await root.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(root.getByRole('status')).toHaveText('Saved');

  // The post preview uses it.
  await page.goto('/');
  await openSection(page, 'Posts');
  await newPost(page);
  await page.getByLabel('Subject').fill('A designed post');
  await postBody(page).click();
  await page.keyboard.type('Body of the designed post.');
  await expectPostSaved(page);
  await page.getByRole('radio', { name: 'Email · desktop' }).check({ force: true });
  const preview = page.frameLocator('iframe[title="Email preview"]');
  await expect(preview.getByText('Body of the designed post.')).toBeVisible();
  await expect(preview.getByText('Notes from the hill')).toBeVisible();
  await expect(preview.getByText('12 Hill Road, Oxford')).toBeVisible();
  const html = await preview.locator('html').innerHTML();
  expect(html).toMatch(/Georgia/);
  expect(html.toLowerCase()).toContain('#eef6ff');
  expect(html.toLowerCase()).toContain('#223344');
  expect(html.toLowerCase()).not.toContain('#fdfdf0');
  await shot(page, 'email-design-preview');
});

test('Blocked addresses and Inactive readers', async ({ page, request }) => {
  test.setTimeout(120_000);
  const site = await publication(page, request, 'blocked', []);
  await page.goto(`/channels/${site.id}/sending`);
  const root = section(page, 'Blocked addresses');
  await expect(root.getByText('No addresses are blocked.')).toBeVisible();
  await expectAccessible(page);

  // "Block an address" opens a short form in place; Esc closes it and focus goes back.
  const open = root.getByRole('button', { name: 'Block an address' });
  const block = root.getByLabel('Address to block');
  await open.click();
  await expect(block).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(block).toHaveCount(0);
  await expect(open).toBeFocused();
  const blockAddress = async (email: string) => {
    await open.click();
    await block.fill(email);
    await root.getByRole('button', { name: 'Block', exact: true }).click();
    // A successful add closes the form and says what was blocked.
    await expect(block).toHaveCount(0);
    await expect(root.getByRole('status').filter({ hasText: /^Blocked / })).toHaveText(
      `Blocked ${email.trim().toLowerCase()}.`,
    );
  };

  await blockAddress('Someone@Example.com ');
  const row = root.getByRole('listitem').filter({ hasText: 'someone@example.com' });
  await expect(row).toBeVisible();
  await expect(row.getByText(/Added by a teammate on/)).toBeVisible();
  await expectAccessible(page);
  await shot(page, 'blocked-list');

  // Blocking the same address again doesn't make a second row or an error.
  await blockAddress('someone@example.com');
  await expect(root.getByRole('listitem').filter({ hasText: 'someone@example.com' })).toHaveCount(
    1,
  );

  await blockAddress('other@example.com');
  await expect(root.getByRole('listitem').filter({ hasText: 'other@example.com' })).toBeVisible();

  // Find narrows the list, including typed in another case, and Show all goes back.
  await root.getByLabel('Find an address').fill('OTHER@example.com');
  await root.getByRole('button', { name: 'Find' }).click();
  await expect(root.getByRole('listitem').filter({ hasText: 'someone@example.com' })).toHaveCount(
    0,
  );
  await expect(root.getByRole('listitem').filter({ hasText: 'other@example.com' })).toBeVisible();
  await root.getByLabel('Find an address').fill('nobody@example.com');
  await root.getByRole('button', { name: 'Find' }).click();
  await expect(root.getByText('That address isn’t blocked.')).toBeVisible();
  await root.getByRole('button', { name: 'Show all' }).click();
  await expect(root.getByLabel('Find an address')).toHaveValue('');
  await expect(row).toBeVisible();

  // Removing one takes it off the list for good, and the other stays.
  await row.getByRole('button', { name: 'Remove' }).click();
  await expect(row).toHaveCount(0);
  await page.reload();
  await expect(root.getByRole('listitem').filter({ hasText: 'other@example.com' })).toBeVisible();
  await expect(row).toHaveCount(0);

  // Inactive readers: off by default, saved as soon as it's picked.
  const inactive = section(page, 'Inactive readers');
  await expect(inactive.getByRole('radio', { name: /Keep everyone/ })).toBeChecked();
  await inactive.getByRole('radio', { name: /After 1 year/ }).check();
  await expect(inactive.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await expect(inactive.getByRole('button', { name: 'Undo' })).toBeVisible();
  await expect
    .poll(
      async () =>
        (await api<{ sunsetDays: number | null }>(page, 'GET', `/api/v1/channels/${site.id}`))
          .sunsetDays,
    )
    .toBe(365);
  await page.reload();
  await expect(inactive.getByRole('radio', { name: /After 1 year/ })).toBeChecked();
  await inactive.getByRole('radio', { name: /Keep everyone/ }).check();
  await expect
    .poll(
      async () =>
        (await api<{ sunsetDays: number | null }>(page, 'GET', `/api/v1/channels/${site.id}`))
          .sunsetDays,
    )
    .toBeNull();
  await expectAccessible(page);
});
