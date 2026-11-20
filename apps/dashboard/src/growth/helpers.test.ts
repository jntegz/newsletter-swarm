import type { DispatchDocument, SmartPromptPlacement } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLACEMENT,
  describePlacement,
  formatMinutes,
  formatRate,
  funnelIsEmpty,
  journeyProblems,
  moveItem,
  nextVariantKey,
  normalizePlacement,
  rewardKinds,
  placementProblems,
  problemAt,
  splitTestBody,
  splitTestProblems,
  stageWidths,
  variantShare,
  weightShares,
  withoutSmartBlocks,
  type SplitTestDraft,
} from './helpers';

const doc = (text: string): DispatchDocument => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const subjectDraft = (subjects: string[]): SplitTestDraft => ({
  variable: 'subject',
  variants: subjects.map((subject) => ({ subject, preheader: '', content: null })),
  testPercent: 20,
  metric: 'opens',
  windowMinutes: 120,
});

describe('split test variants', () => {
  it('accepts two to four variants with subjects', () => {
    expect(splitTestProblems(subjectDraft(['Hello']))).toEqual([]);
    expect(splitTestProblems(subjectDraft(['B', 'C', 'D']))).toEqual([]);
  });

  it('refuses too many variants, missing and repeated subjects', () => {
    expect(problemAt(splitTestProblems(subjectDraft(['B', 'C', 'D', 'E'])), 'variants')).toMatch(
      /2 to 4/,
    );
    expect(problemAt(splitTestProblems(subjectDraft(['  '])), 'variants.1.subject')).toMatch(
      /variant B a subject/,
    );
    expect(problemAt(splitTestProblems(subjectDraft(['Same', 'same'])), 'variants.2')).toMatch(
      /repeats/,
    );
  });

  it('checks the percentage and the window', () => {
    const problems = splitTestProblems({
      ...subjectDraft(['B']),
      testPercent: 2,
      windowMinutes: 5,
    });
    expect(problems.map((p) => p.path)).toEqual(['testPercent', 'windowMinutes']);
  });

  it('needs content without Smart Blocks for content tests', () => {
    const draft: SplitTestDraft = {
      ...subjectDraft([]),
      variable: 'content',
      variants: [
        { subject: '', preheader: '', content: null },
        {
          subject: '',
          preheader: '',
          content: { type: 'doc', content: [{ type: 'smartBlock', attrs: {}, content: [] }] },
        },
      ],
    };
    const problems = splitTestProblems(draft);
    expect(problemAt(problems, 'variants.1.content')).toMatch(/content/);
    expect(problemAt(problems, 'variants.2.content')).toMatch(/Only variant A/);
  });

  it('sends variant A as an empty object', () => {
    expect(splitTestBody(subjectDraft([' New subject '])).variants).toEqual([
      {},
      { subject: 'New subject' },
    ]);
    const content = splitTestBody({
      ...subjectDraft([]),
      variable: 'content',
      variants: [{ subject: 'x', preheader: 'y', content: doc('B') }],
    });
    expect(content.variants).toEqual([{}, { content: doc('B') }]);
  });

  it('copies the Dispatch for a content variant without its Smart Blocks', () => {
    const inner = { type: 'paragraph', content: [{ type: 'text', text: 'Paid only' }] };
    expect(
      withoutSmartBlocks({
        type: 'doc',
        content: [{ type: 'paragraph' }, { type: 'smartBlock', attrs: {}, content: [inner] }],
      }),
    ).toEqual({ type: 'doc', content: [{ type: 'paragraph' }, inner] });
  });

  it('shows shares and windows in plain words', () => {
    expect(variantShare(20, 2)).toBe(10);
    expect(variantShare(10, 3)).toBe(3.3);
    expect(formatMinutes(120)).toBe('2 h');
    expect(formatMinutes(1530)).toBe('1 day 1 h 30 min');
  });
});

describe('smart prompt placement', () => {
  const at = (patch: Partial<SmartPromptPlacement>): SmartPromptPlacement => ({
    ...DEFAULT_PLACEMENT,
    ...patch,
  });

  it('accepts the default and simple globs', () => {
    expect(placementProblems(DEFAULT_PLACEMENT)).toEqual([]);
    expect(placementProblems(at({ paths: ['/p/*', '/about'] }))).toEqual([]);
  });

  it('refuses bad paths, scroll and delay values, and Gate prompts for everyone', () => {
    expect(placementProblems(at({ paths: ['p/*'] }))[0]?.path).toBe('placement.paths.0');
    expect(placementProblems(at({ paths: ['//evil'] }))[0]?.path).toBe('placement.paths.0');
    expect(placementProblems(at({ value: 0 }))[0]?.path).toBe('placement.value');
    expect(placementProblems(at({ trigger: 'delay', value: undefined }))[0]?.path).toBe(
      'placement.value',
    );
    expect(placementProblems(at({ trigger: 'gate_hit', readers: 'everyone' }))[0]?.path).toBe(
      'placement.readers',
    );
    expect(placementProblems(at({ cooldownDays: 400 }))[0]?.path).toBe('placement.cooldownDays');
  });

  it('drops the value for triggers without one, and blank paths', () => {
    expect(normalizePlacement(at({ trigger: 'exit_intent', paths: [' /a ', ''] }))).toEqual({
      trigger: 'exit_intent',
      paths: ['/a'],
      readers: 'anonymous',
      cooldownDays: 7,
    });
  });

  it('describes a placement', () => {
    expect(describePlacement(DEFAULT_PLACEMENT)).toBe(
      'At 50% scroll · every page · readers who are not subscribers',
    );
  });
});

describe('signup journeys', () => {
  it('checks keys, weights and steps', () => {
    expect(journeyProblems([{ key: 'a', weight: 50, steps: [{ kind: 'upsell' }] }])).toEqual([]);
    const problems = journeyProblems([
      { key: 'a', weight: 0, steps: [] },
      { key: 'a', weight: 10, steps: [{ kind: 'welcome', headline: ' ' }] },
    ]);
    expect(problems.map((p) => p.path)).toEqual([
      'variants.0.weight',
      'variants.0.steps',
      'variants.1.key',
      'variants.1.steps.0.headline',
    ]);
  });

  it('shares and keys', () => {
    expect(weightShares([{ weight: 1 }, { weight: 3 }])).toEqual([25, 75]);
    expect(nextVariantKey(['a', 'b'])).toBe('c');
  });
});

describe('funnel rates', () => {
  it('formats rates, with a dash when there was nothing to convert', () => {
    expect(formatRate(null)).toBe('—');
    expect(formatRate(0)).toBe('0%');
    expect(formatRate(0.5)).toBe('50%');
    expect(formatRate(0.12345)).toBe('12.3%');
    expect(formatRate(0.0004)).toBe('<0.1%');
    expect(formatRate(Number.NaN)).toBe('—');
  });

  it('sizes bars against the largest stage and keeps tiny ones visible', () => {
    expect(stageWidths([200, 100, 1, 0])).toEqual([100, 50, 1, 0]);
    expect(stageWidths([0, 0])).toEqual([0, 0]);
  });

  it('knows an empty range', () => {
    const zero = { visits: 0, formViews: 0, subscribes: 0, confirms: 0, firstOpens: 0, paid: 0 };
    expect(funnelIsEmpty(zero)).toBe(true);
    expect(funnelIsEmpty({ ...zero, visits: 1 })).toBe(false);
  });
});

describe('moveItem', () => {
  it('moves and clamps', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, -5)).toEqual(['c', 'a', 'b']);
    expect(moveItem(['a'], 3, 0)).toEqual(['a']);
  });
});

describe('rewardKinds', () => {
  it('leaves Goods out while its flag is off', () => {
    expect(rewardKinds(false, undefined)).toEqual(['comp_level', 'coupon', 'manual']);
    expect(rewardKinds(false, 'manual')).not.toContain('goods');
  });

  it('offers Goods while its flag is on', () => {
    expect(rewardKinds(true, undefined)).toContain('goods');
  });

  it('keeps Goods for a reward that already is one', () => {
    expect(rewardKinds(false, 'goods')).toContain('goods');
  });
});
