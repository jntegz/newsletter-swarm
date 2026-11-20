// Code embeds on the Dispatch page: highlighted by classes the site stylesheet colours (no inline
// styles, no script, so the CSP holds), anchored headings and a table of contents.
import { describe, expect, it } from 'vitest';
import type { SiteChannel } from '../src/context';
import type { SiteDispatch } from '../src/render/data';
import { renderDispatch } from '../src/render/dispatch';
import { siteCss } from '../src/render/theme';

const text = (value: string) => ({ type: 'text', text: value });
const dispatch: SiteDispatch = {
  id: 'dp_x',
  subject: 'Guide',
  preheader: '',
  contentJson: JSON.stringify({
    type: 'doc',
    content: [
      { type: 'tableOfContents', attrs: {} },
      { type: 'heading', attrs: { level: 2 }, content: [text('Install it')] },
      { type: 'codeBlock', attrs: { language: 'bash' }, content: [text('npm i x # go')] },
    ],
  }),
  visibility: 'public',
  coverMediaId: null,
  coverAlt: '',
  publishedAt: 0,
  updatedAt: 0,
  sectionId: null,
  slug: 'guide',
  createdBy: null,
};
const context = { channelName: 'Field Notes', media: new Map(), allowHtmlBlocks: false };

describe('code embeds on the site', () => {
  it('highlights with classes and links the headings with the flag', () => {
    const { freeHtml } = renderDispatch(dispatch, { ...context, codeEmbeds: true });
    expect(freeHtml).toContain('<span class="sw-tk-com"># go</span>');
    expect(freeHtml).toContain('<h3 id="install-it">');
    expect(freeHtml).toContain('<a href="#install-it">Install it</a>');
    expect(freeHtml).not.toMatch(/style=|<script/);
  });

  it('renders code plainly and leaves the contents out without it', () => {
    const { freeHtml } = renderDispatch(dispatch, context);
    expect(freeHtml).not.toContain('sw-tk-');
    expect(freeHtml).not.toContain('sw-toc');
    expect(freeHtml).toContain('npm i x # go');
  });

  it('colours tokens in light and dark schemes from the stylesheet', () => {
    const css = siteCss({ branding: {}, settings: { cacheVersion: 1 } } as unknown as SiteChannel);
    expect(css).toContain('.sw-prose .sw-tk-kw{color:#5636e8}');
    expect(css).toContain('html[data-scheme=dark] .sw-prose .sw-tk-kw{color:#b9a8ff}');
    expect(css).toContain(
      '@media (prefers-color-scheme:dark){html[data-scheme=auto] .sw-prose .sw-tk-kw',
    );
    expect(css).toContain('.sw-toc{');
  });
});
