import { env } from 'cloudflare:test';
import { sha256Hex } from '@swarm/db';
import { describe, expect, it } from 'vitest';
import { safeReturnPath } from '../src/readers/returnPath';
import { READER_SESSION_MAX_MS } from '../src/readers/session';
import {
  READER_COOKIE,
  addEntitlement,
  addMember,
  call,
  mailTo,
  nextIp,
  seedChannel,
  sessionCookie,
  testSite,
  uniqueEmail,
  type SeededChannel,
} from './helpers';

const site = testSite();

function form(origin: string, fields: Record<string, string>, extra: Record<string, string> = {}) {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin,
      'sec-fetch-site': 'same-origin',
      'cf-connecting-ip': nextIp(),
      ...extra,
    },
    body: new URLSearchParams(fields).toString(),
  };
}

async function requestLink(ch: SeededChannel, email: string, returnPath = '/') {
  return call(
    site,
    `${ch.origin}/_swarm/reader/signin`,
    form(ch.origin, { email, return: returnPath }),
  );
}

const linkIn = (text: string) =>
  /https?:\/\/\S+\/_swarm\/reader\/consume\?token=\S+/.exec(text)?.[0] ?? '';

async function linkFor(email: string): Promise<string> {
  const [mail] = await mailTo(email);
  const link = linkIn(mail?.text ?? '');
  if (!link) throw new Error(`no sign-in link mailed to ${email}`);
  return link;
}

const tokenOf = (link: string) => new URL(link).searchParams.get('token') ?? '';

async function consume(ch: SeededChannel, token: string, extra: Record<string, string> = {}) {
  return call(site, `${ch.origin}/_swarm/reader/consume`, form(ch.origin, { token }, extra));
}

const cookieFrom = (res: Response) =>
  /swarm_reader=[^;]+/.exec(res.headers.get('set-cookie') ?? '')?.[0] ?? '';

/** The cookie the sign-in form sets in the browser that asked for a link. */
const linkCookieFrom = (res: Response) =>
  /swarm_reader_link=[^;]+/.exec(res.headers.get('set-cookie') ?? '')?.[0] ?? '';

async function whoami(ch: SeededChannel, cookie: string) {
  const res = await call(site, `${ch.origin}/whoami`, { headers: { cookie } });
  return ((await res.json()) as { reader: { class: string; memberId: string | null } }).reader;
}

describe('reader sign-in', () => {
  it('answers the same for subscribers and non-subscribers, and mails only subscribers', async () => {
    const ch = await seedChannel();
    const memberEmail = uniqueEmail('member');
    const strangerEmail = uniqueEmail('stranger');
    const unsubscribedEmail = uniqueEmail('gone');
    await addMember(ch.channelId, memberEmail);
    await addMember(ch.channelId, unsubscribedEmail, 'unsubscribed');

    const answers = [];
    for (const email of [memberEmail, strangerEmail, unsubscribedEmail]) {
      const res = await requestLink(ch, email);
      expect(res.status).toBe(200);
      answers.push((await res.text()).replace(email, 'EMAIL'));
    }
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toContain('Check your email');

    expect(await mailTo(memberEmail)).toHaveLength(1);
    expect(await mailTo(strangerEmail)).toHaveLength(0);
    expect(await mailTo(unsubscribedEmail)).toHaveLength(0);
  });

  it('mails paused subscribers too, and links to the publication origin', async () => {
    const ch = await seedChannel();
    const email = uniqueEmail();
    await addMember(ch.channelId, email, 'paused');
    await requestLink(ch, email);
    const link = await linkFor(email);
    expect(link.startsWith(`${ch.origin}/_swarm/reader/consume?token=`)).toBe(true);
  });

  it('does not mail a subscriber of another publication', async () => {
    const ch = await seedChannel();
    const other = await seedChannel();
    const email = uniqueEmail();
    await addMember(other.channelId, email);
    await requestLink(ch, email);
    expect(await mailTo(email)).toHaveLength(0);
  });

  it('consumes only on POST, sets the cookie, returns to a safe path and refuses replays', async () => {
    const ch = await seedChannel();
    const email = uniqueEmail();
    const memberId = await addMember(ch.channelId, email);
    const browser = linkCookieFrom(await requestLink(ch, email, '/p/hello?x=1'));
    expect(browser).not.toBe('');
    const link = await linkFor(email);
    const token = tokenOf(link);

    // GET shows a Continue page and consumes nothing (link scanners prefetch GETs).
    const page = await call(site, link);
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain('Continue');
    // It names the address it signs in as: a link can be forwarded to someone else.
    expect(text).toContain(`Sign in as <b>${email}</b>`);
    expect(page.headers.get('set-cookie')).toBeNull();
    const row = await env.DB.prepare('SELECT consumed_at FROM reader_tokens WHERE token_hash = ?1')
      .bind(await sha256Hex(token))
      .first<{ consumed_at: number | null }>();
    expect(row?.consumed_at).toBeNull();

    // The browser that asked for the link goes back to where it was.
    const res = await consume(ch, token, { cookie: browser });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/p/hello?x=1');
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${READER_COOKIE}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toContain('Domain');

    const reader = await whoami(ch, cookieFrom(res));
    expect(reader).toEqual({ class: 'member', memberId, levelId: null });

    const replay = await consume(ch, token);
    expect(replay.status).toBe(410);
    expect(replay.headers.get('set-cookie')).toBeNull();
  });

  it('refuses cross-site posts', async () => {
    const ch = await seedChannel();
    const email = uniqueEmail();
    await addMember(ch.channelId, email);
    const crossSite = await call(
      site,
      `${ch.origin}/_swarm/reader/signin`,
      form(
        ch.origin,
        { email },
        { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      ),
    );
    expect(crossSite.status).toBe(403);
    expect(await mailTo(email)).toHaveLength(0);

    await requestLink(ch, email);
    const token = tokenOf(await linkFor(email));
    const forced = await consume(ch, token, { 'sec-fetch-site': 'cross-site' });
    expect(forced.status).toBe(403);
    expect(forced.headers.get('set-cookie')).toBeNull();
    // The token survived the refused attempt.
    expect((await consume(ch, token)).status).toBe(303);
  });

  it('takes Origin: null only from a same-origin page, and refuses posts with neither header', async () => {
    const ch = await seedChannel();
    const email = uniqueEmail();
    await addMember(ch.channelId, email);
    await requestLink(ch, email);
    const token = tokenOf(await linkFor(email));
    const post = (headers: Record<string, string>) =>
      call(site, `${ch.origin}/_swarm/reader/consume`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'cf-connecting-ip': nextIp(),
          ...headers,
        },
        body: new URLSearchParams({ token }).toString(),
      });
    // A sandboxed frame or data: page on another site, in a browser without Sec-Fetch-Site.
    const opaque = await post({ origin: 'null' });
    expect(opaque.status).toBe(403);
    expect(opaque.headers.get('set-cookie')).toBeNull();
    expect((await post({})).status).toBe(403);
    // A no-referrer page's own form: browsers send Origin: null with Sec-Fetch-Site: same-origin.
    expect((await consume(ch, token, { origin: 'null' })).status).toBe(303);
  });

  it('ignores the return path of a link someone else asked for', async () => {
    const ch = await seedChannel();
    const attackerEmail = uniqueEmail('sender');
    const attacker = await addMember(ch.channelId, attackerEmail);
    const victim = await addMember(ch.channelId, uniqueEmail('victim'));
    // The sender asks for a link to their own address with a page of their choosing, then gets
    // someone else to continue it in their browser.
    const used = new Set<string>();
    const senderLink = async () => {
      // Three links in all, which the per-address limit (three in half an hour) allows.
      await requestLink(ch, attackerEmail, '/p/chosen-by-sender');
      const tokens = (await mailTo(attackerEmail)).map((mail) => tokenOf(linkIn(mail.text ?? '')));
      const token = tokens.find((t) => !used.has(t)) ?? '';
      used.add(token);
      return token;
    };

    // Signed in as someone else on this site: the session changes, so the page goes home.
    const signedIn = await sessionCookie(ch.channelId, victim);
    const switched = await consume(ch, await senderLink(), { cookie: signedIn });
    expect(switched.status).toBe(303);
    expect(switched.headers.get('location')).toBe('/');

    // Not signed in, and the link was not asked for from this browser: home too.
    const fresh = await consume(ch, await senderLink());
    expect(fresh.status).toBe(303);
    expect(fresh.headers.get('location')).toBe('/');

    // Already signed in as the link's Member: nothing changes, so the return path is kept.
    const same = await sessionCookie(ch.channelId, attacker);
    const kept = await consume(ch, await senderLink(), { cookie: same });
    expect(kept.headers.get('location')).toBe('/p/chosen-by-sender');
  });

  it('says when continuing replaces the reader signed in on this browser', async () => {
    const ch = await seedChannel();
    const senderEmail = uniqueEmail('sender');
    const sender = await addMember(ch.channelId, senderEmail);
    const readerEmail = uniqueEmail('reader');
    const signedIn = await addMember(ch.channelId, readerEmail);
    await requestLink(ch, senderEmail);
    const link = await linkFor(senderEmail);
    const notice = 'Continuing signs you in as';

    const switching = await (
      await call(site, link, { headers: { cookie: await sessionCookie(ch.channelId, signedIn) } })
    ).text();
    expect(switching).toContain(
      `You are signed in as <b>${readerEmail}</b>. ${notice} <b>${senderEmail}</b> instead.`,
    );

    // Not signed in, or already signed in as the link's Member: nothing to warn about.
    expect(await (await call(site, link)).text()).not.toContain(notice);
    const same = await sessionCookie(ch.channelId, sender);
    expect(await (await call(site, link, { headers: { cookie: same } })).text()).not.toContain(
      notice,
    );
  });

  it('falls back to "/" for open-redirect attempts', async () => {
    const ch = await seedChannel();
    const email = uniqueEmail();
    await addMember(ch.channelId, email);
    await requestLink(ch, email, '/.//evil.example/');
    const res = await consume(ch, tokenOf(await linkFor(email)));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
  });

  it('refuses tokens from another publication', async () => {
    const ch = await seedChannel();
    const other = await seedChannel();
    const email = uniqueEmail();
    await addMember(ch.channelId, email);
    await requestLink(ch, email);
    const token = tokenOf(await linkFor(email));
    expect((await consume(other, token)).status).toBe(410);
    expect((await consume(ch, token)).status).toBe(303);
  });

  it('signs out', async () => {
    const ch = await seedChannel();
    const memberId = await addMember(ch.channelId, uniqueEmail());
    const cookie = await sessionCookie(ch.channelId, memberId);
    const res = await call(site, `${ch.origin}/_swarm/reader/signout`, {
      ...form(ch.origin, { return: '/p/x' }),
      headers: { ...form(ch.origin, {}).headers, cookie },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/p/x');
    expect((await whoami(ch, cookie)).class).toBe('anonymous');
  });

  it('signs out on every device, leaving other readers signed in', async () => {
    const ch = await seedChannel();
    const memberId = await addMember(ch.channelId, uniqueEmail());
    const other = await addMember(ch.channelId, uniqueEmail());
    const laptop = await sessionCookie(ch.channelId, memberId);
    const phone = await sessionCookie(ch.channelId, memberId);
    const someoneElse = await sessionCookie(ch.channelId, other);
    const res = await call(site, `${ch.origin}/_swarm/reader/signout`, {
      ...form(ch.origin, { everywhere: '1' }),
      headers: { ...form(ch.origin, {}).headers, cookie: laptop },
    });
    expect(res.status).toBe(303);
    expect((await whoami(ch, laptop)).class).toBe('anonymous');
    expect((await whoami(ch, phone)).class).toBe('anonymous');
    expect((await whoami(ch, someoneElse)).class).toBe('member');
  });

  it('ends the session a browser had when another starts there', async () => {
    const ch = await seedChannel();
    const before = await addMember(ch.channelId, uniqueEmail());
    const email = uniqueEmail();
    await addMember(ch.channelId, email);
    const old = await sessionCookie(ch.channelId, before);
    const asked = await requestLink(ch, email);
    const res = await consume(ch, tokenOf(await linkFor(email)), {
      cookie: `${old}; ${linkCookieFrom(asked)}`,
    });
    expect(res.status).toBe(303);
    // The replaced cookie can't be used from anywhere else afterwards.
    expect((await whoami(ch, old)).class).toBe('anonymous');
  });
});

describe('safe return paths', () => {
  it.each([
    ['/p/hello?x=1#top', '/p/hello?x=1#top'],
    ['/', '/'],
    ['//evil.example', '/'],
    ['/.//evil.example', '/'],
    ['/./\\evil.example', '/'],
    ['/\\evil.example', '/'],
    ['https://evil.example/', '/'],
    ['javascript:alert(1)', '/'],
    ['/\t/evil.example', '/'],
    ['/%2F%2Fevil.example', '/%2F%2Fevil.example'],
    ['/_swarm/reader/signin', '/'],
    ['p/relative', '/'],
    [null, '/'],
  ])('%s → %s', (input, expected) => {
    expect(safeReturnPath(input)).toBe(expected);
  });
});

describe('reader classes', () => {
  it('resolves member, paid and expired entitlements', async () => {
    const ch = await seedChannel();
    const now = Date.now();
    const member = await addMember(ch.channelId, uniqueEmail());
    const paid = await addMember(ch.channelId, uniqueEmail());
    const lapsed = await addMember(ch.channelId, uniqueEmail());
    const future = await addMember(ch.channelId, uniqueEmail());
    await addEntitlement(ch.channelId, paid, now - 1000, null);
    await addEntitlement(ch.channelId, lapsed, now - 10_000, now - 1000);
    await addEntitlement(ch.channelId, future, now + 60_000, null);

    expect((await whoami(ch, await sessionCookie(ch.channelId, member))).class).toBe('member');
    expect((await whoami(ch, await sessionCookie(ch.channelId, paid))).class).toBe('paid');
    expect((await whoami(ch, await sessionCookie(ch.channelId, lapsed))).class).toBe('member');
    expect((await whoami(ch, await sessionCookie(ch.channelId, future))).class).toBe('member');
  });

  it('reads an unsubscribed subscriber as anonymous', async () => {
    const ch = await seedChannel();
    const memberId = await addMember(ch.channelId, uniqueEmail());
    const cookie = await sessionCookie(ch.channelId, memberId);
    expect((await whoami(ch, cookie)).class).toBe('member');
    await env.DB.prepare("UPDATE members SET status = 'unsubscribed' WHERE id = ?1")
      .bind(memberId)
      .run();
    expect(await whoami(ch, cookie)).toEqual({ class: 'anonymous', memberId: null, levelId: null });
  });

  it('never revives a session when an unsubscribed subscriber comes back', async () => {
    const ch = await seedChannel();
    const memberId = await addMember(ch.channelId, uniqueEmail());
    const cookie = await sessionCookie(ch.channelId, memberId);
    for (const status of ['unsubscribed', 'active']) {
      await env.DB.prepare('UPDATE members SET status = ?1 WHERE id = ?2')
        .bind(status, memberId)
        .run();
    }
    expect((await whoami(ch, cookie)).class).toBe('anonymous');
    const left = await env.DB.prepare(
      'SELECT count(*) AS n FROM reader_sessions WHERE member_id = ?1',
    )
      .bind(memberId)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it('ends a session at its absolute lifetime, however active', async () => {
    const ch = await seedChannel();
    const memberId = await addMember(ch.channelId, uniqueEmail());
    const cookie = await sessionCookie(ch.channelId, memberId);
    expect((await whoami(ch, cookie)).class).toBe('member');
    const now = Date.now();
    await env.DB.prepare(
      'UPDATE reader_sessions SET created_at = ?1, last_seen_at = ?2, expires_at = ?3 WHERE member_id = ?4',
    )
      .bind(now - READER_SESSION_MAX_MS - 1000, now, now + 86_400_000, memberId)
      .run();
    expect((await whoami(ch, cookie)).class).toBe('anonymous');
  });

  it("does not accept one publication's session on another", async () => {
    const ch = await seedChannel();
    const other = await seedChannel();
    const memberId = await addMember(ch.channelId, uniqueEmail());
    const cookie = await sessionCookie(ch.channelId, memberId);
    expect((await whoami(ch, cookie)).class).toBe('member');
    expect((await whoami(other, cookie)).class).toBe('anonymous');
  });

  it('ignores forged and expired session cookies', async () => {
    const ch = await seedChannel();
    const memberId = await addMember(ch.channelId, uniqueEmail());
    const cookie = await sessionCookie(ch.channelId, memberId);
    expect((await whoami(ch, `${cookie}x`)).class).toBe('anonymous');
    expect((await whoami(ch, `${READER_COOKIE}=v1.reader-session.r1.e30.abc`)).class).toBe(
      'anonymous',
    );
    await env.DB.prepare('UPDATE reader_sessions SET expires_at = 1 WHERE member_id = ?1')
      .bind(memberId)
      .run();
    expect((await whoami(ch, cookie)).class).toBe('anonymous');
  });
});
