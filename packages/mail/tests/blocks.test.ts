import { describe, expect, it } from 'vitest';
import { embedInfo, imageWidthPercent, personalize, renderDispatch, renderWeb } from '../src/index';

const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...content: unknown[]) => ({ type: 'doc', content });
const email = (document: unknown) =>
  renderDispatch(document, {
    channelName: 'Field Notes',
    mediaUrl: () => null,
    allowHtmlBlocks: false,
  });
const web = (document: unknown) =>
  renderWeb(document, { channelName: 'Field Notes', media: () => null, allowHtmlBlocks: false });

describe('embedInfo', () => {
  it('recognises the supported services', () => {
    expect(embedInfo('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toMatchObject({
      provider: 'YouTube',
      youtubeId: 'dQw4w9WgXcQ',
    });
    expect(embedInfo('https://youtu.be/dQw4w9WgXcQ')?.youtubeId).toBe('dQw4w9WgXcQ');
    expect(embedInfo('https://x.com/a/status/1')?.provider).toBe('X');
    expect(embedInfo('https://open.spotify.com/episode/1')?.provider).toBe('Spotify');
    expect(embedInfo('https://bsky.app/profile/a/post/1')?.provider).toBe('Bluesky');
  });

  it('refuses everything else, including look-alikes and plain http', () => {
    for (const bad of [
      'https://evil.example/watch?v=dQw4w9WgXcQ',
      'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
      'http://youtube.com/watch?v=dQw4w9WgXcQ',
      'javascript:alert(1)',
      'not a url',
      'https://youtube.com/watch?v=%22%3E%3Cscript%3E',
    ]) {
      expect(embedInfo(bad), bad).toBeNull();
    }
  });
});

describe('imageWidthPercent', () => {
  it('only takes the three sizes', () => {
    expect(imageWidthPercent(50)).toBe(50);
    for (const bad of [100, 0, '50', '50%;position:fixed', null]) {
      expect(imageWidthPercent(bad)).toBeNull();
    }
  });
});

describe('callouts', () => {
  const document = doc({ type: 'callout', content: [para('Note this')] });
  it('render in email and on the web', () => {
    expect(email(document).html).toContain('sw-callout');
    expect(email(document).text).toContain('Note this');
    expect(web(document).freeHtml).toContain('<aside class="sw-callout">');
  });
});

describe('columns', () => {
  const document = doc({
    type: 'columns',
    content: [
      { type: 'column', content: [para('Left')] },
      { type: 'column', content: [para('Right')] },
    ],
  });
  it('sit side by side, stack on a phone, and read in order in plain text', () => {
    const out = email(document);
    expect(out.html).toContain('class="sw-col"');
    expect(out.html).toContain('@media (max-width:620px)');
    expect(out.text.indexOf('Left')).toBeLessThan(out.text.indexOf('Right'));
    expect(web(document).freeHtml).toContain('sw-columns');
  });
  it('refuse any other shape', () => {
    const one = doc({ type: 'columns', content: [{ type: 'column', content: [para('x')] }] });
    expect(() => email(one)).toThrow(/two columns/);
    expect(() => web(one)).toThrow(/two columns/);
  });
  it('don’t carry the phone rule when unused', () => {
    expect(email(doc(para('Plain'))).html).not.toContain('sw-col{');
  });
});

describe('embeds', () => {
  const youtube = doc({ type: 'embed', attrs: { url: 'https://youtu.be/dQw4w9WgXcQ' } });
  it('show a thumbnail in email and nothing from the service on the web', () => {
    expect(email(youtube).html).toContain('img.youtube.com/vi/dQw4w9WgXcQ');
    const page = web(youtube).freeHtml;
    expect(page).toContain('Watch on YouTube');
    expect(page).not.toContain('<img');
    expect(page).not.toContain('<iframe');
  });
  it('refuse an unsupported link', () => {
    const bad = doc({ type: 'embed', attrs: { url: 'https://evil.example/x' } });
    expect(() => email(bad)).toThrow(/embedded/);
    expect(() => web(bad)).toThrow(/embedded/);
  });
});

describe('footnotes', () => {
  const note = (text: string) => ({ type: 'footnote', attrs: { text } });
  const document = doc({
    type: 'paragraph',
    content: [{ type: 'text', text: 'Claim' }, note('Source <one>'), note('Source two')],
  });
  it('number in order and list at the end, escaped', () => {
    const out = email(document);
    expect(out.html).toContain('<sup>[1]</sup><sup>[2]</sup>');
    expect(out.html).toContain('[1] Source &lt;one&gt;');
    expect(out.text).toContain('[2] Source two');
    const page = web(document).freeHtml;
    expect(page).toContain('href="#fn-1"');
    expect(page).toContain('id="fn-2"');
    expect(page).toContain('Source &lt;one&gt;');
  });
  it('need text', () => {
    const empty = doc({ type: 'paragraph', content: [note(' ')] });
    expect(() => email(empty)).toThrow(/footnote/i);
  });
  it('keep a paid part’s notes out of the free part', () => {
    const gated = doc(
      { type: 'paragraph', content: [{ type: 'text', text: 'Free' }, note('Free note')] },
      { type: 'gate' },
      { type: 'paragraph', content: [{ type: 'text', text: 'Paid' }, note('Paid note')] },
    );
    const out = web(gated);
    expect(out.freeHtml).toContain('Free note');
    expect(out.freeHtml).not.toContain('Paid note');
    expect(out.gatedHtml).toContain('Paid note');
    expect(out.gatedHtml).toContain('id="fn-2"');
  });
});

describe('image width', () => {
  it('applies in email and on the web, and ignores anything else', () => {
    const image = (widthPercent: unknown) =>
      doc({ type: 'image', attrs: { src: 'https://x.example/a.png', alt: 'A', widthPercent } });
    expect(email(image(50)).html).toContain('width="267"');
    expect(web(image(50)).freeHtml).toContain('sw-w-50');
    expect(email(image('50%;position:fixed')).html).toContain('width="534"');
  });
});

describe('email design', () => {
  const render = (design: Parameters<typeof renderDispatch>[1]['design']) =>
    renderDispatch(doc(para('Hello')), {
      channelName: 'Field Notes',
      mediaUrl: () => null,
      allowHtmlBlocks: false,
      design,
    });

  it('leaves the standard look alone without one', () => {
    expect(render(null).html).toContain('background:#fbfbfd');
  });

  it('applies font, colours, logo, header and footer', () => {
    const { html } = render({
      font: 'serif',
      pageColor: '#112233',
      cardColor: '#223344',
      textColor: '#334455',
      logoUrl: 'https://media.example/logo.png',
      header: 'Every Tuesday',
      footer: '1 Main St <Town>',
    });
    expect(html).toContain('font-family:Georgia');
    expect(html).toContain('background:#112233');
    expect(html).toContain('background:#223344');
    expect(html).toContain('color:#334455');
    expect(html).toContain('src="https://media.example/logo.png"');
    expect(html).toContain('Every Tuesday');
    expect(html).toContain('1 Main St &lt;Town&gt;');
    expect(html).toContain('{{@unsubscribe}}');
  });

  it('ignores a value that isn’t a colour or a safe address', () => {
    const { html } = render({
      pageColor: 'red;background:url(x)',
      logoUrl: 'javascript:alert(1)',
    });
    expect(html).toContain('background:#fbfbfd');
    expect(html).not.toContain('url(x)');
    expect(html).not.toContain('javascript:');
  });
});

describe('merge tags for custom fields', () => {
  const fill = (fields?: Record<string, string>) =>
    personalize(
      { html: 'City: {{ field.city | somewhere }}', text: 'x', subject: 's' },
      {
        link: () => '',
        unsubscribeUrl: '',
        pixelUrl: null,
        member: { email: 'a@example.org', ...(fields ? { fields } : {}) },
      },
    ).html;

  it('fills the value, escaped, or the fallback', () => {
    expect(fill({ city: 'Prague' })).toBe('City: Prague');
    expect(fill({ city: '<b>x</b>' })).toBe('City: &lt;b&gt;x&lt;/b&gt;');
    expect(fill()).toBe('City: somewhere');
  });

  it('doesn’t warn about them when rendering', () => {
    const out = renderDispatch(doc(para('Hi {{ field.city | there }}')), {
      channelName: 'Field Notes',
      mediaUrl: () => null,
      allowHtmlBlocks: false,
    });
    expect(out.warnings.join(' ')).not.toContain('Unknown merge tag');
  });

  it('shows the fallback on the website, never a reader’s data', () => {
    expect(web(doc(para('Hi {{ field.city | there }}'))).freeHtml).toContain('Hi there');
  });
});

describe('embed players', () => {
  const ID = '4iV5W9uYEdYUVa79Axb7Rh';
  it('are built from checked ids, with the privacy-friendly address where there is one', () => {
    expect(embedInfo('https://www.youtube.com/watch?v=dQw4w9WgXcQ')?.player).toEqual({
      src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      origin: 'https://www.youtube-nocookie.com',
      shape: 'video',
    });
    expect(embedInfo('https://vimeo.com/76979871')?.player).toEqual({
      src: 'https://player.vimeo.com/video/76979871?dnt=1',
      origin: 'https://player.vimeo.com',
      shape: 'video',
    });
    expect(embedInfo('https://vimeo.com/76979871/abc123def0')?.player?.src).toBe(
      'https://player.vimeo.com/video/76979871?dnt=1&h=abc123def0',
    );
    expect(embedInfo('https://vimeo.com/channels/staffpicks/76979871')?.player?.src).toBe(
      'https://player.vimeo.com/video/76979871?dnt=1',
    );
    expect(embedInfo(`https://open.spotify.com/intl-de/track/${ID}?si=x`)?.player).toEqual({
      src: `https://open.spotify.com/embed/track/${ID}`,
      origin: 'https://open.spotify.com',
      shape: 'short',
    });
    expect(embedInfo(`https://open.spotify.com/playlist/${ID}`)?.player?.shape).toBe('tall');
    expect(embedInfo(`https://open.spotify.com/episode/${ID}`)?.player?.shape).toBe('medium');
  });

  it('fall back to a plain link for anything that isn’t a clean id', () => {
    for (const url of [
      'https://vimeo.com/about',
      'https://vimeo.com/123/"><script>',
      'https://vimeo.com/76979871?h=%22%3E',
      'https://open.spotify.com/episode/1',
      `https://open.spotify.com/user/${ID}`,
      `https://open.spotify.com/track/${ID}/../../evil`,
      'https://x.com/a/status/1',
      'https://bsky.app/profile/a/post/1',
    ]) {
      const info = embedInfo(url);
      expect(info, url).not.toBeNull();
      expect(info?.player, url).toBeNull();
    }
  });

  const video = doc({ type: 'embed', attrs: { url: 'https://youtu.be/dQw4w9WgXcQ' } });
  const withPlayers = (document: unknown) =>
    renderWeb(document, {
      channelName: 'C',
      media: () => null,
      allowHtmlBlocks: false,
      players: true,
    });

  it('stay out of the page unless it asks for them', () => {
    const plain = web(video);
    expect(plain.freeHtml).not.toContain('sw-player');
    expect(plain.freePlayers).toEqual([]);
  });

  it('wrap the link card with the address and a hidden button, and load nothing', () => {
    const out = withPlayers(video);
    expect(out.freeHtml).toContain('class="sw-link-card" href="https://youtu.be/dQw4w9WgXcQ"');
    expect(out.freeHtml).toContain(
      'data-sw-src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"',
    );
    expect(out.freeHtml).toContain('<div class="sw-player-load" hidden>');
    expect(out.freeHtml).toContain('loads from YouTube');
    expect(out.freeHtml).not.toMatch(/<iframe|<img|<script|style=/);
    expect(out.freePlayers).toEqual(['https://www.youtube-nocookie.com']);
    expect(out.text).toBe(web(video).text);
  });

  it('list each part’s players apart, so a gated one stays with the gated part', () => {
    const out = withPlayers({
      type: 'doc',
      content: [
        { type: 'embed', attrs: { url: 'https://youtu.be/dQw4w9WgXcQ' } },
        { type: 'gate' },
        { type: 'embed', attrs: { url: 'https://vimeo.com/76979871' } },
      ],
    });
    expect(out.freePlayers).toEqual(['https://www.youtube-nocookie.com']);
    expect(out.gatedPlayers).toEqual(['https://player.vimeo.com']);
    expect(out.freeHtml).not.toContain('vimeo');
  });

  it('leave out a player whose block doesn’t show on the web', () => {
    const out = withPlayers(
      doc({ type: 'embed', attrs: { url: 'https://vimeo.com/76979871', showOn: 'email' } }),
    );
    expect(out.freePlayers).toEqual([]);
    expect(out.freeHtml).toBe('');
  });

  it('keep the link for X and Bluesky', () => {
    const out = withPlayers(doc({ type: 'embed', attrs: { url: 'https://x.com/a/status/1' } }));
    expect(out.freeHtml).toContain('sw-link-card');
    expect(out.freeHtml).not.toContain('sw-player');
    expect(out.freePlayers).toEqual([]);
  });
});
