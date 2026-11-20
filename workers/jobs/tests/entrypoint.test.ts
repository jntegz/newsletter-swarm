// The Workers runtime treats every named export of the entry module as an entrypoint and refuses
// to start when one is a plain value, so wrangler dev fails even though every other test passes.
import { describe, expect, it } from 'vitest';
import * as entry from '../src/index';

describe('entry module exports', () => {
  it('are all functions or handler objects', () => {
    for (const [name, value] of Object.entries(entry)) {
      const ok =
        typeof value === 'function' ||
        (typeof value === 'object' && value !== null && 'fetch' in value);
      expect(ok, `${name} is not a function or handler`).toBe(true);
    }
  });
});
