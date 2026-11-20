import { describe, expect, it } from 'vitest';
import app from '../src/index';

describe('realtime worker', () => {
  it('reports healthy', async () => {
    const res = await app.request('/healthz', {}, { ENVIRONMENT: 'test' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { ok: true, service: 'realtime' } });
  });

  it('refuses requests without a valid environment', async () => {
    const res = await app.request('/healthz', {}, {});
    expect(res.status).toBe(503);
  });
});
