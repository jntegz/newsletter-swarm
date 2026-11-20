// Shared by the specs that open dashboard screens through their real UI.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { allowSiteCode, API, enableChannelFlag, ownSignupClient, signIn } from './helpers';

const SITE_PORT = 8792;
const DASHBOARD = 'http://localhost:5273';

export async function api<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(`${DASHBOARD}${path}`, {
    method,
    headers: { origin: DASHBOARD, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { data }),
  });
  expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
  return ((await res.json()) as { data: T }).data;
}

export interface Publication {
  id: string;
  slug: string;
  origin: string;
  email: string;
}

/** Signs in a new person and makes a publication with these flags on, before any page reads them. */
export async function publication(
  page: Page,
  request: APIRequestContext,
  prefix: string,
  flags: string[],
  /** False leaves website code to the instance rules, as on a shared install. */
  allowCode = true,
): Promise<Publication> {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  const slug = `${prefix}-${stamp}`;
  const email = `${prefix}-${stamp}@example.com`;
  await page.goto('/');
  await signIn(page, request, email);
  const me = await api<{ workspaces: { id: string }[] }>(page, 'GET', '/api/v1/auth/session');
  const channel = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/workspaces/${me.workspaces[0]!.id}/channels`,
    { name: 'Field Notes', slug },
  );
  for (const flag of flags) enableChannelFlag(flag, channel.id);
  if (allowCode && flags.includes('site_custom_code')) allowSiteCode(channel.id);
  return { id: channel.id, slug, origin: `http://${slug}.site.localhost:${SITE_PORT}`, email };
}

/** Publishes a signup form, which a website needs before it takes signups. */
export async function publishForm(page: Page, channelId: string) {
  const form = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/channels/${channelId}/capture-forms`,
    {
      name: 'Website',
      config: {
        fields: [{ key: 'email', label: 'Email', required: true }],
        consent: { text: 'I agree to receive this newsletter.', required: true },
        layout: 'regular',
        placement: 'inline',
        trigger: { type: 'immediate' },
        frequency: { type: 'every_visit' },
        success: { type: 'message', message: 'Check your inbox to confirm.' },
        doubleOptIn: true,
        theme: { accentColor: null, mode: 'auto' },
        allowedOrigins: [],
        copy: { heading: '', body: '', button: 'Subscribe' },
      },
    },
  );
  await api(page, 'POST', `/api/v1/capture-forms/${form.id}/publish`);
}

/** Subscribes through the website's form, through the Turnstile step. Counts against the rate limit. */
export async function subscribeOnSite(visit: Page, origin: string, email: string) {
  await ownSignupClient(visit);
  await visit.goto(`${origin}/`);
  const form = visit.locator('#subscribe');
  await form.getByRole('textbox', { name: 'Email' }).fill(email);
  await form.getByLabel('I agree to receive this newsletter.').check();
  await form.getByRole('button', { name: 'Subscribe' }).click();
  // The always-pass test keys fill the token in the widget; a post without it only comes back.
  await expect(visit.locator('input[name="cf-turnstile-response"]')).toHaveValue(/.+/, {
    timeout: 30_000,
  });
  await visit.getByRole('button', { name: 'Continue' }).click();
}

interface Mail {
  subject: string;
  html: string;
  text: string;
  to: string;
}

/** The newest local mail for an address, once one has arrived. */
export async function latestMail(request: APIRequestContext, to: string, subject?: RegExp) {
  let found: Mail | null = null;
  await expect
    .poll(
      async () => {
        const res = await request.get(`${API}/__dev/mail/latest.json?to=${encodeURIComponent(to)}`);
        if (!res.ok()) return false;
        found = ((await res.json()) as { data: Mail }).data;
        return subject ? subject.test(found.subject) : true;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return found as unknown as Mail;
}

/** Whether any local mail has gone to an address. */
export async function hasMail(request: APIRequestContext, to: string) {
  const res = await request.get(`${API}/__dev/mail/latest.json?to=${encodeURIComponent(to)}`);
  return res.ok();
}

/** Keeps a full-page picture to look at, when SCREEN_SHOTS names a folder. */
export async function shot(page: Page, name: string) {
  const folder = process.env.SCREEN_SHOTS;
  if (!folder) return;
  mkdirSync(folder, { recursive: true });
  await page.screenshot({ path: join(folder, `${name}.png`), fullPage: true });
}
