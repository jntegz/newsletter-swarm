// Standing feeds of a workspace's data (docs/security.md "Standing feeds"): creating an API key,
// a webhook endpoint or an export destination needs a second factor of the operator's own proved
// in the last 10 minutes. The dashboard asks "Confirm it is you" and retries; the other owners and
// admins are emailed; and "Pause all outbound feeds" stops them all at once.
import { createHash, randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  addAuthenticatorApp,
  expectAccessible,
  forgetCached,
  localSql,
  signIn,
  totpCode,
} from './helpers';
import { api, nextMail, workspaceOf } from './subscriber-links';

const hex = () => randomBytes(16).toString('hex');

/**
 * Makes this session's last second-factor check older than the 10 minutes a standing feed
 * accepts, as if the operator had verified a while ago. The api caches a session's facts in KV
 * for a few minutes, so the cached copy goes too.
 */
async function ageSecondFactorCheck(page: Page, email: string) {
  localSql(
    `UPDATE sessions SET mfa_verified_at = mfa_verified_at - 3600000 WHERE operator_id = (SELECT id FROM operators WHERE email = '${email}') AND revoked_at IS NULL`,
  );
  const cookie = (await page.context().cookies()).find((c) => c.name.endsWith('swarm_session'));
  if (!cookie) throw new Error('no session cookie');
  forgetCached(`sess:v2:${createHash('sha256').update(cookie.value).digest('hex')}`);
}

/** An owner or admin who isn't signed in: someone who should hear about new feeds. */
function addAdmin(workspaceId: string, email: string) {
  const now = Date.now();
  localSql(
    `INSERT INTO operators (id, email, created_at, updated_at) VALUES ('op_${hex()}', '${email}', ${now}, ${now});
     INSERT INTO seats (id, workspace_id, operator_id, role, created_at, updated_at)
       SELECT 'st_${hex()}', '${workspaceId}', id, 'admin', ${now}, ${now} FROM operators WHERE email = '${email}';`,
  );
}

test('standing feeds need a fresh second factor, tell the other admins, and pause all at once', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const stamp = Date.now() * 10 + test.info().parallelIndex;
  const owner = `feeds-${stamp}@example.com`;
  const admin = `feeds-admin-${stamp}@example.com`;

  await page.goto('/');
  await signIn(page, request, owner);
  const secret = await addAuthenticatorApp(page);
  // Adding the factor used the code of this 30-second step; each check needs a later one.
  let lastStep = Math.floor(Date.now() / 30_000);
  const nextCode = async () => {
    const step = lastStep + 1;
    // The api accepts the next step's code, not one further ahead.
    while (Math.floor(Date.now() / 30_000) + 1 < step) await page.waitForTimeout(1000);
    lastStep = step;
    return totpCode(secret, step - Math.floor(Date.now() / 30_000));
  };

  const workspaceId = await workspaceOf(page);
  addAdmin(workspaceId, admin);
  // Export destinations are part of the paid plans.
  localSql(`UPDATE workspaces SET plan = 'pro' WHERE id = '${workspaceId}'`);
  const channel = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/workspaces/${workspaceId}/channels`,
    { name: 'Field Notes', slug: `feeds-${stamp.toString(36)}` },
  );

  const stepUp = page.getByRole('dialog', { name: 'Confirm it is you' });
  /** Confirms in the step-up dialog with the next authenticator code. */
  const confirm = async () => {
    await expect(stepUp).toBeVisible();
    await stepUp.getByLabel('6-digit code').fill(await nextCode());
    await stepUp.getByRole('button', { name: 'Confirm' }).click();
    await expect(stepUp).toBeHidden();
  };
  /** The api's answer to a direct request when the last check is too old. */
  const refused = async (path: string, data: unknown) => {
    const origin = new URL(page.url()).origin;
    const res = await page.request.post(`${origin}${path}`, {
      headers: { origin, 'content-type': 'application/json' },
      data,
    });
    expect(res.status()).toBe(403);
    expect(await res.text()).toContain('step_up_required');
  };

  await test.step('an API key', async () => {
    await ageSecondFactorCheck(page, owner);
    await refused(`/api/v1/workspaces/${workspaceId}/api-keys`, {
      name: 'Sneaky',
      scopes: ['channels:read'],
    });
    await page.goto('/settings/developers');
    await page.getByRole('button', { name: 'Create key' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Create an API key' });
    await dialog.getByLabel('Name').fill('Zapier');
    await dialog.getByRole('button', { name: 'Create key' }).click();
    await expect(stepUp).toBeVisible();
    await expect(stepUp).toContainText('This change needs a fresh check with your second factor.');
    await expectAccessible(page);

    // A wrong code is refused, and nothing is created.
    await stepUp.getByLabel('6-digit code').fill('000000');
    await stepUp.getByRole('button', { name: 'Confirm' }).click();
    await expect(stepUp.getByText('Not verified')).toBeVisible();
    const keys = await api<{ name: string }[]>(
      page,
      'GET',
      `/api/v1/workspaces/${workspaceId}/api-keys`,
    );
    expect(keys.map((k) => k.name)).toEqual([]);

    await stepUp.getByLabel('6-digit code').fill(await nextCode());
    await stepUp.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('dialog', { name: 'Copy your new key' })).toBeVisible();
    const notice = await nextMail(request, admin, 'standing_feed_changed', null);
    expect(notice.subject).toBe('A new API key: Zapier');
    expect(notice.text).toContain(`${owner} created the API key “Zapier”.`);
  });

  await test.step('a webhook endpoint', async () => {
    await page.goto('/settings/developers/webhooks');
    await expect(page.getByRole('heading', { name: 'Webhooks' })).toBeVisible();
    await ageSecondFactorCheck(page, owner);
    await refused(`/api/v1/workspaces/${workspaceId}/webhooks`, {
      url: 'https://elsewhere.example.com/hook',
      events: ['member.created'],
    });
    const before = (await nextMail(request, admin, 'standing_feed_changed', null)).id;
    await page.getByRole('button', { name: 'Add endpoint' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add endpoint' });
    await dialog.getByLabel('URL').fill('https://hooks.example.com/swarm');
    await dialog.getByRole('checkbox').first().check();
    await dialog.getByRole('button', { name: 'Add endpoint' }).click();
    await confirm();
    await expect(page.getByRole('dialog', { name: 'Signing secret' })).toBeVisible();
    await page
      .getByRole('dialog', { name: 'Signing secret' })
      .getByRole('button', { name: 'Done' })
      .click();
    await expect(
      page.getByText('https://hooks.example.com/swarm').locator('visible=true').first(),
    ).toBeVisible();
    const notice = await nextMail(request, admin, 'standing_feed_changed', before);
    expect(notice.subject).toContain('https://hooks.example.com/swarm');
  });

  await test.step('an export destination', async () => {
    await page.goto(`/channels/${channel.id}/export-destinations`);
    await expect(page.getByRole('heading', { name: 'No export destinations yet' })).toBeVisible();
    await ageSecondFactorCheck(page, owner);
    const before = (await nextMail(request, admin, 'standing_feed_changed', null)).id;
    await page.getByRole('button', { name: 'Add destination' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add export destination' });
    await dialog.getByLabel('Storage').selectOption('s3');
    await dialog.getByLabel('Bucket').fill('field-notes-backup');
    await dialog.getByLabel('Region').fill('eu-west-1');
    await dialog.getByLabel('Access key ID').fill('AKIAEXAMPLE0000000000');
    await dialog.getByLabel('Secret access key').fill('example-secret-access-key-0000000000');
    await dialog.getByRole('button', { name: 'Add destination' }).click();
    await confirm();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByText('field-notes-backup').locator('visible=true').first(),
    ).toBeVisible();
    const notice = await nextMail(request, admin, 'standing_feed_changed', before);
    expect(notice.subject).toBe('Subscriber export added: field-notes-backup');
  });

  await test.step('pausing every outbound feed', async () => {
    const before = (await nextMail(request, admin, 'standing_feed_changed', null)).id;
    await page.goto('/settings/security');
    await page.getByRole('button', { name: 'Pause all feeds' }).click();
    const dialog = page.getByRole('dialog', { name: 'Pause every outbound feed?' });
    await expectAccessible(page);
    await dialog.getByRole('button', { name: 'Pause all feeds' }).click();
    const result = page.getByRole('status').filter({ hasText: 'Paused 2 feeds.' });
    await expect(result).toBeVisible();
    await expect(result).toContainText('Webhook endpoint: https://hooks.example.com/swarm');
    await expect(result).toContainText('Export destination:');
    const notice = await nextMail(request, admin, 'standing_feed_changed', before);
    expect(notice.subject).toBe('All outbound feeds were paused');

    const endpoints = await api<{ status: string }[]>(
      page,
      'GET',
      `/api/v1/workspaces/${workspaceId}/webhooks`,
    );
    expect(endpoints.map((e) => e.status)).toEqual(['paused']);
    const destinations = await api<{ status: string }[]>(
      page,
      'GET',
      `/api/v1/channels/${channel.id}/export-destinations`,
    );
    expect(destinations.map((d) => d.status)).toEqual(['paused']);
  });
});
