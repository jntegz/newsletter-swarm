import { expect, test } from '@playwright/test';
import { WORKERS } from '../workers';

for (const worker of WORKERS) {
  test(`${worker.name} worker is healthy behind the shared runtime`, async ({ request }) => {
    const res = await request.get(`http://localhost:${worker.port}/healthz`);
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({
      data: { ok: true, service: worker.name, environment: 'development' },
    });
    expect(res.headers()['strict-transport-security']).toContain('preload');
    expect(res.headers()['x-request-id']).toBeTruthy();

    const securityTxt = await request.get(
      `http://localhost:${worker.port}/.well-known/security.txt`,
    );
    expect(securityTxt.status()).toBe(worker.securityTxt ? 200 : 404);
  });
}

test('every feature flag starts off', async ({ request }) => {
  const res = await request.get('http://localhost:8787/api/v1/flags');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { data: { flags: Record<string, boolean> } };
  expect(Object.keys(body.data.flags).length).toBeGreaterThan(0);
  expect(Object.values(body.data.flags).every((enabled) => !enabled)).toBe(true);
});

test('the dashboard asks visitors to sign in', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in/);
  await expect(page.getByRole('heading', { name: 'Sign in to Swarm' })).toBeVisible();
});
