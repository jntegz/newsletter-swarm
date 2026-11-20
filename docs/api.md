# Public API guide

The Swarm public API lives under `/v2` on the app's origin (for example `https://app.swarm.example/v2`). It covers Channels, Members, profile fields and tags, Circles, Dispatches, Broadcasts, membership levels, capture forms, Flows, bulk imports and the audit log.

- **Reference:** `/v2/reference` (every operation, its scope, parameters and response).
- **OpenAPI 3.1 document:** `/v2/openapi.json`, also committed as [`openapi-v2.json`](openapi-v2.json).
- **Discovery:** `/.well-known/api-catalog` (RFC 9727) links both.
- **TypeScript SDK:** `packages/sdk` is generated from the document (see [SDK](#typescript-sdk)).

The dashboard's own API (`/api/v1`, cookie sessions) is not part of this contract and can change without notice.

## Authentication

Create a key in **Settings → Developers → API keys** (admin role or higher). Send it as a Bearer token:

```bash
curl https://app.swarm.example/v2/channels \
  -H "Authorization: Bearer sk_live_…"
```

- The full key (`sk_live_` followed by 40 characters) is shown **once**, when it is created. Swarm stores only a SHA-256 fingerprint of it and an 8-character prefix so you can recognise it in the list.
- A key can be limited to some Channels, to IPv4 or IPv6 ranges (CIDR, up to 20), to a request rate below your plan's, and can expire.
- Revoking a key takes effect on the next request.
- Third-party apps use OAuth access tokens (`Bearer oat_…`) instead of keys; everything below applies to them too.

An unknown, revoked or expired key, or a request from outside the key's allowed ranges, all get the same answer:

```json
{
  "error": {
    "code": "unauthorized",
    "message": "The API key or access token is not valid.",
    "requestId": "…"
  }
}
```

The number of active keys depends on the plan (free 2, pro 25, scale 100, enterprise 500).

## Scopes

Every operation needs exactly one scope, shown on it in the reference. A `:write` scope also grants the matching `:read`.

| Scope                                  | Grants                                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `channels:read`                        | List and read Channels                                                                                         |
| `members:read` / `members:write`       | Members (list, lookup by email, read, create or upsert, edit, unsubscribe, delete, tags, profile field values) |
| `fields:read` / `fields:write`         | Profile field definitions                                                                                      |
| `circles:read` / `circles:write`       | Circles and live counts                                                                                        |
| `dispatches:read` / `dispatches:write` | Dispatches (drafts, saves, previews, test sends, scheduling)                                                   |
| `broadcasts:read`                      | Broadcasts and their statistics                                                                                |
| `levels:read`                          | Membership levels                                                                                              |
| `forms:read`                           | Capture forms and Smart Prompts                                                                                |
| `flows:read` / `flows:write`           | Flows; enrolling a Member; API events                                                                          |
| `imports:read` / `imports:write`       | Bulk upserts (import jobs); reading a job and its report needs only `imports:read`                             |
| `audit:read`                           | The workspace audit log                                                                                        |
| `webhooks:read` / `webhooks:write`     | Event Webhooks                                                                                                 |
| `sends:read` / `sends:write`           | The Direct Send API; listing and reading sends needs only `sends:read`                                         |
| `rosters:read` / `rosters:write`       | Rosters and who is on them ([rosters.md](rosters.md); needs the `rosters` flag)                                |

A key without the scope gets `403` with code `insufficient_scope`. A Channel the key can't reach (another workspace, or outside the key's Channel list) answers `404`, exactly like a Channel that does not exist.

## Rate limits

Each key (or OAuth token) has a token bucket. It refills at your plan's rate per minute, or the key's cap if that is lower, and holds that much plus a burst (half the rate on every plan). Every response to an authenticated request says where you are:

```
RateLimit-Limit: 900
RateLimit-Remaining: 899
RateLimit-Reset: 1
RateLimit-Policy: 900;w=60;burst=300;rate=600
```

`RateLimit-Limit` is the bucket size, `RateLimit-Remaining` the requests you can make right now and `RateLimit-Reset` the seconds until the bucket is full again. When it is empty the answer is `429` with code `rate_limited` and `Retry-After` in seconds:

```bash
curl -i https://app.swarm.example/v2/channels -H "Authorization: Bearer sk_live_…"
# HTTP/1.1 429 Too Many Requests
# Retry-After: 1
```

| Plan       | Requests a minute | Burst |
| ---------- | ----------------- | ----- |
| free       | 60                | 30    |
| pro        | 600               | 300   |
| scale      | 3,000             | 1,500 |
| enterprise | 10,000            | 5,000 |

## Idempotency

Send `Idempotency-Key` (1 to 255 visible characters, a UUID is ideal) on any `POST`, `PUT`, `PATCH` or `DELETE`. For 24 hours, retrying with the same key, method, path and body returns the first response again, with `Idempotent-Replayed: true`, and does nothing twice. Using the key for a different request is `409 conflict`, and so is a retry while the first request is still running. Server errors (5xx) and `429` are not stored, so you can retry them with the same key. A response that carries a one-time secret (a new API key, a webhook signing secret, an OAuth client secret, a rotated secret) is never stored either: a retry with its key is `409 conflict`, so check what the first request created (for example, list your webhook endpoints) rather than retrying with a new key. Keys belong to the credential: two keys never share them, and an OAuth access token gets a replay only of a request made with the same scopes.

```bash
curl -X POST https://app.swarm.example/v2/channels/ch_…/members \
  -H "Authorization: Bearer sk_live_…" \
  -H "Idempotency-Key: 7f6c7c1e-2b36-4a52-9d0b-3a3c2f1e8a10" \
  -H "Content-Type: application/json" \
  -d '{"email":"ada@example.com","firstName":"Ada","consent":true}'
```

## Pagination

Lists return `{ "data": { "items": [...], "nextCursor": "…" } }`. Pass `nextCursor` back as `cursor` for the next page; it is `null` on the last page. `limit` is 1 to 100 (default 25). Cursors are opaque: don't build or parse them.

```bash
curl "https://app.swarm.example/v2/channels/ch_…/members?limit=100&status=active" \
  -H "Authorization: Bearer sk_live_…"
curl "https://app.swarm.example/v2/channels/ch_…/members?limit=100&status=active&cursor=bWJfMDE5…" \
  -H "Authorization: Bearer sk_live_…"
```

## Responses and errors

Successful responses are `{ "data": … }`. Errors are:

```json
{
  "error": {
    "code": "invalid_input",
    "message": "Some fields are not valid.",
    "requestId": "8e1c…",
    "details": [{ "path": "email", "message": "Enter a valid email address." }]
  }
}
```

| Status | Code                 | Meaning                                                               |
| ------ | -------------------- | --------------------------------------------------------------------- |
| 400    | `invalid_input`      | The request is not valid; `details` names the fields                  |
| 401    | `unauthorized`       | No credential, or not a valid one                                     |
| 403    | `insufficient_scope` | The credential lacks the operation's scope                            |
| 404    | `not_found`          | No such row, or not one this credential can reach                     |
| 409    | `conflict`           | The change conflicts with the current state, or an Idempotency-Key    |
| 429    | `rate_limited`       | The bucket is empty; see `Retry-After`                                |
| 5xx    | `internal`, …        | Something failed on Swarm's side; retry with the same Idempotency-Key |

Quote `requestId` when you contact support. Timestamps are ISO 8601 in UTC; money is integer minor units with a `currency`.

Encrypted profile fields are decrypted for you. If that can't be done for a moment, a read still succeeds: those fields come back as `null` and the Member carries `"encryptedUnavailable": true`. They still hold their values, so don't treat the `null`s as cleared; read the Member again shortly. A write that sets an encrypted field answers 503 meanwhile, and nothing is saved.

## Examples

**Add a Member who asked to receive your Channel, or update them if they already are one:**

```bash
curl -X POST https://app.swarm.example/v2/channels/ch_…/members \
  -H "Authorization: Bearer sk_live_…" -H "Content-Type: application/json" \
  -d '{"email":"ada@example.com","consent":true,"tags":["webinar"],"fields":{"company":"Analytical"},"upsert":true}'
```

Without `consent` a new Member starts pending and receives nothing until they confirm. Members follow the same rules as in the dashboard: an unsubscribed Member can only come back by confirming from an email, and bounced or complained addresses stay suppressed.

**Find a Member by email:**

```bash
curl "https://app.swarm.example/v2/channels/ch_…/members/lookup?email=ada%40example.com" \
  -H "Authorization: Bearer sk_live_…"
```

**Tag, untag, set profile fields, unsubscribe:**

```bash
curl -X POST .../v2/channels/ch_…/members/mb_…/tags -d '{"tags":["vip"]}' -H "Content-Type: application/json" -H "Authorization: Bearer sk_live_…"
curl -X DELETE .../v2/channels/ch_…/members/mb_…/tags/vip -H "Authorization: Bearer sk_live_…"
curl -X PATCH .../v2/channels/ch_…/members/mb_…/fields -d '{"fields":{"plan":"gold"}}' -H "Content-Type: application/json" -H "Authorization: Bearer sk_live_…"
curl -X POST .../v2/channels/ch_…/members/mb_…/unsubscribe -H "Authorization: Bearer sk_live_…"
```

**Trigger a Flow from your app.** Flows with an API event of this name among their start events enrol the Member:

```bash
curl -X POST https://app.swarm.example/v2/channels/ch_…/members/mb_…/events \
  -H "Authorization: Bearer sk_live_…" -H "Content-Type: application/json" \
  -d '{"name":"order.paid","properties":{"total":42}}'
```

Or enrol a Member in a live Flow directly: `POST /v2/channels/{channelId}/flows/{flowId}/enrolments` with `{"memberId":"mb_…"}`. A Flow that gives a Membership level for free (a `change_level` grant step, its own or through `enrol_flow`) answers 403 `forbidden`: comp grants need the admin role, and keys and OAuth tokens act as editor.

**Draft a Dispatch, preview it, send yourself a test, schedule it:**

```bash
curl -X POST .../v2/channels/ch_…/dispatches -H "Authorization: Bearer sk_live_…" -H "Content-Type: application/json" \
  -d '{"subject":"October notes","content":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Hello {{first_name | there}}"}]}]}}'
curl -X POST .../v2/channels/ch_…/dispatches/dp_…/preview -d '{"memberId":"mb_…"}' -H "Content-Type: application/json" -H "Authorization: Bearer sk_live_…"
curl -X POST .../v2/channels/ch_…/dispatches/dp_…/test -d '{"to":["you@yourteam.example"]}' -H "Content-Type: application/json" -H "Authorization: Bearer sk_live_…"
curl -X POST .../v2/channels/ch_…/dispatches/dp_…/schedule -d '{"publishAt":"2026-11-02T08:00:00Z"}' -H "Content-Type: application/json" -H "Authorization: Bearer sk_live_…"
```

Tests only go to teammates of the workspace. Scheduling runs the pre-send checklist now and again at send time. A Dispatch that fails the checklist at send time goes back to draft, with a `dispatch.schedule_failed` audit entry. If it can't be started for another reason (an outage, a platform limit), it stays scheduled and is tried again after 2, 4, 8, 16 and 32 minutes; after the sixth failure (a try that never finishes counts) it goes back to draft the same way. The scheduler starts at most 25 due Dispatches a minute, at most 10 of them from one workspace.

## Bulk imports and moving from another platform

`POST /v2/channels/{channelId}/members/bulk` takes up to 10,000 Members and creates an import job, the same as an upload in the dashboard: a dry run first, then you confirm.

```bash
curl -X POST .../v2/channels/ch_…/members/bulk -H "Authorization: Bearer sk_live_…" -H "Content-Type: application/json" \
  -d '{"consentAttested":true,"members":[{"email":"ada@example.com","firstName":"Ada","tags":["import"]},{"email":"grace@example.com"}]}'
# → 202 { "data": { "id": "ij_…", "status": "analyzing", … } }
curl .../v2/channels/ch_…/imports/ij_… -H "Authorization: Bearer sk_live_…"
# when status is "analyzed", read report.counts, then:
curl -X POST .../v2/channels/ch_…/imports/ij_…/confirm -H "Authorization: Bearer sk_live_…"
```

`consentAttested: true` confirms these people agreed to hear from this Channel; without it they import as pending. `updateExisting: true` also updates current Members.

To bring a list from another newsletter platform, send its export as it is: `"source": "platform_json"` with `records` (the export's objects), or `"source": "platform_csv"` with `csv` (the file's text). Their column names are matched to Swarm's, a paid plan becomes a tag, and people who had unsubscribed there, or whose email was turned off, are counted as suppressed in the dry run and never imported. The dashboard's import page offers the same as "Another newsletter platform (CSV)" and "(JSON)". This only imports Members; there is no compatibility API for other platforms' endpoints.

## Audit log

`GET /v2/audit-events` (`audit:read`) pages the workspace's tamper-evident log, newest first. A key or OAuth grant limited to Channels sees only the events about those Channels and their resources (Members, Dispatches, Flows and so on), plus the changes it made itself; workspace-level events such as teammate invites, seats and other keys are left out. Changes made through the API have no teammate as `actor`; `metadata.via` names the key or OAuth token. Events older than the plan's retention (free 30 days, pro 365, scale 730, enterprise forever) are pruned daily; each prune is itself an `audit.pruned` event. Admins can download the log as CSV or JSONL in Settings → Audit log.

## AI agents (MCP)

AI agents can use the same operations through the MCP server at `/mcp`, with the same keys and scopes. See [open-operator.md](open-operator.md).

## TypeScript SDK

`packages/sdk` is generated from `docs/openapi-v2.json` (`pnpm openapi:v2`). One method per operation, named by its `operationId`, with types for every request and response:

```ts
import { SwarmApiError, SwarmClient } from '@swarm/sdk';

const swarm = new SwarmClient({
  baseUrl: 'https://app.swarm.example',
  token: process.env.SWARM_KEY!,
});
const member = await swarm.createMember(
  { channelId: 'ch_…', body: { email: 'ada@example.com', consent: true, upsert: true } },
  { idempotencyKey: crypto.randomUUID() },
);
try {
  await swarm.getMember({ channelId: 'ch_…', memberId: 'mb_…' });
} catch (error) {
  if (error instanceof SwarmApiError && error.code === 'rate_limited') {
    // wait error.retryAfter seconds
  }
}
console.log(swarm.rateLimit); // { limit, remaining, reset }
```

The SDK's contract tests run it against the worker (`workers/api/tests/sdk-contract.test.ts`).

## Resending to people who didn't open

`POST /v2/channels/{channelId}/broadcasts/{broadcastId}/resend-unopened` (`dispatches:write`, flag `resend_unopens`) starts a draft copy for the people that Broadcast reached who neither opened nor clicked it, so bounces, failures and complaints are left out. Sending it takes the usual steps and checks, and anyone who unsubscribed since is skipped. Asking again gives the same draft. The copy stays off the website, where the original already is.

Opens from privacy proxies don't count as opens, so someone whose mail app hides opens may get it twice even if they read the first. A post with a paywall can't be resent yet (`409`).
