import { describe, expect, it } from 'vitest';
import { parseCsv, readArchiveCsv, readExportZip, readZip, toSlug } from './archive';

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, commas and newlines in fields', () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi""\nthere"\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"\nthere'],
    ]);
  });
});

describe('toSlug', () => {
  it('takes the last part of an address and makes it safe', () => {
    expect(toSlug('https://news.example.com/p/my-post?utm=1')).toBe('my-post');
    expect(toSlug('Crème Brûlée & Co!')).toBe('creme-brulee-co');
  });
});

describe('readExportZip', () => {
  const csv = [
    'post_id,post_date,is_published,title,subtitle,audience',
    '123.my-post,2025-03-01T10:00:00.000Z,true,My post,Sub,everyone',
    '124.paid-post,2025-03-02T10:00:00.000Z,true,Paid post,,only_paid',
    '125.draft-post,,false,Draft post,,everyone',
    '126.empty-post,2025-03-03T10:00:00.000Z,true,Empty post,,everyone',
  ].join('\n');
  const files = new Map([
    ['posts.csv', csv],
    ['posts/123.my-post.html', '<p>Hello</p>'],
    ['posts/124.paid-post.html', '<p>Paid</p>'],
  ]);

  it('reads published posts, keeps their address and says what it left out', () => {
    const { items, skipped } = readExportZip(files);
    expect(items).toMatchObject([
      {
        subject: 'My post',
        preheader: 'Sub',
        slug: 'my-post',
        publishedAt: '2025-03-01T10:00:00.000Z',
        visibility: 'public',
        html: '<p>Hello</p>',
      },
      { subject: 'Paid post', slug: 'paid-post', visibility: 'paid' },
    ]);
    expect(skipped).toEqual(['Draft post: a draft', 'Empty post: no content in the export']);
  });

  it('says when this isn’t the right file', () => {
    expect(() => readExportZip(new Map())).toThrow(/posts\.csv/);
  });

  it('keeps an entity named like an Object.prototype member as it is', () => {
    // The export is another platform's file: &constructor; is no entity.
    const { items } = readExportZip(
      new Map([
        [
          'posts.csv',
          `${csv.split('\n')[0]}\n123.my-post,2025-03-01T10:00:00.000Z,true,A &constructor; b,Sub,everyone`,
        ],
        ['posts/123.my-post.html', '<p>Hello</p>'],
      ]),
    );
    expect(items[0]!.subject).toBe('A &constructor; b');
  });
});

describe('readArchiveCsv', () => {
  it('finds common column names, and reports rows it can’t use', () => {
    const { items, skipped } = readArchiveCsv(
      [
        'Title,Publish_Date,Content_HTML,Web_URL,Audience',
        'One,2025-01-02,<p>1</p>,https://a.example/p/one,free',
        'Two,not a date,<p>2</p>,,free',
        ',2025-01-03,<p>3</p>,,free',
      ].join('\n'),
    );
    expect(items).toMatchObject([{ subject: 'One', slug: 'one', html: '<p>1</p>' }]);
    expect(skipped).toEqual(['Two: no date', '(no title): no title']);
  });
});

describe('readZip', () => {
  it('reads a stored file', async () => {
    const name = new TextEncoder().encode('a.csv');
    const body = new TextEncoder().encode('hi');
    const local = new Uint8Array(30 + name.length + body.length);
    new DataView(local.buffer).setUint32(0, 0x04034b50, true);
    new DataView(local.buffer).setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(body, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint32(20, body.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, 0, true);
    central.set(name, 46);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(10, 1, true);
    ev.setUint32(16, local.length, true);
    const all = new Uint8Array(local.length + central.length + end.length);
    all.set(local);
    all.set(central, local.length);
    all.set(end, local.length + central.length);
    const files = await readZip(all.buffer);
    expect(files.get('a.csv')).toBe('hi');
  });

  it('refuses something that isn’t a zip', async () => {
    await expect(readZip(new ArrayBuffer(40))).rejects.toThrow(/zip/);
  });
});

// Shaped like what public migration tooling reads from these exports. Not copied from a real export,
// which is still needed for proof.
describe('a zip export, as public tooling describes it', () => {
  const header =
    'post_id,post_date,is_published,email_sent_at,inbox_sent_at,type,audience,title,subtitle,podcast_url';
  const posts = [
    header,
    '139286.first-post,2023-01-18T21:25:27.123Z,true,2023-01-18T21:25:30.000Z,,newsletter,everyone,First post,Tom &amp; Jerry&#39;s story,',
    '139287.paid-post,2023-02-01T09:00:00.000Z,true,,,newsletter,only_paid,A paid post,,',
    '139288.free-only,2023-02-02T09:00:00.000Z,true,,,newsletter,only_free,Subscribers only,,',
    '139289.founders,2023-02-03T09:00:00.000Z,true,,,newsletter,founding,For founders,,',
    '139290.episode,2023-03-01T09:00:00.000Z,true,,,podcast,everyone,An episode,,https://audio.example.com/1.mp3',
    '139291.an-old-draft,,false,,,newsletter,everyone,An old draft,,',
    '139292.empty-flag,2023-03-02T09:00:00.000Z,,,,newsletter,everyone,Flag left empty,,',
    '139293.a-chat,2023-03-03T09:00:00.000Z,true,,,thread,everyone,A chat,,',
    '139294.about,2023-03-04T09:00:00.000Z,true,,,page,everyone,About us,,',
    '139295.no-date,,true,,,newsletter,everyone,Sent only,,',
    '139296,2023-03-05T09:00:00.000Z,true,,,newsletter,everyone,Title Becomes Address,,',
    '139297.first-post,2023-03-06T09:00:00.000Z,true,,,newsletter,everyone,Same address,,',
  ].join('\r\n');
  const files = new Map([
    ['export-abc/posts.csv', `\uFEFF${posts}`],
    ['export-abc/posts/139286.first-post.html', '<p>One</p>'],
    ['export-abc/posts/139287.paid-post.html', '<p>Two</p>'],
    ['export-abc/posts/139288.free-only.html', '<p>Three</p>'],
    ['export-abc/posts/139289.founders.html', '<p>Four</p>'],
    ['export-abc/posts/139290.episode.html', '<p>Five</p>'],
    ['export-abc/posts/139291.an-old-draft.html', '<p>Draft</p>'],
    ['export-abc/posts/139292.empty-flag.html', '<p>Not known to be published</p>'],
    ['export-abc/posts/139293.a-chat.html', '<p>Chat</p>'],
    ['export-abc/posts/139294.about.html', '<p>About</p>'],
    ['export-abc/posts/139295.no-date.html', '<p>Seven</p>'],
    ['export-abc/posts/139296.html', '<p>Eight</p>'],
    ['export-abc/posts/139297.first-post.html', '<p>Nine</p>'],
    ['__MACOSX/export-abc/posts/139295.no-date.html', 'binary'],
    ['export-abc/email_list.csv', 'email\nsomeone@example.com\n'],
    ['export-abc/posts/139286.first-post.opens.csv', 'email\nsomeone@example.com\n'],
  ]);
  const { items, skipped } = readExportZip(files);
  const bySlug = (slug: string) => items.find((item) => item.slug === slug);

  it('finds each published post in its folder', () => {
    expect(items.map((item) => item.slug)).toEqual([
      'first-post',
      'paid-post',
      'free-only',
      'founders',
      'episode',
      'title-becomes-address',
    ]);
    expect(bySlug('first-post')).toMatchObject({
      subject: 'First post',
      preheader: "Tom & Jerry's story",
      publishedAt: '2023-01-18T21:25:27.123Z',
      html: '<p>One</p>',
    });
  });

  it('reads who each was for', () => {
    expect(bySlug('first-post')?.visibility).toBe('public');
    expect(bySlug('paid-post')?.visibility).toBe('paid');
    expect(bySlug('free-only')?.visibility).toBe('members');
    expect(bySlug('founders')?.visibility).toBe('paid');
  });

  it('links an episode’s audio, which stays where it is', () => {
    expect(bySlug('episode')?.html).toContain('href="https://audio.example.com/1.mp3"');
    expect(bySlug('episode')?.html).toContain('<p>Five</p>');
  });

  it('says why the rest were left out, and only imports what is known to be published', () => {
    expect(skipped).toEqual([
      'An old draft: a draft',
      'Flag left empty: a draft',
      'A chat: a discussion thread, not a post',
      'About us: a page, which you can make again under Pages',
      'Sent only: no date',
      'Same address: another post in this file has the address first-post',
    ]);
  });
});

describe('a CSV export with web_ columns and a status', () => {
  const html = '"<table><tr><td id=""content-blocks""><p>Body, with a comma</p></td></tr></table>"';
  const { items, skipped } = readArchiveCsv(
    [
      'id,web_title,status,audience,web_audiences,content_tags,url,web_subtitle,content_html,thumbnail_url,created_at',
      `post_1,Published one,confirmed,free,,news,https://news.example.com/p/published-one,The sub,${html},,2023-01-18 21:25:27`,
      `post_2,Paid one,confirmed,premium,,,https://news.example.com/p/paid-one,,${html},,2023-01-19 21:25:27`,
      `post_3,Newer paid,confirmed,,All paid subscribers,,https://news.example.com/p/newer-paid,,${html},,2023-01-20 21:25:27`,
      `post_4,For both,confirmed,both,,,https://news.example.com/p/for-both,,${html},,2023-01-21 21:25:27`,
      `post_5,Still a draft,draft,free,,,https://news.example.com/p/still-a-draft,,${html},,2023-01-22 21:25:27`,
      `post_6,Taken down,archived,free,,,https://news.example.com/p/taken-down,,${html},,2023-01-23 21:25:27`,
    ].join('\n'),
  );

  it('reads the title, address, subtitle and HTML from those columns', () => {
    expect(items[0]).toMatchObject({
      subject: 'Published one',
      slug: 'published-one',
      preheader: 'The sub',
    });
    expect(items[0]?.html).toContain('Body, with a comma');
  });

  it('reads a time without a zone as UTC, wherever the browser is', () => {
    expect(items[0]?.publishedAt).toBe('2023-01-18T21:25:27.000Z');
  });

  it('reads who each was for, from either column', () => {
    expect(items.map((item) => item.visibility)).toEqual(['public', 'paid', 'paid', 'members']);
  });

  it('leaves out drafts and archived posts', () => {
    expect(skipped).toEqual([
      'Still a draft: not published (draft)',
      'Taken down: not published (archived)',
    ]);
  });
});

describe('toSlug when it has to cut', () => {
  it('never ends on a dash', () => {
    expect(toSlug(`${'a'.repeat(99)} b`)).toBe('a'.repeat(99));
  });
});
