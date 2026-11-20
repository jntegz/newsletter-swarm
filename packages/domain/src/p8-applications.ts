// Applications: other products a workspace connects (flag applications; docs/applications.md).
import { z } from '@hono/zod-openapi';
import { idPattern } from './ids';

const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));

const SLUG_FORMAT_TOKENS = ['publication', 'post', 'date', 'domain', 'random'] as const;
export const SLUG_FORMAT_DEFAULT = '{post}-{random}';
/** Shorthop's limit on a slug. */
export const SHORT_SLUG_MAX = 64;

export const SlugFormatSchema = z
  .string()
  .trim()
  .min(1, 'Set a format.')
  .max(64, 'Keep the format under 64 characters.')
  .regex(
    new RegExp(`^(?:[A-Za-z0-9_-]|\\{(?:${SLUG_FORMAT_TOKENS.join('|')})\\})+$`),
    'Use letters, digits, - and _, plus {publication}, {post}, {date}, {domain} and {random}.',
  );

export const ShorthopConnectionSchema = z
  .object({
    connected: z.boolean(),
    baseUrl: z.string().nullable(),
    /** The end of the key, to recognise it. The key itself never leaves the server. */
    last4: z.string().nullable(),
    slugFormat: z.string(),
    /** The short domain; null uses Shorthop's primary one. */
    domain: z.string().nullable(),
    updatedAt: z.iso.datetime().nullable(),
  })
  .openapi('ShorthopConnection');
export type ShorthopConnection = z.infer<typeof ShorthopConnectionSchema>;

const DomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'Use a domain like go.example.com.')
  .max(253);

export const ConnectShorthopSchema = z
  .object({
    baseUrl: z.url('Enter the address of your Shorthop.').max(300),
    apiKey: z.string().trim().min(8, 'Paste the API key.').max(300),
    slugFormat: SlugFormatSchema.default(SLUG_FORMAT_DEFAULT),
    domain: DomainSchema.nullable().optional(),
  })
  .openapi('ConnectShorthop');
export type ConnectShorthop = z.input<typeof ConnectShorthopSchema>;

export const UpdateShorthopSchema = z
  .object({
    slugFormat: SlugFormatSchema.optional(),
    domain: DomainSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .openapi('UpdateShorthop');
export type UpdateShorthop = z.infer<typeof UpdateShorthopSchema>;

/** What a writer's editor needs to know: no address or key. */
export const ShorthopStatusSchema = z
  .object({ connected: z.boolean(), slugFormat: z.string().nullable() })
  .openapi('ShorthopStatus');
export type ShorthopStatus = z.infer<typeof ShorthopStatusSchema>;

export const CreateShortLinkSchema = z
  .object({
    url: z.url('Use a full web address.').max(2048),
    /** The post it's for: fills {post}, and the same address in a post gets the same link. */
    dispatchId: id('dispatch').optional(),
  })
  .openapi('CreateShortLink');
export type CreateShortLink = z.infer<typeof CreateShortLinkSchema>;

export const ShortLinkSchema = z
  .object({ url: z.string(), shortUrl: z.string() })
  .openapi('ShortLink');
export type ShortLink = z.infer<typeof ShortLinkSchema>;

const slugWord = (text: string, max: number) =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');

interface SlugContext {
  publication: string;
  /** The post's subject; empty outside a post. */
  post: string;
  url: string;
  now: number;
  random: string;
}

/** The slug a format makes, always one Shorthop accepts: 1 to 64 of A-Z a-z 0-9 - _, alnum first. */
export function renderSlug(format: string, context: SlugContext): string {
  const host = new URL(context.url).hostname.replace(/^www\./, '');
  const values: Record<string, string> = {
    publication: slugWord(context.publication, 30),
    post: slugWord(context.post, 30),
    date: new Date(context.now).toISOString().slice(0, 10),
    domain: slugWord(host, 30),
    random: context.random,
  };
  const slug = format
    .replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '')
    .replace(/[^A-Za-z0-9_-]/g, '')
    // A token with nothing to say (no post yet) doesn't leave its separator behind.
    .replace(/([-_])[-_]+/g, '$1')
    .replace(/^[-_]+/, '')
    .slice(0, SHORT_SLUG_MAX)
    .replace(/[-_]+$/, '');
  return slug || context.random;
}
