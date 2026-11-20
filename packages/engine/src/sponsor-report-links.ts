/**
 * Sponsor report links by email (Sponsor Match). A report link (partners.ts signSponsorReport)
 * lives 90 days since the link cutover; the ones issued before it lived 365 days and stop working
 * 90 days after it. So, once the cutover has happened, the jobs worker emails a fresh link to the
 * sponsor of every accepted booking that still runs or ran within the last 90 days
 * (reissueSponsorReportLinks), and an admin can send one from a booking at any time
 * (sendSponsorReportLink). `sponsor_bookings.report_link_sent_at` records the last one sent.
 */
import type { MailAdapter } from '@swarm/mail';
import type { EngineConfig, SiteOriginConfig } from './config';
import { all, first } from './db';
import type { LinkSigner } from './links';
import { memberMail } from './messages';
import { signSponsorReport } from './partners';
import { channelSiteOrigin } from './publishing';
import { resolveSender } from './start';
import { isSuppressedFor } from './suppressions';

const DAY_MS = 86_400_000;
/** How long a report link from before the cutover keeps working after it (LEGACY_ACCEPT_MAX). */
export const SPONSOR_LEGACY_LINK_DAYS = 90;
/** An admin can send the same booking's sponsor a link this often. */
export const SPONSOR_LINK_RESEND_MS = 10 * 60 * 1000;
/** Bookings mailed per run of the cron. */
const REISSUE_BATCH = 25;

export interface SponsorLinkDeps {
  db: D1Database;
  mail: MailAdapter;
  /** Signs the link (SPONSOR_REPORT_SIGNING_KEYS). */
  links: LinkSigner;
  site: SiteOriginConfig;
  platformMailDomain: string;
  now?: number;
}

interface BookingRow {
  id: string;
  channel_id: string;
  workspace_id: string;
  sponsor_email: string;
  sponsor_name: string;
  ad_title: string;
  run_on: string;
  channel_name: string;
  slug: string;
  branding_json: string;
}

const BOOKING = `SELECT b.id, b.channel_id, c.workspace_id, b.sponsor_email, b.sponsor_name, b.ad_title,
       b.run_on, c.name AS channel_name, c.slug, c.branding_json
  FROM sponsor_bookings b JOIN channels c ON c.id = b.channel_id
 WHERE c.deleted_at IS NULL`;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const accentOf = (brandingJson: string) => {
  try {
    const accent = (JSON.parse(brandingJson) as { accentColor?: unknown }).accentColor;
    return typeof accent === 'string' && /^#[0-9a-f]{6}$/i.test(accent) ? accent : '#6c4cf1';
  } catch {
    return '#6c4cf1';
  }
};

const dateOf = (at: number) =>
  new Date(at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

/** Mails one booking's sponsor a new link. False when the address can't or mustn't be mailed. */
async function mailLink(
  deps: SponsorLinkDeps,
  row: BookingRow,
  now: number,
  replacesUntil: number | null,
): Promise<boolean> {
  // An erased sponsor's row keeps only 'erased'; a suppressed address gets no mail.
  if (!EMAIL.test(row.sponsor_email)) return false;
  if (await isSuppressedFor(deps.db, row.workspace_id, row.channel_id, row.sponsor_email)) {
    return false;
  }
  const token = await signSponsorReport(
    deps.links,
    { bookingId: row.id, channelId: row.channel_id },
    now,
  );
  const { origin } = await channelSiteOrigin(deps.db, deps.site, row.channel_id);
  const url = new URL(`/_swarm/sponsor/report/${token}`, origin).toString();
  const config = { platformMailDomain: deps.platformMailDomain } as EngineConfig;
  const channel = { id: row.channel_id, slug: row.slug, name: row.channel_name };
  const sender = await resolveSender(deps.db, config, channel, null);
  const from = sender.problems.length
    ? { name: sender.name, address: `${row.slug}@${deps.platformMailDomain}` }
    : { name: sender.name, address: sender.address };
  const replyTo = sender.problems.length ? null : sender.replyTo;
  const body = memberMail({
    channelName: row.channel_name,
    accent: accentOf(row.branding_json),
    heading: 'Your sponsorship report',
    paragraphs: [
      `Here is a new link to the numbers for “${row.ad_title}” in ${row.channel_name} (${row.run_on}).`,
      replacesUntil === null
        ? 'The link works for 90 days. Ask the publisher for a new one any time.'
        : `The link you had before stops working on ${dateOf(replacesUntil)}. This one works for 90 days, and the publisher can send you a new one any time.`,
    ],
    button: { label: 'See your report', url },
    footnote:
      'You are receiving this because you sponsored this newsletter. Anyone with the link can see the report.',
  });
  await deps.mail.send({
    category: 'sponsor_report',
    from,
    to: row.sponsor_email,
    replyTo: replyTo ?? from.address,
    subject: `Your sponsorship report for ${row.channel_name}`,
    html: body.html,
    text: body.text,
    tags: { channel: row.channel_id, kind: 'sponsor_report' },
  });
  return true;
}

export type SponsorLinkOutcome = 'sent' | 'not_found' | 'rate_limited' | 'not_mailable';

/** An admin's "Send a new report link" on a booking of `channelId`. */
export async function sendSponsorReportLink(
  deps: SponsorLinkDeps,
  input: { channelId: string; bookingId: string },
): Promise<SponsorLinkOutcome> {
  const now = deps.now ?? Date.now();
  const row = await first<BookingRow>(
    deps.db,
    `${BOOKING} AND b.id = ?1 AND b.channel_id = ?2`,
    input.bookingId,
    input.channelId,
  );
  if (!row) return 'not_found';
  // Claimed first, so two clicks (or two admins) mail once.
  const claimed = await first(
    deps.db,
    `UPDATE sponsor_bookings SET report_link_sent_at = ?1
      WHERE id = ?2 AND (report_link_sent_at IS NULL OR report_link_sent_at <= ?3) RETURNING id`,
    now,
    row.id,
    now - SPONSOR_LINK_RESEND_MS,
  );
  if (!claimed) return 'rate_limited';
  return (await mailLink(deps, row, now, null)) ? 'sent' : 'not_mailable';
}

/**
 * After the link cutover at `cutoffMs`: emails a new link to the sponsor of each accepted booking
 * made before it whose day is no more than 90 days before it (so its 365-day link would otherwise
 * end early), once each. Stops once those links have ended anyway. Returns how many were mailed.
 */
export async function reissueSponsorReportLinks(
  deps: SponsorLinkDeps,
  cutoffMs: number,
  limit: number = REISSUE_BATCH,
): Promise<number> {
  const now = deps.now ?? Date.now();
  const until = cutoffMs + SPONSOR_LEGACY_LINK_DAYS * DAY_MS;
  if (now >= until) return 0;
  const since = new Date(cutoffMs - SPONSOR_LEGACY_LINK_DAYS * DAY_MS).toISOString().slice(0, 10);
  const due = await all<BookingRow>(
    deps.db,
    `${BOOKING} AND b.status = 'accepted' AND b.run_on >= ?1 AND b.created_at < ?2
        AND (b.report_link_sent_at IS NULL OR b.report_link_sent_at < ?2)
      ORDER BY b.run_on, b.id LIMIT ?3`,
    since,
    cutoffMs,
    limit,
  );
  let sent = 0;
  for (const row of due) {
    const claimed = await first(
      deps.db,
      `UPDATE sponsor_bookings SET report_link_sent_at = ?1
        WHERE id = ?2 AND (report_link_sent_at IS NULL OR report_link_sent_at < ?3) RETURNING id`,
      now,
      row.id,
      cutoffMs,
    );
    if (!claimed) continue;
    if (await mailLink(deps, row, now, until)) sent++;
  }
  return sent;
}
