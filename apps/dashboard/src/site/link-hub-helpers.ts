// Pure helpers for Site Studio → Link Hub: link checks, schedule inputs and statuses, the preview's
// colours and click-through. Kept free of React so they can be unit tested.
import { hubLinkLive, hubLinkUrlProblem, type HubLink } from '@swarm/domain';

/** The problem with a link draft, or null when it can be saved (mirrors the API's checks). */
export function hubLinkProblem(draft: {
  title: string;
  url: string;
  startsAt: string;
  endsAt: string;
}): { field: 'title' | 'url' | 'endsAt'; message: string } | null {
  if (!draft.title.trim()) return { field: 'title', message: 'Give the link a title.' };
  if (draft.title.trim().length > 80) {
    return { field: 'title', message: 'Keep the title under 80 characters.' };
  }
  const url = draft.url.trim();
  if (!url) return { field: 'url', message: 'Add an address.' };
  const problem = hubLinkUrlProblem(url);
  if (problem) return { field: 'url', message: problem };
  const start = isoFromLocalInput(draft.startsAt);
  const end = isoFromLocalInput(draft.endsAt);
  if (start && end && Date.parse(start) >= Date.parse(end)) {
    return { field: 'endsAt', message: 'End after the start.' };
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** An ISO timestamp as a `datetime-local` value in the browser's time zone ('' for null). */
export function localInputValue(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A `datetime-local` value (browser time zone) as an ISO timestamp, or null when empty. */
export function isoFromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

type HubLinkStatus = 'live' | 'scheduled' | 'ended';

/** Whether a link shows at `now`, will show later, or has ended. */
export function hubLinkStatus(
  link: Pick<HubLink, 'startsAt' | 'endsAt'>,
  now: number,
): HubLinkStatus {
  const startsAt = link.startsAt ? Date.parse(link.startsAt) : null;
  const endsAt = link.endsAt ? Date.parse(link.endsAt) : null;
  if (hubLinkLive({ startsAt, endsAt }, now)) return 'live';
  return endsAt !== null && now >= endsAt ? 'ended' : 'scheduled';
}

/** Clicks per page view as a percentage string, or a dash when there were no views. */
export function clickThrough(clicks: number, views: number): string {
  if (views <= 0) return '—';
  const rate = (clicks / views) * 100;
  return `${rate >= 10 ? Math.round(rate) : rate.toFixed(1)}%`;
}

/**
 * The public site's colours for the preview (workers/site/src/render/theme.ts): the preview
 * shows the Channel's page, not the dashboard, so it uses the site's palette.
 */
export const SITE_PALETTE = {
  light: { page: '#fbfbfd', surface: '#ffffff', ink: '#0f0f12', sub: '#6b6b76', line: '#ececf2' },
  dark: { page: '#0f0f12', surface: '#17171c', ink: '#f4f3f8', sub: '#a2a2ad', line: '#2a2a33' },
} as const;

const DEFAULT_SITE_ACCENT = '#6c4cf1';

/** The Channel's accent when it is a valid #rrggbb, else the default (as the site does). */
export function siteAccent(accent: string | null | undefined): string {
  return accent && /^#[0-9a-f]{6}$/i.test(accent) ? accent.toLowerCase() : DEFAULT_SITE_ACCENT;
}

/** Readable text on the accent: white unless the accent is light (as the site's stylesheet). */
export function onAccent(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r ?? 0) + 0.7152 * lin(g ?? 0) + 0.0722 * lin(b ?? 0);
  return luminance > 0.45 ? '#0f0f12' : '#ffffff';
}
