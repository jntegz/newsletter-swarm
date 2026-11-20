// Rosters (Phase 8.1): several opt-in lists per Channel, flag rosters.
// Tables: migrations/0019_rosters.sql. Docs: docs/rosters.md.
// audience.ts imports the audience part from here, so this module imports nothing from it.
import { z } from '@hono/zod-openapi';
import { idPattern } from './ids';

const timestamp = z.iso.datetime().openapi({ example: '2026-10-28T12:00:00.000Z' });
const id = (kind: Parameters<typeof idPattern>[0]) => z.string().regex(idPattern(kind));

/** Live Rosters per Channel. */
export const ROSTERS_MAX = 100;
/** Rosters on each side of an audience, and on one Capture Form. */
const ROSTER_AUDIENCE_MAX = 20;

const ROSTER_STATUSES = ['subscribed', 'unsubscribed'] as const;
export const RosterStatusSchema = z.enum(ROSTER_STATUSES).openapi('RosterStatus');
export type RosterStatus = z.infer<typeof RosterStatusSchema>;

/** Who made a membership's last change. */
const ROSTER_SOURCES = ['operator', 'form', 'member', 'import', 'api', 'unsubscribe'] as const;
export const RosterSourceSchema = z.enum(ROSTER_SOURCES).openapi('RosterSource');
export type RosterSource = z.infer<typeof RosterSourceSchema>;
/** A Member who left through one of these can only be put back by themselves. */
export const MEMBER_LEFT_SOURCES: readonly RosterSource[] = ['member', 'unsubscribe'];

// ---------------------------------------------------------------------------------------------
// Rosters

export const RosterSchema = z
  .object({
    id: id('roster'),
    channelId: id('channel'),
    name: z.string(),
    description: z.string().nullable(),
    /** Listed in the Member Center, where Members join and leave it themselves. */
    memberCenter: z.boolean(),
    /** Members subscribed to it now (any Member status). */
    subscribedCount: z.number().int(),
    /** Of those, active Members: who a Broadcast to this Roster would reach before suppressions. */
    activeCount: z.number().int(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi('Roster');
export type Roster = z.infer<typeof RosterSchema>;

export const RosterListSchema = z.object({ items: z.array(RosterSchema) }).openapi('RosterList');

const name = z.string().trim().min(1, 'Name the Roster.').max(80);
const description = z.string().trim().max(500).nullable();

export const CreateRosterSchema = z
  .object({
    name,
    description: description.optional(),
    memberCenter: z.boolean().default(true),
  })
  .strict()
  .openapi('CreateRoster');
export type CreateRoster = z.input<typeof CreateRosterSchema>;

export const UpdateRosterSchema = z
  .object({
    name: name.optional(),
    description: description.optional(),
    memberCenter: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Change at least one field.')
  .openapi('UpdateRoster');
export type UpdateRoster = z.infer<typeof UpdateRosterSchema>;

// ---------------------------------------------------------------------------------------------
// Memberships

/** One Member's place on one Roster. */
const RosterMembershipSchema = z
  .object({
    rosterId: id('roster'),
    rosterName: z.string(),
    status: RosterStatusSchema,
    source: RosterSourceSchema,
    subscribedAt: timestamp.nullable(),
    unsubscribedAt: timestamp.nullable(),
    updatedAt: timestamp,
  })
  .openapi('RosterMembership');
export type RosterMembership = z.infer<typeof RosterMembershipSchema>;

export const MemberRostersSchema = z
  .object({ items: z.array(RosterMembershipSchema) })
  .openapi('MemberRosters');
export type MemberRosters = z.infer<typeof MemberRostersSchema>;

/** A row of a Roster's membership list. */
export const RosterMemberSchema = z
  .object({
    memberId: id('member'),
    email: z.string(),
    memberStatus: z.string(),
    status: RosterStatusSchema,
    source: RosterSourceSchema,
    subscribedAt: timestamp.nullable(),
    unsubscribedAt: timestamp.nullable(),
    updatedAt: timestamp,
  })
  .openapi('RosterMember');
export type RosterMember = z.infer<typeof RosterMemberSchema>;

export const RosterMembersQuerySchema = z.object({
  status: RosterStatusSchema.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const SetRosterMembershipSchema = z
  .object({ status: RosterStatusSchema })
  .strict()
  .openapi('SetRosterMembership');
// ---------------------------------------------------------------------------------------------
// Audiences

const ROSTER_CONFLICT_POLICIES = ['exclude_wins', 'include_wins'] as const;
const RosterConflictSchema = z.enum(ROSTER_CONFLICT_POLICIES).openapi('RosterConflict');
export type RosterConflict = z.infer<typeof RosterConflictSchema>;

/**
 * The Roster part of a Dispatch audience, combined with the Circle part by AND: subscribed to
 * an included Roster (anyone when none is included) and to no excluded one. `conflict` decides a
 * Member subscribed to both an included and an excluded Roster.
 */
export const RosterAudienceSchema = z
  .object({
    include: z.array(id('roster')).max(ROSTER_AUDIENCE_MAX),
    exclude: z.array(id('roster')).max(ROSTER_AUDIENCE_MAX),
    conflict: RosterConflictSchema.default('exclude_wins'),
  })
  .refine((a) => !a.include.some((r) => a.exclude.includes(r)), {
    message: 'A Roster can’t be both included and excluded.',
  })
  .openapi('RosterAudience');
export type RosterAudience = z.infer<typeof RosterAudienceSchema>;

export const hasRosters = (rosters: RosterAudience | null | undefined): rosters is RosterAudience =>
  !!rosters && (rosters.include.length > 0 || rosters.exclude.length > 0);

/** Counts for the Roster part of an audience, among active, unsuppressed Members right now. */
export const RosterOverlapSchema = z
  .object({
    /** Subscribed to at least one included Roster. */
    included: z.number().int(),
    /** Subscribed to at least one excluded Roster. */
    excluded: z.number().int(),
    /** Both: the Members the conflict policy decides. */
    conflicts: z.number().int(),
    /** Who the Roster part lets through under the chosen policy (Circles not applied). */
    recipients: z.number().int(),
  })
  .openapi('RosterOverlap');
export type RosterOverlap = z.infer<typeof RosterOverlapSchema>;
