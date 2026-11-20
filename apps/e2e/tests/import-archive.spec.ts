// Website → Import past issues, through the file input with a real .zip and a CSV. The fixtures
// follow what public migration tooling reads from exports; a real export is still needed for proof.
import { expect, test } from '@playwright/test';
import { expectAccessible } from './helpers';
import { api, hasMail, latestMail, publication, shot } from './screens';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Buffer) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A real zip with stored files, the way an archiver writes one. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const name = Buffer.from(path);
    const body = Buffer.from(text);
    const crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const RICH = `
<p>The first line of the old post<a class="footnote-anchor" id="footnote-anchor-1" href="#footnote-1" target="_self">1</a>.</p>
<div class="captioned-image-container"><figure><a class="image-link image2" target="_blank" href="https://cdn.example.com/fox-big.png"><img src="https://cdn.example.com/fox.png" srcset="https://cdn.example.com/fox.png 424w, https://cdn.example.com/fox-big.png 848w" alt="A fox at dawn"></a><figcaption class="image2-caption">Seen on the hill</figcaption></figure></div>
<div class="subscription-widget-wrap"><div class="subscription-widget"><form><input type="email"><input type="submit" value="Subscribe"></form></div></div>
<div id="youtube2-dQw4w9WgXcQ" class="youtube-wrap" data-attrs="{&quot;videoId&quot;:&quot;dQw4w9WgXcQ&quot;}"><div class="youtube-inner"><iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0" frameborder="0"></iframe></div></div>
<p class="button-wrapper"><a class="button primary" href="https://example.com/the-report"><span>Read the report</span></a></p>
<p class="button-wrapper"><a class="button primary" href="https://old.example.com/subscribe?"><span>Subscribe now</span></a></p>
<p class="button-wrapper"><a class="button primary" href="https://old.example.com/p/rich?action=share"><span>Share</span></a></p>
<div class="embedded-post-wrap" data-attrs="{&quot;url&quot;:&quot;https://other.example.com/p/earlier&quot;,&quot;title&quot;:&quot;An earlier post&quot;,&quot;truncated_body_text&quot;:&quot;What came before.&quot;}"><div class="embedded-post">An earlier post</div></div>
<div class="poll-embed" data-attrs="{&quot;id&quot;:1}">A poll</div>
<div class="footnote"><a id="footnote-1" href="#footnote-anchor-1" class="footnote-number">1</a><div class="footnote-content"><p>The note under the post.</p></div></div>`;

const POSTS_CSV = [
  'post_id,post_date,is_published,email_sent_at,inbox_sent_at,type,audience,title,subtitle,podcast_url',
  '101.oldest-issue,2021-03-04T10:00:00.000Z,true,2021-03-04T10:00:05.000Z,,newsletter,everyone,The oldest issue,Where it began,',
  '102.middle-issue,2022-06-15T10:00:00.000Z,true,,,newsletter,everyone,The middle issue,Tom &amp; Jerry,',
  '103.newest-issue,2023-09-20T10:00:00.000Z,true,,,newsletter,everyone,The newest issue,,',
  '104.rich-issue,2021-08-08T08:00:00.000Z,true,,,newsletter,everyone,The rich issue,,',
  '105.paid-issue,2022-02-02T10:00:00.000Z,true,,,newsletter,only_paid,The paid issue,,',
  '106.paid-no-break,2022-03-03T10:00:00.000Z,true,,,newsletter,only_paid,The paid issue without a break,,',
  '107.free-only,2022-04-04T10:00:00.000Z,true,,,newsletter,only_free,The subscribers issue,,',
  '108.a-draft,,false,,,newsletter,everyone,A draft that must stay private,,',
  '109.a-thread,2022-05-05T10:00:00.000Z,true,,,thread,everyone,A discussion thread,,',
  '110.lost-file,2022-05-06T10:00:00.000Z,true,,,newsletter,everyone,A post with no file,,',
].join('\n');

const EXPORT = {
  'export-abc/posts.csv': POSTS_CSV,
  'export-abc/email_list.csv': 'email,active\nsomeone@example.com,true\n',
  'export-abc/posts/101.oldest-issue.html': '<p>Oldest body text.</p>',
  'export-abc/posts/101.oldest-issue.delivers.csv': 'email\nsomeone@example.com\n',
  'export-abc/posts/102.middle-issue.html': '<p>Middle body text.</p>',
  'export-abc/posts/103.newest-issue.html': '<p>Newest body text.</p>',
  'export-abc/posts/104.rich-issue.html': RICH,
  'export-abc/posts/105.paid-issue.html':
    '<p>The free opening.</p><div class="paywall-jump" data-component-name="PaywallJump"></div><p>The secret part.</p>',
  'export-abc/posts/106.paid-no-break.html': '<p>Secret from the first word.</p>',
  'export-abc/posts/107.free-only.html': '<p>For subscribers from the first word.</p>',
  'export-abc/posts/108.a-draft.html': '<p>Draft text.</p>',
  'export-abc/posts/109.a-thread.html': '<p>Thread text.</p>',
};

test('a real zip becomes dated website posts, emails nobody, and importing again is safe', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(180_000);
  const site = await publication(page, request, 'import', ['archive_import']);
  const reader = `import-reader-${Date.now()}@example.com`;
  await api(page, 'POST', `/api/v1/channels/${site.id}/members`, { email: reader, consent: true });

  // Reached from the Website tabs, which show it only with its flag on.
  await page.goto(`/site/${site.id}`);
  await page
    .getByRole('navigation', { name: 'Website sections' })
    .getByRole('link', { name: 'Import past issues' })
    .click();
  await expect(page.getByRole('heading', { name: 'Import past issues' })).toBeVisible();
  await expectAccessible(page);

  const file = page.getByLabel('Export file');
  await file.setInputFiles({
    name: 'export.zip',
    mimeType: 'application/zip',
    buffer: zip(EXPORT),
  });
  await expect(page.getByRole('button', { name: 'Import 7 posts' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText('3 left out')).toBeVisible();
  await page.getByText('What was left out').click();
  await expect(page.getByText('A draft that must stay private: a draft')).toBeVisible();
  await expect(
    page.getByText('A discussion thread: a discussion thread, not a post'),
  ).toBeVisible();
  await expect(page.getByText('A post with no file: no content in the export')).toBeVisible();
  await page.getByText('What won’t come across').click();
  await expect(page.getByText('The rich issue: a poll')).toBeVisible();
  await expectAccessible(page);
  await shot(page, 'import-ready');

  await page.getByRole('button', { name: 'Import 7 posts' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'posts imported' })).toContainText(
    '7 posts imported. Nothing was emailed.',
    { timeout: 30_000 },
  );
  await expectAccessible(page);
  await shot(page, 'import-done');

  // Nothing went to anyone: a subscriber's mailbox stays empty.
  expect(await hasMail(request, reader)).toBe(false);

  // The website: right order, right dates.
  const visitor = await browser.newContext({ timezoneId: 'America/Los_Angeles' });
  const visit = await visitor.newPage();
  await visit.goto(`${site.origin}/archive`);
  await shot(visit, 'import-archive-page');
  const titles = await visit.getByRole('link', { name: /issue/ }).allInnerTexts();
  const position = (title: string) => titles.findIndex((text) => text.includes(title));
  expect(position('The newest issue')).toBeGreaterThanOrEqual(0);
  expect(position('The newest issue')).toBeLessThan(position('The middle issue'));
  expect(position('The middle issue')).toBeLessThan(position('The rich issue'));
  expect(position('The rich issue')).toBeLessThan(position('The oldest issue'));

  await visit.goto(`${site.origin}/p/oldest-issue`);
  await expect(visit.getByRole('heading', { name: 'The oldest issue' })).toBeVisible();
  await expect(visit.getByText('Where it began')).toBeVisible();
  await expect(visit.getByText('Oldest body text.')).toBeVisible();
  await expect(visit.getByText(/Mar(ch)?\.? 4,? 2021|4 Mar(ch)? 2021/).first()).toBeVisible();
  await visit.goto(`${site.origin}/p/middle-issue`);
  await expect(visit.getByText('Tom & Jerry')).toBeVisible();

  // What the HTML mapping keeps, on the page itself.
  await visit.goto(`${site.origin}/p/rich-issue`);
  await shot(visit, 'import-rich-post');
  await expect(visit.getByRole('img', { name: 'A fox at dawn' })).toBeVisible();
  await expect(visit.getByText('Seen on the hill')).toBeVisible();
  await expect(visit.getByText('The note under the post.')).toBeVisible();
  await expect(visit.getByRole('link', { name: /Read the report/ })).toHaveAttribute(
    'href',
    /the-report/,
  );
  await expect(visit.getByRole('link', { name: /Watch on YouTube/ })).toBeVisible();
  await expect(visit.getByRole('link', { name: /An earlier post/ })).toBeVisible();
  const words = (await visit.locator('main').innerText()).toLowerCase();
  expect(words).not.toContain('subscribe now');
  expect(words).not.toContain('a poll');

  // Paid text stays paid: a paywall mark is kept, and a post without one shows only its title.
  await visit.goto(`${site.origin}/p/paid-issue`);
  await shot(visit, 'import-paid');
  await expect(visit.getByText('The free opening.')).toBeVisible();
  await expect(visit.getByText('The secret part.')).toHaveCount(0);
  for (const [path, secret] of [
    ['paid-no-break', 'Secret from the first word.'],
    ['free-only', 'For subscribers from the first word.'],
  ] as const) {
    const res = await visit.goto(`${site.origin}/p/${path}`);
    expect(res?.status()).toBe(200);
    await shot(visit, `import-${path}`);
    await expect(visit.getByText(secret)).toHaveCount(0);
  }
  // Nor in the feed.
  const feed = await request.get(`${site.origin}/feed.xml`);
  if (feed.ok()) expect(await feed.text()).not.toContain('Secret from the first word.');
  for (const path of ['a-draft', 'a-thread']) {
    expect((await visit.goto(`${site.origin}/p/${path}`))?.status()).toBe(404);
  }
  await visitor.close();

  // The same file again changes nothing.
  await page.goto(`/site/${site.id}/import`);
  await file.setInputFiles({
    name: 'export.zip',
    mimeType: 'application/zip',
    buffer: zip(EXPORT),
  });
  await expect(page.getByText('7 already here')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /^Import/ })).toHaveCount(0);
  await shot(page, 'import-again');
  expect(await hasMail(request, reader)).toBe(false);

  // A CSV from any platform, with a draft, an archived post and a time without a zone. Choosing the
  // same file twice in a row is noticed too.
  const csv = [
    'id,web_title,status,audience,url,web_subtitle,content_html,created_at',
    `p1,The csv issue,confirmed,free,https://news.example.com/p/csv-issue,From a csv,"<html><head><title>x</title><style>p{color:red}</style></head><body><table><tr><td id=""content-blocks""><p>Csv body text {{subscriber_id}}.</p></td></tr></table><p>Unsubscribe here</p></body></html>",2020-01-18 21:25:27`,
    `p2,A csv draft,draft,free,https://news.example.com/p/csv-draft,,<p>Draft</p>,2020-01-19 21:25:27`,
    `p3,An archived one,archived,free,https://news.example.com/p/csv-gone,,<p>Gone</p>,2020-01-20 21:25:27`,
    `p4,The premium csv issue,confirmed,premium,https://news.example.com/p/csv-paid,,<p>Premium words.</p>,2020-01-21 21:25:27`,
  ].join('\n');
  const upload = { name: 'posts.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) };
  await file.setInputFiles(upload);
  await expect(page.getByRole('button', { name: 'Import 2 posts' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText('2 left out')).toBeVisible();
  await file.setInputFiles(upload);
  await expect(page.getByRole('button', { name: 'Import 2 posts' })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Import 2 posts' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'imported' })).toContainText(
    '2 posts imported',
    { timeout: 30_000 },
  );
  await page.goto(`${site.origin}/p/csv-issue`);
  await shot(page, 'import-csv-post');
  await expect(page.getByText('Csv body text .')).toBeVisible();
  const body = await page.locator('main').innerText();
  expect(body).not.toContain('Unsubscribe here');
  expect(body).not.toContain('color:red');
  await expect(page.getByText(/Jan(uary)?\.? 18,? 2020|18 Jan(uary)? 2020/).first()).toBeVisible();

  // A file with nothing usable says why, instead of showing nothing.
  await page.goto(`/site/${site.id}/import`);
  await file.setInputFiles({
    name: 'drafts.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'web_title,status,content_html,created_at\nOnly a draft,draft,<p>x</p>,2020-01-01\n',
    ),
  });
  await expect(page.getByText('1 left out')).toBeVisible({ timeout: 30_000 });
  // And a wrong zip says so.
  await file.setInputFiles({
    name: 'other.zip',
    mimeType: 'application/zip',
    buffer: zip({ 'readme.csv': 'a,b\n1,2\n' }),
  });
  await expect(page.getByText(/No posts\.csv in this zip/)).toBeVisible();
  await expectAccessible(page);
  // The owner's mailbox holds their sign-in link, and no post.
  expect((await latestMail(request, site.email)).subject).not.toMatch(/issue/i);
});
