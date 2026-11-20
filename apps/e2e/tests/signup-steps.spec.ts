// A website signup in steps, and an owner's own confirmation email, in a real browser: the address
// is saved at the first step, the name is added at the next, and the address never reaches a URL.
import { expect, test, type Page } from '@playwright/test';
import { enableChannelFlag, mailLink, ownSignupClient, signIn } from './helpers';

const SITE_PORT = 8792;
const DASHBOARD = 'http://localhost:5273';

async function api<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(`${DASHBOARD}${path}`, {
    method,
    headers: { origin: DASHBOARD, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { data }),
  });
  expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
  return ((await res.json()) as { data: T }).data;
}

test('a reader joins in steps; leaving early keeps them, and the owner’s email goes out', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const slug = `steps-${stamp.toString(36)}`;
  await page.goto('/');
  await signIn(page, request, `steps-${stamp}@example.com`);
  const me = await api<{ workspaces: { id: string }[] }>(page, 'GET', '/api/v1/auth/session');
  const channel = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/workspaces/${me.workspaces[0]!.id}/channels`,
    { name: 'Field Notes', slug },
  );
  enableChannelFlag('signup_paths', channel.id);
  enableChannelFlag('message_templates', channel.id);
  enableChannelFlag('site_templates', channel.id);

  // Every subscriber must confirm, and the form tries to turn that off.
  const form = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/channels/${channel.id}/capture-forms`,
    {
      name: 'Steps',
      config: {
        fields: [
          { key: 'email', label: 'Email', required: true },
          { key: 'first_name', label: 'First name', required: true },
        ],
        consent: { text: 'I agree to receive this newsletter.', required: true },
        layout: 'regular',
        placement: 'inline',
        trigger: { type: 'immediate' },
        frequency: { type: 'every_visit' },
        success: { type: 'message', message: 'Check your inbox to confirm.' },
        doubleOptIn: false,
        theme: { accentColor: null, mode: 'auto' },
        allowedOrigins: [],
        copy: { heading: '', body: '', button: 'Subscribe' },
      },
    },
  );
  await api(page, 'POST', `/api/v1/capture-forms/${form.id}/publish`);
  await api(page, 'PATCH', `/api/v1/channels/${channel.id}`, {
    requireConfirmation: true,
    signupPath: 'email_name',
  });
  await api(page, 'PATCH', `/api/v1/channels/${channel.id}/site/settings`, {
    theme: { template: 'gate' },
  });
  await api(page, 'PUT', `/api/v1/channels/${channel.id}/messages/confirm`, {
    subject: 'One click for {{channel_name}}',
    mode: 'text',
    heading: 'Nearly there',
    body: 'Press the button to start reading.',
    buttonLabel: 'Yes, sign me up',
  });

  const origin = `http://${slug}.site.localhost:${SITE_PORT}`;
  const reader = await browser.newContext();
  const visit = await reader.newPage();
  await ownSignupClient(visit);

  const join = async (email: string) => {
    await visit.goto(`${origin}/`);
    // The first step asks for the address and the agreement alone.
    await expect(visit.getByLabel('First name')).toHaveCount(0);
    await visit.getByLabel('Email').fill(email);
    await visit.getByLabel('I agree to receive this newsletter.').check();
    await visit.getByRole('button', { name: 'Subscribe' }).click();
    // The always-pass test keys fill the token in the widget; a post without it only comes back.
    await expect(visit.locator('input[name="cf-turnstile-response"]')).toHaveValue(/.+/, {
      timeout: 30_000,
    });
    await visit.getByRole('button', { name: 'Continue' }).click();
    await expect(visit.getByRole('heading', { name: 'What should we call you?' })).toBeVisible();
    expect(visit.url()).not.toContain(email);
    expect(visit.url()).not.toContain(encodeURIComponent(email));
  };

  // Someone who stops here is still on the list, and has their confirmation email.
  const leaver = `leaver-${stamp}@example.com`;
  await join(leaver);
  const leaving = await mailLink(request, leaver, '/v1/confirm/');
  expect(leaving).toContain('/v1/confirm/');

  // Someone who goes on gives their name.
  const stayer = `stayer-${stamp}@example.com`;
  await join(stayer);
  await visit.getByLabel('First name').fill('Ada');
  await visit.getByLabel('Last name').fill('Lovelace');
  await visit.getByRole('button', { name: 'Continue' }).click();
  await expect(visit.getByRole('heading', { name: 'You are all set' })).toBeVisible();
  await expect(visit.getByText('Check your inbox to confirm.')).toBeVisible();

  interface Row {
    email: string;
    firstName: string | null;
    status: string;
  }
  const memberRows = async () =>
    (await api<{ items: Row[] }>(page, 'GET', `/api/v1/channels/${channel.id}/members`)).items;
  const row = async (email: string) => (await memberRows()).find((m) => m.email === email);
  // A form set to off can't skip confirmation when the publication requires it.
  await expect.poll(async () => (await row(leaver))?.status).toBe('pending');
  expect((await row(leaver))?.firstName ?? null).toBeNull();
  await expect.poll(async () => (await row(stayer))?.firstName).toBe('Ada');
  expect((await row(stayer))?.status).toBe('pending');

  // The confirmation is the owner's wording, and its link works.
  const link = await mailLink(request, stayer, '/v1/confirm/');
  await visit.goto(link);
  await visit.getByRole('button', { name: /confirm/i }).click();
  await expect.poll(async () => (await row(stayer))?.status).toBe('active');
  await reader.close();
});
