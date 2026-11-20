import { expect, test } from '@playwright/test';
import { enableWorkspaceFlag, createPublication, expectAccessible, signIn } from './helpers';

const siteUrl = (slug: string, path = '/') => `http://${slug}.site.localhost:8792${path}`;

test('an editor publishes a landing page, and a visitor signs up from it', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now() * 10 + test.info().parallelIndex;
  const slug = `land-${stamp.toString(36)}`;
  const api = async <T>(method: string, path: string, data?: unknown): Promise<T> =>
    page.evaluate(
      async ({ method, path, data }) => {
        const res = await fetch(path, {
          method,
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        });
        return ((await res.json()) as { data: T }).data;
      },
      { method, path, data },
    );

  await page.goto('/');
  await signIn(page, request, `land-${stamp}@example.com`);
  const me = await api<{ workspaces: { id: string }[] }>('GET', '/api/v1/auth/session');
  enableWorkspaceFlag('landing_pages', me.workspaces[0]!.id);
  await createPublication(page, 'Field Notes', slug);
  const channelId = /\/channels\/(ch_[0-9a-f]{32})/.exec(page.url())![1]!;

  const form = await api<{ id: string }>('POST', `/api/v1/channels/${channelId}/capture-forms`, {
    name: 'Guide form',
  });
  await api('POST', `/api/v1/capture-forms/${form.id}/publish`);

  // Pick a starter and a form: the words in brackets are there to replace.
  await page.goto(`/site/${channelId}/pages`);
  await page.getByRole('button', { name: 'New page' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New page' });
  await dialog.getByLabel('Kind of page').selectOption('download');
  await expect(dialog.getByRole('button', { name: 'Create page' })).toBeDisabled();
  await dialog.getByLabel('Signup form').selectOption(form.id);
  await dialog.getByLabel('Title').fill('Get the field guide free');
  await dialog.getByLabel(/^Address/).fill('field-guide');
  await expectAccessible(page);
  await dialog.getByRole('button', { name: 'Create page' }).click();
  await expect(page).toHaveURL(/\/pages\/pg_|\/pages\/[a-z]+_/);
  await expect(page.getByText('What’s inside')).toBeVisible();
  await expect(page.getByLabel('Signup form')).toHaveValue(form.id);
  await page.getByRole('button', { name: /^Publish/ }).click();
  await expect(page.getByText('Published: anyone can read it on the website.')).toBeVisible();

  // A visitor sees the page and the form, and nothing to wander off to.
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(siteUrl(slug, '/field-guide'));
  await expect(visitor.getByRole('heading', { level: 1, name: /field guide/ })).toBeVisible();
  await expect(visitor.getByRole('navigation')).toHaveCount(0);
  await expect(visitor.getByRole('search')).toHaveCount(0);
  await expect(visitor.locator('form[data-swarm-subscribe]')).toHaveCount(1);
  await expect(visitor.locator('form[data-swarm-subscribe]')).toHaveAttribute(
    'action',
    new RegExp(`/v1/${form.id}/subscribe$`),
  );
  await expectAccessible(visitor);

  const email = `land-reader-${stamp}@example.org`;
  await visitor.getByLabel('Email').fill(email);
  await visitor.locator('form[data-swarm-subscribe] button[type="submit"]').click();
  await expect(visitor.getByRole('heading', { name: 'One more step' })).toBeVisible();
  await expect(visitor.locator('input[name="cf-turnstile-response"]')).toHaveValue(/.+/, {
    timeout: 30_000,
  });
  await visitor.getByRole('button', { name: 'Continue' }).click();
  await expect(visitor.getByRole('heading', { name: 'Thank you' })).toBeVisible();
  await expect
    .poll(async () => {
      const pending = await api<{ items: { email: string }[] }>(
        'GET',
        `/api/v1/channels/${channelId}/members?status=pending`,
      );
      return pending.items.map((m) => m.email);
    })
    .toContain(email);
});
