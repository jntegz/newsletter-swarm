// Phase 6 growth screens: an Ask poll put into a Dispatch, Champions with a Milestone, a Split
// Test on the Dispatch with its preflight split, and the Funnel Explorer. axe runs on each screen.
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_PORT } from '../workers';
import {
  chooseEveryone,
  enableChannelFlag,
  expectAccessible,
  expectPostSaved,
  insertBlock,
  newPost,
  openMoreOptions,
  postBody,
  postSettings,
  signIn,
} from './helpers';

const DASHBOARD = `http://localhost:${DASHBOARD_PORT}`;

async function api<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(`${DASHBOARD}${path}`, {
    method,
    headers: { origin: DASHBOARD, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { data }),
  });
  expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
  return ((await res.json()) as { data: T }).data;
}

const growthTab = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Growth sections' }).getByRole('link', { name });

test('an operator runs a poll in a Dispatch, sets up Champions and a Split Test, and reads the funnel', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const owner = `growth-${stamp}@example.com`;

  await page.goto('/');
  await signIn(page, request, owner);
  const me = await api<{ workspaces: { id: string }[] }>(page, 'GET', '/api/v1/auth/session');
  const channel = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/workspaces/${me.workspaces[0]!.id}/channels`,
    { name: 'Field Notes', slug: `growth-${stamp.toString(36)}` },
  );
  enableChannelFlag('split_tests', channel.id);
  for (const email of [`a-${stamp}@example.org`, `b-${stamp}@example.org`]) {
    await api(page, 'POST', `/api/v1/channels/${channel.id}/members`, {
      email,
      consent: true,
    });
  }

  // Growth → Ask: create a poll and open it.
  await page.goto(`/growth/${channel.id}/ask`);
  await expect(page.getByRole('heading', { level: 1, name: 'Referrals & growth' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No polls or surveys yet' })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('link', { name: 'Create a poll or survey' }).click();
  await page.getByLabel('Title', { exact: true }).fill('Reader poll');
  await page.getByLabel('Question', { exact: true }).fill('What should we cover next?');
  await page.getByLabel('Option 1', { exact: true }).fill('Rivers');
  await page.getByLabel('Option 2', { exact: true }).fill('Mountains');
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Create poll' }).click();
  await expect(page).toHaveURL(/\/ask\/ak_/);
  await page.getByRole('button', { name: 'Open it' }).click();
  await expect(page.getByText('Open', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Results' }).click();
  await expect(page.getByRole('heading', { name: 'No answers yet' })).toBeVisible();
  await expectAccessible(page);

  // Champions: a Milestone at 3 referrals.
  await growthTab(page, 'Referrals').click();
  await expect(page.getByText(/No Milestones yet/)).toBeVisible();
  await expectAccessible(page);
  // "Add Milestone" opens a short form in place; a successful add closes it and says so.
  await page.getByRole('button', { name: 'Add Milestone' }).click();
  const milestone = page.getByRole('form', { name: 'Add a Milestone' });
  await expect(milestone.getByLabel('Name')).toBeFocused();
  await milestone.getByLabel('Name').fill('Bronze Champion');
  await milestone.getByLabel('Counted referrals needed').fill('3');
  await milestone.getByRole('button', { name: 'Add Milestone' }).click();
  await expect(milestone).toBeHidden();
  await expect(
    page.getByRole('status').filter({ hasText: 'Added the Milestone Bronze Champion.' }),
  ).toBeVisible();
  await expect(page.getByText('Bronze Champion', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('3 referrals · No reward')).toBeVisible();
  await expectAccessible(page);

  // A Dispatch with the poll in it.
  await page.goto(`/dispatches?channel=${channel.id}`);
  await newPost(page);
  const body = postBody(page);
  await expect(body).toBeVisible();
  await page.getByLabel('Subject', { exact: true }).fill('Field Notes, issue 2');
  await body.click();
  await page.keyboard.type('Tell us what to write about.');
  await insertBlock(page, 'Poll');
  const pollDialog = page.getByRole('dialog', { name: 'Insert a poll' });
  await pollDialog.getByLabel(/What should we cover next\?/).check();
  await pollDialog.getByRole('button', { name: 'Insert poll' }).click();
  await expect(body.getByText('What should we cover next?')).toBeVisible();
  await expect(body.getByText('Mountains')).toBeVisible();
  await expectPostSaved(page);
  await expectAccessible(page);

  // Split Test on the subject, then the preflight shows the split.
  await openMoreOptions(page);
  const panel = page.getByRole('region', { name: 'Test before sending' });
  await panel.getByLabel('Split Test', { exact: true }).check();
  await panel.getByLabel('Variant B subject').fill('Rivers or mountains?');
  await panel.getByLabel('Test on (% of the audience)').fill('50');
  await panel.getByRole('button', { name: 'Save Split Test' }).click();
  await expect(panel.getByText('Split Test saved. It starts when you send.')).toBeVisible();
  await expectAccessible(page);

  await chooseEveryone(page);
  const route = postSettings(page);
  await expect(route.getByText('Split Test:', { exact: true })).toBeVisible();
  await expect(route.getByText(/of 2 variants first/).first()).toBeVisible();
  const send = route.getByRole('button', { name: 'Send to 2 subscribers' });
  await expect(send).toBeEnabled({ timeout: 15_000 });
  await send.click();
  const confirm = route.getByRole('group', { name: /^Send now to 2 subscribers\?/ });
  await expect(confirm).toBeVisible();
  await expectAccessible(page);
  await confirm.getByRole('button', { name: 'Cancel' }).click();

  // Funnel Explorer: nothing yet, with the empty state.
  await page.goto(`/growth/${channel.id}/funnel`);
  await expect(page.getByLabel('Break down by')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No traffic yet' })).toBeVisible();
  await page.getByLabel('Break down by').selectOption('utm_source');
  await expectAccessible(page);
});
