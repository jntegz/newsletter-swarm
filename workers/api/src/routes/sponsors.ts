// Sponsor Match (flag sponsor_match; docs/sponsor-match.md): a publication's sponsor page, what it
// sells, and the bookings that come in. Sponsors pay the publisher directly; nothing here charges.
import { createRoute, z } from '@hono/zod-openapi';
import { all, first, isUniqueViolation, toIso } from '@swarm/db';
import {
  CursorQuerySchema,
  SPONSOR_PATH,
  SponsorBookingSchema,
  SponsorSettingsSchema,
  UpdateSponsorBookingSchema,
  UpdateSponsorSettingsSchema,
  idPattern,
  newId,
  page,
  sponsorClickPath,
  type SponsorBooking,
  type SponsorSettings,
} from '@swarm/domain';
import {
  bumpCacheStatement,
  linksFor,
  mailAdapter,
  sendSponsorReportLink,
  signSponsorReport,
} from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { createRouter, env, type AppContext } from '../lib/context';
import { errors, idParam, jsonBody, ok } from '../lib/openapi';
import { audit, requireFlag, siteConfig, siteOrigin } from '../lib/site';

export const sponsors = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const bookingParams = channelParam.extend(idParam('bookingId', idPattern('sponsorBooking')).shape);
const TAGS = ['Sponsor Match'];

async function enter(c: AppContext, channelId: string, role: 'viewer' | 'editor' | 'admin') {
  const access = await requireChannel(c, channelId, role);
  await requireFlag(c, access, 'sponsor_match', 'Sponsor Match is not turned on.');
  return access;
}

async function readSettings(c: AppContext, channelId: string): Promise<SponsorSettings> {
  const db = env(c).DB;
  const [settings, slots, { origin }] = await Promise.all([
    first<{ accepting: number; headline: string; pitch: string }>(
      db,
      'SELECT accepting, headline, pitch FROM sponsor_settings WHERE channel_id = ?1',
      channelId,
    ),
    all<{ id: string; name: string; description: string; amount: number; currency: string }>(
      db,
      `SELECT id, name, description, amount, currency FROM sponsor_slots
        WHERE channel_id = ?1 AND archived_at IS NULL ORDER BY position`,
      channelId,
    ),
    siteOrigin(c, channelId),
  ]);
  return {
    accepting: settings?.accepting === 1,
    headline: settings?.headline ?? '',
    pitch: settings?.pitch ?? '',
    slots,
    url: new URL(SPONSOR_PATH, origin).toString(),
  };
}

sponsors.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/sponsor-settings',
    tags: TAGS,
    summary: 'The sponsor page and what it offers',
    request: { params: channelParam },
    responses: {
      200: ok(SponsorSettingsSchema, 'Settings'),
      ...errors('unauthorized', 'not_found', 'feature_disabled'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await enter(c, channelId, 'viewer');
    return c.json({ data: await readSettings(c, channelId) }, 200);
  },
);

sponsors.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/channels/{channelId}/sponsor-settings',
    tags: TAGS,
    summary: 'Change the sponsor page and what it offers',
    request: { params: channelParam, body: jsonBody(UpdateSponsorSettingsSchema) },
    responses: {
      200: ok(SponsorSettingsSchema, 'Changed'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'feature_disabled'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const access = await enter(c, channelId, 'admin');
    const input = c.req.valid('json');
    const db = env(c).DB;
    const now = Date.now();
    const known = await all<{ id: string }>(
      db,
      'SELECT id FROM sponsor_slots WHERE channel_id = ?1 AND archived_at IS NULL',
      channelId,
    );
    const ids = new Set(known.map((slot) => slot.id));
    if (input.slots.some((slot) => slot.id && !ids.has(slot.id))) {
      throw new ApiError('invalid_input', 'That placement isn’t on this publication.');
    }
    if (input.accepting && input.slots.length === 0) {
      throw new ApiError('invalid_input', 'Add a placement before taking bookings.');
    }
    await db.batch([
      db
        .prepare(
          `INSERT INTO sponsor_settings (channel_id, accepting, headline, pitch, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (channel_id) DO UPDATE SET accepting = ?2, headline = ?3, pitch = ?4, updated_at = ?5`,
        )
        .bind(channelId, input.accepting ? 1 : 0, input.headline, input.pitch, now),
      db
        .prepare(
          `UPDATE sponsor_slots SET archived_at = ?1
            WHERE channel_id = ?2 AND archived_at IS NULL
              AND id NOT IN (SELECT value FROM json_each(?3))`,
        )
        .bind(now, channelId, JSON.stringify(input.slots.flatMap((s) => (s.id ? [s.id] : [])))),
      ...input.slots.map((slot, position) =>
        slot.id
          ? db
              .prepare(
                `UPDATE sponsor_slots SET name = ?1, description = ?2, amount = ?3, currency = ?4, position = ?5
                  WHERE id = ?6 AND channel_id = ?7`,
              )
              .bind(
                slot.name,
                slot.description ?? '',
                slot.amount,
                slot.currency,
                position,
                slot.id,
                channelId,
              )
          : db
              .prepare(
                `INSERT INTO sponsor_slots (id, channel_id, name, description, amount, currency, position)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
              )
              .bind(
                newId('sponsorSlot', now),
                channelId,
                slot.name,
                slot.description ?? '',
                slot.amount,
                slot.currency,
                position,
              ),
      ),
      bumpCacheStatement(db, channelId, now),
    ]);
    await audit(c, access, 'sponsor_settings.updated', 'channel', channelId);
    return c.json({ data: await readSettings(c, channelId) }, 200);
  },
);

interface BookingRow {
  id: string;
  channel_id: string;
  slot_id: string;
  slot_name: string;
  run_on: string;
  sponsor_name: string;
  sponsor_email: string;
  ad_title: string;
  ad_body: string;
  ad_url: string;
  status: SponsorBooking['status'];
  paid: number;
  clicks: number;
  created_at: number;
}

const BOOKING_SELECT = `SELECT b.*, s.name AS slot_name FROM sponsor_bookings b
  JOIN sponsor_slots s ON s.id = b.slot_id`;

async function toBooking(c: AppContext, row: BookingRow, origin: string): Promise<SponsorBooking> {
  const token = await signSponsorReport(linksFor(env(c)), {
    bookingId: row.id,
    channelId: row.channel_id,
  });
  return {
    id: row.id,
    channelId: row.channel_id,
    slotId: row.slot_id,
    slotName: row.slot_name,
    runOn: row.run_on,
    sponsorName: row.sponsor_name,
    sponsorEmail: row.sponsor_email,
    adTitle: row.ad_title,
    adBody: row.ad_body,
    adUrl: row.ad_url,
    status: row.status,
    paid: row.paid === 1,
    clicks: row.clicks,
    clickUrl: new URL(sponsorClickPath(row.id), origin).toString(),
    reportUrl: new URL(`/_swarm/sponsor/report/${token}`, origin).toString(),
    createdAt: toIso(row.created_at),
  };
}

sponsors.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/sponsor-bookings',
    tags: TAGS,
    summary: 'Bookings, newest first',
    request: { params: channelParam, query: CursorQuerySchema },
    responses: {
      200: ok(page(SponsorBookingSchema), 'Bookings'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'feature_disabled'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await enter(c, channelId, 'editor');
    const { cursor, limit } = c.req.valid('query');
    const rows = await all<BookingRow>(
      env(c).DB,
      `${BOOKING_SELECT} WHERE b.channel_id = ?1 AND (?2 IS NULL OR b.id < ?2)
        ORDER BY b.id DESC LIMIT ?3`,
      channelId,
      cursor ?? null,
      limit + 1,
    );
    const { origin } = await siteOrigin(c, channelId);
    const items = await Promise.all(rows.slice(0, limit).map((row) => toBooking(c, row, origin)));
    return c.json(
      { data: { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null } },
      200,
    );
  },
);

sponsors.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/channels/{channelId}/sponsor-bookings/{bookingId}',
    tags: TAGS,
    summary: 'Accept, decline or change a booking',
    description:
      'Only one booking can be accepted for a placement on a given day (409). Editing the ad is how a publisher applies their own rules for what they’ll run.',
    request: { params: bookingParams, body: jsonBody(UpdateSponsorBookingSchema) },
    responses: {
      200: ok(SponsorBookingSchema, 'Changed'),
      ...errors(
        'invalid_input',
        'unauthorized',
        'forbidden',
        'not_found',
        'conflict',
        'feature_disabled',
      ),
    },
  }),
  async (c) => {
    const { channelId, bookingId } = c.req.valid('param');
    const access = await enter(c, channelId, 'admin');
    const input = c.req.valid('json');
    const db = env(c).DB;
    try {
      const updated = await first<{ id: string }>(
        db,
        `UPDATE sponsor_bookings SET status = coalesce(?1, status), paid = coalesce(?2, paid),
                run_on = coalesce(?3, run_on), ad_title = coalesce(?4, ad_title),
                ad_body = coalesce(?5, ad_body), ad_url = coalesce(?6, ad_url), updated_at = ?7
          WHERE id = ?8 AND channel_id = ?9 RETURNING id`,
        input.status ?? null,
        input.paid === undefined ? null : input.paid ? 1 : 0,
        input.runOn ?? null,
        input.adTitle ?? null,
        input.adBody ?? null,
        input.adUrl ?? null,
        Date.now(),
        bookingId,
        channelId,
      );
      if (!updated) throw new ApiError('not_found', 'Booking not found.');
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError('conflict', 'Another sponsor already has this placement on that day.');
      }
      throw error;
    }
    await audit(c, access, 'sponsor_booking.updated', 'sponsor_booking', bookingId, {
      fields: Object.keys(input).sort(),
    });
    const row = await first<BookingRow>(db, `${BOOKING_SELECT} WHERE b.id = ?1`, bookingId);
    const { origin } = await siteOrigin(c, channelId);
    return c.json({ data: await toBooking(c, row!, origin) }, 200);
  },
);

sponsors.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/sponsor-bookings/{bookingId}/report-link',
    tags: TAGS,
    summary: 'Email the sponsor a new report link',
    description:
      'Sends the booking’s sponsor contact a fresh link to their report, good for 90 days. At most once every 10 minutes per booking (429). Nothing is sent to an address that was erased or suppressed (409).',
    request: { params: bookingParams },
    responses: {
      200: ok(z.object({ sent: z.literal(true) }), 'Sent'),
      ...errors(
        'unauthorized',
        'forbidden',
        'not_found',
        'conflict',
        'rate_limited',
        'feature_disabled',
      ),
    },
  }),
  async (c) => {
    const { channelId, bookingId } = c.req.valid('param');
    const access = await enter(c, channelId, 'admin');
    const e = env(c);
    const outcome = await sendSponsorReportLink(
      {
        db: e.DB,
        mail: mailAdapter(e, e.PLATFORM_MAIL_DOMAIN),
        links: linksFor(e),
        site: siteConfig(c),
        platformMailDomain: e.PLATFORM_MAIL_DOMAIN,
      },
      { channelId, bookingId },
    );
    if (outcome === 'not_found') throw new ApiError('not_found', 'Booking not found.');
    if (outcome === 'rate_limited') {
      throw new ApiError(
        'rate_limited',
        'A link went to this sponsor a moment ago. Try again later.',
      );
    }
    if (outcome === 'not_mailable') {
      throw new ApiError('conflict', 'This sponsor’s address can’t be emailed.');
    }
    await audit(c, access, 'sponsor_booking.report_link_sent', 'sponsor_booking', bookingId);
    return c.json({ data: { sent: true as const } }, 200);
  },
);
