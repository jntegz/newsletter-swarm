// Pins the dashboard's security headers (public/_headers, copied into dist and applied by
// Workers static assets) and the one page they protect.
import { describe, expect, it } from 'vitest';
import indexHtml from '../index.html?raw';
import headersFile from '../public/_headers?raw';

/** The `/*` block of the _headers file as a header map (Cloudflare's syntax: path, then indented lines). */
function headersForAll(): Record<string, string> {
  const out: Record<string, string> = {};
  let inBlock = false;
  for (const line of headersFile.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue;
    if (!/^\s/.test(line)) {
      inBlock = line.trim() === '/*';
      continue;
    }
    if (!inBlock) continue;
    const colon = line.indexOf(':');
    out[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return out;
}

function csp(): Map<string, string[]> {
  const policy = headersForAll()['content-security-policy'] ?? '';
  return new Map(
    policy
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map(([name, ...values]) => [name!, values]),
  );
}

describe('dashboard security headers', () => {
  it('sends HSTS, nosniff, frame denial and a referrer policy on every path', () => {
    const h = headersForAll();
    expect(h['strict-transport-security']).toBe('max-age=63072000; includeSubDomains; preload');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('has a CSP with no inline or eval script, same-origin connections and no framing', () => {
    const policy = csp();
    expect(policy.get('default-src')).toEqual(["'self'"]);
    // Turnstile (sign-in) is the only third-party script.
    expect(policy.get('script-src')).toEqual(["'self'", 'https://challenges.cloudflare.com']);
    // 'self' covers the live send monitor's same-origin WebSocket.
    expect(policy.get('connect-src')).toEqual(["'self'"]);
    expect(policy.get('frame-src')).toEqual(['https://challenges.cloudflare.com']);
    expect(policy.get('frame-ancestors')).toEqual(["'none'"]);
    expect(policy.get('object-src')).toEqual(["'none'"]);
    expect(policy.get('base-uri')).toEqual(["'none'"]);
    // Uploaded fonts are drawn from the media origin (its address differs per deployment).
    // Uploaded fonts come from this install's media origin, which the installer adds at deploy time.
    expect(policy.get('font-src')).toEqual(["'self'", 'data:']);
    for (const [name, values] of policy) {
      expect(values, name).not.toContain("'unsafe-eval'");
      if (name !== 'style-src') expect(values, name).not.toContain("'unsafe-inline'");
    }
  });

  it('serves a page with no inline script for the CSP to break', () => {
    const scripts = [...indexHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attrs, body] of scripts) {
      expect(attrs).toMatch(/\bsrc=/);
      expect(body!.trim()).toBe('');
    }
    expect(indexHtml).not.toMatch(/\son[a-z]+=/i);
  });
});
