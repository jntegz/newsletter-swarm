import { expect, test } from '@playwright/test';
import { expectAccessible, signIn, signOut } from './helpers';

test('an owner adds a passkey, saves recovery codes, then signs in with the passkey as the second factor', async ({
  page,
  request,
}) => {
  const owner = `passkey-${Date.now()}@example.com`;

  // Chrome's virtual authenticator stands in for Touch ID or Windows Hello.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await page.goto('/sign-in');
  await signIn(page, request, owner);
  await expect(page.getByRole('heading', { name: 'Create your first publication' })).toBeVisible();

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: 'Security' }).click();
  await expect(page.getByText('Your role needs a second factor', { exact: true })).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await page.getByLabel('Passkey name').fill('Test laptop');
  await page.getByRole('button', { name: 'Create passkey' }).click();
  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem'),
  ).toHaveCount(10);
  await expectAccessible(page);
  await page.getByRole('button', { name: 'I saved my recovery codes' }).click();
  await expect(page.getByText('Test laptop')).toBeVisible();

  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  expect(credentials).toHaveLength(1);

  // Sign out and back in: a sign-in link alone is no longer enough.
  await signOut(page);
  await expect(page).toHaveURL(/\/sign-in/);
  await signIn(page, request, owner);
  await expect(page.getByRole('heading', { name: 'Confirm it is you' })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Use your passkey' }).click();
  await expect(page.getByRole('heading', { name: 'Create your first publication' })).toBeVisible();

  // The passkey was used, and Devices offers sign out everywhere.
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: 'Security' }).click();
  await expect(page.getByText(/last used/)).toBeVisible();
  await page.getByRole('link', { name: 'Devices' }).click();
  await page.getByRole('button', { name: 'Sign out everywhere' }).click();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Sign out other devices' }).click();
  await expect(page.getByText(/Signed out of \d+ other/)).toBeVisible();
});
