// Shared steps for the stories about what subscribers do from the links Swarm mails them: the
// Member Center behind every footer, the website's sign-in and gift links, and the public data
// request page. Everything runs on the dev stand-ins: PAYMENTS=dev for Stripe and the dev mailbox
// for mail.
import {
  expect,
  type APIRequestContext,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test';
import { DASHBOARD_PORT } from '../workers';
import {
  API,
  chooseEveryone,
  createPublication,
  expectPostSaved,
  newPost,
  openSection,
  postBody,
  sendNow,
} from './helpers';

const DASHBOARD = `http://localhost:${DASHBOARD_PORT}`;
export const CAPTURE = 'http://localhost:8791';
const SITE_PORT = 8792;

export const siteUrl = (slug: string, path = '/') =>
  `http://${slug}.site.localhost:${SITE_PORT}${path}`;

/** A dashboard API call from the signed-in page; fails the test unless it answers 2xx. */
export async function api<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(`${DASHBOARD}${path}`, {
    method,
    headers: { origin: DASHBOARD, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { data }),
  });
  expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
  return res.status() === 204 ? (undefined as T) : ((await res.json()) as { data: T }).data;
}

interface StoredMail {
  id: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  category: string;
}

async function newest(request: APIRequestContext, to: string): Promise<StoredMail | null> {
  const res = await request.get(`${API}/__dev/mail/latest.json?to=${encodeURIComponent(to)}`);
  if (res.status() !== 200) return null;
  return ((await res.json()) as { data: StoredMail }).data;
}

/** The id of the newest mail to an address, or null: to wait for the next one after it. */
export const lastMailId = async (request: APIRequestContext, to: string) =>
  (await newest(request, to))?.id ?? null;

/**
 * Waits for a mail to `to` newer than `after` (an id from lastMailId) in `category`, and returns
 * it. The dev mailbox keeps everything, newest first.
 */
export async function nextMail(
  request: APIRequestContext,
  to: string,
  category: string,
  after: string | null,
): Promise<StoredMail> {
  let mail: StoredMail | null = null;
  await expect
    .poll(
      async () => {
        mail = await newest(request, to);
        return mail && mail.id !== after ? mail.category : null;
      },
      { timeout: 30_000 },
    )
    .toBe(category);
  return mail as unknown as StoredMail;
}

/** The first link in a mail's text that contains `path`. */
export function linkIn(mail: StoredMail, path: string): string {
  const link = mail.text.match(new RegExp(`https?://\\S+${path}\\S*`))?.[0];
  if (!link) throw new Error(`no ${path} link in “${mail.subject}”`);
  return link;
}

let clients = 0;

/**
 * The capture worker rate-limits Member Center actions, link requests and data requests per
 * client IP, and locally every browser is the same client, kept across runs. Gives this page's
 * requests to the capture worker an address of their own (CF-Connecting-IP, as Cloudflare's edge
 * sets it).
 */
export async function ownCaptureClient(page: Page) {
  const ip = `192.0.2.${(process.pid * 13 + clients++ * 7 + Date.now()) % 250}`;
  await page.route(`${CAPTURE}/**`, (route) =>
    route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': ip } }),
  );
}

/** The signed-in operator's (first) workspace. */
export async function workspaceOf(page: Page): Promise<string> {
  const me = await api<{ workspaces: { id: string }[] }>(page, 'GET', '/api/v1/auth/session');
  return me.workspaces[0]!.id;
}

/**
 * From the empty Home: a publication that sells a "Supporter" plan at $8 a month through the dev
 * Stripe, with `members` on its list (consented, so active). Returns its id; the page is left on
 * the publication.
 */
export async function paidPublication(
  page: Page,
  name: string,
  slug: string,
  members: string[],
): Promise<string> {
  await createPublication(page, name, slug);
  const channelId = /\/channels\/(ch_[0-9a-f]{32})/.exec(page.url())![1]!;
  const back = page.url();
  // The dev Connect URL returns through the callback at once.
  await page.goto(`/settings/payments?channel=${channelId}`);
  await page.getByRole('button', { name: 'Connect Stripe' }).click();
  await expect(page).toHaveURL(/connected=1/);
  await api(page, 'POST', `/api/v1/channels/${channelId}/levels`, {
    name: 'Supporter',
    prices: [{ interval: 'month', currency: 'usd', amount: 800 }],
  });
  for (const email of members) {
    await api(page, 'POST', `/api/v1/channels/${channelId}/members`, { email, consent: true });
  }
  await page.goto(back);
  return channelId;
}

/**
 * Opens a page until `ready` shows. Each local worker opens the same D1 file from its own
 * process, so a read can fail now and then while another process writes ("Failed to get session
 * commit token"), and the page answers 500. That is local D1 only; open it again.
 */
export async function openUntil(page: Page, url: string, ready: Locator) {
  await expect(async () => {
    await page.goto(url);
    await expect(ready).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
}

/** A reader buys the Supporter plan on the website, in a browser of their own. */
export async function buySupporter(browser: Browser, slug: string, email: string) {
  const context = await browser.newContext();
  const shop = await context.newPage();
  const plan = shop.getByRole('listitem').filter({
    has: shop.getByRole('heading', { level: 2, name: 'Supporter' }),
  });
  await openUntil(shop, siteUrl(slug, '/subscribe'), plan);
  await plan.getByLabel('Email').fill(email);
  // The stand-in Turnstile fills the token in the widget.
  await expect(plan.locator('input[name="cf-turnstile-response"]')).toHaveValue(/.+/, {
    timeout: 30_000,
  });
  await plan.getByRole('button', { name: /^Subscribe for/ }).click();
  await expect(shop.getByRole('heading', { name: 'Test checkout' })).toBeVisible();
  await shop.getByRole('button', { name: 'Complete test purchase' }).click();
  await expect(shop.getByRole('heading', { name: /You.re in/ })).toBeVisible({ timeout: 20_000 });
  await context.close();
}

/** Writes a post and sends it to everyone; `count` is the audience the send route must show. */
export async function sendBroadcast(page: Page, subject: string, count: number) {
  await openSection(page, 'Posts');
  await newPost(page);
  await page.getByLabel('Subject').fill(subject);
  await postBody(page).click();
  await page.keyboard.type('This week, from the garden.');
  await expectPostSaved(page);
  await chooseEveryone(page);
  await sendNow(page, count);
  await expect(page).toHaveURL(/\/broadcasts\/bc_/);
  await expect(page.getByText('Sent', { exact: true })).toBeVisible({ timeout: 60_000 });
}

/** The form on the Member Center page that performs one action. */
export const centerForm = (page: Page, action: string) =>
  page.locator('form', { has: page.locator(`input[name="action"][value="${action}"]`) });

/** "r•••@example.org": how a footer link's page shows the address. */
export const masked = (email: string) => `${email[0]}•••${email.slice(email.lastIndexOf('@'))}`;
