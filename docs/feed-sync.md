# Feed Sync

Feed Sync (Phase 8, flag `feed_sync`) turns the items of an RSS 2.0, RSS 1.0, Atom or JSON Feed into Dispatches. Each Channel can follow up to 20 feeds, and a workspace up to 100 across its Channels (`FEED_SYNC_LIMITS.sourcesPerWorkspace`; a workspace already above it keeps its feeds, new ones are refused). The minute check takes at most 3 due feeds from one workspace, workspaces in turn. A feed source either drafts Dispatches for an editor to finish, or sends them on its own, one Dispatch per item or a digest of every new item. Dispatches → Feed Sync (`/channels/<id>/feeds`) in the dashboard; `/api/v1/channels/{channelId}/feed-sources` and `/v2/channels/{channelId}/feed-sources` in the API. Tables: `feed_sources` and `feed_items` (`migrations/0020_feed_sync.sql`). Schemas: `packages/domain/src/p8-feed-sync.ts`. Engine: `packages/engine/src/feed-sync.ts` (polling and Dispatches), `feed-parse.ts` (formats) and `feed-html.ts` (item HTML into the editor document).

## A feed source

| Setting        | Values                                                                | Meaning                                                                                                                                               |
| -------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| URL            | an https URL with a public host name                                  | The feed. Checked by the outbound URL guard when saved and on every fetch, redirects included.                                                        |
| Mode           | `draft`, `send`                                                       | `draft` leaves each Dispatch as a draft. `send` schedules it for now; the send worker runs the usual checklist and starts the Broadcast.              |
| Grouping       | `each`, `digest`                                                      | One Dispatch per item, or one Dispatch with every new item (at most `digestLimit`, oldest first; the rest wait for the next digest).                  |
| Content        | `full`, `summary`                                                     | The item's whole HTML, or its summary (at most 400 characters of text) with a link to the original.                                                   |
| Template       | a Template of kind `dispatch` in the Channel or workspace             | The frame. A paragraph whose whole text is `{{feed.items}}` is replaced by the items; without one, the items follow the Template's content.           |
| Subject        | text with `{{item.title}}`, `{{feed.title}}`, `{{count}}`, `{{date}}` | Defaults: `{{item.title}}` for `each`, `{{feed.title}}: {{count}} new` for `digest`. `{{date}}` is the day in the feed's time zone, e.g. 28 Oct 2026. |
| Audience       | Circles to include and exclude, and Rosters (flag `rosters`)          | The same `{ include, exclude, rosters }` as a Dispatch. Empty means every active Member.                                                              |
| Sender         | a sender identity of the Channel                                      | Empty means the Channel's default sender.                                                                                                             |
| Check every    | 15 to 1,440 minutes                                                   | How often the feed is fetched.                                                                                                                        |
| Frequency caps | `minGapMinutes` (0 to 10,080), `maxPerDay` (1 to 48)                  | The least time between two Dispatches from this feed, and the most in any 24 hours. They also set the digest's rhythm.                                |
| Digest days    | `digestSchedule`: `{ weekdays, time }` (0 = Sunday, HH:MM), or null   | Digests only. Made on these days at this time, in the feed's time zone. See below.                                                                    |
| Quiet window   | `quietStart`, `quietEnd` (HH:MM) and a `timezone`                     | No automatic send starts inside it. A window may cross midnight (22:00 to 07:00). Drafts are not held back.                                           |

Viewers can see feed sources, their items and the preview. Editors and above add, change, check and delete them: a feed in `send` mode sends Dispatches, and scheduling a Dispatch needs the editor role too. Every change is in the audit log (`feed_source.created`, `.changed`, `.paused`, `.resumed`, `.deleted`; `.paused` with no actor when errors turn it off). Dispatches made by Feed Sync are audited as `dispatch.created` with `metadata.feedSourceId` and no actor; automatic ones also emit the `dispatch.scheduled` webhook event.

## Polling

1. **When.** The jobs worker's minute cron (`runFeedSync`) takes up to 10 active feed sources whose `next_check_at` has passed, oldest first, and checks them three at a time. A Channel without the `feed_sync` flag is skipped and looked at again after its interval. "Check now" (POST `…/check`) runs the same check in the API request and answers with the result, a failed fetch included. It also works on a paused or turned-off source: a paused source's items wait until it is resumed. A turned-off `draft` source that checks successfully is turned back on (audited as `feed_source.resumed` with the person or credential that checked, `metadata.by = "check"`). A turned-off `send` source is never turned back on by a check: the check reports that the feed works again (`resumeRequired: true`), clears the error, stores its new items and makes no Dispatch; the items wait until someone resumes the source (status `active`), the same decision as resuming it from the dashboard, which an agent's approval mode holds (`update_feed_source` is destructive).
2. **One check at a time.** A check claims the source with a 2-minute lease (`lock_until`). A second check while one runs answers `409` ("A check is already running").
3. **Fetching.** `GET` with `If-None-Match` and `If-Modified-Since` from the last answer, `redirect: manual`, and an `Accept` naming the feed types. Every URL, the first and each redirect target (at most 3 hops), goes through `outboundUrlProblem` (https only, plain http in development; no credentials, IP literals, localhost, single-label, `.local`, `.internal` or `.home.arpa` hosts). The whole fetch has 10 seconds and the body at most 2 MB, counted while it streams. A redirect is followed for this fetch only; the stored URL never changes on its own.
4. **Answers.** `304` is a success with nothing new. `200` is parsed. Anything else, a timeout, a body over the limit or one that breaks off, or a feed that does not parse is a failure. An error that is not the feed's (a bug of ours, a D1 error, also while storing the new items of a scheduled check) is logged as an error and is not counted: the source's next check waits twice as long as the last wait (at least the interval, at most 24 hours), so a source that keeps hitting it never holds the front of the due window, and a bug can't turn sources off.
5. **Failures.** The error is kept on the source (`lastError`, shown on the dashboard) and the next check waits the interval times 2^(failures − 1), at most 24 hours. After 8 failures in a row the source is turned off (`status = 'disabled'`) and audited; resuming it clears the count. A success resets it.

## Parsing

- **Formats.** RSS 2.0 (`rss/channel/item`), RSS 1.0 (`RDF/item`), Atom 1.0 (`feed/entry`) and JSON Feed 1.0 and 1.1 (`version` starting `https://jsonfeed.org/version/1`). The format is detected from the body, not the content type.
- **XML safety.** The bounded reader from DMARC (`parseXml` in `dmarc.ts`), which now also keeps attributes: at most 32 levels and 400,000 elements, the five predefined entities and character references only, and a `DOCTYPE` is refused, so there are no DTDs and no entity expansion. JSON Feed uses `JSON.parse` on the bounded body.
- **Fields.** Item HTML is RSS `content:encoded`, else `description`; Atom `content` (`html`, `xhtml` or `text`), else `summary`; JSON Feed `content_html`, else `content_text`. The link is RSS `link`, Atom `link` with `rel="alternate"` (or no `rel`), JSON Feed `url`. Dates are RFC 822 or ISO 8601. The first image enclosure (`enclosure`, `media:content`, `media:thumbnail`, JSON Feed `image`) is shown when the item HTML has no image.
- **Limits.** The first 50 items of a fetch are read. Titles are cut to 300 characters, links and GUIDs to 2,048.

## Dedupe

An item's key is SHA-256 of `guid:<guid>` (RSS `guid`, Atom `id`, JSON Feed `id`), else of `link:<link>` plus its title. `feed_items` is unique on `(feed_source_id, key_hash)`, so a fetch that overlaps the last one, two checks at once, or a feed that reorders its items creates nothing twice. A feed that changes an item's GUID makes it a new item; that is the feed's call.

The first successful fetch of a new source records every item already in the feed as `skipped`, so adding a feed never sends its backlog. Only items that appear after that become Dispatches. Changing the URL starts again the same way.

The newest 500 items of a feed are kept (the daily cron drops older ones), which is far more than feeds list. Item content is kept while an item waits and for 14 days after.

## Making Dispatches

Fetching stores items as `new`; releasing turns them into Dispatches. Release runs after every check and on every minute cron for sources with new items, so caps and quiet windows are honoured even when the feed is quiet. Each minute looks at up to 25 such sources, at most 5 per workspace, the ones looked at longest ago first (`release_checked_at`), so sources whose items are held back can't keep other sources' items waiting.

- **Draft mode.** `each`: one draft per new item, oldest first, at most `maxPerDay` in 24 hours and `minGapMinutes` apart. `digest`: one draft with the new items when `minGapMinutes` has passed since the last one.
- **Digest days.** With `digestSchedule`, a digest goes when a slot has passed and nothing has gone since it, on top of the other limits. If nothing new is waiting within 24 hours of the slot, there is no digest until the next one, so a post that appears on Saturday doesn't make a "Friday" digest on Saturday. A slot from before the schedule was set releases nothing.
- **Send mode.** The same, plus: nothing starts inside the quiet window. A Dispatch is created as `scheduled` for the current minute; the send worker's scheduler starts it with the usual checklist (sender, domain, DMARC, audience, content). A Dispatch that fails the checklist goes back to draft, exactly like a scheduled one written by hand. So does one that can't be started for another reason six times in a row (tries back off from 2 to 32 minutes).
- **One per release.** Each release makes at most one Dispatch per source. With `each`, a burst of items leaves one a minute (or one per `minGapMinutes`), so a feed that publishes ten posts at once does not land ten emails in the same minute.
- **Counting.** The caps count Dispatches made from the feed (`feed_items.dispatched_at`), drafts included.
- **The item is claimed with the Dispatch.** The Dispatch, its first revision and the item status change are one D1 batch. A Dispatch deleted later leaves its items `dispatched`, so they are not sent again.
- **Sanitising.** Item HTML becomes editor nodes, never a raw HTML block, so it renders with `raw_html_mode` off and passes the same renderer as any Dispatch (`feed-html.ts`):
  - `p`, `h1` to `h6` (h1 → level 1, h2 → 2, the rest → 3), `ul`, `ol`, `li`, `blockquote`, `pre`, `hr`, `img`, `br`; `strong`/`b`, `em`/`i`, `u`, `s`/`strike`/`del`, `code` and `a` become marks.
  - `script`, `style`, `iframe`, `object`, `embed`, `svg`, `math`, `video`, `audio`, `canvas`, `form` and their contents are dropped; other tags (`div`, `span`, `table`, `figure`…) keep only their text and children.
  - Links keep http, https and mailto, resolved against the item link; anything else loses its link. Images keep `https` sources only, with their alt text.
  - At most 300 blocks and 64 KB of document per item.
- **Images stay remote.** Item images are linked from the feed's host, not copied into Media. Copying would mean fetching arbitrary image URLs from the jobs worker; the feed's own images are already public. An operator who wants them in Media can replace them in the editor before sending.
- **Each item ends** with a "Read the original" button for `each` and a linked heading per item for `digest`.

## Preview

GET `…/preview` renders the Dispatch the next release would make, with the source's Template, subject and content settings, without changing anything. When nothing is waiting it uses the newest item and says so (`sample: true`); before the first check there is nothing to show and it answers `409`.

## Targeting and Rosters

A feed source targets Circles and Rosters with the same audience as a Dispatch ([rosters.md](rosters.md#sending-to-rosters)): `rosters: { include, exclude, conflict }` next to the Circles, combined with them by AND, with the same conflict policy (`exclude_wins` by default). The Feed Sync dialog shows the same Roster panel as the Dispatch audience, with live counts.

- **Saving.** A Roster part needs the `rosters` flag for the Channel (`404 feature_disabled` otherwise, like every Roster route) and live Rosters of this Channel (`400`). An empty Roster part is dropped. The same rules apply on `/v2`.
- **Releasing.** `feedAudience()` (`packages/engine/src/feed-sync.ts`) copies the Circles and the Roster part into every Dispatch the source makes.
- **Sending.** The Dispatch's preflight checks the Rosters again. A Roster deleted since, or the flag turned off since, fails the audience check: a `send` mode Dispatch goes back to draft, and nothing goes out to a wider audience than the one chosen.

## API

| Method and path (`/api/v1/channels/{channelId}/feed-sources…`) | Role   | `/v2` (scope)                         |
| -------------------------------------------------------------- | ------ | ------------------------------------- |
| `GET` list                                                     | viewer | `listFeedSources` (dispatches:read)   |
| `POST` create                                                  | editor | `createFeedSource` (dispatches:write) |
| `GET /{feedSourceId}`                                          | viewer | `getFeedSource` (dispatches:read)     |
| `PATCH /{feedSourceId}` (also pause and resume)                | editor | `updateFeedSource` (dispatches:write) |
| `DELETE /{feedSourceId}` (its Dispatches stay)                 | editor | `deleteFeedSource` (dispatches:write) |
| `POST /{feedSourceId}/check` ("Check now")                     | editor | `checkFeedSource` (dispatches:write)  |
| `GET /{feedSourceId}/items`                                    | viewer | `listFeedItems` (dispatches:read)     |
| `GET /{feedSourceId}/preview`                                  | viewer | —                                     |

Every route answers `feature_disabled` (404) while the flag is off for the Channel, and `404` for a feed source of another Channel. Feed Sync reuses the Dispatch scopes on `/v2`, since what it makes is Dispatches.

## Not built

- Importing item images into Media.
- Per-item editing before release, or skipping one item from the dashboard. Pause the source, or delete the draft.
- WebSub (push) subscriptions; feeds are polled.
