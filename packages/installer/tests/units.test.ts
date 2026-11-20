import { readFile } from 'node:fs/promises';
import { RESERVED_SLUGS } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli';
import { CloudflareApi, upsertRecord } from '../src/cloudflare';
import { inlineParams, RestD1 } from '../src/d1';
import { FakeTransport } from '../src/fake';
import { hostnamesFor, routesFor } from '../src/hostnames';
import { resendZoneRecords } from '../src/resend';
import { WORKER_SES_ACTIONS, sesPolicyOutdated } from '../src/ses-policy';
import { emptyState, parseState } from '../src/state';
import { bootstrapOwner, mintSignInLink } from '../src/steps/bootstrap';
import { parseAuthToken } from '../src/steps/login';
import { caughtByWildcard, slugProblem } from '../src/steps/prompts';
import { InstallError } from '../src/ui';

describe('parseArgs', () => {
  it('defaults to install on production', () => {
    expect(parseArgs([])).toMatchObject({
      command: 'install',
      env: 'production',
      dryRun: false,
      yes: false,
    });
  });
  it('reads commands and flags', () => {
    expect(parseArgs(['enable', 'payments', '--env', 'staging', '--yes'])).toMatchObject({
      command: 'enable',
      feature: 'payments',
      env: 'staging',
      yes: true,
    });
    expect(parseArgs(['--dry-run', '--answers=a.json'])).toMatchObject({
      dryRun: true,
      answers: 'a.json',
    });
  });
  it('refuses unknown input with a hint', () => {
    expect(() => parseArgs(['--env', 'prod'])).toThrow(InstallError);
    expect(() => parseArgs(['enable', 'stripe'])).toThrow(
      /custom-domains, payments, google or debounce/,
    );
    expect(() => parseArgs(['deploy'])).toThrow(/Unknown command/);
  });
});

describe('hostnames', () => {
  it('prefix staging and keep every name one level deep', () => {
    const h = hostnamesFor('example.com', 'staging');
    expect(h.app).toBe('staging-app.example.com');
    expect(h.bounce).toBe('bounce.staging-mail.example.com');
    expect(h.wildcard).toBe(false);
    expect(routesFor('site', h, { customDomains: false, payments: false, google: false })).toEqual([
      { pattern: 'staging-media.example.com/*', zone_name: 'example.com' },
    ]);
  });

  it('flags proxied subdomains the wildcard would catch', () => {
    const h = hostnamesFor('example.com', 'production');
    const records = [
      { id: '1', type: 'CNAME', name: 'www.example.com', content: 'x', proxied: true },
      { id: '2', type: 'A', name: 'shop.example.com', content: '1.2.3.4', proxied: false },
      { id: '3', type: 'AAAA', name: 'app.example.com', content: '100::', proxied: true },
      { id: '4', type: 'A', name: 'example.com', content: '1.2.3.4', proxied: true },
      { id: '5', type: 'A', name: 'a.b.example.com', content: '1.2.3.4', proxied: true },
    ];
    expect(caughtByWildcard(records, h)).toEqual(['www.example.com']);
  });

  it('keep publication addresses away from installer names', () => {
    expect(slugProblem('letter')).toBeUndefined();
    expect(slugProblem('events')).toMatch(/reserved/);
    expect(slugProblem('app')).toBeDefined();
    expect(slugProblem('staging-notes')).toMatch(/used by Swarm/);
    expect(slugProblem('Bad Slug')).toBeDefined();
  });

  it.each(['production', 'staging'] as const)(
    'are all reserved for Channels on %s',
    (environment) => {
      const zone = 'example.com';
      // bounce.mail.example.com sits under mail: the label a Channel could take is the last one.
      const labels = Object.values(hostnamesFor(zone, environment))
        .filter((v): v is string => typeof v === 'string' && v.endsWith(`.${zone}`))
        .filter((host) => !host.includes('@'))
        .map(
          (host) =>
            host
              .slice(0, -zone.length - 1)
              .split('.')
              .at(-1) as string,
        );
      const prefix = environment === 'staging' ? 'staging-' : '';
      expect(labels).toEqual(
        expect.arrayContaining(
          ['events', 'sites', 'unsubscribe', 'dmarc'].map((label) => prefix + label),
        ),
      );
      for (const label of labels) expect(RESERVED_SLUGS).toContain(label);
    },
  );
});

describe('the workers SES policy', () => {
  it('lists exactly the actions in docs/deployment.md', async () => {
    const doc = await readFile(new URL('../../../docs/deployment.md', import.meta.url), 'utf8');
    const bullet = doc
      .split('\n')
      .find((line) => /^\d+\. \*\*IAM user\*\* for the workers/.test(line));
    const documented = [...(bullet ?? '').matchAll(/`(ses:\w+)`/g)].map((m) => m[1]);
    expect(documented.length).toBeGreaterThan(0);
    expect([...WORKER_SES_ACTIONS].sort()).toEqual(documented.sort());
  });

  it('counts an install with no recorded actions, or a missing one, as out of date', () => {
    expect(sesPolicyOutdated({})).toBe(true);
    expect(sesPolicyOutdated({ workerActions: WORKER_SES_ACTIONS.slice(1) })).toBe(true);
    expect(sesPolicyOutdated({ workerActions: WORKER_SES_ACTIONS })).toBe(false);
  });
});

describe('resendZoneRecords', () => {
  it('completes relative names and skips receiving and tracking records', () => {
    expect(
      resendZoneRecords('mail.example.com', [
        { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: 'p=abc' },
        {
          record: 'SPF',
          name: 'bounce.mail.example.com',
          type: 'TXT',
          value: 'v=spf1 include:amazonses.com ~all',
        },
        {
          record: 'SPF',
          name: 'bounce',
          type: 'MX',
          value: 'feedback-smtp.eu-west-1.amazonses.com',
          priority: 10,
        },
        {
          record: 'Receiving',
          name: 'mail.example.com',
          type: 'MX',
          value: 'inbound-smtp.resend.com',
        },
        { record: 'Tracking', name: 'links', type: 'CNAME', value: 'links.resend.com' },
      ]),
    ).toEqual([
      { type: 'TXT', name: 'resend._domainkey.mail.example.com', content: 'p=abc', proxied: false },
      {
        type: 'TXT',
        name: 'bounce.mail.example.com',
        content: 'v=spf1 include:amazonses.com ~all',
        proxied: false,
      },
      {
        type: 'MX',
        name: 'bounce.mail.example.com',
        content: 'feedback-smtp.eu-west-1.amazonses.com',
        priority: 10,
        proxied: false,
      },
    ]);
  });
});

describe('upsertRecord', () => {
  const setup = () => {
    const t = new FakeTransport({ zone: 'example.com' });
    return { t, cf: new CloudflareApi(t, 'token', 'test') };
  };

  it('updates a record whose content differs and leaves other TXT records alone', async () => {
    const { t, cf } = setup();
    t.dns.push(
      {
        id: 'a',
        type: 'TXT',
        name: '_dmarc.mail.example.com',
        content: '"v=DMARC1; p=none"',
        proxied: false,
      },
      {
        id: 'b',
        type: 'TXT',
        name: '_dmarc.mail.example.com',
        content: '"google-site-verification=x"',
        proxied: false,
      },
    );
    const record = {
      type: 'TXT' as const,
      name: '_dmarc.mail.example.com',
      content: 'v=DMARC1; p=quarantine',
    };
    expect(await upsertRecord(cf, 'zone', record)).toBe('updated');
    expect(t.dns.find((r) => r.id === 'a')?.content).toBe('"v=DMARC1; p=quarantine"');
    expect(t.dns.find((r) => r.id === 'b')?.content).toBe('"google-site-verification=x"');
    expect(await upsertRecord(cf, 'zone', record)).toBe('unchanged');
  });

  it('stops on a CNAME at a name that needs an AAAA record', async () => {
    const { t, cf } = setup();
    t.dns.push({
      id: 'c',
      type: 'CNAME',
      name: 'app.example.com',
      content: 'elsewhere.net',
      proxied: true,
    });
    await expect(
      upsertRecord(cf, 'zone', {
        type: 'AAAA',
        name: 'app.example.com',
        content: '100::',
        proxied: true,
      }),
    ).rejects.toThrow(/already has a CNAME/);
  });
});

describe('D1', () => {
  it('inlines parameters for the wrangler fallback', () => {
    expect(inlineParams('INSERT INTO t VALUES (?1, ?2, ?3, ?1)', ["it's", 3, null])).toBe(
      "INSERT INTO t VALUES ('it''s', 3, NULL, 'it''s')",
    );
  });

  it('bootstrap is idempotent: an existing owner, workspace and channel are reused', async () => {
    const statements: string[] = [];
    const t = new FakeTransport({
      zone: 'example.com',
      d1: (sql) => {
        statements.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
        if (/FROM operators/.test(sql)) return [{ id: 'op_existing' }];
        if (/FROM seats/.test(sql)) return [{ id: 'ws_existing' }];
        if (/sqlite_master/.test(sql))
          return [{ name: 'instance_admins' }, { name: 'instance_settings' }];
        if (/FROM channels/.test(sql)) return [{ id: 'ch_existing', workspace_id: 'ws_existing' }];
        return [];
      },
    });
    const db = new RestD1(new CloudflareApi(t, 'token', 'test'), 'account', 'db');
    const result = await bootstrapOwner(db, {
      email: 'ada@example.com',
      name: 'Ada',
      workspaceName: 'Letter',
      publication: { name: 'Letter', slug: 'letter' },
    });
    expect(result).toMatchObject({
      operatorId: 'op_existing',
      workspaceId: 'ws_existing',
      channelId: 'ch_existing',
      createdOperator: false,
      createdWorkspace: false,
      createdChannel: false,
    });
    const created = statements.filter((s) =>
      /^INSERT INTO (operators|workspaces|seats|channels|audit_events)/.test(s),
    );
    expect(created).toEqual([]);
    // The sign-up mode is only ever inserted with ON CONFLICT DO NOTHING, so a later choice stays.
    expect(statements).toContain('INSERT INTO instance_settings');
  });

  it('bootstrap creates the first publication with per-person tracking off', async () => {
    const inserts: unknown[][] = [];
    const t = new FakeTransport({
      zone: 'example.com',
      d1: (sql, params) => {
        if (/^\s*INSERT INTO channels/.test(sql)) inserts.push(params);
        if (/sqlite_master/.test(sql))
          return [{ name: 'instance_admins' }, { name: 'instance_settings' }];
        return [];
      },
    });
    const db = new RestD1(new CloudflareApi(t, 'token', 'test'), 'account', 'db');
    const result = await bootstrapOwner(db, {
      email: 'ada@example.com',
      name: 'Ada',
      workspaceName: 'Letter',
      publication: { name: 'Letter', slug: 'letter' },
    });
    expect(result.createdChannel).toBe(true);
    expect(inserts).toHaveLength(1);
    expect(JSON.parse(inserts[0]?.[7] as string)).toEqual({
      trackOpens: false,
      trackClicks: false,
      profileReaders: false,
    });
  });

  it('a sign-in link stores only the hash of its token', async () => {
    const seen: unknown[][] = [];
    const t = new FakeTransport({
      d1: (_sql, params) => {
        seen.push(params);
        return [];
      },
    });
    const db = new RestD1(new CloudflareApi(t, 'token', 'test'), 'account', 'db');
    const { link, expiresAt } = await mintSignInLink(
      db,
      'ada@example.com',
      'https://app.example.com',
      1_000,
    );
    const token = new URL(link).hash.replace('#token=', '');
    expect(link.startsWith('https://app.example.com/sign-in/continue#token=')).toBe(true);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(seen[0]).not.toContain(token);
    expect(seen[0]?.[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt).toBe(1_000 + 60 * 60 * 1000);
  });
});

describe('state and tokens', () => {
  it('round-trips state and rejects a broken file with a fix', () => {
    const state = emptyState('production');
    expect(parseState(JSON.stringify(state))).toEqual(state);
    expect(() => parseState('{"version":2}', '.swarm/production.json')).toThrow(/backup/);
  });

  it('reads the wrangler auth token in either format', () => {
    expect(parseAuthToken('{"type":"oauth","token":"abcdefghijklmnopqrstuvwxyz"}')).toBe(
      'abcdefghijklmnopqrstuvwxyz',
    );
    expect(parseAuthToken('abcdefghijklmnopqrstuvwxyz0123\n')).toBe(
      'abcdefghijklmnopqrstuvwxyz0123',
    );
    expect(parseAuthToken('')).toBeNull();
  });
});
