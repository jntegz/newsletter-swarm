import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkDesign,
  compileTheme,
  renderDesign,
  type CompiledTheme,
  type Design,
  type RenderHooks,
  type SettingType,
} from '../src/index';
import { THEME_FILES } from '../themes/generated';
import { BUILT_IN_THEMES, BUILT_IN_THEME_IDS } from '../themes/index';

const THEMES = fileURLToPath(new URL('../themes/', import.meta.url));

function onDisk(id: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(join(THEMES, id, dir)).sort()) {
      const path = dir ? `${dir}/${name}` : name;
      if (statSync(join(THEMES, id, path)).isDirectory()) walk(path);
      else if (/\.(html|css|json)$/.test(name))
        files[path] = readFileSync(join(THEMES, id, path), 'utf8');
    }
  };
  walk('');
  return files;
}

/** The shared sections and their settings, as docs/site-themes.md lists them. */
const SHARED: Record<string, Record<string, SettingType>> = {
  hero: {
    heading: 'text',
    pitch: 'textarea',
    promise: 'text',
    show_count: 'checkbox',
    show_logo: 'checkbox',
    privacy_note: 'text',
    layout: 'select',
    image: 'image',
  },
  benefits: { heading: 'text', items: 'list' },
  latest: {
    heading: 'text',
    count: 'range',
    style: 'select',
    show_images: 'checkbox',
    show_excerpt: 'checkbox',
  },
  featured: { heading: 'text', button_label: 'text' },
  testimonials: { heading: 'text', items: 'list' },
  author: {
    heading: 'text',
    name: 'text',
    bio: 'textarea',
    photo: 'image',
    link_label: 'text',
    link_url: 'url',
  },
  faq: { heading: 'text', items: 'list' },
  numbers: { heading: 'text', items: 'list' },
  text: { heading: 'text', body: 'textarea', align: 'select' },
  subscribe_band: { heading: 'text', text: 'textarea' },
};

const LIST_FIELDS: Record<string, Record<string, SettingType>> = {
  benefits: { title: 'text', text: 'textarea' },
  testimonials: { quote: 'textarea', name: 'text', role: 'text', photo: 'image' },
  faq: { question: 'text', answer: 'textarea' },
  numbers: { value: 'text', label: 'text' },
};

const hooks: RenderHooks = {
  subscribeForm: () =>
    '<form data-test-form><label>Email <input type="email" name="email"></label><button>Subscribe</button></form>',
  image: (img) => `<img src="${img.url}" alt="${img.alt}">`,
  now: () => new Date(Date.UTC(2026, 10, 9)),
};

const image = (n: number) => ({
  url: `/media/${n}.png`,
  alt: `Picture ${n}`,
  width: 1600,
  height: 1000,
  focal: '50% 50%',
});
const posts = Array.from({ length: 8 }, (_, i) => ({
  title: `Issue ${8 - i}`,
  url: `/p/issue-${8 - i}`,
  excerpt: 'A few plain sentences about what this issue is about.',
  date: new Date(Date.UTC(2026, 10, 8 - i * 7)).toISOString(),
  reading_minutes: 5,
  image: i % 3 === 2 ? null : image(i),
  is_paid: i === 3,
  is_pinned: i === 1,
  author: 'Mara Lind',
}));
const site = {
  name: 'Field Notes',
  description: 'A weekly letter about the nature on your doorstep.',
  url: 'https://fieldnotes.example',
  logo: image(99),
  subscriber_count: 12_431,
  issue_count: 48,
  nav: [],
  archive_url: '/archive',
  about_url: '/about',
  plans_url: '/subscribe',
  has_paid_plans: true,
};
const PHOTO = `md_${'a'.repeat(32)}`;

function render(theme: CompiledTheme, design: Design, subscriber: boolean, empty = false) {
  const list = empty ? [] : posts;
  return renderDesign(
    theme,
    design,
    {
      globals: {
        site: empty ? { ...site, subscriber_count: null, issue_count: 0, logo: null } : site,
        posts: list,
        pinned: list.filter((p) => p.is_pinned),
        featured: list.find((p) => p.is_pinned) ?? null,
        page: { path: '/' },
      },
      reader: { is_subscriber: subscriber, is_paid: false },
      image: (id) => (id === PHOTO ? image(7) : null),
    },
    hooks,
  ).html;
}

const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;

describe('built-in themes', () => {
  it('generated.ts matches the files on disk', () => {
    expect(Object.keys(THEME_FILES).sort()).toEqual([...BUILT_IN_THEME_IDS].sort());
    for (const id of BUILT_IN_THEME_IDS) expect(THEME_FILES[id]).toEqual(onDisk(id));
  });

  it('are all listed, with a name and a line about them', () => {
    for (const id of BUILT_IN_THEME_IDS) {
      const theme = BUILT_IN_THEMES[id];
      expect(theme?.name).toBeTruthy();
      expect(theme?.description).toMatch(/^[A-Z].{20,110}\.$/);
      expect(theme?.files).toBe(THEME_FILES[id]);
    }
  });

  for (const id of BUILT_IN_THEME_IDS) {
    describe(id, () => {
      const { theme, problems } = compileTheme(THEME_FILES[id] ?? {});
      const compiled = theme as CompiledTheme;
      const defaults: Design = { theme: id, files: null, settings: {}, sections: null };

      it('compiles without problems', () => {
        expect(problems).toEqual([]);
        expect(theme).not.toBeNull();
      });

      it('has no problems with its default sections', () => {
        expect(checkDesign(compiled, defaults)).toEqual([]);
        expect(compiled.defaults[0]?.type).toBe('hero');
      });

      it('has every shared section, with the shared settings', () => {
        for (const [type, settings] of Object.entries(SHARED)) {
          const schema = compiled.schemas[type];
          expect(schema, type).toBeDefined();
          const types = Object.fromEntries((schema?.settings ?? []).map((s) => [s.id, s.type]));
          expect(types, type).toEqual(settings);
          const fields = LIST_FIELDS[type];
          if (fields) {
            const list = schema?.settings.find((s) => s.id === 'items');
            expect(
              Object.fromEntries((list?.fields ?? []).map((f) => [f.id, f.type])),
              type,
            ).toEqual(fields);
          }
        }
        const latest = compiled.schemas.latest?.settings ?? [];
        const style = latest.find((s) => s.id === 'style');
        const values = (style?.options ?? []).map((o) => (typeof o === 'string' ? o : o.value));
        expect(values).toEqual(expect.arrayContaining(['cards', 'list', 'compact']));
        expect(latest.find((s) => s.id === 'count')).toMatchObject({ min: 1, max: 12 });
        const align = compiled.schemas.text?.settings.find((s) => s.id === 'align');
        expect(align?.options?.map((o) => (typeof o === 'string' ? o : o.value))).toEqual([
          'left',
          'centre',
        ]);
      });

      it('declares at most three settings of its own besides the standard tokens', () => {
        expect(compiled.settings.length).toBeLessThanOrEqual(13);
      });

      it('shows visitors the form and one main heading, and subscribers the writing', () => {
        const visitor = render(compiled, defaults, false);
        expect(count(visitor, /data-test-form/g)).toBeGreaterThanOrEqual(1);
        expect(count(visitor, /<h1[\s>]/g)).toBe(1);
        expect(visitor).toContain('/p/issue-8');

        const reader = render(compiled, defaults, true);
        expect(reader).not.toContain('data-test-form');
        expect(count(reader, /<h1[\s>]/g)).toBe(1);
        expect(reader).toContain('/p/issue-8');
      });

      it('draws every section, filled in and empty, in every layout and style', () => {
        const schemas = compiled.schemas;
        const options = (type: string, id: string) =>
          (schemas[type]?.settings.find((s) => s.id === id)?.options ?? []).map((o) =>
            typeof o === 'string' ? o : o.value,
          );
        const filled = {
          heading: 'A heading',
          items: [
            {
              title: 'One',
              text: 'Text',
              quote: 'A quote',
              name: 'Jonas Weber',
              role: 'Reader',
              photo: PHOTO,
              question: 'A question?',
              answer: 'An answer.',
              value: '48',
              label: 'Issues',
            },
          ],
          name: 'Mara Lind',
          bio: 'About me.\n\nMore about me.',
          photo: PHOTO,
          body: 'Some text.',
          image: PHOTO,
          promise: 'Every Sunday. Free.',
          show_logo: true,
        };
        const sections = [
          ...options('hero', 'layout').map((layout) => ({ type: 'hero', settings: { layout } })),
          ...options('latest', 'style').map((style) => ({
            type: 'latest',
            settings: { style, count: 12, show_images: true },
          })),
          ...Object.keys(SHARED)
            .filter((t) => t !== 'hero' && t !== 'latest')
            .flatMap((type) => [
              { type, settings: filled },
              { type, settings: { heading: '', items: [] } },
            ]),
        ];
        for (const [i, s] of sections.entries()) {
          const design: Design = {
            theme: id,
            files: null,
            settings: { scheme: 'auto' },
            sections: [{ id: `s${i}`, type: s.type, settings: s.settings }],
          };
          for (const subscriber of [false, true]) {
            for (const empty of [false, true]) {
              const html = render(compiled, design, subscriber, empty);
              expect(count(html, /<h1[\s>]/g)).toBeLessThanOrEqual(1);
              expect(html).not.toMatch(/\{\{|\{%|undefined|\[object/);
            }
          }
        }
      });
    });
  }
});
