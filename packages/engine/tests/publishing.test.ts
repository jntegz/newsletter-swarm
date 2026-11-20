import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CloudflareWebHostnames,
  WebHostingEnvFields,
  checkWebHostingEnv,
  platformSiteOrigin,
  searchBody,
  webHostnames,
} from '../src/index';

const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const gated = { type: 'doc', content: [p('Open part'), { type: 'gate' }, p('Closed part')] };
const plain = { type: 'doc', content: [p('Only part')] };

describe('searchBody', () => {
  it('never indexes text behind the gate', () => {
    expect(searchBody(gated, 'public', 'Notes')).toContain('Closed part');
    for (const visibility of ['members', 'paid'] as const) {
      const body = searchBody(gated, visibility, 'Notes');
      expect(body).toContain('Open part');
      expect(body).not.toContain('Closed part');
      // Without a gate a members-only or paid Dispatch is entirely gated.
      expect(searchBody(plain, visibility, 'Notes')).toBe('');
    }
    expect(searchBody({ type: 'doc', content: [{ type: 'script' }] }, 'public', 'Notes')).toBe('');
  });

  it('never indexes an email-only block, and holds a website-only one', () => {
    const para = (text: string, showOn?: string) => ({
      ...p(text),
      ...(showOn ? { attrs: { showOn } } : {}),
    });
    const kept = {
      type: 'doc',
      content: [
        para('For both'),
        para('Inbox secret', 'email'),
        para('Site words', 'web'),
        { type: 'gate' },
        para('Closed inbox secret', 'email'),
      ],
    };
    for (const visibility of ['public', 'members', 'paid'] as const) {
      const body = searchBody(kept, visibility, 'Notes');
      expect(body).toContain('For both');
      expect(body).toContain('Site words');
      expect(body).not.toContain('secret');
    }
    // An unknown value indexes nothing rather than guessing.
    expect(searchBody({ type: 'doc', content: [para('Odd', 'both')] }, 'public', 'Notes')).toBe('');
  });

  it('never indexes more than the page shows when the paywall break is email-only', () => {
    // The website drops an email-only break, so the page cuts at its own short preview instead.
    const content = [
      p('Alpha one'),
      p('Bravo two'),
      p('Charlie three'),
      p('Delta four'),
      p('Echo five'),
      p('Foxtrot six'),
      { type: 'gate', attrs: { showOn: 'email' } },
      p('Golf seven'),
    ];
    for (const visibility of ['members', 'paid'] as const) {
      const body = searchBody({ type: 'doc', content }, visibility, 'Notes');
      for (const word of ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf']) {
        expect(body, word).not.toContain(word);
      }
      // A break the website shows still indexes its free part, wherever an email-only one sits.
      const both = searchBody(
        { type: 'doc', content: [...content.slice(0, 2), { type: 'gate' }, ...content.slice(2)] },
        visibility,
        'Notes',
      );
      expect(both).toContain('Bravo two');
      expect(both).not.toContain('Charlie');
    }
    expect(searchBody({ type: 'doc', content }, 'public', 'Notes')).toContain('Golf seven');
  });
});

describe('site origin', () => {
  it('builds the platform address', () => {
    expect(platformSiteOrigin({ scheme: 'https', platformDomain: 'swarm.page' }, 'notes')).toBe(
      'https://notes.swarm.page',
    );
  });
});

describe('web hostnames', () => {
  const schema = z
    .object({ ENVIRONMENT: z.string(), ...WebHostingEnvFields })
    .superRefine(checkWebHostingEnv);
  const base = { SITE_FALLBACK_ORIGIN: 'sites.swarm.page' };

  it('allows the dev fake only locally and needs Cloudflare credentials', () => {
    expect(schema.safeParse({ ...base, ENVIRONMENT: 'test', WEB_HOSTNAMES: 'dev' }).success).toBe(
      true,
    );
    const prod = { ...base, ENVIRONMENT: 'production' };
    expect(schema.safeParse({ ...prod, WEB_HOSTNAMES: 'dev' }).success).toBe(false);
    expect(schema.safeParse({ ...prod, WEB_HOSTNAMES: 'cloudflare' }).success).toBe(false);
    expect(
      schema.safeParse({ ...prod, WEB_HOSTNAMES: 'cloudflare', CF_ZONE_ID: 'z', CF_API_TOKEN: 't' })
        .success,
    ).toBe(true);
    expect(webHostnames({ ...prod, WEB_HOSTNAMES: 'off' })).toBeNull();
  });

  it('talks to the Cloudflare custom hostname API with HTTP validation', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const replies: unknown[] = [
      { success: true, result: { id: 'cf-1', status: 'pending', ssl: { status: 'initializing' } } },
      {
        success: true,
        result: {
          id: 'cf-1',
          status: 'pending',
          verification_errors: ['custom hostname does not CNAME to this zone.'],
        },
      },
      { success: true, result: { id: 'cf-1', status: 'active', ssl: { status: 'active' } } },
      { success: false, errors: [{ message: 'not found' }] },
    ];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      const reply = replies.shift();
      return Response.json(reply, { status: (reply as { success: boolean }).success ? 200 : 404 });
    }) as typeof fetch;
    const cf = new CloudflareWebHostnames('zone-1', 'token', fetcher);

    expect(await cf.create('www.example.com')).toEqual({
      id: 'cf-1',
      status: 'pending',
      detail: null,
    });
    expect(calls[0]).toMatchObject({
      url: 'https://api.cloudflare.com/client/v4/zones/zone-1/custom_hostnames',
      method: 'POST',
      body: { hostname: 'www.example.com', ssl: { method: 'http', type: 'dv' } },
    });
    expect(await cf.status('cf-1')).toEqual({
      status: 'pending',
      detail: 'custom hostname does not CNAME to this zone.',
    });
    expect(await cf.status('cf-1')).toEqual({ status: 'active', detail: null });
    // Removing a hostname Cloudflare no longer knows is fine.
    await expect(cf.remove('cf-1')).resolves.toBeUndefined();
    expect(calls[3]).toMatchObject({ method: 'DELETE' });
  });
});
