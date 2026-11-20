// Redirects, evaluated before rendering: the Channel's own (site_redirects, exact path match), then
// trailing-slash normalisation ("/about/" → "/about"). Only GET and HEAD are redirected, and the
// platform's /_swarm routes are never shadowed.
import { first } from '@swarm/db';
import type { SiteChannel } from '../context';
import type { SiteEnv } from '../env';

interface RedirectTarget {
  location: string;
  status: 301 | 302 | 307 | 308;
}

const STATUSES = new Set([301, 302, 307, 308]);

/** A redirect target must be a same-site path or an https URL. */
function safeTarget(to: string): string | null {
  // Browsers strip tabs and newlines from a Location before parsing it, so "/<tab>/evil.example"
  // would turn protocol-relative; refuse control characters, whitespace and backslashes.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s\\]/.test(to)) return null;
  if (to.startsWith('/') && !to.startsWith('//')) return to;
  try {
    const url = new URL(to);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function findRedirect(
  env: SiteEnv,
  channel: SiteChannel,
  method: string,
  url: URL,
): Promise<RedirectTarget | null> {
  if (method !== 'GET' && method !== 'HEAD') return null;
  const path = url.pathname;
  if (path === '/_swarm' || path.startsWith('/_swarm/') || path.length > 512) return null;

  // Collapsing leading slashes too means a normalised Location can never be protocol-relative
  // ("//evil.example/" must not become "//evil.example").
  const trimmed = `/${path.replace(/^\/+/, '').replace(/\/+$/, '')}`;
  const row = await first<{ to_location: string; status_code: number }>(
    env.DB,
    `SELECT to_location, status_code FROM site_redirects
      WHERE channel_id = ?1 AND from_path IN (?2, ?3)
      ORDER BY from_path = ?2 DESC LIMIT 1`,
    channel.id,
    path,
    trimmed,
  );
  if (row) {
    const target = safeTarget(row.to_location);
    if (target && STATUSES.has(row.status_code)) {
      // Carry the query string over to a path target that has none of its own.
      const location =
        target.startsWith('/') && !target.includes('?') && url.search
          ? `${target}${url.search}`
          : target;
      if (location !== `${path}${url.search}`) {
        return { location, status: row.status_code as RedirectTarget['status'] };
      }
    }
  }
  if (trimmed !== path) return { location: `${trimmed}${url.search}`, status: 301 };
  return null;
}
