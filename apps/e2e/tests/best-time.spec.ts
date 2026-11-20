// The send option "Send at each reader's best time", from the send route to the send report, with
// the send worker's minute cron driven by hand. Nothing here reaches a real mail service.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  API,
  chooseEveryone,
  createPublication,
  enableWorkspaceFlag,
  expectAccessible,
  expectPostSaved,
  localSql,
  newPost,
  openSection,
  openStop,
  postBody,
  postSettings,
  sendNow,
  signIn,
  turnOnTracking,
} from './helpers';

const SEND_WORKER = 'http://localhost:8788';
const LABEL = 'Send at each reader’s best time';
const hex = () => crypto.randomUUID().replace(/-/g, '');

/** Runs the send worker's minute cron once. */
async function minuteCron(request: APIRequestContext) {
  const res = await request.get(`${SEND_WORKER}/__scheduled?cron=*+*+*+*+*`);
  expect(res.status()).toBe(200);
}

/** Flags go on the workspace before the publication exists, since flags are cached for a minute. */
async function publication(
  page: Page,
  request: APIRequestContext,
  name: string,
  flags: string[] = ['best_time_send'],
) {
  const stamp = Date.now() * 10 + test.info().parallelIndex;
  await page.goto('/');
  await signIn(page, request, `best-time-${name}-${stamp}@example.com`);
  const workspaceId = await page.evaluate(async () => {
    const res = await fetch('/api/v1/auth/session', { credentials: 'same-origin' });
    return ((await res.json()) as { data: { workspaces: { id: string }[] } }).data.workspaces[0]!
      .id;
  });
  for (const flag of flags) enableWorkspaceFlag(flag, workspaceId);
  await createPublication(page, 'Field Notes', `best-${name}-${stamp.toString(36)}`);
  const channelId = /\/channels\/(ch_[0-9a-f]{32})/.exec(page.url())![1]!;
  // Best-time sending works from reader profiles, which a new publication starts without.
  await turnOnTracking(page, channelId, ['trackOpens', 'profileReaders']);
  return { stamp, channelId };
}

async function addReader(page: Page, channelId: string, email: string): Promise<string> {
  return page.evaluate(
    async ({ channelId, email }) => {
      const res = await fetch(`/api/v1/channels/${channelId}/members`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ email, consent: true }),
      });
      if (res.status !== 201) throw new Error(`member not added: ${await res.text()}`);
      return ((await res.json()) as { data: { id: string } }).data.id;
    },
    { channelId, email },
  );
}

/** Three posts this reader opened, in the hour three hours from now (UTC), so the hold is real. */
function seedHabit(channelId: string, memberId: string, email: string) {
  const now = Date.now();
  const hour = (new Date(now).getUTCHours() + 3) % 24;
  const statements = [1, 2, 3].flatMap((weeks) => {
    const opened = new Date(now - weeks * 7 * 86_400_000);
    opened.setUTCHours(hour, 10, 0, 0);
    const at = opened.getTime();
    const dispatch = `di_${hex()}`;
    const broadcast = `bc_${hex()}`;
    return [
      `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at) VALUES ('${dispatch}', '${channelId}', 'Old', '{"type":"doc","content":[]}', 'sent', ${at}, ${at})`,
      `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text, from_name, from_address, track_opens, created_at, last_progress_at) SELECT '${broadcast}', '${dispatch}', id, workspace_id, 'sent', 'Old', '', '<p>Hi</p>', 'Hi', 'N', 'n@example.com', 1, ${at}, ${at} FROM channels WHERE id = '${channelId}'`,
      `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, status, sent_at, opened_at, human_opened_at) VALUES ('dl_${hex()}', '${broadcast}', '${channelId}', '${memberId}', '${email}', 'delivered', ${at - 3_600_000}, ${at}, ${at})`,
    ];
  });
  localSql(statements.join('; '));
}

async function writePost(page: Page, subject: string) {
  await openSection(page, 'Posts');
  await newPost(page);
  await page.getByLabel('Subject').fill(subject);
  await page.getByLabel('Preview text').fill('What we found');
  const body = postBody(page);
  await body.click();
  await page.keyboard.type('Hello there.');
  await expectPostSaved(page);
}

async function mailCategory(request: APIRequestContext, to: string): Promise<string | null> {
  const res = await request.get(`${API}/__dev/mail/latest.json?to=${encodeURIComponent(to)}`);
  if (res.status() !== 200) return null;
  return ((await res.json()) as { data: { category: string } }).data.category;
}

test('a reader with a habit waits for their hour, others go now, and the report counts both', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const { stamp, channelId } = await publication(page, request, 'send');
  const regular = `regular-${stamp}@example.org`;
  const newcomer = `newcomer-${stamp}@example.org`;
  const regularId = await addReader(page, channelId, regular);
  await addReader(page, channelId, newcomer);
  seedHabit(channelId, regularId, regular);

  await writePost(page, 'Best time issue');
  await chooseEveryone(page);
  const route = postSettings(page);
  const option = route.getByRole('checkbox', { name: LABEL });
  // Off unless chosen, with what it really does next to it.
  await expect(option).not.toBeChecked();
  await expect(route.getByText(/It’s an estimate/)).toBeVisible();
  await expect(route.getByText(/fewer than 3 posts opened or clicked/)).toBeVisible();
  await option.check();
  await expectAccessible(page);

  const send = route.getByRole('button', { name: 'Send to 2 subscribers' });
  await expect(send).toBeEnabled({ timeout: 15_000 });
  await send.click();
  await expect(route.getByText('Readers get it over the next 24 hours')).toBeVisible();
  await route.getByRole('button', { name: 'Confirm' }).click();

  // The report: one personal, one at the chosen time, and the send still open.
  await expect(page).toHaveURL(/\/broadcasts\/(br|bc)_/);
  await expect(page.getByText('1 reader got a personal time; 1 got the chosen time.')).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText('1 of 2')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Readers get this at their best time/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop sending' })).toBeVisible();
  await expectAccessible(page);
  await expect.poll(() => mailCategory(request, newcomer), { timeout: 30_000 }).toBe('broadcast');
  expect(await mailCategory(request, regular)).toBeNull();

  // A minute cron before their hour changes nothing.
  await minuteCron(request);
  await page.waitForTimeout(2_000);
  expect(await mailCategory(request, regular)).toBeNull();

  // Their hour comes round.
  localSql(
    `UPDATE broadcast_recipients SET send_after = ${Date.now() - 1000} WHERE member_id = '${regularId}' AND held = 1`,
  );
  await minuteCron(request);
  await expect.poll(() => mailCategory(request, regular), { timeout: 60_000 }).toBe('broadcast');
  await expect(page.getByText('2 of 2')).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByText('1 reader got a personal time; 1 got the chosen time.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop sending' })).toBeHidden();
});

test('stopping a send leaves a waiting reader unsent', async ({ page, request }) => {
  test.setTimeout(180_000);
  const { stamp, channelId } = await publication(page, request, 'stop');
  const regular = `regular-${stamp}@example.org`;
  const regularId = await addReader(page, channelId, regular);
  await addReader(page, channelId, `newcomer-${stamp}@example.org`);
  seedHabit(channelId, regularId, regular);

  await writePost(page, 'Stopped issue');
  await chooseEveryone(page);
  await postSettings(page).getByRole('checkbox', { name: LABEL }).check();
  await sendNow(page, 2);
  await expect(page.getByText('1 of 2')).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: 'Stop sending' }).click();
  await page
    .getByRole('dialog', { name: 'Stop this send?' })
    .getByRole('button', { name: 'Stop sending' })
    .click();
  await expect(page.getByRole('dialog', { name: 'Stop this send?' })).toBeHidden();

  localSql(`UPDATE broadcast_recipients SET send_after = 1 WHERE member_id = '${regularId}'`);
  await minuteCron(request);
  await page.waitForTimeout(3_000);
  expect(await mailCategory(request, regular)).toBeNull();
});

test('a scheduled send keeps the choice, and the cron starts it that way', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const { stamp, channelId } = await publication(page, request, 'schedule');
  const reader = `reader-${stamp}@example.org`;
  await addReader(page, channelId, reader);

  await writePost(page, 'Scheduled best time issue');
  await chooseEveryone(page);
  const route = postSettings(page);
  await route.getByRole('radio', { name: 'Schedule' }).check();
  await route.getByRole('checkbox', { name: LABEL }).check();
  await expect(route.getByText(/Over the 24 hours from the time you chose/)).toBeVisible();
  const schedule = route.getByRole('button', { name: /^Schedule for / });
  await expect(schedule).toBeEnabled({ timeout: 15_000 });
  await schedule.click();
  await route.getByRole('button', { name: 'Confirm' }).click();
  const note = route.getByText('Each reader gets it at their best time, within 24 hours of then.');
  await expect(note).toBeVisible();

  // Unscheduling drops the choice with the time.
  await route.getByRole('button', { name: 'Unschedule' }).click();
  await expect(note).toBeHidden();
  const option = route.getByRole('checkbox', { name: LABEL });
  await expect(option).toBeVisible();

  // Scheduled again; the time comes.
  await route.getByRole('radio', { name: 'Schedule' }).check();
  await option.check();
  await route.getByRole('button', { name: /^Schedule for / }).click();
  await route.getByRole('button', { name: 'Confirm' }).click();
  await expect(note).toBeVisible();
  localSql(
    `UPDATE dispatches SET publish_at = ${Date.now() - 1000} WHERE channel_id = '${channelId}' AND status = 'scheduled'`,
  );
  await minuteCron(request);
  await expect.poll(() => mailCategory(request, reader), { timeout: 60_000 }).toBe('broadcast');
  const broadcasts = await page.evaluate(async (channelId) => {
    const res = await fetch(`/api/v1/channels/${channelId}/broadcasts`);
    return ((await res.json()) as { data: { bestTime: unknown }[] }).data;
  }, channelId);
  expect(broadcasts[0]?.bestTime).toMatchObject({ limitedByWarmUp: false });
});

test('the choice is hidden and refused while the feature is off', async ({ page, request }) => {
  test.setTimeout(120_000);
  const { stamp, channelId } = await publication(page, request, 'off', []);
  await addReader(page, channelId, `reader-${stamp}@example.org`);
  await writePost(page, 'No best time issue');
  await chooseEveryone(page);
  const route = postSettings(page);
  await expect(route.getByRole('button', { name: 'Send to 1 subscriber' })).toBeEnabled({
    timeout: 15_000,
  });
  await expect(route.getByRole('checkbox', { name: LABEL })).toBeHidden();
  const dispatchId = /\/dispatches\/(d[ip]_\w+)/.exec(page.url())![1]!;
  const refused = await page.evaluate(async (dispatchId) => {
    const res = await fetch(`/api/v1/dispatches/${dispatchId}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ bestTime: true }),
    });
    return {
      status: res.status,
      code: ((await res.json()) as { error: { code: string } }).error.code,
    };
  }, dispatchId);
  expect(refused).toEqual({ status: 404, code: 'feature_disabled' });
});

test('a split test rules the choice out, and says why', async ({ page, request }) => {
  test.setTimeout(120_000);
  const { stamp, channelId } = await publication(page, request, 'split', [
    'best_time_send',
    'split_tests',
  ]);
  await addReader(page, channelId, `reader-${stamp}@example.org`);
  await writePost(page, 'Split issue');
  const dispatchId = /\/dispatches\/(d[ip]_\w+)/.exec(page.url())![1]!;
  const saved = await page.evaluate(async (dispatchId) => {
    const res = await fetch(`/api/v1/dispatches/${dispatchId}/split-test`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        variable: 'subject',
        variants: [{}, { subject: 'Split issue B' }],
        testPercent: 50,
        metric: 'opens',
        windowMinutes: 60,
      }),
    });
    return res.status;
  }, dispatchId);
  expect(saved).toBe(200);
  await page.reload();
  await chooseEveryone(page);
  const route = postSettings(page);
  await expect(route.getByRole('checkbox', { name: LABEL })).toBeDisabled({ timeout: 15_000 });
  await expect(route.getByText(/can’t run with a split test or cohort sample/)).toBeVisible();
  await openStop(page, 'Check & send');
  await expectAccessible(page);
});
