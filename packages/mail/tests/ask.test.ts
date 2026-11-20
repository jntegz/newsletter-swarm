import { describe, expect, it } from 'vitest';
import {
  RenderError,
  personalize,
  renderDispatch,
  renderWeb,
  type AskPollView,
} from '../src/index';

const askId = `ak_${'1'.repeat(32)}`;
const questionId = `aq_${'2'.repeat(32)}`;
const yes = `ao_${'3'.repeat(32)}`;
const no = `ao_${'4'.repeat(32)}`;

const poll: AskPollView = {
  title: 'Reader poll',
  description: 'Help us <plan>',
  prompt: 'More fox stories?',
  status: 'open',
  options: [
    { id: yes, label: 'Yes & more' },
    { id: no, label: 'No' },
  ],
};

const doc = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
    { type: 'askPoll', attrs: { askId, questionId } },
  ],
};

const options = (ask?: (a: string, q: string) => AskPollView | null) => ({
  channelName: 'Field Notes',
  mediaUrl: () => null,
  allowHtmlBlocks: false,
  ...(ask ? { ask } : {}),
});

describe('askPoll in email', () => {
  it('renders one placeholder per option, escaped', () => {
    const out = renderDispatch(
      doc,
      options((a, q) => (a === askId && q === questionId ? poll : null)),
    );
    expect(out.html).toContain(`href="{{@ask:${yes}}}"`);
    expect(out.html).toContain(`href="{{@ask:${no}}}"`);
    expect(out.html).toContain('Yes &amp; more');
    expect(out.html).toContain('Help us &lt;plan&gt;');
    expect(out.text).toContain(`- No: {{@ask:${no}}}`);
    // Poll links are not tracked links.
    expect(out.links).toEqual([]);
  });

  it('refuses a poll that is not one of the Channel’s questions', () => {
    expect(() =>
      renderDispatch(
        doc,
        options(() => null),
      ),
    ).toThrow(RenderError);
    expect(() => renderDispatch(doc, options())).toThrow(RenderError);
  });

  it('warns when the Ask is not open', () => {
    const out = renderDispatch(
      doc,
      options(() => ({ ...poll, status: 'draft' })),
    );
    expect(out.warnings.some((w) => w.includes('still a draft'))).toBe(true);
  });

  it('personalize fills per-recipient links and falls back to #', () => {
    const template = renderDispatch(
      doc,
      options(() => poll),
    );
    const base = {
      link: () => '#',
      unsubscribeUrl: 'https://t.example/u/x',
      pixelUrl: null,
      member: { email: 'a@example.org' },
    };
    const filled = personalize(
      { html: template.html, text: template.text, subject: 's' },
      { ...base, ask: (o) => `https://forms.example/a/tok-${o === yes ? 'yes' : 'no'}&x` },
    );
    expect(filled.html).toContain('href="https://forms.example/a/tok-yes&amp;x"');
    expect(filled.text).toContain('- No: https://forms.example/a/tok-no&x');
    expect(filled.html).not.toContain('{{@ask:');
    const preview = personalize({ html: template.html, text: template.text, subject: 's' }, base);
    expect(preview.html).toContain('href="#"');
  });

  it('never expands a placeholder a Member typed into their name', () => {
    const template = { html: '<p>{{ first_name | there }}</p>', text: '', subject: '' };
    const filled = personalize(template, {
      link: () => '#',
      unsubscribeUrl: '#',
      pixelUrl: null,
      member: { email: 'a@example.org', firstName: `{{@ask:${yes}}}` },
      ask: () => 'https://evil.example',
    });
    expect(filled.html).toContain(`{{@ask:${yes}}}`);
    expect(filled.html).not.toContain('evil');
  });
});

describe('askPoll on the web', () => {
  it('links each option to the survey page', () => {
    const out = renderWeb(doc, {
      channelName: 'Field Notes',
      media: () => null,
      allowHtmlBlocks: false,
      ask: () => poll,
    });
    expect(out.freeHtml).toContain(`href="/_swarm/ask/${askId}?o=${yes}"`);
    expect(out.freeHtml).toContain('class="sw-poll"');
  });

  it('leaves out an unknown poll with a warning', () => {
    const out = renderWeb(doc, { channelName: 'F', media: () => null, allowHtmlBlocks: false });
    expect(out.freeHtml).not.toContain('sw-poll');
    expect(out.warnings.length).toBeGreaterThan(0);
  });
});
