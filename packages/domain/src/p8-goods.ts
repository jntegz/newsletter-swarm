// Goods (Phase 8.6, flag goods): digital products sold through the publisher's own Stripe.
// Tables: migrations/0045_goods.sql. Docs: docs/goods.md.
import { z } from '@hono/zod-openapi';
import { idPattern } from './ids';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-27T12:00:00.000Z' });
const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));

const GOOD_STATUSES = ['draft', 'published', 'archived'] as const;
const GoodStatusSchema = z.enum(GOOD_STATUSES).openapi('GoodStatus');
export type GoodStatus = z.infer<typeof GoodStatusSchema>;

const GOOD_ORDER_STATUSES = ['pending', 'paid', 'refunded', 'disputed'] as const;
const GoodOrderStatusSchema = z.enum(GOOD_ORDER_STATUSES).openapi('GoodOrderStatus');
export type GoodOrderStatus = z.infer<typeof GoodOrderStatusSchema>;

const MAX_GOOD_PRICES = 10;
const MAX_GOOD_FILES = 20;
/** The smallest price, in minor units: card fees make less pointless. */
const MIN_GOOD_AMOUNT = 100;
/** Where a good lives on the publication's website: `/goods/<slug>`. */
export const GOODS_PATH = '/goods';
export const goodPath = (slug: string) => `${GOODS_PATH}/${slug}`;

const GoodSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and hyphens.');
const GoodNameSchema = z.string().trim().min(1, 'Name the product.').max(120);
const GoodDescriptionSchema = z.string().trim().max(5000);

const GoodPriceSchema = z
  .object({
    id: id('goodPrice'),
    name: z.string(),
    /** In minor units (cents). */
    amount: z.number().int(),
    currency: z.string().length(3),
  })
  .openapi('GoodPrice');
const GoodFileSchema = z
  .object({ id: id('goodFile'), mediaId: id('media'), name: z.string() })
  .openapi('GoodFile');
export const GoodSchema = z
  .object({
    id: id('good'),
    channelId: id('channel'),
    slug: z.string(),
    /** The product's page on the publication's website. */
    url: z.string(),
    name: z.string(),
    description: z.string(),
    status: GoodStatusSchema,
    /** Each order gets its own license key. */
    licenseKeys: z.boolean(),
    prices: z.array(GoodPriceSchema),
    files: z.array(GoodFileSchema),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('Good');
export type Good = z.infer<typeof GoodSchema>;

const GoodPriceInputSchema = z.object({
  /** An existing price to keep. Without it, a new price. */
  id: id('goodPrice').optional(),
  name: z.string().trim().min(1, 'Name the price.').max(80),
  amount: z.number().int().min(MIN_GOOD_AMOUNT, 'The smallest price is 1.00.').max(99_999_999),
  currency: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z]{3}$/, 'Use a three-letter currency code.'),
});

const GoodFileInputSchema = z.object({
  mediaId: id('media'),
  name: z.string().trim().min(1, 'Name the file.').max(120),
});

export const CreateGoodSchema = z
  .object({
    name: GoodNameSchema,
    slug: GoodSlugSchema,
    description: GoodDescriptionSchema.optional(),
    licenseKeys: z.boolean().optional(),
    prices: z.array(GoodPriceInputSchema).max(MAX_GOOD_PRICES).optional(),
    files: z.array(GoodFileInputSchema).max(MAX_GOOD_FILES).optional(),
  })
  .openapi('CreateGood');
export type CreateGood = z.infer<typeof CreateGoodSchema>;

export const UpdateGoodSchema = z
  .object({
    name: GoodNameSchema.optional(),
    slug: GoodSlugSchema.optional(),
    description: GoodDescriptionSchema.optional(),
    licenseKeys: z.boolean().optional(),
    /** Publishing needs at least one price and one file. */
    status: GoodStatusSchema.optional(),
    /** Replaces the list. A price left out is archived; past orders keep what they paid. */
    prices: z.array(GoodPriceInputSchema).max(MAX_GOOD_PRICES).optional(),
    /** Replaces the list. Buyers see the current files, including ones added later. */
    files: z.array(GoodFileInputSchema).max(MAX_GOOD_FILES).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .openapi('UpdateGood');
export type UpdateGood = z.infer<typeof UpdateGoodSchema>;

export const GoodOrderSchema = z
  .object({
    id: id('goodOrder'),
    channelId: id('channel'),
    goodId: id('good'),
    goodName: z.string(),
    priceName: z.string().nullable(),
    memberId: id('member').nullable(),
    email: z.string(),
    amount: z.number().int(),
    currency: z.string(),
    status: GoodOrderStatusSchema,
    licenseKey: z.string().nullable(),
    createdAt: timestamp,
    paidAt: timestamp.nullable(),
    endedAt: timestamp.nullable(),
  })
  .openapi('GoodOrder');
export type GoodOrder = z.infer<typeof GoodOrderSchema>;

/** The `data` of good.purchased and good.refunded. */
export const GoodOrderEventSchema = z
  .object({
    id: id('goodOrder'),
    channelId: id('channel'),
    goodId: id('good'),
    memberId: id('member').nullable(),
    email: z.string(),
    amount: z.number().int(),
    currency: z.string(),
    status: GoodOrderStatusSchema,
  })
  .openapi('WebhookGoodOrder');

/** What a license key is good for right now. */
export const GoodLicenseSchema = z
  .object({
    valid: z.boolean(),
    /** Null when the key doesn't exist. */
    goodId: id('good').nullable(),
    orderId: id('goodOrder').nullable(),
  })
  .openapi('GoodLicense');
