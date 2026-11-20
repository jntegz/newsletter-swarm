// The placeholder reference the code editor shows beside the files: every value, tag and filter a
// template can use, with what to insert. One list, so the docs and the editor can't drift apart.

interface ReferenceItem {
  /** What is inserted at the cursor. */
  insert: string;
  /** One plain line. */
  description: string;
}

interface ReferenceGroup {
  title: string;
  items: ReferenceItem[];
}

const post = (name: string) => [
  { insert: `{{ ${name}.title }}`, description: 'The issue’s subject.' },
  { insert: `{{ ${name}.url }}`, description: 'Its address on the site.' },
  { insert: `{{ ${name}.excerpt }}`, description: 'A short summary of the free part.' },
  { insert: `{{ ${name}.date | date: 'long' }}`, description: 'When it was published.' },
  { insert: `{{ ${name}.reading_minutes }}`, description: 'Minutes to read.' },
  {
    insert: `{% if ${name}.image %}{{ ${name}.image | image: '(min-width: 960px) 33vw, 100vw' }}{% endif %}`,
    description: 'Its image, sized for the reader’s screen.',
  },
  {
    insert: `{% if ${name}.is_paid %}Paid{% endif %}`,
    description: 'Whether it’s for paid subscribers.',
  },
  { insert: `{{ ${name}.author }}`, description: 'Who wrote it, when bylines are on.' },
];

export const REFERENCE: ReferenceGroup[] = [
  {
    title: 'The publication',
    items: [
      { insert: '{{ site.name }}', description: 'The publication’s name.' },
      { insert: '{{ site.description }}', description: 'Its description.' },
      {
        insert: "{% if site.logo %}{{ site.logo | image: '72px' }}{% endif %}",
        description: 'The logo.',
      },
      {
        insert: '{% if site.subscriber_count %}{{ site.subscriber_count | number }}{% endif %}',
        description: 'Subscribers, when shown and at least 100.',
      },
      {
        insert: "{{ site.issue_count | plural: 'issue', 'issues' }}",
        description: 'How many issues are published.',
      },
      { insert: '{{ site.archive_url }}', description: 'The archive.' },
      { insert: '{{ site.about_url }}', description: 'The About page.' },
      {
        insert:
          '{% if site.plans_url %}<a href="{{ site.plans_url }}">See paid plans</a>{% endif %}',
        description: 'Paid plans, when there are any.',
      },
      {
        insert:
          '{% for link in site.nav %}<a href="{{ link.url }}">{{ link.label }}</a>{% endfor %}',
        description: 'The navigation links.',
      },
    ],
  },
  {
    title: 'The reader',
    items: [
      {
        insert: '{% unless reader.is_subscriber %}{% subscribe_form %}{% endunless %}',
        description: 'The signup form, for visitors only.',
      },
      {
        insert: '{% if reader.is_paid %}…{% endif %}',
        description: 'Something for paid subscribers.',
      },
    ],
  },
  {
    title: 'Issues',
    items: [
      {
        insert:
          '{% for post in posts limit: 3 %}\n  \n{% else %}\n  The first issue is on its way.\n{% endfor %}',
        description: 'The latest issues (up to 24), newest first.',
      },
      { insert: '{% for post in pinned %}{% endfor %}', description: 'The pinned issues.' },
      { insert: '{{ featured.title }}', description: 'The pinned issue, or else the latest.' },
      ...post('post'),
    ],
  },
  {
    title: 'Sections and settings',
    items: [
      {
        insert: '{{ section.settings.heading }}',
        description: 'A setting of this section, declared in its {% schema %}.',
      },
      {
        insert: '{% for item in section.settings.items %}{{ item.text }}{% endfor %}',
        description: 'The items of a list setting.',
      },
      {
        insert: '{{ theme.accent }}',
        description: 'A theme setting; in CSS use var(--accent) or var(--t-<id>).',
      },
      {
        insert: '{% sections %}',
        description: 'In layout.html: the page’s sections, in the owner’s order.',
      },
      { insert: "{% section 'footer' %}", description: 'One section, always in this place.' },
      {
        insert: "{% render 'post-card', post: post %}",
        description: 'A snippet from snippets/, with what it needs.',
      },
    ],
  },
  {
    title: 'Logic',
    items: [
      {
        insert: '{% if  %}\n\n{% else %}\n\n{% endif %}',
        description: 'Show something only when a value is set.',
      },
      {
        insert: '{% unless  %}{% endunless %}',
        description: 'Show something only when a value is not set.',
      },
      {
        insert: '{% for item in  limit: 3 %}{{ forloop.index }}{% endfor %}',
        description: 'Repeat for each item; forloop.first, .last, .index.',
      },
      { insert: '{% assign name = value %}', description: 'Keep a value under a short name.' },
      { insert: '{% comment %}{% endcomment %}', description: 'A note that never shows.' },
    ],
  },
  {
    title: 'Filters',
    items: [
      { insert: " | default: 'text'", description: 'Use this when the value is empty.' },
      { insert: ' | truncate: 120', description: 'Shorten to so many characters.' },
      { insert: ' | truncatewords: 20', description: 'Shorten to so many words.' },
      {
        insert: " | date: 'long'",
        description: "Dates: 'short', 'long', 'month', 'year', 'iso', 'ago'.",
      },
      { insert: ' | number', description: 'A number with thousands separators.' },
      { insert: ' | paragraphs', description: 'Text with blank lines drawn as paragraphs.' },
      { insert: " | plural: 'issue', 'issues'", description: 'A number with the right word.' },
      {
        insert: " | image: '100vw'",
        description: 'Draw an image, with the space it takes on the page.',
      },
      { insert: ' | upcase', description: 'Capitals (also downcase, capitalize, strip).' },
      {
        insert: " | append: 'text'",
        description: 'Add text after (prepend adds before; replace swaps).',
      },
      { insert: ' | size', description: 'How many items or characters (also first, last, join).' },
    ],
  },
  {
    title: 'CSS variables',
    items: [
      {
        insert: 'var(--accent)',
        description: 'The accent colour (var(--on-accent) for text on it).',
      },
      { insert: 'var(--page)', description: 'Background; also --surface, --surface-alt.' },
      {
        insert: 'var(--ink)',
        description: 'Headings; --text for body text, --text-sub for quieter text.',
      },
      { insert: 'var(--line)', description: 'Rules and borders; --line-strong for stronger ones.' },
      { insert: 'var(--font-heading)', description: 'The heading font; var(--font) for text.' },
      { insert: 'var(--step-3)', description: 'The type scale, --step-m1 to --step-6.' },
      { insert: 'var(--r-card)', description: 'Corner radius of cards; --r-control, --r-button.' },
      { insert: 'var(--wrap)', description: 'The page width.' },
    ],
  },
];
