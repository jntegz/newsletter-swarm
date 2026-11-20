import { expect, test, type Page } from '@playwright/test';
import {
  API,
  createPublication,
  expectAccessible,
  expectPostSaved,
  newPost,
  openSection,
  openStop,
  postBody,
  postSettings,
  sendNow,
  signIn,
} from './helpers';

/** Adds a confirmed Member through the API, as the signed-in operator in the page. */
async function addMember(page: Page, channelId: string, email: string, tags: string[]) {
  const status = await page.evaluate(
    async ({ channelId, email, tags }) => {
      const res = await fetch(`/api/v1/channels/${channelId}/members`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, consent: true, tags }),
      });
      return res.status;
    },
    { channelId, email, tags },
  );
  expect(status).toBe(201);
}

test('an operator builds a Circle from a tag, sees the live count and sends a Dispatch to it only', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now() * 10 + test.info().parallelIndex;
  const owner = `circles-${stamp}@example.com`;
  const vips = [`vip-a-${stamp}@example.org`, `vip-b-${stamp}@example.org`];
  const other = `other-${stamp}@example.org`;

  await page.goto('/');
  await signIn(page, request, owner);
  await createPublication(page, 'Inner Circle Notes', `inner-${stamp.toString(36)}`);
  const channelId = /\/channels\/(ch_[0-9a-f]{32})/.exec(page.url())?.[1];
  expect(channelId).toBeTruthy();

  for (const email of vips) await addMember(page, channelId!, email, ['vip']);
  await addMember(page, channelId!, other, []);

  // Circles: the empty state leads to the builder.
  await openSection(page, 'Segments');
  await expect(page.getByRole('heading', { name: 'No segments yet' })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('link', { name: 'Create a segment' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'New segment' })).toBeVisible();

  await page.getByLabel('Name').fill('VIP readers');
  await page.getByLabel('Condition 1: field').selectOption('tag');
  await page.getByLabel('Condition 1: comparison').selectOption('eq');
  await page.getByLabel('Condition 1: value').selectOption('vip');

  // The live count and sample follow the unsaved rule.
  await expect(page.getByTestId('circle-count')).toHaveText('2 subscribers match · 2 active', {
    timeout: 15_000,
  });
  const sample = page.getByRole('table', { name: 'Subscribers matching the rule' });
  for (const email of vips) await expect(sample.getByRole('cell', { name: email })).toBeVisible();
  await expect(sample.getByRole('cell', { name: other })).toHaveCount(0);

  // A nested group with "None" narrows it, and removing it brings the count back.
  await page.getByRole('button', { name: 'Add group', exact: true }).click();
  await page.getByLabel('Match', { exact: true }).selectOption('not');
  await page.getByLabel('Condition 2.1: field').selectOption('email');
  await page.getByLabel('Condition 2.1: comparison').selectOption('eq');
  await page.getByLabel('Condition 2.1: value').fill(vips[0]!);
  await expect(page.getByTestId('circle-count')).toHaveText('1 subscriber matches · 1 active', {
    timeout: 15_000,
  });
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Remove group 2' }).click();
  await expect(page.getByTestId('circle-count')).toHaveText('2 subscribers match · 2 active', {
    timeout: 15_000,
  });

  await page.getByRole('button', { name: 'Create segment' }).click();
  await expect(page).toHaveURL(/\/circles\/cl_[0-9a-f]{32}/);
  await expect(page.getByRole('heading', { level: 1, name: 'VIP readers' })).toBeVisible();
  await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: /^Subscribers/ }).click();
  for (const email of vips) await expect(page.getByRole('cell', { name: email })).toBeVisible();
  await expectAccessible(page);

  // A Dispatch addressed to the Circle.
  await openSection(page, 'Posts');
  await newPost(page);
  await page.getByLabel('Subject').fill('For VIPs only');
  await postBody(page).click();
  await page.keyboard.type('Thanks for being here.');
  await expectPostSaved(page);

  await openStop(page, 'Who gets it');
  const audience = postSettings(page);
  await audience.getByRole('radio', { name: 'Only some segments' }).check();
  await audience
    .getByRole('group', { name: 'Segments to send to' })
    .getByRole('checkbox', { name: /VIP readers/ })
    .check();
  await expect(audience.getByText('Subscribers in VIP readers', { exact: true })).toBeVisible();
  await expect(audience.getByText('2 active subscribers right now')).toBeVisible({
    timeout: 15_000,
  });
  await expectAccessible(page);
  await audience.getByRole('button', { name: 'Continue to Check & send' }).click();

  // The route names the audience next to the exact count.
  await expect(audience.getByRole('button', { name: /^Who gets it/ })).toContainText(
    'VIP readers · 2',
  );
  await sendNow(page, 2);

  await expect(page).toHaveURL(/\/broadcasts\/bc_/);
  await expect(page.getByText('Sent', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('2 of 2')).toBeVisible();

  // Only the Circle received it.
  for (const email of vips) {
    await expect
      .poll(async () => {
        const res = await request.get(
          `${API}/__dev/mail/latest.json?to=${encodeURIComponent(email)}`,
        );
        if (res.status() !== 200) return null;
        return ((await res.json()) as { data: { category: string } }).data.category;
      })
      .toBe('broadcast');
  }
  const outside = await request.get(
    `${API}/__dev/mail/latest.json?to=${encodeURIComponent(other)}`,
  );
  if (outside.status() === 200) {
    const { data } = (await outside.json()) as { data: { category: string } };
    expect(data.category).not.toBe('broadcast');
  }
});

test('an operator tags everyone in a segment from the segment page', async ({ page, request }) => {
  test.setTimeout(120_000);
  const stamp = Date.now() * 10 + test.info().parallelIndex;
  await page.goto('/');
  await signIn(page, request, `circle-bulk-${stamp}@example.com`);
  await createPublication(page, 'Bulk Notes', `bulk-${stamp.toString(36)}`);
  const channelId = /\/channels\/(ch_[0-9a-f]{32})/.exec(page.url())![1]!;
  for (const name of ['a', 'b']) {
    await addMember(page, channelId, `vip-${name}-${stamp}@example.org`, ['vip']);
  }
  await addMember(page, channelId, `other-${stamp}@example.org`, []);

  await openSection(page, 'Segments');
  await page.getByRole('link', { name: 'Create a segment' }).first().click();
  await page.getByLabel('Name').fill('VIP readers');
  await page.getByLabel('Condition 1: field').selectOption('tag');
  await page.getByLabel('Condition 1: comparison').selectOption('eq');
  await page.getByLabel('Condition 1: value').selectOption('vip');
  await page.getByRole('button', { name: 'Create segment' }).click();
  await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: /^Subscribers/ }).click();

  const bar = page.getByRole('region', { name: 'Bulk actions' });
  await expect(bar).toContainText('Everyone in VIP readers: 2 subscribers');
  await expectAccessible(page);
  await bar.getByRole('button', { name: 'Add tag' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a tag to 2 subscribers' });
  await dialog.getByLabel('Tag').fill('spring');
  await dialog.getByRole('button', { name: 'Add tag' }).click();
  await expect(page.getByText('Tagged 2 subscribers with “spring”.')).toBeVisible({
    timeout: 30_000,
  });

  // Only the segment got it.
  const tags = await page.evaluate(
    async (id) =>
      (await (await fetch(`/api/v1/channels/${id}/tags`)).json()) as {
        data: { name: string; memberCount: number }[];
      },
    channelId,
  );
  expect(tags.data.find((t) => t.name === 'spring')?.memberCount).toBe(2);
});
