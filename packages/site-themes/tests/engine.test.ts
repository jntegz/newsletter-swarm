import { describe, expect, it } from 'vitest';
import {
  checkDesign,
  compileTheme,
  contrast,
  contrastWarnings,
  designMediaIds,
  parseTemplate,
  renderDesign,
  renderNodes,
  resolveSettings,
  runningTests,
  standardSettings,
  tokensCss,
  valueProblem,
  type CompiledTheme,
  type RenderHooks,
  type SectionInstance,
  type ThemeFiles,
} from '../src/index';
import { LIMITS, RenderLimit } from '../src/render';

const hooks: RenderHooks = {
  subscribeForm: () => '<form data-test-form></form>',
  image: (img, sizes) => `<img src="${img.url}" alt="${img.alt}" sizes="${sizes}">`,
  now: () => new Date(Date.UTC(2026, 10, 8)),
};

function render(source: string, data: Record<string, unknown> = {}): string {
  const parsed = parseTemplate('test.html', source);
  expect(parsed.problems.filter((p) => p.severity === 'error')).toEqual([]);
  return renderNodes(parsed.nodes, data, hooks);
}

const errors = (source: string) =>
  parseTemplate('test.html', source)
    .problems.filter((p) => p.severity === 'error')
    .map((p) => p.message);

describe('output and escaping', () => {
  it('escapes text, and attributes, by where the placeholder sits', () => {
    expect(render('<p>{{ x }}</p>', { x: '<b>"hi"</b> & co' })).toBe(
      '<p>&lt;b&gt;"hi"&lt;/b&gt; &amp; co</p>',
    );
    expect(render('<p title="{{ x }}">t</p>', { x: '"><img src=x onerror=alert(1)>' })).toBe(
      '<p title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">t</p>',
    );
    expect(render("<p title='{{ x }}'>t</p>", { x: "it's" })).toBe("<p title='it&#39;s'>t</p>");
  });

  it('checks addresses filled in when drawing, and drops unsafe ones', () => {
    expect(render('<a href="{{ u }}">x</a>', { u: 'https://example.com/a?b=1&c=2' })).toBe(
      '<a href="https://example.com/a?b=1&amp;c=2">x</a>',
    );
    expect(render('<a href="{{ u }}">x</a>', { u: 'javascript:alert(1)' })).toBe(
      '<a href="">x</a>',
    );
    expect(render('<a href="{{ u }}">x</a>', { u: ' jav\tascript:alert(1)' })).toBe(
      '<a href="">x</a>',
    );
    expect(render('<a href="{{ u }}">x</a>', { u: 'data:text/html,hi' })).toBe('<a href="">x</a>');
    expect(render('<img src="{{ u }}" alt="">', { u: 'https://tracker.example/p.gif' })).toBe(
      '<img src="" alt="">',
    );
    expect(render('<img src="{{ u }}" alt="">', { u: '/media/a.png' })).toBe(
      '<img src="/media/a.png" alt="">',
    );
    expect(render('<a href="/p/{{ s }}">x</a>', { s: 'javascript:alert(1)' })).toBe(
      '<a href="/p/javascript:alert(1)">x</a>',
    );
  });

  it('refuses placeholders that could escape their place', () => {
    expect(errors('<a href={{ u }}>x</a>')[0]).toMatch(/quotes/);
    expect(errors('<p style="color: {{ c }}">x</p>')[0]).toMatch(/style attribute/);
    expect(errors('<p {{ attr }}>x</p>')[0]).toMatch(/inside a tag/);
    expect(errors('<a href="java{{ x }}">x</a>')[0]).toMatch(/whole address/);
    expect(errors('<a href="{{ a }}{{ b }}">x</a>')[0]).toMatch(/whole address/);
    expect(errors('<a href="{% if x %}/a{% endif %}">x</a>')[0]).toMatch(/around the whole link/);
  });

  it('lets a control tag sit in an attribute only when it leaves it as it found it', () => {
    expect(render('<p class="a {% if x %}b{% endif %}">t</p>', { x: true })).toBe(
      '<p class="a b">t</p>',
    );
    expect(errors('{% if x %}<p class="a{% endif %}">t</p>')[0]).toMatch(/open/);
    // Between tags, a branch may hold any elements.
    expect(
      errors(
        '<div>{% if x %}<p>a</p>{% elsif y %}<ul><li>b</li></ul>{% endif %}{% for i in l %}<span>{{ i }}</span>{% endfor %}</div>',
      ),
    ).toEqual([]);
  });

  it('lets a block hold whole elements', () => {
    expect(errors('<ul>{% for i in l %}<li>{{ i }}</li>{% endfor %}</ul>')).toEqual([]);
    expect(errors('{% if a %}<b>x</b>{% else %}<i>y</i>{% endif %}')).toEqual([]);
    expect(render('<ul>{% for i in l %}<li>{{ i }}</li>{% endfor %}</ul>', { l: [1, 2] })).toBe(
      '<ul><li>1</li><li>2</li></ul>',
    );
    expect(errors('<p {% if a %}hidden{% endif %}>t</p>')[0]).toBeDefined();
  });

  it('only lets Swarm’s own HTML through unescaped', () => {
    expect(render('{% subscribe_form %}')).toBe('<form data-test-form></form>');
    expect(
      render('{{ i | image: "100vw" }}', {
        i: { url: '/media/x.png', alt: 'A "cat"', width: 1, height: 1, focal: '50% 50%' },
      }),
    ).toContain('<img');
    expect(render('{{ i | image }}', { i: '<script>' })).toBe('');
  });
});

describe('HTML safety', () => {
  it('refuses scripts, styles, frames, forms and handlers', () => {
    expect(errors('<script>alert(1)</script>')[0]).toMatch(/Scripts/);
    expect(errors('<style>p{}</style>')[0]).toMatch(/theme\.css/);
    expect(errors('<iframe src="/x"></iframe>')[0]).toMatch(/loads another site/);
    expect(errors('<form action="/x"></form>')[0]).toMatch(/subscribe_form/);
    expect(errors('<p onclick="x()">t</p>')[0]).toMatch(/runs code/);
    expect(errors('<P OnMouseOver="x()">t</P>')[0]).toMatch(/runs code/);
    expect(errors('<a href="javascript:alert(1)">t</a>')[0]).toMatch(/Links can start/);
    expect(errors('<a href="&#106;avascript:alert(1)">t</a>')[0]).toMatch(/character references/);
    expect(errors('<img src="https://cdn.example/x.png" alt="">')[0]).toMatch(/media library/);
    expect(errors('<p style="background:url(https://x.example/a.png)">t</p>')[0]).toMatch(
      /url\(\)/,
    );
    expect(errors('<img srcset="/a.png 1x" alt="">')[0]).toMatch(/srcset/);
  });

  it('allows ordinary markup, inline SVG and safe addresses', () => {
    expect(
      errors(
        '<section class="hero" aria-label="x"><h1 data-x="1">T</h1><a href="https://a.example" rel="noopener">a</a><a href="#top">t</a><a href="/archive">a</a><a href="mailto:a@b.example">m</a><img src="/media/a.png" alt="" loading="lazy"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0h10"/></svg><details><summary>Q</summary>A</details><!-- note --></section>',
      ),
    ).toEqual([]);
  });

  it('reports where the problem is', () => {
    const p = parseTemplate('sections/hero.html', '<div>\n  <p>ok</p>\n  <script></script>\n</div>')
      .problems[0];
    expect(p).toMatchObject({ file: 'sections/hero.html', line: 3, column: 3 });
  });
});

describe('logic', () => {
  it('branches, loops and assigns', () => {
    expect(
      render('{% if a == 2 and b %}yes{% elsif a > 1 %}more{% else %}no{% endif %}', {
        a: 2,
        b: '',
      }),
    ).toBe('more');
    expect(render('{% unless r.sub %}join{% endunless %}', { r: { sub: false } })).toBe('join');
    expect(
      render(
        '{% for p in ps limit: 2 offset: 1 %}{{ forloop.index }}{{ p }}{% if forloop.last %}.{% endif %}{% endfor %}',
        { ps: ['a', 'b', 'c', 'd'] },
      ),
    ).toBe('1b2c.');
    expect(render('{% for p in ps %}x{% else %}none{% endfor %}', { ps: [] })).toBe('none');
    expect(
      render('{% assign n = ps | size %}{{ n }} {{ ps.first }} {{ ps[1] }}', { ps: ['a', 'b'] }),
    ).toBe('2 a b');
    expect(render("{% if tags contains 'paid' %}p{% endif %}", { tags: ['free', 'paid'] })).toBe(
      'p',
    );
  });

  it('applies filters', () => {
    expect(render("{{ x | default: 'Field Notes' }}", { x: '' })).toBe('Field Notes');
    expect(render('{{ x | truncate: 10 }}', { x: 'abcdefghijklmnop' })).toBe('abcdefghi…');
    expect(render('{{ n | number }} {{ n | plural: "issue", "issues" }}', { n: 12731 })).toBe(
      '12,731 12,731 issues',
    );
    expect(
      render("{{ d | date: 'long' }}|{{ d | date: 'iso' }}|{{ d | date: 'ago' }}", {
        d: Date.UTC(2026, 10, 1),
      }),
    ).toBe('November 1, 2026|2026-11-01|1 week ago');
    expect(render('{{ x | upcase | append: "!" }}', { x: 'hi' })).toBe('HI!');
    expect(render('{{ x | paragraphs }}', { x: 'One <b>\nline\n\nTwo' })).toBe(
      '<p>One &lt;b&gt;<br>line</p><p>Two</p>',
    );
  });

  it('never reaches the prototype or Swarm internals', () => {
    expect(render('{{ x.constructor }}{{ x.__proto__ }}', { x: {} })).toBe('');
  });

  it('reports unknown tags, filters and unclosed blocks', () => {
    expect(errors('{% include "x" %}')[0]).toMatch(/no \{% include %\}/);
    expect(errors('{{ x | evil }}')[0]).toMatch(/no “evil” filter/);
    expect(errors('{% if x %}open')[0]).toMatch(/never closed/);
    expect(errors('{% for x in y %}{% endif %}')[0]).toMatch(/closes \{% for %\}/);
    expect(errors('{{ x ')[0]).toMatch(/never closed/);
  });

  it('stops a page that takes too long', () => {
    const nested =
      '{% for a in l %}{% for b in l %}{% for c in l %}{% for d in l %}x{% endfor %}{% endfor %}{% endfor %}{% endfor %}';
    const l = Array.from({ length: LIMITS.loop }, (_, i) => i);
    expect(() => render(nested, { l })).toThrow(RenderLimit);
  });
});

// ---- Themes and designs ---------------------------------------------------------------------------

const files: ThemeFiles = {
  'theme.json': JSON.stringify({
    name: 'Test',
    settings: standardSettings({ accent: '#2f5d50' }),
    sections: [{ type: 'hero', settings: { heading: 'Hello' } }, { type: 'latest' }],
  }),
  'layout.html': '<div class="page">{% sections %}</div>',
  'sections/hero.html': `<header><h1>{{ section.settings.heading | default: site.name }}</h1>{% unless reader.is_subscriber %}{% subscribe_form %}{% endunless %}</header>
{% schema %}{"name":"Hero","settings":[{"id":"heading","type":"text","label":"Heading","max":40}]}{% endschema %}`,
  'sections/latest.html': `<ul>{% for post in posts limit: section.settings.count %}{% render 'card', post: post %}{% endfor %}</ul>
{% schema %}{"name":"Latest","limit":2,"settings":[{"id":"count","type":"range","label":"How many","min":1,"max":6,"default":3}]}{% endschema %}`,
  'snippets/card.html': '<li><a href="{{ post.url }}">{{ post.title }}</a></li>',
  'theme.css': '.page{color:var(--ink)}',
};

function compiled(f: ThemeFiles = files): CompiledTheme {
  const { theme, problems } = compileTheme(f);
  expect(problems.filter((p) => p.severity === 'error')).toEqual([]);
  return theme as CompiledTheme;
}

describe('themes', () => {
  it('compiles files, schemas and default sections', () => {
    const theme = compiled();
    expect(theme.name).toBe('Test');
    expect(Object.keys(theme.schemas)).toEqual(['hero', 'latest']);
    expect(theme.defaults.map((s) => s.id)).toEqual(['hero-1', 'latest-2']);
    expect(theme.reach.subscribe.has('hero')).toBe(true);
  });

  it('reports broken references, bad names, bad JSON and unsafe CSS by file', () => {
    const { problems } = compileTheme({
      ...files,
      'sections/latest.html': "{% render 'nope' %}{% schema %}{bad{% endschema %}",
      'Sections/Bad.HTML': '',
      'theme.css': '@import url(https://fonts.example/x.css);',
    });
    const messages = problems.map((p) => `${p.file}: ${p.message}`);
    expect(messages.some((m) => m.includes('no snippet “nope”'))).toBe(true);
    expect(
      messages.some((m) => m.startsWith('sections/latest.html') && m.includes('valid JSON')),
    ).toBe(true);
    expect(messages.some((m) => m.startsWith('Sections/Bad.HTML'))).toBe(true);
    expect(messages.some((m) => m.startsWith('theme.css'))).toBe(true);
  });

  it('checks a design: values, limits and the essentials', () => {
    const theme = compiled();
    const ok = { theme: 'test', files: null, settings: {}, sections: null };
    expect(checkDesign(theme, ok).filter((p) => p.severity === 'error')).toEqual([]);
    const bad = checkDesign(theme, {
      ...ok,
      settings: { accent: 'red' },
      sections: [
        { id: 'h', type: 'hero', settings: { heading: 'x'.repeat(41) }, audience: 'subscribers' },
        { id: 'l1', type: 'latest', settings: { count: 9 } },
        { id: 'l2', type: 'latest', settings: {} },
        { id: 'l3', type: 'latest', settings: {} },
        { id: 'z', type: 'nope', settings: {} },
      ],
    }).map((p) => p.message);
    expect(bad).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Accent: use a colour/),
        expect.stringMatching(/Heading: keep it under 40/),
        expect.stringMatching(/How many: the most is 6/),
        expect.stringMatching(/no “nope” section/),
        expect.stringMatching(/2 “Latest” sections at most/),
        expect.stringMatching(/Visitors have no way to subscribe/),
      ]),
    );
  });

  it('draws a design for visitors and for subscribers', () => {
    const theme = compiled();
    const design = {
      theme: 'test',
      files: null,
      settings: { accent: '#aa3311' },
      sections: [
        { id: 'hero', type: 'hero', settings: {} },
        {
          id: 'news',
          type: 'latest',
          settings: { count: 1 },
          device: 'phone' as const,
          audience: 'subscribers' as const,
        },
      ],
    };
    const globals = {
      site: { name: 'Field Notes' },
      posts: [
        { title: 'One', url: '/p/one' },
        { title: 'Two', url: '/p/two' },
      ],
    };
    const visitor = renderDesign(
      theme,
      design,
      { globals, reader: { is_subscriber: false, is_paid: false }, image: () => null },
      hooks,
    );
    expect(visitor.html).toContain('<h1>Field Notes</h1><form data-test-form>');
    expect(visitor.html).not.toContain('/p/one');
    expect(visitor.css).toContain('--accent:#aa3311');
    expect(visitor.css).toContain('.page{color:var(--ink)}');
    const reader = renderDesign(
      theme,
      design,
      { globals, reader: { is_subscriber: true, is_paid: false }, image: () => null },
      hooks,
    );
    expect(reader.html).not.toContain('data-test-form');
    expect(reader.html).toContain(
      'class="t-section t-section--latest t-only-phone" id="section-news"',
    );
    expect(reader.html).toContain('<a href="/p/one">One</a>');
    expect(reader.html).not.toContain('/p/two');
  });
});

describe('A/B tests on a section', () => {
  const startedAt = '2026-11-01T10:00:00.000Z';
  const testing = (variantB: Record<string, unknown>, status: 'running' | 'ended' = 'running') => ({
    id: 'exp1',
    status,
    variantB,
    startedAt,
  });
  const design = (sections: SectionInstance[]) => ({
    theme: 'test',
    files: null,
    settings: {},
    sections,
  });
  const globals = { site: { name: 'Field Notes' }, posts: [] };
  const visitor = { is_subscriber: false, is_paid: false };

  it('checks variant B against the section’s schema, and the test itself', () => {
    const theme = compiled();
    const ok = design([
      { id: 'hero', type: 'hero', settings: {}, experiment: testing({ heading: 'B' }) },
    ]);
    expect(checkDesign(theme, ok)).toEqual([]);
    const messages = checkDesign(
      theme,
      design([
        {
          id: 'hero',
          type: 'hero',
          settings: {},
          experiment: {
            ...testing({ heading: 'x'.repeat(41) }),
            id: 'Not An Id',
            startedAt: 'soon',
          },
        },
      ]),
    ).map((p) => p.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Hero, variant B: Heading: keep it under 40/),
        'Hero: the A/B test needs an id.',
        'Hero: the A/B test needs the date it started.',
      ]),
    );
    const winner = checkDesign(
      theme,
      design([
        {
          id: 'hero',
          type: 'hero',
          settings: {},
          experiment: { ...testing({}, 'ended'), winner: 'c' as 'a' },
        },
      ]),
    ).map((p) => p.message);
    expect(winner).toContain('Hero: the A/B test’s winner is A or B.');
  });

  it('runs at most 3 tests at once; ended ones don’t count', () => {
    const theme = compiled({
      ...files,
      'sections/latest.html': files['sections/latest.html']!.replace('"limit":2,', ''),
    });
    const latest = (i: number, status: 'running' | 'ended'): SectionInstance => ({
      id: `l${i}`,
      type: 'latest',
      settings: {},
      experiment: { ...testing({ count: 2 }, status), id: `e${i}` },
    });
    const hero: SectionInstance = { id: 'hero', type: 'hero', settings: {} };
    const three = design([
      hero,
      latest(1, 'running'),
      latest(2, 'running'),
      latest(3, 'running'),
      latest(4, 'ended'),
    ]);
    expect(checkDesign(theme, three).filter((p) => p.severity === 'error')).toEqual([]);
    const four = design([
      hero,
      latest(1, 'running'),
      latest(2, 'running'),
      latest(3, 'running'),
      latest(4, 'running'),
    ]);
    expect(checkDesign(theme, four).map((p) => p.message)).toContain(
      'A design can run at most 3 A/B tests at once; 4 are running. End one first.',
    );
  });

  it('draws B for a view given B, A otherwise, and tells the hooks which', () => {
    const theme = compiled();
    const d = design([
      {
        id: 'hero',
        type: 'hero',
        settings: { heading: 'Alpha' },
        experiment: testing({ heading: 'Beta' }),
      },
      { id: 'news', type: 'latest', settings: {} },
    ]);
    const forms: unknown[] = [];
    const ends: string[] = [];
    const tracking: RenderHooks = {
      ...hooks,
      subscribeForm: (context) => {
        forms.push(context);
        return '<form></form>';
      },
      sectionEnd: (id, variant) => {
        ends.push(`${id}:${variant}`);
        return `<img class="t-beacon" data-s="${id}" data-v="${variant}">`;
      },
    };
    const draw = (variants?: Record<string, 'a' | 'b'>) =>
      renderDesign(theme, d, { globals, reader: visitor, image: () => null, variants }, tracking)
        .html;

    const b = draw({ hero: 'b', news: 'b' });
    expect(b).toContain('<h1>Beta</h1>');
    expect(b).toContain('<img class="t-beacon" data-s="hero" data-v="b"></div>');
    // A section without a running test is always A.
    expect(b).toContain('data-s="news" data-v="a"');
    expect(forms).toEqual([{ sectionId: 'hero', variant: 'b' }]);
    expect(ends).toEqual(['hero:b', 'news:a']);

    expect(draw({ hero: 'a' })).toContain('<h1>Alpha</h1>');
    expect(draw()).toContain('<h1>Alpha</h1>');

    // An ended test draws the section's own settings, whatever the view was given.
    const ended = design([
      {
        id: 'hero',
        type: 'hero',
        settings: { heading: 'Alpha' },
        experiment: testing({ heading: 'Beta' }, 'ended'),
      },
    ]);
    const html = renderDesign(
      theme,
      ended,
      { globals, reader: visitor, image: () => null, variants: { hero: 'b' } },
      tracking,
    ).html;
    expect(html).toContain('<h1>Alpha</h1>');
  });

  it('keeps hosts without the new hooks working, and gives the layout’s form no context', () => {
    const theme = compiled({
      ...files,
      'layout.html': '<div class="page">{% sections %}<footer>{% subscribe_form %}</footer></div>',
    });
    const contexts: unknown[] = [];
    const html = renderDesign(
      theme,
      design([{ id: 'hero', type: 'hero', settings: {} }]),
      { globals, reader: visitor, image: () => null },
      {
        ...hooks,
        subscribeForm: (context) => {
          contexts.push(context ?? null);
          return '<form></form>';
        },
      },
    ).html;
    expect(contexts).toEqual([{ sectionId: 'hero', variant: 'a' }, null]);
    expect(html).not.toContain('t-beacon');
  });

  it('lists the images variant B uses, and the tests that run', () => {
    const withImage = compiled({
      ...files,
      'sections/hero.html': files['sections/hero.html']!.replace(
        '"settings":[',
        '"settings":[{"id":"image","type":"image","label":"Image"},',
      ),
    });
    const a = `md_${'a'.repeat(32)}`;
    const b = `md_${'b'.repeat(32)}`;
    const d = design([
      { id: 'hero', type: 'hero', settings: { image: a }, experiment: testing({ image: b }) },
    ]);
    expect(designMediaIds(withImage, d).sort()).toEqual([a, b]);
    expect(runningTests(withImage, d).map((s) => s.id)).toEqual(['hero']);
    const ended = design([
      {
        id: 'hero',
        type: 'hero',
        settings: { image: a },
        experiment: testing({ image: b }, 'ended'),
      },
    ]);
    expect(designMediaIds(withImage, ended)).toEqual([a]);
    expect(runningTests(withImage, ended)).toEqual([]);
  });
});

describe('settings and tokens', () => {
  it('checks each type', () => {
    expect(valueProblem({ id: 'u', type: 'url', label: 'U' }, 'javascript:x')).toMatch(/Links/);
    expect(valueProblem({ id: 'u', type: 'url', label: 'U' }, '/about')).toBeNull();
    expect(valueProblem({ id: 'i', type: 'image', label: 'I' }, `md_${'a'.repeat(32)}`)).toBeNull();
    expect(
      valueProblem(
        { id: 's', type: 'select', label: 'S', options: ['a', { value: 'b', label: 'B' }] },
        'b',
      ),
    ).toBeNull();
    expect(
      valueProblem(
        {
          id: 'l',
          type: 'list',
          label: 'L',
          max: 1,
          fields: [{ id: 't', type: 'text', label: 'T' }],
        },
        [{ t: 'a' }, { t: 'b' }],
      ),
    ).toMatch(/at most 1/);
  });

  it('falls back to defaults for missing or invalid values', () => {
    const defs = standardSettings({ accent: '#123456' });
    const v = resolveSettings(defs, { accent: 'nope', scale: 'large' });
    expect(v.accent).toBe('#123456');
    expect(v.scale).toBe('large');
  });

  it('writes variables, dark values and readable text on the accent', () => {
    const css = tokensCss(
      standardSettings(),
      resolveSettings(standardSettings(), { accent: '#ffd400', scheme: 'auto', buttons: 'pill' }),
    );
    expect(css).toContain('--on-accent:#0f0f12');
    expect(css).toContain('@media (prefers-color-scheme:dark)');
    expect(css).toContain('--r-button:999px');
    expect(css).toContain("@font-face{font-family:'Swarm Grotesk'");
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 0);
    expect(contrastWarnings({ page: '#ffffff', ink: '#cccccc', accent: '#ffff00' })).toHaveLength(
      2,
    );
    // A colour that text sits on is checked against the text colour, by its label.
    const inks = [{ id: 'second_ink', type: 'color' as const, label: 'Second ink', text_on: true }];
    expect(
      contrastWarnings({ page: '#ffffff', ink: '#111111', second_ink: '#ffd23f' }, inks),
    ).toEqual([]);
    expect(
      contrastWarnings({ page: '#ffffff', ink: '#111111', second_ink: '#222266' }, inks),
    ).toEqual([expect.stringMatching(/^Text on second ink is hard to read/)]);
  });

  it('wins over the site’s own variables and keeps accent links readable in the dark', () => {
    const css = tokensCss(
      standardSettings(),
      resolveSettings(standardSettings(), { accent: '#c42d17', scheme: 'dark' }),
    );
    // The site sets its variables on :root and html[data-scheme=…]; html:root matches those.
    const blocks = [
      ...css.matchAll(/html:root\{--accent:(#\w+);[^}]*?--page:(#\w+);[^}]*?--surface-alt:(#\w+)/g),
    ];
    expect(blocks.map((m) => m[1])).toEqual(['#c42d17', expect.not.stringMatching('#c42d17')]);
    const [, accent = '', page = '', raised = ''] = blocks[1] ?? [];
    expect(contrast(accent, page)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(accent, raised)).toBeGreaterThanOrEqual(4.5);
  });
});
