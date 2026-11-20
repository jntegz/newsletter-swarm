import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { app } from '../src/index';

describe('track worker', () => {
  it('reports healthy', async () => {
    const res = await app.request('/healthz', {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { ok: true, service: 'track' } });
  });

  it('refuses requests without a valid environment', async () => {
    const res = await app.request('/healthz', {}, {});
    expect(res.status).toBe(503);
  });
});
