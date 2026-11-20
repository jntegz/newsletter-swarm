import { describe, expect, it } from 'vitest';
import { tabTitle } from './tabStatus';

describe('tabTitle', () => {
  it('reads status, page, publication, product', () => {
    expect(tabTitle({ status: 'Sending 42%', page: 'The slow web', place: 'Field Notes' })).toBe(
      'Sending 42% · The slow web · Field Notes · Swarm',
    );
  });
  it('drops what is missing or repeated', () => {
    expect(tabTitle({ status: null, page: 'Field Notes', place: 'Field Notes' })).toBe(
      'Field Notes · Swarm',
    );
    expect(tabTitle({ status: null, page: null, place: null })).toBe('Swarm');
  });
});
