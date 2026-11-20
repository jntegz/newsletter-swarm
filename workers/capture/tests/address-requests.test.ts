// Data requests from the public request page (/privacy/<channelId>, privacy.ts
// startAddressRequest): for anyone, subscriber or not, confirmed from the inbox, answered the
// same whatever is held, rate-limited per IP and address.
import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import { addressMarker, runPrivacyRequests } from '@swarm/engine';
import { parseKeyring } from '@swarm/tokens';
import { describe, expect, it } from 'vitest';
import { jobsPrivacyVault } from './vault-fetch';
import { memberTokenFor } from './links';
import { audienceDeps } from '../src/context';
import { parseCaptureEnv } from '../src/env';
import { addMember, call, mailTo, nextIp, ORIGIN, seedChannel, uniqueEmail } from './helpers';

const fieldKeys = parseKeyring(env.TEST_FIELD_KEYS);

function ask(
  channelId: string,
  fields: Record<string, string>,
  options: { ip?: string; origin?: string | null } = {},
) {
  return call(`/privacy/${channelId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cf-connecting-ip': options.ip ?? nextIp(),
      ...(options.origin === null ? {} : { origin: options.origin ?? ORIGIN }),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

const confirmPath = async (to: string) => {
  const mail = (await mailTo(to)).filter((m) => m.category === 'privacy_confirm');
  return mail.map(
    (m) => /https:\/\/forms\.swarm\.test(\/privacy\/confirm\/[A-Za-z0-9._-]+)/.exec(m.text)?.[1],
  );
};

const post = (path: string) =>
  call(path, {
    method: 'POST',
    headers: { origin: ORIGIN, 'cf-connecting-ip': nextIp() },
  });

async function requestsFor(workspaceId: string, email: string) {
  const marker = await addressMarker(env.DB, workspaceId, email, fieldKeys);
  return (
    await env.DB.prepare(
      'SELECT kind, source, status, member_id FROM dsr_requests WHERE workspace_id = ?1 AND email_hash = ?2',
    )
      .bind(workspaceId, marker)
      .all<{ kind: string; source: string; status: string; member_id: string | null }>()
  ).results;
}

/** The answer with the masked address taken out: it must not depend on what is held. */
const answer = async (res: Response) =>
  (await res.text()).replace(/.•••@[^\s<]+/g, '<address>').replace(/nonce[-=]"?[^"' ]+/g, '');

describe('the public data request page', () => {
  it('lets a buyer who never subscribed have their data deleted, from their inbox', async () => {
    const { workspaceId, channelId } = await seedChannel();
    const email = uniqueEmail('buyer');
    const reference = `ref${crypto.randomUUID().replace(/-/g, '')}`;
    await env.DB.prepare(
      `INSERT INTO checkout_sessions (reference, channel_id, email, intent, created_at)
       VALUES (?1, ?2, ?3, 'tip', 0)`,
    )
      .bind(reference, channelId, email)
      .run();
    expect((await call(`/privacy/${channelId}`)).status).toBe(200);
    const res = await ask(channelId, { email, kind: 'erase' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Check your inbox');
    // Nothing is filed until the link is used.
    expect(await requestsFor(workspaceId, email)).toEqual([]);
    const [path] = await confirmPath(email);
    expect(path).toBeTruthy();
    expect((await call(path!)).status).toBe(200);
    const done = await post(path!);
    expect(await done.text()).toContain('Your request was received');
    expect(await requestsFor(workspaceId, email)).toEqual([
      { kind: 'erase', source: 'address_form', status: 'processing', member_id: null },
    ]);
    // Single use.
    expect((await post(path!)).status).toBe(404);
    const e = parseCaptureEnv(env);
    await runPrivacyRequests(
      { ...audienceDeps(e), fieldKeys: await jobsPrivacyVault(), exports: e.EXPORTS },
      Date.now(),
    );
    expect(
      await env.DB.prepare('SELECT email FROM checkout_sessions WHERE reference = ?1')
        .bind(reference)
        .first(),
    ).toEqual({ email: null });
    // No subscriber was made on the way, and the waiting confirmation is gone.
    expect(
      await env.DB.prepare('SELECT count(*) AS n FROM members WHERE email = ?1')
        .bind(email)
        .first(),
    ).toEqual({ n: 0 });
    expect(
      await env.DB.prepare(
        'SELECT count(*) AS n FROM address_confirmations WHERE workspace_id = ?1',
      )
        .bind(workspaceId)
        .first(),
    ).toEqual({ n: 0 });
  });

  it('answers the same whether or not anything is held, and mails only a link', async () => {
    const { channelId } = await seedChannel();
    const held = uniqueEmail('held');
    await addMember(channelId, held, 'active');
    const unknown = uniqueEmail('unknown');
    const a = await ask(channelId, { email: held, kind: 'export' });
    const b = await ask(channelId, { email: unknown, kind: 'export' });
    expect(a.status).toBe(b.status);
    expect(await answer(a)).toBe(await answer(b));
    expect(await confirmPath(held)).toHaveLength(1);
    expect(await confirmPath(unknown)).toHaveLength(1);
    // A second ask within minutes sends no second email.
    await ask(channelId, { email: unknown, kind: 'export' });
    expect(await confirmPath(unknown)).toHaveLength(1);
  });

  it('files an export for the address that the jobs worker mails as a download link', async () => {
    const { workspaceId, channelId } = await seedChannel();
    const email = uniqueEmail('giver');
    await ask(channelId, { email, kind: 'export' });
    const [path] = await confirmPath(email);
    await post(path!);
    expect(await requestsFor(workspaceId, email)).toMatchObject([
      { kind: 'export', source: 'address_form', status: 'processing' },
    ]);
  });

  it('mails nothing to an address that complained, bounced or was erased, and says the same', async () => {
    const { workspaceId, channelId } = await seedChannel();
    const complained = uniqueEmail('complained');
    await env.DB.prepare(
      `INSERT INTO suppressions (id, workspace_id, email, reason, created_at)
       VALUES (?1, ?2, ?3, 'complaint', 0)`,
    )
      .bind(newId('suppression'), workspaceId, complained)
      .run();
    const res = await ask(channelId, { email: complained, kind: 'erase' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Check your inbox');
    expect(await confirmPath(complained)).toEqual([]);
  });

  it('is rate-limited per IP and per address, ignores the honeypot and other origins', async () => {
    const { channelId } = await seedChannel();
    const ip = nextIp();
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      statuses.push(
        (await ask(channelId, { email: uniqueEmail(), kind: 'export' }, { ip })).status,
      );
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
    const target = uniqueEmail('target');
    const perAddress = [];
    for (let i = 0; i < 4; i++) {
      perAddress.push((await ask(channelId, { email: target, kind: 'erase' })).status);
    }
    expect(perAddress.slice(0, 3)).toEqual([200, 200, 200]);
    expect(perAddress[3]).toBe(429);

    const trapped = uniqueEmail('bot');
    await ask(channelId, { email: trapped, kind: 'erase', website: 'x' });
    expect(await confirmPath(trapped)).toEqual([]);
    const foreign = uniqueEmail('foreign');
    expect(
      (await ask(channelId, { email: foreign, kind: 'erase' }, { origin: 'https://evil.example' }))
        .status,
    ).toBe(404);
    expect(await confirmPath(foreign)).toEqual([]);
  });

  it('is linked from subscriber settings', async () => {
    const { channelId } = await seedChannel();
    const id = await addMember(channelId, uniqueEmail(), 'active');
    const token = await memberTokenFor(id);
    const html = await (await call(`/m/${token}`)).text();
    expect(html).toContain(`href="/privacy/${channelId}"`);
  });
});
