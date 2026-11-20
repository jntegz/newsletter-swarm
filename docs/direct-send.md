# Direct Send API

One email to one Member of a Channel, outside Broadcasts: a receipt, a sign-in code, a one-off note. Code: `workers/api/src/v2/sends.ts`; schemas: `packages/domain/src/p7-direct-send.ts`; table: `direct_sends` (`migrations/0012_platform.sql`, `0014_oauth_sends.sql`).

## Endpoints

| Method | Path                                              | Scope           | Notes                                                            |
| ------ | ------------------------------------------------- | --------------- | ---------------------------------------------------------------- |
| POST   | `/v2/channels/{channelId}/sends`                  | `sends:write`   | Send now; answers `201` with the record.                         |
| GET    | `/v2/channels/{channelId}/sends`                  | `sends:read`    | Newest first, `cursor`, `limit`, `status`.                       |
| GET    | `/v2/channels/{channelId}/sends/{id}`             | `sends:read`    | One send and its status.                                         |
| GET    | `/api/v1/channels/{channelId}/direct-sends/stats` | session, viewer | Counts by status per UTC day, and today's use against the limit. |

Reading sends needs `sends:read`; `sends:write` includes it, so keys and grants made before `sends:read` existed keep working. A Channel outside the key's or grant's workspace or Channel list is `404`.

```json
POST /v2/channels/ch_…/sends
{
  "kind": "transactional",
  "to": { "email": "ada@example.com" },
  "templateId": "tp_…",
  "variables": { "order": "A-17" }
}
```

- `to` is `{ "memberId": "mb_…" }` or `{ "email": "…" }` (matched without regard to case). **The recipient must be a Member of the Channel, for both kinds.** Direct Send is not a way to mail addresses that never joined; an unknown address is `400`.
- The body is a Template (`templateId`: a `dispatch` Template of this Channel or shared with the workspace) or a Dispatch of the Channel (`dispatchId`, sent with its own sender). Exactly one of the two.
- `variables`: up to 50 names (`[a-z][a-z0-9_]*`) with string values up to 2,000 characters. `{{ var.name }}` in the subject and body is replaced; values are HTML-escaped in the HTML part, and an unknown name becomes empty. The usual merge tags (`{{ first_name | there }}`) work as in Broadcasts. Variables are not stored.
- Links are sent as written (no click tracking) and there is no open pixel.

## The compliance gate

The same rules as Broadcasts:

- **Suppression always blocks.** An address on the workspace's suppression list, or a Member marked bounced or complained, is never mailed. The send is recorded with status `suppressed` and `error: "address_suppressed"`.
- **`one_off`** needs an active Member (otherwise `suppressed` with `error: "member_not_active"`) and carries `List-Unsubscribe` (https and `mailto:`) with `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058). The unsubscribe code is the Broadcast one, built from the send's id; the track worker (One-Click and the page) and the events worker (`unsub+…@`) resolve it to the send's Member.
- **`transactional`** is for messages the Member asked for. It carries no unsubscribe headers and reaches Members who unsubscribed from the Channel, but still honours suppression. Its footer's unsubscribe placeholder links to the Member's Member Center.
- The Channel's sender must be able to send (verified domain, DMARC), as for a Broadcast; otherwise `409`.

## Plans and the daily limit

- Paid plans only: on `free` every request is `403 plan_required`.
- `PLAN_LIMITS.directSendsPerDay` per workspace (Pro 10,000, Scale 100,000, Enterprise 1,000,000), counted from 00:00 UTC. Every recorded send counts, including `suppressed` ones. The row is inserted with a conditional `INSERT … SELECT … WHERE (count today) < limit`, so concurrent requests cannot overshoot. Over the limit: `429 rate_limited` with `Retry-After` until midnight UTC.
- The `/v2` per-minute rate limit applies on top.

## Sending limits

Direct Sends count against the install's sending limits with every other email ([self-hosting.md](self-hosting.md#sending-limits)). A `transactional` send is mail someone is waiting for: it may use the whole of each hour, day and month, and goes ahead of posts in the per-second line. A `one_off` send counts like a post: it may use 90% of each window.

When a limit holds the send back, the request answers `429 rate_limited` with `Retry-After` (seconds until the limit allows it) and a detail at path `sendingLimit` naming the limit (`second`, `hour`, `day`, `month`, `service_day` or `service_month`). Nothing is recorded or counted against the plan's daily Direct Sends, and a retry with the same `Idempotency-Key` is not a replay. The same applies after the email service said its daily or monthly quota is used up: the send that found out is recorded as `failed`, as below, and later requests of both kinds, `transactional` included, answer `429` (`service_day` or `service_month`) until the quota resets, since the caller can try again then. Mail Swarm sends itself, such as sign-in links and signup confirmations, is still tried meanwhile, in case the service accepts it. A suppressed address takes no turn. When the limits can't be checked (the counter is unreachable), the send goes ahead.

## How it sends

**Synchronously through the MailAdapter, not the send queue.** A Direct Send is one message: the caller wants to know at once whether it was accepted, and the queue's snapshot, fan-out, Reputation Ramp and claim/reaper machinery exist for audiences, not single recipients. The request renders (the same `renderForWorkspace` and `personalize` as Broadcasts and test sends), records the row, sends, and stores the provider message id.

- It uses its own SES configuration set, `SES_DIRECT_CONFIGURATION_SET` (`swarm-<env>-direct`), so its reputation metrics and event stream stay apart from Broadcasts and sign-in mail. In development the dev mailbox receives it.
- Messages carry `Feedback-ID: <sendId>:<channelId>:direct:swarm`, `X-Swarm-Direct-Send` and the SES tag `direct_send=<sendId>`.
- A provider error marks the send `failed` with the reason; the request still answers `201` with that record. Retry with a new request, and a new `Idempotency-Key` (the old one replays the failed answer). A sending limit is answered `429` before anything is recorded (above).

## Status

`queued` (recorded, being sent) → `sent` (the provider accepted it) → `delivered`, `bounced` or `complained` from SES events. `suppressed` and `failed` are final. The events worker's `applySesEvent` falls back to `direct_sends` when an event matches no Broadcast delivery (by the `direct_send` tag, then the provider message id). A hard bounce or complaint suppresses the address workspace-wide, exactly as for a Broadcast; Direct Sends have no Reputation Ramp.

`direct_sends` keeps no address, subject or variables: the Member reference (set to null when the Member is deleted), the body's Template or Dispatch, and who sent it (`api_key_id` or `oauth_grant_id`).
