import type { SectionInstance } from '@swarm/site-themes';
import { testResult } from '@swarm/site-themes';
import { describe, expect, it } from 'vitest';
import type { DesignStats } from '../api/design';
import { duplicateSection } from './sections';
import {
  countsLine,
  endTest,
  formatRate,
  resultInWords,
  sectionCounts,
  startTest,
  testProblem,
  withVariantSettings,
} from './tests';

const NOW = Date.UTC(2026, 10, 9, 10);
const hero: SectionInstance = { id: 'hero-1', type: 'hero', settings: { heading: 'Hello' } };
const band: SectionInstance = { id: 'band-1', type: 'subscribe_band', settings: {} };

describe('A/B tests in the draft', () => {
  it('starts a test with B copied from A, and edits either', () => {
    const [started] = startTest([hero], 'hero-1', NOW);
    expect(started!.experiment).toEqual({
      id: `t${NOW.toString(36)}`,
      status: 'running',
      variantB: { heading: 'Hello' },
      startedAt: '2026-11-09T10:00:00.000Z',
    });
    // B is its own copy.
    expect(started!.experiment!.variantB).not.toBe(hero.settings);
    const [b] = withVariantSettings([started!], 'hero-1', 'b', (s) => ({ ...s, heading: 'Hi' }));
    expect(b!.settings.heading).toBe('Hello');
    expect(b!.experiment!.variantB.heading).toBe('Hi');
    const [a] = withVariantSettings([b!], 'hero-1', 'a', (s) => ({ ...s, heading: 'Hey' }));
    expect(a!.settings.heading).toBe('Hey');
    expect(a!.experiment!.variantB.heading).toBe('Hi');
  });

  it('ends a test: Use B copies B in, Keep A keeps A; both keep the test for its results', () => {
    const [running] = withVariantSettings(startTest([hero], 'hero-1', NOW), 'hero-1', 'b', () => ({
      heading: 'B wins',
    }));
    const [useB] = endTest([running!], 'hero-1', 'b', NOW + 1000);
    expect(useB!.settings).toEqual({ heading: 'B wins' });
    expect(useB!.experiment).toMatchObject({
      status: 'ended',
      winner: 'b',
      endedAt: '2026-11-09T10:00:01.000Z',
    });
    const [keepA] = endTest([running!], 'hero-1', 'a', NOW);
    expect(keepA!.settings).toEqual({ heading: 'Hello' });
    expect(keepA!.experiment).toMatchObject({ status: 'ended', winner: 'a' });
  });

  it('allows 3 running tests and one per section', () => {
    const many = ['a', 'b', 'c', 'd'].map((n) => ({ ...band, id: `band-${n}` }));
    let list = startTest(many, 'band-a', NOW);
    expect(testProblem(list, 'band-a')).toBe('A test is already running here.');
    list = startTest(startTest(list, 'band-b', NOW), 'band-c', NOW);
    expect(testProblem(list, 'band-d')).toBe('3 tests are running. End one to start another.');
    list = endTest(list, 'band-a', 'a', NOW);
    expect(testProblem(list, 'band-d')).toBeNull();
    // A new test replaces an ended one.
    expect(startTest(list, 'band-a', NOW + 5)[0]!.experiment?.status).toBe('running');
  });

  it('leaves a duplicated section without the test', () => {
    const { added } = duplicateSection(startTest([hero], 'hero-1', NOW), 'hero-1');
    expect(added?.experiment).toBeUndefined();
  });
});

describe('numbers in words', () => {
  const stats: DesignStats = {
    days: 30,
    from: '2026-10-11',
    to: '2026-11-09',
    sections: [
      { sectionId: 'hero-1', variant: 'a', reached: 1000, signups: 30 },
      { sectionId: 'hero-1', variant: 'b', reached: 204, signups: 8 },
    ],
    totals: { reached: 1204, signups: 38 },
    tests: [],
  };

  it('says what each section reached and signed up', () => {
    expect(countsLine(sectionCounts(stats, 'hero-1'), true, 30)).toBe(
      '1,204 reached · 38 signups · 3.2%',
    );
    expect(countsLine({ reached: 900, signups: 0 }, false, 30)).toBe('900 reached');
    expect(countsLine({ reached: 10, signups: 1 }, true, 7)).toBe('10 reached · 1 signup · 10.0%');
    expect(countsLine(sectionCounts(stats, 'band-1'), true, 7)).toBe(
      'Not reached in the last 7 days',
    );
    expect(formatRate(0)).toBe('0%');
    expect(formatRate(0.041)).toBe('4.1%');
  });

  it('says how a test stands', () => {
    expect(
      resultInWords(testResult({ reached: 4000, signups: 128 }, { reached: 4000, signups: 164 })),
    ).toBe('B is ahead: 4.1% against 3.2%, 96% sure');
    expect(
      resultInWords(testResult({ reached: 4000, signups: 164 }, { reached: 4000, signups: 128 })),
    ).toBe('A is ahead: 4.1% against 3.2%, 96% sure');
    expect(
      resultInWords(testResult({ reached: 1000, signups: 32 }, { reached: 1000, signups: 41 })),
    ).toBe('Not enough yet: about 4,700 more views to tell');
    expect(resultInWords(testResult({ reached: 0, signups: 0 }, { reached: 0, signups: 0 }))).toBe(
      'No views yet. Results show once the page is visited.',
    );
    expect(
      resultInWords(testResult({ reached: 300, signups: 0 }, { reached: 300, signups: 0 })),
    ).toBe('Not enough yet: no signups from either variant so far');
  });
});
