import { expect, test, type Page } from '@playwright/test';
import { createPublication, expectAccessible, openSection, signIn } from './helpers';

/** Adds an active subscriber through the API, as the signed-in operator in the page. */
async function addSubscriber(page: Page, channelId: string, email: string) {
  const status = await page.evaluate(
    async ({ channelId, email }) => {
      const res = await fetch(`/api/v1/channels/${channelId}/members`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, consent: true }),
      });
      return res.status;
    },
    { channelId, email },
  );
  expect(status).toBe(201);
}

test('an automation takes a second start event, and a subscriber’s page says where they stand', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const owner = `why-${stamp}@example.com`;
  const reader = `why-reader-${stamp}@example.org`;

  await page.goto('/');
  await signIn(page, request, owner);
  await createPublication(page, 'Field Notes', `why-${stamp.toString(36)}`);
  const channelId = /\/channels\/(ch_[0-9a-f]{32})/.exec(page.url())?.[1];
  expect(channelId).toBeTruthy();
  await addSubscriber(page, channelId!, reader);

  // Before anything is live, the page says so.
  await openSection(page, 'Subscribers');
  await page.getByRole('button', { name: reader }).click();
  let drawer = page.getByRole('dialog', { name: reader });
  await expect(drawer.getByRole('heading', { name: 'Automations' })).toBeVisible();
  await expect(drawer.getByText('This publication has no live automations.')).toBeVisible();
  await drawer.getByRole('button', { name: 'Close' }).click();

  // A recipe gives a graph that is ready to publish.
  await openSection(page, 'Automations');
  await page.getByRole('button', { name: 'New automation' }).first().click();
  const create = page.getByRole('dialog', { name: 'New automation' });
  await create.getByRole('radio', { name: /Welcome email/ }).check();
  await create.getByRole('button', { name: 'Create automation' }).click();
  await expect(page).toHaveURL(/\/flows\/fl_[0-9a-f]{32}/);

  // The trigger takes a second start event, with its own settings.
  const canvas = page.getByRole('application');
  await canvas.getByRole('button', { name: /^Confirmed: Confirmed opt-in/ }).click();
  await page.getByRole('button', { name: 'Add another start event' }).click();
  const second = page.getByRole('group', { name: 'Start event 2' });
  await second.getByLabel('Starts when').selectOption('referral_succeeded');
  await expect(second.getByText('A referral succeeds when')).toBeVisible();
  await expect(canvas.getByRole('button', { name: /2 start events/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ready to publish' })).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Publish version 1?' })
    .getByRole('button', { name: 'Publish version 1' })
    .click();
  const published = page.getByRole('dialog', { name: 'Version 1 is live' });
  await expect(published).toBeVisible({ timeout: 20_000 });
  await published.getByRole('button', { name: 'Done' }).click();

  // The subscriber hasn't met either start event, and the page says that in plain sentences.
  await openSection(page, 'Subscribers');
  await page.getByRole('button', { name: reader }).click();
  drawer = page.getByRole('dialog', { name: reader });
  await expect(drawer.getByText("Hasn't entered Welcome email.")).toBeVisible();
  await expect(drawer.getByText('No start event has been recorded')).toBeVisible();
  await expectAccessible(page);
});
