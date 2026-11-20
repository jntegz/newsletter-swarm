import { describe, expect, it } from 'vitest';
import { NAV, crumbsFor, visibleNav } from './nav';

const labels = (groups: ReturnType<typeof visibleNav>) => groups.map((g) => g.label);
const items = (groups: ReturnType<typeof visibleNav>) =>
  groups.flatMap((g) => g.items.map((i) => i.label));

describe('visibleNav', () => {
  it('keeps every group and item while the flags are on', () => {
    expect(visibleNav(() => true)).toEqual(NAV);
  });

  it('drops Apps, and Connect with it, when app_directory is off', () => {
    const nav = visibleNav(() => false);
    expect(items(nav)).not.toContain('Apps');
    expect(labels(nav)).not.toContain('Connect');
  });

  it('leaves items without a flag alone', () => {
    const nav = visibleNav(() => false);
    expect(items(nav)).toContain('Subscribers');
    expect(labels(nav)).toEqual(['Write', 'Audience', 'Grow', 'Earn', 'Publish']);
  });

  it('asks about the flag the item names', () => {
    const asked: string[] = [];
    visibleNav((flag) => {
      asked.push(flag);
      return false;
    });
    expect(asked).toEqual(['partner_exchange', 'goods', 'sponsor_match', 'app_directory']);
  });
});

describe('crumbsFor', () => {
  it('treats path parts named like Object.prototype members as unknown pages', () => {
    // The path is the address bar; a crumb must be words, never a built-in.
    for (const part of ['constructor', '__proto__', 'toString']) {
      expect(crumbsFor(`/settings/${part}`, undefined), part).toEqual([{ label: 'Settings' }]);
      expect(crumbsFor(`/channels/ch_1/${part}`, 'ch_1'), part).toEqual([
        { label: 'Publication settings' },
      ]);
    }
  });
});
