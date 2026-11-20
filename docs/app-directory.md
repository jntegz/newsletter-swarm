# App Directory

The App Directory (Phase 8, flag `app_directory`) lists OAuth apps that platform staff have reviewed, so operators can find and install them, and it shares community Flow Recipes the same way. It is built on the existing pieces: OAuth apps with PKCE (`docs/oauth.md`), Event Webhooks (`docs/webhooks.md`) and Flow Recipes. Nothing here creates a new way to reach a workspace's data: an installed app is an OAuth grant like any other.

Code: `packages/domain/src/p8-app-directory.ts` (schemas, statuses, the manifest), `packages/engine/src/app-directory.ts` (manifest checks and the recipe sanitiser), `workers/api/src/routes/appDirectory.ts` (listings, the directory, review, the public endpoint) and `routes/recipeSubmissions.ts` (community recipes), `apps/dashboard/src/pages/AppDirectory.tsx`, `AppListings.tsx`, `CommunityRecipes.tsx`. Tables: `app_listings`, `recipe_submissions`, `platform_staff` (`migrations/0024_app_directory.sql`).

## Who does what

| Who                                       | Can                                                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Admin or owner of the app's workspace     | Create, edit, submit, withdraw and delete the app's listing; import and export its manifest              |
| Any seat in a workspace                   | Browse and search approved listings                                                                      |
| Admin or owner                            | Install an app (the consent step needs admin, as before), see installed apps, revoke them                |
| Editor or higher on a Channel             | Submit one of the Channel's Flows as a community recipe; create a Flow from an approved community recipe |
| Viewer or higher on a Channel             | See the approved community recipes                                                                       |
| Platform staff (with a proved 2nd factor) | See the review queue; approve, reject or delist listings and recipes                                     |
| Anyone (no sign-in)                       | Read approved listings through the public endpoint                                                       |

## The flag

`app_directory` is off by default and enforced on the server:

- Workspace routes (listings, the directory, installed apps) resolve it for the workspace; Channel routes (community recipes) for the Channel. Off answers `404 feature_disabled`.
- The public endpoint resolves it at platform scope only, so the directory becomes public when the platform turns the flag on, not when one workspace does.
- Staff routes do not check the flag: they only see rows that flag-gated routes created, and staff must be able to delist something after a workspace turns the flag off.

## Platform staff

Before Phase 8 the codebase had no platform-level administrator: every permission is a seat in a workspace, and platform-scope flags are set with SQL. The directory needs one, so it adds the smallest mechanism that is safe:

- A table `platform_staff (operator_id, note, created_at)`. There is **no API or dashboard route that writes it**; rows are added and removed with `wrangler d1 execute` (see `docs/deployment.md`, "Platform staff"). An operator cannot make themselves staff, and a compromised workspace owner gains nothing.
- Every staff route requires a session that has **proved a second factor** with a passkey, an authenticator app or a recovery code (`sessions.mfa_method` is `passkey`, `totp` or `recovery`). A session that signed in with QuickPass alone, or whose second factor came from an SSO identity provider, is refused with `403` and the detail `secondFactor: staff_second_factor_required`. The grace period that lets new owners work without a factor does not apply to staff.
- To anyone who is not staff, staff routes answer `404`, so their existence is not revealed.
- Review decisions are written to the audit log **of the workspace that owns the listing or recipe** (actor: the staff operator), so developers see who reviewed their submission and when.

## Listings

One listing per OAuth app (`app_listings.app_id` is unique). The app must be registered by the same workspace and not revoked. Fields:

| Field                                    | Rules                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `name`                                   | 1–80 characters                                                                                                     |
| `slug`                                   | lowercase letters, digits and `-`, 2–50 characters, unique across the directory; derived from the name when omitted |
| `tagline`                                | 1–120 characters                                                                                                    |
| `description`                            | up to 5,000 characters of plain text (shown with line breaks; no HTML or Markdown is rendered)                      |
| `iconMediaId`                            | an image in this workspace's Media (uploaded or picked in the dashboard); required to submit                        |
| `screenshotMediaIds`                     | up to 6 images in this workspace's Media                                                                            |
| `categories`                             | 1–3 of `APP_CATEGORIES`                                                                                             |
| `scopes`                                 | the scopes the app asks for; at least one, and every one must be among the app's registered scopes                  |
| `webhookEvents`                          | the Event Webhook types the app subscribes to (may be empty)                                                        |
| `websiteUrl`, `supportUrl`, `privacyUrl` | https addresses (a `mailto:` is accepted for support); all three are required to submit                             |
| `installUrl`                             | the https address on the app's side that starts the authorization request (see "Install"); required to submit       |

Media must be an image (not a PDF), public, not deleted, and belong to the listing's workspace; anything else is `400`. URLs use the same checks as redirect URIs: absolute https, no credentials, no fragment (plain http only in local development).

### Statuses

```
draft ──submit──▶ submitted ──approve──▶ approved ──delist──▶ delisted
  ▲                  │  └────reject────▶ rejected
  └──── edit ────────┴──── (any status) ──┘
```

- `draft`: being written. Only the developer sees it.
- `submitted`: waiting for review. Submitting checks the required fields again and that the scopes are still within the app's.
- `approved`: in the directory. Staff may attach a note.
- `rejected`: staff must give a reason (`note`, 1–1,000 characters); the developer sees it.
- `delisted`: removed from the directory, by staff (with a reason) or by the developer (Withdraw).
- **Any edit returns the listing to `draft`**, including edits to an approved listing, which leaves the directory until it is approved again. Decision: what the directory shows is always exactly what staff approved, with no second copy to keep in sync. Developers who want to stay listed should edit rarely; the dashboard says so before saving an approved listing.
- **Changing what staff saw on the app itself also returns the listing to `draft`**: a new name, redirect URI or homepage, or a scope the app did not have, saved in Settings → Developers → OAuth apps. Removing scopes does not. The consent page's Verified pill vouches for an app as staff reviewed it, so it stays off until the listing is approved again.
- A rejected or delisted listing can be edited and submitted again. Deleting a listing removes it (any status).
- Revoking the OAuth app hides its listing from the directory and from the public endpoint at once (the queries require an unrevoked app); the listing row stays so the developer can see it.

Every change is audited in the developer's workspace: `app_listing.created`, `.updated`, `.submitted`, `.withdrawn`, `.deleted`, and from staff `.approved`, `.rejected`, `.delisted`.

### What the directory shows about scopes

A listing's `scopes` are what the developer declares. Because the app may register more scopes than the listing declares, the directory also shows `extraScopes`: registered scopes that the listing does not declare, under "May also ask for". The consent page always shows the scopes of the actual request, in the same plain-language labels (`SCOPE_LABELS`).

## Browsing and installing

- Settings is not where operators look for apps, so the directory is its own page, **Apps** (`/apps`) in the main navigation, with tabs: Directory, Installed, and Review (staff only).
- `GET /api/v1/workspaces/{workspaceId}/app-directory?q=&category=` lists approved listings of unrevoked apps (any seat), newest approval first, up to 100. `q` matches the name, tagline and description (case-insensitive substring; the directory is small enough that a full-text index is not worth its write cost). Each listing carries `installedGrantId` when the app already has an active grant on this workspace.
- `GET …/app-directory/{slug}` returns one listing with the scopes in plain language.

### Install

**Install opens the app's `installUrl`**, after the dashboard shows the scopes it will ask for in plain language. The app then sends the browser to `/oauth/authorize` with its own PKCE challenge, and the existing consent page (workspace and Channel choice, scopes, Allow) completes it.

Decision: Swarm never builds the authorization request for the app. The PKCE `code_verifier` must stay with the client that redeems the code; if the dashboard created it, the app could not complete the exchange, and handing the verifier over would defeat PKCE. A listing therefore has to name an `installUrl`, and submission refuses one without it. The consent page is unchanged; it already shows the requested scopes in plain language and refuses operators below admin.

### Installed apps

The Installed tab is the existing list of apps authorised on the workspace (`GET /api/v1/workspaces/{workspaceId}/oauth-grants`, admin) with **Revoke access** (`DELETE …/oauth-grants/{grantId}`), matched to listings for their icon. Apps installed without the directory appear too. Nothing new was added to the grant model.

## The open plugin specification (app manifest)

A manifest is a JSON document that describes an app's listing, OAuth settings and webhook use. Developers keep it in their repository and import it instead of filling in the form. Its schema is `AppManifestSchema` in the domain package; the JSON Schema is published at `GET /api/v1/public/app-manifest.schema.json` and committed as `docs/app-manifest.schema.json` (regenerated by `pnpm openapi`; a domain test fails when it is stale).

```json
{
  "$schema": "https://app.swarm.example/api/v1/public/app-manifest.schema.json",
  "manifestVersion": 1,
  "listing": {
    "name": "Sheet Sync",
    "slug": "sheet-sync",
    "tagline": "Keep a spreadsheet of your Members up to date",
    "description": "Adds a row for every new Member and updates it when they change.",
    "categories": ["import_export", "productivity"],
    "websiteUrl": "https://sheetsync.example",
    "supportUrl": "mailto:help@sheetsync.example",
    "privacyUrl": "https://sheetsync.example/privacy",
    "installUrl": "https://sheetsync.example/swarm/install"
  },
  "oauth": {
    "clientType": "confidential",
    "redirectUris": ["https://sheetsync.example/swarm/callback"],
    "scopes": ["members:read"]
  },
  "webhooks": { "events": ["member.created", "member.updated"] }
}
```

Rules:

- `manifestVersion` is `1`. A later version will get a new number; the server refuses numbers it does not know (`400`), so a manifest never silently loses fields.
- Unknown top-level and nested keys are refused (`400`), except `$schema`.
- The manifest **describes** an app; it does not change its registration. On import (`POST /api/v1/workspaces/{workspaceId}/app-listings/import`, `{ appId, manifest }`) the server checks it against the registered app: the same `clientType`, every `redirectUris` entry registered exactly, and every scope registered. A mismatch is `400` with one detail per problem, so the developer fixes the app or the manifest.
- Import creates the app's listing, or replaces the fields of its existing one, as a `draft`. The icon and screenshots are not part of the manifest: Swarm does not fetch images from other servers (that would be a server-side request to an address the developer chose, and unreviewed content in our bucket). They are added from Media in the dashboard.
- `GET …/app-listings/{listingId}/manifest` exports the listing and its app as a manifest, so the round trip is lossless.

## Community Flow Recipes

Operators can share one of their Flows as a recipe. It is reviewed like a listing and, once approved, appears next to the built-in Flow Recipes when anyone creates a Flow.

### Submitting

`POST /api/v1/channels/{channelId}/recipe-submissions` (`{ flowId, name, description }`, editor) copies the Flow's **draft graph** and its Flow emails into a sanitised recipe and stores it as a `draft`. The response includes `removed`: what was taken out, per step, so the operator sees exactly what will be shared before submitting (`POST …/{submissionId}/submit`). A submission can be withdrawn or deleted by an editor of the Channel. The sanitised copy is all that is stored; later changes to the Flow do not reach it (submit again instead). A Flow with no email step is refused: a recipe without emails gives nothing to start from.

### What is stripped

Sanitising is an allowlist: everything not listed as kept is removed. `sanitizeFlowRecipe` in `packages/engine/src/app-directory.ts`, tested on every node type.

| In the Flow                                               | In the recipe                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trigger                                                   | the event kept; `includeImports`, `days` and an API event `name` kept; form, Circle, tag, field, level, Ask, option, Dispatch and URL removed; the enrolment `filter` removed (a Circle rule can hold addresses and field values)                                                                        |
| Send email                                                | the email kept as recipe text (below); `audience` kept; the Dispatch id replaced by a key                                                                                                                                                                                                                |
| Delay, A/B split, exit                                    | kept as they are                                                                                                                                                                                                                                                                                         |
| Wait for event                                            | event, timeout and the watched step kept; the URL removed                                                                                                                                                                                                                                                |
| Add/remove tag, update field, change level, enrol in Flow | the step kept with its kind (and level action and days); the tag, field, value, level and Flow removed                                                                                                                                                                                                   |
| Branch                                                    | the step kept; its condition removed (Circle rules can hold addresses and field values)                                                                                                                                                                                                                  |
| Webhook call                                              | the step kept; **the URL removed** (it can carry tokens) and `includeFields` kept. The Flow's webhook secret is never read                                                                                                                                                                               |
| Notify author                                             | the message kept with addresses redacted; the operator list removed (it then goes to the Channel's admins)                                                                                                                                                                                               |
| Step names                                                | kept with addresses redacted                                                                                                                                                                                                                                                                             |
| Email subject and preheader                               | kept with addresses redacted                                                                                                                                                                                                                                                                             |
| Email body                                                | paragraphs, headings, lists, quotes, rules, line breaks and buttons kept; text styles kept; links and button addresses kept only when `https`, **with the query string and fragment removed**; `mailto:` links removed. Images, link cards, attachments, polls, Gates, Smart Blocks and raw HTML removed |

Addresses (anything shaped like an email address) are replaced with `[email]`. Merge tags such as `{{member.first_name}}` are kept: they are placeholders, not data. Regular expressions cannot find every name or phone number a writer may have typed into an email, so **staff review is the second check**: the review screen shows the full sanitised text.

### Using a community recipe

`GET /api/v1/channels/{channelId}/community-recipes` (viewer) lists approved recipes; `POST …/community-recipes/{recipeId}/flows` (editor) creates a draft Flow from one: its emails become Flow emails (Dispatches of kind `flow`), complete steps go into the draft graph, and steps whose Channel-specific settings were removed are saved as **pending steps** (`draftPending`), which the Flow builder shows as "Finish setting up this step". Publishing refuses while any remain, as for any Flow. Community recipes are shown without the submitting workspace's name: the name of a workspace is often a person's name, and the recipe is what matters.

## Public endpoint

`GET /api/v1/public/apps?q=&category=` and `GET /api/v1/public/apps/{slug}` return approved listings without signing in: name, slug, tagline, description, icon and screenshot URLs, categories, scopes with labels, webhook events, website, support and privacy URLs, and the install URL. Never the client id, the workspace's name or review notes. Icon and screenshot URLs are the public Media addresses, as in any Dispatch.

- **Flag:** platform scope only (above). Off answers `404`.
- **Rate limit:** 60 requests a minute per client network (the IP prefix used in audit entries: /24 for IPv4, /48 for IPv6), a token bucket in the realtime worker's `ApiRateLimiter` (the `/v2` binding). Over the limit is `429` with `Retry-After`. A local worker without the binding is unlimited, as for `/v2`.
- **Caching:** `Cache-Control: public, max-age=300, stale-while-revalidate=600`, so a CDN or the browser can serve repeat requests. A listing that is delisted can therefore stay visible for up to five minutes.
- **CORS:** `Access-Control-Allow-Origin: *` without credentials, so a marketing site can show the directory. The response never depends on the caller's cookies.
- `GET /api/v1/public/app-manifest.schema.json` returns the manifest JSON Schema, same caching, no flag (it is documentation).

## Review

Staff routes (`/api/v1/app-directory/review/…`):

- `GET …/review` the queue: submitted listings and recipes, oldest first, with the app's registered scopes and redirect URIs and the full sanitised recipe. Each listing carries a `reviewVersion` naming the listing and app as shown.
- `POST …/review/listings/{listingId}` and `…/review/recipes/{submissionId}` with `{ decision: 'approve' | 'reject' | 'delist', note?, version? }`. Approve and reject need `submitted`; delist needs `approved`. Reject and delist need a note. A decision on a row in another status is `409`.
- Approving a listing needs `version`, the `reviewVersion` from the queue (without it, `400`). If the listing or its app changed after the queue was loaded, the decision is `409` "It changed while you were reviewing.", even when the listing is back in `submitted` (edited or changed on the app, then submitted again). The dashboard sends the version it showed and reloads the queue after a refusal.

The dashboard's Review tab shows each item with what to check: the app's real scopes against the declared ones, the URLs, and for recipes the whole text.

## Not built

- Paid apps, ratings, reviews and install counts.
- Showing "listed in the App Directory" on the consent page.
- Hosting manifests at a well-known URL on the developer's site and re-reading them.
- Email notices to developers when a review decision is made (the decision and note are shown in the dashboard and audit log).
