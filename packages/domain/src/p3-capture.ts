// Phase 3 schemas: Capture Forms (builder config, versions, stats, snippet) and attribution.
import { z } from '@hono/zod-openapi';
import { SourceSchema, type MemberSource } from './audience';
import { idPattern } from './ids';
import { CAPTURE_FORM_KINDS, SmartPromptPlacementSchema } from './p6-growth';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-27T12:00:00.000Z' });
const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));

// ---------------------------------------------------------------------------------------------
// Builder config

/** `email`, `first_name`, `last_name`, or a profile field as `field:<key>`. */
const FORM_FIELD_KEY = /^(email|first_name|last_name|field:[a-z][a-z0-9_]{0,39})$/;

const FormFieldSchema = z
  .object({
    key: z.string().regex(FORM_FIELD_KEY, 'Pick email, a name or a profile field.'),
    label: z.string().trim().min(1, 'Label the field.').max(80),
    placeholder: z.string().trim().max(80).optional(),
    required: z.boolean().default(false),
    /** How select fields are shown: a dropdown or radio buttons. Multi-select is always checkboxes. */
    display: z.enum(['dropdown', 'radio']).optional(),
  })
  .openapi('CaptureFormField');
export type FormField = z.infer<typeof FormFieldSchema>;

export const FORM_LAYOUTS = ['regular', 'slim'] as const;
export const FORM_PLACEMENTS = [
  'inline',
  'slide_in_left',
  'slide_in_right',
  'popup',
  'sticky_top',
  'sticky_bottom',
] as const;

/** A CSS selector chosen by the operator. Used with querySelector on the host page, never as markup. */
const SelectorSchema = z.string().trim().min(1).max(200);

export const FormTriggerSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('immediate') }),
    z.object({ type: z.literal('delay'), seconds: z.number().int().min(1).max(600) }),
    z.object({ type: z.literal('scroll'), percent: z.number().int().min(1).max(100) }),
    z.object({ type: z.literal('element_visible'), selector: SelectorSchema }),
    z.object({ type: z.literal('click'), selector: SelectorSchema }),
    z.object({
      type: z.literal('event'),
      name: z.string().regex(/^[A-Za-z0-9_:.-]{1,60}$/, 'Use letters, digits, dots and dashes.'),
    }),
    z.object({ type: z.literal('exit_intent') }),
    /** Predicts a leave from a fast upward scroll after reading part of the page (touch screens). */
    z.object({ type: z.literal('scroll_velocity') }),
  ])
  .openapi('CaptureFormTrigger');
export type FormTrigger = z.infer<typeof FormTriggerSchema>;

export const FormFrequencySchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('every_visit') }),
    z.object({ type: z.literal('once_per_days'), days: z.number().int().min(1).max(365) }),
  ])
  .openapi('CaptureFormFrequency');

const httpsUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Use a full https:// address.');

const FormSuccessSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('message'),
      message: z.string().trim().min(1).max(80, 'Keep the message to 80 characters.'),
    }),
    /** The Member is sent here with a signed reference (`swarm_member`), never their email. */
    z.object({ type: z.literal('redirect'), url: httpsUrl }),
  ])
  .openapi('CaptureFormSuccess');

/** `https://host[:port]`, or http://localhost for development. Normalised to the URL origin. */
const OriginSchema = z
  .string()
  .trim()
  .max(255)
  .transform((value, ctx) => {
    try {
      const url = new URL(value);
      const local = url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
      if ((url.protocol === 'https:' || local) && url.origin !== 'null') return url.origin;
    } catch {
      // fall through
    }
    ctx.addIssue({ code: 'custom', message: 'Use a site origin such as https://example.com.' });
    return z.NEVER;
  });

const FormThemeSchema = z
  .object({
    /** Falls back to the Channel's accent colour, then Swarm indigo. */
    accentColor: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i, 'Use a hex colour such as #6c4cf1.')
      .nullable(),
    mode: z.enum(['light', 'dark', 'auto']).default('auto'),
  })
  .openapi('CaptureFormTheme');

const FormCopySchema = z
  .object({
    heading: z.string().trim().max(120),
    body: z.string().trim().max(300),
    button: z.string().trim().min(1).max(40),
  })
  .openapi('CaptureFormCopy');

/**
 * Whether a signup through a form must confirm by email. A Channel that requires confirmation wins
 * over everything; otherwise the form's own setting, then the Channel default (on unless turned off).
 */
export function resolveDoubleOptIn(
  form: boolean | null,
  channel: { doubleOptIn?: unknown; requireConfirmation?: unknown },
): boolean {
  if (channel.requireConfirmation === true) return true;
  return form ?? channel.doubleOptIn !== false;
}

export const CaptureFormConfigSchema = z
  .object({
    fields: z.array(FormFieldSchema).min(1).max(12),
    consent: z
      .object({ text: z.string().trim().min(1).max(1000), required: z.boolean() })
      .nullable()
      .default(null),
    layout: z.enum(FORM_LAYOUTS),
    placement: z.enum(FORM_PLACEMENTS),
    trigger: FormTriggerSchema,
    frequency: FormFrequencySchema,
    success: FormSuccessSchema,
    /** null follows the Channel's default (double opt-in is on unless the Channel turns it off). */
    doubleOptIn: z.boolean().nullable().default(null),
    theme: FormThemeSchema,
    /** Sites allowed to embed the form. Empty means any site. */
    allowedOrigins: z.array(OriginSchema).max(20).default([]),
    copy: FormCopySchema,
    /** Rosters a sign-up joins (rosters flag; docs/rosters.md). Absent means none. */
    rosterIds: z
      .array(id('roster'))
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length, 'Pick each Roster once.')
      .optional(),
  })
  .superRefine((config, ctx) => {
    const keys = config.fields.map((f) => f.key);
    const email = config.fields.filter((f) => f.key === 'email');
    if (email.length !== 1) {
      ctx.addIssue({ code: 'custom', path: ['fields'], message: 'Include the email field once.' });
    } else if (!email[0]!.required) {
      ctx.addIssue({ code: 'custom', path: ['fields'], message: 'The email field is required.' });
    }
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: 'custom', path: ['fields'], message: 'Use each field once.' });
    }
  })
  .openapi('CaptureFormConfig');
export type CaptureFormConfig = z.infer<typeof CaptureFormConfigSchema>;

export function defaultCaptureFormConfig(): CaptureFormConfig {
  return {
    fields: [{ key: 'email', label: 'Email', placeholder: 'you@example.com', required: true }],
    consent: null,
    layout: 'regular',
    placement: 'inline',
    trigger: { type: 'immediate' },
    frequency: { type: 'every_visit' },
    success: { type: 'message', message: 'Check your inbox to confirm.' },
    doubleOptIn: null,
    theme: { accentColor: null, mode: 'auto' },
    allowedOrigins: [],
    copy: { heading: 'Join the list', body: '', button: 'Join' },
  };
}

// ---------------------------------------------------------------------------------------------
// Capture Forms

const CAPTURE_FORM_STATUSES = ['draft', 'published', 'archived'] as const;

export const CaptureFormSchema = z
  .object({
    id: id('captureForm'),
    channelId: id('channel'),
    name: z.string(),
    /** 'prompt' is a Smart Prompt (flag smart_prompts): shown by the site at `placement`. */
    kind: z.enum(CAPTURE_FORM_KINDS),
    placement: SmartPromptPlacementSchema.nullable(),
    status: z.enum(CAPTURE_FORM_STATUSES),
    /** The published version number; 0 before the first publish. */
    version: z.number().int(),
    draft: CaptureFormConfigSchema,
    published: CaptureFormConfigSchema.nullable(),
    hasUnpublishedChanges: z.boolean(),
    publishedAt: timestamp.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('CaptureForm');
export type CaptureForm = z.infer<typeof CaptureFormSchema>;

export const CreateCaptureFormSchema = z
  .object({
    name: z.string().trim().min(1, 'Name the form.').max(80),
    config: CaptureFormConfigSchema.optional(),
    /** Fixed once created. A 'prompt' needs a placement and the smart_prompts flag. */
    kind: z.enum(CAPTURE_FORM_KINDS).default('form'),
    placement: SmartPromptPlacementSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'prompt' && !value.placement) {
      ctx.addIssue({ code: 'custom', path: ['placement'], message: 'Say where the prompt shows.' });
    }
    if (value.kind === 'form' && value.placement) {
      ctx.addIssue({
        code: 'custom',
        path: ['placement'],
        message: 'Only Smart Prompts have a placement.',
      });
    }
  })
  .openapi('CreateCaptureForm');

export const UpdateCaptureFormSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    config: CaptureFormConfigSchema.optional(),
    /** Only to confirm it: the kind can't change. */
    kind: z.enum(CAPTURE_FORM_KINDS).optional(),
    /** Smart Prompts only; takes effect at once (it is not versioned). */
    placement: SmartPromptPlacementSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .openapi('UpdateCaptureForm');

export const CaptureFormVersionSchema = z
  .object({
    version: z.number().int(),
    config: CaptureFormConfigSchema,
    publishedBy: id('operator').nullable(),
    publishedAt: timestamp,
  })
  .openapi('CaptureFormVersion');

const CaptureFormDaySchema = z
  .object({
    day: z.string().openapi({ example: '2026-10-27' }),
    views: z.number().int(),
    submissions: z.number().int(),
    confirmed: z.number().int(),
  })
  .openapi('CaptureFormDay');

export const CaptureFormStatsSchema = z
  .object({
    days: z.array(CaptureFormDaySchema),
    totals: z.object({
      views: z.number().int(),
      submissions: z.number().int(),
      confirmed: z.number().int(),
    }),
    /** Confirmed Members per view, 0–1; null without views. */
    conversion: z.number().nullable(),
  })
  .openapi('CaptureFormStats');

export const CaptureFormSnippetSchema = z
  .object({
    version: z.number().int(),
    scriptUrl: z.url(),
    /** Subresource Integrity hash of the exact bytes served for this version. */
    integrity: z.string(),
    /** The script tag to paste. */
    script: z.string(),
    /** A plain HTML form that works without JavaScript. */
    noscript: z.string(),
    /** Optional site-wide first-touch attribution script. */
    attribution: z.string(),
  })
  .openapi('CaptureFormSnippet');

// ---------------------------------------------------------------------------------------------
// Attribution, as stored in members.source_json

type TouchKey =
  'utm_source' | 'utm_medium' | 'utm_campaign' | 'utm_term' | 'utm_content' | 'referrer';

/** The top-level keys keep the first touch; `current` holds the latest one. */
export type StoredSource = MemberSource & { current?: Pick<MemberSource, TouchKey> | undefined };

/** What the embed reports: the first touch (from attr.js) and the current page. */
export const AttributionInputSchema = z.object({
  first: SourceSchema.pick({
    utm_source: true,
    utm_medium: true,
    utm_campaign: true,
    utm_term: true,
    utm_content: true,
    referrer: true,
    first_url: true,
  })
    .partial()
    .optional(),
  current: SourceSchema.pick({
    utm_source: true,
    utm_medium: true,
    utm_campaign: true,
    utm_term: true,
    utm_content: true,
    referrer: true,
    current_url: true,
  })
    .partial()
    .optional(),
});
export type AttributionInput = z.infer<typeof AttributionInputSchema>;
