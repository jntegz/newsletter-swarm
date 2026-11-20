import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ApiError,
  BaseEnvSchema,
  EnvError,
  defineEnv,
  localRequest,
  redact,
  secret,
  useRuntime,
  type RuntimeVariables,
} from '../src/index';

const parseEnv = defineEnv(BaseEnvSchema.extend({ SIGNING_KEY: secret() }));
const goodEnv = { ENVIRONMENT: 'test', SIGNING_KEY: 'k'.repeat(32) };

function buildApp() {
  const app = new Hono<{ Variables: RuntimeVariables }>();
  useRuntime(app, { service: 'unit', parseEnv, securityTxt: true });
  app.get('/boom', () => {
    throw new Error('kaboom user@example.com');
  });
  app.get('/conflict', () => {
    throw new ApiError('conflict', 'That slug is taken.');
  });
  app.get('/zod', () => {
    z.object({ name: z.string() }).parse({});
    return new Response('unreachable');
  });
  return app;
}

describe('defineEnv', () => {
  it('fails closed when a secret is missing, naming the key only', () => {
    expect(() => parseEnv({ ENVIRONMENT: 'production' })).toThrow(EnvError);
    try {
      parseEnv({ ENVIRONMENT: 'production', SIGNING_KEY: 'short' });
    } catch (error) {
      expect((error as EnvError).problems.join()).toContain('SIGNING_KEY');
      expect((error as EnvError).message).not.toContain('short');
    }
  });

  it('accepts a complete env', () => {
    expect(parseEnv(goodEnv).ENVIRONMENT).toBe('test');
  });

  it('accepts a deployed key whose id only contains dev0', () => {
    const SIGNING_KEY = 'kdev0:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
    expect(parseEnv({ ENVIRONMENT: 'production', SIGNING_KEY }).ENVIRONMENT).toBe('production');
  });

  it('refuses the placeholder keys from .dev.vars.example outside development', () => {
    const placeholders = [
      'k1:development-only-track-key-replace-before-using-this-file',
      'k1:replace-with-64-random-hex-characters-before-using-this-file',
      // The example Ed25519 keyrings, which can't spell it out.
      'dev0:MC4CAQAwBQYDK2VwBCIEIEXKf0Kf-9zhaQaCaKCc9YC0zYHPm9QJIFUdyr1Iims6',
      'k20261119:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ, dev0:DsT8V2i1akM8f3JdsIMC5fW9QhKyaBTwfiQyHiffkcs',
    ];
    for (const SIGNING_KEY of placeholders) {
      for (const ENVIRONMENT of ['staging', 'production']) {
        expect(() => parseEnv({ ENVIRONMENT, SIGNING_KEY }), ENVIRONMENT).toThrow(
          /SIGNING_KEY: .*\.dev\.vars\.example/,
        );
      }
      // Fine on a laptop, which is what the example file is for.
      expect(parseEnv({ ENVIRONMENT: 'development', SIGNING_KEY }).ENVIRONMENT).toBe('development');
    }
    try {
      parseEnv({ ENVIRONMENT: 'production', SIGNING_KEY: placeholders[0] });
    } catch (error) {
      expect((error as EnvError).message).not.toContain('track-key');
    }
  });
});

describe('redact', () => {
  it('removes emails and signed tokens', () => {
    expect(redact('mail jo@example.com token v1.confirm.k1.eyJ4IjoxfQ.abc_-1')).toBe(
      'mail [email] token [token]',
    );
    // A per-family link too, whatever its signature's length.
    expect(redact(`link /m/v2.member.k20261119.eyJtIjoxfQ.${'A'.repeat(86)} done`)).toBe(
      'link /m/[token] done',
    );
  });

  it('removes addresses with no dot after the @, as a cut-off provider value has', () => {
    expect(redact('to jo@localhost and ann@exam')).toBe('to [email] and [email]');
  });

  it('removes model API keys', () => {
    expect(redact('{"key":"sk-ant-api03-Ab_c-123"}')).toBe('{"key":"[key]"}');
  });
});

describe('useRuntime', () => {
  it('serves healthz with security headers and a request id', async () => {
    const res = await buildApp().request('/healthz', {}, goodEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: { ok: true, service: 'unit', environment: 'test' },
    });
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expect(res.headers.get('strict-transport-security')).toContain('preload');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('reports the vault through a VAULT binding, and is unavailable when it does not answer', async () => {
    const up = { ...goodEnv, VAULT: { ping: async () => ({ ok: true, entrypoint: 'api' }) } };
    const res = await buildApp().request('/healthz', {}, up);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { ok: true, vault: 'ok' } });
    const down = {
      ...goodEnv,
      VAULT: {
        ping: async () => {
          throw new Error('no such service');
        },
      },
    };
    const failed = await buildApp().request('/healthz', {}, down);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ error: { code: 'unavailable' } });
    const odd = { ...goodEnv, VAULT: { ping: async () => 'yes' } };
    expect((await buildApp().request('/healthz', {}, odd)).status).toBe(503);
  });

  it('refuses every request when the env is invalid', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await buildApp().request('/healthz', {}, { ENVIRONMENT: 'production' });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'unavailable' } });
    error.mockRestore();
  });

  it('wraps errors in the envelope without leaking internals', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = buildApp();

    const boom = await app.request('/boom', {}, goodEnv);
    expect(boom.status).toBe(500);
    const body = (await boom.json()) as { error: { message: string; requestId: string } };
    expect(body.error.message).not.toContain('kaboom');
    expect(body.error.requestId).toBeTruthy();
    expect(error.mock.calls.flat().join()).not.toContain('user@example.com');

    expect((await app.request('/conflict', {}, goodEnv)).status).toBe(409);

    const invalid = await app.request('/zod', {}, goodEnv);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: 'invalid_input', details: [{ path: 'name' }] },
    });

    const missing = await app.request('/nope', {}, goodEnv);
    expect(missing.status).toBe(404);
    error.mockRestore();
  });

  it('serves security.txt', async () => {
    const res = await buildApp().request('/.well-known/security.txt', {}, goodEnv);
    expect(await res.text()).toContain('Contact: https://github.com/');
  });
});

describe('localRequest', () => {
  it('knows the names only a local run has', () => {
    for (const url of [
      'http://localhost:8793/__dev/x',
      'http://127.0.0.1:8792/',
      'http://[::1]:8787/',
      'http://letter.site.localhost:8792/',
      'http://letter.swarm.test/',
      'http://localhost./',
    ]) {
      expect(localRequest(url), url).toBe(true);
    }
  });

  it('refuses every name a deployed Worker can be reached on', () => {
    for (const url of [
      'https://app.example.com/__dev/mail',
      'https://swarm-jobs-local.someone.workers.dev/',
      'https://localhost.example.com/',
      'https://test.example.org/',
      'https://notes.swarm.page/',
      'https://128.0.0.1/',
      'not a url',
    ]) {
      expect(localRequest(url), url).toBe(false);
    }
  });
});
