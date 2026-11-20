import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { app } from '../src/index';

describe('capture worker', () => {
  it('reports healthy', async () => {
    const res = await app.request('/healthz', {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { ok: true, service: 'capture' } });
  });

  it('refuses requests without a valid environment', async () => {
    const res = await app.request('/healthz', {}, { ENVIRONMENT: 'test' });
    expect(res.status).toBe(503);
  });

  it('refuses development-only settings (test keys, dev mailbox, http origin) elsewhere', async () => {
    const res = await app.request('/healthz', {}, { ...env, ENVIRONMENT: 'production' });
    expect(res.status).toBe(503);
  });
});
