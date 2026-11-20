// Tenant resolution: which Channel a request is for, from its Host header only.
import { first } from '@swarm/db';
import { SECTION_ID_PATTERN, type SignupPath } from '@swarm/domain';
import { MAX_RUNNING_TESTS } from '@swarm/site-themes';
import type { SiteChannel } from './context';
import type { SiteEnv } from './env';

interface ChannelRow {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
  description: string | null;
  branding_json: string;
  layout: string | null;
  pinned_json: string | null;
  about_json: string | null;
  nav_json: string | null;
  seo_json: string | null;
  theme_json: string | null;
  ai_bots: string | null;
  expose_gated: number | null;
  prev_next_nav: number | null;
  cache_version: number | null;
  primary_host: string | null;
  settings_json: string;
  custom_css: string | null;
  design_version: number | null;
  design_tests: string | null;
}

const SELECT = `SELECT c.id, c.workspace_id, c.slug, c.name, c.description, c.branding_json, c.settings_json,
    s.layout, s.pinned_json, s.about_json, s.nav_json, s.seo_json, s.theme_json, s.ai_bots,
    s.expose_gated, s.prev_next_nav, s.cache_version, s.custom_css,
    (SELECT d.published_version FROM site_designs d
      WHERE d.channel_id = c.id AND d.published_json IS NOT NULL) AS design_version,
    (SELECT d.published_tests FROM site_designs d
      WHERE d.channel_id = c.id AND d.published_json IS NOT NULL) AS design_tests,
    (SELECT h.hostname FROM custom_hostnames h
      WHERE h.channel_id = c.id AND h.is_primary = 1 AND h.status = 'active' AND h.role = 'web') AS primary_host
  FROM channels c LEFT JOIN site_settings s ON s.channel_id = c.id`;

type Resolution =
  | { kind: 'channel'; channel: SiteChannel }
  /** A bare domain whose only job is to send visitors to the Channel's web hostname. */
  | { kind: 'redirect'; location: string }
  | { kind: 'unknown' };

function json<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** The published design's running A/B tests, by section id: at most 3, each a valid id. */
function designTests(value: string | null): string[] {
  const list = json<unknown>(value, []);
  if (!Array.isArray(list)) return [];
  return [
    ...new Set(
      list.filter((id): id is string => typeof id === 'string' && SECTION_ID_PATTERN.test(id)),
    ),
  ]
    .sort()
    .slice(0, MAX_RUNNING_TESTS);
}

function toChannel(row: ChannelRow, env: SiteEnv, host: string): SiteChannel {
  const port = host.includes(':') ? `:${host.split(':')[1]}` : '';
  const platform = `${row.slug}.${env.PLATFORM_SITE_DOMAIN}${env.SITE_SCHEME === 'http' ? port : ''}`;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    branding: json(row.branding_json, {}),
    origin: `${env.SITE_SCHEME}://${row.primary_host ?? platform}`,
    host,
    settings: {
      signupPath: json<{ signupPath?: SignupPath }>(row.settings_json, {}).signupPath ?? 'email',
      customCss: row.custom_css ?? '',
      layout: row.layout === 'newspaper' ? 'newspaper' : 'magazine',
      pinned: json(row.pinned_json, []),
      aboutJson: row.about_json ?? '{"type":"doc","content":[]}',
      nav: json(row.nav_json, []),
      seo: json(row.seo_json, {}),
      theme: json(row.theme_json, {}),
      aiBots: (row.ai_bots ?? 'unset') as SiteChannel['settings']['aiBots'],
      exposeGated: row.expose_gated === 1,
      prevNextNav: row.prev_next_nav !== 0,
      cacheVersion: row.cache_version ?? 1,
      designVersion: row.design_version ?? null,
      designTests: designTests(row.design_tests),
    },
  };
}

/**
 * Resolves `host` (with any port) to a Channel:
 * - `<slug>.<PLATFORM_SITE_DOMAIN>` → that Channel, if it exists, isn't deleted and isn't paused;
 * - an active custom hostname with role 'web' → its Channel;
 * - an active 'apex_redirect' hostname → a redirect to the Channel's canonical origin;
 * - anything else → unknown (a 404 page, never another Channel's content).
 */
export async function resolveHost(env: SiteEnv, rawHost: string): Promise<Resolution> {
  const host = rawHost.toLowerCase();
  const name = host.split(':')[0] ?? '';
  const suffix = `.${env.PLATFORM_SITE_DOMAIN.toLowerCase()}`;
  let row: ChannelRow | null;
  if (name.endsWith(suffix)) {
    const slug = name.slice(0, -suffix.length);
    if (!/^[a-z0-9-]{3,48}$/.test(slug)) return { kind: 'unknown' };
    row = await first<ChannelRow>(
      env.DB,
      `${SELECT} WHERE c.slug = ?1 AND c.deleted_at IS NULL AND c.status = 'active'`,
      slug,
    );
  } else {
    const custom = await first<{ channel_id: string; role: string }>(
      env.DB,
      `SELECT channel_id, role FROM custom_hostnames WHERE hostname = ?1 AND status = 'active'`,
      name,
    );
    if (!custom) return { kind: 'unknown' };
    row = await first<ChannelRow>(
      env.DB,
      `${SELECT} WHERE c.id = ?1 AND c.deleted_at IS NULL AND c.status = 'active'`,
      custom.channel_id,
    );
    if (row && custom.role === 'apex_redirect') {
      return { kind: 'redirect', location: toChannel(row, env, host).origin };
    }
  }
  return row ? { kind: 'channel', channel: toChannel(row, env, host) } : { kind: 'unknown' };
}
