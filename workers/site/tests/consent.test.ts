import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { newId, type SiteCodeEntry } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { createSite, mountSite } from '../src/index';
import {
  addMember,
  allowSiteCode,
  call,
  seedChannel,
  sessionCookie,
  type SeededChannel,
  BROWSER_UA,
} from './helpers';

const site = createSite((s) => mountSite(s));

const GA: SiteCodeEntry = {
  name: 'Analytics',
  preset: 'google_analytics',
  category: 'analytics',
  value: 'G-ABC123DEF4',
};

async function setup(
  consent: Record<string, unknown>,
  code: SiteCodeEntry[],
  flag = true,
  /** Lets the workspace's code run on the platform address, as most tests here need. */
  allow = true,
): Promise<SeededChannel> {
  const ch = await seedChannel();
  if (allow) await allowSiteCode(ch.workspaceId);
  await env.DB.prepare(
    `INSERT INTO site_settings (channel_id, consent_json, code_json, updated_at) VALUES (?1, ?2, ?3, 0)
     ON CONFLICT (channel_id) DO UPDATE SET consent_json = ?2, code_json = ?3,
       cache_version = cache_version + 1`,
  )
    .bind(ch.channelId, JSON.stringify(consent), JSON.stringify(code))
    .run();
  if (flag) {
    await env.DB.prepare(
      `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at)
       VALUES (?1, 'site_custom_code', 'channel', ?2, 1, 0)`,
    )
      .bind(newId('featureFlag'), ch.channelId)
      .run();
  }
  return ch;
}

const get = (ch: SeededChannel, path: string, headers: Record<string, string> = {}) =>
  call(site, `${ch.origin}${path}`, { headers: { 'user-agent': BROWSER_UA, ...headers } });

const ON = {
  enabled: true,
  text: 'We use cookies.',
  acceptLabel: 'Accept all',
  rejectLabel: 'Reject all',
  policyUrl: '/cookies',
  position: 'bottom',
};

describe('a default site', () => {
  it('has no popup, no code and the strict policy', async () => {
    const ch = await setup({}, []);
    const res = await get(ch, '/');
    const html = await res.text();
    expect(html).not.toContain('sw-consent');
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).not.toContain('strict-dynamic');
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("font-src 'self';");
  });

  it('ignores saved code with the flag off', async () => {
    const ch = await setup(ON, [GA], false);
    const res = await get(ch, '/');
    expect(await res.text()).not.toContain('G-ABC123DEF4');
    expect(res.headers.get('content-security-policy')).not.toContain('strict-dynamic');
  });
});

describe('the popup and code', () => {
  it('keeps code out of the page’s own script tags, so nothing loads before consent', async () => {
    const ch = await setup(ON, [GA]);
    const res = await get(ch, '/');
    const html = await res.text();
    expect(html).toContain('id="sw-consent"');
    expect(html).toContain('Reject all');
    // The only place the tool appears is inert JSON read by the loader.
    expect(html).not.toMatch(/<script[^>]+googletagmanager/);
    const data = /<script type="application\/json" id="sw-consent-data"[^>]*>([^<]*)</.exec(html)!;
    expect(data[1]).toContain('G-ABC123DEF4');
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).toMatch(/script-src 'nonce-/);
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https:");
  });

  it('cannot be broken out of by what the owner pastes', async () => {
    const evil = '</script><script>alert(1)</script>';
    const ch = await setup(ON, [
      { name: 'Mine', preset: 'custom', category: 'analytics', value: evil },
    ]);
    const html = await (await get(ch, '/')).text();
    expect(html).not.toContain(evil);
    expect(html).toContain('\\u003c/script>');
  });

  it('runs analytics only through a popup: without one, only strictly necessary code', async () => {
    const needed: SiteCodeEntry = {
      name: 'Needed',
      preset: 'custom',
      category: 'necessary',
      value: '<script>window.needed=1</script>',
    };
    const ch = await setup({ enabled: false }, [GA, needed]);
    const html = await (await get(ch, '/')).text();
    expect(html).not.toContain('G-ABC123DEF4');
    expect(html).toContain('window.needed=1');
    expect(html).not.toContain('id="sw-consent"');
  });

  it('asks again when the code changes', async () => {
    const version = async (code: SiteCodeEntry[]) => {
      const ch = await setup(ON, code);
      const html = await (await get(ch, '/')).text();
      return /"v":"([^"]+)"/.exec(html)![1];
    };
    expect(await version([GA])).not.toBe(await version([{ ...GA, value: 'G-ZZZ999ZZZ9' }]));
  });

  it('puts a verification tag straight in the head, with the strict policy', async () => {
    const ch = await setup({}, [
      {
        name: 'Verify',
        preset: 'verification',
        category: 'necessary',
        value: '<meta name="site-verification" content="abc123">',
      },
    ]);
    const res = await get(ch, '/');
    const html = await res.text();
    expect(html.slice(0, html.indexOf('</head>'))).toContain(
      '<meta name="site-verification" content="abc123">',
    );
    expect(res.headers.get('content-security-policy')).not.toContain('strict-dynamic');
  });

  it('keeps the same nonce in the policy and the page on a cached copy', async () => {
    const ch = await setup(ON, [GA]);
    const res = await get(ch, '/');
    const nonce = /script-src 'nonce-([^']+)'/.exec(
      res.headers.get('content-security-policy')!,
    )![1];
    expect(await res.text()).toContain(`nonce="${nonce}"`);
  });

  it('leaves the plans page able to run the bot check under the wider policy', async () => {
    const ch = await setup(ON, [GA]);
    const res = await get(ch, '/subscribe');
    expect(res.headers.get('content-security-policy')).toContain(
      'https://challenges.cloudflare.com',
    );
  });
});

describe('where code never runs', () => {
  it('stays off gift links, and they keep the strict policy', async () => {
    const ch = await setup(ON, [GA]);
    const res = await get(ch, '/?gift=secret-token');
    expect(await res.text()).not.toContain('G-ABC123DEF4');
    expect(res.headers.get('content-security-policy')).not.toContain('strict-dynamic');
  });

  it('stays off every page for a signed-in reader, so it can’t act with their session', async () => {
    const ch = await setup(ON, [GA]);
    // The same page runs the code for a visitor.
    const visitor = await get(ch, '/');
    expect(visitor.headers.get('content-security-policy')).toContain('strict-dynamic');
    const memberId = await addMember(ch.channelId, `signed-in-${crypto.randomUUID()}@example.org`);
    const res = await get(ch, '/', { cookie: await sessionCookie(ch.channelId, memberId) });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('G-ABC123DEF4');
    expect(res.headers.get('content-security-policy')).not.toContain('strict-dynamic');
  });
});

describe('the referral cookie', () => {
  const setsCookie = (res: Response) => (res.headers.get('set-cookie') ?? '').includes('swarm_ref');

  it('is set as before with no popup', async () => {
    const ch = await setup({}, []);
    expect(setsCookie(await get(ch, '/?ref=abcd2345'))).toBe(true);
  });

  it('waits for marketing consent with a popup on, while the form still carries the code', async () => {
    const ch = await setup(ON, [GA]);
    const res = await get(ch, '/r/abcd2345');
    expect(setsCookie(res)).toBe(false);
    expect(res.headers.get('location')).toBe('/?ref=abcd2345');
    expect(setsCookie(await get(ch, '/?ref=abcd2345'))).toBe(false);
    const v = await currentVersion(ch);
    const allowed = await get(ch, '/r/abcd2345', { cookie: `swarm_consent=${v}.01` });
    expect(setsCookie(allowed)).toBe(true);
    const refused = await get(ch, '/r/abcd2345', { cookie: `swarm_consent=${v}.10` });
    expect(setsCookie(refused)).toBe(false);
  });

  it('needs a choice made on the current wording and code', async () => {
    const ch = await setup(ON, [GA]);
    const stale = await get(ch, '/r/abcd2345', { cookie: 'swarm_consent=x.01' });
    expect(setsCookie(stale)).toBe(false);
  });

  it('over https, reads only the __Host- choice, which a sibling site cannot set', async () => {
    const ch = await setup(ON, [GA]);
    const v = await currentVersion(ch);
    // A Domain=<zone> cookie from another Channel's owner code arrives under the old name.
    const tossed = await getHttps(ch, '/r/abcd2345', `swarm_consent=${v}.11`);
    expect(tossed.headers.get('set-cookie') ?? '').not.toContain('swarm_ref');
    const own = await getHttps(ch, '/r/abcd2345', `__Host-swarm_consent=${v}.01`);
    expect(own.headers.get('set-cookie') ?? '').toContain('__Host-swarm_ref=abcd2345');
  });
});

/** The version a reader's stored choice must carry, as the page publishes it. */
async function currentVersion(ch: SeededChannel): Promise<string> {
  const html = await (await get(ch, '/')).text();
  return /"v":"([^"]+)"/.exec(html)![1]!;
}

/** The same site as deployed, over https. */
async function getHttps(ch: SeededChannel, path: string, cookie?: string): Promise<Response> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = { 'user-agent': BROWSER_UA };
  if (cookie) headers.cookie = cookie;
  const req = new Request(`https://${ch.host}${path}`, { redirect: 'manual', headers });
  const res = await site.fetch(req, { ...env, SITE_SCHEME: 'https' }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

interface StoredCookie {
  name: string;
  value: string;
  domain: string | null;
  secure: boolean;
}

/**
 * One host's cookie store as document.cookie sees it on a page at /: a host-only cookie and a
 * Domain= cookie of the same name are separate entries, and __Host- needs Secure and no Domain.
 */
function cookieJar() {
  const list: StoredCookie[] = [];
  return {
    list,
    plant(name: string, value: string, domain: string | null = null) {
      list.push({ name, value, domain, secure: true });
    },
    get cookie() {
      return list.map((c) => `${c.name}=${c.value}`).join('; ');
    },
    set cookie(text: string) {
      const [pair = '', ...parts] = text.split(';').map((p) => p.trim());
      const at = pair.indexOf('=');
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      const attrs = new Map(
        parts.map((p) => {
          const eq = p.indexOf('=');
          return eq < 0 ? [p.toLowerCase(), ''] : [p.slice(0, eq).toLowerCase(), p.slice(eq + 1)];
        }),
      );
      const domain = attrs.get('domain') ?? null;
      const secure = attrs.has('secure');
      if ((attrs.get('path') ?? '/') !== '/') return;
      if (name.startsWith('__Host-') && (!secure || domain !== null)) return;
      const index = list.findIndex((c) => c.name === name && c.domain === domain);
      const entry = { name, value, domain, secure };
      if (attrs.get('max-age') === '0') {
        if (index >= 0) list.splice(index, 1);
      } else if (index >= 0) list[index] = entry;
      else list.push(entry);
    },
  };
}

/** Runs the page's own consent loader against a fake document, and says what it did. */
function runLoader(html: string, jar: ReturnType<typeof cookieJar>, protocol: string) {
  const data = /<script type="application\/json" id="sw-consent-data"[^>]*>([^<]*)</.exec(
    html,
  )![1]!;
  const loader = /<script nonce="[^"]+">(\(function\(\)\{var d=document[\s\S]*?)<\/script>/.exec(
    html,
  )![1]!;
  let ran = 0;
  let onClick: ((e: unknown) => void) | null = null;
  const box = {
    hidden: true,
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: (_: string, fn: (e: unknown) => void) => (onClick = fn),
  };
  const doc = {
    currentScript: { nonce: 'n' },
    getElementById: (id: string) =>
      id === 'sw-consent-data' ? { textContent: data } : id === 'sw-consent' ? box : null,
    createElement: () => {
      ran++;
      return { innerHTML: '', content: { childNodes: [] } };
    },
    get cookie() {
      return jar.cookie;
    },
    set cookie(text: string) {
      jar.cookie = text;
    },
  };
  new Function('document', 'location', loader)(doc, { protocol, reload() {} });
  const choose = (choice: string) =>
    onClick!({ target: { closest: () => ({ getAttribute: () => choice }) } });
  return { shown: !box.hidden, ran, choose };
}

describe('the reader’s choice in the browser', () => {
  // The edge cache key has no scheme (one per deployment), so each Channel is read over one only.
  const page = async (ch: SeededChannel, scheme: 'http' | 'https') => {
    const html = await (await (scheme === 'https' ? getHttps(ch, '/') : get(ch, '/'))).text();
    return { html, v: /"v":"([^"]+)"/.exec(html)![1]! };
  };

  it('ignores a choice another site on the same domain set, and asks', async () => {
    const { html, v } = await page(await setup(ON, [GA]), 'https');
    const jar = cookieJar();
    jar.plant('swarm_consent', `${v}.11`, 'swarm.test');
    const out = runLoader(html, jar, 'https:');
    expect(out.shown).toBe(true);
    expect(out.ran).toBe(0);
    expect(jar.list.map((c) => c.name)).toEqual(['swarm_consent']);
  });

  it('keeps a reader’s earlier choice on this host once, under the __Host- name', async () => {
    const { html, v } = await page(await setup(ON, [GA]), 'https');
    const jar = cookieJar();
    // A tossed cookie listed first, then the reader's own host-only one.
    jar.plant('swarm_consent', `${v}.11`, 'swarm.test');
    jar.plant('swarm_consent', `${v}.10`);
    const out = runLoader(html, jar, 'https:');
    expect(out.shown).toBe(false);
    expect(out.ran).toBe(1);
    expect(jar.list).toContainEqual({
      name: '__Host-swarm_consent',
      value: `${v}.10`,
      domain: null,
      secure: true,
    });
    expect(jar.list.filter((c) => c.name === 'swarm_consent' && c.domain === null)).toEqual([]);
    // Later pages read the __Host- cookie and leave the tossed one alone.
    const later = runLoader(html, jar, 'https:');
    expect(later.shown).toBe(false);
    expect(later.ran).toBe(1);
  });

  it('stores a new choice as __Host- over https', async () => {
    const { html, v } = await page(await setup(ON, [GA]), 'https');
    const jar = cookieJar();
    runLoader(html, jar, 'https:').choose('none');
    expect(jar.list).toEqual([
      { name: '__Host-swarm_consent', value: `${v}.00`, domain: null, secure: true },
    ]);
  });

  it('keeps the plain name over http, for local development', async () => {
    const { html, v } = await page(await setup(ON, [GA]), 'http');
    const jar = cookieJar();
    runLoader(html, jar, 'http:').choose('all');
    expect(jar.list).toEqual([
      { name: 'swarm_consent', value: `${v}.11`, domain: null, secure: false },
    ]);
    const again = runLoader(html, jar, 'http:');
    expect(again.shown).toBe(false);
    expect(again.ran).toBe(1);
  });
});

const hex = () => crypto.randomUUID().replace(/-/g, '');

async function addOwner(workspaceId: string, role = 'owner', instanceAdmin = true) {
  const operatorId = `op_${hex()}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO operators (id, email, created_at, updated_at) VALUES (?1, ?2, 0, 0)`,
    ).bind(operatorId, `${operatorId}@example.com`),
    env.DB.prepare(
      `INSERT INTO seats (id, workspace_id, operator_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 0, 0)`,
    ).bind(`st_${hex()}`, workspaceId, operatorId, role),
    ...(instanceAdmin
      ? [
          env.DB.prepare(
            'INSERT INTO instance_admins (operator_id, created_at) VALUES (?1, 0)',
          ).bind(operatorId),
        ]
      : []),
  ]);
  return operatorId;
}

async function addCustomDomain(ch: SeededChannel, status = 'active'): Promise<string> {
  const hostname = `news-${hex().slice(0, 10)}.example`;
  await env.DB.prepare(
    `INSERT INTO custom_hostnames (id, workspace_id, channel_id, hostname, role, status, is_primary, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'web', ?5, 1, 0, 0)`,
  )
    .bind(`hn_${hex()}`, ch.workspaceId, ch.channelId, hostname, status)
    .run();
  return `http://${hostname}`;
}

const VERIFY: SiteCodeEntry = {
  name: 'Verify',
  preset: 'verification',
  category: 'necessary',
  value: '<meta name="site-verification" content="abc123">',
};

const runsCode = async (res: Response) => {
  const html = await res.text();
  return (
    html.includes('G-ABC123DEF4') &&
    !!res.headers.get('content-security-policy')?.includes('strict-dynamic')
  );
};

describe('where code may run (several workspaces on one install)', () => {
  it('keeps scripts off the platform address of a workspace nobody allowed', async () => {
    const ch = await setup(ON, [GA, VERIFY], true, false);
    const res = await get(ch, '/');
    const html = await res.text();
    expect(html).not.toContain('G-ABC123DEF4');
    expect(res.headers.get('content-security-policy')).not.toContain('strict-dynamic');
    // Saved code is kept, the popup still asks, and the verification tag loads nothing.
    expect(html).toContain('id="sw-consent"');
    expect(html).toContain('<meta name="site-verification" content="abc123">');
  });

  it('runs on the publication’s own custom domain, never on its platform address', async () => {
    const ch = await setup(ON, [GA], true, false);
    const custom = await addCustomDomain(ch);
    const own = await call(site, `${custom}/`, { headers: { 'user-agent': BROWSER_UA } });
    expect(await runsCode(own)).toBe(true);
    expect(await runsCode(await get(ch, '/'))).toBe(false);
  });

  it('does not count a domain that is not active yet', async () => {
    const ch = await setup(ON, [GA], true, false);
    await addCustomDomain(ch, 'pending');
    expect(await runsCode(await get(ch, '/'))).toBe(false);
  });

  it('does not run because an instance admin is an owner: any owner can make one', async () => {
    const ch = await setup(ON, [GA], true, false);
    await addOwner(ch.workspaceId);
    expect(await runsCode(await get(ch, '/'))).toBe(false);
  });

  it('does not count an instance admin with a lesser seat, or an owner who is not one', async () => {
    const ch = await setup(ON, [GA], true, false);
    await addOwner(ch.workspaceId, 'admin', true);
    await addOwner(ch.workspaceId, 'owner', false);
    expect(await runsCode(await get(ch, '/'))).toBe(false);
  });

  it('runs where an instance admin allowed the workspace, and only there', async () => {
    const allowed = await setup(ON, [GA]);
    const other = await setup(ON, [GA], true, false);
    expect(await runsCode(await get(allowed, '/'))).toBe(true);
    expect(await runsCode(await get(other, '/'))).toBe(false);
  });

  it('runs for every workspace when the instance-wide switch is on', async () => {
    const ch = await setup(ON, [GA], true, false);
    await env.DB.prepare(
      'INSERT INTO site_code_rules (id, every_workspace, updated_at) VALUES (1, 1, 0)',
    ).run();
    try {
      expect(await runsCode(await get(ch, '/'))).toBe(true);
    } finally {
      await env.DB.prepare('DELETE FROM site_code_rules').run();
    }
  });

  it('keeps code withheld when the switch went on off until its workspace is allowed', async () => {
    const ch = await setup(ON, [GA], true, false);
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO site_code_rules (id, every_workspace, updated_at) VALUES (1, 1, 0)',
      ),
      env.DB.prepare('INSERT INTO site_code_held (workspace_id, held_at) VALUES (?1, 0)').bind(
        ch.workspaceId,
      ),
    ]);
    try {
      expect(await runsCode(await get(ch, '/'))).toBe(false);
      await allowSiteCode(ch.workspaceId);
      await env.DB.prepare('UPDATE site_settings SET cache_version = cache_version + 1').run();
      expect(await runsCode(await get(ch, '/'))).toBe(true);
    } finally {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM site_code_rules'),
        env.DB.prepare('DELETE FROM site_code_held'),
      ]);
    }
  });
});
