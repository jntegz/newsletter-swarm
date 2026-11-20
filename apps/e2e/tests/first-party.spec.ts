// Exit gate: a Channel website and the Capture Form embed make no third-party requests. Every
// request a page makes (documents, styles, images, scripts, frames, form posts) is recorded, and
// any origin outside the site's own and the documented first-party origins fails the test:
// - the site itself (<slug>.site.localhost) and public media (MEDIA_ORIGIN, the site worker);
// - the capture worker (CAPTURE_ORIGIN): the embed script, its frame and subscribe posts;
// - Turnstile (challenges.cloudflare.com), inside the Capture Form frame only, as
//   docs/security.md describes. Site pages themselves load nothing from it.
import { expect, test, type Page, type Request } from '@playwright/test';
import { PNG, signIn } from './helpers';

const SITE_PORT = 8792;
const MEDIA = 'http://localhost:8792';
const CAPTURE = 'http://localhost:8791';
const DASHBOARD = 'http://localhost:5273';
const TURNSTILE = 'https://challenges.cloudflare.com';
/** A made-up host page for the embed, served by page.route. */
const HOST = 'http://localhost:4597';

const siteOrigin = (slug: string) => `http://${slug}.site.localhost:${SITE_PORT}`;

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
 * Every http(s) origin the page asks for until `stop()`, frames and subresources included
 * (Playwright reports requests from every frame on the page).
 */
function recordOrigins(page: Page): { seen: Set<string>; stop: () => void } {
  const seen = new Set<string>();
  const onRequest = (request: Request) => {
    const url = new URL(request.url());
    if (url.protocol === 'http:' || url.protocol === 'https:') seen.add(url.origin);
  };
  page.on('request', onRequest);
  return { seen, stop: () => page.off('request', onRequest) };
}

const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

interface Setup {
  slug: string;
  dispatchPath: string;
  snippet: { script: string; attribution: string };
}

async function setup(page: Page, request: Parameters<typeof signIn>[1]): Promise<Setup> {
  const stamp = Date.now();
  const slug = `fp-${stamp.toString(36)}`;
  await page.goto('/');
  await signIn(page, request, `first-party-${stamp}@example.com`);
  const me = await api<{ workspaces: { id: string }[] }>(page, 'GET', '/api/v1/auth/session');
  const channel = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/workspaces/${me.workspaces[0]!.id}/channels`,
    { name: 'Field Notes', slug },
  );

  // An image in the Dispatch, so media, OG and favicon URLs are on the pages too.
  const upload = await page.request.fetch(`${DASHBOARD}/api/v1/channels/${channel.id}/media`, {
    method: 'POST',
    headers: { origin: DASHBOARD },
    multipart: { file: { name: 'fox.png', mimeType: 'image/png', buffer: PNG }, alt: 'A fox' },
  });
  expect(upload.ok(), await upload.text()).toBe(true);
  const media = ((await upload.json()) as { data: { id: string } }).data;

  const dispatch = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/channels/${channel.id}/dispatches`,
    {
      subject: 'Low tide notes',
      content: {
        type: 'doc',
        content: [
          { type: 'image', attrs: { mediaId: media.id, alt: 'A fox' } },
          p('The tide is out and the harbour is quiet.'),
        ],
      },
    },
  );
  const published = await api<{ webUrl: string | null }>(
    page,
    'POST',
    `/api/v1/dispatches/${dispatch.id}/publish-web`,
  );
  expect(published.webUrl).toBeTruthy();

  const form = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/channels/${channel.id}/capture-forms`,
    {
      name: 'First-party check',
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
  const snippet = await api<Setup['snippet']>(
    page,
    'GET',
    `/api/v1/capture-forms/${form.id}/snippet`,
  );
  return { slug, dispatchPath: new URL(published.webUrl!).pathname, snippet };
}

test('site pages and the Capture Form embed make no third-party requests', async ({
  page,
  request,
}) => {
  const { slug, dispatchPath, snippet } = await setup(page, request);
  const site = siteOrigin(slug);

  // Site pages: only the site and its public media.
  const paths = ['/', '/archive', dispatchPath, '/about', '/search?q=tide', '/links'];
  for (const path of paths) {
    const record = recordOrigins(page);
    await page.goto(`${site}${path}`, { waitUntil: 'networkidle' });
    await expect(page.locator('main#main')).toBeVisible();
    record.stop();
    const foreign = [...record.seen].filter((origin) => origin !== site && origin !== MEDIA);
    expect(foreign, `third-party requests on ${path}`).toEqual([]);
  }

  // The embed on a host page: the host, the capture worker and Turnstile inside the frame.
  await page.route(`${HOST}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="en"><head><title>Host</title></head><body><main><h1>An essay</h1>${snippet.attribution}${snippet.script}</main></body></html>`,
    }),
  );
  const record = recordOrigins(page);
  await page.goto(`${HOST}/essay`, { waitUntil: 'networkidle' });
  await expect(
    page.frameLocator('iframe[title="Join Field Notes"]').getByRole('button', { name: 'Join' }),
  ).toBeVisible();
  record.stop();
  const foreign = [...record.seen].filter((o) => ![HOST, CAPTURE, TURNSTILE].includes(o));
  expect(foreign, 'third-party requests from the embed').toEqual([]);
});
