// Email checks at signup (docs/email-verification.md): a red address is refused with DeBounce's
// suggestion, the plain form offers the suggestion with a fresh challenge, the colour's rule can ask
// for confirmation or a tag, and DeBounce being out of credits, wrong or slow never loses a signup.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { EMAIL_CHECK_DEFAULTS, newId } from '@swarm/domain';
import { fakeDebounceFetch, readQueueMessage, useDebounceFetchForTests } from '@swarm/engine';
import { afterEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import {
  HOST,
  ORIGIN,
  confirmLink,
  member,
  nextIp,
  seedChannel,
  seedForm,
  uniqueEmail,
} from './helpers';
import { installFakeVault } from './vault-fetch';

afterEach(() => useDebounceFetchForTests(undefined));

const withKey = { ...env, DEBOUNCE_API_KEY: 'dev' };

async function call(path: string, init: RequestInit, bindings: object = withKey) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`${ORIGIN}${path}`, { redirect: 'manual', ...init }),
    bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const json = (formId: string, email: string, bindings?: object) =>
  call(
    `/v1/${formId}/subscribe`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': nextIp(), origin: ORIGIN },
      body: JSON.stringify({ email, turnstileToken: 'token', parentOrigin: HOST, website: '' }),
    },
    bindings,
  );

const plain = (formId: string, email: string) =>
  call(`/v1/${formId}/subscribe`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cf-connecting-ip': nextIp(),
      origin: HOST,
      referer: `${HOST}/essays/one`,
    },
    body: new URLSearchParams({ email, 'cf-turnstile-response': 'token', website: '' }).toString(),
  });

/**
 * A publication whose workspace may use DeBounce, with signup checks turned on and their verdict
 * shown (both off by default); `null` keeps the defaults.
 */
async function allowed(
  settings: object | null = {},
  visible: object = { checkSignups: true, showSignupVerdict: true },
  doubleOptIn = false,
) {
  const channel = await seedChannel();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at)
       VALUES (?1, 'email_verification', 'workspace', ?2, 1, 0)`,
    ).bind(newId('featureFlag'), channel.workspaceId),
    env.DB.prepare(
      'INSERT INTO email_check_workspaces (workspace_id, created_at) VALUES (?1, ?2)',
    ).bind(channel.workspaceId, Date.now()),
    ...(settings
      ? [
          env.DB.prepare(
            'INSERT INTO email_check_settings (workspace_id, settings_json, updated_at) VALUES (?1, ?2, ?3)',
          ).bind(
            channel.workspaceId,
            JSON.stringify({ ...EMAIL_CHECK_DEFAULTS, ...visible, ...settings }),
            Date.now(),
          ),
        ]
      : []),
  ]);
  const { id } = await seedForm(channel, { doubleOptIn } as never);
  return { ...channel, formId: id };
}

const checkOf = (workspaceId: string, email: string) =>
  env.DB.prepare(
    'SELECT state, code, source FROM email_checks WHERE workspace_id = ?1 AND email = ?2',
  )
    .bind(workspaceId, email)
    .first();

describe('signup checks', () => {
  it('lets a deliverable address in and keeps its result', async () => {
    const c = await allowed();
    const email = uniqueEmail('jan');
    const res = await json(c.formId, email);
    expect(res.status).toBe(200);
    expect(await member(c.channelId, email)).not.toBeNull();
    expect(await checkOf(c.workspaceId, email)).toEqual({
      state: 'green',
      code: 5,
      source: 'debounce',
    });
  });

  it('refuses a red address with DeBounce’s suggestion, and keeps nothing about it', async () => {
    const c = await allowed();
    const res = await json(c.formId, 'jan@gmial.com');
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string; suggestion: string };
    };
    expect(body.error).toMatchObject({
      code: 'invalid_input',
      suggestion: 'jan@gmail.com',
      message:
        'This email address can’t receive email. Check it for typos. Did you mean jan@gmail.com?',
    });
    expect(await member(c.channelId, 'jan@gmial.com')).toBeNull();
    expect(await checkOf(c.workspaceId, 'jan@gmial.com')).toBeNull();
  });

  it('offers the suggestion on the plain form, with a fresh check that the person is real', async () => {
    const c = await allowed();
    const res = await plain(c.formId, 'mara@gmial.com');
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('Did you mean <strong>mara@gmail.com</strong>?');
    expect(html).toContain('name="email" value="mara@gmail.com"');
    expect(html).toContain('name="_challenge"');
    expect(html).toContain('Yes, use mara@gmail.com');
  });

  it('asks orange addresses to confirm when the rule says so, and tags them', async () => {
    const c = await allowed({ signup: { green: 'accept', orange: 'confirm', red: 'tag' } });
    const email = `catchall-${crypto.randomUUID().slice(0, 6)}@example.org`;
    expect((await json(c.formId, email)).status).toBe(200);
    expect(await member(c.channelId, email)).toMatchObject({ status: 'pending' });
    const bad = `bad-${crypto.randomUUID().slice(0, 6)}@example.org`;
    expect((await json(c.formId, bad)).status).toBe(200);
    const tagged = await env.DB.prepare(
      `SELECT t.name FROM member_tags mt JOIN tags t ON t.id = mt.tag_id JOIN members m ON m.id = mt.member_id
        WHERE m.email = ?1`,
    )
      .bind(bad)
      .first<{ name: string }>();
    expect(tagged?.name).toBe('email-red');
  });

  it('lets people in unchecked when DeBounce is out of credits or refuses the key', async () => {
    const c = await allowed();
    useDebounceFetchForTests(fakeDebounceFetch({ credits: { left: 0 } }));
    const one = uniqueEmail('credits');
    expect((await json(c.formId, one)).status).toBe(200);
    expect(await member(c.channelId, one)).not.toBeNull();
    expect(await checkOf(c.workspaceId, one)).toBeNull();
    useDebounceFetchForTests(fakeDebounceFetch({ wrongKey: true }));
    const two = `bad-${crypto.randomUUID().slice(0, 6)}@example.org`;
    expect((await json(c.formId, two)).status).toBe(200);
    expect(await member(c.channelId, two)).not.toBeNull();
  });

  it('gives up on a slow DeBounce within a few seconds, and lets them in', async () => {
    const c = await allowed();
    useDebounceFetchForTests(fakeDebounceFetch({ delayMs: 10_000 }));
    const email = `bad-slow-${crypto.randomUUID().slice(0, 6)}@example.org`;
    const started = Date.now();
    expect((await json(c.formId, email)).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(6000);
    expect(await member(c.channelId, email)).not.toBeNull();
  });

  it('sends nothing to DeBounce under the default settings, even for an allowed workspace', async () => {
    const c = await allowed(null);
    const asked: string[] = [];
    const fake = fakeDebounceFetch();
    useDebounceFetchForTests(async (input, init) => {
      asked.push(String(input));
      return fake(input, init);
    });
    for (const email of [
      uniqueEmail('quiet'),
      'quiet@gmial.com',
      `bad-${crypto.randomUUID().slice(0, 6)}@example.org`,
    ]) {
      expect((await json(c.formId, email)).status).toBe(200);
    }
    expect(asked).toEqual([]);
  });

  it('answers a refused address exactly like an accepted one unless the publisher shows verdicts', async () => {
    const c = await allowed({}, { checkSignups: true });
    const shape = async (res: Response) => {
      const text = await res.text();
      return {
        status: res.status,
        location: res.headers.get('location'),
        // Tokens and ids are random per signup; everything else must match.
        body: text.replace(/[A-Za-z0-9_-]{20,}/g, '…'),
      };
    };
    const good = await shape(await json(c.formId, uniqueEmail('good')));
    const red = await shape(await json(c.formId, 'hidden@gmial.com'));
    expect(red).toEqual(good);
    expect(red.body).not.toContain('gmail.com');
    expect(await member(c.channelId, 'hidden@gmial.com')).toBeNull();
    expect(await checkOf(c.workspaceId, 'hidden@gmial.com')).toBeNull();
    // The plain form too.
    const plainGood = await shape(await plain(c.formId, uniqueEmail('plaingood')));
    const plainRed = await shape(await plain(c.formId, 'plainhidden@gmial.com'));
    expect(plainRed.status).toBe(plainGood.status);
    expect(plainRed.location === null).toBe(plainGood.location === null);
    expect(plainRed.body).not.toContain('Did you mean');
    expect(await member(c.channelId, 'plainhidden@gmial.com')).toBeNull();
  });

  it("keeps each workspace within its daily share, reusing results, without touching another's", async () => {
    const a = await allowed();
    const b = await allowed();
    await env.DB.prepare(
      'INSERT INTO email_check_budgets (workspace_id, daily_checks, updated_at) VALUES (?1, 3, ?2)',
    )
      .bind(a.workspaceId, Date.now())
      .run();
    const asked: string[] = [];
    const fake = fakeDebounceFetch();
    useDebounceFetchForTests(async (input, init) => {
      asked.push(new URL(String(input)).searchParams.get('email') ?? '');
      return fake(input, init);
    });
    // The same address again and again costs one check: its result is reused.
    const same = uniqueEmail('again');
    for (let i = 0; i < 4; i++) expect((await json(a.formId, same)).status).toBe(200);
    expect(asked.filter((e) => e === same)).toHaveLength(1);
    // New addresses use up the rest of A's share, then pass unchecked.
    const fresh = Array.from({ length: 5 }, (_, i) => uniqueEmail(`share${i}`));
    for (const email of fresh) expect((await json(a.formId, email)).status).toBe(200);
    expect(asked).toHaveLength(3);
    for (const email of fresh) expect(await member(a.channelId, email)).not.toBeNull();
    expect(await checkOf(a.workspaceId, fresh[4]!)).toBeNull();
    // B still has its own share.
    const other = uniqueEmail('other');
    expect((await json(b.formId, other)).status).toBe(200);
    expect(asked).toContain(other);
    expect(await checkOf(b.workspaceId, other)).toMatchObject({ source: 'debounce' });
  });

  it('asks nothing for a workspace the owner hasn’t allowed, or without a key', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel, { doubleOptIn: false } as never);
    expect((await json(id, 'bad-1@example.org')).status).toBe(200);
    const c = await allowed();
    // An install without a DeBounce key: the vault has none to attach, and the sign-up goes on.
    await installFakeVault({ debounce: false });
    try {
      expect((await json(c.formId, 'bad-2@example.org', env)).status).toBe(200);
      expect(await checkOf(c.workspaceId, 'bad-2@example.org')).toBeNull();
    } finally {
      await installFakeVault();
    }
  });
});

describe('a form that asks people to confirm (S04-P3-TR-signup-check-after-confirmation)', () => {
  it('sends nothing to DeBounce at signup, and queues the check once the person confirms', async () => {
    const c = await allowed({}, { checkSignups: true, showSignupVerdict: true }, true);
    const asked: string[] = [];
    const fake = fakeDebounceFetch();
    useDebounceFetchForTests(async (input, init) => {
      asked.push(String(input));
      return fake(input, init);
    });
    const queued: unknown[] = [];
    const bindings = {
      ...withKey,
      PUBLIC_QUEUE: { send: async (message: unknown) => void queued.push(message) },
    };
    // Even a red address gets the ordinary answer and a confirmation: nothing was asked yet.
    const email = `bad-${crypto.randomUUID().slice(0, 6)}@example.org`;
    expect((await json(c.formId, email, bindings)).status).toBe(200);
    expect(await member(c.channelId, email)).toMatchObject({ status: 'pending' });
    expect(asked).toEqual([]);
    expect(queued.filter((m) => (m as { type: string }).type === 'email_check')).toEqual([]);
    expect(await checkOf(c.workspaceId, email)).toBeNull();

    const res = await call(await confirmLink(email), { method: 'POST' }, bindings);
    expect(await res.text()).toContain('You are in');
    const row = await member(c.channelId, email);
    expect(queued).toContainEqual({
      type: 'email_check',
      workspaceId: c.workspaceId,
      channelId: c.channelId,
      memberIds: [row!.id],
      confirmed: true,
    });
    // Each message is one the jobs worker accepts from the public queue (S04-P1-TR).
    for (const message of queued) expect(readQueueMessage('public', message).ok).toBe(true);
    // The message names the Member, never the address.
    expect(JSON.stringify(queued)).not.toContain(email);
    expect(asked).toEqual([]);
  });

  it('queues nothing on confirming where the workspace may not use email checks', async () => {
    // Capture holds no DeBounce key, so it can't tell an install without one: the jobs worker,
    // which holds it, skips the check there. What capture does know is the workspace's access.
    const c = await allowed({}, { checkSignups: true }, true);
    await env.DB.prepare(
      "DELETE FROM feature_flags WHERE key = 'email_verification' AND scope_id = ?1",
    )
      .bind(c.workspaceId)
      .run();
    const queued: unknown[] = [];
    const bindings = {
      ...env,
      PUBLIC_QUEUE: { send: async (message: unknown) => void queued.push(message) },
    };
    const email = uniqueEmail('nokey');
    expect((await json(c.formId, email, bindings)).status).toBe(200);
    await call(await confirmLink(email), { method: 'POST' }, bindings);
    expect(queued.filter((m) => (m as { type: string }).type === 'email_check')).toEqual([]);
  });
});
