import { describe, expect, it } from 'vitest';
import { ENGAGEMENT_MIN_SENT, scoreEngagement } from '../src/engagement';

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 4);
const counts = (over: Partial<Parameters<typeof scoreEngagement>[0]> = {}) => ({
  sent: 10,
  humanOpened: 0,
  humanClicked: 0,
  machineOnly: 0,
  lastEngagedAt: null,
  ...over,
});

describe('scoreEngagement', () => {
  it('gives no score until enough posts have reached someone', () => {
    expect(scoreEngagement(counts({ sent: ENGAGEMENT_MIN_SENT - 1 }), now)).toEqual({
      score: null,
      band: 'too_few_posts',
    });
  });

  it('does not call someone cold when a privacy proxy hides their opens', () => {
    expect(scoreEngagement(counts({ machineOnly: 10 }), now)).toEqual({
      score: null,
      band: 'opens_hidden',
    });
    expect(scoreEngagement(counts({ machineOnly: 5 }), now).band).toBe('opens_hidden');
  });

  it('calls someone cold when posts reach them and nothing is opened', () => {
    expect(scoreEngagement(counts(), now)).toEqual({ score: 0, band: 'cold' });
    expect(scoreEngagement(counts({ machineOnly: 4 }), now)).toEqual({ score: 0, band: 'cold' });
  });

  it('uses a click from someone behind a proxy, and does not hold hidden opens against them', () => {
    const { score, band } = scoreEngagement(
      counts({ machineOnly: 9, humanClicked: 1, humanOpened: 1, lastEngagedAt: now }),
      now,
    );
    expect(band).toBe('very_engaged');
    expect(score).toBe(85);
  });

  it('rewards recent, regular reading and clicks', () => {
    const reader = counts({ humanOpened: 10, humanClicked: 5, lastEngagedAt: now });
    expect(scoreEngagement(reader, now)).toEqual({ score: 100, band: 'very_engaged' });
    const steady = counts({ humanOpened: 5, lastEngagedAt: now - 10 * DAY });
    expect(scoreEngagement(steady, now)).toEqual({ score: 53, band: 'engaged' });
    const fading = counts({ humanOpened: 1, lastEngagedAt: now - 70 * DAY });
    expect(scoreEngagement(fading, now)).toEqual({ score: 12, band: 'slipping' });
  });

  it('never leaves 0 to 100', () => {
    const odd = counts({ sent: 3, humanOpened: 9, humanClicked: 9, lastEngagedAt: now + DAY });
    expect(scoreEngagement(odd, now).score).toBe(100);
    const old = counts({ humanOpened: 0, lastEngagedAt: now - 400 * DAY });
    expect(scoreEngagement(old, now).score).toBe(0);
  });
});
