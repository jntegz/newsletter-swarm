import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';
import { CopilotStreamError, parseSse, streamCopilot } from './copilot';

afterEach(() => vi.unstubAllGlobals());

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe('parseSse', () => {
  it('returns complete events and keeps the incomplete tail', () => {
    const { events, rest } = parseSse(
      'event: delta\ndata: {"text":"a"}\n\nevent: delta\r\ndata: {"text":"b"}\r\n\r\nevent: do',
    );
    expect(events).toEqual([
      { event: 'delta', data: '{"text":"a"}' },
      { event: 'delta', data: '{"text":"b"}' },
    ]);
    expect(rest).toBe('event: do');
  });
});

describe('streamCopilot', () => {
  it('passes deltas through and resolves with the result, across chunk boundaries', async () => {
    const body = streamOf([
      'event: delta\ndata: {"text":"Hel',
      'lo"}\n\nevent: delta\ndata: {"text":" there"}\n\n',
      'event: done\ndata: {"requestId":"ai_1","text":"Hello there","suggestions":[],"remaining":3}\n\n',
    ]);
    const spy = vi.fn(async () => new Response(body, { status: 200 }));
    vi.stubGlobal('fetch', spy);
    const deltas: string[] = [];
    const done = await streamCopilot(
      'dp_1',
      { feature: 'teaser', text: 'x' },
      { onDelta: (t) => deltas.push(t) },
    );
    expect(deltas).toEqual(['Hello', ' there']);
    expect(done).toEqual({ requestId: 'ai_1', text: 'Hello there', suggestions: [], remaining: 3 });
    const init = (spy.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.body).toBe('{"feature":"teaser","text":"x"}');
  });

  it('rejects with the stream error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            streamOf(['event: error\ndata: {"code":"refused","message":"Declined."}\n\n']),
          ),
      ),
    );
    const error = await streamCopilot('dp_1', { feature: 'teaser', text: 'x' }).catch((e) => e);
    expect(error).toBeInstanceOf(CopilotStreamError);
    expect(error).toMatchObject({ code: 'refused', message: 'Declined.' });
  });

  it('rejects with ApiError when the request is refused before streaming', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: 'rate_limited',
              message: 'Limit',
              requestId: 'r',
              details: [{ path: 'quota', message: 'month' }],
            },
          },
          { status: 429 },
        ),
      ),
    );
    const error = await streamCopilot('dp_1', { feature: 'teaser', text: 'x' }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).field('quota')).toBe('month');
  });
});
