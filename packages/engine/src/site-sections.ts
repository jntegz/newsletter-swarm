// Section analytics on website themes (docs/site-themes.md): one row per Channel, UTC day, section
// and variant in site_section_daily. The site worker adds a reach when a section's lazy beacon
// loads on a counted home page view; the capture worker adds a signup when the site's own form in
// a section is sent. Nothing about the reader is stored.
import { SECTION_ID_PATTERN, type SectionVariant } from '@swarm/domain';
import { analyticsDay } from './readers';

export interface SectionCount {
  channelId: string;
  sectionId: string;
  variant: SectionVariant;
  now?: number;
}

/** The section and variant a beacon or a form post names, or null when either isn't valid. */
export function sectionVariantOf(
  section: unknown,
  variant: unknown,
): { sectionId: string; variant: SectionVariant } | null {
  if (typeof section !== 'string' || !SECTION_ID_PATTERN.test(section)) return null;
  if (variant !== 'a' && variant !== 'b') return null;
  return { sectionId: section, variant };
}

/** +1 reached or +1 signups for a section's variant today. */
export function sectionCountStatement(
  db: D1Database,
  column: 'reached' | 'signups',
  count: SectionCount,
): D1PreparedStatement {
  // The column is one of two names fixed here, never input.
  const name = column === 'signups' ? 'signups' : 'reached';
  return db
    .prepare(
      `INSERT INTO site_section_daily (channel_id, day, section_id, variant, ${name})
       VALUES (?1, ?2, ?3, ?4, 1)
       ON CONFLICT (channel_id, day, section_id, variant) DO UPDATE SET ${name} = ${name} + 1`,
    )
    .bind(count.channelId, analyticsDay(count.now), count.sectionId, count.variant);
}
