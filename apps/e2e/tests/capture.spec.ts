// Capture Forms end to end: the whole embed matrix (layouts × placements × triggers × frequency),
// frequency caps with and without localStorage, the origin allowlist, the no-JS fallback, and the
// subscribe → confirm → Circle → send story with attribution.
//
// Host pages are served by page.route on made-up localhost ports, so no extra server is needed.
// The capture worker runs on :8791 with Cloudflare's always-pass Turnstile test keys.
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import {
  FORM_LAYOUTS,
  FORM_PLACEMENTS,
  FormFrequencySchema,
  FormTriggerSchema,
} from '@swarm/domain';
import {
  API,
  createPublication,
  enableChannelFlag,
  expectPostSaved,
  newPost,
  openSection,
  openStop,
  postBody,
  postSettings,
  sendNow,
  signIn,
} from './helpers';

const CAPTURE = 'http://localhost:8791';
const DASHBOARD = 'http://localhost:5273';
const HOST = 'http://localhost:4599';
const FOREIGN = 'http://127.0.0.1:4598';

const TRIGGERS = [
  { type: 'immediate' },
  { type: 'delay', seconds: 1 },
  { type: 'scroll', percent: 50 },
  { type: 'element_visible', selector: '#end' },
  { type: 'click', selector: '.open-form' },
  { type: 'event', name: 'swarm:open' },
  { type: 'exit_intent' },
  { type: 'scroll_velocity' },
] as const;

const FREQUENCIES = [{ type: 'every_visit' }, { type: 'once_per_days', days: 7 }] as const;

type Trigger = (typeof TRIGGERS)[number];
type Layout = (typeof FORM_LAYOUTS)[number];
type Placement = (typeof FORM_PLACEMENTS)[number];

/** Layouts × placements × triggers × frequency: 2 × 6 × 8 × 2 = 192. */
const MATRIX = FORM_LAYOUTS.flatMap((layout) =>
  FORM_PLACEMENTS.flatMap((placement) =>
    TRIGGERS.flatMap((trigger) =>
      FREQUENCIES.map((frequency) => ({
        title: `${layout} × ${placement} × ${trigger.type} × ${frequency.type}`,
        layout,
        placement,
        trigger,
        frequency,
      })),
    ),
  ),
);

interface Snippet {
  script: string;
  noscript: string;
  attribution: string;
}

/** Dashboard API calls with the signed-in operator's session (the CSRF check wants Origin). */
async function api<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  // Each `wrangler dev` opens the same SQLite file, so a statement can fail when another worker
  // process is writing (SQLITE_BUSY, or "Failed to get session commit token"). Only local D1 does
  // this, and nothing here is what these tests check, so try again. A real 500 still fails.
  for (let attempt = 1; ; attempt++) {
    const res = await page.request.fetch(`${DASHBOARD}${path}`, {
      method,
      headers: { origin: DASHBOARD, 'content-type': 'application/json' },
      ...(data === undefined ? {} : { data }),
    });
    if (res.status() === 500 && attempt < 4) {
      await page.waitForTimeout(200 * attempt);
      continue;
    }
    expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
    return ((await res.json()) as { data: T }).data;
  }
}

let clients = 0;

/**
 * Sign-ups allow 10 per 10 minutes from one client IP, and locally every browser here is the same
 * client, kept across runs. Each test that submits a form comes from its own documentation address.
 */
async function ownClient(page: Page) {
  const ip = `203.0.113.${(process.pid + clients++ * 7 + Date.now()) % 250}`;
  await page.route(`${CAPTURE}/v1/*/subscribe`, (route) =>
    route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': ip } }),
  );
}

let channelId = '';
/** The operator's session, kept for later tests in this worker (each gets a fresh context). */
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];

async function setup(page: Page, request: APIRequestContext) {
  if (channelId) {
    await page.context().addCookies(cookies);
    return;
  }
  // Parallel workers reach this at the same moment. The worker's index keeps their operators apart:
  // with a shared address they read each other's single-use sign-in links.
  const stamp = `${Date.now().toString(36)}-${test.info().parallelIndex}`;
  await page.goto('/');
  await signIn(page, request, `capture-${stamp}@example.com`);
  const me = await api<{ workspaces: { id: string }[] }>(page, 'GET', '/api/v1/auth/session');
  const channel = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/workspaces/${me.workspaces[0]!.id}/channels`,
    { name: 'Field Notes', slug: `capture-${stamp}` },
  );
  channelId = channel.id;
  cookies = await page.context().cookies();
}

function config(overrides: Record<string, unknown>) {
  return {
    fields: [
      { key: 'email', label: 'Email', required: true },
      { key: 'first_name', label: 'First name', required: false },
    ],
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
    ...overrides,
  };
}

async function publishedForm(page: Page, overrides: Record<string, unknown>) {
  const form = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/channels/${channelId}/capture-forms`,
    { name: `Form ${Date.now()}`, config: config(overrides) },
  );
  await api(page, 'POST', `/api/v1/capture-forms/${form.id}/publish`);
  const snippet = await api<Snippet>(page, 'GET', `/api/v1/capture-forms/${form.id}/snippet`);
  return { id: form.id, snippet };
}

/** A tall host page with the embed, a click target and an element far down. */
async function host(page: Page, origin: string, snippet: Snippet, path = '/') {
  await page.route(`${origin}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="en"><head><title>Host</title></head><body>
<main><h1>An essay</h1><button class="open-form" type="button">Get updates</button>
<div style="height:3000px"></div><p id="end">The end.</p>${snippet.attribution}${snippet.script}</main>
</body></html>`,
    }),
  );
  await page.goto(`${origin}${path}`);
}

async function fire(page: Page, trigger: Trigger) {
  switch (trigger.type) {
    case 'delay':
      await page.waitForTimeout(1200);
      break;
    case 'scroll':
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      break;
    case 'element_visible':
      await page.locator('#end').scrollIntoViewIfNeeded();
      break;
    case 'click':
      await page.getByRole('button', { name: 'Get updates' }).click();
      break;
    case 'event':
      await page.evaluate(() => window.dispatchEvent(new Event('swarm:open')));
      break;
    case 'exit_intent':
      await page.evaluate(() =>
        document.dispatchEvent(
          new MouseEvent('mouseout', { clientY: 0, relatedTarget: null, bubbles: true }),
        ),
      );
      break;
    case 'scroll_velocity':
      // Scroll events fire once a frame, so positions set between two frames collapse into one
      // event and the loader never sees the reader go down. Fixed sleeps lost that race on a busy
      // machine; waiting for each event doesn't.
      await page.evaluate(async () => {
        const to = async (y: number) => {
          const next = new Promise((resolve) =>
            window.addEventListener('scroll', resolve, { once: true }),
          );
          window.scrollTo(0, y);
          await next;
        };
        if (window.pageYOffset === 2000) await to(1990);
        await to(2000);
        await to(0);
      });
      break;
    default:
      break;
  }
}

const frameOf = (page: Page) => page.frameLocator('iframe[title="Join Field Notes"]');

/** Where the form must sit, for one placement and layout, in a 1280 × 720 viewport. */
async function expectPlaced(page: Page, placement: Placement, layout: Layout) {
  const wrap = page.locator('[data-swarm-capture]');
  const box = (await wrap.boundingBox())!;
  const { width: vw, height: vh } = page.viewportSize()!;
  const near = (actual: number, wanted: number) =>
    expect(Math.abs(actual - wanted)).toBeLessThan(2);
  const position = await wrap.evaluate((node) => getComputedStyle(node).position);
  switch (placement) {
    case 'inline':
      expect(position).toBe('static');
      // In the page, straight after the script tag, at the layout's own width.
      expect(await wrap.evaluate((node) => node.previousElementSibling?.tagName)).toBe('SCRIPT');
      near(box.width, layout === 'slim' ? 720 : 480);
      return;
    case 'popup': {
      expect(position).toBe('fixed');
      await expect(wrap).toHaveAttribute('role', 'dialog');
      await expect(wrap).toHaveAttribute('aria-modal', 'true');
      near(box.x, 0);
      near(box.y, 0);
      near(box.width, vw);
      near(box.height, vh);
      const card = (await wrap.locator('> div').boundingBox())!;
      near(card.width, layout === 'slim' ? 560 : 440);
      near(card.x + card.width / 2, vw / 2);
      return;
    }
    case 'slide_in_left':
      expect(position).toBe('fixed');
      near(box.x, 16);
      near(box.y + box.height, vh - 16);
      near(box.width, 380);
      return;
    case 'slide_in_right':
      expect(position).toBe('fixed');
      near(box.x + box.width, vw - 16);
      near(box.y + box.height, vh - 16);
      near(box.width, 380);
      return;
    case 'sticky_top':
      expect(position).toBe('fixed');
      near(box.x, 0);
      near(box.y, 0);
      near(box.width, vw);
      return;
    case 'sticky_bottom':
      expect(position).toBe('fixed');
      near(box.x, 0);
      near(box.y + box.height, vh);
      near(box.width, vw);
      return;
  }
}

/** Regular shows the heading and body text; Slim is only the fields and the button. */
async function expectLayout(page: Page, layout: Layout) {
  const frame = frameOf(page);
  const heading = frame.getByRole('heading', { name: 'Join Field Notes' });
  const body = frame.getByText('One email a week.');
  await expect(frame.locator('body')).toHaveClass(new RegExp(`\\b${layout}\\b`));
  if (layout === 'regular') {
    await expect(heading).toBeVisible();
    await expect(body).toBeVisible();
  } else {
    await expect(heading).toHaveCount(0);
    await expect(body).toHaveCount(0);
  }
}

test.describe('embed matrix', () => {
  test('the matrix is the whole spec', () => {
    expect(MATRIX).toHaveLength(192);
    expect(new Set(MATRIX.map((c) => c.title)).size).toBe(192);
    // A layout, placement, trigger or frequency added to the schema has to join the matrix.
    expect(FORM_LAYOUTS.length * FORM_PLACEMENTS.length).toBe(12);
    expect(TRIGGERS.map((t) => t.type).sort()).toEqual(
      FormTriggerSchema.options.map((o) => o.shape.type.value).sort(),
    );
    expect(FREQUENCIES.map((f) => f.type).sort()).toEqual(
      FormFrequencySchema.options.map((o) => o.shape.type.value).sort(),
    );
  });

  // Every combination the builder can produce, each in a real browser on a static host page:
  // nothing before its trigger, then the right layout in the right place, then what the frequency
  // rule says on the next visit.
  for (const { title, layout, placement, trigger, frequency } of MATRIX) {
    test(title, async ({ page, request }) => {
      await setup(page, request);
      const { snippet } = await publishedForm(page, { placement, trigger, layout, frequency });
      await host(page, HOST, snippet);
      const iframe = page.locator('iframe[title="Join Field Notes"]');
      const join = frameOf(page).getByRole('button', { name: 'Join' });

      // First visit: nothing until the trigger fires.
      if (trigger.type !== 'immediate') {
        await page.waitForTimeout(300);
        await expect(iframe).toHaveCount(0);
      }
      await fire(page, trigger);
      await expect(iframe).toBeVisible();
      await expect(join).toBeVisible();
      await expectLayout(page, layout);
      await expectPlaced(page, placement, layout);
      if (placement !== 'inline') {
        await expect(join).toBeInViewport();
        await page.getByRole('button', { name: 'Close' }).click();
        await expect(iframe).toHaveCount(0);
      }

      // Next visit: the frequency rule decides, with the trigger fired again.
      await page.reload();
      await fire(page, trigger);
      if (frequency.type === 'every_visit') {
        await expect(iframe).toBeVisible();
        await expect(join).toBeVisible();
      } else {
        await page.waitForTimeout(500);
        await expect(iframe).toHaveCount(0);
      }
    });
  }
});

test.describe('frequency', () => {
  test.beforeEach(async ({ page, request }) => setup(page, request));

  test('once per 7 days shows once, every visit shows every time', async ({ page }) => {
    const once = await publishedForm(page, {
      placement: 'popup',
      frequency: { type: 'once_per_days', days: 7 },
    });
    await host(page, HOST, once.snippet, '/once');
    await expect(page.locator('iframe')).toBeVisible();
    await page.reload();
    await page.waitForTimeout(800);
    await expect(page.locator('iframe')).toHaveCount(0);

    const every = await publishedForm(page, { placement: 'popup' });
    await host(page, HOST, every.snippet, '/every');
    await expect(page.locator('iframe')).toBeVisible();
    await page.reload();
    await expect(page.locator('iframe')).toBeVisible();
  });

  test('once per 7 days comes back after the 7 days, not before', async ({ page }) => {
    const once = await publishedForm(page, {
      placement: 'popup',
      frequency: { type: 'once_per_days', days: 7 },
    });
    await host(page, HOST, once.snippet, '/window');
    await expect(page.locator('iframe')).toBeVisible();
    const seenDaysAgo = (days: number, id: string) =>
      page.evaluate(
        ([key, at]) => window.localStorage.setItem(key as string, String(at)),
        [`swarm:cf:${id}:seen`, Date.now() - days * 86_400_000],
      );
    await seenDaysAgo(6, once.id);
    await page.reload();
    await page.waitForTimeout(800);
    await expect(page.locator('iframe')).toHaveCount(0);
    await seenDaysAgo(8, once.id);
    await page.reload();
    await expect(page.locator('iframe')).toBeVisible();
  });

  test('falls back to a session-only rule when localStorage throws', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('blocked', 'SecurityError');
        },
      });
    });
    const once = await publishedForm(page, {
      placement: 'slide_in_right',
      frequency: { type: 'once_per_days', days: 30 },
    });
    await host(page, HOST, once.snippet, '/no-storage');
    await expect(page.locator('iframe')).toBeVisible();
    await page.reload();
    await page.waitForTimeout(800);
    await expect(page.locator('iframe')).toHaveCount(0);
  });
});

test.describe('form frame', () => {
  test.beforeEach(async ({ page, request }) => setup(page, request));

  test('shows the form while Turnstile is still loading', async ({ page }) => {
    // Cloudflare's script never answers. The frame's load event must not wait for it.
    await page.route('https://challenges.cloudflare.com/**', () => undefined);
    const { snippet } = await publishedForm(page, {});
    await host(page, HOST, snippet);
    await expect(frameOf(page).getByRole('button', { name: 'Join' })).toBeVisible();
    await expect(frameOf(page).getByLabel('Email')).toBeEditable();
  });

  test('the embed sends the ?ref= of the page it is on, and it is recorded', async ({ page }) => {
    const referrer = await api<{ id: string }>(
      page,
      'POST',
      `/api/v1/channels/${channelId}/members`,
      { email: `champion-${Date.now()}@example.org`, consent: true },
    );
    await ownClient(page);
    const { snippet } = await publishedForm(page, {
      success: { type: 'message', message: 'Thanks, look for a note from Ada.' },
    });
    await host(page, HOST, snippet, `/landing?ref=${referrer.id}`);
    const email = `friend-${Date.now()}@example.org`;
    await frameOf(page).getByLabel('Email').fill(email);
    await frameOf(page).getByRole('button', { name: 'Join' }).click();
    await expect(frameOf(page).getByText('Thanks, look for a note from Ada.')).toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(async () => {
        const pending = await api<{ items: { id: string; email: string }[] }>(
          page,
          'GET',
          `/api/v1/channels/${channelId}/members?status=pending`,
        );
        const joined = pending.items.find((m) => m.email === email);
        if (!joined) return null;
        return (
          await api<{ source: { ref?: string } }>(page, 'GET', `/api/v1/members/${joined.id}`)
        ).source.ref;
      })
      .toBe(referrer.id);
  });
});

test.describe('origin allowlist', () => {
  test.beforeEach(async ({ page, request }) => setup(page, request));

  test('a foreign site can load the script but never shows the form', async ({ page }) => {
    const { snippet } = await publishedForm(page, {});
    await host(page, FOREIGN, snippet);
    // frame-ancestors refuses the frame, so it never renders the form.
    await page.waitForTimeout(1500);
    await expect(frameOf(page).getByRole('button', { name: 'Join' })).toHaveCount(0);
  });

  test('the allowed site shows it', async ({ page }) => {
    const { snippet } = await publishedForm(page, {});
    await host(page, HOST, snippet);
    await expect(frameOf(page).getByRole('button', { name: 'Join' })).toBeVisible();
  });
});

test.describe('no-JS fallback', () => {
  test.beforeEach(async ({ page, request }) => setup(page, request));

  test('the plain form joins with JavaScript off, and with it on', async ({ page, browser }) => {
    const { snippet } = await publishedForm(page, {});
    const html = `<!doctype html><html lang="en"><head><title>Host</title></head><body><main>${snippet.noscript}</main></body></html>`;

    const off = await browser.newContext({ javaScriptEnabled: false });
    const plain = await off.newPage();
    await ownClient(plain);
    await ownClient(page);
    await plain.route(`${HOST}/**`, (route) =>
      route.fulfill({ contentType: 'text/html', body: html }),
    );
    await plain.goto(`${HOST}/plain`);
    const nojs = `nojs-${Date.now()}@example.org`;
    await plain.getByLabel('Email').fill(nojs);
    await plain.getByRole('button', { name: 'Join' }).click();
    // Turnstile needs JavaScript, so this browser is asked a question instead.
    await expect(plain.getByRole('heading', { name: 'One more step' })).toBeVisible();
    await expect(plain.getByRole('button', { name: 'Continue' })).toBeHidden();
    const words = ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
    const question = plain.getByLabel(/^What is /);
    const label = await plain.locator('label', { has: question }).innerText();
    const [a, b] = /What is (\w+) plus (\w+)\?/.exec(label)!.slice(1);
    await question.fill(String(words.indexOf(a!) + 2 + words.indexOf(b!) + 2));
    await plain.getByRole('button', { name: 'Join' }).click();
    await expect(plain.getByText('Check your inbox to confirm.')).toBeVisible();
    await off.close();
    // In, and waiting for the address to confirm.
    await expect
      .poll(
        async () =>
          (
            await api<{ items: { email: string }[] }>(
              page,
              'GET',
              `/api/v1/channels/${channelId}/members?status=pending`,
            )
          ).items.map((m) => m.email),
        { timeout: 15_000 },
      )
      .toContain(nojs);

    // A browser that blocks only the embed (but runs JavaScript) passes the challenge and joins.
    await page.route(`${HOST}/**`, (route) =>
      route.fulfill({ contentType: 'text/html', body: html }),
    );
    await page.goto(`${HOST}/plain`);
    await page.getByLabel('Email').fill(`plain-${Date.now()}@example.org`);
    await page.getByRole('button', { name: 'Join' }).click();
    await expect(page.getByRole('heading', { name: 'One more step' })).toBeVisible();
    // Cloudflare's always-pass test keys fill the token in the widget. Continue is clickable before
    // that, and a post without the token only brings the challenge back.
    await expect(page.locator('input[name="cf-turnstile-response"]')).toHaveValue(/.+/, {
      timeout: 30_000,
    });
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Check your inbox to confirm.')).toBeVisible();
  });
});

test.describe('subscribe and confirm', () => {
  test.beforeEach(async ({ page, request }) => setup(page, request));

  test('a visitor joins from an embedded form, confirms from the inbox and keeps their UTMs', async ({
    page,
    request,
  }) => {
    await ownClient(page);
    const email = `joiner-${Date.now()}@example.org`;
    // UTMs are stored only with this flag on (workers/capture/src/routes/subscribe.ts). Nothing in
    // this worker has submitted with attribution yet, so the capture worker hasn't cached it.
    enableChannelFlag('subscribe_attribution_fields', channelId);
    const { id } = await publishedForm(page, {});
    const snippet = await api<Snippet>(page, 'GET', `/api/v1/capture-forms/${id}/snippet`);
    await host(page, HOST, snippet, '/landing?utm_source=e2e&utm_medium=test');

    const frame = frameOf(page);
    await frame.getByLabel('Email').fill(email);
    await frame.getByLabel('First name').fill('Ada');
    await frame.getByRole('button', { name: 'Join' }).click();
    await expect(frame.getByText('Check your inbox to confirm.')).toBeVisible({ timeout: 30_000 });

    // The confirmation, from the dev mailbox, carries one-click List-Unsubscribe.
    let mail: { text: string; category: string; headers: Record<string, string> } | null = null;
    await expect
      .poll(
        async () => {
          const res = await request.get(
            `${API}/__dev/mail/latest.json?to=${encodeURIComponent(email)}`,
          );
          if (res.status() !== 200) return null;
          mail = ((await res.json()) as { data: NonNullable<typeof mail> }).data;
          return mail.category;
        },
        { timeout: 30_000 },
      )
      .toBe('confirm');
    expect(mail!.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const link = /http:\/\/localhost:8791\/v1\/confirm\/\S+/.exec(mail!.text)![0];

    // Opening the link changes nothing until the button is pressed.
    await page.goto(link);
    const pending = await api<{ items: { id: string; email: string }[] }>(
      page,
      'GET',
      `/api/v1/channels/${channelId}/members?status=pending`,
    );
    const memberId = pending.items.find((m) => m.email === email)!.id;
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('heading', { name: 'You are in' })).toBeVisible();

    const active = await api<{ items: { email: string }[] }>(
      page,
      'GET',
      `/api/v1/channels/${channelId}/members?status=active`,
    );
    expect(active.items.map((m) => m.email)).toContain(email);
    const detail = await api<{ source: Record<string, string>; formId: string }>(
      page,
      'GET',
      `/api/v1/members/${memberId}`,
    );
    expect(detail.formId).toBe(id);
    expect(detail.source).toMatchObject({ utm_source: 'e2e', utm_medium: 'test' });

    // The Member Center link on the confirmation page works.
    await page.getByRole('link', { name: 'Manage your subscription' }).click();
    await expect(page.getByRole('heading', { name: 'Subscriber settings' })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`^${CAPTURE}/m/`));
  });
});

test('the whole story: a form on a page, a confirmed joiner with UTMs, a Circle, a send to it only', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const stamp = Date.now().toString(36);
  const campaign = `story-${stamp}`;
  const joiners = [`story-a-${stamp}@example.org`, `story-b-${stamp}@example.org`];
  const outsider = `outsider-${stamp}@example.org`;

  await ownClient(page);
  await page.goto('/');
  await signIn(page, request, `story-${stamp}@example.com`);
  await createPublication(page, 'Field Notes', `story-${stamp}`);
  const id = /\/channels\/(ch_[0-9a-f]{32})/.exec(page.url())![1]!;
  enableChannelFlag('subscribe_attribution_fields', id);
  await api(page, 'POST', `/api/v1/channels/${id}/members`, { email: outsider, consent: true });

  // Create a form and put it on a page.
  const form = await api<{ id: string }>(page, 'POST', `/api/v1/channels/${id}/capture-forms`, {
    name: 'Story form',
    config: config({}),
  });
  await api(page, 'POST', `/api/v1/capture-forms/${form.id}/publish`);
  const snippet = await api<Snippet>(page, 'GET', `/api/v1/capture-forms/${form.id}/snippet`);

  for (const email of joiners) {
    // Subscribe on the host page.
    await host(page, HOST, snippet, `/landing?utm_source=${campaign}&utm_medium=test`);
    const frame = frameOf(page);
    await frame.getByLabel('Email').fill(email);
    await frame.getByRole('button', { name: 'Join' }).click();
    await expect(frame.getByText('Check your inbox to confirm.')).toBeVisible({ timeout: 30_000 });

    // Confirm by clicking through the dev mail viewer.
    await expect
      .poll(
        async () => {
          await page.goto(`${API}/__dev/mail`);
          return page.locator('li', { hasText: email }).count();
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
    await page.locator('li', { hasText: email }).first().getByRole('link').click();
    await page.getByRole('link', { name: /\/v1\/confirm\// }).click();
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('heading', { name: 'You are in' })).toBeVisible();
  }

  // The Member is there, active, with the UTMs and the form.
  const active = await api<{ items: { id: string; email: string }[] }>(
    page,
    'GET',
    `/api/v1/channels/${id}/members?status=active`,
  );
  const joined = active.items.find((m) => m.email === joiners[0])!;
  const detail = await api<{ source: Record<string, string>; formId: string }>(
    page,
    'GET',
    `/api/v1/members/${joined.id}`,
  );
  expect(detail.formId).toBe(form.id);
  expect(detail.source).toMatchObject({ utm_source: campaign, utm_medium: 'test' });

  // Put them in a Circle by those UTMs.
  const circle = await api<{ id: string }>(page, 'POST', `/api/v1/channels/${id}/circles`, {
    name: 'From the story page',
    rule: { field: 'source.utm_source', cmp: 'eq', value: campaign },
  });
  await expect
    .poll(
      async () => {
        const row = await api<{ status: string; memberCount: number }>(
          page,
          'GET',
          `/api/v1/circles/${circle.id}`,
        );
        return `${row.status} ${row.memberCount}`;
      },
      { timeout: 60_000 },
    )
    .toBe('ready 2');

  // Send to that Circle only.
  await page.goto('/');
  await openSection(page, 'Posts');
  await newPost(page);
  await page.getByLabel('Subject').fill('For the story readers');
  await postBody(page).click();
  await page.keyboard.type('Thanks for joining from that page.');
  await expectPostSaved(page);
  await openStop(page, 'Who gets it');
  const audience = postSettings(page);
  await audience.getByRole('radio', { name: 'Only some segments' }).check();
  await audience
    .getByRole('group', { name: 'Segments to send to' })
    .getByRole('checkbox', { name: /From the story page/ })
    .check();
  await audience.getByRole('button', { name: 'Continue to Check & send' }).click();
  await sendNow(page, 2);
  await expect(page).toHaveURL(/\/broadcasts\/bc_/);
  await expect(page.getByText('Sent', { exact: true })).toBeVisible({ timeout: 60_000 });

  const latestCategory = async (email: string) => {
    const res = await request.get(`${API}/__dev/mail/latest.json?to=${encodeURIComponent(email)}`);
    if (res.status() !== 200) return null;
    return ((await res.json()) as { data: { category: string } }).data.category;
  };
  for (const email of joiners) {
    await expect.poll(() => latestCategory(email), { timeout: 30_000 }).toBe('broadcast');
  }
  expect(await latestCategory(outsider)).not.toBe('broadcast');
});
