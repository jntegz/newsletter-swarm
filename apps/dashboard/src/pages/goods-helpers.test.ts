import type { Good } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { draftInput, emptyDraft, productButton, slugFrom } from './goods-helpers';

describe('goods helpers', () => {
  it('makes an address from a name', () => {
    expect(slugFrom('  The Field Guide: 2nd Édition! ')).toBe('the-field-guide-2nd-edition');
  });

  it('turns a typed amount into minor units', () => {
    const draft = { ...emptyDraft('usd'), name: ' Guide ', slug: 'guide' };
    draft.prices[0]!.amount = '9.50';
    const result = draftInput(draft);
    expect(result).toMatchObject({
      input: { name: 'Guide', prices: [{ name: 'Standard', amount: 950, currency: 'usd' }] },
    });
  });

  it('says which price needs fixing', () => {
    const draft = emptyDraft('usd');
    draft.prices[0]!.amount = 'cheap';
    expect(draftInput(draft)).toEqual({ error: 'Enter an amount for “Standard”.' });
  });

  it('builds a button for a post', () => {
    const good = { name: 'Guide', url: 'https://x.test/goods/guide' } as Good;
    expect(productButton(good, '$9')).toEqual({
      label: 'Buy Guide: $9',
      href: 'https://x.test/goods/guide',
    });
    expect(productButton(good, null).label).toBe('Buy Guide');
  });
});
