// The click map on a send's report: the frozen email with clicks marked, in a sandboxed frame, with
// nothing in it that can register an open or a click. Most sends here are seeded so the numbers are
// exact; one goes through the real send, mail and track workers.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  API,
  PNG,
  createPublication,
  enableWorkspaceFlag,
  expectAccessible,
  localSql,
  signIn,
  turnOnTracking,
} from './helpers';

const hex = () => crypto.randomUUID().replace(/-/g, '');
const q = (value: string | null) => (value === null ? 'NULL' : `'${value.replace(/'/g, "''")}'`);
const SHOTS = process.env.CLICK_MAP_SHOTS;

async function publication(page: Page, request: APIRequestContext, name: string, flag = true) {
  const stamp = Date.now() * 10 + test.info().parallelIndex;
  await page.goto('/');
  await signIn(page, request, `click-map-${name}-${stamp}@example.com`);
  const workspaceId = await page.evaluate(async () => {
    const res = await fetch('/api/v1/auth/session', { credentials: 'same-origin' });
    return ((await res.json()) as { data: { workspaces: { id: string }[] } }).data.workspaces[0]!
      .id;
  });
  if (flag) enableWorkspaceFlag('click_map', workspaceId);
  await createPublication(page, 'Field Notes', `map-${name}-${stamp.toString(36)}`);
  return { channelId: /\/channels\/(ch_[0-9a-f]{32})/.exec(page.url())![1]!, workspaceId, stamp };
}

interface Seed {
  html: string;
  teaser?: string;
  status?: string;
  urls?: string[];
  /** Per reader: their clicks by link position, and which email they got. */
  readers?: { clicks: number[]; scannerClicks?: number[]; variant?: string; version?: string }[];
  versions?: { label: string; subject: string | null; html: string | null }[];
}

/** One SQL batch: a Broadcast with its link targets, recipients, deliveries and clicks. */
function seed(channelId: string, spec: Seed) {
  const at = Date.now() - 3_600_000;
  const dispatch = `di_${hex()}`;
  const broadcast = `bc_${hex()}`;
  const urls = spec.urls ?? ['https://example.com/one', 'https://example.com/two'];
  const links = urls.map(() => `lt_${hex()}`);
  const test_ = spec.versions ? `xt_${hex()}` : null;
  const versionIds = new Map((spec.versions ?? []).map((v) => [v.label, `xv_${hex()}`]));
  const sql = [
    `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at) VALUES (${q(dispatch)}, ${q(channelId)}, 'The field report', '{"type":"doc","content":[]}', 'sent', ${at}, ${at})`,
    `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text, teaser_html, teaser_text, from_name, from_address, track_opens, recipient_count, sent_count, created_at, last_progress_at) SELECT ${q(broadcast)}, ${q(dispatch)}, id, workspace_id, ${q(spec.status ?? 'sent')}, 'The field report', '', ${q(spec.html)}, '', ${q(spec.teaser ?? null)}, ${q(spec.teaser ?? null)}, 'Notes', 'n@example.com', 1, ${spec.readers?.length ?? 0}, ${spec.readers?.length ?? 0}, ${at}, ${at} FROM channels WHERE id = ${q(channelId)}`,
    ...links.map(
      (id, position) =>
        `INSERT INTO link_targets (id, broadcast_id, url, position) VALUES (${q(id)}, ${q(broadcast)}, ${q(urls[position]!)}, ${position})`,
    ),
  ];
  if (test_) {
    sql.push(
      `INSERT INTO split_tests (id, channel_id, dispatch_id, broadcast_id, variable, test_percent, metric, window_minutes, status, created_at, updated_at) VALUES (${q(test_)}, ${q(channelId)}, ${q(dispatch)}, ${q(broadcast)}, 'content', 50, 'clicks', 60, 'promoted', ${at}, ${at})`,
      `UPDATE broadcasts SET split_test_id = ${q(test_)} WHERE id = ${q(broadcast)}`,
    );
    for (const version of spec.versions ?? []) {
      sql.push(
        `INSERT INTO split_test_variants (id, split_test_id, label, subject, html, text, created_at) VALUES (${q(versionIds.get(version.label)!)}, ${q(test_)}, ${q(version.label)}, ${q(version.subject)}, ${q(version.html)}, '', ${at})`,
      );
    }
  }
  for (const reader of spec.readers ?? []) {
    const member = `me_${hex()}`;
    const delivery = `dl_${hex()}`;
    const email = `${member}@example.org`;
    sql.push(
      `INSERT INTO members (id, channel_id, email, status, created_at, updated_at) VALUES (${q(member)}, ${q(channelId)}, ${q(email)}, 'active', ${at}, ${at})`,
      `INSERT INTO broadcast_recipients (broadcast_id, member_id, email, status, variant, split_variant_id) VALUES (${q(broadcast)}, ${q(member)}, ${q(email)}, 'sent', ${q(reader.variant ?? 'full')}, ${q(reader.version ? versionIds.get(reader.version)! : null)})`,
      `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, status, sent_at, human_clicked_at) VALUES (${q(delivery)}, ${q(broadcast)}, ${q(channelId)}, ${q(member)}, ${q(email)}, 'delivered', ${at}, ${reader.clicks.length ? at : 'NULL'})`,
    );
    const addClick = (position: number, classification: string) =>
      sql.push(
        `INSERT INTO clicks (id, delivery_id, broadcast_id, link_target_id, classification, created_at) VALUES (${q(`ck_${hex()}`)}, ${q(delivery)}, ${q(broadcast)}, ${q(links[position]!)}, ${q(classification)}, ${at})`,
      );
    reader.clicks.forEach((position) => addClick(position, 'human'));
    reader.scannerClicks?.forEach((position) => addClick(position, 'scanner'));
  }
  localSql(sql.join('; '));
  return { broadcast };
}

const countable = (page: Page) => page.frameLocator('iframe[title*="click counts"]');
const row = (page: Page, number: number) =>
  page
    .getByRole('heading', { name: 'Links in this email' })
    .locator('..')
    .getByRole('listitem')
    .filter({ hasText: `#${number}` });

/** Fails on anything that would count as an open or a click, or leave for a hostile address. */
function watchRequests(page: Page) {
  const seen: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    const inFrame = req.frame() !== page.mainFrame();
    if (
      (inFrame && !url.startsWith('https://cdn.example.test/')) ||
      /:8790\b|evil\.|pixel\./.test(url)
    ) {
      seen.push(url);
    }
  });
  return seen;
}

const EMAIL = `<!doctype html><html><head><meta charset="utf-8"><title>x</title>
<meta http-equiv="refresh" content="0;url=https://evil.example/refresh"><base href="https://evil.example/">
<style>.note{font-style:italic}</style><style>@import url(https://evil.example/a.css);</style>
</head><body style="margin:0;background:#fbfbfd;font-family:Georgia,serif;color:#222">
<table role="presentation" width="100%"><tr><td style="padding:24px">
<h1 style="margin:0 0 12px">Field report</h1>
<p>Hi {{ first_name | friend }}, your address {{ email | is safe here }}.</p>
<p><a href="{{@link:0}}" style="color:#6c4cf1">Read the top story</a> from this month.</p>
<img src="https://cdn.example.test/photo.png" width="200" alt="The field at dawn">
<p class="note">And in the middle, <a href="{{@link:1}}" style="color:#6c4cf1">a smaller story</a>.</p>
<p><a href="{{@link:0}}" style="color:#6c4cf1">Read the top story again</a> at the end.</p>
<table><tr><td style="background:#6c4cf1;border-radius:999px"><a href="{{@link:2}}" style="display:inline-block;padding:12px 24px;color:#fff;text-decoration:none">A button nobody pressed</a></td></tr></table>
<div><a href="https://raw.example/hand-written">A link in raw HTML</a>
<img src="https://pixel.example.test/p.gif" width="1" height="1" alt="">
<script>document.title='ran'; fetch('https://evil.example/s')</script>
<img src=x onerror="fetch('https://evil.example/e')"><iframe src="https://evil.example/f"></iframe></div>
<p style="font-size:12px"><a href="{{@member_center}}">Manage your subscription</a> · <a href="{{@unsubscribe}}">Unsubscribe</a></p>
</td></tr></table>{{@pixel}}</body></html>`;

test('shows the sent email with human clicks on each link, and nothing in it can fire', async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const { channelId } = await publication(page, request, 'one');
  const { broadcast } = seed(channelId, {
    html: EMAIL,
    urls: ['https://example.com/one', 'https://example.com/two', 'https://example.com/three'],
    readers: [
      { clicks: [0, 0, 0, 1], scannerClicks: [2] },
      { clicks: [0] },
      { clicks: [0] },
      { clicks: [1] },
      { clicks: [] },
    ],
  });
  const images: string[] = [];
  await page.route('https://cdn.example.test/**', (route) => {
    images.push(route.request().url());
    return route.fulfill({ contentType: 'image/png', body: PNG });
  });
  const seen = watchRequests(page);
  await page.goto(`/broadcasts/${broadcast}`);
  await expect(page.getByRole('heading', { name: 'Click map' })).toBeVisible();

  const frame = page.locator('iframe[title*="click counts"]');
  await expect(frame).toHaveAttribute('sandbox', '');
  const doc = countable(page);

  // Five human clicks on the first link by three people; two on the second; a scanner on the third.
  await expect(doc.locator('[data-map-link="1"]').first()).toHaveText(
    '#1 · 3 people · 71% · shared count',
  );
  await expect(doc.locator('[data-map-link="1"]')).toHaveCount(2);
  await expect(doc.locator('[data-map-link="2"]')).toHaveText('#2 · 2 people · 29%');
  await expect(doc.locator('[data-map-link="3"]')).toHaveText('#3 · 0 people · 0%');
  await expect(doc.locator('[data-map-uncounted]')).toHaveCount(1);
  await expect(doc.getByText('Hi friend, your address is safe here.')).toBeVisible();
  await expect(doc.locator('script, iframe, base, meta[http-equiv="refresh"]')).toHaveCount(0);
  await expect(doc.locator('img')).toHaveCount(1);
  await expect.poll(() => images.length).toBeGreaterThan(0);

  const content = await frame.evaluate((node: HTMLIFrameElement) => node.srcdoc);
  expect(content).not.toMatch(/\{\{|evil\.|pixel\.|raw\.example|example\.com/);

  // The same numbers as a list, each with a real link to where it goes.
  await expect(page.getByText('4 people clicked, 7 clicks in all.')).toBeVisible();
  await expect(row(page, 1)).toContainText('3 people · 5 clicks · 71% of clicks');
  await expect(row(page, 1)).toContainText('Used in 2 places, with one count for all of them.');
  await expect(row(page, 1).getByRole('link')).toHaveAttribute('href', 'https://example.com/one');
  await expect(row(page, 2)).toContainText('2 people · 2 clicks · 29% of clicks');
  await expect(row(page, 3)).toContainText('0 people · 0 clicks · 0% of clicks');

  // The links table says the same thing.
  const table = page.getByRole('table');
  const tableRow = (url: string) => table.getByRole('row').filter({ hasText: url });
  await expect(tableRow('https://example.com/one').getByRole('cell').nth(1)).toHaveText('3');
  await expect(tableRow('https://example.com/one').getByRole('cell').nth(2)).toHaveText('5');
  await expect(tableRow('https://example.com/three').getByRole('cell').nth(2)).toHaveText('0');
  await expect(tableRow('https://example.com/three').getByRole('cell').nth(3)).toHaveText('1');

  await expect(page.getByText(/Links in raw HTML aren’t counted\. This email has 1/)).toBeVisible();
  await expect(page.getByText(/one count, so each place shows the same number/)).toBeVisible();

  // A click in the frame stays put, and nothing went to the track worker.
  const clickable = doc.getByRole('link', { name: 'Read the top story', exact: true });
  // Forced because they are announced as disabled, which Playwright would wait out. The mouse is real.
  await clickable.click({ force: true });
  await doc.getByRole('link', { name: 'A link in raw HTML' }).click({ force: true });
  await doc.getByRole('link', { name: 'Unsubscribe' }).click({ force: true });
  await expect(doc.getByRole('heading', { name: 'Field report' })).toBeVisible();
  const frames = page.frames().filter((f) => f !== page.mainFrame());
  expect(frames.map((f) => f.url())).toEqual(['about:srcdoc']);
  expect(seen).toEqual([]);

  await expectAccessible(page);
  if (SHOTS) {
    await page
      .locator('section', { hasText: 'Click map' })
      .last()
      .screenshot({
        path: `${SHOTS}/desktop.png`,
      });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('heading', { name: 'Click map' }).scrollIntoViewIfNeeded();
    await page
      .locator('section', { hasText: 'Click map' })
      .last()
      .screenshot({
        path: `${SHOTS}/phone.png`,
      });
  } else {
    await page.setViewportSize({ width: 390, height: 844 });
  }
  // On a phone nothing runs off the side of the page.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('gives each split test version and paid email its own map', async ({ page, request }) => {
  test.setTimeout(120_000);
  const { channelId } = await publication(page, request, 'versions');
  const { broadcast: split } = seed(channelId, {
    html: '<p><a href="{{@link:0}}">The A story</a></p>',
    versions: [
      { label: 'A', subject: null, html: null },
      {
        label: 'B',
        subject: 'A different subject',
        html: '<p><a href="{{@link:1}}">The B story</a></p>',
      },
    ],
    readers: [
      { clicks: [0, 0], version: 'A' },
      { clicks: [1], version: 'B' },
      { clicks: [1], version: 'B' },
    ],
  });
  await page.goto(`/broadcasts/${split}`);
  const versions = page.getByRole('tablist', { name: 'Version of the email' });
  await expect(versions.getByRole('tab')).toHaveText(['Version A', 'Version B']);
  await expect(countable(page).locator('[data-map-link="1"]')).toHaveText('#1 · 1 person · 100%');
  await expect(page.getByText('1 person clicked, 2 clicks in all.')).toBeVisible();
  await versions.getByRole('tab', { name: 'Version B' }).click();
  await expect(countable(page).getByRole('link', { name: 'The B story' })).toBeVisible();
  await expect(countable(page).locator('[data-map-link="1"]')).toHaveText('#1 · 2 people · 100%');
  await expect(page.getByText('Subject: A different subject')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/versions.png`, fullPage: true });

  const { broadcast: paid } = seed(channelId, {
    html: '<p><a href="{{@link:0}}">Shared</a> <a href="{{@link:1}}">Paid only</a></p>',
    teaser: '<p><a href="{{@link:0}}">Shared</a></p>',
    readers: [{ clicks: [0, 1] }, { clicks: [0], variant: 'teaser' }],
  });
  await page.goto(`/broadcasts/${paid}`);
  const tabs = page.getByRole('tablist', { name: 'Version of the email' });
  await expect(tabs.getByRole('tab')).toHaveText(['Full email', 'Teaser']);
  await expect(countable(page).locator('[data-map-link]')).toHaveCount(2);
  await tabs.getByRole('tab', { name: 'Teaser' }).click();
  await expect(countable(page).locator('[data-map-link]')).toHaveCount(1);
  await expect(countable(page).getByText('Paid only')).toHaveCount(0);
  await expect(countable(page).locator('[data-map-link="1"]')).toHaveText('#1 · 1 person · 100%');
});

test('says so with no clicks yet, while sending, and with no stored copy', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const { channelId } = await publication(page, request, 'empty');
  const { broadcast: sending } = seed(channelId, {
    html: '<a href="{{@link:0}}">One</a>',
    status: 'sending',
    urls: ['https://example.com/one'],
  });
  await page.goto(`/broadcasts/${sending}`);
  await expect(page.getByText(/Still sending, so these numbers keep changing/)).toBeVisible();
  await expect(
    page.getByText('No clicks yet. The numbers fill in here as people click.'),
  ).toBeVisible();
  await expect(countable(page).locator('[data-map-link="1"]')).toHaveText('#1 · 0 people · 0%');

  const { broadcast: old } = seed(channelId, {
    html: '',
    urls: ['https://example.com/old'],
    readers: [{ clicks: [0] }],
  });
  await page.goto(`/broadcasts/${old}`);
  await expect(page.getByText(/A copy of this email is no longer stored/)).toBeVisible();
  await expect(row(page, 1)).toContainText('1 person · 1 click · 100% of clicks');

  const { broadcast: none } = seed(channelId, { html: '<p>No links at all.</p>', urls: [] });
  await page.goto(`/broadcasts/${none}`);
  await expect(page.getByText('This email had no links to map.')).toBeVisible();
});

test('stays out of the report and the API while the flag is off', async ({ page, request }) => {
  test.setTimeout(90_000);
  const { channelId } = await publication(page, request, 'off', false);
  const { broadcast } = seed(channelId, { html: '<a href="{{@link:0}}">One</a>' });
  await page.goto(`/broadcasts/${broadcast}`);
  await expect(page.getByRole('heading', { name: 'Links' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Click map' })).toHaveCount(0);
  const status = await page.evaluate(
    async (id) => (await fetch(`/api/v1/broadcasts/${id}/click-map`)).status,
    broadcast,
  );
  expect(status).toBe(404);
});

test('counts a real click through the track worker, and viewing the map adds nothing', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const { channelId, stamp } = await publication(page, request, 'real');
  // A tracking link and an open pixel only with click and open tracking on; a new publication
  // starts with both off.
  await turnOnTracking(page, channelId, ['trackOpens', 'trackClicks']);
  const email = `reader-${stamp}@example.org`;
  const broadcast = await page.evaluate(
    async ({ channelId, email }) => {
      const post = async (path: string, body?: unknown) => {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body ?? {}),
        });
        if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
        return ((await res.json()) as { data: { id: string; broadcastId: string } }).data;
      };
      await post(`/api/v1/channels/${channelId}/members`, { email, consent: true });
      const dispatch = await post(`/api/v1/channels/${channelId}/dispatches`, {
        subject: 'A real send',
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Hello ' },
                {
                  type: 'text',
                  text: 'a real link',
                  marks: [{ type: 'link', attrs: { href: 'https://example.com/real' } }],
                },
              ],
            },
          ],
        },
      });
      return (await post(`/api/v1/dispatches/${dispatch.id}/send`)).broadcastId;
    },
    { channelId, email },
  );

  // The dev mailbox holds what the reader got: a tracking link and an open pixel.
  let html = '';
  await expect
    .poll(
      async () => {
        const res = await request.get(
          `${API}/__dev/mail/latest.json?to=${encodeURIComponent(email)}`,
        );
        if (res.status() !== 200) return false;
        html = ((await res.json()) as { data: { html: string } }).data.html;
        return html.includes('/c/');
      },
      { timeout: 60_000, intervals: [1000] },
    )
    .toBe(true);
  const tracking = /href="([^"]*\/c\/[^"]+)"/.exec(html)![1]!;
  const pixel = /src="([^"]*\/o\/[^"]+)"/.exec(html)?.[1];
  expect(pixel).toBeTruthy();

  const seen = watchRequests(page);
  await page.goto(`/broadcasts/${broadcast}`);
  const doc = countable(page);
  await expect(doc.locator('[data-map-link="1"]')).toHaveText('#1 · 0 people · 0%');
  const srcdoc = await page
    .locator('iframe[title*="click counts"]')
    .evaluate((node: HTMLIFrameElement) => node.srcdoc);
  expect(srcdoc).not.toContain('/c/');
  expect(srcdoc).not.toContain('/o/');

  // People don't click within two seconds of delivery, and a machine-looking request isn't a person.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const click = await request.get(tracking, {
    maxRedirects: 0,
    headers: {
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    },
  });
  expect(click.status()).toBe(302);
  await expect
    .poll(
      async () => {
        await page.reload();
        return doc.locator('[data-map-link="1"]').textContent({ timeout: 20_000 });
      },
      { timeout: 60_000, intervals: [2000] },
    )
    .toBe('#1 · 1 person · 100%');
  await expect(row(page, 1).getByRole('link')).toHaveAttribute('href', 'https://example.com/real');

  // Looking at the map opened nothing and clicked nothing else.
  expect(seen).toEqual([]);
  const stats = await page.evaluate(
    async (id) =>
      (
        (await (await fetch(`/api/v1/broadcasts/${id}/stats`)).json()) as {
          data: { uniqueOpens: number; links: { clicks: number; humanClicks: number }[] };
        }
      ).data,
    broadcast,
  );
  // The click itself counts as an open by a person; the page view doesn't add another.
  expect(stats.uniqueOpens).toBe(1);
  expect(stats.links[0]).toMatchObject({ clicks: 1, humanClicks: 1 });
});
