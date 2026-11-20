// Partner Exchange and Sponsor Match (Phase 8, flags partner_exchange, sponsor_match), as direct
// deals: no shared network, and no money through Swarm. Tables: migrations/0046_partners_sponsors.sql.
import { z } from '@hono/zod-openapi';
import { idPattern } from './ids';
import { EmailSchema } from './schemas';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-27T12:00:00.000Z' });
const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));

const webUrl = (schemes: RegExp, message: string) =>
  z
    .string()
    .trim()
    .max(2048)
    .refine((value) => {
      try {
        return schemes.test(new URL(value).protocol);
      } catch {
        return false;
      }
    }, message);

export const PARTNERS_PATH = '/partners';
export const SPONSOR_PATH = '/sponsor';
export const partnerClickPath = (pickId: string, from: 'site' | 'signup') =>
  `/_swarm/partner/${pickId}?from=${from}`;
export const sponsorClickPath = (bookingId: string) => `/_swarm/sponsored/${bookingId}`;
export const MAX_PARTNER_PICKS = 24;
const MAX_SPONSOR_SLOTS = 10;
/** How many picks a signup step or homepage shows, so it stays a recommendation and not a list. */
export const PARTNER_PICKS_SHOWN = 4;

export const PartnerPickSchema = z
  .object({
    id: id('partnerPick'),
    channelId: id('channel'),
    name: z.string(),
    description: z.string(),
    url: z.string(),
    onSite: z.boolean(),
    onSignup: z.boolean(),
    siteClicks: z.number().int(),
    signupClicks: z.number().int(),
  })
  .openapi('PartnerPick');
export type PartnerPick = z.infer<typeof PartnerPickSchema>;

export const CreatePartnerPickSchema = z
  .object({
    name: z.string().trim().min(1, 'Name the publication.').max(80),
    description: z.string().trim().max(280).optional(),
    url: webUrl(/^https?:$/, 'Enter a web address starting with https://.'),
    onSite: z.boolean().optional(),
    onSignup: z.boolean().optional(),
  })
  .openapi('CreatePartnerPick');
export type CreatePartnerPick = z.infer<typeof CreatePartnerPickSchema>;

export const UpdatePartnerPickSchema = CreatePartnerPickSchema.partial()
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .openapi('UpdatePartnerPick');
export type UpdatePartnerPick = z.infer<typeof UpdatePartnerPickSchema>;

const SponsorSlotSchema = z
  .object({
    id: id('sponsorSlot'),
    name: z.string(),
    description: z.string(),
    amount: z.number().int(),
    currency: z.string().length(3),
  })
  .openapi('SponsorSlot');
export const SponsorSettingsSchema = z
  .object({
    accepting: z.boolean(),
    headline: z.string(),
    pitch: z.string(),
    slots: z.array(SponsorSlotSchema),
    /** The public page sponsors book from. */
    url: z.string(),
  })
  .openapi('SponsorSettings');
export type SponsorSettings = z.infer<typeof SponsorSettingsSchema>;

export const UpdateSponsorSettingsSchema = z
  .object({
    accepting: z.boolean(),
    headline: z.string().trim().max(120),
    pitch: z.string().trim().max(2000),
    /** Replaces the list. A slot left out is archived; its bookings stay. */
    slots: z
      .array(
        z.object({
          id: id('sponsorSlot').optional(),
          name: z.string().trim().min(1, 'Name the placement.').max(80),
          description: z.string().trim().max(280).optional(),
          amount: z.number().int().min(0).max(99_999_999),
          currency: z
            .string()
            .trim()
            .toLowerCase()
            .regex(/^[a-z]{3}$/, 'Use a three-letter currency code.'),
        }),
      )
      .max(MAX_SPONSOR_SLOTS),
  })
  .openapi('UpdateSponsorSettings');
export type UpdateSponsorSettings = z.infer<typeof UpdateSponsorSettingsSchema>;

const SPONSOR_BOOKING_STATUSES = ['requested', 'accepted', 'declined', 'canceled'] as const;
const SponsorBookingStatusSchema = z.enum(SPONSOR_BOOKING_STATUSES).openapi('SponsorBookingStatus');
export type SponsorBookingStatus = z.infer<typeof SponsorBookingStatusSchema>;

const AD_TITLE = z.string().trim().min(1, 'Add a headline.').max(120);
const AD_BODY = z.string().trim().max(280);
const AD_URL = webUrl(/^https:$/, 'Enter a web address starting with https://.');
const RUN_ON = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-27.')
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, 'That date does not exist.');

/** What a sponsor sends from the public page. */
export const SponsorRequestSchema = z.object({
  slotId: id('sponsorSlot'),
  runOn: RUN_ON,
  sponsorName: z.string().trim().min(1).max(120),
  sponsorEmail: EmailSchema,
  adTitle: AD_TITLE,
  adBody: AD_BODY,
  adUrl: AD_URL,
});
export const SponsorBookingSchema = z
  .object({
    id: id('sponsorBooking'),
    channelId: id('channel'),
    slotId: id('sponsorSlot'),
    slotName: z.string(),
    runOn: z.string(),
    sponsorName: z.string(),
    sponsorEmail: z.string(),
    adTitle: z.string(),
    adBody: z.string(),
    adUrl: z.string(),
    status: SponsorBookingStatusSchema,
    paid: z.boolean(),
    clicks: z.number().int(),
    /** What goes in the post: counts the click, then leads to the sponsor. */
    clickUrl: z.string(),
    /** A private page for the sponsor with their click count. */
    reportUrl: z.string(),
    createdAt: timestamp,
  })
  .openapi('SponsorBooking');
export type SponsorBooking = z.infer<typeof SponsorBookingSchema>;

export const UpdateSponsorBookingSchema = z
  .object({
    status: SponsorBookingStatusSchema.optional(),
    paid: z.boolean().optional(),
    runOn: RUN_ON.optional(),
    adTitle: AD_TITLE.optional(),
    adBody: AD_BODY.optional(),
    adUrl: AD_URL.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .openapi('UpdateSponsorBooking');
export type UpdateSponsorBooking = z.infer<typeof UpdateSponsorBookingSchema>;
