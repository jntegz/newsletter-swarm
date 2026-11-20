# Rosters

A Roster is an opt-in list inside a Channel: "Weekly deals", "Events in Berlin", "Product news". A Member of the Channel can be on any number of Rosters, each with its own status, and a Broadcast can go to the Members of chosen Rosters only. Everything here sits behind the `rosters` flag (Phase 8, parity); with the flag off nothing below exists and sending works exactly as before.

Tables: `rosters` and `roster_members` (`migrations/0019_rosters.sql`). Schemas: `packages/domain/src/p8-rosters.ts`. Engine: `packages/engine/src/rosters.ts`. Routes: `workers/api/src/routes/rosters.ts` (dashboard) and `workers/api/src/v2/rosters.ts` (public API).

## The model

- **Roster.** A name (unique per Channel, ignoring case), an optional description, and `memberCenter`: whether Members see it in the Member Center. At most 100 live Rosters per Channel. Deleting a Roster hides it everywhere; its memberships are kept, so a Broadcast that is already sending to it finishes with the Members it counted.
- **Membership.** One row per Member and Roster, `subscribed` or `unsubscribed`, with the `source` of the last change (`operator`, `form`, `member`, `import`, `api`, `unsubscribe`) and when they joined and left. A Member who never joined has no row. The Member's own status still comes first: only an `active` Member receives anything, whatever their Rosters say.
- **Who may re-subscribe.** A Member who left a Roster themselves (Member Center or an unsubscribe link: source `member` or `unsubscribe`) can only be put back by themselves: the Member Center, or a Capture Form they submit and confirm. Operators, imports and the API get `409 conflict` (operators) or skip the row (imports). This mirrors the Member status rule that an operator can't bring back an unsubscribed Member.

## Sending to Rosters

A Dispatch's audience gains an optional `rosters` part next to the Circles:

```json
{
  "include": ["cl_…"],
  "exclude": [],
  "rosters": { "include": ["rs_…", "rs_…"], "exclude": ["rs_…"], "conflict": "exclude_wins" }
}
```

- **Combined with Circles by AND.** A Member gets the Broadcast when they are active and unsuppressed (as today), match the Circle part (in an included Circle, or everyone when none is included, and in no excluded Circle), and match the Roster part. Rosters are the consent; Circles narrow it down.
- **The Roster part.** With included Rosters, the Member must be subscribed to at least one of them. A Member subscribed to an excluded Roster is left out.
- **Conflict policy.** A Member subscribed to both an included and an excluded Roster is the conflict. `exclude_wins` (the default) leaves them out; `include_wins` sends to them. The operator chooses in the audience panel, which shows how many Members are in both right now. With no included Roster there is no conflict, and excluded Rosters always leave their Members out.
- **One Delivery per Member.** The audience is one SQL predicate over the Channel's Members, so a Member in three included Rosters and two Circles matches once, and `broadcast_recipients` has one row per Member. Members are unique per address in a Channel, so an address gets one email.
- **Frozen at start.** Like the Circle rules, the Roster ids and the policy are frozen into the Broadcast when it starts. Memberships are read when the snapshot runs, the same predicate preflight counted with.
- **Feed Sync.** A feed source takes the same `rosters` part, with the same checks, and passes it to every Dispatch it makes ([feed-sync.md](feed-sync.md#targeting-and-rosters)).
- **Checks.** Saving an audience with Rosters needs the flag and Rosters of the Dispatch's Channel (`400` otherwise). Preflight fails the audience check when a Roster has been deleted, or when the flag has been turned off since the audience was chosen ("Choose the audience again"); a send never silently ignores the Roster part. An empty `rosters` part (nothing included or excluded) is dropped on save.

## Leaving a Roster from an email

Every Broadcast email carries `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` as before; nothing in the headers changes.

- **Roster-targeted Broadcasts** (the frozen audience includes at least one Roster): the One-Click POST (RFC 8058), the mailto unsubscribe and the unsubscribe page's main button take the Member off the included Rosters they are subscribed to. They stay a Member and keep receiving Broadcasts that are not limited to those Rosters. The delivery is marked unsubscribed, so the Broadcast's unsubscribe numbers still count it.
- **Leaving everything.** The unsubscribe page names the Rosters and has a second button, "Unsubscribe from everything", which unsubscribes the Member from the Channel exactly as before. The Member Center has the same choice.
- **Other Broadcasts** (no Roster included, or only excluded ones) unsubscribe from the Channel as before.
- **Flag turned off since.** If the `rosters` flag is off when the unsubscribe arrives, it unsubscribes from the Channel: with the flag off, Rosters no longer limit who gets mail, so leaving only the Roster would not stop the emails.

## Member Center

When the flag is on and the Channel has Rosters with `memberCenter` on, the Member Center shows "Your Rosters" with a checkbox per Roster for pending, active and paused Members. Saving joins the ticked Rosters and leaves the unticked ones they were on (source `member`). Rosters hidden from the Member Center are not listed; a Member leaves those through an unsubscribe link or by leaving everything. The page shows nothing about Rosters when the flag is off.

## Capture Forms

A form's config can name up to 20 Rosters (`rosterIds`, flag required when saving). A sign-up through the form joins them (source `form`):

- a new Member under single opt-in joins when the Member is created;
- under double opt-in, and for a returning (unsubscribed) Member, the Rosters are joined when the confirm link is used: the Rosters of the form the confirm request came from, at confirm time. Confirming re-subscribes a Member to a form Roster they had left, because they just asked for it;
- an existing active or paused Member is not changed. The form answers every address the same way, so a stranger typing someone's address must not change their subscriptions; Members change their Rosters in the Member Center.

With the flag off at sign-up or confirm time, no Roster is joined.

## Imports and exports

- **Import.** A column can map to `rosters` (flag required). Cells hold Roster names separated by `;`, `,` or `|`, matched without case to the Channel's live Rosters; unknown names are ignored. New Members join those Rosters (source `import`). With "update existing" on, current Members join the Rosters they have never been on, which counts the row as updated; a Member who left a Roster is not put back.
- **Export.** Exports created while the flag is on add a `rosters` column (CSV, `; `-separated names of the live Rosters the Member is subscribed to) or a `rosters` array (JSONL). `rosterId` limits an export to the Members subscribed to that Roster.

## Events and webhooks

Membership changes append `roster_joined` and `roster_left` to the member event log (`{ rosterId, source }`), in the same batch as the change, and only when the status actually changes. Every path (Capture Forms and the confirm link, the Member Center, unsubscribe links and One-Click, the dashboard, `/v2` and imports) goes through `rosterChangeStatements`, so each writes them the same way.

- **Webhooks.** Each change is a `roster.subscribed` or `roster.unsubscribed` event with `{ member, rosterId, source }` ([webhooks.md](webhooks.md)). It also still counts as `member.updated` (one per Member per fan-out page, as for tags and fields), which receivers written before these events rely on.
- **Flow triggers.** "Joined a Roster" (`roster_joined`) and "Left a Roster" (`roster_left`) start a Flow when a Member joins or leaves the chosen Roster, whatever the source. The Roster must be a live Roster of the Flow's Channel, and saving or publishing a Flow with one needs the flag (`400` otherwise; the Flow builder offers them only while it is on). With the flag off no membership changes, so a live Flow with such a trigger simply waits.

## Privacy

A data export (Privacy Center) lists the Member's Rosters with status and dates. Erasure deletes the Member, and their memberships cascade with them.

## API

Dashboard (`/api/v1`): viewer reads, editor writes. Every route answers `404 feature_disabled` when the flag is off for the Channel.

| Route                                                             | Role   | Purpose                                                  |
| ----------------------------------------------------------------- | ------ | -------------------------------------------------------- |
| `GET /channels/{channelId}/rosters`                               | viewer | Rosters with subscribed counts                           |
| `POST /channels/{channelId}/rosters`                              | editor | Create                                                   |
| `GET /channels/{channelId}/rosters/{rosterId}`                    | viewer | One Roster                                               |
| `PATCH /channels/{channelId}/rosters/{rosterId}`                  | editor | Rename, describe, show or hide in the Member Center      |
| `DELETE /channels/{channelId}/rosters/{rosterId}`                 | editor | Delete                                                   |
| `GET /channels/{channelId}/rosters/{rosterId}/members`            | viewer | Memberships, newest change first, by status, with cursor |
| `POST /channels/{channelId}/rosters/overlap`                      | viewer | Counts for an audience's Roster part, with conflicts     |
| `GET /channels/{channelId}/members/{memberId}/rosters`            | viewer | One Member's Rosters                                     |
| `PUT /channels/{channelId}/members/{memberId}/rosters/{rosterId}` | editor | Subscribe or unsubscribe one Member                      |

Public API (`/v2`, the "lists" resource), scopes `rosters:read` and `rosters:write`:

| Route                                                                   | Scope         |
| ----------------------------------------------------------------------- | ------------- |
| `GET /v2/channels/{channelId}/rosters`                                  | rosters:read  |
| `POST /v2/channels/{channelId}/rosters`                                 | rosters:write |
| `GET /v2/channels/{channelId}/rosters/{rosterId}`                       | rosters:read  |
| `PATCH /v2/channels/{channelId}/rosters/{rosterId}`                     | rosters:write |
| `DELETE /v2/channels/{channelId}/rosters/{rosterId}`                    | rosters:write |
| `GET /v2/channels/{channelId}/rosters/{rosterId}/members`               | rosters:read  |
| `PUT /v2/channels/{channelId}/rosters/{rosterId}/members/{memberId}`    | rosters:write |
| `DELETE /v2/channels/{channelId}/rosters/{rosterId}/members/{memberId}` | rosters:write |
| `GET /v2/channels/{channelId}/members/{memberId}/rosters`               | rosters:read  |

`PUT` subscribes (source `api`) and `DELETE` unsubscribes; both are idempotent. A Dispatch's audience takes the same `rosters` part through `PATCH /v2/channels/{channelId}/dispatches/{dispatchId}`.

## Decisions

- Rosters live inside a Channel and add to the Channel subscription; they don't replace it. A Broadcast without Rosters still goes to everyone (or its Circles).
- Roster and Circle parts combine with AND; the conflict policy decides only included-versus-excluded Roster overlaps, and excluded Circles always win, as before.
- Operators can't re-subscribe a Member who left a Roster themselves.
- One-Click from a Roster-targeted Broadcast leaves the Roster, not the Channel; the page offers leaving everything.
- Membership events go to the event log, to webhooks as `roster.*` and still as `member.updated`, and start Flows.
