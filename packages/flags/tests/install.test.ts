import { describe, expect, it } from 'vitest';
import {
  FEATURES_OFF_AT_INSTALL,
  FEATURES_WITHOUT_A_GATE,
  FLAG_KEYS,
  FLAG_REGISTRY,
  isSwitchableFlag,
  resolveFlags,
  SWITCHABLE_FLAG_KEYS,
} from '../src/index';

describe('switchable features', () => {
  it('are exactly the flags decided as "build"', () => {
    const build = FLAG_KEYS.filter((key) => FLAG_REGISTRY[key].decision === 'build');
    expect(SWITCHABLE_FLAG_KEYS).toEqual(build);
    expect(build.length).toBeGreaterThan(0);
    for (const key of FLAG_KEYS) {
      expect(isSwitchableFlag(key)).toBe(FLAG_REGISTRY[key].decision === 'build');
    }
  });

  it('refuse deferred, undecided, dropped and unknown keys, and object internals', () => {
    for (const key of ['digest', 'site_comments', 'pulse', 'nope', 'constructor', '__proto__']) {
      expect(isSwitchableFlag(key)).toBe(false);
    }
  });
});

describe('FEATURES_OFF_AT_INSTALL', () => {
  it('holds Copilot, and only features someone can turn on', () => {
    expect(FEATURES_OFF_AT_INSTALL).toEqual(
      expect.arrayContaining(['copilot', 'copilot_byok', 'copilot_actions']),
    );
    for (const key of FEATURES_OFF_AT_INSTALL) expect(isSwitchableFlag(key)).toBe(true);
  });

  it('FEATURES_WITHOUT_A_GATE holds only switchable keys', () => {
    for (const key of FEATURES_WITHOUT_A_GATE) expect(isSwitchableFlag(key)).toBe(true);
  });

  it('does not change the code default: with no rows, every flag is off', () => {
    expect(Object.values(resolveFlags([], {})).every((value) => value === false)).toBe(true);
  });
});
