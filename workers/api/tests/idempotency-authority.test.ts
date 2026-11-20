// Idempotency-Key replays and current authority (S04-P1-V-idempotent-narrowed-replay) and
// responses that carry a bearer value (S04-P1-V-consent-code-storage).
import { env } from 'cloudflare:test';
import type { MemberDetail } from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  call,
  createChannel,
  freshFactor,
  json,
  signIn,
  uniqueEmail,
  type Session,
} from './helpers';
import { REDIRECT, authorizeQuery, createApp, form, pkce } from './oauth-helpers';
import { createKey, setPlan, v2 } from './v2-helpers';

let owner: Session;
let x: string;
let y: string;

beforeAll(async () => {
  owner = await freshFactor(await signIn());
  await setPlan(owner.workspaceId, 'pro');
  x = (await createChannel(owner)).id;
  y = (await createChannel(owner)).id;
});

const stored = (principal: string, key: string) =>
  env.DB.prepare('SELECT * FROM api_idempotency WHERE principal = ?1 AND key = ?2')
    .bind(principal, key)
    .first<{ response_json: string; status: number }>();

describe('a replay after a key is narrowed', () => {
  it('is refused for a removed Channel like a fresh request, and still replays for a kept one', async () => {
    const { key, secret } = await createKey(owner, {
      scopes: ['members:write'],
      channelIds: [x, y],
    });
    const toX = { 'Idempotency-Key': `x-${crypto.randomUUID()}` };
    const toY = { 'Idempotency-Key': `y-${crypto.randomUUID()}` };
    const bodyX = { email: uniqueEmail('x') };
    const bodyY = { email: uniqueEmail('y') };
    const firstX = await v2('POST', `/v2/channels/${x}/members`, secret, {
      body: bodyX,
      headers: toX,
    });
    expect(firstX.status).toBe(201);
    const firstY = await v2('POST', `/v2/channels/${y}/members`, secret, {
      body: bodyY,
      headers: toY,
    });
    expect(firstY.status).toBe(201);
    const firstYBody = await firstY.text();

    // Narrow the key to Y.
    await freshFactor(owner);
    const narrowed = await call(
      'PATCH',
      `/api/v1/workspaces/${owner.workspaceId}/api-keys/${key.id}`,
      {
        cookie: owner.cookie,
        body: { channelIds: [y] },
      },
    );
    expect(narrowed.status).toBe(200);

    const replayX = await v2('POST', `/v2/channels/${x}/members`, secret, {
      body: bodyX,
      headers: toX,
    });
    const fresh = await v2('POST', `/v2/channels/${x}/members`, secret, {
      body: { email: uniqueEmail('x2') },
    });
    expect(replayX.status).toBe(fresh.status);
    expect(replayX.status).toBe(404);
    expect(replayX.headers.get('idempotent-replayed')).toBeNull();
    expect(await replayX.text()).not.toContain(bodyX.email);

    const replayY = await v2('POST', `/v2/channels/${y}/members`, secret, {
      body: bodyY,
      headers: toY,
    });
    expect(replayY.status).toBe(201);
    expect(replayY.headers.get('idempotent-replayed')).toBe('true');
    expect(await replayY.text()).toBe(firstYBody);
    const count = await env.DB.prepare('SELECT count(*) AS n FROM members WHERE email = ?1')
      .bind(bodyY.email)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});

describe('a response carrying a bearer value', () => {
  it('the OAuth consent redirect, with its code, is never stored, and the code still works once', async () => {
    const { app } = await createApp(owner, { scopes: ['channels:read'] });
    const { verifier, challenge } = pkce();
    const codeChallenge = await challenge();
    const key = `consent-${crypto.randomUUID()}`;
    const send = () =>
      call('POST', '/api/v1/oauth/consent', {
        cookie: owner.cookie,
        headers: { 'Idempotency-Key': key },
        body: {
          ...authorizeQuery({
            clientId: app.clientId,
            scope: 'channels:read',
            challenge: codeChallenge,
          }),
          decision: 'allow',
          workspaceId: owner.workspaceId,
        },
      });
    const res = await send();
    expect(res.status, await res.clone().text()).toBe(200);
    const url = new URL((await json<{ data: { redirectUrl: string } }>(res)).data.redirectUrl);
    const code = url.searchParams.get('code')!;
    const row = await stored(`operator:${owner.me.operator.id}`, key);
    expect(row?.response_json ?? '').not.toContain(code);
    expect(row?.response_json ?? '').not.toContain('redirectUrl');
    // A repeat does not hand back the earlier code from storage.
    const again = await send();
    expect(again.headers.get('idempotent-replayed')).toBeNull();
    expect(await again.text()).not.toContain(code);
    // The flow still completes, once.
    const token = await form('/oauth/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id: app.clientId,
    });
    expect(token.status, await token.clone().text()).toBe(200);
  });

  it('a response that looks like it holds a key is not stored even without no-store', async () => {
    // A Member whose name looks like an API key: storing it is refused, the request still works.
    const { secret } = await createKey(owner, { scopes: ['members:write'] });
    const key = `odd-${crypto.randomUUID()}`;
    const res = await v2('POST', `/v2/channels/${x}/members`, secret, {
      body: { email: uniqueEmail('odd'), firstName: 'sk_live_lookalike' },
      headers: { 'Idempotency-Key': key },
    });
    expect(res.status).toBe(201);
    const member = (await json<{ data: MemberDetail }>(res)).data;
    expect(member.id).toBeTruthy();
    const keyRow = await env.DB.prepare('SELECT principal FROM api_idempotency WHERE key = ?1')
      .bind(key)
      .first<{ principal: string }>();
    const row = await stored(keyRow!.principal, key);
    expect(row?.response_json).toBe('');
  });
});
