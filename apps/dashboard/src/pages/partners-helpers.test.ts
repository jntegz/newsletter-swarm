import { describe, expect, it } from 'vitest';
import { clickCount, sponsorCard } from './partners-helpers';

describe('sponsorCard', () => {
  it('marks the ad and uses the counting link, not the sponsor’s own', () => {
    expect(
      sponsorCard({
        adTitle: 'Try Acme',
        adBody: 'It works.',
        clickUrl: 'https://x.test/_swarm/sponsored/bk_1',
      }),
    ).toEqual({
      href: 'https://x.test/_swarm/sponsored/bk_1',
      title: 'Sponsored: Try Acme',
      description: 'It works.',
    });
  });
});

describe('clickCount', () => {
  it('gets one right', () => {
    expect(clickCount(1)).toBe('1 click');
    expect(clickCount(1200)).toBe('1,200 clicks');
    expect(clickCount(0)).toBe('0 clicks');
  });
});
