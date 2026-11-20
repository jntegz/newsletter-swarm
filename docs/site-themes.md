# Website themes: templates, sections, style and code

Status: built, Nov 2026 (engine `packages/site-themes`, API `workers/api/src/routes/siteDesign.ts`, site `workers/site/src/render/design.ts` and `routes/preview.ts`, dashboard `apps/dashboard/src/design/`). Replaces the fixed home-page templates in `workers/site/src/render/templates.ts`. Flag: `site_templates` (the code editor also needs the admin role).

## The idea

One mechanism, four depths. Every built-in template is written in the same files an owner can edit, and every setting an owner sees in the dashboard is declared in those files. So nobody hits a wall: a writer picks a template and changes a colour; a designer opens the code, adds a section with its own settings, and those settings appear as ordinary controls for the rest of the team.

| Depth       | Who      | What they change                                                                                                                                                                                                                                                                 |
| ----------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Template | everyone | Pick a starting design (Gate, Letter, Magazine, Newspaper, Launch, Night, Zine, Brief). Switching keeps the words.                                                                                                                                                               |
| 2. Style    | everyone | Design tokens: colours, fonts, type size, corners, width, buttons, light or dark. Contrast is checked as they change.                                                                                                                                                            |
| 3. Sections | everyone | Add, remove, reorder and fill sections: hero, benefits, latest issues, a featured issue, testimonials, the author, FAQ, numbers, a subscribe band, custom HTML. Each can show to visitors only, subscribers only, or everyone, and on phones only, larger screens only, or both. |
| 4. Code     | admins   | Edit the theme's files: the layout, each section's HTML with placeholders, snippets and the stylesheet. Declare new settings in a section's schema and they appear at depth 3.                                                                                                   |

Everything is a **draft** until **Publish**. The draft shows in a live preview rendered by the real site worker. Every publish is kept as a version that can be restored.

## Theme files

A theme is a small set of text files, at most 64 files and 256 KB in all:

```
theme.json            name, the theme's settings (tokens) and the default sections
layout.html           the page around the sections (optional; a default wraps them)
sections/<type>.html  one file per section type, ending with its {% schema %}
snippets/<name>.html  pieces shared between sections, used with {% render %}
theme.css             the theme's rules, written against the tokens
```

A built-in template is a theme in `packages/site-themes/themes/<id>/`. A site that never edited code uses the built-in files directly and gets their improvements. **Edit code** copies the files into the site's design, from then on the site's own.

### theme.json

```json
{
  "name": "Launch",
  "settings": [
    { "id": "accent", "type": "color", "label": "Accent", "default": "#2f5d50" },
    {
      "id": "heading_font",
      "type": "font",
      "label": "Headings",
      "default": "archivo"
    },
    {
      "id": "corners",
      "type": "select",
      "label": "Corners",
      "options": ["square", "soft", "round"],
      "default": "soft"
    }
  ],
  "sections": [
    { "type": "hero", "settings": { "layout": "split" } },
    { "type": "benefits" },
    { "type": "latest", "settings": { "style": "cards", "count": 3 } },
    { "type": "testimonials" },
    { "type": "subscribe_band" }
  ]
}
```

Theme settings become CSS custom properties: a setting `accent` is `var(--t-accent)`; the standard tokens (below) also feed the site's own variables, so post pages and the archive match the home page.

### A section file

```liquid
<section class="hero hero--{{ section.settings.layout }}">
  <h1>{{ section.settings.heading | default: site.name }}</h1>
  <p class="pitch">{{ section.settings.pitch | default: site.description }}</p>
  {% if site.subscriber_count %}<p class="proof">Read by {{ site.subscriber_count | number }} people</p>{% endif %}
  {% unless reader.is_subscriber %}{% subscribe_form %}{% endunless %}
</section>

{% schema %}
{
  "name": "Hero",
  "settings": [
    { "id": "heading", "type": "text", "label": "Heading", "max": 120 },
    { "id": "pitch", "type": "textarea", "label": "The line under it", "max": 400 },
    { "id": "layout", "type": "select", "label": "Layout", "options": ["centred", "split"], "default": "centred" }
  ]
}
{% endschema %}
```

## The shared sections

The built-in themes draw the same section types with the same setting ids, each in its own style. Switching template keeps every word and every image; only the look changes. A custom theme may add types of its own.

| Type             | What it is                                                                     | Settings (id: type)                                                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hero`           | The first screen: the promise and the signup form. Every theme starts with it. | `heading`: text (defaults to the name), `pitch`: textarea (defaults to the description), `promise`: text ("Every Sunday. Free."), `show_count`: checkbox, `show_logo`: checkbox, `privacy_note`: text, `layout`: select (theme-specific), `image`: image |
| `benefits`       | What subscribers get, as a short list.                                         | `heading`: text, `items`: list of `title`: text, `text`: textarea                                                                                                                                                                                        |
| `latest`         | The latest issues.                                                             | `heading`: text, `count`: range 1–12, `style`: select (`cards`, `list`, `compact`; themes may add their own), `show_images`: checkbox, `show_excerpt`: checkbox                                                                                          |
| `featured`       | One issue up close: the pinned one, else the latest; "read a sample".          | `heading`: text, `button_label`: text                                                                                                                                                                                                                    |
| `testimonials`   | What readers say.                                                              | `heading`: text, `items`: list of `quote`: textarea, `name`: text, `role`: text, `photo`: image                                                                                                                                                          |
| `author`         | Who writes it.                                                                 | `heading`: text, `name`: text, `bio`: textarea, `photo`: image, `link_label`: text, `link_url`: url                                                                                                                                                      |
| `faq`            | Questions before signing up (drawn with `<details>`, no script).               | `heading`: text, `items`: list of `question`: text, `answer`: textarea                                                                                                                                                                                   |
| `numbers`        | A few figures: issues, readers, years.                                         | `heading`: text, `items`: list of `value`: text, `label`: text                                                                                                                                                                                           |
| `text`           | A heading and paragraphs.                                                      | `heading`: text, `body`: textarea, `align`: select (`left`, `centre`)                                                                                                                                                                                    |
| `subscribe_band` | A second chance to subscribe, at the end.                                      | `heading`: text, `text`: textarea                                                                                                                                                                                                                        |

Every section's own CSS is scoped by its wrapper, `.t-section--<type>`. Sections show for `everyone`, `visitors` (not subscribed) or `subscribers`, and on `all` screens, `phone` only or `desktop` only.

### From the old template settings

A page colour fixes the scheme to the one that suits it, and a text colour that can't be read on the page is left out.

A site that chose a template before themes keeps its look: its design is made from the old settings once. `template` gives the theme; `branding.accentColor`, `pageColor`, `inkColor` and `font` give the tokens (the font goes to both `heading_font` and `body_font`; `colorScheme` gives `scheme`); `headline`, `pitch` and `showSubscriberCount` go to the hero's `heading`, `pitch` and `show_count`; `benefits` become the `benefits` section's items. `customCss` stays where it is and is added after `theme.css`.

## API

All under `/api/v1/channels/{channelId}/site/design`. Viewers can read. Editors and up can change settings and sections, preview and publish. Changing files (Edit code, import) needs the admin role.

| Method and path                      | Role   | What                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`                              | viewer | `{ draft, published, draftUpdatedAt, publishedAt, publishedBy, problems, themes, schedule }`: the designs, the draft's problems, the built-in themes (id, name, description, files) and the scheduled publish (`{ at, by, createdAt, status, problems }` or null). Before the first save the draft is made from the old template settings, or is the Launch theme as it comes.                                                            |
| `PUT /draft`                         | editor | Saves the whole draft design and answers `{ draft, draftUpdatedAt, problems }`. Always saves when the shape is right, so work is never lost. A draft whose `files` differ from the stored draft's is refused (403) below the admin role.                                                                                                                                                                                                  |
| `POST /publish`                      | editor | Publishes the draft: `{ published, publishedAt, publishedBy, version, problems }` (warnings only). Refused with 422 and `{ error, problems }` while the draft has errors. Bumps the site's cache version and keeps the design as a version.                                                                                                                                                                                               |
| `PUT /schedule`                      | editor | `{ at }`: schedules the draft as it is now to publish at `at`, at least 5 minutes and at most 90 days ahead (else 400). Answers the schedule. Refused with 422 and `{ error, problems }` while the draft has errors, like Publish. Replaces any schedule there is, failed ones included.                                                                                                                                                  |
| `DELETE /schedule`                   | editor | Cancels the schedule (204), waiting or failed, so nothing is published. 404 when there is none. The row is kept as `cancelled` for 10 minutes' Undo.                                                                                                                                                                                                                                                                                      |
| `POST /schedule/restore`             | editor | Undo for Cancel within 10 minutes: puts back the same snapshot and time, waiting or failed as it was, and answers the schedule. 404 when there is nothing to put back.                                                                                                                                                                                                                                                                    |
| `GET /versions`                      | viewer | `{ items }`: the last 20 published designs, newest first: `id`, `publishedAt`, `publishedBy`, `theme`.                                                                                                                                                                                                                                                                                                                                    |
| `POST /versions/{versionId}/restore` | editor | Puts a version, files included, into the draft, answering like `PUT /draft`.                                                                                                                                                                                                                                                                                                                                                              |
| `POST /preview`                      | editor | `{ url, expiresAt }`: a site address on the platform domain, `/_swarm/preview?token=…`, with a signed token (purpose `site-preview` in `@swarm/tokens`, signed with `SITE_LINK_SIGNING_KEYS`, 30 minutes) that renders the draft. `as` in the body: `visitor` (the default), `subscriber` or `paid`. `variant: "b"` adds `&variant=b` (variant B of every running A/B test), and `section` with it `&section=<id>` (that section's only). |
| `GET /stats?days=7\|30\|90`          | viewer | Section analytics and A/B test results (below): `{ days, from, to, sections, totals, tests }`. `sections` has `{ sectionId, variant, reached, signups }` per section and variant over the period (30 days by default), `totals` their sums, and `tests` one result per running or ended test of the draft or the published design.                                                                                                        |
| `GET /export`                        | viewer | The draft's theme as one file: `{ format: "swarm-theme", version: 1, name, files }`, its own files or the built-in theme's.                                                                                                                                                                                                                                                                                                               |
| `POST /import`                       | admin  | Takes that file into the draft: its files replace the draft's, the settings stay, and the sections stay when the theme has every type they use (else the theme's defaults). Answers like `PUT /draft`.                                                                                                                                                                                                                                    |

Every route needs the `site_templates` flag (404 `feature_disabled` without it). Publish, restore, import and scheduling are written to the audit log (`site.design_published`, `site.design_restored`, `site.design_imported`, `site.design_scheduled`, `site.design_schedule_cancelled`, `site.design_schedule_restored`, and `site.design_schedule_failed` when a scheduled publish is refused at its time). A scheduled publish writes `site.design_published` with the person who scheduled it as the actor and `scheduled: true` in its metadata.

A design is `{ theme, files, settings, sections }` as in `@swarm/site-themes` (`Design`). `files: null` means the built-in theme's files.

## The template language

A small, Liquid-flavoured language. It is interpreted from a parsed tree, never evaluated as code, and it escapes everything by default.

- **Output:** `{{ post.title }}`, `{{ section.settings.heading | default: site.name | truncate: 80 }}`.
- **Conditions:** `{% if a %}`, `{% elsif b %}`, `{% else %}`, `{% endif %}`; `{% unless a %}…{% endunless %}`. Comparisons `==`, `!=`, `<`, `>`, `<=`, `>=`, `contains`, joined with `and` and `or` (read left to right).
- **Loops:** `{% for post in posts limit: 3 offset: 1 %}…{% else %}nothing yet{% endfor %}`, with `forloop.index`, `forloop.first`, `forloop.last`, `forloop.length`.
- **Sections:** in `layout.html`, `{% sections %}` draws the page's sections in the owner's order. `{% section 'name' %}` draws one fixed section.
- **Snippets:** `{% render 'post-card', post: post, size: 'large' %}`. A snippet sees only what it is given, plus `site`, `reader` and `theme`.
- **Swarm parts:** `{% subscribe_form %}` (the publication's signup form, with its bot check, consent and steps), `{{ post.image | image: '(min-width: 960px) 33vw, 100vw' }}` (a responsive, sized image), `{{ site.logo | image: '72px' }}`.
- **Comments:** `{% comment %}…{% endcomment %}`.
- **Filters:** `default`, `truncate`, `truncatewords`, `date` (`'long'`, `'short'`, `'month'`, `'year'`), `number`, `plural: 'issue', 'issues'`, `upcase`, `downcase`, `capitalize`, `strip`, `size`, `first`, `last`, `image`, `url_encode`, `escape` (a no-op: output is always escaped).

### What a template can read

| Name       | What                                                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site`     | `name`, `description`, `url`, `logo`, `subscriber_count` (null below 100 or when hidden), `issue_count`, `nav` (`label`, `url`, `current`), `archive_url`, `about_url`, `plans_url` (null without paid plans), `has_paid_plans` |
| `reader`   | `is_subscriber`, `is_paid`                                                                                                                                                                                                      |
| `posts`    | the latest public issues, newest first (up to 24): `title`, `url`, `excerpt`, `date`, `reading_minutes`, `image`, `is_paid`, `is_pinned`, `author`                                                                              |
| `pinned`   | the pinned issues, same shape                                                                                                                                                                                                   |
| `featured` | the pinned issue, else the latest                                                                                                                                                                                               |
| `theme`    | the theme settings' values                                                                                                                                                                                                      |
| `section`  | inside a section: `settings`, `id`, `type`, `index`                                                                                                                                                                             |
| `page`     | `path`                                                                                                                                                                                                                          |

### Settings types

`text`, `textarea`, `url` (https, mailto or a path on the site), `color`, `font` (one of the built-in fonts, or the media id of a font uploaded to the media library), `select` (`options`), `checkbox`, `range` (`min`, `max`, `step`, `unit`), `number`, `image` (a media library item), and `list` (repeating items with their own `fields`, `max` items: benefits, testimonials, FAQ). Each has `id`, `label`, optional `default`, `info` and `max`. A `color` setting marked `"text_on": true` is one that text in the theme's ink colour sits on, so the dashboard warns when that text would be hard to read (Zine's second and third inks use it). The dashboard draws a control for each; the server checks every value against its type.

## Standard tokens

Every built-in theme declares these, so switching themes keeps the owner's style; a custom theme may add its own.

| Token                       | Values                                                                              | Becomes                                                                |
| --------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `accent`                    | colour                                                                              | `--accent`, `--on-accent` (picked for contrast)                        |
| `page`, `ink`               | colour                                                                              | `--page`, `--surface`, `--ink`, `--text`; muted text and lines derived |
| `scheme`                    | light, dark, auto                                                                   | dark values derived from the light ones when auto or dark              |
| `heading_font`, `body_font` | grotesk, archivo, serif, geist, inter, system, mono, or an uploaded font's media id | `--font-heading`, `--font`                                             |
| `scale`                     | compact, regular, large                                                             | `--step-*` type scale                                                  |
| `corners`                   | square, soft, round                                                                 | `--r-card`, `--r-control`                                              |
| `width`                     | narrow, regular, wide                                                               | `--wrap`                                                               |
| `buttons`                   | solid, outline, pill                                                                | button rules                                                           |

## Safety

The site promises fast pages with no third-party requests and no surprise code, so theme files are checked when saved, and the parsed tree is what renders.

- **HTML:** elements and attributes come from an allowlist. No `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, `<link>`, `<meta>`, `<base>` or `<form>` (the signup form comes from `{% subscribe_form %}`), and no `on…` attributes. Scripts and analytics stay where they are today: Website → Custom code, behind the cookie popup and the CSP.
- **Addresses:** links may be `https:`, `http:`, `mailto:`, `#…` or a path on the site. Images and other files must come from the media library (`/media/…`) or be `data:image/…`, so a theme never makes a reader's browser call another server.
- **Placeholders know where they are.** Output in text is HTML-escaped. Output inside a quoted attribute is attribute-escaped. Output in `href` or `src` is also checked as an address and dropped if it isn't a safe one. Output is refused in unquoted attributes, in `style` attributes and inside tags' names. A control tag (`if`, `for`) may sit inside a quoted attribute value only when it leaves the HTML state as it found it.
- **CSS** follows the custom CSS rules (`customCssProblem`): no `@import`, no `url()` except `data:image`, no escapes, nothing that runs code.
- **Limits:** loops only walk data Swarm provides (at most 24 posts, 20 list items); snippets nest at most 4 deep; one page renders at most 200,000 steps and 512 KB, or the published theme is used instead and the error is logged.
- **Required:** the home page must offer a way to subscribe to visitors (`{% subscribe_form %}` somewhere they see it) and have one `<h1>`. Missing either is an error at publish, with the line.

## Draft, preview, publish

- **Draft:** the dashboard saves the design as it changes (`PUT /channels/{id}/site/design/draft`). Saving checks the files and returns problems with file, line and column.
- **Preview:** the preview pane is the real site rendered from the draft: the site worker serves `/_swarm/preview` with a short-lived signed token (`site-preview` purpose in `@swarm/tokens`), never cached, with a "Preview" bar. It can show as a visitor, a subscriber or a paid subscriber, at phone or desktop width.
- **Publish** (`POST …/site/design/publish`) copies the draft to live, bumps the site's cache version and keeps the previous design as a version (the last 20). **Restore** puts a version back into the draft.
- **Scheduled publish** (`PUT …/site/design/schedule`): an editor schedules the draft to publish at a time at least 5 minutes and at most 90 days ahead. Scheduling takes a snapshot of the draft as it is then, so later edits to the draft don't change what goes live. A publication has one schedule at most; scheduling again replaces it. Scheduling is refused (422 with the problems) while the draft has errors, exactly like Publish. Viewers see the schedule; editors and up schedule, change and cancel it (`DELETE …/schedule`). Cancel removes the schedule; the row stays as `cancelled` (read as no schedule, never claimed) so the dashboard's Undo can put the same snapshot back within 10 minutes (`POST …/schedule/restore`), and scheduling again replaces it.
  - **At the time:** the jobs worker's five-minute cron claims the due schedules (a conditional `UPDATE … RETURNING` that sets a claim token and a 10 minute lease, so two runs never take the same one), checks the snapshot again (a built-in theme may have changed since) and publishes it exactly as Publish does, through the same function (`publishSiteDesign` in `@swarm/engine/site-design`): the published design, a version (trimmed to the last 20), the A/B tests it runs (`published_tests`), the cache version bump and the audit entry, its actor the person who scheduled it. Every write in that batch is conditional on the claim still holding, and the batch ends by deleting the schedule, so a schedule that was replaced or cancelled meanwhile, or taken by another run after the lease, publishes nothing. It can publish up to five minutes late, so the dashboard says "around".
  - **When the check fails** nothing is published: the schedule is marked `failed` with the problems, and the dashboard shows the first one until someone dismisses it (Cancel) or schedules again.
  - **Publishing by hand before the time** leaves the schedule alone in the API. The dashboard asks in the toast that confirms the publish, which offers Cancel schedule.
  - **In the dashboard:** Publish is a split button. The main part publishes now; its menu has Schedule…, which opens a form under the bar: a date and time in the person's time zone (named), quick picks (Tomorrow 09:00, Monday 09:00) and a line saying what will go live ("The draft as it is now: Launch theme, 7 sections"). While a schedule waits the bar says "Scheduled for Mon 10 Nov, around 09:00", with Change and Cancel (Cancel offers Undo in its toast); a failed one says "Didn't publish at 09:00:" and its first problem, with See problems and Dismiss. Viewers see the line without the actions.
  - **Where:** `site_design_schedules`, one row per Channel: the snapshot, `publish_at`, who scheduled it and when, the status, the problems and the claim.
- **Export and import:** a theme downloads as one JSON file of its files, and imports the same way, so designers can share themes.

## How it renders

`@swarm/site-themes` holds the language (parse, check, render), the settings types, the token rules and the built-in themes. The API uses it to check what is saved; the site worker uses it to render the home page from the published design (parsed trees are cached per design version); the dashboard uses it for instant checks while typing and for the placeholder reference.

Pages other than the home page keep their own markup but take the design's tokens and `theme.css`, so the whole site looks like one design.

## Working on the built-in themes

The files live in `packages/site-themes/themes/<id>/`. After changing them, run `pnpm --filter @swarm/site-themes build:themes` (it writes `themes/generated.ts`; a test fails when that is out of date). `pnpm --filter @swarm/site-themes gallery <dir>` renders every theme with sample data inside the real site stylesheet, light and dark, as a visitor and a subscriber; `--shoot` adds screenshots and checks that the form is in the first screen and nothing scrolls sideways, `--axe` runs axe-core, and `--thumbs` rewrites the dashboard's gallery images in `apps/dashboard/public/theme-thumbs/` (each in the theme's default colour scheme; with `--only` just those themes').

## Section analytics

Counted without cookies, script or anything from another server, like the site's page views:

- **Reached:** each section of the published design's home page ends, inside its wrapper, with a 1×1 same-origin image the browser loads lazily, so it is fetched only when the reader scrolls near the section (browsers start a little ahead of the screen, about one screen): `<img src="/_swarm/r?d=<design version>&s=<section id>&v=<a|b>" alt="" width="1" height="1" loading="lazy" decoding="async" aria-hidden="true" class="t-beacon">`, which `.t-beacon` keeps out of the layout. The engine adds nothing itself: the site passes the image through the render hook `sectionEnd(sectionId, variant)`. `/_swarm/r` answers a transparent GIF with `cache-control: no-store` and, after the response, adds one reach, but only for what a page view would count (not a bot or a verified crawler, not a prefetch or prerender, with a User-Agent and an IP), never from a preview, and only for the published design's current version, a section it shows and, for B, a section whose test is running. The request carries the version, the section id and the variant, nothing about the reader. Previews and a design still made from the old template settings draw no beacon.
- **Signups:** `{% subscribe_form %}` inside a section gets hidden `sw_section` and `sw_variant` inputs (through the hook `subscribeForm({ sectionId, variant })`; a form in the layout gets none). On a successful plain post from the Channel's own site (its platform address or an active web hostname), the capture worker adds one signup for that section and variant, counted like the form's submissions; the fields are used for nothing else, and invalid values are ignored.
- **Where:** `site_section_daily`, one row per Channel, UTC day, section id and variant (`reached`, `signups`), with nothing about the reader. Like the other site analytics rollups it is kept as long as the Channel and deleted with it. The dashboard shows each section's reached, signups and signup rate for the last 7, 30 or 90 days, beside the section in the list (`GET …/stats`).

## A/B tests on a section

- **A test is a second set of settings for one section:** in the dashboard, "Test a variant" on a section copies its settings into variant B, which is edited like the original. In the design it is the section's `experiment`: `{ id, status: "running" | "ended", variantB, startedAt, endedAt?, winner?: "a" | "b" }`. Saving checks B's values against the section's schema like A's. A design runs at most 3 tests at once, one per section.
- **Assignment:** each home page view is given A or B at random at the edge, before the cache. Publishing stores the section ids of the running tests beside the published design (`site_designs.published_tests`), so the site reads them with the Channel and needs nothing more to choose. The edge cache key gets the choice after the reader class (`…/anonymous.ab-hero-1=b,faq-3=a/`), so a copy drawn for one set of variants is only served for that set, and publishing bumps the cache version, so one design's copies never meet another's. While tests run, the home page tells browsers and other caches `private, no-cache`, so nothing outside the edge keeps one variant for the address. There is no cookie, so a reader who comes back may see the other variant; results are per view, which is honest about that and keeps the site cookieless.
- **Results:** reached and signups per variant, counted from the day the test started (UTC) to the day it ended, the signup rate of each, and how sure the difference is (a two-proportion z-test; `@swarm/site-themes` `testResult`, so the API and the dashboard agree): "B is ahead: 4.1% against 3.2%, 96% sure", or "Not enough yet: about 1,800 more views to tell". A result is called at 95% with at least 100 views on each side; the views still needed assume the rates stay as they are. Nothing is decided for the owner.
- **Preview:** the dashboard's preview can show variant B (Preview as → Variant B, or the A | B switch on B in a section's settings), through `?variant=b` and `&section=<id>` on the preview address. A preview is never counted.
- **Ending:** "Use B" puts B's settings into the section and ends the test; "Keep A" ends it and drops B. Either goes into the draft (`status: "ended"`, `endedAt`, `winner`), to publish like any change. Ended tests keep their results.

## Uploaded fonts

- The media library also takes WOFF2 and WOFF fonts (up to 2 MB), checked by their bytes like images (`wOF2` and `wOFF` at the start, and the header's length matching the file), through the same upload scan. They are stored as `font/woff2` and `font/woff`; a media asset says `kind: "font"` (`image`, `font` or `file`, from its type), and `GET …/media?kind=font` lists them (`kind=file` lists the other files). The asset's alt text is the font's name. Uploading in the dashboard asks the owner to confirm the licence allows use on a website, a required checkbox in the upload form; the server stores no answer.
- An uploaded font is a choice in every `font` setting, beside the built-in ones; its value is the media id. `tokensCss` and `designCss` take an optional lookup, `font(id) => { url, family } | null`, and add one `@font-face` per uploaded font used: `font-family: 'Swarm Upload <12 hex of the id>'`, `src: url('/media/…') format('woff2' | 'woff')`, `font-weight: 100 900`, `font-display: swap`. The family comes first in the stack and the setting's default (the theme's choice) after it, with its own face, so text looks right while the file loads or if it fails. The lookup's `url` must be a font on the site's own `/media/` path; anything else is never written, and the default is used. The owner's name for the font never reaches the CSS.
- The site worker looks up the fonts a design uses (`fontMediaIds`) in one media query (this Channel's public, not deleted, `font/*` media) for the published stylesheet and for the preview, and passes the lookup to `designCss`. Readers load them from the site's own `/media/`, which `font-src 'self'` allows, so they never load fonts from another server. Fonts from `/media/` are served with their type, a year's immutable cache and `Access-Control-Allow-Origin: *`; the site itself doesn't need it (same origin), but the dashboard draws each font's name in its face from the media origin.
- The API needs nothing new: a draft with a media-id font is checked by the engine like any value, and the dashboard finds the fonts' names and addresses through the media list (`kind=font`).
- In Style, the font menu lists the built-in fonts, then "Your fonts" (this publication's uploaded fonts, each name in its own face), then "Upload a font…", which opens the upload form in place and chooses the font once it is uploaded.
- A font that is later deleted falls back to the theme's default for that setting, and the Style panel says so under the control.

## What this gives owners, compared with the platforms they come from

- Eight starting designs built for conversion: the form is above the fold at every width, with proof (count, testimonials), a sample of the writing (latest or featured issue), the author and the promise (how often, what it's about).
- Every section and every token is a control, and every control is declared in the code, so designers can extend the editor itself.
- Full code access with placeholders, safely: no scripts, no third-party requests, and errors with line numbers before anything goes live.
- A real preview from the real renderer, as a visitor or a subscriber, on a phone or a laptop, before publishing; and every published version kept.
- Sections that show to visitors or to subscribers, so the home page sells to newcomers and serves readers.
- Fast and accessible by default: no client-side script on the page, one `<h1>`, alt text and contrast checked, dark mode derived.
