# Link Hub

A link-in-bio page on the Channel website, at `/links` on the platform subdomain and on every custom domain, with click analytics built in. Flag `link_hub` (Phase 8, part 3). Tables: `hub_settings`, `hub_links` and `hub_link_clicks_daily` (`migrations/0021_link_hub.sql`). Schemas: `packages/domain/src/p8-link-hub.ts`; logic: `packages/engine/src/link-hub.ts`; page and redirect: `workers/site/src/routes/hub.ts`; API: `workers/api/src/routes/linkHub.ts`; dashboard: Site Studio → Link Hub.

## The page

`GET /links` renders on the server like every other site page: the Channel's stylesheet (accent colour, font, colour scheme from Site Studio), no script, nothing from third parties. In order:

1. the Channel's logo, the page title (the Channel name when none is set) and a short bio;
2. social profiles, as labelled links (`rel="me noopener"`);
3. the links, in the operator's order, each with its title and an optional thumbnail from the workspace's Media;
4. the latest Dispatches on the site (0 to 10, 3 by default), linking to their pages;
5. a Capture Form (optional, on by default).

The page answers 404 (the site's normal not-found page) when the flag is off for the Channel or the operator has not switched the page on. It is a compact page of its own, not the full site shell: no header navigation or search, a footer that links to the site's home page and the subprocessor list.

**Scheduled links.** A link with `startsAt` is hidden before it; a link with `endsAt` is hidden from that moment. The page is cached at the edge like other site pages (per reader class, keyed by `cache_version`), but for 60 seconds instead of 5 minutes, so a scheduled link appears or disappears within about a minute without any job running. Every write through the API bumps `cache_version`.

**Capture Form.** With `showCaptureForm` on, the page shows `captureFormId` when it names a published form of this Channel that the site can render (the same checks as the site's own form: the site's origin is allowed and no required profile fields); when it is null or the form stops qualifying, it shows the Channel's site form, or the plain email form. The form posts to the capture worker exactly like the subscribe form on every other page, so Turnstile, confirm opt-in and Champion codes all apply.

**Path.** `links` is added to the reserved site paths, so a custom page can no longer take `/links`. A redirect from `/links` set up in Site Studio still runs first, as for every path.

## Clicks

Every link on the page points at a first-party redirect, `/_swarm/hub/<linkId>`, on the same host.

- **No open redirect.** The target is read from `hub_links` by id, scoped to the Channel resolved from the Host header; nothing in the request can name a target. A link id of another Channel answers 404. The target is checked again before redirecting (`hubLinkUrlProblem`).
- **Only http and https.** Targets must be absolute `http://` or `https://` URLs with a host and no user name or password (also enforced by a `CHECK` in the table). `javascript:`, `data:` and relative targets are refused when the link is saved. Plain http is allowed because many link-in-bio targets still use it; nothing is fetched by Swarm, so there is no server-side request risk.
- **Outside its window** (not started, or ended) the redirect sends the visitor back to `/links` with a 302; a missing link, a switched-off page or a flag that is off answers 404.
- **The response** is `302` with `Cache-Control: no-store` and `X-Robots-Tag: noindex`; it is never stored in the edge cache.

**Counting.** A click is counted when the request is a GET with a User-Agent, is not a bot by the same test as page views (Cloudflare verified bots, automated User-Agents, known AI crawlers) and is not a prefetch or prerender (`Sec-Purpose` / `Purpose`). Counting happens after the response (`waitUntil`), so a slow write never delays the visitor. Counting a click on a GET is analytics, like page views and the email click tracker; it changes nothing the visitor or operator owns.

**No cookies, no identifiers.** Nothing is set on the visitor and no IP address, User-Agent or hash is stored. A click is one increment of a daily row `(channel, UTC day, link, source, country)` in `hub_link_clicks_daily`. Because nothing identifies a visitor, there are no unique-clicker counts; the page's own views and visitors come from the existing site analytics (`/links` in Site Studio → Analytics), and the Link Hub report puts them next to the clicks.

**Source.** The interesting referrer is where the visitor came to the page from, not the page itself. So the site edge, after the cache, adds `?s=<source>` to each link on the page for this request (`edge/hub.ts`, an HTMLRewriter pass like the Champion referral code), where the source is worked out exactly as for page views: `utm_source` of the page URL, else the referrer's host without `www.` (`internal` for the site's own host), else `direct`. The cached page never contains a source. At click time `s` is normalised again (lowercase, `[a-z0-9._-]`, at most 60 characters); without it the click's own Referer is used the same way. `s` is a label only: it never affects where the redirect goes.

**Country** is Cloudflare's `cf.country` (two letters, `XX` when unknown), as for page views.

Daily rows are kept as long as the Channel (like `site_page_views_daily`). Deleting a link keeps its rows; the report lists them as "Deleted link".

## API

Dashboard routes (cookie session), all behind the `link_hub` flag (`404 feature_disabled` when it is off) and `channelAccess` (a Channel the operator cannot see answers 404):

| Route                                                         | Role   | Purpose                                                      |
| ------------------------------------------------------------- | ------ | ------------------------------------------------------------ |
| `GET /api/v1/channels/{channelId}/link-hub`                   | viewer | Settings and every link (live or not), with the page address |
| `PATCH /api/v1/channels/{channelId}/link-hub`                 | editor | Change settings (switch the page on, title, bio, socials, …) |
| `POST /api/v1/channels/{channelId}/link-hub/links`            | editor | Add a link (at the end unless `position` is given)           |
| `PATCH /api/v1/channels/{channelId}/link-hub/links/{linkId}`  | editor | Change a link                                                |
| `DELETE /api/v1/channels/{channelId}/link-hub/links/{linkId}` | editor | Remove a link (its click history stays)                      |
| `PUT /api/v1/channels/{channelId}/link-hub/order`             | editor | Reorder: every link id once, in the new order                |
| `GET /api/v1/channels/{channelId}/link-hub/analytics`         | viewer | Clicks per link, per day, by source and country; page views  |

Limits: 50 links per Channel, titles up to 80 characters, targets up to 2,048 characters, a bio up to 280 characters, 12 social profiles. Thumbnails must be public images in the workspace's media library. Analytics ranges are whole UTC days, the last 30 by default, at most 366, with no plan limit (as for site analytics). Every write is in the audit log (`link_hub.*`) and bumps the site's `cache_version`.

**No `/v2` routes.** The public API has no Site Studio resources and no site scope yet, so Link Hub stays on the dashboard API. Adding it would mean new `site:read`/`site:write` scopes for all of Site Studio, which is a separate decision.

## Dashboard

Site Studio → Link Hub (`/site/<channelId>/link-hub`), shown when the flag is on for the Channel. Settings and links on the left, a live preview on the right that follows unsaved edits (it draws the page with the Channel's accent colour and colour scheme; scheduled links show as they will be at the current time). Links can be added, edited (with a media picker for the thumbnail and start and end times in the operator's local time), reordered with the Up and Down buttons, and removed. Below, the click report: totals, clicks by day, per link (with click-through against page views), sources and countries. Viewers and authors see everything read-only.

## Decisions

- **One page per Channel at `/links`.** No custom slug, so the path is predictable and reserved once.
- **Inside Site Studio**, as a tab, because it is part of the website and uses its theme.
- **Social profiles are Link Hub's own list** (network + https URL), separate from the SEO "Profiles elsewhere" (`sameAs`), because the page needs a label per profile and an operator may want different ones. They are not click-counted.
- **Latest Dispatches and the form link directly**, not through the counter: they are on the Channel's own site and show up in its page analytics.
- **Clicks only, no unique clickers.** Uniques would need a per-link visitor hash table; the daily-salted hash already exists for page views and is enough to read the page's reach.
- **60-second edge lifetime** for `/links` instead of a cron that bumps `cache_version` at every start and end time.
- **No Analytics Engine data point** for clicks: the existing dataset has the page-view layout, and D1 rollups answer every question the report asks.
