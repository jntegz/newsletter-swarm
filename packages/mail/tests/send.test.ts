import { describe, expect, it } from 'vitest';
import {
  buildMime,
  encodeHeaderWords,
  hasGateDivider,
  HeaderInjectionError,
  personalize,
  renderDispatch,
  RenderError,
  shareLinks,
  IdentityExistsError,
  SesClient,
  SesError,
  signRequest,
  unsubscribeHeaders,
  type RenderOptions,
} from '../src/index';

const options: RenderOptions = {
  channelName: 'Field Notes',
  mediaUrl: (id) => (id === 'md_ok' ? 'https://media.example/md_ok.png' : null),
  allowHtmlBlocks: false,
};

const text = (value: string, marks?: unknown[]) => ({ type: 'text', text: value, marks });
const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const doc = (...content: unknown[]) => ({ type: 'doc', content });

function decodeParts(raw: string): { text: string; html: string } {
  const parts = raw.split(/--swarm-[0-9a-f]+/);
  const decode = (part: string) => {
    const body = part.split('\r\n\r\n')[1]!.replace(/\r\n/g, '');
    const binary = atob(body);
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  };
  return { text: decode(parts[1]!), html: decode(parts[2]!) };
}

describe('SigV4', () => {
  it('matches the AWS get-vanilla test vector', async () => {
    const headers = await signRequest({
      method: 'GET',
      url: 'https://example.amazonaws.com/',
      service: 'service',
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      },
      now: new Date('2015-08-30T12:36:00Z'),
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
    expect(headers['x-amz-date']).toBe('20150830T123600Z');
  });
});

describe('MIME', () => {
  const base = {
    from: { name: 'Zpravodaj Žirafa', address: 'hello@news.example.com' },
    to: 'member@example.org',
    replyTo: 'editor@example.com',
    subject: 'Týdenní přehled — issue 12',
    text: 'Plain body',
    html: '<p>HTML body</p>',
    messageId: 'dl_1@news.example.com',
    date: new Date('2026-10-27T10:00:00Z'),
    headers: {
      ...unsubscribeHeaders('https://link.example.com/u/abc', 'unsub+abc@example.com'),
      'Feedback-ID': 'bc_1:ch_1:swarm',
    },
  };

  it('carries exact One-Click unsubscribe headers and both parts', () => {
    const raw = buildMime(base);
    const [head] = raw.split('\r\n\r\n');
    expect(head).toContain(
      'List-Unsubscribe: <https://link.example.com/u/abc>, <mailto:unsub+abc@example.com>',
    );
    expect(head).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
    expect(head).toContain('Feedback-ID: bc_1:ch_1:swarm');
    expect(head).toContain('Message-ID: <dl_1@news.example.com>');
    expect(head).toContain('Reply-To: editor@example.com');
    expect(head).toMatch(/Content-Type: multipart\/alternative; boundary="swarm-[0-9a-f]+"/);
    expect(raw).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(raw).toContain('Content-Type: text/html; charset=UTF-8');
    expect(decodeParts(raw)).toEqual({ text: 'Plain body', html: '<p>HTML body</p>' });
    // Every line ends in CRLF and stays under the 998-character limit.
    expect(raw.split('\r\n').every((line) => !line.includes('\n') && line.length <= 998)).toBe(
      true,
    );
  });

  it('encodes non-ASCII names and subjects with RFC 2047', () => {
    const raw = buildMime(base);
    expect(raw).toMatch(
      /From: =\?UTF-8\?B\?[^?]+\?=(\r\n =\?UTF-8\?B\?[^?]+\?=)* <hello@news\.example\.com>/,
    );
    const subject = encodeHeaderWords(base.subject);
    for (const word of subject.split('\r\n ')) expect(word.length).toBeLessThanOrEqual(75);
    const decoded = subject
      .split('\r\n ')
      .map((word) => atob(word.slice(10, -2)))
      .join('');
    expect(new TextDecoder().decode(Uint8Array.from(decoded, (c) => c.charCodeAt(0)))).toBe(
      base.subject,
    );
  });

  it('refuses header injection', () => {
    expect(() => buildMime({ ...base, subject: 'Hi\r\nBcc: victim@example.com' })).toThrow(
      HeaderInjectionError,
    );
    expect(() =>
      buildMime({ ...base, from: { name: 'A\nB', address: 'hello@news.example.com' } }),
    ).toThrow(HeaderInjectionError);
    expect(() => buildMime({ ...base, to: 'a@b.example, c@d.example' })).toThrow();
  });

  it('never uses the wrong One-Click value or a non-https URL', () => {
    expect(unsubscribeHeaders('https://x.example/u/1', null)['List-Unsubscribe-Post']).toBe(
      'List-Unsubscribe=One-Click',
    );
    expect(() => unsubscribeHeaders('http://x.example/u/1', null)).toThrow();
  });
});

describe('renderDispatch', () => {
  it('renders blocks, escapes text and collects links in order', () => {
    const out = renderDispatch(
      doc(
        { type: 'heading', attrs: { level: 1 }, content: [text('Hello <there>')] },
        para(
          text('Read '),
          text('this', [{ type: 'link', attrs: { href: 'https://a.example/1' } }]),
          text(' and '),
          text('that', [{ type: 'link', attrs: { href: 'https://b.example/2' } }]),
          text(' and '),
          text('again', [{ type: 'link', attrs: { href: 'https://a.example/1' } }]),
          text(' or '),
          text('write', [{ type: 'link', attrs: { href: 'mailto:editor@example.com' } }]),
        ),
        { type: 'button', attrs: { href: 'https://c.example/3', label: 'Go' } },
        { type: 'image', attrs: { mediaId: 'md_ok', alt: 'A chart' } },
      ),
      options,
    );
    expect(out.html).toContain('Hello &lt;there&gt;');
    expect(out.links).toEqual([
      'https://a.example/1',
      'https://b.example/2',
      'https://c.example/3',
    ]);
    expect(out.html).toContain('href="{{@link:0}}"');
    expect(out.html).toContain('href="mailto:editor@example.com"');
    expect(out.html).toContain('src="https://media.example/md_ok.png"');
    expect(out.html).toContain('{{@unsubscribe}}');
    expect(out.html).toContain('{{@pixel}}');
    expect(out.text).toContain('this ({{@link:0}})');
    expect(out.text).toContain('Unsubscribe: {{@unsubscribe}}');
    expect(out.html).toContain('href="{{@member_center}}"');
    expect(out.text).toContain('Manage your subscription: {{@member_center}}');
    expect(out.warnings).toEqual([]);
  });

  it('refuses unknown nodes, unsafe links and foreign media', () => {
    expect(() => renderDispatch(doc({ type: 'script' }), options)).toThrow(RenderError);
    expect(() =>
      renderDispatch(doc({ type: 'image', attrs: { mediaId: 'md_other', alt: 'x' } }), options),
    ).toThrow(RenderError);
    expect(() =>
      renderDispatch(doc({ type: 'image', attrs: { src: 'javascript:alert(1)' } }), options),
    ).toThrow(RenderError);
    expect(() =>
      renderDispatch(doc({ type: 'htmlBlock', attrs: { html: '<b>x</b>' } }), options),
    ).toThrow(RenderError);
    const dropped = renderDispatch(
      doc(para(text('x', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]))),
      options,
    );
    expect(dropped.html).not.toContain('javascript:');
    expect(dropped.links).toEqual([]);
    expect(dropped.warnings[0]).toMatch(/not a valid web address/);
  });

  it('allows raw HTML blocks only when the flag is on', () => {
    const out = renderDispatch(doc({ type: 'htmlBlock', attrs: { html: '<b>raw</b>' } }), {
      ...options,
      allowHtmlBlocks: true,
    });
    expect(out.html).toContain('<b>raw</b>');
  });

  it('lints raw HTML for bad links, missing alt text and dark-mode traps', () => {
    const out = renderDispatch(
      doc({
        type: 'htmlBlock',
        attrs: {
          html: '<p style="color:#000">Hi <a href="javascript:alert(1)">x</a> <a href="https://ok.example/">ok</a><img src="https://img.example/a.png"></p>',
        },
      }),
      { ...options, allowHtmlBlocks: true },
    );
    const warnings = out.warnings.join('\n');
    expect(warnings).toMatch(/"javascript:alert\(1\)", which is not a web address/);
    expect(warnings).not.toMatch(/ok\.example/);
    expect(warnings).toMatch(/image in raw HTML has no alt text/);
    expect(warnings).toMatch(/dark mode/);
  });

  it('renders attachments as tracked download links from the media library only', () => {
    const out = renderDispatch(
      doc({ type: 'attachment', attrs: { mediaId: 'md_ok', name: 'Report <2026>' } }),
      options,
    );
    expect(out.links).toEqual(['https://media.example/md_ok.png']);
    expect(out.html).toContain('href="{{@link:0}}"');
    expect(out.html).toContain('Report &lt;2026&gt;');
    expect(out.html).toContain('Download PNG');
    expect(out.text).toContain('Report <2026>: {{@link:0}}');
    expect(() =>
      renderDispatch(doc({ type: 'attachment', attrs: { mediaId: 'md_other' } }), options),
    ).toThrow(/media library/);
  });

  it('warns about missing alt text, missing fallbacks and Gmail clipping', () => {
    const out = renderDispatch(
      doc(
        { type: 'image', attrs: { src: 'https://img.example/a.png' } },
        para(text('Hi {{ first_name }}, {{ nickname }}')),
        para(text('x'.repeat(110_000))),
      ),
      options,
    );
    expect(out.warnings.join('\n')).toMatch(/alt text/);
    expect(out.warnings.join('\n')).toMatch(/"first_name" has no fallback/);
    expect(out.warnings.join('\n')).toMatch(/Unknown merge tag "nickname"/);
    expect(out.warnings.join('\n')).toMatch(/Gmail will clip/);
  });
});

describe('an empty post', () => {
  const EMPTY = 'The post is empty.';
  const image = { type: 'image', attrs: { mediaId: 'md_ok', alt: '' } };
  const button = { type: 'button', attrs: { href: 'https://x.example', label: 'Read' } };

  it('is a post with nothing to read, dividers and empty quotes included', () => {
    const warnings = (...blocks: unknown[]) => renderDispatch(doc(...blocks), options).warnings;
    expect(warnings(para())).toContain(EMPTY);
    expect(warnings({ type: 'horizontalRule' })).toContain(EMPTY);
    expect(
      warnings({ type: 'blockquote', content: [para()] }, { type: 'horizontalRule' }),
    ).toContain(EMPTY);
    expect(warnings(para(text('Hello')), { type: 'horizontalRule' })).not.toContain(EMPTY);
  });

  it('is not an image-only or a button-only post, though neither has words', () => {
    expect(renderDispatch(doc(image), options).warnings).not.toContain(EMPTY);
    expect(renderDispatch(doc(button), options).warnings).not.toContain(EMPTY);
  });
});

describe('gate divider', () => {
  const gated = doc(para(text('Free part')), { type: 'gate' }, para(text('Paid part')));
  const webUrl = 'https://notes.swarm.page/p/issue-1';

  for (const visibility of ['public', 'members', 'hidden', undefined] as const) {
    it(`carries everything for ${visibility ?? 'no'} web visibility; the gate renders nothing`, () => {
      const out = renderDispatch(gated, {
        ...options,
        ...(visibility ? { webVisibility: visibility } : {}),
        webUrl,
      });
      expect(out.html).toContain('Free part');
      expect(out.html).toContain('Paid part');
      expect(out.text).toContain('Paid part');
      expect(out.html).not.toContain('Continue reading');
      expect(out.links).toEqual([]);
    });
  }

  it('stops a paid Dispatch at the gate with a button to the web', () => {
    const out = renderDispatch(gated, { ...options, webVisibility: 'paid', webUrl });
    expect(out.html).toContain('Free part');
    expect(out.html).not.toContain('Paid part');
    expect(out.text).not.toContain('Paid part');
    expect(out.html).toContain('Continue reading on the web');
    expect(out.links).toEqual([webUrl]);
    expect(out.html).toContain('href="{{@link:0}}"');
    expect(out.text).toContain('Continue reading on the web: {{@link:0}}');
  });

  it('renders the full variant of a paid Dispatch for entitled Members', () => {
    const out = renderDispatch(gated, {
      ...options,
      webVisibility: 'paid',
      paidVariant: 'full',
      webUrl,
    });
    expect(out.html).toContain('Free part');
    expect(out.html).toContain('Paid part');
    expect(out.html).not.toContain('Continue reading');
    expect(hasGateDivider(gated)).toBe(true);
    expect(hasGateDivider(doc(para(text('x'))))).toBe(false);
  });

  it('shares one link list between the full and teaser emails', () => {
    const link = (label: string, href: string) => text(label, [{ type: 'link', attrs: { href } }]);
    const both = doc(
      para(link('free', 'https://free.example/')),
      { type: 'gate' },
      para(link('paid', 'https://paid.example/'), link('free again', 'https://free.example/')),
    );
    const full = renderDispatch(both, { ...options, webVisibility: 'paid', paidVariant: 'full' });
    const teaser = renderDispatch(both, { ...options, webVisibility: 'paid', webUrl });
    expect(teaser.links).toEqual(['https://free.example/', webUrl]);
    const shared = shareLinks(full, teaser);
    expect(shared.full.links).toEqual(['https://free.example/', 'https://paid.example/', webUrl]);
    expect(shared.teaser.links).toBe(shared.full.links);
    expect(shared.full.html).toBe(full.html);
    // The teaser's web button was {{@link:1}}; in the shared list it is {{@link:2}}.
    expect(shared.teaser.html).toContain('href="{{@link:0}}"');
    expect(shared.teaser.html).toContain('href="{{@link:2}}"');
    expect(shared.teaser.html).not.toContain('{{@link:1}}');
    expect(shared.teaser.text).toContain('Continue reading on the web: {{@link:2}}');
  });

  it('a paid Dispatch without a gate is sent whole', () => {
    const out = renderDispatch(doc(para(text('All of it'))), {
      ...options,
      webVisibility: 'paid',
      webUrl,
    });
    expect(out.html).toContain('All of it');
    expect(out.html).not.toContain('Continue reading');
  });

  it('a paid Dispatch without a web address says so instead of linking', () => {
    const out = renderDispatch(gated, { ...options, webVisibility: 'paid', webUrl: null });
    expect(out.html).not.toContain('Paid part');
    expect(out.html).toContain('for paid subscribers');
    expect(out.links).toEqual([]);
    expect(out.warnings.join('\n')).toMatch(/no web address/);
  });

  it('still validates the gated part, and refuses nested gates', () => {
    expect(() =>
      renderDispatch(doc(para(text('a')), { type: 'gate' }, { type: 'script' }), {
        ...options,
        webVisibility: 'paid',
        webUrl,
      }),
    ).toThrow(RenderError);
    expect(() =>
      renderDispatch(doc({ type: 'blockquote', content: [{ type: 'gate' }] }), options),
    ).toThrow(/paywall break/);
  });
});

describe('personalize', () => {
  const template = renderDispatch(
    doc(
      para(text('Hi {{ first_name | there & friends }}!')),
      para(text('link', [{ type: 'link', attrs: { href: 'https://a.example/1' } }])),
    ),
    options,
  );

  const fill = (member: { email: string; firstName?: string | null }, pixel = true) =>
    personalize(
      { html: template.html, text: template.text, subject: 'For {{ first_name | you }}' },
      {
        link: (n) => `https://t.example/c/${n}?x=1&y=2`,
        unsubscribeUrl: 'https://t.example/u/abc',
        pixelUrl: pixel ? 'https://t.example/o/abc' : null,
        member,
      },
    );

  it('escapes Member values in HTML and uses fallbacks', () => {
    const evil = fill({ email: 'a@b.example', firstName: '<script>x</script>' });
    expect(evil.html).toContain('Hi &lt;script&gt;x&lt;/script&gt;!');
    expect(evil.text).toContain('Hi <script>x</script>!');
    expect(evil.subject).toBe('For <script>x</script>');
    const blank = fill({ email: 'a@b.example', firstName: null });
    expect(blank.html).toContain('Hi there &amp; friends!');
    expect(blank.text).toContain('Hi there & friends!');
    expect(blank.subject).toBe('For you');
  });

  it('rewrites links, fills unsubscribe and the pixel', () => {
    const out = fill({ email: 'a@b.example' });
    expect(out.html).toContain('href="https://t.example/c/0?x=1&amp;y=2"');
    expect(out.html).toContain('href="https://t.example/u/abc"');
    expect(out.html).toContain('<img src="https://t.example/o/abc"');
    expect(out.text).toContain('link (https://t.example/c/0?x=1&y=2)');
    expect(fill({ email: 'a@b.example' }, false).html).not.toContain('/o/abc');
    expect(out.html).not.toMatch(/\{\{@/);
  });

  it('fills the Member Center link per recipient, falling back to unsubscribe', () => {
    const base = { html: template.html, text: template.text, subject: 's' };
    const values = {
      link: () => 'https://t.example/c',
      unsubscribeUrl: 'https://t.example/u/abc',
      pixelUrl: null,
      member: { email: 'a@b.example' },
    };
    const one = personalize(base, {
      ...values,
      memberCenterUrl: 'https://f.example/m/one?a=1&b=2',
    });
    const two = personalize(base, { ...values, memberCenterUrl: 'https://f.example/m/two' });
    expect(one.html).toContain('href="https://f.example/m/one?a=1&amp;b=2"');
    expect(one.text).toContain('Manage your subscription: https://f.example/m/one?a=1&b=2');
    expect(two.html).toContain('href="https://f.example/m/two"');
    expect(two.html).not.toContain('/m/one');
    const preview = personalize(base, values);
    expect(preview.html).toMatch(
      /href="https:\/\/t\.example\/u\/abc" [^>]*>Manage your subscription/,
    );
    expect(preview.html).not.toMatch(/\{\{@/);
  });

  it('treats a field merge tag named like an Object.prototype member as a missing field', () => {
    // A Channel may name a field "constructor"; a Member without a value gets the fallback.
    const out = personalize(
      { html: '<p>Hi {{ field.constructor | friend }}</p>', text: '', subject: 'S' },
      {
        link: () => 'https://t.example/c',
        unsubscribeUrl: 'https://t.example/u/abc',
        pixelUrl: null,
        member: { email: 'a@b.example', fields: { city: 'Paris' } },
      },
    );
    expect(out.html).toBe('<p>Hi friend</p>');
  });

  it('never expands placeholders or merge tags that come from Member data', () => {
    const out = fill({ email: 'a@b.example', firstName: '{{@unsubscribe}} {{ email }}' });
    expect(out.html).toContain('Hi {{@unsubscribe}} {{ email }}!');
  });

  it('keeps line breaks out of the subject', () => {
    const out = fill({ email: 'a@b.example', firstName: 'A\r\nBcc: x@y.example' });
    expect(out.subject).toBe('For A Bcc: x@y.example');
  });
});

describe('SesClient', () => {
  it('sends raw MIME with the configuration set and sanitised tags', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new SesClient({
      region: 'eu-west-1',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
      configurationSet: 'swarm-broadcasts',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return Response.json({ MessageId: 'ses-1' });
      },
    });
    const id = await client.sendRaw({
      from: 'a@b.example',
      to: 'c@d.example',
      raw: 'Subject: x\r\n\r\nbody',
      tags: { broadcast: 'bc_1', 'bad tag!': 'v@lue' },
    });
    expect(id).toBe('ses-1');
    expect(calls[0]!.url).toBe('https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.Content.Raw.Data).toBe(btoa('Subject: x\r\n\r\nbody'));
    expect(body.Content.Simple).toBeUndefined();
    expect(body.ConfigurationSetName).toBe('swarm-broadcasts');
    expect(body.EmailTags).toEqual([
      { Name: 'broadcast', Value: 'bc_1' },
      { Name: 'bad_tag_', Value: 'v_lue' },
    ]);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/eu-west-1\/ses\/aws4_request/,
    );
  });

  it('marks throttling as retryable and rejections as final', async () => {
    const client = (status: number, type: string) =>
      new SesClient({
        region: 'eu-west-1',
        credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
        configurationSet: 'x',
        fetch: async () =>
          Response.json({ message: 'no' }, { status, headers: { 'x-amzn-errortype': type } }),
      });
    await expect(
      client(429, 'TooManyRequestsException').sendRaw({ from: 'a@b.c', to: 'd@e.f', raw: 'x' }),
    ).rejects.toMatchObject({ retryable: true });
    await expect(
      client(400, 'MessageRejected').sendRaw({ from: 'a@b.c', to: 'd@e.f', raw: 'x' }),
    ).rejects.toMatchObject({ retryable: false, code: 'MessageRejected' });
  });

  it('reads a used-up daily quota from its message, whatever the code', async () => {
    const quota = new SesClient({
      region: 'eu-west-1',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
      configurationSet: 'x',
      fetch: async () =>
        Response.json(
          { message: 'Daily message quota exceeded.' },
          { status: 400, headers: { 'x-amzn-errortype': 'LimitExceededException' } },
        ),
    });
    await expect(quota.sendRaw({ from: 'a@b.c', to: 'd@e.f', raw: 'x' })).rejects.toMatchObject({
      quota: 'day',
      retryable: false,
      halting: false,
    });
    // Throttling stays a retry, not a quota.
    expect(
      new SesError(429, 'TooManyRequestsException', 'Maximum sending rate exceeded.'),
    ).toMatchObject({
      quota: null,
      retryable: true,
    });
  });
});

describe('SesClient domain identities', () => {
  it('refuses an identity SES already has instead of taking it over', async () => {
    const calls: { method: string; url: string }[] = [];
    const client = new SesClient({
      region: 'eu-west-1',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
      configurationSet: 'x',
      fetch: async (url, init) => {
        calls.push({ method: init?.method ?? 'GET', url: String(url) });
        if (init?.method === 'POST')
          return Response.json(
            { message: 'exists' },
            { status: 400, headers: { 'x-amzn-errortype': 'AlreadyExistsException' } },
          );
        return Response.json({ DkimAttributes: { Tokens: ['t1', 't2', 't3'] } });
      },
    });
    await expect(client.create('staging-mail.example.com', 'bounce.x')).rejects.toBeInstanceOf(
      IdentityExistsError,
    );
    // Nothing read from it, and its MAIL FROM is left alone.
    expect(calls.map((c) => c.method)).toEqual(['POST']);
  });
});

describe('SesClient suppression list', () => {
  const calls: { url: string; method: string; body: string | null; auth: string }[] = [];
  const client = (respond: (url: string) => Response) =>
    new SesClient({
      region: 'eu-west-1',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
      configurationSet: 'x',
      fetch: async (url, init) => {
        const headers = init!.headers as Record<string, string>;
        calls.push({
          url: String(url),
          method: init!.method!,
          body: (init!.body as string | null) ?? null,
          auth: headers.authorization!,
        });
        return respond(String(url));
      },
    });

  it('puts, deletes (missing is success) and lists suppressed destinations', async () => {
    calls.length = 0;
    const ses = client((url) =>
      url.includes('/addresses/')
        ? Response.json(
            { message: 'nope' },
            { status: 404, headers: { 'x-amzn-errortype': 'NotFoundException' } },
          )
        : url.includes('?')
          ? Response.json({
              SuppressedDestinationSummaries: [
                { EmailAddress: 'A@Example.com', Reason: 'BOUNCE', LastUpdateTime: 1_800_000_000 },
                { EmailAddress: 'b@example.com', Reason: 'OTHER', LastUpdateTime: 1 },
              ],
              NextToken: 'next',
            })
          : new Response(''),
    );
    await ses.putSuppressed('a+b@example.com', 'COMPLAINT');
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      url: 'https://email.eu-west-1.amazonaws.com/v2/email/suppression/addresses',
    });
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      EmailAddress: 'a+b@example.com',
      Reason: 'COMPLAINT',
    });

    await ses.deleteSuppressed('a+b@example.com');
    expect(calls[1]).toMatchObject({
      method: 'DELETE',
      url: 'https://email.eu-west-1.amazonaws.com/v2/email/suppression/addresses/a%2Bb%40example.com',
    });

    const page = await ses.listSuppressed({ from: 0, to: 1_900_000_000_000, nextToken: 't1' });
    expect(page).toEqual({
      items: [{ email: 'a@example.com', reason: 'BOUNCE', updatedAt: 1_800_000_000_000 }],
      nextToken: 'next',
    });
    const listed = new URL(calls[2]!.url);
    expect(listed.searchParams.get('StartDate')).toBe('1970-01-01T00:00:00.000Z');
    expect(listed.searchParams.get('NextToken')).toBe('t1');
    for (const call of calls) expect(call.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\//);
  });

  it('signs an address path with each segment encoded twice, as SES (not S3) expects', async () => {
    const sign = (service: string) =>
      signRequest({
        method: 'DELETE',
        url: 'https://email.eu-west-1.amazonaws.com/v2/email/suppression/addresses/a%2Bb%40x.com',
        service,
        region: 'eu-west-1',
        credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
        now: new Date('2026-10-28T00:00:00Z'),
      });
    // S3 and SES canonicalise the path differently, so the signatures differ.
    expect((await sign('ses')).authorization).not.toBe((await sign('s3')).authorization);
  });

  it('marks throttling retryable', async () => {
    const ses = client(() =>
      Response.json(
        {},
        { status: 429, headers: { 'x-amzn-errortype': 'TooManyRequestsException' } },
      ),
    );
    await expect(ses.putSuppressed('a@b.c', 'BOUNCE')).rejects.toMatchObject({ retryable: true });
  });
});
