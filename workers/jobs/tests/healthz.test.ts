import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as entry from '../src/index';
import app from '../src/index';

describe('jobs worker', () => {
  it('reports healthy', async () => {
    const res = await SELF.fetch('http://jobs.test/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { ok: true, service: 'jobs' } });
  });

  it('refuses requests without a valid environment', async () => {
    const res = await app.fetch(new Request('http://jobs.test/healthz'), {}, {
      waitUntil() {},
      passThroughOnException() {},
    } as unknown as ExecutionContext);
    expect(res.status).toBe(503);
  });

  it('exports only handlers from its entry module, which workerd requires to start', () => {
    const bad = Object.entries(entry).filter(
      ([, value]) => typeof value !== 'function' && (typeof value !== 'object' || value === null),
    );
    expect(bad.map(([name]) => name)).toEqual([]);
  });
});
