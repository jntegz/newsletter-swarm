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

test('a writer rehearses an automation, then adds people after seeing the count', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const owner = `rehearse-${stamp}@example.com`;
  const first = `rehearse-a-${stamp}@example.org`;
  const second = `rehearse-b-${stamp}@example.org`;

  await page.goto('/');
  await signIn(page, request, owner);
  await createPublication(page, 'Field Notes', `rehearse-${stamp.toString(36)}`);
  const channelId = /\/channels\/(ch_[0-9a-f]{32})/.exec(page.url())?.[1];
  expect(channelId).toBeTruthy();
  await addSubscriber(page, channelId!, first);
  await addSubscriber(page, channelId!, second);

  await openSection(page, 'Automations');
  await page.getByRole('button', { name: 'New automation' }).first().click();
  const create = page.getByRole('dialog', { name: 'New automation' });
  await create.getByRole('radio', { name: /Re-engagement/ }).check();
  await create.getByRole('button', { name: 'Create automation' }).click();
  await expect(page).toHaveURL(/\/flows\/fl_[0-9a-f]{32}/);

  // A draft can be rehearsed before anything is published.
  await page.getByRole('button', { name: 'Rehearse', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Rehearse' });
  await expect(panel.getByText('Nothing is sent and nothing changes.')).toBeVisible();
  await panel.getByRole('radio', { name: first }).check();
  await panel.getByRole('button', { name: 'Rehearse', exact: true }).click();
  await expect(
    panel.getByText('This automation isn’t live, so nobody enters it yet.'),
  ).toBeVisible();
  await expect(panel.getByText('Would send “Still want these emails?”.')).toBeVisible();

  // The wait for an open is the writer's to answer, and the path changes with it.
  await expect(panel.getByText('Would send “Should we stop writing?”.')).toBeVisible();
  await panel.getByRole('radio', { name: 'If they open' }).check();
  await expect(panel.getByText('If they open the email, they go on at once.')).toBeVisible();
  await expect(panel.getByText('Would send “Should we stop writing?”.')).toHaveCount(0);
  await expect(panel.getByText('They finish the automation.')).toBeVisible();
  await expectAccessible(page);

  // Nothing above changed anything: the Runs tab is still empty after publishing.
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const publish = page.getByRole('dialog', { name: /Publish version 1/ });
  await publish.getByRole('button', { name: 'Publish version 1' }).click();
  await page
    .getByRole('dialog', { name: 'Version 1 is live' })
    .getByRole('button', { name: 'Done' })
    .click();

  // Add people: the count comes first, and the button names the number.
  await page.getByRole('button', { name: 'Add people' }).click();
  const add = page.getByRole('dialog', { name: 'Add people to this automation' });
  await add.getByLabel('Who to add').selectOption('members');
  await add.getByRole('checkbox', { name: first }).check();
  await add.getByRole('checkbox', { name: second }).check();
  await add.getByRole('button', { name: 'Count who would enter' }).click();
  await expect(add.getByText('2 subscribers would enter now.')).toBeVisible();
  await expectAccessible(page);
  await add.getByRole('button', { name: 'Add 2 subscribers' }).click();
  const done = page.getByRole('dialog', { name: 'People added' });
  await expect(done.getByText('Added 2 subscribers.')).toBeVisible();
  await done.getByRole('button', { name: 'Close' }).click();

  // Asked again, they are already in, and nobody can be added.
  await page.getByRole('button', { name: 'Add people' }).click();
  await add.getByLabel('Who to add').selectOption('members');
  await add.getByRole('checkbox', { name: first }).check();
  await add.getByRole('button', { name: 'Count who would enter' }).click();
  await expect(add.getByText('Nobody in this selection can enter.')).toBeVisible();
  await expect(add.getByText('1 is already in this automation.')).toBeVisible();
});
