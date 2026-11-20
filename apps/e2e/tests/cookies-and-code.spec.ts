// The cookie popup and an owner's code in a real browser, where the CSP is what decides: nothing
// loads before a reader agrees, Reject keeps it that way, and Accept lets the tool run.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { allowSiteCode, enableChannelFlag, signIn } from './helpers';

const SITE_PORT = 8792;
const DASHBOARD = 'http://localhost:5273';
const TOOL = 'www.googletagmanager.com';

async function api<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(`${DASHBOARD}${path}`, {
    method,
    headers: { origin: DASHBOARD, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { data }),
  });
  expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
  return ((await res.json()) as { data: T }).data;
}

/** A stand-in for the real tool, so a test never talks to it, and a record of what asked for it. */
async function fakeTool(context: BrowserContext): Promise<string[]> {
  const seen: string[] = [];
  await context.route(`https://${TOOL}/**`, (route) => {
    seen.push(route.request().url());
    return route.fulfill({
      contentType: 'application/javascript',
      headers: { 'access-control-allow-origin': '*' },
      body: 'window.__toolRan = true;',
    });
  });
  return seen;
}

test('nothing runs before consent, Reject blocks it, Accept runs it, and it can be changed', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const slug = `ck-${stamp.toString(36)}`;
  await page.goto('/');
  await signIn(page, request, `cookies-${stamp}@example.com`);
  const me = await api<{ workspaces: { id: string }[] }>(page, 'GET', '/api/v1/auth/session');
  const channel = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/workspaces/${me.workspaces[0]!.id}/channels`,
    { name: 'Field Notes', slug },
  );
  enableChannelFlag('site_custom_code', channel.id);
  allowSiteCode(channel.id);
  await api(page, 'PATCH', `/api/v1/channels/${channel.id}/site/settings`, {
    consent: {
      enabled: true,
      text: 'We use cookies to see how this site is used.',
      acceptLabel: 'Accept all',
      rejectLabel: 'Reject all',
      policyUrl: '/about',
      position: 'bottom',
    },
    code: [
      {
        name: 'Analytics',
        preset: 'google_analytics',
        category: 'analytics',
        value: 'G-TEST12345',
      },
      {
        name: 'Inline',
        preset: 'custom',
        category: 'analytics',
        value: '<script>window.__inlineRan = true;</script>',
      },
    ],
  });
  const home = `http://${slug}.site.localhost:${SITE_PORT}/`;

  const context = await browser.newContext();
  const seen = await fakeTool(context);
  const reader = await context.newPage();
  const blocked: string[] = [];
  reader.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) blocked.push(m.text());
  });

  // First visit: the popup asks, and nothing has loaded.
  await reader.goto(home);
  const popup = reader.getByRole('dialog', { name: 'Cookie choices' });
  await expect(popup).toBeVisible();
  const accept = popup.getByRole('button', { name: 'Accept all' });
  const reject = popup.getByRole('button', { name: 'Reject all' });
  // Rejecting is as easy to see as accepting.
  const [a, r] = [await accept.boundingBox(), await reject.boundingBox()];
  expect(Math.abs(a!.height - r!.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(a!.width - r!.width)).toBeLessThanOrEqual(1);
  expect(await accept.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(
    await reject.evaluate((e) => getComputedStyle(e).backgroundColor),
  );
  await reader.waitForLoadState('networkidle');
  expect(seen).toEqual([]);
  expect(
    await reader.evaluate(() => (window as { __inlineRan?: boolean }).__inlineRan),
  ).toBeUndefined();

  // Reject: gone, and still nothing, on this page and the next.
  await reject.click();
  await expect(popup).toBeHidden();
  await reader.reload();
  await expect(popup).toBeHidden();
  await reader.waitForLoadState('networkidle');
  expect(seen).toEqual([]);

  // Change of mind from the footer: Accept runs the tool now, with no reload.
  await reader.getByRole('button', { name: 'Cookie settings' }).click();
  await expect(popup).toBeVisible();
  await accept.click();
  await expect.poll(() => seen.length).toBeGreaterThan(0);
  expect(seen[0]).toContain('gtag/js?id=G-TEST12345');
  await expect
    .poll(() => reader.evaluate(() => (window as { __toolRan?: boolean }).__toolRan))
    .toBe(true);
  expect(await reader.evaluate(() => (window as { __inlineRan?: boolean }).__inlineRan)).toBe(true);
  expect(blocked, 'the CSP blocked something the owner’s code needed').toEqual([]);

  // Remembered on the next page, and it runs with the popup closed. This one may be a cached copy.
  await reader.reload();
  await expect(popup).toBeHidden();
  await expect
    .poll(() => reader.evaluate(() => (window as { __toolRan?: boolean }).__toolRan))
    .toBe(true);
  expect(blocked).toEqual([]);

  // New code means asking again.
  await api(page, 'PATCH', `/api/v1/channels/${channel.id}/site/settings`, {
    code: [
      {
        name: 'Analytics',
        preset: 'google_analytics',
        category: 'analytics',
        value: 'G-OTHER6789',
      },
    ],
  });
  await reader.goto(`${home}?next=1`);
  await expect(popup).toBeVisible();
  await context.close();
});

test('the bot check on the plans page still runs with an owner’s code on it', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  const slug = `ckp-${stamp.toString(36)}`;
  await page.goto('/');
  await signIn(page, request, `cookies-p-${stamp}@example.com`);
  const me = await api<{ workspaces: { id: string }[] }>(page, 'GET', '/api/v1/auth/session');
  const channel = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/workspaces/${me.workspaces[0]!.id}/channels`,
    { name: 'Field Notes', slug },
  );
  enableChannelFlag('site_custom_code', channel.id);
  allowSiteCode(channel.id);
  await page.goto(`/settings/payments?channel=${channel.id}`);
  await page.getByRole('button', { name: 'Connect Stripe' }).click();
  await expect(page).toHaveURL(/connected=1/);
  await api(page, 'POST', `/api/v1/channels/${channel.id}/levels`, {
    name: 'Supporter',
    prices: [{ interval: 'month', currency: 'usd', amount: 800 }],
  });
  await api(page, 'PATCH', `/api/v1/channels/${channel.id}/site/settings`, {
    consent: {
      enabled: true,
      text: 'Cookies?',
      acceptLabel: 'Accept all',
      rejectLabel: 'Reject all',
      policyUrl: '',
      position: 'bottom',
    },
    code: [
      {
        name: 'Analytics',
        preset: 'google_analytics',
        category: 'analytics',
        value: 'G-TEST12345',
      },
    ],
  });
  const context = await browser.newContext();
  const reader = await context.newPage();
  const blocked: string[] = [];
  reader.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) blocked.push(m.text());
  });
  await reader.goto(`http://${slug}.site.localhost:${SITE_PORT}/subscribe`);
  await expect(reader.locator('input[name="cf-turnstile-response"]').first()).toHaveValue(/.+/, {
    timeout: 30_000,
  });
  expect(blocked.filter((text) => /challenges\.cloudflare\.com/.test(text))).toEqual([]);
  await context.close();
});
