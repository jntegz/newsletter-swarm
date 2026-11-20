// The website templates in a browser: each renders on a phone and a desktop, in light and dark,
// and makes no third-party requests. Set TEMPLATE_SHOTS to a folder to keep screenshots for review.
import { expect, test, type Page } from '@playwright/test';
import { enableChannelFlag, signIn } from './helpers';

const SITE_PORT = 8792;
const DASHBOARD = 'http://localhost:5273';
const TEMPLATES = [
  'gate',
  'letter',
  'magazine',
  'newspaper',
  'launch',
  'night',
  'zine',
  'brief',
] as const;
const SHOTS = process.env.TEMPLATE_SHOTS;

async function api<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(`${DASHBOARD}${path}`, {
    method,
    headers: { origin: DASHBOARD, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { data }),
  });
  expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
  return ((await res.json()) as { data: T }).data;
}

const SUBJECTS = [
  'How to answer the salary question without losing the offer',
  'Five recruiters told me what they never read',
  'The cover letter is not dead, but yours might be',
  'What a rejection email really means',
  'Negotiating when you have no other offer',
  'Your LinkedIn headline, rewritten in ten minutes',
];

test('every template renders, on any screen and scheme, with nothing from elsewhere', async ({
  page,
  request,
}) => {
  test.setTimeout(360_000);
  const stamp = Date.now();
  const slug = `tpl-${stamp.toString(36)}`;
  await page.goto('/');
  await signIn(page, request, `templates-${stamp}@example.com`);
  const me = await api<{ workspaces: { id: string }[] }>(page, 'GET', '/api/v1/auth/session');
  const channel = await api<{ id: string }>(
    page,
    'POST',
    `/api/v1/workspaces/${me.workspaces[0]!.id}/channels`,
    {
      name: 'The Job Search Letter',
      slug,
      description: 'Practical advice for finding your next job, every Tuesday.',
    },
  );
  enableChannelFlag('site_templates', channel.id);
  // A real picture, so the check below can see images load.
  await page.setViewportSize({ width: 1200, height: 800 });
  const picture = await page.screenshot({ type: 'png' });
  const upload = await page.request.fetch(`${DASHBOARD}/api/v1/channels/${channel.id}/media`, {
    method: 'POST',
    headers: { origin: DASHBOARD },
    multipart: {
      file: { name: 'cover.png', mimeType: 'image/png', buffer: picture },
      alt: 'Cover',
    },
  });
  expect(upload.ok()).toBe(true);
  const media = ((await upload.json()) as { data: { id: string } }).data;
  for (const [index, subject] of SUBJECTS.entries()) {
    const dispatch = await api<{ id: string }>(
      page,
      'POST',
      `/api/v1/channels/${channel.id}/dispatches`,
      {
        subject,
        content: {
          type: 'doc',
          content: [
            ...(index % 2 === 0
              ? [{ type: 'image', attrs: { mediaId: media.id, alt: 'Cover' } }]
              : []),
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'A short, specific piece of advice you can use in your next application this week.',
                },
              ],
            },
          ],
        },
      },
    );
    await api(page, 'POST', `/api/v1/dispatches/${dispatch.id}/publish-web`);
  }

  const origin = `http://${slug}.site.localhost:${SITE_PORT}`;
  const seen = new Set<string>();
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.protocol.startsWith('http')) seen.add(url.origin);
  });

  for (const template of TEMPLATES) {
    await api(page, 'PATCH', `/api/v1/channels/${channel.id}/site/settings`, {
      theme: {
        template,
        ...(template === 'launch'
          ? {
              benefits: [
                'A new tactic every Tuesday',
                'Scripts for every hard conversation',
                'The full archive of past issues',
              ],
            }
          : {}),
      },
    });
    for (const [viewport, size] of [
      ['desktop', { width: 1280, height: 860 }],
      ['phone', { width: 390, height: 780 }],
    ] as const) {
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme });
        await page.goto(`${origin}/`);
        // The theme's own root carries its id; the html element marks that a design is drawn.
        await expect(page.locator(`.t-${template}`).first()).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-scheme', /^t-/);
        await page.evaluate(() => {
          for (const img of document.images) img.loading = 'eager';
        });
        await page.waitForLoadState('networkidle');
        const broken = await page.evaluate(
          () => [...document.images].filter((img) => img.complete && img.naturalWidth === 0).length,
        );
        expect(broken, `broken images on ${template}`).toBe(0);
        // Nothing runs off the side of a phone.
        const over = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(over, `${template} ${viewport} ${colorScheme}`).toBeLessThanOrEqual(0);
        if (SHOTS) {
          await page.screenshot({ path: `${SHOTS}/${template}-${viewport}-${colorScheme}.png` });
        }
      }
    }
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(`${origin}/archive`);
    await expect(page.locator('.sw-t-month').first()).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${template}-archive.png`, fullPage: true });
  }
  expect([...seen].filter((o) => o !== origin && o !== 'http://localhost:8792')).toEqual([]);
});
