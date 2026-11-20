// Website → Design, scheduled publishing through its real screens: Publish's menu opens Schedule…,
// a quick pick fills the time, the bar says when it goes live, Cancel takes it away with Undo to
// bring it back, and Change schedules again for another time.
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './helpers';
import { api, publication, shot } from './screens';

interface DesignState {
  draft: { settings: Record<string, unknown> };
  schedule: { at: string; status: 'scheduled' | 'failed' } | null;
}

const designOf = (page: Page, id: string) =>
  api<DesignState>(page, 'GET', `/api/v1/channels/${id}/site/design`);

/** 09:00 local time, `days` from today, as the quick picks compute it. */
function nineAm(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(9, 0, 0, 0);
  return date;
}

test('Design: schedule the draft, see it in the bar, cancel with Undo, and reschedule', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const site = await publication(page, request, 'design-schedule', ['site_templates']);
  await page.goto(`/site/${site.id}/design`);
  await expect(page.getByRole('tab', { name: 'Template', selected: true })).toBeVisible();

  // Something new to publish, so Publish and its menu are on.
  await page.getByRole('tab', { name: 'Style' }).click();
  const accent = page.getByRole('tabpanel').getByRole('textbox', { name: 'Accent', exact: true });
  await accent.fill('#b4235f');
  await accent.press('Tab');
  await expect(page.getByRole('status').filter({ hasText: /^Draft saved/ })).toBeVisible();

  // Schedule…: the form names the time zone and what goes live.
  await page.getByRole('button', { name: 'More ways to publish' }).click();
  await page.getByRole('button', { name: /^Schedule…/ }).click();
  const form = page.getByRole('form', { name: 'Schedule the draft' });
  await expect(form).toBeVisible();
  await expect(form.getByText(/^The draft as it is now: .+ theme, \d+ sections?\./)).toBeVisible();
  await expect(form.getByText(/^In your time zone, /)).toBeVisible();
  await form.getByRole('button', { name: 'Tomorrow 09:00' }).click();
  await expect(form.getByLabel('Publish at')).toHaveValue(/T09:00$/);
  await expectAccessible(page);
  await shot(page, 'design-schedule-form');
  await form.getByRole('button', { name: /^Schedule for / }).click();

  // The bar says when, "around" since the cron runs every five minutes.
  const line = page.getByText(/^Scheduled for .+, around 09:00$/);
  await expect(line).toBeVisible();
  await expect(form).toBeHidden();
  await expect
    .poll(async () => (await designOf(page, site.id)).schedule?.at)
    .toBe(nineAm(1).toISOString());
  await expectAccessible(page);
  await shot(page, 'design-schedule-line');

  // Editing the draft afterwards leaves the schedule as it is.
  await accent.fill('#1f6f5c');
  await accent.press('Tab');
  await expect(page.getByRole('status').filter({ hasText: /^Draft saved/ })).toBeVisible();
  expect((await designOf(page, site.id)).schedule?.at).toBe(nineAm(1).toISOString());

  // Cancel, then Undo puts the same schedule back.
  await page.getByRole('button', { name: 'Cancel schedule' }).click();
  await expect(page.getByText(/^Schedule cancelled\./)).toBeVisible();
  await expect(line).toBeHidden();
  await expect.poll(async () => (await designOf(page, site.id)).schedule).toBeNull();
  await page.getByRole('button', { name: 'Undo' }).last().click();
  await expect(page.getByText('The schedule is back.')).toBeVisible();
  await expect(line).toBeVisible();
  await expect
    .poll(async () => (await designOf(page, site.id)).schedule?.at)
    .toBe(nineAm(1).toISOString());

  // Change: schedule again for another time, which replaces it.
  await page.getByRole('button', { name: 'Change schedule' }).click();
  const change = page.getByRole('form', { name: 'Change the scheduled publish' });
  const later = nineAm(3);
  later.setHours(14, 30);
  const pad = (n: number) => String(n).padStart(2, '0');
  await change
    .getByLabel('Publish at')
    .fill(`${later.getFullYear()}-${pad(later.getMonth() + 1)}-${pad(later.getDate())}T14:30`);
  await change.getByRole('button', { name: /^Schedule for .+, 14:30$/ }).click();
  await expect(page.getByText(/^Scheduled for .+, around 14:30$/)).toBeVisible();
  await expect
    .poll(async () => (await designOf(page, site.id)).schedule?.at)
    .toBe(later.toISOString());
});
