import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ATTEMPTS_AFTER_CLOSE,
  RETRY_DELAYS_MS,
  createSaveQueue,
  fitsKeepalive,
  type SaveStatus,
} from './saveQueue';

const DEBOUNCE = 1000;

/** A queue over a "document" the test types into, with saves the test finishes by hand. */
function harness() {
  const doc = { text: '' };
  const saves: { text: string; resolve: () => void; reject: (reason: Error) => void }[] = [];
  const states: SaveStatus[] = [];
  const queue = createSaveQueue<string>({
    debounceMs: DEBOUNCE,
    read: () => doc.text,
    write: (text) =>
      new Promise<void>((resolve, reject) => {
        saves.push({ text, resolve, reject });
      }),
    onChange: (status) => states.push(status),
  });
  const type = (text: string) => {
    doc.text = text;
    queue.changed();
  };
  const state = () => states.at(-1)?.state;
  const settle = () => vi.advanceTimersByTimeAsync(0);
  return { queue, saves, states, type, state, settle };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the debounce', () => {
  it('saves once after typing stops, however many keystrokes came first', async () => {
    const { saves, type } = harness();
    for (const text of ['a', 'ab', 'abc']) {
      type(text);
      await vi.advanceTimersByTimeAsync(DEBOUNCE / 2);
    }
    expect(saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(saves.map((s) => s.text)).toEqual(['abc']);
  });
});

describe('typing during a save', () => {
  it('coalesces into one more save, which reads the document when it starts', async () => {
    const { queue, saves, type, state, settle } = harness();
    type('first');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(saves).toHaveLength(1);
    expect(state()).toBe('saving');

    type('second');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    type('third');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(saves).toHaveLength(1);

    saves[0]!.resolve();
    await settle();
    expect(saves.map((s) => s.text)).toEqual(['first', 'third']);
    expect(state()).toBe('saving');
    expect(queue.pending()).toBe(true);

    saves[1]!.resolve();
    await settle();
    expect(saves).toHaveLength(2);
    expect(state()).toBe('saved');
    expect(queue.pending()).toBe(false);
  });

  it('waits for the debounce when typing goes on as a save finishes', async () => {
    const { saves, type, state, settle } = harness();
    type('first');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    type('second');
    saves[0]!.resolve();
    await settle();
    expect(saves).toHaveLength(1);
    expect(state()).toBe('unsaved');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(saves.map((s) => s.text)).toEqual(['first', 'second']);
  });
});

describe('the status', () => {
  it('says saved only when nothing is dirty and nothing is running', async () => {
    const { queue, saves, type, states, settle } = harness();
    type('one');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    type('two');
    saves[0]!.resolve();
    await settle();
    expect(states.filter((s) => s.state === 'saved')).toHaveLength(0);
    expect(queue.pending()).toBe(true);

    void queue.flush();
    saves[1]!.resolve();
    await settle();
    expect(states.at(-1)?.state).toBe('saved');
    expect(states.at(-1)?.savedAt).toBeInstanceOf(Date);
  });
});

describe('a failed save', () => {
  it('stays Not saved, retries with growing delays, and clears when one lands', async () => {
    const { queue, saves, type, state, states, settle } = harness();
    type('words');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    saves[0]!.reject(new Error('Network down'));
    await settle();
    expect(state()).toBe('error');
    expect(states.at(-1)?.error).toBe('Network down');
    expect(queue.pending()).toBe(true);

    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]! - 1);
    expect(saves).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves).toHaveLength(2);
    // Still not saved while the retry runs.
    expect(state()).toBe('error');

    saves[1]!.reject(new Error('Network down'));
    await settle();
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]!);
    expect(saves).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1]! - RETRY_DELAYS_MS[0]!);
    expect(saves).toHaveLength(3);

    saves[2]!.resolve();
    await settle();
    expect(state()).toBe('saved');
    expect(states.at(-1)?.error).toBeNull();
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS.at(-1)! * 2);
    expect(saves).toHaveLength(3);
  });

  it('keeps retrying at the longest delay while the page stays open', async () => {
    const { saves, type, settle } = harness();
    type('words');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 3; attempt++) {
      saves.at(-1)!.reject(new Error('Network down'));
      await settle();
      await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS.at(-1)!);
    }
    expect(saves).toHaveLength(RETRY_DELAYS_MS.length + 4);
  });

  it('stays Not saved when more typing comes in, and saves the newest text', async () => {
    const { saves, type, state, settle } = harness();
    type('old');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    saves[0]!.reject(new Error('Network down'));
    await settle();
    type('new');
    expect(state()).toBe('error');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(saves[1]!.text).toBe('new');
    saves[1]!.resolve();
    await settle();
    expect(state()).toBe('saved');
  });
});

describe('flush', () => {
  it('resolves at once when there is nothing to save', async () => {
    const { queue, saves } = harness();
    await expect(queue.flush()).resolves.toBeUndefined();
    expect(saves).toHaveLength(0);
  });

  it('resolves only when everything is stored, across a running save', async () => {
    const { queue, saves, type, settle } = harness();
    type('first');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    type('second');

    let done = false;
    void queue.flush().then(() => {
      done = true;
    });
    saves[0]!.resolve();
    await settle();
    expect(done).toBe(false);
    expect(saves.map((s) => s.text)).toEqual(['first', 'second']);

    saves[1]!.resolve();
    await settle();
    expect(done).toBe(true);
  });

  it('rejects when the save fails, and leaves the retry running', async () => {
    const { queue, saves, type, settle } = harness();
    type('words');
    const flushed = queue.flush();
    saves[0]!.reject(new Error('Network down'));
    await expect(flushed).rejects.toThrow('Network down');
    await settle();
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]!);
    expect(saves).toHaveLength(2);
  });

  it('tries again at once after a failure, and doesn’t wait for typing that comes after it', async () => {
    const { queue, saves, type, settle } = harness();
    type('words');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    saves[0]!.reject(new Error('Network down'));
    await settle();

    let done = false;
    void queue.flush().then(() => {
      done = true;
    });
    expect(saves).toHaveLength(2);
    type('later words');
    saves[1]!.resolve();
    await settle();
    expect(done).toBe(true);
  });
});

describe('closing the editor', () => {
  it('saves right away, without the debounce, and reports when it is done', async () => {
    const { queue, saves, type, settle } = harness();
    type('words');
    const settled = vi.fn();
    queue.close(settled);
    expect(saves.map((s) => s.text)).toEqual(['words']);
    expect(settled).not.toHaveBeenCalled();
    saves[0]!.resolve();
    await settle();
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('does nothing and settles at once when already saved', () => {
    const { queue, saves } = harness();
    const settled = vi.fn();
    queue.close(settled);
    expect(saves).toHaveLength(0);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('gives up on a save that keeps failing', async () => {
    const { queue, saves, type, settle } = harness();
    type('words');
    const settled = vi.fn();
    queue.close(settled);
    for (let attempt = 0; attempt < ATTEMPTS_AFTER_CLOSE; attempt++) {
      saves.at(-1)!.reject(new Error('Network down'));
      await settle();
      await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS.at(-1)!);
    }
    expect(saves).toHaveLength(ATTEMPTS_AFTER_CLOSE);
    expect(settled).toHaveBeenCalledTimes(1);
  });
});

describe('fitsKeepalive', () => {
  it('counts bytes, not characters', () => {
    expect(fitsKeepalive('a'.repeat(1000))).toBe(true);
    expect(fitsKeepalive('a'.repeat(64_000))).toBe(false);
    expect(fitsKeepalive('é'.repeat(32_000))).toBe(false);
  });
});
