// Feed Sync, pure parts: the four formats, the XML safety rules, item HTML into editor blocks
// (rendered by the real renderer), dedupe keys, building Dispatches, quiet windows and fetching
// through the outbound URL guard with redirects, size and time limits.
import { FEED_SYNC_LIMITS } from '@swarm/domain';
import { renderDispatch } from '@swarm/mail';
import { describe, expect, it } from 'vitest';
import {
  FeedError,
  buildFeedDispatch,
  digestSlotDue,
  feedAudience,
  feedBackoffMs,
  feedItemContent,
  feedItemKey,
  fetchFeed,
  htmlToBlocks,
  htmlToText,
  inQuietWindow,
  parseFeed,
  type DocNode,
} from '../src/index';

const FEED_URL = 'https://blog.example.com/feed.xml';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Field &amp; Stream Notes</title>
    <link>https://blog.example.com/</link>
    <item>
      <title>Second post</title>
      <link>https://blog.example.com/second</link>
      <guid isPermaLink="false">post-2</guid>
      <pubDate>Tue, 27 Oct 2026 09:00:00 GMT</pubDate>
      <description>A &lt;b&gt;short&lt;/b&gt; summary.</description>
      <content:encoded><![CDATA[<p>Hello <strong>there</strong>, <a href="/about">about</a>.</p><script>alert(1)</script><img src="https://cdn.example.com/a.png" alt="A fox">]]></content:encoded>
      <media:content url="https://cdn.example.com/cover.jpg" medium="image"/>
    </item>
    <item>
      <title>First post</title>
      <guid>https://blog.example.com/first</guid>
      <description>Just text</description>
      <enclosure url="https://cdn.example.com/first.jpg" type="image/jpeg" length="1"/>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="text">Atom Notes</title>
  <entry>
    <title type="html">Fish &amp;amp; chips</title>
    <id>urn:uuid:1225c695</id>
    <link rel="self" href="https://atom.example.com/self/1"/>
    <link rel="alternate" type="text/html" href="https://atom.example.com/posts/1"/>
    <updated>2026-10-27T18:30:02Z</updated>
    <summary>Short</summary>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Para <em>one</em></p><ul><li>a</li><li>b</li></ul></div></content>
  </entry>
</feed>`;

const JSON_VERSION = 'https://jsonfeed.org/version/1.1';
const JSON_FEED = JSON.stringify({
  version: JSON_VERSION,
  title: 'JSON Notes',
  items: [
    { id: 1, url: 'https://json.example.com/1', title: 'One', content_text: 'Line\n\nTwo' },
    {
      id: '2',
      url: 'https://json.example.com/2',
      content_html: '<p>Hi</p>',
      image: 'http://insecure.example.com/x.png',
    },
  ],
});

/** Renders blocks with the real renderer: what Feed Sync stores must always render. */
function renders(blocks: DocNode[]) {
  return renderDispatch(
    { type: 'doc', content: blocks.length ? blocks : [{ type: 'paragraph' }] },
    {
      channelName: 'Field Notes',
      accentColor: null,
      preheader: '',
      mediaUrl: () => null,
      allowHtmlBlocks: false,
      webUrl: null,
      ask: () => null,
    },
  );
}

describe('parseFeed', () => {
  it('reads RSS 2.0 with content:encoded, GUIDs, permalinks and media', () => {
    const feed = parseFeed(RSS, FEED_URL);
    expect(feed.format).toBe('rss');
    expect(feed.title).toBe('Field & Stream Notes');
    const [second, first] = feed.items;
    expect(second).toMatchObject({
      guid: 'post-2',
      link: 'https://blog.example.com/second',
      title: 'Second post',
      publishedAt: Date.UTC(2026, 9, 27, 9),
      image: 'https://cdn.example.com/cover.jpg',
      summary: 'A <b>short</b> summary.',
    });
    expect(second?.html).toContain('<strong>there</strong>');
    // A permalink GUID stands in for the missing link; the enclosure is the image.
    expect(first).toMatchObject({
      link: 'https://blog.example.com/first',
      html: 'Just text',
      image: 'https://cdn.example.com/first.jpg',
    });
  });

  it('reads Atom with the alternate link and xhtml content', () => {
    const feed = parseFeed(ATOM, FEED_URL);
    expect(feed).toMatchObject({ format: 'atom', title: 'Atom Notes' });
    const [entry] = feed.items;
    expect(entry).toMatchObject({
      guid: 'urn:uuid:1225c695',
      link: 'https://atom.example.com/posts/1',
      title: 'Fish & chips',
      publishedAt: Date.parse('2026-10-27T18:30:02Z'),
    });
    expect(entry?.html).toContain('<p>Para <em>one</em></p>');
    expect(entry?.summary).toBe('<p>Short</p>');
  });

  it('reads RSS 1.0 and JSON Feed', () => {
    const rdf = parseFeed(
      `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
        <channel rdf:about="https://x.example.com"><title>RDF</title></channel>
        <item rdf:about="https://x.example.com/1"><title>One</title><link>https://x.example.com/1</link><dc:date>2026-10-01T00:00:00Z</dc:date></item>
      </rdf:RDF>`,
      FEED_URL,
    );
    expect(rdf.items[0]).toMatchObject({ guid: 'https://x.example.com/1', title: 'One' });
    const json = parseFeed(JSON_FEED, FEED_URL);
    expect(json.format).toBe('json');
    expect(json.items[0]).toMatchObject({ guid: '1', html: '<p>Line</p><p>Two</p>' });
    // Plain http images are not kept.
    expect(json.items[1]).toMatchObject({ guid: '2', image: null });
  });

  it('refuses DTDs, entity bombs, other documents and other JSON', () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">]><rss><channel><title>&lol;</title></channel></rss>`;
    expect(() => parseFeed(bomb, FEED_URL)).toThrow(FeedError);
    expect(() => parseFeed(bomb, FEED_URL)).toThrow(/DOCTYPE/);
    expect(() => parseFeed('<html><body>hi</body></html>', FEED_URL)).toThrow(/not an RSS or Atom/);
    expect(() => parseFeed('{"items":[]}', FEED_URL)).toThrow(/not a JSON Feed/);
    expect(() => parseFeed('hello', FEED_URL)).toThrow(FeedError);
  });

  it('reads at most the first 50 items', () => {
    const items = Array.from(
      { length: 70 },
      (_, i) => `<item><title>Post ${i}</title><guid>g${i}</guid></item>`,
    ).join('');
    const feed = parseFeed(`<rss><channel><title>Many</title>${items}</channel></rss>`, FEED_URL);
    expect(feed.items).toHaveLength(FEED_SYNC_LIMITS.itemsPerFetch);
  });

  it('turns titles into plain text: tags dropped, entities decoded, spaces collapsed', () => {
    const titleOf = (title: string) =>
      parseFeed(JSON.stringify({ version: JSON_VERSION, title, items: [] }), FEED_URL).title;
    expect(titleOf('Hello <b>bold</b> &amp; <a href="/x?a=1">linked</a>')).toBe(
      'Hello bold & linked',
    );
    expect(titleOf('Line\n\n  two\tthree')).toBe('Line two three');
    expect(titleOf('&lt;em&gt;Entity tags&lt;/em&gt; stay as text')).toBe(
      '<em>Entity tags</em> stay as text',
    );
    // A tag runs from a '<' to the next '>'; a '<' with no '>' after it is kept.
    expect(titleOf('5 < 6 and 7 > 3')).toBe('5 3');
    expect(titleOf('a <<b> c')).toBe('a c');
    expect(titleOf('x <b>y</b> < z')).toBe('x y < z');
    expect(titleOf('I <3 feeds')).toBe('I <3 feeds');
    expect(titleOf('<b></b>')).toBeNull();
    expect(titleOf('word '.repeat(100))).toHaveLength(300);
    const rss = parseFeed(
      `<rss><channel><title><![CDATA[Fish <i>and</i> chips]]></title><item><title>&lt;b&gt;Bold&lt;/b&gt; news</title><guid>g</guid></item></channel></rss>`,
      FEED_URL,
    );
    expect(rss.title).toBe('Fish and chips');
    expect(rss.items[0]!.title).toBe('Bold news');
  });

  it('reads a long run of "<" in a title in linear time', () => {
    // A feed body is up to 2 MiB from a third party, and a title of '<' with no '>' took
    // quadratic time to strip of tags (seconds at this size, minutes at the cap).
    const title = '<'.repeat(200_000);
    const started = performance.now();
    const json = parseFeed(JSON.stringify({ version: JSON_VERSION, title, items: [] }), FEED_URL);
    const rss = parseFeed(
      `<rss><channel><title>${'&lt;'.repeat(200_000)}</title></channel></rss>`,
      FEED_URL,
    );
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(json.title).toBe('<'.repeat(300));
    expect(rss.title).toBe('<'.repeat(300));
  });
});

describe('item HTML into editor blocks', () => {
  it('keeps structure and marks, drops scripts and unsafe links, and always renders', () => {
    const blocks = htmlToBlocks(
      `<h1>Title</h1><h4>Small</h4>
       <p>Some <b>bold</b> and <a href="/rel">relative</a> and <a href="javascript:alert(1)">bad</a> text<br>next line</p>
       <div>Loose <span>text</span></div>
       <ul><li>One</li><li>Two <ol><li>Nested</li></ol></li></ul>
       <blockquote><p>Quoted</p></blockquote>
       <pre>  code\n  block</pre><hr>
       <a href="https://example.com/big"><img src="https://cdn.example.com/i.png" alt="Pic"></a>
       <img src="http://cdn.example.com/insecure.png"><img src="https://t.example.com/p.gif" width="1" height="1">
       <iframe src="https://evil.example.com"></iframe><style>p{}</style><form><input></form>
       <table><tr><td>Cell</td></tr></table>`,
      'https://blog.example.com/posts/1',
    );
    expect(blocks.map((b) => b.type)).toEqual([
      'heading',
      'heading',
      'paragraph',
      'paragraph',
      'bulletList',
      'blockquote',
      'codeBlock',
      'horizontalRule',
      'image',
      'paragraph',
    ]);
    expect(blocks[0]).toMatchObject({ attrs: { level: 1 } });
    expect(blocks[1]).toMatchObject({ attrs: { level: 3 } });
    const para = blocks[2]!.content!;
    expect(para.find((n) => n.text === 'bold')?.marks).toEqual([{ type: 'bold' }]);
    expect(para.find((n) => n.text === 'relative')?.marks).toEqual([
      { type: 'link', attrs: { href: 'https://blog.example.com/rel' } },
    ]);
    expect(para.find((n) => n.text?.includes('bad'))?.marks).toBeUndefined();
    expect(para.some((n) => n.type === 'hardBreak')).toBe(true);
    expect(blocks[8]).toEqual({
      type: 'image',
      attrs: { src: 'https://cdn.example.com/i.png', alt: 'Pic', href: 'https://example.com/big' },
    });
    expect(JSON.stringify(blocks)).not.toMatch(/evil|alert|insecure|p\{\}/);
    const rendered = renders(blocks);
    expect(rendered.html).toContain('Nested');
    expect(rendered.links).toContain('https://blog.example.com/rel');
  });

  it('decodes entities, collapses whitespace and handles broken markup', () => {
    const blocks = htmlToBlocks('<p>caf&eacute; &amp;&nbsp;more   text<p>second <b>unclosed', null);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.content![0]!.text).toBe('café & more text');
    expect(blocks[1]!.content!.map((n) => n.text)).toEqual(['second ', 'unclosed']);
    expect(htmlToText('<p>One</p><p>Two &lt;3</p><script>x</script>')).toBe('One Two <3');
    renders(blocks);
  });

  it('treats entity and tag names that Object.prototype has as unknown', () => {
    // A feed is third-party HTML: &constructor; or <toString> must not reach a built-in.
    for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(htmlToText(`<p>a &${name}; b</p>`), name).toBe(`a &${name}; b`);
      const blocks = htmlToBlocks(`<p><${name}>x</${name}> y</p>`, null);
      expect(blocks, name).toEqual([
        { type: 'paragraph', content: [{ type: 'text', text: 'x y' }] },
      ]);
      renders(blocks);
    }
  });

  it('skips raw-text elements to their end tag, in any case', () => {
    expect(htmlToText('<p>a</p><SCRIPT>if (x < 1) "</p>"</ScRiPt >b')).toBe('a b');
    expect(htmlToText('<p>a</p><style>p{}</style><textarea><b>t</b></textarea>c')).toBe('a c');
    expect(htmlToText('<p>a</p><title>T</title><xmp><p>x</p></xmp><noscript>n</noscript>d')).toBe(
      'a d',
    );
    expect(htmlToText('<template><p>t</p></template>e<script>s</scripts>f')).toBe('ef');
    expect(htmlToText('<p>a</p><style>never closed <p>b</p>')).toBe('a');
    expect(htmlToText('<p>a</p><script>x</script')).toBe('a');
    expect(htmlToText('<p>a</p><script>x</script><p>b</p><xmp>y</XMP><p>c</p>')).toBe('a b c');
    expect(htmlToBlocks('<p>One</p><script>bad()</script><p>Two</p>', null)).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'One' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Two' }] },
    ]);
  });

  it('reads many raw-text elements in linear time', () => {
    // Item HTML is up to 2 MiB from a third party; each raw-text tag used to lowercase the
    // whole document again to find its end tag.
    const html = `${'<xmp></xmp>'.repeat(20_000)}<p>${'word '.repeat(150_000)}</p>`;
    const started = performance.now();
    const blocks = htmlToBlocks(html, null);
    const text = htmlToText(html);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(blocks).toHaveLength(1);
    expect(text).toBe('word '.repeat(150_000).trim());
  });

  it('trims a <pre> block in linear time after a long run of whitespace', () => {
    // A trailing-whitespace regex was quadratic on a long run that is not at the end.
    const run = ' '.repeat(100_000);
    const started = performance.now();
    const blocks = htmlToBlocks(`<pre>a${run}b \n\t</pre>`, null);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(blocks).toEqual([{ type: 'codeBlock', content: [{ type: 'text', text: `a${run}b` }] }]);
  });

  it('caps the number of blocks and the stored size', () => {
    const many = '<p>x</p>'.repeat(1000);
    expect(htmlToBlocks(many, null)).toHaveLength(FEED_SYNC_LIMITS.blocksPerItem);
    const huge = `<p>${'word '.repeat(40_000)}</p>`.repeat(3);
    const content = feedItemContent(
      {
        guid: 'g',
        link: null,
        title: 't',
        publishedAt: null,
        html: huge,
        summary: null,
        image: null,
      },
      FEED_URL,
    );
    expect(new TextEncoder().encode(JSON.stringify(content)).length).toBeLessThanOrEqual(
      FEED_SYNC_LIMITS.itemDocumentBytes,
    );
    expect(content.summary.length).toBeLessThanOrEqual(FEED_SYNC_LIMITS.summaryChars);
  });
});

describe('dedupe keys', () => {
  it('uses the GUID, else the link and title', async () => {
    const a = await feedItemKey({ guid: 'x', link: 'https://a.example.com', title: 'A' });
    const b = await feedItemKey({ guid: 'x', link: 'https://b.example.com', title: 'B' });
    expect(a).toBe(b);
    const c = await feedItemKey({ guid: null, link: 'https://a.example.com', title: 'A' });
    const d = await feedItemKey({ guid: null, link: 'https://a.example.com', title: 'A2' });
    expect(c).not.toBe(d);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('buildFeedDispatch', () => {
  const item = (title: string) => ({
    title,
    link: `https://blog.example.com/${title}`,
    content: {
      blocks: [{ type: 'paragraph', content: [{ type: 'text', text: `${title} body` }] }],
      summary: `${title} summary`,
      image: 'https://cdn.example.com/c.jpg',
    },
  });
  const base = {
    contentMode: 'full' as const,
    subjectTemplate: null,
    feedTitle: 'Field Notes',
    timezone: 'Europe/Prague',
    template: null,
    now: Date.UTC(2026, 9, 28, 12),
  };

  it('one item: its title, its content, the image and a button to the original', () => {
    const built = buildFeedDispatch({ ...base, grouping: 'each', items: [item('Hello')] });
    expect(built.subject).toBe('Hello');
    expect(built.preheader).toBe('Hello summary');
    expect(built.content.content!.map((n) => n.type)).toEqual(['image', 'paragraph', 'button']);
    expect(renders(built.content.content!).links).toContain('https://blog.example.com/Hello');
  });

  it('a digest: linked headings, rules between items, the count and date in the subject', () => {
    const built = buildFeedDispatch({
      ...base,
      grouping: 'digest',
      contentMode: 'summary',
      subjectTemplate: '{{feed.title}} · {{count}} new · {{date}}',
      items: [item('A'), item('B')],
    });
    expect(built.subject).toBe('Field Notes · 2 new · 28 Oct 2026');
    expect(built.preheader).toBe('A · B');
    expect(built.content.content!.map((n) => n.type)).toEqual([
      'heading',
      'image',
      'paragraph',
      'horizontalRule',
      'heading',
      'image',
      'paragraph',
    ]);
    renders(built.content.content!);
  });

  it('puts the items at {{feed.items}} in the Template, or after its content', () => {
    const template = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Intro' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '{{feed.items}}' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Outro' }] },
      ],
    };
    const placed = buildFeedDispatch({ ...base, grouping: 'each', template, items: [item('X')] });
    const texts = placed.content.content!.map((n) => n.content?.[0]?.text ?? n.type);
    expect(texts).toEqual(['Intro', 'image', 'X body', 'button', 'Outro']);
    const appended = buildFeedDispatch({
      ...base,
      grouping: 'each',
      template: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] },
          { type: 'paragraph' },
        ],
      },
      items: [item('Y')],
    });
    expect(appended.content.content!.map((n) => n.type)).toEqual([
      'paragraph',
      'image',
      'paragraph',
      'button',
    ]);
  });
});

describe('feedAudience', () => {
  it('keeps the Circles and the Roster part, and drops an empty Roster part', () => {
    const rosters = {
      include: [`rs_${'1'.repeat(32)}`],
      exclude: [`rs_${'2'.repeat(32)}`],
      conflict: 'include_wins' as const,
    };
    const circle = `cl_${'3'.repeat(32)}`;
    expect(
      feedAudience({ audience_json: JSON.stringify({ include: [circle], exclude: [], rosters }) }),
    ).toEqual({ include: [circle], exclude: [], rosters });
    expect(
      feedAudience({
        audience_json: JSON.stringify({
          include: [],
          exclude: [],
          rosters: { include: [], exclude: [], conflict: 'exclude_wins' },
        }),
      }),
    ).toEqual({ include: [], exclude: [] });
    expect(feedAudience({ audience_json: '{}' })).toEqual({ include: [], exclude: [] });
  });
});

describe('quiet windows and backoff', () => {
  const at = (iso: string) => Date.parse(iso);
  it('handles windows that cross midnight, in the feed source’s time zone', () => {
    const window = { start: 22 * 60, end: 7 * 60, zone: 'Europe/Prague' };
    // 21:30 UTC is 22:30 in Prague (CET, UTC+1 at the end of October).
    expect(inQuietWindow(at('2026-10-28T21:30:00Z'), window)).toBe(true);
    expect(inQuietWindow(at('2026-10-28T05:59:00Z'), window)).toBe(true);
    expect(inQuietWindow(at('2026-10-28T06:00:00Z'), window)).toBe(false);
    expect(inQuietWindow(at('2026-10-28T12:00:00Z'), window)).toBe(false);
    const day = { start: 9 * 60, end: 17 * 60, zone: 'UTC' };
    expect(inQuietWindow(at('2026-10-28T12:00:00Z'), day)).toBe(true);
    expect(inQuietWindow(at('2026-10-28T17:00:00Z'), day)).toBe(false);
    expect(inQuietWindow(at('2026-10-28T12:00:00Z'), { start: null, end: null, zone: 'UTC' })).toBe(
      false,
    );
  });

  it('backs off exponentially up to a day', () => {
    expect(feedBackoffMs(60, 1)).toBe(3_600_000);
    expect(feedBackoffMs(60, 3)).toBe(4 * 3_600_000);
    expect(feedBackoffMs(60, 10)).toBe(FEED_SYNC_LIMITS.maxBackoffMs);
  });
});

describe('fetchFeed', () => {
  const deps = (answer: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    return {
      seen,
      deps: {
        environment: 'production',
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          seen.push({ url: String(input), init });
          return answer(String(input), init);
        }) as typeof fetch,
      },
    };
  };
  const none = { etag: null, lastModified: null };

  it('sends the validators and reads 200 and 304', async () => {
    const ok = deps(
      () =>
        new Response(RSS, {
          headers: { etag: '"v1"', 'last-modified': 'Tue, 27 Oct 2026 09:00:00 GMT' },
        }),
    );
    const result = await fetchFeed(FEED_URL, { etag: '"v0"', lastModified: 'yesterday' }, ok.deps);
    expect(result).toMatchObject({ notModified: false, etag: '"v1"' });
    const headers = new Headers(ok.seen[0]!.init?.headers);
    expect(headers.get('if-none-match')).toBe('"v0"');
    expect(headers.get('if-modified-since')).toBe('yesterday');
    expect(ok.seen[0]!.init?.redirect).toBe('manual');
    const unchanged = deps(() => new Response(null, { status: 304 }));
    expect(await fetchFeed(FEED_URL, none, unchanged.deps)).toEqual({ notModified: true });
  });

  it('re-checks every redirect and stops after three', async () => {
    const hop = deps((url) =>
      url === FEED_URL
        ? new Response(null, { status: 301, headers: { location: '/moved.xml' } })
        : new Response(RSS),
    );
    expect(await fetchFeed(FEED_URL, none, hop.deps)).toMatchObject({ notModified: false });
    expect(hop.seen.map((s) => s.url)).toEqual([FEED_URL, 'https://blog.example.com/moved.xml']);

    for (const target of [
      'http://127.0.0.1/admin',
      'https://localhost/x',
      'https://[::1]/',
      'http://plain.example.com/',
    ]) {
      const bad = deps(() => new Response(null, { status: 302, headers: { location: target } }));
      await expect(fetchFeed(FEED_URL, none, bad.deps)).rejects.toThrow(
        /redirected to an address that is not allowed/,
      );
      expect(bad.seen).toHaveLength(1);
    }
    const loop = deps(() => new Response(null, { status: 302, headers: { location: FEED_URL } }));
    await expect(fetchFeed(FEED_URL, none, loop.deps)).rejects.toThrow(/too many times/);
    expect(loop.seen).toHaveLength(FEED_SYNC_LIMITS.redirects + 1);
  });

  it('refuses private addresses before fetching, errors, oversized bodies and timeouts', async () => {
    const never = deps(() => new Response(RSS));
    await expect(fetchFeed('https://10.0.0.1/feed', none, never.deps)).rejects.toThrow(
      /not allowed/,
    );
    await expect(fetchFeed('http://blog.example.com/feed', none, never.deps)).rejects.toThrow(
      /https/,
    );
    expect(never.seen).toHaveLength(0);

    const missing = deps(() => new Response('nope', { status: 404 }));
    await expect(fetchFeed(FEED_URL, none, missing.deps)).rejects.toThrow('The feed answered 404.');

    const big = new Uint8Array(FEED_SYNC_LIMITS.fetchBytes + 1);
    const declared = deps(() => new Response(big));
    await expect(fetchFeed(FEED_URL, none, declared.deps)).rejects.toThrow(/larger than 2 MB/);
    const streamed = deps(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let i = 0; i < 3; i++) controller.enqueue(new Uint8Array(1024 * 1024));
              controller.close();
            },
          }),
        ),
    );
    await expect(fetchFeed(FEED_URL, none, streamed.deps)).rejects.toThrow(/larger than 2 MB/);

    const slow = deps(() => {
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      throw error;
    });
    await expect(fetchFeed(FEED_URL, none, slow.deps)).rejects.toThrow(/within 10 seconds/);

    // A body that breaks off or stalls past the timeout is a FeedError too, not a raw error.
    const breaking = (error: Error) =>
      deps(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('<rss>'));
                controller.error(error);
              },
            }),
          ),
      );
    const reset = fetchFeed(
      FEED_URL,
      none,
      breaking(new TypeError('Network connection lost.')).deps,
    );
    await expect(reset).rejects.toBeInstanceOf(FeedError);
    await expect(reset).rejects.toThrow('The feed stopped sending (Network connection lost.).');
    const stalled = fetchFeed(
      FEED_URL,
      none,
      breaking(new DOMException('The operation timed out.', 'TimeoutError')).deps,
    );
    await expect(stalled).rejects.toBeInstanceOf(FeedError);
    await expect(stalled).rejects.toThrow(/within 10 seconds/);
  });

  it('decodes the declared charset', async () => {
    const latin = new Uint8Array([
      ...new TextEncoder().encode('<rss><channel><title>Caf'),
      0xe9,
      ...new TextEncoder().encode('</title></channel></rss>'),
    ]);
    const result = await fetchFeed(
      FEED_URL,
      none,
      deps(
        () =>
          new Response(latin, {
            headers: { 'content-type': 'application/rss+xml; charset=ISO-8859-1' },
          }),
      ).deps,
    );
    expect(result.notModified === false && parseFeed(result.body, FEED_URL).title).toBe('Café');
  });
});

describe('a scheduled digest', () => {
  // Friday 7 November 2025, 09:00 UTC.
  const friday = Date.UTC(2025, 10, 7, 9, 0);
  const HOUR = 3_600_000;
  const schedule = { weekdays: [5], time: '09:00', zone: 'UTC', since: friday - 30 * 24 * HOUR };

  it('goes from its slot, and not a minute before', () => {
    expect(digestSlotDue(friday - 60_000, schedule, null)).toBe(false);
    expect(digestSlotDue(friday, schedule, null)).toBe(true);
    expect(digestSlotDue(friday + HOUR, schedule, null)).toBe(true);
  });

  it('goes once for each slot', () => {
    expect(digestSlotDue(friday + HOUR, schedule, friday + 60_000)).toBe(false);
    expect(digestSlotDue(friday + 7 * 24 * HOUR, schedule, friday + 60_000)).toBe(true);
  });

  it('waits for the next slot when a post appears long after this one', () => {
    expect(digestSlotDue(friday + 23 * HOUR, schedule, null)).toBe(true);
    expect(digestSlotDue(friday + 25 * HOUR, schedule, null)).toBe(false);
  });

  it('ignores a slot from before the schedule was set', () => {
    expect(digestSlotDue(friday + HOUR, { ...schedule, since: friday + 60_000 }, null)).toBe(false);
  });

  it('uses the source’s timezone, through a clock change', () => {
    // 09:00 in New York: 14:00 UTC after the clocks went back on 2 November 2025.
    const zone = { ...schedule, zone: 'America/New_York' };
    expect(digestSlotDue(Date.UTC(2025, 10, 7, 13, 59), zone, null)).toBe(false);
    expect(digestSlotDue(Date.UTC(2025, 10, 7, 14, 0), zone, null)).toBe(true);
  });
});
