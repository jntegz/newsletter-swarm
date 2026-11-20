import { describe, expect, it } from 'vitest';
import {
  CONTENT_LIMITS,
  PUBLIC_LINK_SHORTENERS,
  SPAM_TRIGGER_PHRASES,
  checkContent,
  registrableDomain,
  renderDispatch,
  type ContentCheckInput,
} from '../src/index';

const text = (value: string, href?: string) => ({
  type: 'text',
  text: value,
  ...(href ? { marks: [{ type: 'link', attrs: { href } }] } : {}),
});
const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const image = (src: string, alt = 'A photo') => ({ type: 'image', attrs: { src, alt } });
const doc = (...content: unknown[]) => ({ type: 'doc', content });

/** Renders with the real renderer, so the checks read exactly what a send would carry. */
function email(
  document: unknown,
  extra: Partial<ContentCheckInput> & { design?: { logoUrl?: string | null } } = {},
): ContentCheckInput {
  const { design, ...rest } = extra;
  const rendered = renderDispatch(document, {
    channelName: 'Field Notes',
    mediaUrl: () => null,
    allowHtmlBlocks: false,
    ...(design ? { design } : {}),
  });
  return {
    subject: 'What we learned from a year of field recordings',
    preheader: 'Three places worth the walk, and one that was not.',
    html: rendered.html,
    text: rendered.text,
    links: rendered.links,
    ...rest,
  };
}

const ids = (input: ContentCheckInput) => checkContent(input).map((advice) => advice.id);

const LONG =
  'We spent most of the spring walking the estuary with a recorder and a flask of tea, and came back with more questions than tape. Here is what the first season taught us about patience.';

describe('an ordinary newsletter', () => {
  it('gets no advice at all', () => {
    const input = email(
      doc(
        { type: 'heading', attrs: { level: 2 }, content: [text('The estuary at dawn')] },
        para(text(LONG)),
        image('https://media.example.com/estuary.jpg'),
        para(
          text('Read the full notes on '),
          text('our website', 'https://fieldnotes.example.com/estuary'),
          text(', or see the map at '),
          text('fieldnotes.example.com/map', 'https://fieldnotes.example.com/map'),
          text('. We wrote this with Node.js and a '),
          text('README.md', 'https://github.com/fieldnotes/tools'),
          text('.'),
        ),
        para(text('This offer of a free gift is, for once, not a trick: act now if you like tea.')),
      ),
    );
    expect(checkContent(input)).toEqual([]);
  });

  it('is fine with a short acronym subject, one exclamation mark and a price', () => {
    for (const subject of [
      'NASA and the BBC',
      'We did it!',
      'Tickets from $5',
      'Is this the end? Really?',
      '日本語のニュースレター第十二号です',
    ]) {
      expect(ids(email(doc(para(text(LONG))), { subject })), subject).toEqual([]);
    }
  });

  it('never throws on rubbish', () => {
    expect(
      checkContent({
        subject: 'x'.repeat(5),
        preheader: 'p',
        html: '<a href="{{@link:99}}">https://a.com</a><im<a href="',
        text: '',
        links: ['not a url', 'mailto:a@b.example', '{{web_url}}'],
      }),
    ).toEqual([]);
  });
});

describe('the subject', () => {
  const subject = (value: string) => ids(email(doc(para(text(LONG))), { subject: value }));

  it('flags capitals only when most of a real subject is capitals', () => {
    expect(subject('HUGE NEWS FOR EVERY READER')).toEqual(['subject_caps']);
    expect(subject('BREAKING: the estuary floods again this week')).toEqual([]);
    expect(subject('HELLO')).toEqual([]);
  });

  it('flags repeated marks and a pile of exclamation marks', () => {
    expect(subject('You will not believe this!!!')).toEqual(['subject_punctuation']);
    expect(subject('Save $$$ today')).toEqual(['subject_punctuation']);
    expect(subject('Wait! What! No! Yes!')).toEqual(['subject_punctuation']);
    expect(subject('Really?? Yes!')).toEqual([]);
  });

  it('flags a very long subject and names its length', () => {
    const long = 'A subject that keeps going '.repeat(4).trim();
    expect(long.length).toBeGreaterThan(CONTENT_LIMITS.subjectMaxLength);
    const advice = checkContent(email(doc(para(text(LONG))), { subject: long }));
    expect(advice.map((a) => a.id)).toEqual(['subject_long']);
    expect(advice[0]!.message).toContain(`${long.length} characters`);
    expect(subject('x'.repeat(CONTENT_LIMITS.subjectMaxLength))).toEqual([]);
  });

  it('flags a subject that says nothing, but leaves an empty one to the blocking check', () => {
    expect(subject('...')).toEqual(['subject_thin']);
    expect(subject('Hi')).toEqual(['subject_thin']);
    expect(subject('Untitled')).toEqual(['subject_thin']);
    expect(subject('test')).toEqual(['subject_thin']);
    expect(subject('   ')).toEqual([]);
    expect(subject('May')).toEqual([]);
  });
});

describe('preview text', () => {
  it('is advised when missing', () => {
    expect(ids(email(doc(para(text(LONG))), { preheader: '  ' }))).toEqual(['preview_text']);
  });
});

describe('spam phrases', () => {
  it('needs several different phrases before saying anything', () => {
    expect(SPAM_TRIGGER_PHRASES.length).toBeLessThanOrEqual(30);
    const two = email(doc(para(text(`${LONG} Act now for a free gift.`))));
    expect(ids(two)).toEqual([]);
    const repeated = email(doc(para(text(`${LONG} Act now. Act now. ACT NOW. Act now.`))));
    expect(ids(repeated)).toEqual([]);
    const three = email(
      doc(para(text(`${LONG} Act now for a FREE GIFT, risk-free, with no obligation.`))),
    );
    const advice = checkContent(three);
    expect(advice.map((a) => a.id)).toEqual(['spam_phrases']);
    expect(advice[0]!.message).toContain('"act now"');
    expect(advice[0]!.message).toContain('"risk free"');
  });

  it('counts the subject, matches whole phrases only and ignores the footer', () => {
    const input = email(doc(para(text(`${LONG} Order now, while supplies last.`))), {
      subject: 'A limited time offer for readers',
    });
    expect(ids(input)).toEqual(['spam_phrases']);
    // "factory nowhere" contains "act now" as letters, not as words.
    const inside = email(
      doc(para(text(`${LONG} The factory nowhere near here: reorder nowadays.`))),
    );
    expect(ids(inside)).toEqual([]);
  });
});

describe('links', () => {
  const withLink = (href: string, shown = 'this page') =>
    email(doc(para(text(LONG)), para(text('See '), text(shown, href), text('.'))));

  it('flags public shorteners by name', () => {
    expect(PUBLIC_LINK_SHORTENERS).toContain('bit.ly');
    const advice = checkContent(withLink('https://bit.ly/3abc'));
    expect(advice.map((a) => a.id)).toEqual(['link_shortener']);
    expect(advice[0]!.message).toContain('bit.ly');
    expect(ids(withLink('https://www.tinyurl.com/x'))).toEqual(['link_shortener']);
  });

  it('never flags the publication’s own short-link domain', () => {
    expect(ids(withLink('https://go.fieldnotes.example/3abc'))).toEqual([]);
    // Even one that shares a name with a public shortener, when the publication says it is theirs.
    const own = { ...withLink('https://t.ly/3abc'), ownHosts: ['t.ly'] };
    expect(ids(own)).toEqual([]);
  });

  it('flags link text that is an address on another site', () => {
    const advice = checkContent(withLink('https://evil.example.net/login', 'https://mybank.com'));
    expect(advice.map((a) => a.id)).toEqual(['link_text_mismatch']);
    expect(advice[0]!.message).toContain('mybank.com opens evil.example.net');
    expect(ids(withLink('https://other.org/x', 'www.example.com/sale'))).toEqual([
      'link_text_mismatch',
    ]);
  });

  it('accepts matching addresses, subdomains, words and names that only look like hosts', () => {
    expect(ids(withLink('https://shop.example.com/sale?utm=1', 'example.com/sale'))).toEqual([]);
    expect(ids(withLink('https://www.example.co.uk/a', 'https://blog.example.co.uk'))).toEqual([]);
    expect(ids(withLink('https://nodejs.org', 'Node.js'))).toEqual([]);
    expect(ids(withLink('https://example.org', 'example.com is down, says example.org'))).toEqual(
      [],
    );
    // Shown address differs, but it opens the publication's own short link.
    const own = {
      ...withLink('https://go.fieldnotes.example/x', 'https://example.com/long/page'),
      ownHosts: ['go.fieldnotes.example'],
    };
    expect(ids(own)).toEqual([]);
  });

  it('flags a different site under the same country suffix', () => {
    expect(ids(withLink('https://evil.co.uk/a', 'https://example.co.uk'))).toEqual([
      'link_text_mismatch',
    ]);
  });

  it('flags bare IP addresses and plain http, but not localhost', () => {
    expect(ids(withLink('https://203.0.113.9/offer'))).toEqual(['ip_link']);
    expect(ids(withLink('http://203.0.113.9/offer'))).toEqual(['ip_link', 'insecure_link']);
    expect(ids(withLink('http://example.com/page'))).toEqual(['insecure_link']);
    expect(ids(withLink('http://localhost:8787/page'))).toEqual([]);
  });

  it('flags only a very large number of links', () => {
    const many = (n: number) =>
      email(
        doc(
          para(text(LONG)),
          ...Array.from({ length: n }, (_, i) =>
            para(text(`Story number ${i}`, `https://example.com/story/${i}`)),
          ),
        ),
      );
    expect(ids(many(CONTENT_LIMITS.maxLinks))).toEqual([]);
    const advice = checkContent(many(CONTENT_LIMITS.maxLinks + 1));
    expect(advice.map((a) => a.id)).toEqual(['many_links']);
    expect(advice[0]!.message).toContain(`${CONTENT_LIMITS.maxLinks + 1} different links`);
  });
});

describe('images', () => {
  const src = 'https://media.example.com/poster.jpg';

  it('flags an email that is an image and a few words', () => {
    const advice = checkContent(email(doc(image(src), para(text('Doors open at eight.')))));
    expect(advice.map((a) => a.id)).toEqual(['image_heavy']);
    expect(advice[0]!.message).toContain('4 words');
  });

  it('does not count alt text or link addresses as words', () => {
    const input = email(
      doc(
        image(src, 'A very long description of a poster that goes on and on for many many words'),
        para(text('Tickets', 'https://example.com/a/very/long/address/with/many/words/in/it')),
      ),
    );
    expect(ids(input)).toEqual(['image_heavy']);
  });

  it('leaves alone a short text-only email, and one with enough words beside its images', () => {
    expect(ids(email(doc(para(text('Back next week. Thank you for reading.')))))).toEqual([]);
    expect(ids(email(doc(image(src), image(src), para(text(LONG)))))).toEqual([]);
  });

  it('does not take the publication logo for a content image', () => {
    const input = email(doc(para(text('Back next week.'))), {
      design: { logoUrl: 'https://media.example.com/logo.png' },
    });
    expect(input.html).toContain('logo.png');
    expect(ids(input)).toEqual([]);
  });

  it('flags one huge image when its size is known', () => {
    const input = email(doc(image(src), para(text(LONG))));
    expect(ids({ ...input, imageBytes: new Map([[src, 900_000]]) })).toEqual([]);
    const advice = checkContent({ ...input, imageBytes: new Map([[src, 3_400_000]]) });
    expect(advice.map((a) => a.id)).toEqual(['huge_image']);
    expect(advice[0]!.message).toContain('3.4 MB');
    expect(ids({ ...input, imageBytes: new Map([['https://other.example/x.jpg', 9e6]]) })).toEqual(
      [],
    );
  });
});

describe('everything at once', () => {
  it('reports in a stable order and writes no em dashes', () => {
    const input = email(
      doc(
        image('https://media.example.com/poster.jpg'),
        para(
          text('https://mybank.com', 'http://198.51.100.4/x'),
          text(' '),
          text('go', 'https://bit.ly/x'),
        ),
      ),
      { subject: 'BUY NOW!!! LIMITED TIME OFFER, ORDER NOW', preheader: '' },
    );
    const advice = checkContent(input);
    expect(advice.map((a) => a.id)).toEqual([
      'subject_caps',
      'subject_punctuation',
      'preview_text',
      'spam_phrases',
      'link_shortener',
      'ip_link',
      'insecure_link',
      'link_text_mismatch',
      'image_heavy',
    ]);
    for (const { message } of advice)
      expect(message).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
  });
});

describe('registrableDomain', () => {
  it('takes two labels, or three under a country second level', () => {
    expect(registrableDomain('news.example.com')).toBe('example.com');
    expect(registrableDomain('example.com')).toBe('example.com');
    expect(registrableDomain('a.b.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('mail.example.com.au')).toBe('example.com.au');
    expect(registrableDomain('News.Example.DE.')).toBe('example.de');
  });
});
