import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, onUnauthorized, request } from './client';

function mockFetch(status: number, body: unknown) {
  const spy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    status === 204 ? new Response(null, { status }) : Response.json(body, { status }),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe('api client', () => {
  it('encodes JSON bodies exactly once', async () => {
    const spy = mockFetch(200, { data: { ok: true } });
    await api.post('/api/v1/things', { name: 'Field Notes' });
    const init = spy.mock.calls[0]?.[1];
    expect(init?.body).toBe('{"name":"Field Notes"}');
    expect(JSON.parse(init?.body as string)).toEqual({ name: 'Field Notes' });
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('refuses a pre-encoded string so double encoding cannot happen', async () => {
    mockFetch(200, { data: null });
    await expect(request('POST', '/x', { json: '{"a":1}' })).rejects.toThrow(TypeError);
  });

  it('sends multipart without forcing a content type', async () => {
    const spy = mockFetch(201, { data: { id: 'md_1' } });
    const form = new FormData();
    form.set('file', new Blob(['x']), 'a.png');
    await api.upload('/api/v1/channels/ch_1/media', form);
    const init = spy.mock.calls[0]?.[1];
    expect(init?.body).toBe(form);
    expect((init?.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('unwraps the data envelope and handles 204', async () => {
    mockFetch(200, { data: [1, 2] });
    expect(await api.get('/x')).toEqual([1, 2]);
    mockFetch(204, null);
    expect(await api.delete('/x')).toBeUndefined();
  });

  it('turns error envelopes into ApiError with field details', async () => {
    mockFetch(400, {
      error: {
        code: 'invalid_input',
        message: 'Some fields are not valid.',
        requestId: 'r',
        details: [{ path: 'slug', message: 'Taken' }],
      },
    });
    const error = await api.post('/x', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('invalid_input');
    expect((error as ApiError).field('slug')).toBe('Taken');
  });

  it('notifies listeners on 401', async () => {
    const listener = vi.fn();
    const off = onUnauthorized(listener);
    mockFetch(401, {
      error: { code: 'unauthorized', message: 'Sign in to continue.', requestId: 'r' },
    });
    await expect(api.get('/x')).rejects.toBeInstanceOf(ApiError);
    expect(listener).toHaveBeenCalledOnce();
    off();
  });

  it('reports network failures in plain language', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const error = (await api.get('/x').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('network');
    expect(error.message).toMatch(/could not be reached/);
  });
});
