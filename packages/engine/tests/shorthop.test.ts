// Shorthop: slugs from a format, and calls to its MCP server. docs/applications.md.
import { SlugFormatSchema, renderSlug } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import {
  ShorthopError,
  checkShorthop,
  createShorthopLink,
  normalizeBaseUrl,
  shorthopUrlProblem,
} from '../src/shorthop';

const context = {
  publication: 'field-notes',
  post: 'The Slow Web, Révisité!',
  url: 'https://www.example.com/a',
  now: Date.UTC(2026, 10, 4),
  random: 'x7k2q9',
};

describe('the slug format', () => {
  it('fills each token', () => {
    expect(renderSlug('{publication}-{post}-{date}-{domain}-{random}', context)).toBe(
      'field-notes-the-slow-web-revisite-2026-11-04-example-com-x7k2q9',
    );
  });

  it('always makes a slug Shorthop accepts', () => {
    const accepted = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
    for (const [format, post] of [
      ['{post}', ''],
      ['{post}-{random}', ''],
      ['-{post}-', '!!!'],
      ['{post}{post}{post}{post}', 'a very long subject line that keeps going and going'],
      ['{post}_{post}', ''],
    ] as const) {
      expect(renderSlug(format, { ...context, post }), `${format} / ${post}`).toMatch(accepted);
    }
  });

  it('refuses anything else in a format', () => {
    expect(SlugFormatSchema.safeParse('{post}-{random}').success).toBe(true);
    for (const bad of ['{unknown}', 'a/b', 'a b', '../x', '{post', '']) {
      expect(SlugFormatSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('the address', () => {
  it('takes a public https address, and keeps only its origin', () => {
    expect(shorthopUrlProblem('https://go.example.com', 'production')).toBeNull();
    expect(normalizeBaseUrl('https://go.example.com/_admin?x=1')).toBe('https://go.example.com');
  });

  it('refuses addresses that would reach inside the network', () => {
    for (const bad of [
      'http://go.example.com',
      'https://localhost',
      'https://127.0.0.1',
      'https://169.254.169.254',
      'https://[::1]',
      'https://intranet',
      'https://db.internal',
      'https://user:pw@go.example.com',
    ]) {
      expect(shorthopUrlProblem(bad, 'production'), bad).not.toBeNull();
    }
  });
});

/** A fake Shorthop: answers like the real one's src/worker/mcp.ts. */
function fakeShorthop(answer: (method: string, params: Record<string, unknown>) => unknown) {
  const calls: {
    url: string;
    auth: string | null;
    method: string;
    params: { arguments?: { slug?: string } };
  }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      method: string;
      params: { arguments?: { slug?: string } };
    };
    calls.push({
      url: String(input),
      auth: new Headers(init?.headers).get('authorization'),
      method: body.method,
      params: body.params,
    });
    return Response.json({ jsonrpc: '2.0', id: 1, result: answer(body.method, body.params) });
  }) as typeof fetch;
  return { calls, target: { fetch: fetcher, baseUrl: 'https://go.example.com', apiKey: 'shp_x' } };
}
const linkAnswer = (shortUrl: string) => ({
  content: [{ type: 'text', text: '{}' }],
  structuredContent: { link: { shortUrl } },
});
const toolError = (text: string) => ({ content: [{ type: 'text', text }], isError: true });
const input = {
  url: 'https://a.example',
  slug: 'first',
  domain: null,
  title: 'T',
  tags: ['swarm'],
};

describe('calling Shorthop', () => {
  it('sends the key to its MCP endpoint and returns the short link', async () => {
    const fake = fakeShorthop(() => linkAnswer('https://go.example.com/first'));
    await expect(createShorthopLink(fake.target, input)).resolves.toBe(
      'https://go.example.com/first',
    );
    expect(fake.calls[0]).toMatchObject({
      url: 'https://go.example.com/api/mcp',
      auth: 'Bearer shp_x',
      method: 'tools/call',
      params: { name: 'create_link', arguments: { slug: 'first', url: 'https://a.example' } },
    });
  });

  it('tries another slug when one is taken', async () => {
    let tries = 0;
    const fake = fakeShorthop(() =>
      tries++ === 0
        ? toolError('slug: "first" is already taken on go.example.com.')
        : linkAnswer('https://go.example.com/first-abc'),
    );
    await createShorthopLink(fake.target, { ...input, random: () => 'abc' });
    expect(fake.calls[1]?.params.arguments?.slug).toBe('first-abc');
  });

  it('passes on any other refusal, and doesn’t retry it', async () => {
    const fake = fakeShorthop(() => toolError('Destination is not allowed'));
    await expect(createShorthopLink(fake.target, input)).rejects.toThrow(
      'Destination is not allowed',
    );
    expect(fake.calls).toHaveLength(1);
  });

  it('checks a connection with a real tool call, because listing tools needs no key', async () => {
    const fake = fakeShorthop((method) =>
      method === 'tools/list' ? { tools: [{ name: 'create_link' }] } : toolError('Invalid API key'),
    );
    await expect(checkShorthop(fake.target)).rejects.toMatchObject({ kind: 'rejected' });
    expect(fake.calls.map((c) => c.method)).toEqual(['tools/list', 'tools/call']);
  });

  it('doesn’t take another server for a Shorthop', async () => {
    const fake = fakeShorthop(() => ({ tools: [{ name: 'something_else' }] }));
    await expect(checkShorthop(fake.target)).rejects.toBeInstanceOf(ShorthopError);
  });

  it('says so when it can’t be reached, without leaking the error', async () => {
    const down = {
      apiKey: 'k',
      baseUrl: 'https://go.example.com',
      fetch: (async () => {
        throw new Error('connection refused to 10.0.0.5');
      }) as typeof fetch,
    };
    await expect(createShorthopLink(down, input)).rejects.toMatchObject({
      kind: 'unavailable',
      message: expect.not.stringContaining('10.0.0.5'),
    });
  });
});
