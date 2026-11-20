import { expect, test, type Page } from '@playwright/test';
import {
  createPublication,
  enableChannelFlag,
  expectAccessible,
  expectPostSaved,
  insertBlock,
  newPost,
  openMoreOptions,
  openSection,
  postBody,
  signIn,
} from './helpers';

/** The site worker serves every Channel at <slug>.site.localhost on its dev port. */
const SITE_PORT = 8792;
const siteUrl = (slug: string, path = '/') => `http://${slug}.site.localhost:${SITE_PORT}${path}`;

async function openTab(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: 'Website sections' })
    .getByRole('link', { name, exact: true })
    .click();
}

test('an operator sets up the Channel website in Site Studio and publishes a Dispatch to it', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const slug = `site-${stamp.toString(36)}`;
  const domain = `swarm${stamp.toString(36)}.com`;

  await page.goto('/');
  await signIn(page, request, `site-${stamp}@example.com`);
  await createPublication(page, 'Harbour Log', slug);

  // Site Studio opens on General for the Channel.
  await openSection(page, 'Website');
  await expect(page.getByRole('heading', { level: 1, name: 'Website' })).toBeVisible();
  await expect(page).toHaveURL(/\/site\/ch_[0-9a-f]+\/general$/);
  await expect(page.getByText(`${slug}.site.localhost`).first()).toBeVisible();
  await expectAccessible(page);

  // Layout: the newspaper layout is an optional feature. While it is off it isn't offered, and
  // the page says where to switch it on.
  await expect(page.getByLabel('Magazine')).toBeChecked();
  await expect(page.getByLabel('Newspaper')).toHaveCount(0);
  await expect(page.getByText('An instance admin can switch on Homepage layouts')).toBeVisible();
  // Nothing to save until something changes; then the Unsaved changes bar holds Save.
  const saved = page.getByRole('status').filter({ hasText: /^Saved$/ });
  await expect(page.getByText('Unsaved changes to the home page')).toBeHidden();
  await page.getByLabel('Previous and next links').uncheck();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(saved).toBeAttached();
  await expect(page.getByText('Unsaved changes to the home page')).toBeHidden();

  // Navigation: add the About page to the header.
  await openTab(page, 'Navigation');
  await page.getByRole('button', { name: 'Add About (/about)' }).click();
  await expect(page.getByLabel('Address 1')).toHaveValue('/about');
  await page.getByRole('button', { name: 'Save navigation' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  await expectAccessible(page);

  // Pages: a custom page, written in the editor and published.
  await openTab(page, 'Pages');
  await expect(page.getByRole('heading', { name: 'No custom pages yet' })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'New page' }).click();
  const newPage = page.getByRole('dialog', { name: 'New page' });
  await newPage.getByLabel('Title').fill('Colophon');
  await newPage.getByRole('button', { name: 'Create page' }).click();
  await expect(page).toHaveURL(/\/pages\/pg_/);
  const content = page.getByRole('textbox', { name: 'Page content' });
  await content.click();
  await page.keyboard.type('Set in Geist, sent from the edge.');
  await page.getByLabel('Show in the navigation').check();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Publish page' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Published.' })).toBeVisible();
  await page.goto(siteUrl(slug, '/colophon'));
  await expect(page.getByRole('heading', { name: 'Colophon' })).toBeVisible();
  await expect(page.getByText('Set in Geist, sent from the edge.')).toBeVisible();
  await page.goBack();

  // Redirects: one by hand, and a CSV import with a line to skip.
  await openTab(page, 'Redirects');
  await expect(page.getByRole('heading', { name: 'No redirects yet' })).toBeVisible();
  await page.getByLabel('From path').fill('/old-colophon');
  await page.getByLabel('To', { exact: true }).fill('/colophon');
  await page.getByRole('button', { name: 'Add redirect' }).click();
  await expect(page.getByRole('cell', { name: '/old-colophon', exact: true })).toBeVisible();
  await page.getByLabel('Or paste the rows').fill('from,to\n/2019/about,/about\nno-slash,/about');
  await page.getByRole('button', { name: 'Import redirects' }).click();
  await expect(page.getByText('1 added')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Skipped lines' })).toContainText('Line 3');
  await expectAccessible(page);
  const redirect = await request.get(siteUrl(slug, '/old-colophon'), { maxRedirects: 0 });
  expect(redirect.status()).toBe(301);
  expect(redirect.headers().location).toContain('/colophon');

  // Bot Rules: asked on first visit; block every AI crawler.
  await openTab(page, 'Bot Rules');
  await expect(
    page.getByRole('heading', { name: 'Should AI crawlers read your website?' }),
  ).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Block AI crawlers' }).click();
  await expect(
    page.getByRole('heading', { name: 'Should AI crawlers read your website?' }),
  ).toBeHidden();
  await expect(page.getByRole('cell', { name: 'GPTBot (OpenAI)' })).toBeVisible();
  await expect(page.getByText('Blocked').first()).toBeVisible();
  const robots = await request.get(siteUrl(slug, '/robots.txt'));
  expect(await robots.text()).toContain('User-agent: GPTBot');

  // A Dispatch with a gate, put on the website without sending.
  await openSection(page, 'Posts');
  await newPost(page);
  const body = postBody(page);
  await expect(body).toBeVisible();
  await page.getByLabel('Subject').fill('Low tide notes');
  await body.click();
  await page.keyboard.type('Everyone reads this part.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Only Members read this part.');
  await body.getByText('Everyone reads this part.').click();
  await insertBlock(page, 'Paywall break');
  await expect(body.getByRole('separator')).toBeVisible();
  // One per post: the menu now offers it no more.
  const toolbar = page.getByRole('toolbar', { name: 'Formatting' });
  await toolbar.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(toolbar.getByRole('button', { name: 'Paywall break added' })).toBeDisabled();
  await toolbar.getByRole('button', { name: 'Insert', exact: true }).click();
  await expectPostSaved(page);
  await openMoreOptions(page);
  await page.getByLabel('Who can read it on the website').selectOption('members');
  await expect(
    page.getByText('Readers who aren’t signed-in subscribers stop at the paywall break.'),
  ).toBeVisible();
  await expect(page.getByLabel('Web address')).toHaveAttribute('placeholder', 'low-tide-notes');
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Publish to web only' }).click();
  await expect(page.getByText('On the website', { exact: true })).toBeVisible();
  const href = await page.getByRole('link', { name: /View on site/ }).getAttribute('href');
  expect(href).toMatch(/\/p\/low-tide-notes$/);

  await page.goto(siteUrl(slug, new URL(href!).pathname));
  await expect(page.getByRole('heading', { level: 1, name: 'Low tide notes' })).toBeVisible();
  await expect(page.getByText('Everyone reads this part.')).toBeVisible();
  await expect(page.getByText('Only Members read this part.')).toHaveCount(0);
  await page.goBack();

  // Pin it on the home page, now that it is on the website.
  await page.goto('/site');
  await expect(page).toHaveURL(/\/general$/);
  await page.getByLabel('Pin a post').selectOption({ label: 'Low tide notes' });
  await page.getByRole('button', { name: 'Pin', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeAttached();

  // Domains: a bare domain becomes www plus a redirect; dev hostnames activate on a check.
  await openTab(page, 'Domains');
  await expect(page.getByText(/No domain connected yet/)).toBeVisible();
  // "Add domain" opens a short form in place.
  await page.getByRole('button', { name: 'Add domain' }).click();
  await expect(page.getByLabel('Domain', { exact: true })).toBeFocused();
  await page.getByLabel('Domain', { exact: true }).fill(domain);
  await expect(
    page.getByText(`www.${domain} will serve the site, and ${domain} will redirect to it.`),
  ).toBeVisible();
  await page
    .getByRole('form', { name: 'Add a web domain' })
    .getByRole('button', { name: 'Add domain' })
    .click();
  await expect(page.getByRole('status').filter({ hasText: `Added www.${domain}.` })).toBeVisible();
  const card = page.getByRole('region', { name: domain });
  await expect(card.getByText('Waiting for DNS').first()).toBeVisible();
  await expect(card.getByRole('cell', { name: 'CNAME' }).first()).toBeVisible();
  await expectAccessible(page);
  await card.getByRole('button', { name: `Check www.${domain} now` }).click();
  await expect(card.getByRole('listitem').filter({ hasText: /^Website/ })).toContainText('Active');
  await card.getByRole('button', { name: `Check ${domain} now` }).click();
  await expect(card.getByRole('listitem').filter({ hasText: /^Root redirect/ })).toContainText(
    'Active',
  );
  await expect(card.getByText('Primary').first()).toBeVisible();
  await expect(card.getByRole('listitem').filter({ hasText: /^Email sending/ })).toContainText(
    'Not set up',
  );

  // Analytics: an empty state until readers arrive, or the views the visits above made.
  await openTab(page, 'Analytics');
  await expect(
    page
      .getByRole('heading', { name: 'No page views in this range' })
      .or(page.getByRole('heading', { name: 'Views by day' })),
  ).toBeVisible();
  await expectAccessible(page);
});

test('an author creates their author page in the website settings and readers see it on the website', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const slug = `authors-${stamp.toString(36)}`;
  await page.goto('/');
  await signIn(page, request, `authors-${stamp}@example.com`);
  const dashboard = new URL(page.url()).origin;
  const api = async <T>(method: string, path: string, data?: unknown): Promise<T> => {
    const res = await page.request.fetch(`${dashboard}${path}`, {
      method,
      headers: { origin: dashboard, 'content-type': 'application/json' },
      ...(data === undefined ? {} : { data }),
    });
    expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
    return ((await res.json()) as { data: T }).data;
  };
  const me = await api<{ workspaces: { id: string }[] }>('GET', '/api/v1/auth/session');
  const create = (name: string, address: string) =>
    api<{ id: string }>('POST', `/api/v1/workspaces/${me.workspaces[0]!.id}/channels`, {
      name,
      slug: address,
    });

  // With author_pages off (the default) the tab says the feature is switched off.
  const off = await create('Quiet Log', `${slug}-off`);
  await page.goto(`/site/${off.id}/authors`);
  await expect(
    page.getByRole('heading', { name: 'Author pages are not available for this publication' }),
  ).toBeVisible();
  await expectAccessible(page);

  const channel = await create('Harbour Log', slug);
  enableChannelFlag('author_pages', channel.id);
  await page.goto(`/site/${channel.id}/general`);
  await openTab(page, 'Authors');
  await expect(page).toHaveURL(/\/authors$/);
  const mine = page.getByRole('form', { name: 'Your author page' });
  await expect(page.getByText('No author pages yet.')).toBeVisible();
  await expectAccessible(page);

  await mine.getByLabel('Name').fill('Ada Harbour');
  await mine.getByLabel('Address (optional)').fill('ada');
  await mine.getByLabel('Bio (optional)').fill('Writes about tides and the boats that ride them.');
  await mine.getByRole('button', { name: 'Create author page' }).click();
  await expect(mine.getByRole('status')).toHaveText('Saved.');
  await expect(mine.getByRole('link', { name: /\/authors\/ada/ })).toBeVisible();
  const list = page.getByRole('region', { name: 'Every author page' });
  await expect(list.getByText('Ada Harbour', { exact: true })).toBeVisible();
  await expect(list.getByText('/authors/ada')).toBeVisible();
  await expectAccessible(page);

  // The website has the page.
  await page.goto(siteUrl(slug, '/authors/ada'));
  await expect(page.getByRole('heading', { level: 1, name: 'Ada Harbour' })).toBeVisible();
  await expect(page.getByText('Writes about tides and the boats that ride them.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Posts by Ada Harbour' })).toBeVisible();
  await expectAccessible(page);

  // An admin removes it, and the website no longer has it.
  await page.goto(`/site/${channel.id}/authors`);
  await page.getByRole('button', { name: 'Remove the author page of Ada Harbour' }).click();
  const confirm = page.getByRole('dialog', { name: 'Remove the author page of Ada Harbour?' });
  await expectAccessible(page);
  await confirm.getByRole('button', { name: 'Remove author page' }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByText('No author pages yet.')).toBeVisible();
  expect((await request.get(siteUrl(slug, '/authors/ada'))).status()).toBe(404);
});
