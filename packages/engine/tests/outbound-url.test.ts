// The outbound destination policy (security review S02-P3-T-platform-host-egress): the install's
// own hosts are refused on every path that calls a tenant-chosen or vendor-given address, at
// every hop. It says nothing about what real Worker egress can reach.
import { afterEach, describe, expect, it } from 'vitest';
import { fetchFeed } from '../src/feed-sync';
import { webhookUrlProblem as flowStepUrlProblem } from '../src/flows-webhook';
import {
  outboundUrlProblem,
  platformHostsFromEnv,
  setOutboundPlatformHosts,
} from '../src/outbound-url';
import { webhookEndpointUrlProblem as webhookUrlProblem } from '../src/webhooks';

const PRODUCTION = {
  ENVIRONMENT: 'production',
  APP_ORIGIN: 'https://app.swarm.example',
  CAPTURE_ORIGIN: 'https://forms.swarm.example',
  MEDIA_ORIGIN: 'https://media.swarm.example',
  TRACK_ORIGIN: 'https://t.swarm.example/',
  SITE_FALLBACK_ORIGIN: 'sites.swarm.page',
  PLATFORM_SITE_DOMAIN: 'swarm.page',
  PLATFORM_MAIL_DOMAIN: 'mail.swarm.example',
  OUTBOUND_BLOCKED_HOSTS: 'status.swarm.example, Internal.Example.ORG',
  DEBOUNCE_API_KEY: 'not-a-host',
};

afterEach(() => setOutboundPlatformHosts([]));

describe('the install’s own hosts', () => {
  it('come from the origins, the platform domains and the extra list', () => {
    expect(platformHostsFromEnv(PRODUCTION).sort()).toEqual(
      [
        'app.swarm.example',
        'forms.swarm.example',
        'internal.example.org',
        'mail.swarm.example',
        'media.swarm.example',
        'sites.swarm.page',
        'status.swarm.example',
        'swarm.page',
        't.swarm.example',
      ].sort(),
    );
  });

  it('are refused, with every name under them, on webhooks, Flow steps and feeds', () => {
    setOutboundPlatformHosts(platformHostsFromEnv(PRODUCTION));
    const refused = [
      'https://app.swarm.example/api/v1/anything',
      'https://APP.swarm.example./x',
      'https://t.swarm.example/c/abc',
      'https://a-channel.swarm.page/feed.xml',
      'https://internal.example.org/',
      'https://deep.internal.example.org/',
    ];
    for (const url of refused) {
      expect(outboundUrlProblem(url), url).toMatch(/own addresses/);
      expect(webhookUrlProblem(url, 'production'), url).not.toBeNull();
      expect(flowStepUrlProblem(url), url).not.toBeNull();
    }
    for (const url of [
      'https://hooks.example.com/in',
      'https://swarm.example.evil.com/in',
      'https://notswarm.page/in',
    ]) {
      expect(outboundUrlProblem(url), url).toBeNull();
    }
    // http stays a development-only allowance, under staging and production values too.
    expect(webhookUrlProblem('http://hooks.example.com/in', 'staging')).not.toBeNull();
    expect(webhookUrlProblem('http://hooks.example.com/in', 'production')).not.toBeNull();
    expect(webhookUrlProblem('http://hooks.example.com/in', 'development')).toBeNull();
  });

  it('are refused when a feed redirects to one, before it is contacted', async () => {
    setOutboundPlatformHosts(platformHostsFromEnv(PRODUCTION));
    const seen: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(null, {
        status: 302,
        headers: { location: 'https://app.swarm.example/api/v1/me' },
      });
    }) as typeof fetch;
    await expect(
      fetchFeed(
        'https://feeds.example.com/rss',
        { etag: null, lastModified: null },
        { fetch: fetcher, environment: 'production' },
      ),
    ).rejects.toThrow(/not allowed/);
    expect(seen).toEqual(['https://feeds.example.com/rss']);
  });
});
