// Autosave against a slow connection: leaving the page warns while a save is unfinished, and the
// words still reach the server.
import { expect, test, type Page, type Route } from '@playwright/test';
import { DASHBOARD_PORT } from '../workers';
import {
  createPublication,
  expectPostSaved,
  newPost,
  openMoreOptions,
  openSection,
  postBody,
  signIn,
} from './helpers';

const DASHBOARD = `http://localhost:${DASHBOARD_PORT}`;

async function storedBody(page: Page, id: string): Promise<string> {
  const response = await page.request.get(`${DASHBOARD}/api/v1/dispatches/${id}`);
  expect(response.ok()).toBe(true);
  const { data } = (await response.json()) as { data: { content: unknown } };
  return JSON.stringify(data.content);
}

async function startPost(page: Page, label: string, request: Parameters<typeof signIn>[1]) {
  const stamp = Date.now();
  await page.goto('/');
  await signIn(page, request, `${label}-${stamp}@example.com`);
  await createPublication(page, 'Slow Saves', `${label}-${stamp.toString(36)}`);
  await openSection(page, 'Posts');
  await newPost(page);
  return /\/dispatches\/([^/?]+)/.exec(page.url())![1]!;
}

const isSave = (route: Route, id: string) =>
  route.request().method() === 'PATCH' && route.request().url().endsWith(`/dispatches/${id}`);

test('reloading during a slow save warns, and the words still get stored', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const id = await startPost(page, 'slowsave', request);
  await postBody(page).click();
  await page.keyboard.type('Saved first.');

  // The first save hangs, like a slow connection. Everything after it goes through.
  let held: Route | null = null;
  const keptAlive: boolean[] = [];
  await page.route(`**/api/v1/dispatches/${id}`, async (route) => {
    if (!isSave(route, id)) return route.continue();
    if (!held) {
      held = route;
      return;
    }
    keptAlive.push(route.request().postData()?.includes('Typed during the save') ?? false);
    return route.continue();
  });
  await expect.poll(() => held !== null, { timeout: 15_000 }).toBe(true);
  await expect(page.getByRole('status').filter({ hasText: 'Saving…' })).toBeVisible();

  // Typing during the save doesn't start a second one, however long the debounce has passed.
  await page.keyboard.type(' Typed during the save.');
  await page.waitForTimeout(1_500);
  expect(keptAlive).toEqual([]);
  await expect(page.getByRole('status').filter({ hasText: 'Saving…' })).toBeVisible();

  const warnings: string[] = [];
  page.on('dialog', (dialog) => {
    warnings.push(dialog.type());
    void dialog.accept();
  });
  await page.reload();
  expect(warnings).toEqual(['beforeunload']);

  // The save sent as the page closed carried the newest words. That request goes out while the
  // page unloads, where page.route doesn't see it, so the proof is what the server stored. Opening
  // the post again sends no save of its own: nothing was written.
  await expect.poll(() => storedBody(page, id)).toContain('Typed during the save');
  await expect(postBody(page)).toContainText('Saved first. Typed during the save.');
  // Nothing left unsaved after the reload: leaving now doesn't warn.
  await page.unroute(`**/api/v1/dispatches/${id}`);
  await expect(
    page.getByRole('status').filter({ hasText: /Saved|All changes saved/ }),
  ).toBeVisible();
});

test('a failed save says so, tries again by itself, and holds back a publish until it lands', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const id = await startPost(page, 'failsave', request);

  let failing = true;
  let saves = 0;
  let published = 0;
  page.on('request', (sent) => {
    if (sent.method() === 'POST' && /\/dispatches\/[^/]+\/publish-web/.test(sent.url())) {
      published += 1;
    }
  });
  await page.route(`**/api/v1/dispatches/${id}`, async (route) => {
    if (!isSave(route, id)) return route.continue();
    saves += 1;
    return failing ? route.abort() : route.continue();
  });

  await postBody(page).click();
  await page.keyboard.type('Words that must not be lost.');
  await expect(page.getByRole('status').filter({ hasText: 'Not saved' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText('Your latest changes are not saved')).toBeVisible();

  // It tries again without another keystroke, and keeps saying so while it can't.
  const firstFailures = saves;
  await expect.poll(() => saves, { timeout: 15_000 }).toBeGreaterThan(firstFailures);
  await expect(page.getByRole('status').filter({ hasText: 'Not saved' })).toBeVisible();

  // Publishing uses the saved post, so it doesn't happen while the save is failing.
  await openMoreOptions(page);
  await page.getByRole('button', { name: 'Publish to web only' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Not saved' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish to web only' })).toBeEnabled();
  expect(published).toBe(0);

  failing = false;
  // The next try comes by itself. The publish above made the wait longer: up to 30 seconds.
  await expect(
    page.getByRole('status').filter({ hasText: /^(All changes saved|Saved \d\d:\d\d)$/ }),
  ).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText('Your latest changes are not saved')).toHaveCount(0);
  await expect.poll(() => storedBody(page, id)).toContain('Words that must not be lost.');
});

test('typing fast sends one save, not one per keystroke', async ({ page, request }) => {
  test.setTimeout(120_000);
  const id = await startPost(page, 'onesave', request);
  let saves = 0;
  await page.route(`**/api/v1/dispatches/${id}`, async (route) => {
    if (isSave(route, id)) saves += 1;
    return route.continue();
  });
  await postBody(page).click();
  await page.keyboard.type('Thirty characters typed quickly', { delay: 20 });
  await expectPostSaved(page);
  expect(saves).toBe(1);
});
