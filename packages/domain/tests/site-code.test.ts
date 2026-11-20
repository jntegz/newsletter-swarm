// Known tracking tools in website code (p8-site-code.ts): what asks the owner to confirm that a
// tool marked strictly necessary really is.
import { describe, expect, it } from 'vitest';
import {
  KNOWN_TRACKERS,
  necessaryTrackerProblem,
  trackersIn,
  type SiteCodeEntry,
} from '../src/p8-site-code';

const custom = (value: string, category: SiteCodeEntry['category'] = 'necessary') =>
  ({ name: 'Mine', preset: 'custom', category, value }) satisfies SiteCodeEntry;

describe('trackersIn', () => {
  it('finds the presets that track, and not the cookieless ones', () => {
    const preset = (p: SiteCodeEntry['preset'], value: string) => trackersIn({ preset: p, value });
    expect(preset('google_analytics', 'G-ABC123DEF4')).toEqual(['Google Analytics']);
    expect(preset('google_tag_manager', 'GTM-ABC123')).toEqual(['Google Tag Manager']);
    expect(preset('meta_pixel', '123456789')).toEqual(['Meta Pixel']);
    expect(preset('plausible', 'news.example.com')).toEqual([]);
    expect(preset('fathom', 'ABCDEFG')).toEqual([]);
    expect(preset('verification', '<meta name="x" content="google-analytics.com">')).toEqual([]);
  });

  it('finds tools pasted as code, in any case', () => {
    expect(
      trackersIn(custom('<script src="https://static.hotjar.com/c/hotjar-1.js"></script>')),
    ).toEqual(['Hotjar']);
    expect(trackersIn(custom('<SCRIPT SRC="https://www.CLARITY.ms/tag/abc"></SCRIPT>'))).toEqual([
      'Microsoft Clarity',
    ]);
    expect(
      trackersIn(
        custom(
          '<script>ttq.load("X")</script><script src="https://snap.licdn.com/li.lms-analytics/insight.min.js"></script>',
        ),
      ),
    ).toEqual(['TikTok Pixel', 'LinkedIn Insight Tag']);
    expect(trackersIn(custom('<script>document.body.dataset.ready="1"</script>'))).toEqual([]);
  });

  it('has a name and something to match for every tool', () => {
    for (const tool of KNOWN_TRACKERS) {
      expect(tool.name).not.toBe('');
      expect(tool.match.length).toBeGreaterThan(0);
      for (const needle of tool.match) expect(needle).toBe(needle.toLowerCase());
    }
  });
});

describe('necessaryTrackerProblem', () => {
  const pixel = '<script src="https://connect.facebook.net/en_US/fbevents.js"></script>';

  it('asks only for a tool marked necessary and not yet confirmed', () => {
    expect(necessaryTrackerProblem(custom(pixel))).toMatch(/looks like Meta Pixel/);
    expect(necessaryTrackerProblem({ ...custom(pixel), necessaryConfirmed: true })).toBeNull();
    expect(necessaryTrackerProblem(custom(pixel, 'marketing'))).toBeNull();
    expect(necessaryTrackerProblem(custom('<script>1</script>'))).toBeNull();
  });
});
