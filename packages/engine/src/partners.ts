// Partner Exchange and Sponsor Match helpers shared by the api, site and capture workers.
import { PARTNER_PICKS_SHOWN } from '@swarm/domain';
import { all } from './db';
import { sameTenant, type LinkSigner, type LinkVerifier } from './links';

const REPORT_PURPOSE = 'sponsor-report';

/**
 * A sponsor's report link (SPONSOR_REPORT_SIGNING_KEYS: the api and jobs sign, the site verifies;
 * links signed with SITE_LINK_SIGNING_KEYS before it existed still verify). It lives 90
 * days, the longest any link may (365 before the cutover), so the api shows a fresh one with every
 * booking, and the sponsor can be emailed a new one (sponsor-report-links.ts).
 */
export const signSponsorReport = (
  links: LinkSigner,
  booking: { bookingId: string; channelId: string },
  now: number = Date.now(),
) => links.sign(REPORT_PURPOSE, { b: booking.bookingId, c: booking.channelId }, { now });

/** The booking a report link names, if it is for this Channel; null otherwise. */
export async function readSponsorReport(
  links: LinkVerifier,
  token: string,
  channelId: string,
): Promise<string | null> {
  if (token.length > 1024) return null;
  const verified = await links.verify<{ b?: unknown; c?: unknown }>(REPORT_PURPOSE, token);
  if (!verified.ok || !sameTenant(verified.payload.c, channelId)) return null;
  return typeof verified.payload.b === 'string' ? verified.payload.b : null;
}

export interface ShownPick {
  id: string;
  name: string;
  description: string;
}

/** The first few picks for one surface, in the publisher's order. */
export function partnerPicksFor(
  db: D1Database,
  channelId: string,
  surface: 'site' | 'signup',
  limit: number = PARTNER_PICKS_SHOWN,
): Promise<ShownPick[]> {
  const column = surface === 'site' ? 'on_site' : 'on_signup';
  return all<ShownPick>(
    db,
    `SELECT id, name, description FROM partner_picks
      WHERE channel_id = ?1 AND ${column} = 1 ORDER BY position, id LIMIT ?2`,
    channelId,
    limit,
  );
}
