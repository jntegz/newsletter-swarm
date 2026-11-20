// Phase 8 Rosters (flag rosters): an operator creates a Roster, puts a Member on it and sends a
// Dispatch to that Roster only, choosing the conflict policy. axe runs on each screen.
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_PORT } from '../workers';
import { enableChannelFlag, expectAccessible, expectPostSaved, openStop, signIn } from './helpers';

const DASHBOARD = `http://localhost:${DASHBOARD_PORT}`;

async function api<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(`${DASHBOARD}${path}`, {
    method,
    headers: { origin: DASHBOARD, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { data }),
  });
  expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
  return ((await res.json()) as { data: T }).data;
}

test('an operator creates Rosters and sends a Dispatch to one of them', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now() * 10 + test.info().parallelIndex;
  await page.goto('/');
  await signIn(page, request, `rosters-${stamp}@example.com`);
  const me = await api<{ workspaces: { id: string }[] }>(page, 'GET', '/api/v1/auth/session');
  const channel = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/workspaces/${me.workspaces[0]!.id}/channels`,
    { name: 'Field Notes', slug: `rosters-${stamp.toString(36)}` },
  );
  enableChannelFlag('rosters', channel.id);
  const members: { id: string }[] = [];
  for (const email of [`a-${stamp}@example.org`, `b-${stamp}@example.org`]) {
    members.push(
      await api(page, 'POST', `/api/v1/channels/${channel.id}/members`, { email, consent: true }),
    );
  }

  // Members → Rosters: the empty state, then two Rosters.
  await page.goto(`/rosters?channel=${channel.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Rosters' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No Rosters yet' })).toBeVisible();
  await expectAccessible(page);
  for (const name of ['Weekly deals', 'Events']) {
    await page.getByRole('button', { name: 'Create a Roster' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Create a Roster' });
    await dialog.getByLabel('Name').fill(name);
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await expectAccessible(page);

  const rosters = await api<{ items: { id: string; name: string }[] }>(
    page,
    'GET',
    `/api/v1/channels/${channel.id}/rosters`,
  );
  const deals = rosters.items.find((r) => r.name === 'Weekly deals')!;
  const events = rosters.items.find((r) => r.name === 'Events')!;
  for (const roster of [deals, events]) {
    await api(
      page,
      'PUT',
      `/api/v1/channels/${channel.id}/members/${members[0]!.id}/rosters/${roster.id}`,
      { status: 'subscribed' },
    );
  }

  // The Dispatch's audience: only Weekly deals, leaving out Events, with the conflict choice.
  const dispatch = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/channels/${channel.id}/dispatches`,
    { subject: 'This week’s deals' },
  );
  await page.goto(`/dispatches/${dispatch.id}`);
  await openStop(page, 'Who gets it');
  await page.getByRole('group', { name: 'Only subscribers on' }).getByLabel('Weekly deals').check();
  await expect(page.getByText('1 active subscriber right now')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('group', { name: 'Leave out subscribers on' }).getByLabel('Events').check();
  await expect(page.getByText('is on both an included and an excluded Roster')).toBeVisible({
    timeout: 15_000,
  });
  // Leaving them out is the default, which empties this audience; the count gives way to the reason.
  await expect(page.getByText('The Rosters let through 0 active subscribers')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText('No active subscribers are in this audience.').first()).toBeVisible();
  await page.getByLabel('Send to them').check();
  await expect(page.getByText('1 active subscriber right now')).toBeVisible({ timeout: 15_000 });
  await expectAccessible(page);
});

test('a slow autosave answer does not undo the audience, on the page or with the next change', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now() * 10 + test.info().parallelIndex;
  await page.goto('/');
  await signIn(page, request, `rosters-race-${stamp}@example.com`);
  const me = await api<{ workspaces: { id: string }[] }>(page, 'GET', '/api/v1/auth/session');
  const channel = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/workspaces/${me.workspaces[0]!.id}/channels`,
    { name: 'Field Notes', slug: `rosters-race-${stamp.toString(36)}` },
  );
  enableChannelFlag('rosters', channel.id);
  const member = await api<{ id: string }>(page, 'POST', `/api/v1/channels/${channel.id}/members`, {
    email: `race-${stamp}@example.org`,
    consent: true,
  });
  const ids: Record<string, string> = {};
  for (const name of ['Weekly deals', 'Events']) {
    const roster = await api<{ id: string }>(
      page,
      'POST',
      `/api/v1/channels/${channel.id}/rosters`,
      {
        name,
      },
    );
    ids[name] = roster.id;
    await api(
      page,
      'PUT',
      `/api/v1/channels/${channel.id}/members/${member.id}/rosters/${roster.id}`,
      {
        status: 'subscribed',
      },
    );
  }
  const dispatch = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/channels/${channel.id}/dispatches`,
    {
      subject: 'This week’s deals',
    },
  );
  const savedRosters = async () =>
    (
      await api<{ audience: { rosters: { include: string[]; exclude: string[] } } }>(
        page,
        'GET',
        `/api/v1/dispatches/${dispatch.id}`,
      )
    ).audience.rosters;

  await page.goto(`/dispatches/${dispatch.id}`);
  await openStop(page, 'Who gets it');
  await expectPostSaved(page);

  // An autosave answers after the audience's save, though the server handled it first.
  const isAutosave = (method: string, body: string | null) =>
    method === 'PATCH' && !(body ?? '').includes('audience');
  const answered = { autosave: false };
  await page.route(`**/api/v1/dispatches/${dispatch.id}`, async (route) => {
    const req = route.request();
    if (!isAutosave(req.method(), req.postData())) return route.continue();
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.fulfill({ response });
    answered.autosave = true;
  });
  const autosave = page.waitForRequest((q) => isAutosave(q.method(), q.postData()));
  await page.getByLabel('Subject').fill('This week’s deals, again');
  await autosave;
  await page.waitForTimeout(300);

  const only = page.getByRole('group', { name: 'Only subscribers on' }).getByLabel('Weekly deals');
  await only.check();
  await expect.poll(() => answered.autosave, { timeout: 15_000 }).toBe(true);
  await page.waitForTimeout(500);

  // The page still shows the choice, and the next change builds on it instead of losing it.
  await expect(only).toBeChecked();
  await page.getByRole('group', { name: 'Leave out subscribers on' }).getByLabel('Events').check();
  await expect
    .poll(savedRosters, { timeout: 15_000 })
    .toMatchObject({ include: [ids['Weekly deals']], exclude: [ids['Events']] });
});
