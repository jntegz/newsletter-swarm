# Event Webhooks

Swarm can POST a signed JSON event to your server when something happens in a workspace: a Member joins, a Broadcast finishes, a Flow run completes. Add endpoints in **Settings → Developers → Webhooks**, or with the API (`/api/v1/workspaces/{workspaceId}/webhooks` from the dashboard, `/v2/webhooks` with a key that has `webhooks:write`).

Contract in code: `packages/domain/src/p7-platform.ts` (catalogue, signature, retries) and `p7-webhooks.ts` (request, response and event data schemas). Implementation: `packages/engine/src/webhooks.ts`.

## Endpoints

- **URL.** `https://` with a public host name. IP addresses (v4 in any notation, v6), `localhost`, single-label names and `.local`, `.internal` and `.home.arpa` names are refused, and so are credentials in the URL. Plain `http://` is accepted only in development. Redirects are not followed.
- **Events.** Each endpoint lists the event types it wants (at least one).
- **Channel filter.** Optional. With a Channel set, the endpoint only gets that Channel's events. Without one, it gets every Channel's.
- **Status.** `active`, `paused` (nothing is sent; events that happen while paused are not sent later) or `disabled` (turned off after failing, see [Auto-disable](#auto-disable)). Resuming sets it back to `active`.
- **Limits.** Endpoints per workspace depend on the plan: free 2, Pro 10, Scale 50, Enterprise 200.
- **Who.** Owners and admins of the workspace; on `/v2`, `webhooks:read` and `webhooks:write`. A key limited to some Channels only sees endpoints filtered to one of them. Every change is in the audit log.
- **Confirmation.** Adding an endpoint from the dashboard, or changing its URL or publication, asks for a fresh check with your second factor, and the workspace's other owners and admins are emailed the URL. An endpoint added (or repointed) through `/v2` is a proposal: it has `suspendedReason: "unconfirmed"` and receives nothing until an admin confirms it under **Settings → Developers → Webhooks**. An endpoint also stops (`suspendedReason` says why) when the admin who confirmed it loses the admin role, the key or app that proposed it is revoked, or its publication is deleted, until an admin confirms it again. Events of a deleted publication reach no endpoint at all, workspace-wide ones included, and deliveries already queued for them are canceled; only `member.deleted` still goes. Events from while it was deleted are not sent after a restore. Details: [security.md](security.md#standing-feeds).

An endpoint only receives events that happen after it was created.

## The request

```http
POST /your/endpoint HTTP/1.1
Content-Type: application/json
User-Agent: Swarm-Webhooks/1
Swarm-Event-Id: ev_6b1d4c0e9a2f4d7b8c3e1f0a5b6c7d8e
Swarm-Event-Type: member.created
Swarm-Signature: t=1793188800,v1=5f0c…e1a9

{"id":"ev_6b1d4c0e9a2f4d7b8c3e1f0a5b6c7d8e","type":"member.created","createdAt":"2026-10-28T12:00:00.000Z","workspaceId":"ws_…","channelId":"ch_…","data":{…}}
```

The body is always this envelope:

| Field         | Meaning                                                                           |
| ------------- | --------------------------------------------------------------------------------- |
| `id`          | The event id, the same as `Swarm-Event-Id`. Stable across retries and redrives.   |
| `type`        | One of the event types below.                                                     |
| `createdAt`   | When the event happened (ISO 8601).                                               |
| `workspaceId` | The workspace.                                                                    |
| `channelId`   | The Channel the event belongs to, or `null`.                                      |
| `data`        | The resource, in the same shape the API returns it (schemas in `p7-webhooks.ts`). |

Answer with any `2xx` within 10 seconds. Do the work after answering (queue it), or the request may time out and be retried. Anything else, a redirect, a timeout or a network error counts as a failure. The response body is not read beyond the first 1 KB, which is kept in the delivery log.

## Events

| Type                     | When                                                                                                   | `data`                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `member.created`         | A Member was added: sign-up, import, the API, checkout (in any status, `pending` under double opt-in)  | Member                                    |
| `member.confirmed`       | A Member became active with consent: confirm link, single opt-in, purchase                             | Member                                    |
| `member.updated`         | Tags, profile fields or Rosters changed, or an operator changed the name, digest or status             | Member                                    |
| `member.unsubscribed`    | The Member left: unsubscribe page or One-Click, Member Center, an operator, a bulk action, a complaint | Member                                    |
| `member.deleted`         | The Member was deleted (operator, bulk action, erasure)                                                | `{ id, channelId }` only                  |
| `level.purchased`        | Paid access started or moved to a Membership level                                                     | `{ member, levelId, source }`             |
| `level.canceled`         | Paid access on a level ended or moved away from it                                                     | `{ member, levelId }`                     |
| `dispatch.scheduled`     | A Dispatch was scheduled                                                                               | DispatchSummary                           |
| `dispatch.sent`          | A Dispatch's Broadcast finished and reached at least one Member                                        | DispatchSummary                           |
| `broadcast.completed`    | A Broadcast finished (`sent`, `partially_failed` or `failed`)                                          | `{ broadcast, stats }`                    |
| `ask.response`           | A Member answered an Ask question (new or changed answer)                                              | `{ member, askId, questionId, optionId }` |
| `flow.completed`         | A Flow run reached its end (test runs are left out)                                                    | FlowRun                                   |
| `capture_form.submitted` | A Capture Form was submitted (by a new or an existing Member)                                          | `{ member, formId, created }`             |
| `roster.subscribed`      | A Member joined a Roster: Capture Form or confirm link, Member Center, operator, import, the API       | `{ member, rosterId, source }`            |
| `roster.unsubscribed`    | A Member left a Roster: unsubscribe page or One-Click, Member Center, operator, the API                | `{ member, rosterId, source }`            |

Member data is the Member as it is when the event is sent, not a snapshot of the moment it happened, so read `status` and `tags` from it rather than assuming what changed. Several tag, field and Roster changes to one Member close together may arrive as one `member.updated`, and one edit can produce more than one. `member.deleted` carries ids only.

**Rosters.** Every Roster change ([rosters.md](rosters.md)) is one `roster.subscribed` or `roster.unsubscribed`, never merged with another: `rosterId` is the Roster and `source` is who made the change (`form`, `member`, `operator`, `import`, `api` or `unsubscribe`). Only real changes are sent; subscribing a Member who is already on the Roster sends nothing. The same change still counts towards `member.updated` as before, so receivers written before these events keep working; the two have different event ids. A Member who leaves the whole Channel gets `member.unsubscribed`, not a `roster.unsubscribed` per Roster (their Roster memberships don't change).

### Examples

`member.created`:

```json
{
  "id": "ev_0c5e3b9d7a1f42e8b6c4d2a0f9e8d7c6",
  "type": "member.created",
  "createdAt": "2026-10-28T12:00:00.000Z",
  "workspaceId": "ws_0192f3a4b5c67d8e9f0a1b2c3d4e5f60",
  "channelId": "ch_0192f3a4b5c67d8e9f0a1b2c3d4e5f61",
  "data": {
    "id": "mb_0192f3a4b5c67d8e9f0a1b2c3d4e5f62",
    "channelId": "ch_0192f3a4b5c67d8e9f0a1b2c3d4e5f61",
    "email": "ada@example.com",
    "firstName": "Ada",
    "lastName": null,
    "status": "pending",
    "digest": "every",
    "tags": ["from-podcast"],
    "createdAt": "2026-10-28T12:00:00.000Z",
    "confirmedAt": null,
    "pausedUntil": null,
    "unsubscribedAt": null
  }
}
```

`member.deleted`:

```json
{
  "id": "ev_9a8b7c6d5e4f40312a1b0c9d8e7f6a5b",
  "type": "member.deleted",
  "createdAt": "2026-10-28T12:05:00.000Z",
  "workspaceId": "ws_0192f3a4b5c67d8e9f0a1b2c3d4e5f60",
  "channelId": "ch_0192f3a4b5c67d8e9f0a1b2c3d4e5f61",
  "data": {
    "id": "mb_0192f3a4b5c67d8e9f0a1b2c3d4e5f62",
    "channelId": "ch_0192f3a4b5c67d8e9f0a1b2c3d4e5f61"
  }
}
```

`level.purchased`:

```json
{
  "id": "ev_1f2e3d4c5b6a47980a1b2c3d4e5f6a7b",
  "type": "level.purchased",
  "createdAt": "2026-10-28T12:10:00.000Z",
  "workspaceId": "ws_0192f3a4b5c67d8e9f0a1b2c3d4e5f60",
  "channelId": "ch_0192f3a4b5c67d8e9f0a1b2c3d4e5f61",
  "data": {
    "member": { "id": "mb_0192f3a4b5c67d8e9f0a1b2c3d4e5f62", "status": "active", "…": "…" },
    "levelId": "lv_0192f3a4b5c67d8e9f0a1b2c3d4e5f63",
    "source": "checkout"
  }
}
```

`broadcast.completed`:

```json
{
  "id": "ev_5d4c3b2a1f0e49d8c7b6a5f4e3d2c1b0",
  "type": "broadcast.completed",
  "createdAt": "2026-10-28T13:00:00.000Z",
  "workspaceId": "ws_0192f3a4b5c67d8e9f0a1b2c3d4e5f60",
  "channelId": "ch_0192f3a4b5c67d8e9f0a1b2c3d4e5f61",
  "data": {
    "broadcast": {
      "id": "bc_0192f3a4b5c67d8e9f0a1b2c3d4e5f64",
      "dispatchId": "dp_0192f3a4b5c67d8e9f0a1b2c3d4e5f65",
      "channelId": "ch_0192f3a4b5c67d8e9f0a1b2c3d4e5f61",
      "status": "sent",
      "subject": "Field Notes #12",
      "from": { "name": "Field Notes", "address": "field-notes@mail.example.com" },
      "recipientCount": 1200,
      "sentCount": 1200,
      "failedCount": 0,
      "failureReason": null,
      "createdAt": "2026-10-28T12:58:00.000Z",
      "completedAt": "2026-10-28T13:00:00.000Z",
      "canceledAt": null
    },
    "stats": { "sent": 1200, "delivered": 1194, "bounced": 6, "openRate": 0, "…": "…" }
  }
}
```

`roster.subscribed`:

```json
{
  "id": "ev_3c2b1a0f9e8d47c6b5a4f3e2d1c0b9a8",
  "type": "roster.subscribed",
  "createdAt": "2026-10-28T12:15:00.000Z",
  "workspaceId": "ws_0192f3a4b5c67d8e9f0a1b2c3d4e5f60",
  "channelId": "ch_0192f3a4b5c67d8e9f0a1b2c3d4e5f61",
  "data": {
    "member": { "id": "mb_0192f3a4b5c67d8e9f0a1b2c3d4e5f62", "status": "active", "…": "…" },
    "rosterId": "rs_0192f3a4b5c67d8e9f0a1b2c3d4e5f66",
    "source": "member"
  }
}
```

The other types follow the same pattern with the schemas named in the table. **Send a test event** in the dashboard (or `POST …/webhooks/{endpointId}/test` with an optional `type`) sends any type with made-up sample data; test events are marked in the delivery log.

## Verifying the signature

`Swarm-Signature` is `t=<unix seconds>,v1=<hex HMAC-SHA256>`. The MAC is computed over the timestamp, a full stop and the raw body, `<t>.<body>`, with the endpoint's secret as the key: the whole `whsec_…` string as shown, as UTF-8 bytes.

To verify a request:

1. Read the raw body before parsing it. Re-serialised JSON will not match.
2. Split the header on `,` into `t=` and one or more `v1=` values.
3. Refuse the request when `t` is more than **5 minutes** from your clock (the replay window).
4. Compute the HMAC of `<t>.<body>` and compare it with each `v1=` in constant time. Accept if any matches.

TypeScript (Web Crypto: Node.js 20+, Deno, Bun, Workers). This exact code is run by Swarm's test suite against the signer:

```ts
// Verifies the Swarm-Signature header of an Event Webhook (docs/webhooks.md).
// Web Crypto only: runs on Node.js 20+, Deno, Bun and Cloudflare Workers.
const encoder = new TextEncoder();

export async function verifySwarmSignature(
  secret: string, // whsec_…, exactly as shown when the endpoint was created
  header: string, // the Swarm-Signature request header
  rawBody: string, // the request body as received, before any JSON parsing
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const pairs = header.split(',').map((part) => part.trim().split('='));
  const timestamp = Number(pairs.find(([key]) => key === 't')?.[1]);
  const candidates = pairs.filter(([key]) => key === 'v1').map(([, value]) => value ?? '');
  if (!Number.isInteger(timestamp) || Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return false; // missing or outside the replay window
  }
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  // During a secret rotation there are two v1= values; either one may match.
  return candidates.some((candidate) => constantTimeEqual(candidate, expected));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
```

Python 3:

```python
import hashlib
import hmac
import time


def verify_swarm_signature(secret: str, header: str, raw_body: bytes, tolerance: int = 300) -> bool:
    pairs = [part.strip().split("=", 1) for part in header.split(",")]
    timestamps = [value for key, value in pairs if key == "t"]
    candidates = [value for key, value in pairs if key == "v1"]
    if not timestamps or not timestamps[0].isdigit():
        return False
    timestamp = int(timestamps[0])
    if abs(time.time() - timestamp) > tolerance:
        return False  # outside the replay window
    signed = str(timestamp).encode() + b"." + raw_body
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, candidate) for candidate in candidates)
```

Go:

```go
package webhooks

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"time"
)

// VerifySwarmSignature checks the Swarm-Signature header against the raw request body.
func VerifySwarmSignature(secret, header string, rawBody []byte, tolerance time.Duration) bool {
	var timestamp int64 = -1
	var candidates []string
	for _, part := range strings.Split(header, ",") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		switch key {
		case "t":
			if t, err := strconv.ParseInt(value, 10, 64); err == nil {
				timestamp = t
			}
		case "v1":
			candidates = append(candidates, value)
		}
	}
	if timestamp < 0 {
		return false
	}
	if age := time.Since(time.Unix(timestamp, 0)); age > tolerance || age < -tolerance {
		return false // outside the replay window
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strconv.FormatInt(timestamp, 10) + "."))
	mac.Write(rawBody)
	expected := []byte(hex.EncodeToString(mac.Sum(nil)))
	for _, candidate := range candidates {
		if hmac.Equal(expected, []byte(candidate)) {
			return true
		}
	}
	return false
}
```

## Retries

A failed attempt is retried with exponential backoff, up to 9 attempts in all (the first plus 8 retries):

| Retry | Wait after the failure |
| ----- | ---------------------- |
| 1     | 30 seconds             |
| 2     | 2 minutes              |
| 3     | 8 minutes              |
| 4     | 32 minutes             |
| 5     | about 2 hours          |
| 6     | about 8.5 hours        |
| 7, 8  | 12 hours each          |

A delivery that still fails after that is `failed`. Each attempt is signed afresh, so `t` changes between attempts while the body and `Swarm-Event-Id` stay the same.

**How many at once.** At most 4 deliveries are in flight to one endpoint at a time (`WEBHOOK_ENDPOINT_MAX_CONCURRENT`), test events and redrives included. A delivery that finds 4 already waiting on the endpoint tries again 5 seconds later without using an attempt, so a slow endpoint gets its events a little later instead of tying up the deliveries of every other endpoint. Time spent waiting on a workspace's endpoints also counts against that workspace's share of each minute, as before.

## Idempotency

Deliveries are at least once: the same event can arrive more than once (a retry after a slow `2xx`, a redrive). Use `Swarm-Event-Id` to skip events you have already handled. Every endpoint that receives an event gets the same id. Events are sent roughly in the order they happened, but retries can overtake each other, so don't rely on order; use `createdAt` and the resource's own timestamps.

## Delivery log and redrive

Each endpoint has a delivery log: event type, status (`pending`, `retrying`, `succeeded`, `failed`, `canceled`), response code, latency, every attempt, the exact payload, the headers that were sent (without the signature values) and the first 1 KB of each response. Finished deliveries are kept for 30 days.

**Redrive** sends a delivery again with the same event id and body and a fresh set of retries. Redriving a delivery that is already pending or retrying does nothing. **Redrive failed since…** does the same for every failed and canceled delivery of the endpoint since a time (up to 1,000 per call). Only active endpoints can be redriven.

## Auto-disable

When every attempt to an endpoint has failed for **72 hours** (no success in between), the endpoint is turned off (`disabled`, with the reason shown), its waiting deliveries are canceled and the workspace's owners and admins get an email. Fix the endpoint, resume it (this clears its failures), then redrive what failed. Test events never count towards this.

## Rotating the secret

**Rotate secret** returns a new secret once. For the next **24 hours** every request carries two `v1=` values, one made with the new secret and one with the previous one, so you can deploy the new secret without dropping events. After that only the new secret signs. Secrets are stored encrypted and are never shown again after creation or rotation.
