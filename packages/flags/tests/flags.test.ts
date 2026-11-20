import { describe, expect, it } from 'vitest';
import {
  FLAG_KEYS,
  FLAG_REGISTRY,
  FlagService,
  resolveFlags,
  type FlagOverride,
} from '../src/index';

const context = { workspaceId: 'ws_1', channelId: 'ch_1' };

describe('registry', () => {
  it('registers every flag as off with a phase and description', () => {
    expect(FLAG_KEYS.length).toBeGreaterThan(0);
    for (const key of FLAG_KEYS) {
      const definition = FLAG_REGISTRY[key];
      expect(definition.description.length).toBeGreaterThan(0);
      expect(definition.phase).toBeGreaterThanOrEqual(0);
    }
    expect(Object.values(resolveFlags([], {})).every((value) => value === false)).toBe(true);
  });

  it('does not register options that were dropped from the plan', () => {
    for (const dropped of [
      'pulse',
      'relay',
      'live',
      'reader_accounts',
      'ai_detection',
      'copilot_summaries',
    ]) {
      expect(FLAG_KEYS).not.toContain(dropped);
    }
  });
});

describe('resolveFlags', () => {
  it('applies the most specific scope last', () => {
    const overrides: FlagOverride[] = [
      { key: 'gift_passes', scope: 'channel', scopeId: 'ch_1', enabled: false },
      { key: 'gift_passes', scope: 'platform', scopeId: null, enabled: true },
      { key: 'gift_passes', scope: 'workspace', scopeId: 'ws_1', enabled: true },
    ];
    expect(resolveFlags(overrides, context).gift_passes).toBe(false);
  });

  it('ignores overrides for other workspaces and channels', () => {
    const overrides: FlagOverride[] = [
      { key: 'pledges', scope: 'workspace', scopeId: 'ws_other', enabled: true },
      { key: 'pledges', scope: 'channel', scopeId: 'ch_other', enabled: true },
    ];
    expect(resolveFlags(overrides, context).pledges).toBe(false);
  });

  it('ignores unknown keys', () => {
    const values = resolveFlags(
      [{ key: 'pulse', scope: 'platform', scopeId: null, enabled: true }],
      context,
    );
    expect('pulse' in values).toBe(false);
  });
});

describe('FlagService', () => {
  it('reads through the store', async () => {
    const service = new FlagService({
      load: async () => [
        { key: 'founding_level', scope: 'platform', scopeId: null, enabled: true },
      ],
    });
    expect(await service.enabled('founding_level', context)).toBe(true);
    expect(await service.enabled('gift_passes', context)).toBe(false);
  });
});
