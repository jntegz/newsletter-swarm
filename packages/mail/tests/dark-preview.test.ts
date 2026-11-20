import { describe, expect, it } from 'vitest';
import { darkEmail } from '../src/dark-preview';
import { renderDispatch } from '../src/index';

const render = (...content: unknown[]) =>
  renderDispatch(
    { type: 'doc', content },
    { channelName: 'Field Notes', mediaUrl: () => null, allowHtmlBlocks: true },
  ).html;
const para = (value: string) => ({ type: 'paragraph', content: [{ type: 'text', text: value }] });
const raw = (html: string) => ({ type: 'htmlBlock', attrs: { html } });

describe('the dark view of an email', () => {
  it('darkens the page and the card, and makes the email’s own text readable', () => {
    const out = darkEmail(render({ ...para('Hello'), type: 'paragraph' }));
    expect(out.problems).toEqual([]);
    expect(out.html).toContain('content="dark"');
    expect(out.html).not.toContain('background:#ffffff');
    expect(out.html).not.toContain('background:#fbfbfd');
    expect(out.html).not.toContain('color:#3a3a44');
    expect(out.html).toContain('background:#1c1c1f');
    expect(out.html).toContain('Hello');
  });

  it('shows black text with no background of its own, and names it', () => {
    const out = darkEmail(render(raw('<p style="color:#000">Lost in the dark</p>')));
    expect(out.html).toContain('style="color:#000"');
    expect(out.problems).toEqual(['Lost in the dark']);
  });

  it('catches the other ways of writing a dark colour', () => {
    for (const color of ['black', '#111', 'rgb(20, 20, 20)', '#222222']) {
      const out = darkEmail(render(raw(`<div style='color: ${color}'>Dim</div>`)));
      expect(out.problems).toEqual(['Dim']);
    }
  });

  it('passes dark text that has a background of its own, and lightens both', () => {
    const out = darkEmail(render(raw('<p style="background:#fff;color:#000">On white</p>')));
    expect(out.problems).toEqual([]);
    expect(out.html).not.toContain('color:#000');
  });

  it('passes text inside a block with a background', () => {
    const out = darkEmail(
      render(raw('<div style="background-color:#ffffff"><span style="color:#000">In</span></div>')),
    );
    expect(out.problems).toEqual([]);
  });

  it('leaves a dark background and its light text alone', () => {
    const out = darkEmail(render(raw('<p style="background:#101010;color:#ffffff">Dark</p>')));
    expect(out.problems).toEqual([]);
    expect(out.html).toContain('background:#101010');
    expect(out.html).toContain('color:#ffffff');
  });

  it('keeps a button’s colours and images as they are', () => {
    const html = render(
      { type: 'button', attrs: { href: 'https://example.com', label: 'Go' } },
      { type: 'image', attrs: { src: 'https://example.com/logo.png', alt: 'Logo' } },
    );
    const out = darkEmail(html);
    expect(out.problems).toEqual([]);
    expect(out.html).toContain('background:#6c4cf1');
    expect(out.html).toContain('color:#ffffff');
    expect(out.html).toContain('src="https://example.com/logo.png"');
  });

  it('does not report a link in a dark accent colour', () => {
    const html = renderDispatch(
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'A link',
                marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
              },
            ],
          },
        ],
      },
      {
        channelName: 'Field Notes',
        accentColor: '#14203a',
        mediaUrl: () => null,
        allowHtmlBlocks: false,
      },
    ).html;
    const out = darkEmail(html);
    expect(out.problems).toEqual([]);
    expect(out.html).not.toContain('color:#14203a;text-decoration');
  });

  it('keeps the head’s style element, placeholders and text as written', () => {
    const html = render(para('A & B'));
    const out = darkEmail(`${html.replace('</head>', '<style>a{color:#000}</style></head>')}`);
    expect(out.html).toContain('<style>a{color:#000}</style>');
    expect(out.html).toContain('{{@pixel}}');
    expect(out.html).toContain('A &amp; B');
    expect(out.problems).toEqual([]);
  });

  it('copes with broken raw HTML', () => {
    const out = darkEmail(render(raw('<p style="color:#000">Open <b>never closed')));
    expect(out.problems[0]).toContain('Open never closed');
  });

  it('shortens a long piece of text', () => {
    const out = darkEmail(render(raw(`<p style="color:#000">${'word '.repeat(40)}</p>`)));
    expect(out.problems[0]?.endsWith('…')).toBe(true);
    expect(out.problems[0]?.length).toBeLessThan(60);
  });
});
