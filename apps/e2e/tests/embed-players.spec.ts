// An embed's player on a website page, in a real browser where the CSP decides: nothing reaches the
// service before the click, the click loads the player, and a reader without JavaScript keeps a link.
// The services are faked with context.route, so nothing here talks to them.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { allowSiteCode, enableChannelFlag, signIn } from './helpers';

const SITE_PORT = 8792;
const MEDIA = `http://localhost:${SITE_PORT}`;
const DASHBOARD = 'http://localhost:5273';
const YOUTUBE = 'https://www.youtube-nocookie.com';
const VIMEO = 'https://player.vimeo.com';
const SPOTIFY = 'https://open.spotify.com';
const SPOTIFY_ID = '4iV5W9uYEdYUVa79Axb7Rh';
const PLAYER_PAGE = '<!doctype html><html lang="en"><title>Player</title><p>Fake player</p></html>';

async function api<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(`${DASHBOARD}${path}`, {
    method,
    headers: { origin: DASHBOARD, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { data }),
  });
  expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
  return ((await res.json()) as { data: T }).data;
}

const embed = (url: string) => ({ type: 'embed', attrs: { url } });
const doc = (...content: unknown[]) => ({ type: 'doc', content });
const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

/** Stand-ins for the players, and every address outside the site that anything asked for. */
async function fakeServices(context: BrowserContext, site: string): Promise<string[]> {
  const seen: string[] = [];
  await context.route(
    (url) => url.protocol === 'https:',
    (route) =>
      route.fulfill({ contentType: 'text/html', body: PLAYER_PAGE, headers: { 'x-fake': '1' } }),
  );
  context.on('request', (request) => {
    const { origin, protocol } = new URL(request.url());
    if (/^https?:$/.test(protocol) && origin !== site && origin !== MEDIA) {
      seen.push(request.url());
    }
  });
  return seen;
}

function watchCsp(page: Page): string[] {
  const blocked: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) blocked.push(m.text());
  });
  return blocked;
}

async function publish(page: Page, channelId: string, subject: string, content: unknown) {
  const dispatch = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/channels/${channelId}/dispatches`,
    {
      subject,
      content,
    },
  );
  const out = await api<{ webUrl: string }>(
    page,
    'POST',
    `/api/v1/dispatches/${dispatch.id}/publish-web`,
  );
  return new URL(out.webUrl).pathname;
}

async function setup(page: Page, request: Parameters<typeof signIn>[1], label: string) {
  const stamp = Date.now();
  const slug = `${label}-${stamp.toString(36)}`;
  await page.goto('/');
  await signIn(page, request, `${label}-${stamp}@example.com`);
  const me = await api<{ workspaces: { id: string }[] }>(page, 'GET', '/api/v1/auth/session');
  const channel = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/workspaces/${me.workspaces[0]!.id}/channels`,
    { name: 'Field Notes', slug },
  );
  return { channelId: channel.id, site: `http://${slug}.site.localhost:${SITE_PORT}` };
}

test('nothing loads before the click, the click loads the player, and it needs no pointer', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(180_000);
  const { channelId, site } = await setup(page, request, 'pl');
  const path = await publish(
    page,
    channelId,
    'Three players and a post',
    doc(
      para('Watch, then listen.'),
      embed('https://youtu.be/dQw4w9WgXcQ'),
      embed(`https://open.spotify.com/track/${SPOTIFY_ID}`),
      embed('https://x.com/fieldnotes/status/123'),
    ),
  );

  const context = await browser.newContext();
  const seen = await fakeServices(context, site);
  const reader = await context.newPage();
  const blocked = watchCsp(reader);
  const response = await reader.goto(`${site}${path}`, { waitUntil: 'networkidle' });

  // The policy names exactly this page's players, and the page has asked them for nothing.
  const csp = response!.headers()['content-security-policy']!;
  expect(/frame-src [^;]*/.exec(csp)?.[0]).toBe(`frame-src 'self' ${YOUTUBE} ${SPOTIFY}`);
  expect(seen).toEqual([]);
  expect(await reader.locator('iframe').count()).toBe(0);
  await expect(reader.getByText('This player loads from YouTube')).toBeVisible();
  await expect(reader.getByText('This player loads from Spotify')).toBeVisible();

  // X has no player: its link, and no button.
  await expect(reader.getByRole('link', { name: /Read the post on X/ })).toBeVisible();
  await expect(reader.getByRole('button', { name: /X player/ })).toHaveCount(0);

  // By keyboard: focus the real button and press Enter.
  const load = reader.getByRole('button', { name: 'Load the YouTube player' });
  await load.focus();
  await reader.keyboard.press('Enter');
  const frame = reader.locator(`iframe[title="YouTube player"]`);
  await expect(frame).toBeVisible();
  await expect(load).toHaveCount(0);
  await expect(frame).toBeFocused();
  await expect(
    reader.frameLocator('iframe[title="YouTube player"]').getByText('Fake player'),
  ).toBeVisible();
  expect(blocked, 'the CSP blocked the player').toEqual([]);
  expect(seen).toEqual([`${YOUTUBE}/embed/dQw4w9WgXcQ`]);

  // Exactly what the frame was given, and the other player is still untouched.
  expect(await frame.getAttribute('src')).toBe(`${YOUTUBE}/embed/dQw4w9WgXcQ`);
  expect(await frame.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
  const sandbox = (await frame.getAttribute('sandbox'))!;
  expect(sandbox).toContain('allow-scripts');
  expect(sandbox).not.toContain('allow-top-navigation');
  expect(await frame.getAttribute('allow')).not.toContain('camera');
  // Sized by the stylesheet: 16 by 9, and as wide as the card it sits on.
  const box = (await frame.boundingBox())!;
  expect(Math.abs(box.width / box.height - 16 / 9)).toBeLessThan(0.05);
  const card = (await reader.getByRole('link', { name: /Watch on YouTube/ }).boundingBox())!;
  expect(Math.abs(box.width - card.width)).toBeLessThanOrEqual(1);

  // Loading a player set no cookie of ours (the stand-in sets none either).
  expect((await context.cookies()).filter((c) => c.domain.includes('site.localhost'))).toEqual([]);

  // The same on the next visit, which may be a cached copy: its nonce and policy still work.
  seen.length = 0;
  const again = await reader.goto(`${site}${path}`, { waitUntil: 'networkidle' });
  expect(/frame-src [^;]*/.exec(again!.headers()['content-security-policy']!)?.[0]).toBe(
    `frame-src 'self' ${YOUTUBE} ${SPOTIFY}`,
  );
  expect(seen).toEqual([]);
  await reader.getByRole('button', { name: 'Load the Spotify player' }).click();
  await expect(
    reader.frameLocator('iframe[title="Spotify player"]').getByText('Fake player'),
  ).toBeVisible();
  expect(seen).toEqual([`${SPOTIFY}/embed/track/${SPOTIFY_ID}`]);
  expect(blocked).toEqual([]);

  // A page without an embed keeps the policy it always had.
  const plain = await reader.goto(`${site}/archive`);
  expect(/frame-src [^;]*/.exec(plain!.headers()['content-security-policy']!)?.[0]).toBe(
    "frame-src 'self'",
  );
  await context.close();
});

test('without JavaScript the link card works and no button shows', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(120_000);
  const { channelId, site } = await setup(page, request, 'pn');
  const path = await publish(
    page,
    channelId,
    'A video',
    doc(embed('https://youtu.be/dQw4w9WgXcQ')),
  );
  const context = await browser.newContext({ javaScriptEnabled: false });
  const seen = await fakeServices(context, site);
  const reader = await context.newPage();
  await reader.goto(`${site}${path}`, { waitUntil: 'networkidle' });
  const card = reader.getByRole('link', { name: /Watch on YouTube/ });
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('href', 'https://youtu.be/dQw4w9WgXcQ');
  await expect(reader.getByRole('button', { name: /YouTube player/ })).toHaveCount(0);
  await expect(reader.getByText('This player loads from YouTube')).toBeHidden();
  expect(seen).toEqual([]);
  await context.close();
});

test('a player from a linked snippet, with reduced motion and an owner’s code on the page', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(180_000);
  const { channelId, site } = await setup(page, request, 'ps');
  enableChannelFlag('snippets', channelId);
  enableChannelFlag('site_custom_code', channelId);
  allowSiteCode(channelId);
  const snippet = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/channels/${channelId}/snippets`,
    {
      name: 'Clip',
      content: doc(embed('https://vimeo.com/76979871')),
    },
  );
  const path = await publish(
    page,
    channelId,
    'From a snippet',
    doc(para('Watch.'), { type: 'snippet', attrs: { snippetId: snippet.id } }),
  );
  await api(page, 'PATCH', `/api/v1/channels/${channelId}/site/settings`, {
    consent: {
      enabled: true,
      text: 'We use cookies.',
      acceptLabel: 'Accept all',
      rejectLabel: 'Reject all',
      policyUrl: '',
      position: 'bottom',
    },
    code: [
      {
        name: 'Analytics',
        preset: 'google_analytics',
        category: 'analytics',
        value: 'G-TEST12345',
      },
    ],
  });

  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const seen = await fakeServices(context, site);
  const reader = await context.newPage();
  const blocked = watchCsp(reader);
  await reader.goto(`${site}${path}`, { waitUntil: 'networkidle' });
  expect(seen).toEqual([]);
  await expect(reader.getByText('This player loads from Vimeo')).toBeVisible();

  // Reject everything in the popup: the reader's own click still loads the one thing they asked for.
  await reader
    .getByRole('dialog', { name: 'Cookie choices' })
    .getByRole('button', { name: 'Reject all' })
    .click();
  expect(seen).toEqual([]);
  await reader.getByRole('button', { name: 'Load the Vimeo player' }).click();
  await expect(
    reader.frameLocator('iframe[title="Vimeo player"]').getByText('Fake player'),
  ).toBeVisible();
  expect(seen).toEqual([`${VIMEO}/video/76979871?dnt=1`]);
  expect(blocked).toEqual([]);
  await context.close();
});

test('every template shows the player', async ({ page, request, browser }) => {
  test.setTimeout(360_000);
  const { channelId, site } = await setup(page, request, 'pt');
  enableChannelFlag('site_templates', channelId);
  const path = await publish(
    page,
    channelId,
    'A video',
    doc(embed('https://youtu.be/dQw4w9WgXcQ')),
  );
  const context = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const seen = await fakeServices(context, site);
  for (const template of [
    'gate',
    'letter',
    'magazine',
    'newspaper',
    'launch',
    'night',
    'zine',
    'brief',
  ]) {
    await api(page, 'PATCH', `/api/v1/channels/${channelId}/site/settings`, {
      theme: { template },
    });
    seen.length = 0;
    const reader = await context.newPage();
    const blocked = watchCsp(reader);
    await reader.goto(`${site}${path}`, { waitUntil: 'networkidle' });
    // Every page of a site with a design says so on <html> (data-scheme t-light, t-dark or t-auto).
    await expect(reader.locator('html[data-scheme^="t-"]'), template).toHaveCount(1);
    expect(seen, template).toEqual([]);
    await reader.getByRole('button', { name: 'Load the YouTube player' }).click();
    await expect(
      reader.frameLocator('iframe[title="YouTube player"]').getByText('Fake player'),
      template,
    ).toBeVisible();
    // No wider than a phone's screen, whatever the template does to the column.
    const box = (await reader.locator('iframe[title="YouTube player"]').boundingBox())!;
    expect(box.x + box.width, template).toBeLessThanOrEqual(390);
    expect(blocked, template).toEqual([]);
    await reader.close();
  }
  await context.close();
});
