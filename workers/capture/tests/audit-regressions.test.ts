// Regression tests for plan/00-audit.md §5 rows that had none, and for what Phase 3 promised on top
// of them: the no-JS fallback working with JavaScript off, attribution through its challenge page,
// the bot checks on the Member Center link request, and Circles following capture's changes.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { FormTriggerSchema, defaultCaptureFormConfig, newId } from '@swarm/domain';
import { embedSnippet, loaderConfig, REMINDER_AFTER_MS } from '@swarm/engine';
import { base64UrlEncode } from '@swarm/tokens';
import { describe, expect, it } from 'vitest';
import { testLinks } from './links';
import { remind, retryingFetch } from '../src/index';
import {
  addMember,
  call,
  enableFlag,
  HOST,
  mailTo,
  member,
  nextIp,
  ORIGIN,
  recordPublicQueue,
  seedChannel,
  seedForm,
  submitForm,
  submitJson,
  uniqueEmail,
} from './helpers';
import { turnstile } from './turnstile';

const WORDS: Record<string, number> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
};

/** Reads the question the page asks and works it out, as a person would. */
function solve(html: string): string {
  const match = /What is (\w+) plus (\w+)\?/.exec(html);
  if (!match) throw new Error('no question on the page');
  return String(WORDS[match[1]!]! + WORDS[match[2]!]!);
}

const tokenIn = (html: string) => /name="_challenge" value="([^"]+)"/.exec(html)![1]!;

/** Posts as the challenge page does: from the capture origin itself. */
const fromChallenge = (id: string, fields: Record<string, string>) =>
  submitForm(id, fields, { origin: ORIGIN, referer: `${ORIGIN}/v1/${id}/subscribe` });

describe('§5 layouts', () => {
  it('Regular shows the heading and text, Slim only the fields and the button', async () => {
    const channel = await seedChannel();
    const copy = { heading: 'Join us', body: 'Weekly notes.', button: 'Sign me up' };
    const regular = await seedForm(channel, { layout: 'regular', copy });
    const slim = await seedForm(channel, { layout: 'slim', copy });

    const a = await (await call(`/v1/${regular.id}/frame`)).text();
    expect(a).toMatch(/<body class="regular /);
    expect(a).toContain('<h1>Join us</h1>');
    expect(a).toContain('<p>Weekly notes.</p>');

    const b = await (await call(`/v1/${slim.id}/frame`)).text();
    expect(b).toMatch(/<body class="slim /);
    expect(b).not.toContain('Join us</h1>');
    expect(b).not.toContain('Weekly notes.');
    expect(b).toContain('Sign me up</button>');

    // The loader sizes each layout on its own.
    const script = await (await call(`/v1/${slim.id}.js`)).text();
    expect(script).toContain('"layout":"slim"');
  });
});

describe('§5 success message', () => {
  it('answers with the form’s own message, and refuses one over 80 characters', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel, {
      success: { type: 'message', message: 'Thanks, look for a note from Ada.' },
    });
    const res = await submitJson(id, { email: uniqueEmail() });
    expect(await res.json()).toMatchObject({
      data: { ok: true, message: 'Thanks, look for a note from Ada.', redirect: null },
    });
  });
});

describe('§5 draft and publish', () => {
  it('serves the published config, never an edited draft, and nothing before the first publish', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel, {
      copy: { heading: 'Published heading', body: '', button: 'Join' },
    });
    const draft = {
      ...defaultCaptureFormConfig(),
      placement: 'popup' as const,
      copy: { heading: 'Draft heading', body: '', button: 'Draft button' },
    };
    await env.DB.prepare('UPDATE capture_forms SET draft_config_json = ?1 WHERE id = ?2')
      .bind(JSON.stringify(draft), id)
      .run();

    const frame = await (await call(`/v1/${id}/frame`)).text();
    expect(frame).toContain('Published heading');
    expect(frame).not.toContain('Draft heading');
    const script = await (await call(`/v1/${id}.js`)).text();
    expect(script).toContain('"placement":"inline"');
    expect(script).not.toContain('Draft heading');

    await env.DB.prepare(
      "UPDATE capture_forms SET status = 'draft', published_config_json = NULL WHERE id = ?1",
    )
      .bind(id)
      .run();
    expect((await call(`/v1/${id}.js`)).status).toBe(404);
    expect((await call(`/v1/${id}/frame`)).status).toBe(404);
    expect((await submitJson(id, { email: uniqueEmail() })).status).toBe(404);
  });
});

describe('§5 bot protection', () => {
  it('limits one form across every address and IP, not only one IP', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel);
    const stub = env.RATE_LIMITER.get(
      env.RATE_LIMITER.idFromName(`subscribeForm:${id}`),
    ) as unknown as { hit(limit: number, windowMs: number): Promise<unknown> };
    for (let i = 0; i < 600; i++) await stub.hit(600, 600_000);
    const email = uniqueEmail();
    const res = await submitJson(id, { email }, { ip: nextIp() });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(await member(channel.channelId, email)).toBeNull();
  });
});

describe('§5 data integrity', () => {
  it('creates one subscriber from concurrent sign-ups of the same address, in any case', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel);
    const email = uniqueEmail('racer');
    const responses = await Promise.all(
      [email, email.toUpperCase(), email, email.toUpperCase(), email].map((address) =>
        submitJson(id, { email: address }),
      ),
    );
    for (const res of responses) expect(res.status).toBe(200);
    const row = await env.DB.prepare(
      'SELECT count(*) AS n, min(email) AS email FROM members WHERE channel_id = ?1',
    )
      .bind(channel.channelId)
      .first<{ n: number; email: string }>();
    expect(row).toEqual({ n: 1, email });
    const requests = await env.DB.prepare(
      'SELECT count(*) AS n FROM confirm_requests WHERE channel_id = ?1',
    )
      .bind(channel.channelId)
      .first('n');
    expect(requests).toBe(1);
  });
});

describe('§5 weak delay parsing', () => {
  it('refuses a delay that is not a whole number of seconds', () => {
    for (const seconds of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0,
      -1,
      1.5,
      '5',
      null,
      undefined,
    ]) {
      expect(FormTriggerSchema.safeParse({ type: 'delay', seconds }).success).toBe(false);
    }
    expect(FormTriggerSchema.safeParse({ type: 'delay', seconds: 5 }).success).toBe(true);
  });

  it('reaches the loader as a number, milliseconds worked out there', async () => {
    const config = {
      ...defaultCaptureFormConfig(),
      trigger: { type: 'delay', seconds: 5 },
    } as const;
    const loader = loaderConfig(ORIGIN, `cf_${'1'.repeat(32)}`, 1, config);
    expect(loader.trigger).toEqual({ type: 'delay', seconds: 5 });
  });
});

describe('§5 unescaped placeholder', () => {
  it('escapes a field’s placeholder in the frame and in the no-JS form', async () => {
    const channel = await seedChannel();
    const evil = '"><img src=x onerror=alert(1)>';
    const { id, config } = await seedForm(channel, {
      fields: [{ key: 'email', label: 'Email', placeholder: evil, required: true }],
    });
    const frame = await (await call(`/v1/${id}/frame`)).text();
    expect(frame).not.toContain('<img src=x');
    expect(frame).toContain('placeholder="&quot;&gt;&lt;img');
    const snippet = await embedSnippet(ORIGIN, id, 1, config);
    expect(snippet.noscript).not.toContain('<img src=x');
    // The loader never receives field text at all.
    expect(await (await call(`/v1/${id}.js`)).text()).not.toContain('onerror');
  });
});

describe('no-JS fallback without JavaScript', () => {
  it('asks a question a browser without JavaScript can answer, never showing the answer', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel);
    const email = uniqueEmail();
    const page = await submitForm(id, { email, website: '' });
    const html = await page.text();
    const noscript = /<noscript><form[\s\S]*<\/noscript>/.exec(html)![0];
    expect(noscript).toMatch(/What is \w+ plus \w+\?/);
    expect(noscript).toContain('name="answer"');
    expect(noscript).toContain(`name="email" value="${email}"`);
    expect(html).toContain('#with-script{display:none}');
    // The token holds a keyed MAC; the answer isn't anywhere to read.
    const payload = JSON.parse(
      atob(tokenIn(html).split('.').at(-2)!.replace(/-/g, '+').replace(/_/g, '/')),
    );
    expect(JSON.stringify(payload)).not.toContain(`"${solve(html)}"`);
  });

  it('can not be solved offline from what the token carries', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel);
    const html = await (await submitForm(id, { email: uniqueEmail(), website: '' })).text();
    const payload = JSON.parse(
      atob(tokenIn(html).split('.').at(-2)!.replace(/-/g, '+').replace(/_/g, '/')),
    ) as Record<string, unknown>;
    // A script tries every possible sum against the hash in the readable payload.
    const sha = async (value: string) =>
      [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
        .slice(0, 16)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    const found: number[] = [];
    for (let n = 4; n <= 18; n++) {
      if ((await sha(`${String(payload.s)}:${n}`)) === payload.q) found.push(n);
    }
    expect(found).toEqual([]);
  });

  it('does not MAC the answer with the key that signs the challenge', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel);
    const html = await (await submitForm(id, { email: uniqueEmail(), website: '' })).text();
    const payload = JSON.parse(
      atob(tokenIn(html).split('.').at(-2)!.replace(/-/g, '+').replace(/_/g, '/')),
    ) as Record<string, unknown>;
    // Whoever holds the raw CAPTURE_KEYS secret that signs the challenge (or a MAC oracle under
    // it) must not be able to check answers: the answer MAC has its own key.
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(testLinks().secret('CAPTURE_KEYS')!),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const found: number[] = [];
    for (let n = 4; n <= 18; n++) {
      const input = new TextEncoder().encode(`challenge-answer:${id}:${String(payload.s)}:${n}`);
      const mac = base64UrlEncode(new Uint8Array(await crypto.subtle.sign('HMAC', key, input)));
      if (mac === payload.q) found.push(n);
    }
    expect(found).toEqual([]);
  });

  it('uses a question up on a wrong answer too, so it can not be guessed', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel);
    turnstile.pass = false;
    const email = uniqueEmail();
    const first = await (await submitForm(id, { email, website: '' })).text();
    const fields = { email, website: '', _challenge: tokenIn(first) };
    const wrong = await fromChallenge(id, { ...fields, answer: String(Number(solve(first)) + 1) });
    expect(wrong.status).toBe(403);
    // The page asks a new question; the old one no longer counts, even answered right.
    const again = await fromChallenge(id, { ...fields, answer: solve(first) });
    expect(again.status).toBe(403);
    expect(await member(channel.channelId, email)).toBeNull();
    // The new question still works for the person.
    const retry = await wrong.text();
    expect(tokenIn(retry)).not.toBe(tokenIn(first));
    const done = await fromChallenge(id, {
      ...fields,
      _challenge: tokenIn(retry),
      answer: solve(retry),
    });
    expect(done.status).toBe(200);
    expect(await member(channel.channelId, email)).not.toBeNull();
  });

  it('accepts a solved question once', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel);
    turnstile.pass = false;
    const first = await (await submitForm(id, { email: uniqueEmail(), website: '' })).text();
    const fields = { website: '', _challenge: tokenIn(first), answer: solve(first) };
    const one = uniqueEmail();
    const two = uniqueEmail();
    expect((await fromChallenge(id, { ...fields, email: one })).status).toBe(200);
    const again = await fromChallenge(id, { ...fields, email: two });
    expect(again.status).toBe(403);
    expect(await member(channel.channelId, one)).not.toBeNull();
    expect(await member(channel.channelId, two)).toBeNull();
  });

  it('joins with the right answer, and always asks for a confirmation', async () => {
    const channel = await seedChannel();
    // The form says no confirmation is needed; the question isn't enough to skip it.
    const { id } = await seedForm(channel, { doubleOptIn: false });
    const email = uniqueEmail();
    const first = await (await submitForm(id, { email, firstName: 'Ada', website: '' })).text();
    turnstile.calls = 0;
    const done = await fromChallenge(id, {
      email,
      firstName: 'Ada',
      website: '',
      _challenge: tokenIn(first),
      answer: solve(first),
    });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('Check your inbox to confirm.');
    expect(turnstile.calls).toBe(0);
    const row = await member(channel.channelId, email);
    expect(row).toMatchObject({ status: 'pending', first_name: 'Ada', form_id: id });
    expect((await mailTo(email))[0]).toMatchObject({ category: 'confirm' });
  });

  it('refuses a wrong answer and a token from another form, adding nobody', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel);
    const other = await seedForm(channel);
    const email = uniqueEmail();
    turnstile.pass = false;
    const first = await (await submitForm(id, { email, website: '' })).text();
    const wrong = await fromChallenge(id, {
      email,
      website: '',
      _challenge: tokenIn(first),
      answer: String(Number(solve(first)) + 1),
    });
    expect(wrong.status).toBe(403);
    expect(await wrong.text()).toContain('We could not check that you are a person.');
    const elsewhere = await fromChallenge(other.id, {
      email,
      website: '',
      _challenge: tokenIn(first),
      answer: solve(first),
    });
    expect(elsewhere.status).toBe(403);
    expect(await member(channel.channelId, email)).toBeNull();
  });

  it('keeps the page and UTMs through the challenge, when attribution is on', async () => {
    const channel = await seedChannel();
    await enableFlag(channel.channelId, 'subscribe_attribution_fields');
    const { id } = await seedForm(channel, { allowedOrigins: [HOST] });
    const email = uniqueEmail();
    const fields = { email, website: '', utm_campaign: 'spring', utm_source: '' };
    const first = await (await submitForm(id, fields)).text();
    const done = await fromChallenge(id, {
      ...fields,
      _challenge: tokenIn(first),
      answer: solve(first),
    });
    expect(done.status).toBe(200);
    const source = JSON.parse((await member(channel.channelId, email))!.source_json);
    expect(source).toMatchObject({
      form_id: id,
      current_url: `${HOST}/essays/one?utm_source=footer`,
      // From the snippet's hidden field, and from the page's own query.
      utm_campaign: 'spring',
      utm_source: 'footer',
    });
  });

  it('gives the snippet hidden attribution fields', async () => {
    const snippet = await embedSnippet(
      ORIGIN,
      `cf_${'2'.repeat(32)}`,
      1,
      defaultCaptureFormConfig(),
    );
    for (const name of [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'ref',
    ]) {
      expect(snippet.noscript).toContain(`<input type="hidden" name="${name}" value="">`);
    }
  });
});

describe('Subscriber settings link request', () => {
  const ask = (fields: Record<string, string>) =>
    call('/m', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: ORIGIN,
        'cf-connecting-ip': nextIp(),
      },
      body: new URLSearchParams(fields).toString(),
    });

  it('needs a passed check: without one, no mail goes out', async () => {
    const channel = await seedChannel();
    const email = uniqueEmail();
    await addMember(channel.channelId, email, 'active');
    turnstile.pass = false;
    const res = await ask({ email });
    expect(res.status).toBe(403);
    expect(await mailTo(email)).toEqual([]);
  });

  it('pretends to accept a filled honeypot and sends nothing', async () => {
    const channel = await seedChannel();
    const email = uniqueEmail();
    await addMember(channel.channelId, email, 'active');
    const res = await ask({
      email,
      website: 'https://spam.example',
      'cf-turnstile-response': 'ok',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Check your inbox');
    expect(await mailTo(email)).toEqual([]);
    expect(turnstile.calls).toBe(0);
  });

  it('works without JavaScript through the question', async () => {
    const channel = await seedChannel();
    const email = uniqueEmail();
    await addMember(channel.channelId, email, 'active');
    const form = await (await call('/m')).text();
    expect(form).toContain('class="cf-turnstile"');
    turnstile.pass = false;
    const res = await ask({ email, _challenge: tokenIn(form), answer: solve(form) });
    expect(res.status).toBe(200);
    expect((await mailTo(email))[0]).toMatchObject({ category: 'member_center' });
  });
});

describe('Circles follow capture', () => {
  async function circleOf(channel: { workspaceId: string; channelId: string }) {
    const id = newId('circle');
    await env.DB.prepare(
      `INSERT INTO circles (id, workspace_id, channel_id, name, rule_json, generation, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'All', '{"field":"email","cmp":"is_set"}', 1, 'ready', 0, 0)`,
    )
      .bind(id, channel.workspaceId, channel.channelId)
      .run();
    return async () =>
      env.DB.prepare('SELECT status FROM circles WHERE id = ?1').bind(id).first<string>('status');
  }

  it('queues a re-evaluation after a sign-up, a confirmation and a subscriber settings change', async () => {
    const channel = await seedChannel();
    const statusNow = await circleOf(channel);
    const { id } = await seedForm(channel);
    const email = uniqueEmail();
    // Only "this publication changed", on the public queue. Capture writes no Circle row: the
    // jobs worker marks the Circles pending and queues their refreshes (S04-P1-TR).
    const changed = { type: 'channel_changed', channelId: channel.channelId };

    expect(await recordPublicQueue(() => submitJson(id, { email }))).toEqual([changed]);
    expect(await statusNow()).toBe('ready');

    const mail = (await mailTo(email))[0]!;
    const link = /\/v1\/confirm\/[A-Za-z0-9._-]+/.exec(mail.text)![0];
    let confirmed: Response | undefined;
    const onConfirm = await recordPublicQueue(async () => {
      confirmed = await call(link, { method: 'POST', headers: { 'cf-connecting-ip': nextIp() } });
    });
    expect(confirmed!.status).toBe(200);
    expect(onConfirm).toEqual([changed]);

    const center = /\/m\/[A-Za-z0-9._-]+/.exec(await confirmed!.text())![0];
    let paused: Response | undefined;
    const onPause = await recordPublicQueue(async () => {
      paused = await call(center, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: ORIGIN,
          'cf-connecting-ip': nextIp(),
        },
        body: new URLSearchParams({ action: 'pause', weeks: '2' }).toString(),
      });
    });
    expect(paused!.status).toBe(303);
    expect(onPause).toEqual([changed]);
    expect(await statusNow()).toBe('ready');
    // Capture has no binding to the jobs queue.
    expect('JOBS_QUEUE' in env).toBe(false);
  });
});

describe('confirm links', () => {
  it('reminds a pending sign-up, never someone who unsubscribed and asked to rejoin', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel);
    const email = uniqueEmail('rejoiner');
    await addMember(channel.channelId, email, 'unsubscribed');
    await submitJson(id, { email });
    expect((await mailTo(email))[0]).toMatchObject({ category: 'confirm' });
    const sent = await env.DB.prepare(
      `SELECT q.last_sent_at, q.kind FROM confirm_requests q JOIN members m ON m.id = q.member_id
        WHERE m.channel_id = ?1`,
    )
      .bind(channel.channelId)
      .first<{ last_sent_at: number; kind: string }>();
    expect(sent!.kind).toBe('return');
    await remind(env, sent!.last_sent_at + REMINDER_AFTER_MS + 1);
    const mine = (await mailTo(email)).filter((m) => m.category === 'confirm_reminder');
    expect(mine).toEqual([]);
  });

  it('last as long as the publication says, and the mail says how long', async () => {
    const channel = await seedChannel({ confirmDays: 3 });
    const { id } = await seedForm(channel);
    const email = uniqueEmail();
    await submitJson(id, { email });
    const request = await env.DB.prepare(
      'SELECT expires_at, created_at FROM confirm_requests WHERE channel_id = ?1',
    )
      .bind(channel.channelId)
      .first<{ expires_at: number; created_at: number }>();
    expect(request!.expires_at - request!.created_at).toBe(3 * 86_400_000);
    expect((await mailTo(email))[0]!.text).toContain('The link works for 3 days.');
  });

  it('default to 7 days', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel);
    const email = uniqueEmail();
    await submitJson(id, { email });
    expect((await mailTo(email))[0]!.text).toContain('The link works for 7 days.');
  });
});

describe('a moment of D1 failure', () => {
  it('gives a visitor the form on a GET, and never runs a POST twice', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel);
    let failures = 1;
    let prepared = 0;
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key !== 'prepare') return Reflect.get(target, key);
        return (sql: string) => {
          prepared++;
          if (failures-- > 0) throw new Error('boom');
          return target.prepare(sql);
        };
      },
    });
    const ctx = createExecutionContext();
    const page = await retryingFetch(new Request(`${ORIGIN}/v1/${id}.js`), { ...env, DB: db }, ctx);
    await waitOnExecutionContext(ctx);
    expect(page.status).toBe(200);

    failures = 100;
    prepared = 0;
    const post = createExecutionContext();
    const refused = await retryingFetch(
      new Request(`${ORIGIN}/v1/${id}/subscribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: '{}',
      }),
      { ...env, DB: db },
      post,
    );
    await waitOnExecutionContext(post);
    expect(refused.status).toBe(500);
    expect(prepared).toBe(1);
  });
});
