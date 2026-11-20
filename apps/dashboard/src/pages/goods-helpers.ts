// Pure helpers for the Goods page, kept free of React so they can be unit tested.
import type { CreateGood, Good, GoodOrderStatus, GoodStatus } from '@swarm/domain';
import { parseAmount } from '../money/helpers';

interface PriceDraft {
  id?: string;
  name: string;
  amount: string;
  currency: string;
}

interface FileDraft {
  mediaId: string;
  name: string;
}

export interface GoodDraft {
  name: string;
  slug: string;
  description: string;
  licenseKeys: boolean;
  prices: PriceDraft[];
  files: FileDraft[];
}

export const GOOD_STATUS_LABEL: Record<GoodStatus, string> = {
  draft: 'Draft',
  published: 'On sale',
  archived: 'Archived',
};

export const ORDER_STATUS_LABEL: Record<GoodOrderStatus, string> = {
  pending: 'Waiting for payment',
  paid: 'Paid',
  refunded: 'Refunded',
  disputed: 'Disputed',
};

export const slugFrom = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

export const emptyDraft = (currency: string): GoodDraft => ({
  name: '',
  slug: '',
  description: '',
  licenseKeys: false,
  prices: [{ name: 'Standard', amount: '', currency }],
  files: [],
});

/** The amounts in a draft as the API wants them, or the message saying what to fix. */
export function draftInput(draft: GoodDraft): { input: CreateGood } | { error: string } {
  const prices: NonNullable<CreateGood['prices']> = [];
  for (const price of draft.prices) {
    const amount = parseAmount(price.amount, price.currency);
    if (amount === null) return { error: `Enter an amount for “${price.name || 'this price'}”.` };
    prices.push({
      ...(price.id ? { id: price.id } : {}),
      name: price.name.trim(),
      amount,
      currency: price.currency,
    });
  }
  return {
    input: {
      name: draft.name.trim(),
      slug: draft.slug.trim(),
      description: draft.description.trim(),
      licenseKeys: draft.licenseKeys,
      prices,
      files: draft.files.map((f) => ({ mediaId: f.mediaId, name: f.name.trim() })),
    },
  };
}

/** A button for a post, with the product's lowest price when it has one. */
export function productButton(good: Good, price: string | null) {
  return { label: price ? `Buy ${good.name}: ${price}` : `Buy ${good.name}`, href: good.url };
}
