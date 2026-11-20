import { expect, test } from '@playwright/test';
import { PNG, createPublication, expectAccessible, mailLink, signIn, signOut } from './helpers';

test('an operator signs in, creates a publication, uploads a logo and invites a teammate who has limited rights', async ({
  page,
  browser,
  request,
}) => {
  const owner = `owner-${Date.now()}@example.com`;
  const teammate = `teammate-${Date.now()}@example.com`;
  const slug = `field-notes-${Date.now().toString(36)}`;

  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in/);
  await expect(page.getByRole('heading', { name: 'Sign in to Swarm' })).toBeVisible();
  // The send button turns on once Turnstile hands over a token, fading in as it does. Audit the
  // page as it settles, not halfway through that fade (locally the stand-in widget answers at once).
  await expect(page.getByRole('button', { name: 'Email me a sign-in link' })).toBeEnabled();
  await expectAccessible(page);

  await signIn(page, request, owner);
  await expect(page.getByRole('heading', { name: 'Create your first publication' })).toBeVisible();
  await expectAccessible(page);

  await createPublication(page, 'Field Notes', slug);
  await expectAccessible(page);

  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByRole('img', { name: 'Field Notes logo' })).toBeVisible();

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: 'Team' }).click();
  await page.getByLabel('Email address').fill(teammate);
  await page.getByLabel('Role').selectOption('viewer');
  await page.getByRole('button', { name: 'Send invite' }).click();
  await expect(page.getByText(`Invite sent to ${teammate}`)).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('link', { name: 'Audit log' }).click();
  await page.getByRole('button', { name: 'Verify log' }).click();
  await expect(page.getByText(/Intact/)).toBeVisible();

  // The teammate opens the invite in their own browser, signs in, and accepts.
  const other = await browser.newContext();
  const teammatePage = await other.newPage();
  await teammatePage.goto(await mailLink(request, teammate, '/invite'));
  await teammatePage.getByRole('link', { name: 'Sign in to accept' }).click();
  await signIn(teammatePage, request, teammate);
  await teammatePage.getByRole('button', { name: 'Accept invite' }).click();

  // As a viewer they can open the publication but not change or delete it.
  await teammatePage.getByRole('button', { name: /^Publication: Field Notes/ }).click();
  await teammatePage.getByRole('link', { name: 'Manage publications' }).click();
  await teammatePage.getByRole('main').getByRole('link', { name: 'Field Notes' }).click();
  await expect(teammatePage.getByLabel('Name')).toBeDisabled();
  await expect(teammatePage.getByRole('button', { name: 'Delete publication' })).toHaveCount(0);
  await expect(teammatePage.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  await other.close();

  // Signing out ends the session.
  await signOut(page);
  await expect(page).toHaveURL(/\/sign-in/);
  await page.goto('/channels');
  await expect(page).toHaveURL(/\/sign-in\?return=/);
});
