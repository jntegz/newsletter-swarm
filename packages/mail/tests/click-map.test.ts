import { describe, expect, it } from 'vitest';
import { formatClickShare, markClickMap, renderDispatch, shareLinks } from '../src';

const counts = [
  { position: 0, people: 30, clicks: 40 },
  { position: 1, people: 5, clicks: 10 },
  { position: 2, people: 0, clicks: 0 },
];

/** Tags and attributes as a browser would meet them: nothing here may survive into `out`. */
function expectInert(out: string) {
  expect(out).not.toMatch(/\{\{@/);
  expect(out).not.toMatch(/<script|<iframe|<object|<embed|<form|<link|<base|<svg|<video|<audio/i);
  expect(out).not.toMatch(/<meta[^>]*refresh/i);
  expect(out).not.toMatch(/\son[a-z]+\s*=/i);
  expect(out).not.toMatch(/javascript:/i);
  expect(out).not.toMatch(/url\(|@import/i);
  // No href at all: even a fragment would load the page around the frame.
  expect(out).not.toMatch(/\shref\s*=/i);
}

describe('markClickMap', () => {
  it('marks each link with its number, people and share of clicks', () => {
    const { html, links } = markClickMap(
      '<p><a href="{{@link:1}}">One</a> and <a href="{{@link:0}}">Two</a></p>',
      counts.slice(0, 2),
    );
    // Numbered in reading order, tied to the target by the placeholder's position.
    expect(links.map((l) => [l.number, l.position, l.people, l.clicks, l.share])).toEqual([
      [1, 1, 5, 10, 0.2],
      [2, 0, 30, 40, 0.8],
    ]);
    expect(links.map((l) => l.level)).toEqual([1, 4]);
    expect(html).toContain('#1 · 5 people · 20%');
    expect(html).toContain('#2 · 30 people · 80%');
    expect(html).not.toContain('{{@link');
  });

  it('shows the shared count on every use of one target, and counts its clicks once', () => {
    const { html, links } = markClickMap(
      '<a href="{{@link:0}}">Top</a><a href="{{@link:1}}">Mid</a><a href="{{@link:0}}">Bottom</a>',
      counts.slice(0, 2),
    );
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ occurrences: 2, people: 30, clicks: 40, share: 0.8 });
    expect(html.match(/#1 · 30 people · 80% · shared count/g)).toHaveLength(2);
    expect(links.reduce((sum, l) => sum + l.share, 0)).toBeCloseTo(1);
  });

  it('removes the open pixel and every other per-recipient placeholder, wherever it is', () => {
    const { html } = markClickMap(
      `<body><p title="{{@pixel}}">{{@pixel}} {{@link:0}} {{@unsubscribe}}</p>
       <img src="{{@link:0}}" alt="a"><img src="{{@pixel}}" alt="b">
       <a href="{{@unsubscribe}}">Leave</a><a href="{{@member_center}}">Center</a>
       <a href="{{@ask:ao_00000000000000000000000000000000}}">Yes</a>{{@pixel}}</body>`,
      counts,
    );
    expectInert(html);
    expect(html).not.toContain('<img');
    // Real parts of the email, with nothing to count.
    expect(html).toContain('>Leave</a>');
    expect(html).not.toMatch(/Leave<\/a><span/);
  });

  it('removes pixels a raw block brought along, and keeps real images', () => {
    const { html } = markClickMap(
      `<img src="https://t.example/x.gif" width="1" height="1" alt="">
       <img src="https://t.example/y.gif" style="width:1px;height:1px" alt="">
       <img src="https://t.example/z.gif" style="display:none" alt="">
       <img src="https://mail.example/o/abc.def" alt="">
       <img src="https://mail.example/c/abc.def" alt="">
       <img src="data:image/svg+xml;base64,AAAA" alt="">
       <img src="https://cdn.example/photo.jpg" width="560" alt="A photo">`,
      [],
    );
    expect(html.match(/<img/g)).toHaveLength(1);
    expect(html).toContain('src="https://cdn.example/photo.jpg"');
    expect(html).toContain('alt="A photo"');
  });

  it('shows merge tags as their fallback, and unknown tags as written', () => {
    const { html } = markClickMap(
      '<p>Hi {{ first_name | there }}, {{ last_name }}{{ email | you }} {{ field.city | Oslo }} {{ other }}</p>',
      [],
    );
    expect(html).toContain('<p>Hi there, you Oslo {{ other }}</p>');
  });

  it('passes a merge tag fallback through the same checks', () => {
    const { html } = markClickMap(
      '<p>{{ first_name | <img src=x onerror=alert(1)> <script>alert(1)</script> }}</p>',
      [],
    );
    expectInert(html);
    expect(html).not.toContain('onerror');
  });

  it('turns hostile HTML into something that can do nothing', () => {
    const hostile = `
      <script>fetch('https://evil.example')</script>
      <SCRIPT SRC=https://evil.example/a.js></SCRIPT>
      <base href="https://evil.example/">
      <meta http-equiv="refresh" content="0;url=https://evil.example">
      <link rel="stylesheet" href="https://evil.example/a.css">
      <iframe src="https://evil.example"></iframe>
      <object data="https://evil.example"></object><embed src="https://evil.example">
      <form action="https://evil.example"><input type="image" src="https://evil.example/i"></form>
      <svg onload="alert(1)"><image href="https://evil.example/i"/></svg>
      <video poster="https://evil.example/p" src="https://evil.example/v"></video>
      <img src=x onerror="alert(1)">
      <img src="javascript:alert(1)" alt="">
      <p onclick="alert(1)" style="background:url(https://evil.example/b)" background="https://evil.example/c">x</p>
      <div style="background:&#117;rl(https://evil.example/d);color:red">y</div>
      <div style="background:\\75 rl(https://evil.example/e)">z</div>
      <style>@import url(https://evil.example/f.css);</style>
      <style>p{background:url(https://evil.example/g)}</style>
      <a href="javascript:alert(1)">bad</a>
      <a href="JaVa&#115;cript:alert(1)" onclick="alert(1)" ping="https://evil.example/p" target="_top">worse</a>
      <a title=">" href="https://evil.example/q">quoted</a>
      <!--><script>alert(1)</script>-->
      <!--[if mso]><img src="https://evil.example/mso"><![endif]-->
      <textarea><img src="https://evil.example/t"></textarea>
      <noscript><img src="https://evil.example/n.gif" width=1></noscript>
      <math><a href="https://evil.example/m">m</a></math>
      <img src="https://evil.example/unterminated`;
    const { html } = markClickMap(hostile, []);
    expectInert(html);
    expect(html).not.toContain('evil.example');
    expect(html).toContain('color:red');
  });

  it('drops a style holding an entity named like an Object.prototype member', () => {
    // An entity it can't read could spell out anything, so the style goes, as for any other.
    for (const name of ['constructor', 'valueOf', 'proto']) {
      const { html } = markClickMap(`<div style="color:red&${name};">y</div>`, []);
      expect(html, name).not.toContain('style=');
      expect(html, name).not.toContain('native code');
    }
  });

  it('holds the policy first, so nothing in the email comes before it', () => {
    const { html } = markClickMap('<head><title>x</title></head><body><p>Hi</p></body>', []);
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<p>'));
    expect(html).toMatch(
      /^<!doctype html><html lang="en"><head><meta http-equiv="Content-Security/,
    );
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain('<title>x');
  });

  it('marks links in raw HTML as not counted, and sends them nowhere', () => {
    const { html, links, uncountedLinks } = markClickMap(
      '<a href="https://raw.example/a?x=1&amp;y=2">Raw</a><a href="mailto:a@example.com">Mail</a>',
      [{ position: 0, people: 0, clicks: 0 }],
    );
    expect(uncountedLinks).toBe(1);
    expect(html).toContain('Not counted');
    expect(html.match(/Not counted/g)).toHaveLength(1);
    expect(html).not.toContain('raw.example');
    expect(html).not.toContain('mailto:');
    expect(links).toEqual([]);
  });

  it('treats a placeholder with no target as not counted', () => {
    const { links, uncountedLinks } = markClickMap('<a href="{{@link:9}}">Old</a>', [
      { position: 0, people: 0, clicks: 0 },
    ]);
    expect(links).toEqual([]);
    expect(uncountedLinks).toBe(1);
  });

  it('closes a link left open, so the badge still lands', () => {
    const { html } = markClickMap('<p><a href="{{@link:0}}">One<a href="{{@link:1}}">Two', counts);
    expect(html).toContain('One</a><span');
    expect(html).toContain('Two</a><span');
  });

  it('keeps clicks on a link missing from the HTML in the list and in the shares', () => {
    const { links } = markClickMap('<a href="{{@link:0}}">One</a>', counts);
    expect(links.map((l) => [l.position, l.occurrences])).toEqual([
      [0, 1],
      [1, 0],
    ]);
    expect(links[0]?.share).toBe(0.8);
  });

  it('lists every target only when asked', () => {
    const none = '<p>Old</p>';
    expect(markClickMap(none, counts).links.map((l) => l.position)).toEqual([0, 1]);
    expect(markClickMap(none, counts, { listEvery: true }).links.map((l) => l.position)).toEqual([
      0, 1, 2,
    ]);
  });

  it('shows no share and the lightest level with no clicks at all', () => {
    const { links, html } = markClickMap('<a href="{{@link:0}}">One</a>', [
      { position: 0, people: 0, clicks: 0 },
    ]);
    expect(links[0]).toMatchObject({ share: 0, level: 0 });
    expect(html).toContain('#1 · 0 people · 0%');
  });

  it('copes with empty and malformed templates', () => {
    for (const input of ['', '<', '<a', '<a href="', '</', '<!--', '<style>', '<plaintext>x<p>']) {
      expect(() => markClickMap(input, counts)).not.toThrow();
    }
  });

  it('marks what the renderer really writes, with no pixel or placeholder left', () => {
    const render = (paidVariant: 'full' | 'teaser') =>
      renderDispatch(
        {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Hi {{ first_name | friend }}, ' },
                {
                  type: 'text',
                  text: 'read',
                  marks: [{ type: 'link', attrs: { href: 'https://a.example/' } }],
                },
              ],
            },
            { type: 'button', attrs: { href: 'https://a.example/', label: 'Again' } },
            { type: 'gate' },
            { type: 'button', attrs: { href: 'https://b.example/', label: 'Paid' } },
            {
              type: 'smartBlock',
              attrs: { condition: { all: [] } },
              content: [
                { type: 'button', attrs: { href: 'https://c.example/', label: 'Some readers' } },
              ],
            },
            { type: 'htmlBlock', attrs: { html: '<a href="https://raw.example/">Raw</a>' } },
          ],
        },
        {
          channelName: 'Field Notes',
          mediaUrl: () => null,
          allowHtmlBlocks: true,
          webVisibility: 'paid',
          paidVariant,
          webUrl: 'https://site.example/p',
        },
      );
    const { full, teaser } = shareLinks(render('full'), render('teaser'));
    const targets = full.links.map((_, position) => ({ position, people: 1, clicks: 1 }));
    const fullMap = markClickMap(full.html, targets);
    expectInert(fullMap.html);
    expect(fullMap.hasSmartBlocks).toBe(true);
    expect(fullMap.uncountedLinks).toBe(1);
    expect(fullMap.html).toContain('Hi friend, ');
    expect(fullMap.html).toContain('shared count');
    expect(fullMap.html).toContain('Some readers');
    expect(fullMap.html).not.toContain('swarm:sb');
    expect(fullMap.links.filter((l) => l.occurrences > 0).map((l) => l.position)).toEqual([
      0, 1, 2,
    ]);
    // The teaser's links are numbered into the shared list: only its own show on its map.
    const teaserMap = markClickMap(
      teaser.html,
      targets.map((t) => ({ ...t, people: 0, clicks: 0 })),
    );
    expectInert(teaserMap.html);
    expect(teaserMap.html).not.toContain('Paid');
    expect(teaserMap.links.map((l) => full.links[l.position])).toEqual([
      'https://a.example/',
      'https://site.example/p',
    ]);
  });
});

describe('formatClickShare', () => {
  it('never rounds a real share down to nothing', () => {
    expect(formatClickShare(0)).toBe('0%');
    expect(formatClickShare(0.001)).toBe('under 1%');
    expect(formatClickShare(0.416)).toBe('42%');
    expect(formatClickShare(1)).toBe('100%');
  });
});
