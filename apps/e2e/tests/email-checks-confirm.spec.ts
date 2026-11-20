// Email checks on a form that asks people to confirm (docs/email-verification.md): nothing typed
// into the form goes to DeBounce. Once the person clicks the confirmation link, the capture worker
// queues a background check. DeBounce here is the app's own in-process fake
// (DEBOUNCE_API_KEY=dev, set for the e2e workers in local/worker.mjs): it answers without the
// network, and "Deliverable" for an ordinary address.
import { expect, test } from '@playwright/test';
import { enableWorkspaceFlag, expectAccessible, forgetCached, localSql, signIn } from './helpers';
import { api, linkIn, nextMail, ownCaptureClient, workspaceOf } from './subscriber-links';

const HOST = 'http://localhost:4597';

interface MemberCheck {
  available: boolean;
  check: { source: string; reason: string; state: string } | null;
}

test('a double opt-in signup is checked with DeBounce only after the person confirms', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now() * 10 + test.info().parallelIndex;
  const joiner = `joiner-${stamp}@example.org`;

  await page.goto('/');
  await signIn(page, request, `checks-${stamp}@example.com`);
  const workspaceId = await workspaceOf(page);
  // Checks on for this workspace, and allowed to spend the install's credits, as an instance admin
  // would allow it. "Check signups once they confirm" is on by default.
  enableWorkspaceFlag('email_verification', workspaceId);
  localSql(
    `INSERT INTO email_check_workspaces (workspace_id, created_at) VALUES ('${workspaceId}', ${Date.now()})`,
  );
  forgetCached(`flags:v1:${workspaceId}:-`);
  const channel = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/workspaces/${workspaceId}/channels`,
    { name: 'Field Notes', slug: `checks-${stamp.toString(36)}` },
  );
  const form = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/channels/${channel.id}/capture-forms`,
    {
      name: 'Confirmed signups',
      config: {
        fields: [{ key: 'email', label: 'Email', required: true }],
        consent: null,
        layout: 'regular',
        placement: 'inline',
        trigger: { type: 'immediate' },
        frequency: { type: 'every_visit' },
        success: { type: 'message', message: 'Check your inbox to confirm.' },
        doubleOptIn: true,
        theme: { accentColor: null, mode: 'auto' },
        allowedOrigins: [HOST],
        copy: { heading: 'Join Field Notes', body: 'One email a week.', button: 'Join' },
      },
    },
  );
  await api(page, 'POST', `/api/v1/capture-forms/${form.id}/publish`);
  const snippet = await api<{ script: string }>(
    page,
    'GET',
    `/api/v1/capture-forms/${form.id}/snippet`,
  );

  // Someone joins from the form on a page.
  const visitor = await (await browser.newContext()).newPage();
  // Sign-ups allow 10 per 10 minutes from one client IP.
  await ownCaptureClient(visitor);
  await visitor.route(`${HOST}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="en"><head><title>Host</title></head><body><main><h1>An essay</h1>${snippet.script}</main></body></html>`,
    }),
  );
  // A join that hits local D1 while another worker process writes answers 500 (see openUntil);
  // nothing is stored then, so the visitor tries again.
  await expect(async () => {
    await visitor.goto(`${HOST}/essay`);
    const frame = visitor.frameLocator('iframe[title="Join Field Notes"]');
    await frame.getByLabel('Email').fill(joiner);
    await frame.getByRole('button', { name: 'Join' }).click();
    await expect(frame.getByText('Check your inbox to confirm.')).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 60_000 });

  // Pending and not checked: the address went nowhere yet.
  let memberId = '';
  await expect
    .poll(async () => {
      const pending = await api<{ items: { id: string; email: string }[] }>(
        page,
        'GET',
        `/api/v1/channels/${channel.id}/members?status=pending`,
      );
      memberId = pending.items.find((m) => m.email === joiner)?.id ?? '';
      return memberId;
    })
    .not.toBe('');
  const confirmMail = await nextMail(request, joiner, 'confirm', null);
  const before = await api<MemberCheck>(page, 'GET', `/api/v1/members/${memberId}/email-check`);
  expect(before).toEqual({ available: true, check: null });

  // Confirming queues the check, and the result arrives in the background.
  await visitor.goto(linkIn(confirmMail, '/v1/confirm/'));
  await visitor.getByRole('button', { name: 'Confirm' }).click();
  await expect(visitor.getByRole('heading', { name: 'You are in' })).toBeVisible();
  await expect
    .poll(
      async () =>
        (await api<MemberCheck>(page, 'GET', `/api/v1/members/${memberId}/email-check`)).check,
      { timeout: 60_000 },
    )
    .toMatchObject({ source: 'debounce', reason: 'Deliverable' });

  // The subscriber drawer shows it.
  await page.goto(`/members?channel=${channel.id}`);
  await page.getByRole('button', { name: joiner }).click();
  const drawer = page.getByRole('dialog', { name: joiner });
  const check = drawer.getByRole('region', { name: 'Email check' });
  await expect(check).toContainText('Deliverable');
  await expect(check).toContainText('DeBounce');
  await expectAccessible(page);
  await visitor.context().close();
});
