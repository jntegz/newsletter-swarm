import { THEME_LIMITS as DOMAIN_LIMITS } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import {
  THEME_LIMITS,
  compileDesign,
  designFromLegacy,
  designMediaIds,
  standardSettings,
  type CompiledTheme,
  type SectionInstance,
  type ThemeFiles,
} from '../src/index';

const defaults: SectionInstance[] = [
  { id: 'hero-1', type: 'hero', settings: { layout: 'split' } },
  { id: 'latest-2', type: 'latest', settings: { count: 3 } },
];

describe('designFromLegacy', () => {
  it('is null without a template', () => {
    expect(designFromLegacy({ headline: 'Hi' }, '#123456')).toBeNull();
  });

  it('maps colours, the font and the scheme to the standard tokens', () => {
    const design = designFromLegacy(
      {
        template: 'letter',
        pageColor: '#FAFAF0',
        inkColor: '#111111',
        font: 'serif',
        colorScheme: 'dark',
      },
      '#AA3311',
    );
    expect(design).toEqual({
      theme: 'letter',
      files: null,
      settings: {
        accent: '#aa3311',
        page: '#fafaf0',
        ink: '#111111',
        heading_font: 'serif',
        body_font: 'serif',
        scheme: 'light',
      },
      sections: null,
    });
  });

  it('keeps the theme’s sections when there are no words to carry', () => {
    const design = designFromLegacy({ template: 'gate' }, null, defaults);
    expect(design?.sections).toBeNull();
    expect(design?.settings).toEqual({});
  });

  it('puts the headline, pitch and count in the hero, and the benefits after it', () => {
    const design = designFromLegacy(
      {
        template: 'launch',
        headline: ' Letters from the field ',
        pitch: 'Every Sunday.',
        showSubscriberCount: true,
        benefits: ['One essay', '', 'No ads'],
      },
      'not a colour',
      defaults,
    );
    expect(design?.settings).toEqual({});
    expect(design?.sections).toEqual([
      {
        id: 'hero-1',
        type: 'hero',
        settings: {
          layout: 'split',
          heading: 'Letters from the field',
          pitch: 'Every Sunday.',
          show_count: true,
        },
      },
      {
        id: 'benefits-1',
        type: 'benefits',
        settings: { items: [{ title: 'One essay' }, { title: 'No ads' }] },
      },
      { id: 'latest-2', type: 'latest', settings: { count: 3 } },
    ]);
    // The theme's defaults are not changed in place.
    expect(defaults[0]?.settings).toEqual({ layout: 'split' });
  });

  it('fills an existing benefits section, and adds a hero when the theme has none', () => {
    const design = designFromLegacy(
      { template: 'magazine', headline: 'H', benefits: ['B'] },
      null,
      [{ id: 'benefits-1', type: 'benefits', settings: { heading: 'Why' } }],
    );
    expect(design?.sections).toEqual([
      { id: 'hero-1', type: 'hero', settings: { heading: 'H' } },
      { id: 'benefits-1', type: 'benefits', settings: { heading: 'Why', items: [{ title: 'B' }] } },
    ]);
  });

  it('uses the shared sections when the theme’s defaults are unknown', () => {
    const design = designFromLegacy({ template: 'newspaper', showSubscriberCount: false }, null);
    expect(design?.sections?.map((s) => s.type)).toEqual(['hero', 'latest', 'subscribe_band']);
    expect(design?.sections?.[0]?.settings).toEqual({ show_count: false });
  });
});

const files: ThemeFiles = {
  'theme.json': JSON.stringify({
    name: 'Fixture',
    settings: standardSettings(),
    sections: [{ type: 'hero' }],
  }),
  'sections/hero.html': `<h1>{{ section.settings.heading | default: site.name }}</h1>{% subscribe_form %}{% if section.settings.photo %}{{ section.settings.photo | image }}{% endif %}
{% schema %}{"name":"Hero","settings":[{"id":"heading","type":"text","label":"Heading"},{"id":"photo","type":"image","label":"Photo"}]}{% endschema %}`,
};

describe('compileDesign', () => {
  it('compiles the built-in files when the design has none, and checks the design', () => {
    const { theme, problems } = compileDesign(
      { theme: 'gate', files: null, settings: { accent: 'red' }, sections: null },
      files,
    );
    expect(theme?.name).toBe('Fixture');
    expect(problems.map((p) => p.message)).toEqual([expect.stringMatching(/Accent: use a colour/)]);
  });

  it('says so when there is no built-in theme to use', () => {
    const { theme, problems } = compileDesign(
      { theme: 'gate', files: null, settings: {}, sections: null },
      undefined,
    );
    expect(theme).toBeNull();
    expect(problems[0]?.message).toMatch(/no built-in theme/);
  });

  it('lists the images a design uses, once', () => {
    const { theme } = compileDesign(
      { theme: 'gate', files, settings: {}, sections: null },
      undefined,
    );
    const media = `md_${'a'.repeat(32)}`;
    const ids = designMediaIds(theme as CompiledTheme, {
      theme: 'gate',
      files,
      settings: {},
      sections: [
        { id: 'a', type: 'hero', settings: { photo: media } },
        { id: 'b', type: 'hero', settings: { photo: media } },
        { id: 'c', type: 'hero', settings: { photo: `md_${'b'.repeat(32)}` }, hidden: true },
      ],
    });
    expect(ids).toEqual([media]);
  });

  it('shares its limits with the API schema', () => {
    expect(THEME_LIMITS).toBe(DOMAIN_LIMITS);
  });
});
