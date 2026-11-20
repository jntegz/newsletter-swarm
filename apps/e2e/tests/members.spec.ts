import { expect, test } from '@playwright/test';
import { API, createPublication, expectAccessible, openSection, signIn } from './helpers';

test('an operator adds subscribers with and without consent, imports a CSV, edits a subscriber and tags in bulk', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const owner = `audience-${stamp}@example.com`;
  const consented = `consented-${stamp}@example.org`;
  const unconfirmed = `unconfirmed-${stamp}@example.org`;
  const imported = [`ada-${stamp}@example.org`, `grace-${stamp}@example.org`];

  await page.goto('/');
  await signIn(page, request, owner);
  await createPublication(page, 'Garden Letters', `garden-${stamp.toString(36)}`);

  // The empty state offers both ways in.
  await openSection(page, 'Subscribers');
  await expect(page.getByRole('heading', { name: 'No subscribers yet' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Import subscribers' }).first()).toBeVisible();
  await expectAccessible(page);

  // With consent: active straight away.
  await page.getByRole('button', { name: 'Add subscriber' }).first().click();
  let dialog = page.getByRole('dialog', { name: 'Add a subscriber' });
  await dialog.getByLabel('Email').fill(consented);
  await dialog.getByLabel('They asked to receive this publication').check();
  await expect(dialog.getByText('They are added as active')).toBeVisible();
  await expectAccessible(page);
  await dialog.getByRole('button', { name: 'Add subscriber' }).click();
  await expect(page.getByRole('status').filter({ hasText: consented })).toContainText(
    'will receive the next post',
  );
  await expect(page.getByRole('row', { name: new RegExp(consented) })).toContainText('Active');

  // Without consent: pending, and nothing is emailed.
  await page.getByRole('button', { name: 'Add subscriber' }).first().click();
  dialog = page.getByRole('dialog', { name: 'Add a subscriber' });
  await dialog.getByLabel('Email').fill(unconfirmed);
  await expect(dialog.getByText('No email is sent yet')).toBeVisible();
  await dialog.getByRole('button', { name: 'Add subscriber' }).click();
  await expect(page.getByRole('status').filter({ hasText: unconfirmed })).toContainText(
    'No email has been sent',
  );
  await expect(page.getByRole('row', { name: new RegExp(unconfirmed) })).toContainText('Pending');
  const mail = await request.get(
    `${API}/__dev/mail/latest.json?to=${encodeURIComponent(unconfirmed)}`,
  );
  expect(mail.status()).not.toBe(200);

  // Import a small CSV through the wizard.
  await page.getByRole('link', { name: 'Import subscribers' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Import subscribers' })).toBeVisible();
  await expectAccessible(page);
  const csv = [
    'email,first_name,Plan',
    `${imported[0]},Ada,spring`,
    `${imported[1]},Grace,summer`,
    `info@example.org,Team,spring`,
    `not-an-email,Nobody,spring`,
    `${imported[1]},Grace again,summer`,
  ].join('\n');
  await page.getByLabel('Choose a CSV file').setInputFiles({
    name: 'garden.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  await expect(page.getByRole('heading', { name: 'Map the columns' })).toBeVisible();
  await expect(page).toHaveURL(/import=ij_/);
  await expect(page.getByLabel('Where “email” goes')).toHaveValue('email');
  await expect(page.getByLabel('Where “first_name” goes')).toHaveValue('first_name');
  await page.getByLabel('Where “Plan” goes').selectOption({ label: 'Tags' });
  await page.getByLabel('Everyone on this list agreed to receive this publication').check();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Run the dry run' }).click();

  await expect(page.getByRole('heading', { name: 'Review the dry run' })).toBeVisible({
    timeout: 60_000,
  });
  const report = page.getByRole('listitem');
  await expect(report.filter({ hasText: 'New subscribers' })).toContainText('2');
  await expect(report.filter({ hasText: 'Role addresses' })).toContainText('1');
  await expect(report.filter({ hasText: 'Invalid' })).toContainText('1');
  await expect(report.filter({ hasText: 'Duplicates' })).toContainText('1');
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Import 2 subscribers' }).click();

  await expect(page.getByRole('heading', { name: 'Import finished' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole('status').filter({ hasText: 'Added' })).toContainText('2');
  await page.getByRole('link', { name: 'View subscribers' }).click();
  for (const email of imported) {
    await expect(page.getByRole('row', { name: new RegExp(email) })).toContainText('Active');
  }

  // Edit a subscriber in the drawer.
  await page.getByRole('button', { name: imported[0]! }).click();
  const drawer = page.getByRole('dialog', { name: imported[0]! });
  await expect(drawer.getByRole('heading', { name: 'Activity' })).toBeVisible();
  await expect(drawer.getByText('Joined from an import')).toBeVisible();
  await expectAccessible(page);
  await drawer.getByLabel('First name').fill('Augusta Ada');
  await drawer.getByRole('button', { name: 'Save profile' }).click();
  await expect(drawer.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await drawer.getByLabel('Add a tag').fill('founding-reader');
  await drawer.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(drawer.getByRole('list', { name: 'Tags' })).toContainText('founding-reader');
  await drawer.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(drawer.getByText(/^Paused until \d/)).toBeVisible();
  // Only the changes a teammate may make are offered: a paused subscriber can resume.
  await expect(drawer.getByRole('button', { name: 'Resume' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('row', { name: new RegExp(imported[0]!) })).toContainText(
    'Augusta Ada',
  );

  // Tag two subscribers in bulk.
  await page.getByLabel(`Select ${imported[1]}`).check();
  await page.getByLabel(`Select ${consented}`).check();
  const bar = page.getByRole('region', { name: 'Bulk actions' });
  await expect(bar).toContainText('2 selected');
  await bar.getByRole('button', { name: 'Add tag' }).click();
  const bulk = page.getByRole('dialog', { name: 'Add a tag to 2 subscribers' });
  await bulk.getByLabel('Tag').fill('autumn');
  await bulk.getByRole('button', { name: 'Add tag' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'autumn' })).toContainText(
    'Tagged 2 subscribers with “autumn”.',
    { timeout: 60_000 },
  );
  // The closed dialog stays in the DOM with its own "Tag" field, so ask for the visible filter.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Tag', exact: true }).selectOption('autumn');
  await expect(page.getByRole('row', { name: new RegExp(imported[1]!) })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(consented) })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(unconfirmed) })).toHaveCount(0);
  await expectAccessible(page);
});
