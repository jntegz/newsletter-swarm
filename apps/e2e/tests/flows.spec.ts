import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  API,
  createPublication,
  expectAccessible,
  expectPostSaved,
  newPost,
  openSection,
  postBody,
  signIn,
  turnOnTracking,
} from './helpers';

/** Adds an active Member through the API, as the signed-in operator in the page. */
async function addMember(page: Page, channelId: string, email: string) {
  const status = await page.evaluate(
    async ({ channelId, email }) => {
      const res = await fetch(`/api/v1/channels/${channelId}/members`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, consent: true }),
      });
      return res.status;
    },
    { channelId, email },
  );
  expect(status).toBe(201);
}

const saved = (page: Page) =>
  expect(page.getByRole('status').filter({ hasText: 'All changes saved' }).first()).toBeVisible({
    timeout: 15_000,
  });

test('an operator builds a Welcome Flow from the recipe, publishes it and test-runs it with a Member', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const owner = `flows-${stamp}@example.com`;
  const reader = `welcome-${stamp}@example.org`;

  await page.goto('/');
  await signIn(page, request, owner);
  await createPublication(page, 'Field Notes', `flows-${stamp.toString(36)}`);
  const channelId = /\/channels\/(ch_[0-9a-f]{32})/.exec(page.url())?.[1];
  expect(channelId).toBeTruthy();
  await addMember(page, channelId!, reader);

  // The empty list leads to the recipe gallery.
  await openSection(page, 'Automations');
  await expect(page.getByRole('heading', { name: 'No automations yet' })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'New automation' }).first().click();
  const create = page.getByRole('dialog', { name: 'New automation' });
  await expect(create.getByRole('radio', { name: /Welcome email/ })).toBeVisible();
  await expect(create.getByRole('radio', { name: /Win back/ })).toBeVisible();
  await create.getByRole('radio', { name: /Welcome email/ }).check();
  await expectAccessible(page);
  await create.getByRole('button', { name: 'Create automation' }).click();

  // The builder shows the recipe's graph: trigger → A/B split → two emails.
  await expect(page).toHaveURL(/\/flows\/fl_[0-9a-f]{32}/);
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome email' })).toBeVisible();
  const canvas = page.getByRole('application');
  await expect(canvas.getByRole('button', { name: /^Confirmed: Confirmed opt-in/ })).toBeVisible();
  await expect(canvas.getByRole('button', { name: /^A\/B test/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ready to publish' })).toBeVisible();
  await expectAccessible(page);

  // Add a delay after "Welcome A" (selected from the steps list, as a keyboard user would).
  const steps = page.getByRole('region', { name: 'Steps' });
  await steps.getByRole('button', { name: /^Welcome A/ }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Welcome A' })).toBeFocused();
  await page.getByRole('button', { name: 'Add Delay' }).click();
  const inspector = page.getByRole('region', { name: 'Delay' });
  await inspector.getByLabel('Amount').fill('3');
  await expect(canvas.getByRole('button', { name: /^Delay: Wait 3 days/ })).toBeVisible();
  await saved(page);

  // Then a branch after the delay: incomplete until it has a condition.
  await page.getByRole('button', { name: 'Add Branch' }).click();
  await expect(page.getByText('Add a condition to the branch.').first()).toBeVisible();
  const branch = page.getByRole('region', { name: 'Branch' });
  await branch.getByRole('button', { name: 'Add condition', exact: true }).click();
  await branch.getByLabel('Condition 1: field').selectOption('email');
  await branch.getByLabel('Condition 1: comparison').selectOption('contains');
  await branch.getByLabel('Condition 1: value').fill('example.org');
  await expect(page.getByRole('heading', { name: 'Ready to publish' })).toBeVisible();
  await saved(page);
  await expectAccessible(page);

  // Edit Welcome A in the Dispatch editor, then come back.
  await steps.getByRole('button', { name: /^Welcome A/ }).click();
  await page.getByRole('link', { name: 'Edit email' }).click();
  await expect(page.getByRole('complementary', { name: 'Automation email' })).toBeVisible();
  await page.getByLabel('Subject').fill('Welcome to Field Notes');
  await expectPostSaved(page);
  await page.getByRole('link', { name: 'Back to the automation' }).click();
  await expect(
    canvas.getByRole('button', { name: /^Welcome A: Welcome to Field Notes/ }),
  ).toBeVisible();
  // The delay and the branch were kept.
  await expect(canvas.getByRole('button', { name: /^Branch: If 1 condition match/ })).toBeVisible();

  // Publish version 1.
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const publish = page.getByRole('dialog', { name: 'Publish version 1?' });
  await expectAccessible(page);
  await publish.getByRole('button', { name: 'Publish version 1' }).click();
  const published = page.getByRole('dialog', { name: 'Version 1 is live' });
  await expect(published).toBeVisible({ timeout: 20_000 });
  await published.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('Live', { exact: true }).first()).toBeVisible();

  // Test run with the Member.
  await page.getByRole('button', { name: 'Test run' }).click();
  const testRun = page.getByRole('dialog', { name: 'Start a test run' });
  await testRun.getByLabel('Find a subscriber').fill(reader);
  await testRun.getByRole('radio', { name: new RegExp(reader) }).check();
  await expectAccessible(page);
  await testRun.getByRole('button', { name: `Start for ${reader}` }).click();
  const started = page.getByRole('dialog', { name: 'Test run started' });
  await expect(started).toBeVisible();
  await started.getByRole('button', { name: 'See runs' }).click();

  // The run is listed, and its detail opens in a drawer.
  await expect(page).toHaveURL(/tab=runs/);
  const row = page.getByRole('row', { name: new RegExp(reader) });
  await expect(row).toBeVisible();
  await expect(row.getByText('Test', { exact: true })).toBeVisible();
  await expectAccessible(page);
  await row.getByRole('button', { name: /View/ }).click();
  const drawer = page.getByRole('dialog', { name: `Run for ${reader}` });
  await expect(drawer.getByRole('heading', { name: 'Steps' })).toBeVisible();
  await expectAccessible(page);
  await drawer.getByRole('button', { name: 'Close' }).click();

  // Stats for version 1: the canvas overlay and the same numbers as tables.
  await page
    .getByRole('navigation', { name: 'Automation sections' })
    .getByRole('link', { name: 'Stats' })
    .click();
  await expect(page.getByLabel('Version')).toHaveValue('1');
  await expect(page.getByRole('table', { name: 'Steps' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Paths and drop-off' })).toBeVisible();
  await expect(page.getByRole('row', { name: /Welcome A/ }).first()).toBeVisible();
  await expectAccessible(page);

  // The Overview shows the live Flow with its progress meter.
  await openSection(page, 'Home');
  await expect(page.getByRole('meter', { name: /Welcome email/ })).toBeVisible();
});

// ---- A live Flow end to end ------------------------------------------------------------------

const DASHBOARD = 'http://localhost:5273';
const CAPTURE = 'http://localhost:8791';
const JOBS = 'http://localhost:8793';
const HOST = 'http://localhost:4597';
const DAY = 24 * 60 * 60 * 1000;
/** Local queues deliver in batches, a few seconds apart. */
const QUEUE = { timeout: 30_000 };

/** Dashboard API calls with the signed-in operator's session (the CSRF check wants Origin). */
async function api<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(`${DASHBOARD}${path}`, {
    method,
    headers: { origin: DASHBOARD, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { data }),
  });
  expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
  return ((await res.json()) as { data: T }).data;
}

/**
 * The jobs worker's development Flow clock: does the minute cron's Flows work (enrolment, waking
 * waits; wrangler dev runs no crons) and runs the Channel's steps due by `at` as of `at`.
 */
async function advanceFlows(request: APIRequestContext, channelId: string, at?: number) {
  const res = await request.post(`${JOBS}/__dev/flows/advance`, {
    data: { channelId, ...(at === undefined ? {} : { at }) },
  });
  expect(res.status(), await res.text()).toBe(200);
}

interface StoredMail {
  subject: string;
  html: string;
  text: string;
  category: string;
  sentAt: string;
}

async function latestMail(request: APIRequestContext, to: string): Promise<StoredMail | null> {
  const res = await request.get(`${API}/__dev/mail/latest.json?to=${encodeURIComponent(to)}`);
  if (res.status() !== 200) return null;
  return ((await res.json()) as { data: StoredMail }).data;
}

/** Waits until the newest mail to `to` has `subject`. */
async function mailWithSubject(request: APIRequestContext, to: string, subject: string) {
  await expect.poll(async () => (await latestMail(request, to))?.subject, QUEUE).toBe(subject);
  return (await latestMail(request, to))!;
}

const text = (value: string, href?: string) => ({
  type: 'text',
  text: value,
  ...(href ? { marks: [{ type: 'link', attrs: { href } }] } : {}),
});
const doc = (...paragraphs: ReturnType<typeof text>[][]) => ({
  type: 'doc',
  content: paragraphs.map((content) => ({ type: 'paragraph', content })),
});

test('a reader joins through a form, gets the Flow after its delay, clicks, and takes the clicked branch', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const reader = `flow-reader-${stamp}@example.org`;
  await page.goto('/');
  await signIn(page, request, `flow-story-${stamp}@example.com`);
  await expect(page.getByRole('link', { name: 'Create publication' })).toBeVisible();
  const me = await api<{ workspaces: { id: string }[] }>(page, 'GET', '/api/v1/auth/session');
  const { id: channelId } = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/workspaces/${me.workspaces[0]!.id}/channels`,
    { name: 'Field Notes', slug: `story-${stamp.toString(36)}` },
  );
  // A Flow waits on a click only with click tracking on, which a new publication starts without.
  await turnOnTracking(page, channelId, ['trackClicks']);

  // A Flow: confirmed → wait 2 days → "Start here" (one link) → wait up to 2 days for a click →
  // clicked: "Glad you found it"; no click: "In case you missed it".
  const flow = await api<{ id: string }>(page, 'POST', `/api/v1/channels/${channelId}/flows`, {
    name: 'Onboarding',
    trigger: { event: 'confirmed' },
  });
  const email = async (subject: string, ...paragraphs: ReturnType<typeof text>[][]) =>
    (
      await api<{ id: string }>(page, 'POST', `/api/v1/flows/${flow.id}/emails`, {
        subject,
        content: doc(...paragraphs),
      })
    ).id;
  const intro = await email('Start here', [
    text('Read '),
    text('the guide', 'https://guide.example/start'),
    text(' first.'),
  ]);
  const clicked = await email('Glad you found it', [text('Here is what comes next.')]);
  const nudge = await email('In case you missed it', [text('The guide is still there.')]);
  await api(page, 'PATCH', `/api/v1/flows/${flow.id}`, {
    draftGraph: {
      schema: 1,
      nodes: [
        { id: 'trigger', type: 'trigger', config: { event: 'confirmed' } },
        { id: 'delay', type: 'delay', config: { mode: 'duration', amount: 2, unit: 'days' } },
        { id: 'intro', type: 'send_email', config: { dispatchId: intro, audience: 'any' } },
        {
          id: 'wait',
          type: 'wait_for_event',
          config: { event: 'click', sendNodeId: 'intro', timeoutHours: 48 },
        },
        { id: 'clicked', type: 'send_email', config: { dispatchId: clicked, audience: 'any' } },
        { id: 'nudge', type: 'send_email', config: { dispatchId: nudge, audience: 'any' } },
      ],
      edges: [
        { from: 'trigger', to: 'delay', label: 'default' },
        { from: 'delay', to: 'intro', label: 'default' },
        { from: 'intro', to: 'wait', label: 'default' },
        { from: 'wait', to: 'clicked', label: 'default' },
        { from: 'wait', to: 'nudge', label: 'timeout' },
      ],
    },
  });
  await api(page, 'POST', `/api/v1/flows/${flow.id}/publish`, {});

  // A Capture Form on the reader's site.
  const form = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/channels/${channelId}/capture-forms`,
    {
      name: 'Story form',
      config: {
        fields: [{ key: 'email', label: 'Email', required: true }],
        consent: null,
        layout: 'regular',
        placement: 'inline',
        trigger: { type: 'immediate' },
        frequency: { type: 'every_visit' },
        success: { type: 'message', message: 'Check your inbox to confirm.' },
        doubleOptIn: null,
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
  await page.route(`${HOST}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="en"><head><title>Essay</title></head><body><main><h1>An essay</h1>${snippet.script}</main></body></html>`,
    }),
  );

  // The reader subscribes and confirms from the inbox.
  await page.goto(`${HOST}/`);
  const frame = page.frameLocator('iframe[title="Join Field Notes"]');
  await frame.getByLabel('Email').fill(reader);
  await frame.getByRole('button', { name: 'Join' }).click();
  await expect(frame.getByText('Check your inbox to confirm.')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await latestMail(request, reader))?.category).toBe('confirm');
  const confirm = (await latestMail(request, reader))!;
  await page.goto(/http:\/\/localhost:8791\/v1\/confirm\/\S+/.exec(confirm.text)![0]);
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('heading', { name: 'You are in' })).toBeVisible();
  expect(page.url().startsWith(CAPTURE)).toBe(true);

  // Enrolment: the run starts and parks on the two-day delay. Nothing is sent yet.
  await advanceFlows(request, channelId);
  type Run = { id: string; memberEmail: string; status: string; currentNodeId: string | null };
  const runOf = async () =>
    (await api<{ items: Run[] }>(page, 'GET', `/api/v1/flows/${flow.id}/runs`)).items.find(
      (r) => r.memberEmail === reader,
    );
  await expect
    .poll(async () => {
      const run = await runOf();
      return run ? `${run.status}:${run.currentNodeId}` : null;
    }, QUEUE)
    .toBe('waiting:delay');
  expect((await latestMail(request, reader))?.subject).not.toBe('Start here');

  // Two days later the first email arrives.
  await advanceFlows(request, channelId, Date.now() + 2 * DAY + 60_000);
  const first = await mailWithSubject(request, reader, 'Start here');
  const link = /href="(http:\/\/localhost:8790\/c\/[^"]+)"/.exec(first.html)?.[1];
  expect(link, 'a tracked link').toBeTruthy();
  await expect.poll(async () => (await runOf())?.currentNodeId, QUEUE).toBe('wait');

  // The reader clicks (people don't click within two seconds of delivery; scanners do).
  await page.waitForTimeout(2_500);
  // From the browser's context (its desktop Chrome user agent); the made-up target isn't fetched.
  const click = await page.request.get(link!.replaceAll('&amp;', '&'), { maxRedirects: 0 });
  expect(click.status()).toBe(302);
  expect(click.headers().location).toBe('https://guide.example/start');

  // The click wakes the wait: the clicked branch sends its email, the timeout branch never runs.
  await advanceFlows(request, channelId);
  await mailWithSubject(request, reader, 'Glad you found it');
  await expect.poll(async () => (await runOf())?.status, QUEUE).toBe('completed');
  const detail = await api<{ steps: { nodeId: string; status: string; outcome: string | null }[] }>(
    page,
    'GET',
    `/api/v1/flows/${flow.id}/runs/${(await runOf())!.id}`,
  );
  expect(detail.steps.map((s) => [s.nodeId, s.status, s.outcome])).toEqual([
    ['trigger', 'done', 'default'],
    ['delay', 'done', 'default'],
    ['intro', 'done', 'default'],
    ['wait', 'done', 'default'],
    ['clicked', 'done', 'default'],
  ]);

  // The operator sees the same path in the run drawer.
  await page.goto(`/flows/${flow.id}?tab=runs`);
  const row = page.getByRole('row', { name: new RegExp(reader) });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /View/ }).click();
  const drawer = page.getByRole('dialog', { name: `Run for ${reader}` });
  await expect(drawer.getByRole('heading', { name: 'Steps' })).toBeVisible();
  await expectAccessible(page);
});

test('a Dispatch is saved as a template and starts a new Dispatch', async ({ page, request }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const owner = `templates-${stamp}@example.com`;

  await page.goto('/');
  await signIn(page, request, owner);
  await createPublication(page, 'Template Notes', `tpl-${stamp.toString(36)}`);

  await openSection(page, 'Posts');
  await newPost(page);
  await page.getByLabel('Subject').fill('Monthly roundup');
  await postBody(page).click();
  await page.keyboard.type('Here is what happened this month.');
  await expectPostSaved(page);
  await page.getByRole('button', { name: 'Save as template' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save as template' });
  await expect(dialog.getByLabel('Template name')).toHaveValue('Monthly roundup');
  await expectAccessible(page);
  await dialog.getByRole('button', { name: 'Save template' }).click();
  await page
    .getByRole('dialog', { name: 'Saved as a template' })
    .getByRole('button', { name: 'Done' })
    .click();

  await openSection(page, 'Templates');
  const row = page.getByRole('row', { name: /Monthly roundup/ });
  await expect(row).toBeVisible();
  await expect(row.getByRole('link', { name: /Export HTML/ })).toHaveAttribute(
    'href',
    /\/api\/v1\/templates\/tp_[0-9a-f]{32}\/export/,
  );
  await expectAccessible(page);

  // Design templates are behind a flag that is off by default.
  await page.getByRole('button', { name: 'New design template' }).click();
  const design = page.getByRole('dialog', { name: 'New design template' });
  await design.getByLabel('Name').fill('House style');
  await design.getByRole('button', { name: 'Create' }).click();
  await expect(design.getByText('Design templates are not turned on')).toBeVisible();
  await design.getByRole('button', { name: 'Close' }).click();

  await row.getByRole('button', { name: /^Use/ }).click();
  await expect(page).toHaveURL(/\/dispatches\/dp_[0-9a-f]{32}/);
  await expect(page.getByLabel('Subject')).toHaveValue('Monthly roundup');
});
