// A site that chose one of the fixed templates before themes keeps its look: its design is made
// from the old settings ("From the old template settings" in docs/site-themes.md). Pure, so the
// API (a draft before the first save) and the site (a home page before the first publish) agree.
import type { SiteTheme } from '@swarm/domain';
import type { Design } from './design';
import type { SectionInstance } from './theme';
import { contrast, luminance } from './tokens';

/** The old template settings (site_settings.theme_json). */
type LegacyTheme = SiteTheme;

const HEX = /^#[0-9a-fA-F]{6}$/;
/** The page a text colour is checked against when the owner set none, and the text a page gets. */
const LIGHT_PAGE = '#fbfbfd';
const LIGHT_PAGE_INK = '#0f0f12';
const DARK_PAGE_INK = '#f4f3f8';

/** The shared sections, for when the theme's own defaults aren't known. */
const FALLBACK_SECTIONS: SectionInstance[] = [
  { id: 'hero-1', type: 'hero', settings: {} },
  { id: 'latest-2', type: 'latest', settings: {} },
  { id: 'subscribe_band-3', type: 'subscribe_band', settings: {} },
];

const uniqueId = (taken: Set<string>, base: string) => {
  let n = 1;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
};

/**
 * The design for the old settings, or null when no template was chosen. `defaults` are the
 * theme's own default sections (CompiledTheme.defaults); the words go into its hero and benefits.
 */
export function designFromLegacy(
  theme: LegacyTheme,
  accent: string | null | undefined,
  defaults: SectionInstance[] | null = null,
): Design | null {
  if (!theme.template) return null;
  const settings: Record<string, unknown> = {};
  if (accent && HEX.test(accent)) settings.accent = accent.toLowerCase();
  const page = theme.pageColor && HEX.test(theme.pageColor) ? theme.pageColor.toLowerCase() : null;
  const ink = theme.inkColor && HEX.test(theme.inkColor) ? theme.inkColor.toLowerCase() : null;
  const reads = (background: string) => !!ink && contrast(ink, background) >= 4.5;
  if (page) {
    settings.page = page;
    settings.ink = reads(page) ? ink : luminance(page) < 0.2 ? DARK_PAGE_INK : LIGHT_PAGE_INK;
  } else if (reads(LIGHT_PAGE)) {
    settings.ink = ink;
  }
  if (theme.font) {
    settings.heading_font = theme.font;
    settings.body_font = theme.font;
  }
  // A page colour is one colour for every reader, so the scheme is the one that suits it.
  if (page) settings.scheme = luminance(page) < 0.2 ? 'dark' : 'light';
  else if (theme.colorScheme) settings.scheme = theme.colorScheme;

  const hero: Record<string, unknown> = {};
  if (theme.headline?.trim()) hero.heading = theme.headline.trim();
  if (theme.pitch?.trim()) hero.pitch = theme.pitch.trim();
  if (typeof theme.showSubscriberCount === 'boolean') hero.show_count = theme.showSubscriberCount;
  const benefits = (theme.benefits ?? [])
    .map((title) => title.trim())
    .filter(Boolean)
    .map((title) => ({ title }));
  if (Object.keys(hero).length === 0 && benefits.length === 0) {
    return { theme: theme.template, files: null, settings, sections: null };
  }

  const sections: SectionInstance[] = (defaults ?? FALLBACK_SECTIONS).map((s) => ({
    ...s,
    settings: { ...s.settings },
  }));
  const taken = new Set(sections.map((s) => s.id));
  let heroIndex = sections.findIndex((s) => s.type === 'hero');
  if (heroIndex < 0) {
    const id = uniqueId(taken, 'hero');
    taken.add(id);
    sections.unshift({ id, type: 'hero', settings: {} });
    heroIndex = 0;
  }
  const heroSection = sections[heroIndex]!;
  heroSection.settings = { ...heroSection.settings, ...hero };
  if (benefits.length) {
    const existing = sections.find((s) => s.type === 'benefits');
    if (existing) existing.settings = { ...existing.settings, items: benefits };
    else {
      sections.splice(heroIndex + 1, 0, {
        id: uniqueId(taken, 'benefits'),
        type: 'benefits',
        settings: { items: benefits },
      });
    }
  }
  return { theme: theme.template, files: null, settings, sections };
}
