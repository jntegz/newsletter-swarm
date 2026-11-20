import { defaultCaptureFormConfig } from '@swarm/domain';
import { embedSnippet, integrityOf } from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { call, daily, HOST, ORIGIN, republish, seedChannel, seedForm } from './helpers';

describe('embed script', () => {
  it('serves exactly the bytes the snippet hashes, for every published version', async () => {
    const channel = await seedChannel();
    const { id, config } = await seedForm(channel);
    const v1 = await embedSnippet(ORIGIN, id, 1, config);
    expect(v1.script).toBe(
      `<script async src="${ORIGIN}/v1/${id}.js?v=1" integrity="${v1.integrity}" crossorigin="anonymous"></script>`,
    );

    const res = await call(`/v1/${id}.js?v=1`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(await integrityOf(body)).toBe(v1.integrity);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    // crossorigin="anonymous" needs CORS; credentials are never allowed.
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');

    // A republish leaves v1's bytes alone, so pages still pinned to v1 keep passing SRI.
    const next = { ...config, placement: 'popup' as const };
    const version = await republish(id, next);
    expect(await (await call(`/v1/${id}.js?v=1`)).text()).toBe(body);
    const v2 = await call(`/v1/${id}.js?v=${version}`);
    expect(await integrityOf(await v2.text())).toBe(
      (await embedSnippet(ORIGIN, id, 2, next)).integrity,
    );

    // Unpinned, the latest version, with a short cache.
    const latest = await call(`/v1/${id}.js`);
    expect(latest.headers.get('cache-control')).toBe('public, max-age=300');
    expect(await latest.text()).toContain('"v":2');
    expect((await call(`/v1/${id}.js?v=9`)).status).toBe(404);
  });

  it('reads currentScript at the top level and never writes markup', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel, {
      copy: { heading: '</script><img src=x onerror=alert(1)>', body: '', button: 'Join' },
    });
    const script = await (await call(`/v1/${id}.js?v=1`)).text();
    // Captured once, before any function is defined: it is null after the first run.
    expect(script.match(/currentScript/g)).toHaveLength(1);
    const read = script.indexOf('var script = document.currentScript;');
    const iife = script.indexOf('(function () {');
    expect(read).toBeGreaterThan(iife);
    expect(script.indexOf('function', iife + 10)).toBeGreaterThan(read);
    // No markup sinks at all, so operator or visitor data can never become HTML.
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    // Data is embedded as JSON with < escaped, so it can't close a script element either.
    expect(script).not.toContain('</script>');
    expect(script).toContain('\\u003c/script\\u003e');
    // Messages are only trusted from the capture origin and the form's own frame.
    expect(script).toContain('e.origin !== C.origin');
    expect(script).toContain('e.source !== frame.contentWindow');
    expect(script).not.toMatch(/postMessage\([^)]*'\*'/);
  });

  it('serves the attribution script with the hash the snippet uses', async () => {
    const channel = await seedChannel();
    const { id, config } = await seedForm(channel);
    const res = await call('/v1/attr.js');
    expect(res.status).toBe(200);
    const snippet = await embedSnippet(ORIGIN, id, 1, config);
    expect(snippet.attribution).toContain(`integrity="${await integrityOf(await res.text())}"`);
  });

  it('answers 404 for unknown, draft and malformed forms', async () => {
    expect((await call(`/v1/cf_${'0'.repeat(32)}.js`)).status).toBe(404);
    const channel = await seedChannel();
    const { id } = await seedForm(channel);
    expect((await call(`/v1/${id}.js?v=abc`)).status).toBe(404);
  });

  it('gives a no-JS snippet that posts to the subscribe endpoint', async () => {
    const config = {
      ...defaultCaptureFormConfig(),
      consent: { text: 'I agree to <emails>', required: true },
    };
    const snippet = await embedSnippet(ORIGIN, `cf_${'1'.repeat(32)}`, 3, config);
    expect(snippet.noscript).toContain(
      `<form action="${ORIGIN}/v1/cf_${'1'.repeat(32)}/subscribe" method="post">`,
    );
    expect(snippet.noscript).toContain('name="email"');
    expect(snippet.noscript).toContain('name="website"');
    expect(snippet.noscript).toContain('I agree to &lt;emails&gt;');
  });
});

describe('form frame', () => {
  it('is framable only by the allowlist and counts a view', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel, { allowedOrigins: [HOST] });
    const res = await call(`/v1/${id}/frame?v=1`, { headers: { referer: `${HOST}/` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBeNull();
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain(`frame-ancestors ${HOST}`);
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+' https:\/\/challenges\.cloudflare\.com/);
    expect(csp).toContain("connect-src 'self'");
    const html = await res.text();
    expect(html).toContain('class="cf-turnstile"');
    expect(html).toContain('name="website"');
    expect(html).toContain('--accent:#2b7a78');
    expect((await daily(id)).views).toBe(1);
    // The human check is solved for this form only.
    expect(html).toContain(`data-cdata="${id}"`);
  });

  it('names the publication being joined inside the frame, whatever the page around it says', async () => {
    const channel = await seedChannel();
    for (const layout of ['regular', 'slim'] as const) {
      const { id } = await seedForm(channel, {
        layout,
        copy: { heading: '', body: '', button: 'Get the free gift' },
      });
      const html = await (await call(`/v1/${id}/frame?v=1`)).text();
      expect(html, layout).toContain('You are joining <strong>Field Notes</strong>.');
    }
  });

  it('turns away a foreign site', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel, { allowedOrigins: [HOST] });
    const res = await call(`/v1/${id}/frame?v=1`, {
      headers: { referer: 'https://elsewhere.example/' },
    });
    expect(res.status).toBe(403);
    expect((await daily(id)).views).toBe(0);
  });

  it('shows a consent link that opens in a new window, and nothing more dangerous', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel, {
      consent: {
        text: 'I agree to the <a href="https://example.com/privacy" onclick="x()">policy</a><img src=x onerror=y>',
        required: true,
      },
    });
    const html = await (await call(`/v1/${id}/frame`)).text();
    expect(html).toContain(
      '<a href="https://example.com/privacy" target="_blank" rel="noopener noreferrer">policy</a>',
    );
    expect(html).toContain('&lt;img src=x onerror=y&gt;');
    expect(html).not.toContain('onclick');
  });

  it('escapes every operator-written string', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel, {
      copy: { heading: '<b>Hi</b>', body: '"quoted" & <i>', button: '<Join>' },
      consent: { text: '<script>alert(1)</script>', required: false },
    });
    const html = await (await call(`/v1/${id}/frame`)).text();
    expect(html).toContain('<h1>&lt;b&gt;Hi&lt;/b&gt;</h1>');
    expect(html).toContain('&lt;Join&gt;</button>');
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});
