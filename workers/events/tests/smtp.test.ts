import { SELF, env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import { bounceCode, svixSignature, unsubscribeCode } from '@swarm/engine';
import { parseKeyring } from '@swarm/tokens';
import { describe, expect, it } from 'vitest';
import { app, handleEmail } from '../src/index';

async function seedDelivery(mailboxDomain = 'example.org') {
  const now = Date.now();
  const ids = {
    workspace: newId('workspace'),
    channel: newId('channel'),
    member: newId('member'),
    dispatch: newId('dispatch'),
    broadcast: newId('broadcast'),
    delivery: newId('delivery'),
  };
  const email = `reader-${crypto.randomUUID().slice(0, 8)}@${mailboxDomain}`;
  const messageId = `${ids.delivery}@mail.swarm.test`;
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)',
    ).bind(ids.workspace, 'W', now),
    env.DB.prepare(
      `INSERT INTO channels (id, workspace_id, slug, name, created_at, updated_at) VALUES (?1, ?2, ?3, 'Field Notes', ?4, ?4)`,
    ).bind(ids.channel, ids.workspace, `ch-${crypto.randomUUID().slice(0, 8)}`, now),
    env.DB.prepare(
      `INSERT INTO members (id, channel_id, email, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)`,
    ).bind(ids.member, ids.channel, email, now),
    env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at) VALUES (?1, ?2, 'S', '{"type":"doc","content":[]}', 'sent', ?3, ?3)`,
    ).bind(ids.dispatch, ids.channel, now),
    env.DB.prepare(
      `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text, from_name, from_address, track_opens, created_at, last_progress_at)
       VALUES (?1, ?2, ?3, ?4, 'sent', 'S', '', '', '', 'F', 'f@mail.swarm.test', 1, ?5, ?5)`,
    ).bind(ids.broadcast, ids.dispatch, ids.channel, ids.workspace, now),
    env.DB.prepare(
      `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, provider_message_id, status, sent_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'sent', ?7)`,
    ).bind(ids.delivery, ids.broadcast, ids.channel, ids.member, email, messageId, now),
  ]);
  return { ...ids, email, messageId };
}

/** Another email to the same Member, in a Broadcast of its own. */
async function anotherDelivery(s: Awaited<ReturnType<typeof seedDelivery>>) {
  const now = Date.now();
  const broadcast = newId('broadcast');
  const delivery = newId('delivery');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text, from_name, from_address, track_opens, created_at, last_progress_at)
       VALUES (?1, ?2, ?3, ?4, 'sent', 'S', '', '', '', 'F', 'f@mail.swarm.test', 1, ?5, ?5)`,
    ).bind(broadcast, s.dispatch, s.channel, s.workspace, now),
    env.DB.prepare(
      `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, provider_message_id, status, sent_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'sent', ?7)`,
    ).bind(delivery, broadcast, s.channel, s.member, s.email, `${delivery}@mail.swarm.test`, now),
  ]);
  return delivery;
}

const memberStatus = async (id: string) =>
  (
    await env.DB.prepare('SELECT status FROM members WHERE id = ?1')
      .bind(id)
      .first<{ status: string }>()
  )?.status;

function message(
  to: string,
  raw: string,
  from = 'MAILER-DAEMON@mx.example',
  /** Authentication-Results headers, first first. By default there are none. */
  auth: string[] = [],
) {
  const rejected: string[] = [];
  const headers = new Headers();
  for (const value of auth) headers.append('Authentication-Results', value);
  return {
    rejected,
    mail: {
      to,
      from,
      rawSize: raw.length,
      raw: new Blob([raw]).stream(),
      headers,
      setReject: (reason: string) => rejected.push(reason),
    } as unknown as ForwardableEmailMessage,
  };
}

const report = (status: string) =>
  `From: MAILER-DAEMON@mx.example\r\nContent-Type: multipart/report\r\n\r\nFinal-Recipient: rfc822; someone-else@example.org\r\nAction: failed\r\nStatus: ${status}\r\n`;

/** The return path the send worker gives an email: its code under BOUNCE_KEYS. */
const bounceAddress = async (delivery: string, keys = env.BOUNCE_KEYS) =>
  `bounce+${await bounceCode(parseKeyring(keys), delivery)}@unsubscribe.swarm.test`;

/**
 * The header Email Routing prepends for a bounce signed by `dkim`, sent with an empty MAIL FROM
 * from a server whose HELO name passed SPF.
 */
const cloudflareAuth = (dkim: string, helo = `mx1.${dkim}`) =>
  `mx.cloudflare.net; dkim=pass header.d=${dkim} header.s=20230601 header.b=abc; ` +
  `dmarc=pass header.from=${dkim} policy.dmarc=reject; spf=pass (mx.cloudflare.net: domain of ` +
  `postmaster@${helo} designates 1.2.3.4 as permitted sender) smtp.helo=${helo}`;

/** A bounce the reader's own mail server (at example.org) signed. */
const aligned = [cloudflareAuth('example.org')];

/** A hard bounce for `delivery`, from `from` with `auth`. */
const hardBounce = async (delivery: string, auth: string[] = [], from?: string) =>
  handleEmail(message(await bounceAddress(delivery), report('5.1.1'), from, auth).mail, env);

describe('bounces sent back by a mail server', () => {
  it('suppresses the delivery the signed code names, whatever the report claims', async () => {
    const s = await seedDelivery();
    const { mail, rejected } = message(
      await bounceAddress(s.delivery),
      report('5.1.1'),
      undefined,
      aligned,
    );
    await handleEmail(mail, env);
    expect(rejected).toEqual([]);
    expect(await memberStatus(s.member)).toBe('bounced');
    const other = await env.DB.prepare('SELECT 1 FROM suppressions WHERE email = ?1')
      .bind('someone-else@example.org')
      .first();
    expect(other).toBeNull();
  });

  it('takes a code signed with the unsubscribe key for 14 days after the cutover, then none', async () => {
    // Before the cutover the send worker signed bounce codes with UNSUBSCRIBE_KEYS.
    const s = await seedDelivery();
    const { mail } = message(
      await bounceAddress(s.delivery, env.UNSUBSCRIBE_KEYS),
      report('5.1.1'),
      undefined,
      aligned,
    );
    await handleEmail(mail, env);
    expect(await memberStatus(s.member)).toBe('bounced');
    // The cutover more than 14 days ago: track and the api hold that key, so it reports nothing.
    const later = await seedDelivery();
    const late = message(
      await bounceAddress(later.delivery, env.UNSUBSCRIBE_KEYS),
      report('5.1.1'),
      undefined,
      aligned,
    );
    const past = { ...env, LINK_LEGACY_CUTOFF: String(Date.now() - 15 * 86_400_000) };
    await handleEmail(late.mail, past);
    expect(late.rejected).toEqual([]);
    expect(await memberStatus(later.member)).not.toBe('bounced');
    // A code under BOUNCE_KEYS still counts then.
    const current = await seedDelivery();
    await handleEmail(
      message(await bounceAddress(current.delivery), report('5.1.1'), undefined, aligned).mail,
      past,
    );
    expect(await memberStatus(current.member)).toBe('bounced');
  });

  it('counts a permanent failure as soft unless the reader’s mail server signed it', async () => {
    // The bounce code is in the delivered copy's Return-Path, so whoever has the raw message can
    // mail a 5.1.1 report for it; on its own that must not suppress the reader workspace-wide.
    const notCloudflare = cloudflareAuth('example.org').replace(
      'mx.cloudflare.net',
      'mx.evil.test',
    );
    for (const auth of [[], [notCloudflare], [cloudflareAuth('evil.test')]]) {
      const s = await seedDelivery();
      await hardBounce(s.delivery, auth);
      expect(await memberStatus(s.member)).toBe('active');
      const soft = await env.DB.prepare(
        "SELECT count(*) AS n FROM bounce_events WHERE kind = 'soft' AND workspace_id = ?1 AND email = ?2",
      )
        .bind(s.workspace, s.email)
        .first<{ n: number }>();
      expect(soft?.n).toBe(1);
    }
  });

  it('keeps a permanent failure hard when it authenticates as the reader’s mail server', async () => {
    const dkim = await seedDelivery();
    await hardBounce(dkim.delivery, [cloudflareAuth('example.org', 'relay.other.test')]);
    expect(await memberStatus(dkim.member)).toBe('bounced');
    // SPF on the HELO name alone, as a server that doesn't sign its bounces gives.
    const helo = await seedDelivery();
    await hardBounce(helo.delivery, [
      'mx.cloudflare.net; dkim=none; spf=pass smtp.helo=mx2.example.org',
    ]);
    expect(await memberStatus(helo.member)).toBe('bounced');
  });

  it('accepts a big mailbox provider’s bounce servers for its addresses', async () => {
    const gmail = await seedDelivery('gmail.com');
    await hardBounce(gmail.delivery, [cloudflareAuth('google.com', 'mail-sor-f69.google.com')]);
    expect(await memberStatus(gmail.member)).toBe('bounced');
    const hotmail = await seedDelivery('hotmail.com');
    await hardBounce(hotmail.delivery, [
      'mx.cloudflare.net; dkim=none; spf=pass smtp.helo=EUR05-AM6-obe.outbound.protection.outlook.com',
    ]);
    expect(await memberStatus(hotmail.member)).toBe('bounced');
  });

  it('does not take a report mailed from an ordinary mailbox at the provider as hard', async () => {
    // Anyone with a Gmail account passes DKIM for gmail.com; a real bounce has an empty sender.
    const s = await seedDelivery('gmail.com');
    await hardBounce(s.delivery, [cloudflareAuth('gmail.com')], 'someone@gmail.com');
    expect(await memberStatus(s.member)).toBe('active');
  });

  it('keeps a permanent failure hard when the SMTP relay signed it', async () => {
    const s = await seedDelivery();
    const relayed = message(await bounceAddress(s.delivery), report('5.1.1'), '', [
      cloudflareAuth('relay.example.net'),
    ]);
    await handleEmail(relayed.mail, { ...env, SMTP_HOST: 'smtp.relay.example.net' });
    expect(await memberStatus(s.member)).toBe('bounced');
  });

  it('keeps a bounce hard when a common relay wrote it as its own domain', async () => {
    // The relay writes most 5.1.1 bounces, and the common ones sign as another domain.
    for (const [host, auth] of [
      ['smtp.gmail.com', cloudflareAuth('googlemail.com', 'mail-sor-f41.google.com')],
      ['smtp-relay.gmail.com', cloudflareAuth('google.com')],
    ] as const) {
      const s = await seedDelivery();
      const bounce = message(await bounceAddress(s.delivery), report('5.1.1'), '', [auth]);
      await handleEmail(bounce.mail, { ...env, SMTP_HOST: host });
      expect(await memberStatus(s.member), host).toBe('bounced');
    }
  });

  it('keeps a bounce soft when every customer of the relay passes for its domain', async () => {
    // Fastmail signs all customer mail as messagingengine.com, and every Microsoft 365 tenant
    // sends through protection.outlook.com, so any customer could write this DSN itself.
    const office365 =
      'mx.cloudflare.net; dkim=none; dmarc=none; spf=pass smtp.helo=EUR05-AM6-obe.outbound.protection.outlook.com';
    for (const [host, auth, from] of [
      ['smtp.fastmail.com', cloudflareAuth('messagingengine.com'), 'postmaster@evil.test'],
      ['smtp.office365.com', office365, ''],
      ['smtp-mail.outlook.com', office365, ''],
    ] as const) {
      const s = await seedDelivery();
      const bounce = message(await bounceAddress(s.delivery), report('5.1.1'), from, [auth]);
      await handleEmail(bounce.mail, { ...env, SMTP_HOST: host });
      expect(await memberStatus(s.member), host).toBe('active');
      // Hard when the operator accepts the domain in SMTP_BOUNCE_DOMAINS.
      const named = await seedDelivery();
      const again = message(await bounceAddress(named.delivery), report('5.1.1'), from, [auth]);
      await handleEmail(again.mail, {
        ...env,
        SMTP_HOST: host,
        SMTP_BOUNCE_DOMAINS: 'messagingengine.com, protection.outlook.com',
      });
      expect(await memberStatus(named.member), host).toBe('bounced');
    }
  });

  it('keeps a bounce hard when it authenticates as a domain in SMTP_BOUNCE_DOMAINS', async () => {
    const relay = {
      ...env,
      SMTP_HOST: 'mail.example.net',
      SMTP_BOUNCE_DOMAINS: 'a.test, relay.test',
    };
    const s = await seedDelivery();
    await handleEmail(
      message(await bounceAddress(s.delivery), report('5.1.1'), '', [
        'mx.cloudflare.net; dkim=none; dmarc=none; spf=pass smtp.helo=out1.relay.test',
      ]).mail,
      relay,
    );
    expect(await memberStatus(s.member)).toBe('bounced');
    // Anything else still counts as soft.
    const other = await seedDelivery();
    await handleEmail(
      message(await bounceAddress(other.delivery), report('5.1.1'), '', [
        cloudflareAuth('evil.test'),
      ]).mail,
      relay,
    );
    expect(await memberStatus(other.member)).toBe('active');
  });

  it('applies an authenticated hard bounce after an unauthenticated one for the same email', async () => {
    // The unauthenticated one counted as soft, under the soft replay key; the real one still
    // gets the hard key, so it suppresses at once.
    const s = await seedDelivery();
    await hardBounce(s.delivery);
    await hardBounce(s.delivery);
    expect(await memberStatus(s.member)).toBe('active');
    await hardBounce(s.delivery, aligned);
    expect(await memberStatus(s.member)).toBe('bounced');
  });

  it('still suppresses after three unauthenticated permanent failures within a week', async () => {
    const s = await seedDelivery();
    const deliveries = [s.delivery, await anotherDelivery(s), await anotherDelivery(s)];
    await hardBounce(deliveries[0]!);
    await hardBounce(deliveries[1]!);
    expect(await memberStatus(s.member)).toBe('active');
    await hardBounce(deliveries[2]!);
    expect(await memberStatus(s.member)).toBe('bounced');
  });

  it('counts a temporary failure as soft', async () => {
    const s = await seedDelivery();
    await handleEmail(message(await bounceAddress(s.delivery), report('4.4.7')).mail, env);
    expect(await memberStatus(s.member)).not.toBe('bounced');
  });

  it('counts one soft bounce per email, however often the report is sent again', async () => {
    const s = await seedDelivery();
    const address = await bounceAddress(s.delivery);
    for (let i = 0; i < 3; i++) await handleEmail(message(address, report('4.4.7')).mail, env);
    const row = await env.DB.prepare(
      "SELECT count(*) AS n FROM bounce_events WHERE workspace_id = ?1 AND email = ?2 AND kind = 'soft'",
    )
      .bind(s.workspace, s.email)
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
    expect(await memberStatus(s.member)).not.toBe('bounced');
  });

  it('never unsubscribes on a bounce, and leaves a reader alone on an auto-reply', async () => {
    const s = await seedDelivery();
    const reply = message(await bounceAddress(s.delivery), 'Subject: Out of office\r\n\r\nMonday');
    await handleEmail(reply.mail, env);
    expect(reply.rejected).toEqual([]);
    expect(await memberStatus(s.member)).toBe('active');
  });

  it('ignores a report to the unsubscribe code, which every copy of the email carries', async () => {
    // The /u/<code> link and the List-Unsubscribe mailto travel with forwarded mail, so holding
    // that code must not let anyone bounce the Member workspace-wide.
    const s = await seedDelivery();
    const code = await unsubscribeCode(parseKeyring(env.UNSUBSCRIBE_KEYS), s.delivery);
    const forged = message(
      `bounce+${code}@unsubscribe.swarm.test`,
      report('5.1.1'),
      'anyone@attacker.test',
    );
    await handleEmail(forged.mail, env);
    expect(forged.rejected).toEqual([]);
    expect(await memberStatus(s.member)).toBe('active');
    const suppressed = await env.DB.prepare(
      'SELECT 1 FROM suppressions WHERE workspace_id = ?1 AND email = ?2',
    )
      .bind(s.workspace, s.email)
      .first();
    expect(suppressed).toBeNull();
  });

  it('ignores a bounce that arrives long after the email went out', async () => {
    // The return path is in the delivered copy's headers, so anyone who later gets the raw
    // message can mail it. Real bounces come back within days.
    const s = await seedDelivery();
    await env.DB.prepare('UPDATE deliveries SET sent_at = ?1 WHERE id = ?2')
      .bind(Date.now() - 8 * 24 * 3600_000, s.delivery)
      .run();
    await handleEmail(message(await bounceAddress(s.delivery), report('5.1.1')).mail, env);
    expect(await memberStatus(s.member)).toBe('active');
  });

  it('counts one email once, however often its bounce address is mailed', async () => {
    // Whoever has the headers of the email can mail its return path any number of times.
    const s = await seedDelivery();
    for (let i = 0; i < 3; i++) {
      await handleEmail(message(await bounceAddress(s.delivery), report('4.4.7')).mail, env);
    }
    const softBounces = await env.DB.prepare(
      "SELECT count(*) AS n FROM bounce_events WHERE kind = 'soft' AND workspace_id = ?1 AND email = ?2",
    )
      .bind(s.workspace, s.email)
      .first<{ n: number }>();
    expect(softBounces?.n).toBe(1);
    expect(await memberStatus(s.member)).toBe('active');
    // A final failure after a delay notice still counts.
    await hardBounce(s.delivery, aligned);
    expect(await memberStatus(s.member)).toBe('bounced');
  });

  it('drops a forged code without rejecting it, which would bounce the bounce', async () => {
    const s = await seedDelivery();
    const forged = message(`bounce+${'a'.repeat(32)}-${'b'.repeat(20)}@u.test`, report('5.1.1'));
    await handleEmail(forged.mail, env);
    expect(forged.rejected).toEqual([]);
    expect(await memberStatus(s.member)).toBe('active');
  });
});

async function signed(body: string, secret = env.SMTP_FEEDBACK_SECRET) {
  const id = `msg_${crypto.randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    'content-type': 'application/json',
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${await svixSignature(secret, id, timestamp, body)}`,
  };
}

const post = async (payload: unknown, headers?: Record<string, string>) => {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return SELF.fetch('https://events.swarm.test/smtp-feedback', {
    method: 'POST',
    headers: headers ?? (await signed(body)),
    body,
  });
};

describe('reports from a mail server', () => {
  it('marks a complaint, found by the Message-ID Swarm put on the email', async () => {
    const s = await seedDelivery();
    const res = await post({ type: 'complaint', messageId: `<${s.messageId}>` });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { handled: true } });
    expect(await memberStatus(s.member)).toBe('complained');
  });

  it('suppresses a hard bounce, and keeps a soft one soft', async () => {
    const s = await seedDelivery();
    await post({ type: 'soft_bounce', messageId: s.messageId });
    expect(await memberStatus(s.member)).toBe('active');
    await post({ type: 'hard_bounce', messageId: s.messageId, detail: '550 gone' });
    expect(await memberStatus(s.member)).toBe('bounced');
  });

  it('applies a signed report once: the same svix-id again is a replay', async () => {
    const s = await seedDelivery();
    const payload = { type: 'soft_bounce', messageId: s.messageId };
    const headers = await signed(JSON.stringify(payload));
    expect(await (await post(payload, headers)).json()).toMatchObject({ data: { handled: true } });
    const again = await post(payload, headers);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ data: { handled: false, kind: 'replay' } });
  });

  it('rejects an unsigned or wrongly signed report, and changes nothing', async () => {
    const s = await seedDelivery();
    const payload = { type: 'complaint', messageId: s.messageId };
    const body = JSON.stringify(payload);
    expect((await post(payload, { 'content-type': 'application/json' })).status).toBe(401);
    const wrong = await signed(body, `whsec_${btoa('not the configured secret at all')}`);
    expect((await post(payload, wrong)).status).toBe(401);
    expect(await memberStatus(s.member)).toBe('active');
  });

  it('refuses a body that is not a report', async () => {
    expect((await post('not json')).status).toBe(400);
    expect((await post({ type: 'nonsense', messageId: 'x@y' })).status).toBe(400);
  });

  it('is not found when no secret is configured', async () => {
    const res = await app.fetch(
      new Request('https://events.swarm.test/smtp-feedback', { method: 'POST', body: '{}' }),
      { ...env, SMTP_FEEDBACK_SECRET: undefined },
    );
    expect(res.status).toBe(404);
  });
});
