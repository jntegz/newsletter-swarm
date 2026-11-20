import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import {
  createPublication,
  enableWorkspaceFlag,
  expectAccessible,
  expectPostSaved,
  newPost,
  openSection,
  postBody,
  signIn,
} from './helpers';

/** Stands in for a Shorthop on this machine, answering like its src/worker/mcp.ts. */
function fakeShorthop() {
  const made: { slug: string; url: string }[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += String(chunk)));
    req.on('end', () => {
      const { method, params } = JSON.parse(raw) as {
        method: string;
        params: { name: string; arguments: { slug: string; url: string } };
      };
      const origin = `http://${req.headers.host}`;
      const result =
        method === 'tools/list'
          ? { tools: [{ name: 'create_link' }] }
          : params.name === 'list_links'
            ? { structuredContent: { links: [] } }
            : (made.push({ slug: params.arguments.slug, url: params.arguments.url }),
              { structuredContent: { link: { shortUrl: `${origin}/${params.arguments.slug}` } } });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
  });
  return { server, made };
}

async function sessionWorkspace(page: Page) {
  return page.evaluate(async () => {
    const res = await fetch('/api/v1/auth/session', { credentials: 'same-origin' });
    return ((await res.json()) as { data: { workspaces: { id: string }[] } }).data.workspaces[0]!
      .id;
  });
}

test('an admin connects Shorthop from Apps, and a writer shortens links in a post', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const fake = fakeShorthop();
  await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  const stamp = Date.now() * 10 + test.info().parallelIndex;

  try {
    await page.goto('/');
    await signIn(page, request, `apps-${stamp}@example.com`);
    enableWorkspaceFlag('applications', await sessionWorkspace(page));
    await createPublication(page, 'Field Notes', `apps-${stamp.toString(36)}`);

    // Nothing shows in the editor until it is connected.
    // The old address opens the same card.
    await page.goto('/settings/applications');
    await expect(page).toHaveURL(/\/apps\?app=shorthop/);
    const form = page.getByRole('form', { name: 'Connect Shorthop' });
    await form.getByLabel('Shorthop address').fill(address);
    await form.getByLabel('API key').fill('shp_test_key_1234');
    await form.getByLabel('Slug format').fill('{post}-{bad}');
    await expect(form.getByText(/Use letters, digits/)).toBeVisible();
    await form.getByLabel('Slug format').fill('news-{post}-{random}');
    await expect(form.getByText('news-the-slow-web-revisited-x7k2q9')).toBeVisible();
    await expectAccessible(page);
    await form.getByRole('button', { name: 'Connect Shorthop' }).click();
    await expect(page.getByText(/Connected to/)).toBeVisible();
    // The key is gone from the page; its end is enough to recognise it.
    expect(await page.content()).not.toContain('shp_test_key_1234');
    await expect(page.getByText('1234', { exact: true })).toBeVisible();
    await page
      .getByRole('dialog', { name: 'Shorthop' })
      .getByRole('button', { name: 'Close' })
      .click();
    await expect(page.getByText('Connected', { exact: true })).toBeVisible();

    await openSection(page, 'Posts');
    await newPost(page);
    await page.getByLabel('Subject').fill('Good Reads');
    await postBody(page).click();
    await page.keyboard.type('Read this');
    await page.keyboard.press('Enter');
    await page.keyboard.type('And this');

    const openLink = () =>
      page
        .getByRole('toolbar', { name: 'Formatting' })
        .getByRole('button', { name: /^(Add|Edit) link$/ })
        .click();
    const dialog = page.getByRole('dialog', { name: 'Link' });

    // An ordinary link on the second line, for "every link" below.
    await postBody(page).getByText('And this').click({ clickCount: 3 });
    await openLink();
    await dialog.getByLabel('Web address').fill('https://example.org/second');
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(postBody(page).locator('a[href="https://example.org/second"]')).toHaveCount(1);

    // One link, from the link dialog, on the first line.
    await postBody(page).getByText('Read this').click({ clickCount: 3 });
    await openLink();
    const turn = dialog.getByRole('button', { name: 'Shorten link' });
    await expect(turn).toBeDisabled();
    await dialog.getByLabel('Web address').fill('https://example.org/first');
    await turn.click();
    await expect(
      dialog.getByText('Shorthop link, going to https://example.org/first'),
    ).toBeVisible();
    await expect(dialog.getByLabel('Web address')).toHaveValue(
      new RegExp(`^${address}/news-good-reads-[a-z0-9]+$`),
    );
    await dialog.getByRole('button', { name: 'Apply' }).click();
    expect(fake.made).toHaveLength(1);
    expect(fake.made[0]).toMatchObject({ url: 'https://example.org/first' });
    await expect(postBody(page).locator(`a[href^="${address}/news-good-reads-"]`)).toHaveCount(1);
    await expect(postBody(page)).toContainText('Read this');
    await expect(postBody(page)).toContainText('And this');

    await page.getByRole('button', { name: 'Shorten all links' }).click();
    await expect(page.getByText('1 link shortened.')).toBeVisible();
    await expect(postBody(page).locator(`a[href^="${address}/news-good-reads-"]`)).toHaveCount(2);
    await expect(postBody(page).locator('a[href^="https://example.org"]')).toHaveCount(0);
    await expect(postBody(page)).toContainText('Read this');
    await expect(postBody(page)).toContainText('And this');
    await expectPostSaved(page);
    expect(fake.made.map((m) => m.url)).toEqual([
      'https://example.org/first',
      'https://example.org/second',
    ]);
    // Undo brings the address back.
    await postBody(page).click();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(postBody(page).locator('a[href="https://example.org/second"]')).toHaveCount(1);

    // Disconnected: the links stay, and the editor offers nothing.
    await page.goto('/settings/applications');
    await page.getByRole('button', { name: 'Disconnect Shorthop' }).click();
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(page.getByRole('form', { name: 'Connect Shorthop' })).toBeVisible();
  } finally {
    fake.server.close();
  }
});
