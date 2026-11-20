import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import { embedSnippet } from '@swarm/engine';
import { parseKeyring } from '@swarm/tokens';
import { createDownVault, useVaultForTests } from '@swarm/vault';
import { describe, expect, it } from 'vitest';
import { decrypt } from '@swarm/vault/testing';
import { testLinks } from './links';
import {
  addMember,
  daily,
  enableFlag,
  HOST,
  mailTo,
  member,
  nextIp,
  ORIGIN,
  seedChannel,
  seedForm,
  submitForm,
  submitJson,
  uniqueEmail,
} from './helpers';
import { turnstile } from './turnstile';
import { installFakeVault } from './vault-fetch';

describe('subscribe (form frame)', () => {
  it('creates a pending subscriber with attribution and sends a confirmation from the publication', async () => {
    const channel = await seedChannel();
    await enableFlag(channel.channelId, 'subscribe_attribution_fields');
    const { id } = await seedForm(channel);
    const email = uniqueEmail();
    const res = await submitJson(id, {
      email: email.toUpperCase(),
      firstName: 'Ada',
      attribution: {
        first: {
          utm_source: 'newsletter',
          first_url: `${HOST}/landing`,
          referrer: 'https://search.example/',
        },
        current: { utm_source: 'footer', current_url: `${HOST}/essays/one` },
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { ok: true, message: 'Check your inbox to confirm.', redirect: null, journey: null },
    });

    const row = await member(channel.channelId, email);
    expect(row).toMatchObject({ status: 'pending', form_id: id, first_name: 'Ada' });
    expect(JSON.parse(row!.source_json)).toEqual({
      utm_source: 'newsletter',
      referrer: 'https://search.example/',
      first_url: `${HOST}/landing`,
      current: { utm_source: 'footer' },
      current_url: `${HOST}/essays/one`,
      form_id: id,
    });
    expect(await daily(id)).toMatchObject({ submissions: 1, confirmed: 0 });

    const [mail] = await mailTo(email);
    expect(mail).toMatchObject({
      category: 'confirm',
      subject: 'Confirm your email for Field Notes',
    });
    expect(mail!.from.address).toBe(`${channel.slug}@mail.swarm.localhost`);
    expect(mail!.headers!['List-Unsubscribe']).toMatch(
      /^<https:\/\/forms\.swarm\.test\/v1\/leave\/v2\.leave\./,
    );
    expect(mail!.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(mail!.text).toContain(`${ORIGIN}/v1/confirm/v2.confirm.`);
  });

  it('answers identically whether or not the address is on the list', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel);
    const cases = {
      fresh: uniqueEmail('fresh'),
      pending: uniqueEmail('pending'),
      active: uniqueEmail('active'),
      paused: uniqueEmail('paused'),
      unsubscribed: uniqueEmail('unsubscribed'),
      bounced: uniqueEmail('bounced'),
      complained: uniqueEmail('complained'),
    };
    for (const [status, email] of Object.entries(cases)) {
      if (status !== 'fresh') await addMember(channel.channelId, email, status);
    }
    const answers = new Set<string>();
    for (const email of Object.values(cases)) {
      const res = await submitJson(id, { email });
      answers.add(`${res.status} ${await res.text()} ${[...res.headers.keys()].sort().join(',')}`);
    }
    expect(answers.size).toBe(1);

    // What happened differs, out of sight: new and pending get a confirmation, unsubscribed a
    // "welcome back", and everyone else nothing.
    expect((await mailTo(cases.fresh)).map((m) => m.category)).toEqual(['confirm']);
    expect((await mailTo(cases.pending)).map((m) => m.category)).toEqual(['confirm']);
    const back = await mailTo(cases.unsubscribed);
    expect(back.map((m) => m.subject)).toEqual(['Welcome back to Field Notes: confirm to rejoin']);
    for (const email of [cases.active, cases.paused, cases.bounced, cases.complained]) {
      expect(await mailTo(email)).toEqual([]);
    }
    expect((await member(channel.channelId, cases.unsubscribed))!.status).toBe('unsubscribed');
    expect((await member(channel.channelId, cases.bounced))!.status).toBe('bounced');
  });

  it('rate limits resending a confirmation to a pending subscriber', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel);
    const email = uniqueEmail();
    await submitJson(id, { email });
    await submitJson(id, { email });
    await submitJson(id, { email });
    expect(await mailTo(email)).toHaveLength(1);
    const rows = await env.DB.prepare(
      'SELECT count(*) AS n, max(sent_count) AS sent FROM confirm_requests q JOIN members m ON m.id = q.member_id WHERE m.email = ?1',
    )
      .bind(email)
      .first<{ n: number; sent: number }>();
    expect(rows).toEqual({ n: 1, sent: 1 });
  });

  it('skips confirmation when the form or publication turns double opt-in off', async () => {
    const channel = await seedChannel({ doubleOptIn: false });
    const { id } = await seedForm(channel);
    const email = uniqueEmail();
    expect((await submitJson(id, { email })).status).toBe(200);
    expect((await member(channel.channelId, email))!.status).toBe('active');
    expect(await mailTo(email)).toEqual([]);
    expect(await daily(id)).toMatchObject({ submissions: 1, confirmed: 1 });

    // The form overrides the Channel default.
    const strict = await seedForm(channel, { doubleOptIn: true });
    const other = uniqueEmail();
    await submitJson(strict.id, { email: other });
    expect((await member(channel.channelId, other))!.status).toBe('pending');
  });

  it('pretends to accept a filled honeypot and does nothing', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel);
    const email = uniqueEmail('bot');
    const res = await submitJson(id, { email, website: 'https://spam.example' });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({ data: { ok: true } });
    expect(await member(channel.channelId, email)).toBeNull();
    expect(turnstile.calls).toBe(0);
  });

  it('gives a filled honeypot the redirect without a Member reference', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel, {
      success: { type: 'redirect', url: 'https://news.example.com/thanks?from=form' },
    });
    const res = await submitJson(id, { email: 'anything at all', website: 'https://spam.example' });
    expect(res.status).toBe(200);
    const { data } = await res.json<{ data: { redirect: string } }>();
    expect(data.redirect).toBe('https://news.example.com/thanks?from=form');
    expect(data.redirect).not.toContain('swarm_member');
  });

  it('gives a filled honeypot on the site form the message, not a join link', async () => {
    const channel = await seedChannel({ signupPath: 'email_name' });
    await enableFlag(channel.channelId, 'signup_paths');
    const { id } = await seedForm(channel);
    const res = await submitForm(id, {
      email: 'not even an address',
      join: '1',
      website: 'https://spam.example',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    const html = await res.text();
    expect(html).toContain('Check your inbox to confirm.');
    expect(html).not.toContain('/_swarm/join/');
    expect(turnstile.calls).toBe(0);
  });

  it('refuses disposable addresses and invalid ones', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel);
    const res = await submitJson(id, { email: 'someone@mailinator.com' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: {
        code: 'invalid_input',
        message: 'Use a permanent email address, not a disposable one.',
      },
    });
    expect((await submitJson(id, { email: 'not-an-email' })).status).toBe(400);
    expect(
      await env.DB.prepare('SELECT count(*) AS n FROM members WHERE channel_id = ?1')
        .bind(channel.channelId)
        .first('n'),
    ).toBe(0);
  });

  it('enforces the origin allowlist on the parent page and the request origin', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel, { allowedOrigins: [HOST] });
    const foreign = await submitJson(id, {
      email: uniqueEmail(),
      parentOrigin: 'https://elsewhere.example',
    });
    expect(foreign.status).toBe(403);
    const missing = await submitJson(id, { email: uniqueEmail(), parentOrigin: null });
    expect(missing.status).toBe(403);
    // JSON only ever comes from the frame, which is same-origin with the endpoint.
    const crossSite = await submitJson(id, { email: uniqueEmail() }, { origin: HOST });
    expect(crossSite.status).toBe(403);
    expect(crossSite.headers.get('access-control-allow-origin')).toBeNull();
    expect((await submitJson(id, { email: uniqueEmail() })).status).toBe(200);
  });

  it('fails closed when Turnstile says no', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel);
    turnstile.pass = false;
    const email = uniqueEmail();
    const res = await submitJson(id, { email });
    expect(res.status).toBe(403);
    expect(await member(channel.channelId, email)).toBeNull();
    turnstile.pass = true;
    expect((await submitJson(id, { email, turnstileToken: null })).status).toBe(403);
  });

  it('rate limits per IP', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel);
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await submitJson(id, { email: uniqueEmail() }, { ip })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('redirects with a signed subscriber reference and never the address', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel, {
      success: { type: 'redirect', url: 'https://news.example.com/thanks?from=form' },
    });
    const email = uniqueEmail('Private.Person');
    const res = await submitJson(id, { email });
    const { data } = await res.json<{ data: { redirect: string } }>();
    const url = new URL(data.redirect);
    expect(`${url.origin}${url.pathname}`).toBe('https://news.example.com/thanks');
    expect(url.searchParams.get('from')).toBe('form');
    for (const variant of [
      email,
      email.toLowerCase(),
      encodeURIComponent(email),
      'private.person',
    ]) {
      expect(data.redirect.toLowerCase()).not.toContain(variant.toLowerCase());
    }
    const token = url.searchParams.get('swarm_member')!;
    const read = await testLinks().verify<{ c: string; r: string }>('member-ref', token);
    expect(read.ok && read.payload.c).toBe(channel.channelId);
    expect(atob(token.split('.')[3]!.replace(/-/g, '+').replace(/_/g, '/'))).not.toContain('@');

    // The same answer shape for an address already on the list.
    await addMember(channel.channelId, uniqueEmail('known'), 'active');
    const again = await (await submitJson(id, { email })).json<{ data: { redirect: string } }>();
    const ref = (u: string) => new URL(u).searchParams.get('swarm_member')!.split('.')[3];
    expect(JSON.parse(atob(ref(again.data.redirect)!)).r).toBe(
      JSON.parse(atob(ref(data.redirect)!)).r,
    );
  });

  it('requires consent and validates profile fields, sealing encrypted ones', async () => {
    const channel = await seedChannel();
    const now = Date.now();
    const plan = newId('memberField');
    const secret = newId('memberField');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO member_fields (id, channel_id, key, label, type, options_json, created_at, updated_at)
         VALUES (?1, ?2, 'plan', 'Plan', 'select', '["Weekly","Monthly"]', ?3, ?3)`,
      ).bind(plan, channel.channelId, now),
      env.DB.prepare(
        `INSERT INTO member_fields (id, channel_id, key, label, type, encrypted, created_at, updated_at)
         VALUES (?1, ?2, 'company', 'Company', 'text', 1, ?3, ?3)`,
      ).bind(secret, channel.channelId, now),
    ]);
    const { id } = await seedForm(channel, {
      fields: [
        { key: 'email', label: 'Email', required: true },
        { key: 'field:plan', label: 'Plan', required: true, display: 'radio' },
        { key: 'field:company', label: 'Company', required: false },
      ],
      consent: { text: 'I agree to receive emails.', required: true },
    });
    const email = uniqueEmail();
    expect((await submitJson(id, { email, fields: { plan: 'Weekly' } })).status).toBe(400);
    const bad = await submitJson(id, { email, consent: true, fields: { plan: 'Daily' } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { details: [{ path: 'fields.plan' }] } });
    const ok = await submitJson(id, {
      email,
      consent: true,
      fields: { plan: 'monthly', company: 'Acme' },
    });
    expect(ok.status).toBe(200);
    const row = await member(channel.channelId, email);
    const values = await env.DB.prepare(
      'SELECT field_id, value_text, value_enc FROM member_field_values WHERE member_id = ?1',
    )
      .bind(row!.id)
      .all<{ field_id: string; value_text: string | null; value_enc: string | null }>();
    const byField = Object.fromEntries(values.results.map((v) => [v.field_id, v]));
    expect(byField[plan]).toMatchObject({ value_text: 'Monthly', value_enc: null });
    expect(byField[secret]!.value_text).toBeNull();
    expect(await decrypt(parseKeyring(env.TEST_FIELD_KEYS), byField[secret]!.value_enc!)).toBe(
      '"Acme"',
    );
  });

  it('leaves out an optional field named like an Object.prototype member', async () => {
    // "constructor" is a valid field key; leaving it blank must not hand it a built-in.
    const channel = await seedChannel();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO member_fields (id, channel_id, key, label, type, created_at, updated_at)
       VALUES (?1, ?2, 'constructor', 'Builder', 'text', ?3, ?3)`,
    )
      .bind(newId('memberField'), channel.channelId, now)
      .run();
    const { id } = await seedForm(channel, {
      fields: [
        { key: 'email', label: 'Email', required: true },
        { key: 'field:constructor', label: 'Builder', required: false },
      ],
    });
    expect((await submitJson(id, { email: uniqueEmail() })).status).toBe(200);
    expect((await submitJson(id, { email: uniqueEmail(), fields: {} })).status).toBe(200);
    const plain = await submitForm(id, { email: uniqueEmail(), 'cf-turnstile-response': 'ok' });
    expect(plain.status).toBeLessThan(400);
  });

  it('keeps only the form and the referral without the attribution flag', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel);
    const referrer = await addMember(channel.channelId, uniqueEmail('champion'), 'active');
    const email = uniqueEmail();
    const res = await submitJson(id, {
      email,
      ref: referrer,
      attribution: {
        first: { utm_source: 'newsletter', first_url: `${HOST}/landing` },
        current: { current_url: `${HOST}/essays/one` },
      },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse((await member(channel.channelId, email))!.source_json)).toEqual({
      form_id: id,
      ref: referrer,
    });

    // The no-JS post's referer is attribution too.
    const plain = uniqueEmail();
    expect((await submitForm(id, { email: plain, 'cf-turnstile-response': 'ok' })).status).toBe(
      200,
    );
    expect(JSON.parse((await member(channel.channelId, plain))!.source_json)).toEqual({
      form_id: id,
    });
  });

  it('records a valid referral and ignores self and repeat referrals', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel);
    const referrerEmail = uniqueEmail('champion');
    const referrer = await addMember(channel.channelId, referrerEmail, 'active');

    const friend = uniqueEmail('friend');
    await submitJson(id, { email: friend, ref: referrer });
    const row = await member(channel.channelId, friend);
    expect(row!.referred_by).toBe(referrer);
    expect(JSON.parse(row!.source_json).ref).toBe(referrer);

    // The referrer signing up "again" through their own link changes nothing.
    await submitJson(id, { email: referrerEmail, ref: referrer });
    // Plus-addressing yourself is still yourself.
    const [local, domain] = referrerEmail.split('@');
    const alias = `${local}+again@${domain}`;
    await submitJson(id, { email: alias, ref: referrer });
    expect((await member(channel.channelId, alias))!.referred_by).toBeNull();
    // A Member of another Channel can't refer here.
    const elsewhere = await seedChannel();
    const outsider = await addMember(elsewhere.channelId, uniqueEmail(), 'active');
    const third = uniqueEmail('third');
    await submitJson(id, { email: third, ref: outsider });
    expect((await member(channel.channelId, third))!.referred_by).toBeNull();

    const count = await env.DB.prepare('SELECT count(*) AS n FROM referrals WHERE referrer_id = ?1')
      .bind(referrer)
      .first('n');
    expect(count).toBe(1);
  });
});

describe('subscribe (no-JS form post)', () => {
  it('answers with a Turnstile challenge that carries the values, then joins', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel, { allowedOrigins: [HOST] });
    const email = uniqueEmail();
    const first = await submitForm(id, { email, firstName: 'Grace <3', website: '' });
    expect(first.status).toBe(200);
    const html = await first.text();
    expect(html).toContain('class="cf-turnstile"');
    expect(html).toContain(`<input type="hidden" name="email" value="${email}">`);
    expect(html).toContain('value="Grace &lt;3"');
    expect(html).toContain('<noscript>');
    expect(first.headers.get('content-security-policy')).toContain(
      'script-src https://challenges.cloudflare.com',
    );
    expect(await member(channel.channelId, email)).toBeNull();

    const challenge = /name="_challenge" value="([^"]+)"/.exec(html)![1]!;
    const done = await submitForm(
      id,
      {
        email,
        firstName: 'Grace <3',
        website: '',
        _challenge: challenge,
        'cf-turnstile-response': 'ok',
      },
      { origin: ORIGIN, referer: `${ORIGIN}/v1/${id}/subscribe` },
    );
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('Check your inbox to confirm.');
    expect((await member(channel.channelId, email))!.status).toBe('pending');
  });

  it('records the host page and refuses a foreign one', async () => {
    const channel = await seedChannel();
    await enableFlag(channel.channelId, 'subscribe_attribution_fields');
    const { id } = await seedForm(channel, { allowedOrigins: [HOST] });
    const email = uniqueEmail();
    const done = await submitForm(id, { email, 'cf-turnstile-response': 'ok' });
    expect(done.status).toBe(200);
    expect(JSON.parse((await member(channel.channelId, email))!.source_json)).toMatchObject({
      current_url: `${HOST}/essays/one?utm_source=footer`,
    });

    const foreign = await submitForm(
      id,
      { email: uniqueEmail(), 'cf-turnstile-response': 'ok' },
      { origin: 'https://elsewhere.example', referer: 'https://elsewhere.example/' },
    );
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get('content-type')).toContain('text/html');
  });

  it('redirects with 303 when the form says so', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel, {
      success: { type: 'redirect', url: 'https://news.example.com/thanks' },
    });
    const email = uniqueEmail();
    const res = await submitForm(id, { email, 'cf-turnstile-response': 'ok' });
    expect(res.status).toBe(303);
    const location = res.headers.get('location')!;
    expect(location).toMatch(
      /^https:\/\/news\.example\.com\/thanks\?swarm_member=v2\.member-ref\./,
    );
    expect(location.toLowerCase()).not.toContain(email.split('@')[0]!);
  });

  it('renders every profile field type in the no-JS form and validates them like the frame', async () => {
    const channel = await seedChannel();
    const now = Date.now();
    const defs = [
      ['company', 'Company', 'text', '[]'],
      ['age', 'Age', 'number', '[]'],
      ['born', 'Born', 'date', '[]'],
      ['pro', 'Professional', 'boolean', '[]'],
      ['plan', 'Plan', 'select', '["Weekly","Monthly"]'],
      ['topics', 'Topics', 'multi_select', '["Code, mostly","Design"]'],
    ] as const;
    const ids: Record<string, string> = {};
    await env.DB.batch(
      defs.map(([key, label, type, options]) => {
        ids[key] = newId('memberField');
        return env.DB.prepare(
          `INSERT INTO member_fields (id, channel_id, key, label, type, options_json, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
        ).bind(ids[key], channel.channelId, key, label, type, options, now);
      }),
    );
    const { id, config } = await seedForm(channel, {
      fields: [
        { key: 'email', label: 'Email', required: true },
        ...defs.map(([key, label]) => ({ key: `field:${key}`, label, required: true })),
        { key: 'field:gone', label: 'Deleted since', required: false },
      ],
    });
    const snippet = await embedSnippet(
      ORIGIN,
      id,
      1,
      config,
      new Map(
        defs.map(([key, , type, options]) => [
          key,
          { key, type, options: JSON.parse(options) as string[] },
        ]),
      ),
    );
    const form = snippet.noscript;
    expect(form).toContain('<input type="text" name="f.company" maxlength="2000" required>');
    expect(form).toContain('<input type="number" name="f.age" step="any" required>');
    expect(form).toContain('<input type="date" name="f.born" required>');
    expect(form).toContain('<input type="checkbox" name="f.pro" value="yes" required>');
    expect(form).toContain('<select name="f.plan" required><option value="">Choose…</option>');
    expect(form).toContain('<input type="checkbox" name="f.topics" value="Code, mostly">');
    expect(form).not.toContain('Deleted since');

    const email = uniqueEmail();
    const values = {
      email,
      'f.company': 'Acme',
      'f.age': '41',
      'f.born': '1985-02-03',
      'f.pro': 'yes',
      'f.plan': 'Monthly',
      'cf-turnstile-response': 'ok',
    };
    // A required multi-select with nothing ticked is refused, like the frame's JSON post.
    const missing = await submitForm(id, values);
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain('Fill in Topics.');
    const badDate = await submitForm(id, {
      ...values,
      'f.born': '1985-02-30',
      'f.topics': 'Design',
    });
    expect(badDate.status).toBe(400);
    expect(await badDate.text()).toContain('Born: That date does not exist.');

    // One ticked box arrives as a single value, even with a comma in the option.
    const ok = await submitForm(id, { ...values, 'f.topics': 'Code, mostly' });
    expect(ok.status).toBe(200);
    const row = await member(channel.channelId, email);
    const stored = await env.DB.prepare(
      'SELECT field_id, value_text, value_num FROM member_field_values WHERE member_id = ?1',
    )
      .bind(row!.id)
      .all<{ field_id: string; value_text: string | null; value_num: number | null }>();
    const byField = Object.fromEntries(stored.results.map((v) => [v.field_id, v]));
    expect(byField[ids.company!]!.value_text).toBe('Acme');
    expect(byField[ids.age!]!.value_num).toBe(41);
    expect(byField[ids.born!]!.value_text).toBe('1985-02-03');
    expect(byField[ids.plan!]!.value_text).toBe('Monthly');
    expect(JSON.parse(byField[ids.topics!]!.value_text!)).toEqual(['Code, mostly']);

    const both = uniqueEmail();
    expect(
      (await submitForm(id, { ...values, email: both, 'f.topics': ['Design', 'Code, mostly'] }))
        .status,
    ).toBe(200);
  });

  it('refuses a forged challenge', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel);
    const res = await submitForm(id, {
      email: uniqueEmail(),
      _challenge: 'v1.challenge.m1.e30.AAAA',
      'cf-turnstile-response': 'ok',
    });
    expect(res.status).toBe(403);
  });
});

describe('a sign-up with an encrypted field while the vault is down', () => {
  it('answers 503 and stores nothing, rather than keeping the value any other way', async () => {
    const channel = await seedChannel();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO member_fields (id, channel_id, key, label, type, encrypted, created_at, updated_at)
       VALUES (?1, ?2, 'company', 'Company', 'text', 1, ?3, ?3)`,
    )
      .bind(newId('memberField'), channel.channelId, now)
      .run();
    const { id } = await seedForm(channel, {
      fields: [
        { key: 'email', label: 'Email', required: true },
        { key: 'field:company', label: 'Company', required: false },
      ],
    });
    const email = uniqueEmail();
    useVaultForTests('capture', createDownVault<'capture'>());
    try {
      const res = await submitJson(id, { email, fields: { company: 'Acme' } });
      expect(res.status).toBe(503);
    } finally {
      await installFakeVault();
    }
    expect(await member(channel.channelId, email)).toBeNull();
  });
});
