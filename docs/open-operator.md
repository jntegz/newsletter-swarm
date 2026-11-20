# Open Operator

Open Operator lets AI agents work in a Swarm workspace through the public API. It has three parts:

1. **The MCP server** (flag `open_operator_mcp`): a remote [Model Context Protocol](https://modelcontextprotocol.io) server at `/mcp` on the app's origin. Its tools are the `/v2` operations, authenticated with the same scoped API keys and OAuth access tokens.
2. **The agent audit log** (every plan): every tool call is recorded with the client, the credential, the tool, a masked summary of the arguments, the outcome and the latency, in a hash-chained table.
3. **Approvals**: destructive tool calls (sending a Broadcast, deleting Members, and so on) wait for a person to approve them before they run, unless the workspace chooses otherwise.

Code: `packages/domain/src/p8-operator.ts` (schemas, the destructive list), `packages/engine/src/operator.ts` (tool registry, masking, the log, approvals, `runAgentTool`), `workers/api/src/routes/mcp.ts` (the MCP endpoint and resource metadata), `workers/api/src/routes/operator.ts` (dashboard routes), `workers/api/src/lib/operator.ts` (credentials and dispatch). Tables: `migrations/0023_open_operator.sql`. Dashboard: Settings → Developers → Open Operator.

## Connecting a client

The endpoint is `https://<app origin>/mcp` (for example `https://app.swarm.example/mcp`). It speaks **Streamable HTTP**. Two ways to authenticate:

- **An API key** (simplest). Create one in Settings → Developers → API keys with only the scopes the agent needs, and send it as `Authorization: Bearer sk_live_…`. Every client below accepts a header.
- **OAuth.** The client discovers the authorization server from `/.well-known/oauth-protected-resource/mcp` and runs the authorization code flow with PKCE and `resource=<app origin>/mcp` (RFC 8707). A client that supports **Client ID Metadata Documents** (the registration the MCP specification recommends) needs nothing set up: it sends its document URL as `client_id`, and the consent page shows it as an unverified app with the host of its document ([oauth.md](oauth.md#client-id-metadata-documents)). Otherwise register a public OAuth app (Settings → Developers → OAuth apps) with the client's redirect URI and give the client its `swc_…` client id. Dynamic client registration (RFC 7591), deprecated in the specification, is not offered; such clients use a pre-registered id or a key.

The tools a client sees are exactly the operations the key's scopes allow. A key limited to some Channels can only reach those Channels.

### Claude Code

```bash
claude mcp add --transport http swarm https://app.swarm.example/mcp \
  --header "Authorization: Bearer sk_live_…"
```

### Claude Desktop and claude.ai

Settings → Connectors → Add custom connector, URL `https://app.swarm.example/mcp`. A connector that identifies itself with a Client ID Metadata Document connects without more setup; otherwise give, under advanced settings, the OAuth client id of your public OAuth app (its redirect URI must be the one the connector shows).

### Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "swarm": {
      "url": "https://app.swarm.example/mcp",
      "headers": { "Authorization": "Bearer sk_live_…" }
    }
  }
}
```

### VS Code

`.vscode/mcp.json`:

```json
{
  "servers": {
    "swarm": {
      "type": "http",
      "url": "https://app.swarm.example/mcp",
      "headers": { "Authorization": "Bearer ${input:swarm-key}" }
    }
  },
  "inputs": [
    { "id": "swarm-key", "type": "promptString", "password": true, "description": "Swarm API key" }
  ]
}
```

### Any other client

Point it at the URL with a Bearer header. A quick check with curl:

```bash
curl https://app.swarm.example/mcp \
  -H "Authorization: Bearer sk_live_…" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2026-07-28" -H "Mcp-Method: tools/list" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

## Protocol

- **Revision.** MCP **2026-07-28** (current, stateless: version, client identity and capabilities ride on every request's `_meta`). For clients that still open with an `initialize` handshake the server is _dual-era_: it also serves **2025-11-25** and **2025-06-18**. `initialize` answers with the version the client asked for when it is one of those (or 2025-03-26, which a request without `MCP-Protocol-Version` is taken to be), and with 2025-11-25 otherwise. Supported versions: `MCP_PROTOCOL_VERSIONS` in `p8-operator.ts`.
- **Transport.** One endpoint, `POST /mcp`, one JSON-RPC 2.0 message per request (batches are refused with `-32600`), answered with `application/json` (never an SSE stream: no tool needs progress). Notifications get `202` with no body. `GET` and `DELETE /mcp` answer `405`: there are no standalone streams and no sessions; an `Mcp-Session-Id` header is ignored and none is ever issued, for either era.
- **Modern requests** must carry `MCP-Protocol-Version` and `Mcp-Method` headers (plus `Mcp-Name` on `tools/call`) matching the body; a missing or mismatched one is `400` with `-32020` (HeaderMismatch). `Mcp-Name` may use the `=?base64?…?=` form. A missing `_meta` protocol version or client capabilities is `400` with `-32602`. An unsupported version is `400` with `-32022` and `data: { supported, requested }`. An unknown method is `404` with `-32601`. Results carry `resultType: "complete"` and `_meta["io.modelcontextprotocol/serverInfo"]`.
- **Methods.** `server/discover`, `tools/list`, `tools/call`, `ping`, and for legacy clients `initialize` and `notifications/initialized`. No resources, prompts, sampling, elicitation or subscriptions. The tool list does not change while the server runs (`listChanged: false`), though it differs per credential.
- **Origin.** A request with an `Origin` header other than the app's origin is refused (`403`), so a web page can't drive the endpoint through someone's browser. Clients that are not browsers send no `Origin`.
- **Limits.** The body is at most 1 MB. Each POST to `/mcp` takes one token from the same per-credential bucket as `/v2` (`RateLimit-*` headers, `429` with `Retry-After`); the `/v2` call a tool makes inside it is not counted again.

### Errors at the HTTP level

| Situation                                                 | HTTP | Body                                                                                                               |
| --------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------ |
| No credential, an invalid one, or a token not for `/mcp`  | 401  | `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"`, JSON-RPC error `-31001` |
| `open_operator_mcp` off for the workspace                 | 404  | JSON-RPC error `-31004`                                                                                            |
| MCP turned off in the workspace's settings                | 403  | JSON-RPC error `-31003`                                                                                            |
| `tools/call` of a tool the credential lacks the scope for | 403  | `WWW-Authenticate: Bearer error="insufficient_scope", scope="…", resource_metadata="…"`, JSON-RPC error `-31003`   |
| Rate limited                                              | 429  | `Retry-After`, JSON-RPC error `-31029`                                                                             |
| Body over 1 MB                                            | 413  | JSON-RPC error `-32600`                                                                                            |

Application error codes sit outside the JSON-RPC reserved range (`-32768` to `-32000`), as the specification asks.

## Authorization discovery

- `GET /.well-known/oauth-protected-resource/mcp` (RFC 9728, the path-inserted form for the `/mcp` resource) and `GET /.well-known/oauth-protected-resource` both return `resource: <APP_ORIGIN>/mcp`, `authorization_servers: [<APP_ORIGIN>]`, `scopes_supported` (every API scope), `bearer_methods_supported: ["header"]`, `resource_name` and `resource_documentation`. They are public and cacheable for an hour.
- The authorization server is the existing one: `/.well-known/oauth-authorization-server` (with `client_id_metadata_document_supported: true`), `/oauth/authorize`, `/oauth/token` ([oauth.md](oauth.md)).
- **Audience.** `/mcp` accepts only OAuth tokens issued for `resource=<APP_ORIGIN>/mcp` (RFC 8707, [oauth.md](oauth.md#resource-indicators-rfc-8707)). A token for `/v2`, including one from a request without `resource`, gets the same `401` and challenge as an invalid token, so the client authorises again for this server; `/v2` likewise refuses `/mcp` tokens. API keys work on both.

## Tools

Tools are **derived from the `/v2` OpenAPI document** at runtime (`deriveAgentTools`), the same document `/v2/openapi.json` serves, which is built from the `/v2` routers. A new `/v2` route becomes a tool with no change here, and a tool can't drift from its route.

- **Name**: the operation's `operationId` in snake_case (`listMembers` → `list_members`).
- **Title and description**: the operation's summary and description, plus the scope it needs and, for destructive tools, a note that the call may wait for approval.
- **Input schema**: an object with the path parameters and query parameters as properties, and the JSON request body under `body`. `$ref`s into the document's components are inlined (a self-referencing schema stops at depth 8 with an open schema), so the schema is self-contained, as the specification asks.
- **Annotations**: `readOnlyHint: true` for reads (a GET, or any operation whose scope is a `:read` scope, like previewing a Dispatch); `destructiveHint` for the destructive list below and for the writes that can be held by their effect (`CONDITIONAL_HOLD_OPERATIONS`, whose description says when); `idempotentHint` for GET, PUT and DELETE; `openWorldHint: true` for tools that reach outside Swarm (`OPEN_WORLD_OPERATIONS`: they send email now or as a result, call a webhook endpoint or fetch a URL), whose description says so, and `false` for the rest. The API test suite keeps a snapshot of every tool's risk and hints, so a change to them is a reviewed change. Hints are advice to clients; the server's holds never depend on them.
- **Which are listed**: only tools the credential's scopes allow (a `:write` scope grants its `:read`), as the specification permits. `get_agent_approval` is always listed.
- **Calling**: the arguments become a request to the `/v2` route (path parameters encoded, query string, JSON body; a path parameter that is `.` or `..` is refused, and the in-process dispatch refuses any path that a URL would resolve to a different one), which runs **through the API worker's own router**, with every middleware and the route's scope and Channel checks. No business logic is repeated; validation errors, `404`s for other workspaces' Channels and plan limits come from the route itself. The request carries the caller's principal internally (it is never re-authenticated from a secret) and skips the rate limiter, since the `/mcp` request was already counted.
- **Results**: a `2xx` answer is a result with the JSON as text content and as `structuredContent`; any other status is a result with `isError: true` and the API's error envelope, so the model can correct itself. A tool the credential lacks the scope for is refused at the HTTP level before anything runs (see above). An unknown tool or arguments that aren't an object is a JSON-RPC `-32602`.

### Destructive tools

`destructiveHint: true`, and held for approval when the workspace asks for it (`DESTRUCTIVE_OPERATIONS` in `p8-operator.ts`):

| Tool                                                 | Why                                                            |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| every `DELETE` operation                             | deletes something                                              |
| `schedule_dispatch`                                  | sends a Broadcast to Members                                   |
| `create_direct_send`                                 | sends an email                                                 |
| `unsubscribe_member`                                 | removes a Member from mail                                     |
| `bulk_upsert_members`, `confirm_import`              | changes many Members at once                                   |
| `enrol_in_flow`                                      | starts a Flow that sends email                                 |
| `rotate_webhook_secret`                              | breaks receivers that have not got the new secret              |
| `redrive_webhook_deliveries`                         | re-sends every failed delivery                                 |
| `create_feed_source`, `update_feed_source`           | a feed in `send` mode schedules and sends posts on its own     |
| `create_webhook_endpoint`, `update_webhook_endpoint` | sends Member data, emails included, to the endpoint's address  |
| `create_member`                                      | mails a person (confirmation or posts) and starts join Flows   |
| `send_member_event`                                  | starts the Flows that wait for the event, like `enrol_in_flow` |

A test checks every name on the list is a real operation.

### What is held

Whether a call waits follows what it would do, not only its method. A write is held like a destructive call (`risk: destructive` on its log row and approval, with `hold_reason`) when it reaches an effect a held tool has, decided by the server per call (`classifyCall`):

| Tool                      | Held when                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `update_member`           | the body changes `status` (an operator can't undo an unsubscribe) or replaces `tags`; or sets `fields` while a live Flow of the Channel starts on a field change |
| `update_dispatch`         | `webVisibility` widens who can read the post on the website (hidden → paid → members → public)                                                                   |
| `add_member_tags`         | a live Flow of the Channel starts on a tag being added                                                                                                           |
| `set_member_fields`       | a live Flow of the Channel starts on a field change                                                                                                              |
| `subscribe_roster_member` | a live Flow of the Channel starts on joining a Roster                                                                                                            |
| any write                 | the workspace bounds exposed credentials and this key or grant read outside text recently (below)                                                                |

**Consent an agent asserts.** `create_member` with `consent: true` through a tool call (MCP or Copilot) makes the Member active only when a person approved the call, who then takes responsibility for the attestation: the consent record's `attested_by` is `<approving operator id>+<credential>` (for example `op_…+key:ak_…`). When nothing held the call (approval mode `never`), the Member starts `pending` and is sent nothing, and `attested_by` names only the credential (`key:…`, `oauth:…`, `copilot:…`), so the person can later be told how they were added. A direct `/v2` call is the integration's own attestation, as before. Whether any attested basis is adequate is a legal question for the workspace.

`check_feed_source` is not held: a check never turns a turned-off `send` source back on and never schedules a Dispatch from one ([feed-sync.md](feed-sync.md)); resuming the source is `update_feed_source`, which is.

### Text from outside the workspace

Some read results carry text that people outside the workspace wrote: Member names, field values and leaving reasons (from public forms and the Member Center) and feed titles and links (`THIRD_PARTY_TEXT_OPERATIONS`). The server marks such a result: its text content starts with a line saying it holds outside text that is data, not instructions, and `_meta["io.swarm/untrustedContent"]` is `{ fields: [...], source: "outside_workspace" }`. Marking helps only clients that honour it. A workspace can also bound what a credential does after reading such text: with **After an agent reads Member or feed text, hold its changes for** set (`exposedHoldMinutes`, 0 to 1,440; 0, the default, is off), every write by a key or grant that ran one of those tools successfully within that many minutes is held for approval (the agent log is the record of what it read). The window is per credential, so a key shared by several agents is held because of any of them. Copilot has its own rule (any tool result holds later writes) and is not affected.

A tool call can't change what a scheduled Dispatch sends: `update_dispatch` answers 409 when it touches `subject`, `preheader`, `content`, `coverImage`, `senderIdentityId` or `audience` of a Dispatch with status `scheduled`. The schedule was approved for what the Dispatch held then; a person unschedules it, and scheduling it again goes through approval. Direct `/v2` calls with an API key are not affected.

Nor can an edit made while a schedule waits ride on its approval. A held call on a Dispatch stores what it acts on (`target_json`: subject, preheader, status, web visibility, sender, audience definition and a digest of the send fields). The approver sees that, and approval runs the call only if the digest still matches: otherwise the approval ends `failed` ("The post changed after this call was held…"), nothing runs, and the agent asks again so the change gets its own decision. The approved thing is the audience **definition** (Circles, Rosters, tags as chosen); who matches it is resolved at send time, as for a schedule made in the dashboard.

### `get_agent_approval`

A tool of the server itself (not a `/v2` operation): `{ approvalId }` → the approval's status, expiry and, once it ran, the result. A credential only sees approvals its own calls created (another credential gets "not found").

### `get_channel_context`

The tool an agent should call first: `GET /v2/channels/{channelId}/context` (`channels:read`). It returns what a person sitting down to write would know: the publication's name, description and web slug; the operator's **style guide** (written on the publication's page under Publications); with `members:read`, the audience by numbers (active and paid Members, joins and leaves in the last 30 days); and with `dispatches:read` and `broadcasts:read`, the last ten sent posts with their honest numbers (human opens and clicks, machine traffic excluded) and web addresses. A part the credential's scopes don't allow is `null`, so a narrow key can't read Members or stats through this tool. Point an agent at it before it drafts, so tone, length and cadence match the publication. Copilot's writing features also get the style guide ([copilot.md](copilot.md)).

## Agent-written drafts

A Dispatch started by `create_dispatch` through the MCP server is marked `created_via = 'agent'` on the row (`'copilot'` for Copilot actions, `'api'` for a direct `/v2` call, `NULL` for a teammate in the dashboard), and the Posts list shows and filters it, so nothing an agent wrote is mistaken for a teammate's work. A Dispatch Feed Sync started has `from_feed = 1` and the API reports it as `createdVia: 'feed'`. The agent audit log keeps the full story of which credential made it.

The mark is a label, not a lock. `dispatches:write` also allows `schedule_dispatch`. Through `/mcp` that call waits for a person under the rules in [Approvals](#approvals); a direct `/v2` request with the same key doesn't go through approvals.

## Running an agent on a schedule

Swarm doesn't run agents itself, so it needs no model and adds no AI bill. To have an agent write something every week, run any MCP client on a schedule of your own (cron, a CI job, or your client's scheduled tasks) and point it at this server.

1. Create an API key for it with only `channels:read` and `dispatches:write`, limited to one publication. Add `members:read` and `broadcasts:read` if it should see the audience and how recent posts did.
2. Give it a prompt that ends in a draft:

   > Call `get_channel_context` and follow the style guide. Call `list_feed_sources`, then `list_feed_items` for what's new this week. Write a post about the theme they share, and save it with `create_dispatch`. Don't schedule it.

3. Read the draft in Posts, where it is marked as started by an agent, and send it yourself.

If an agent does call `schedule_dispatch`, it waits for a person under the [approval rules](#approvals). That holds for calls through `/mcp` only, so keep the key in the MCP client. To let items go out with no agent involved, a [Feed Sync digest](feed-sync.md) can make a draft on set days by itself.

## Agent audit log

Every `tools/call` that names a tool writes one `agent_actions` row, on every plan, whatever the outcome. Protocol-level failures before a tool is chosen (bad headers, unknown methods, `401`) are not tool calls and are not recorded.

| Column                           | Meaning                                                                                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `source`                         | `mcp` (a client called the tool), `copilot` (Ask Copilot to do it, [copilot.md](copilot.md)) or `approval` (an operator approved a held call and it ran)                                                                             |
| `principal_kind`, `principal_id` | `key` + the API key id, `oauth` + the OAuth grant id, or `copilot` + the operator's id (the dashboard shows the key name and prefix, the app name, or "<address> via Copilot")                                                       |
| `client_name`, `client_version`  | `_meta` `clientInfo`, or for legacy clients the `User-Agent` (self-reported, for display only; at most 100 characters). The dashboard shows it as a claim ("client says …") beside the server-resolved credential                    |
| `copilot_request_id`             | for a Copilot call, the `copilot_requests` row of its run (hashed into the row when set)                                                                                                                                             |
| `tool`, `channel_id`, `risk`     | the tool name (at most 128 characters, so an unknown name is recorded too), the `channelId` argument if any (else the body's `channelId`, for workspace-level tools such as webhook endpoints), and `read`, `write` or `destructive` |
| `arguments_json`                 | the masked summary (below)                                                                                                                                                                                                           |
| `outcome`                        | `ok`, `error` (the route refused it, or the tool is unknown), `denied` (missing scope; for an approved call, a credential or flag that no longer allows it) or `pending_approval`                                                    |
| `status_code`, `error_code`      | the route's HTTP status and error code, when there was one                                                                                                                                                                           |
| `latency_ms`                     | from receiving the call to having the answer                                                                                                                                                                                         |
| `approval_id`                    | the approval this call created, or the approval it ran                                                                                                                                                                               |
| `seq`, `prev_hash`, `hash`       | the tamper-evident chain                                                                                                                                                                                                             |

**Masking.** The summary keeps the shape of the arguments and only what is safe to keep: ids (`mb_…`), numbers, booleans, and short token-like strings (at most 40 characters of letters, digits and `_.:-`) only under an argument name listed in `SAFE_ARGUMENT_KEYS` (`status`, `mode`, `scope`, `tags`, `webVisibility`, `publishAt` and the like). Any other string, a license key, a search term, or an argument nobody has listed yet, is reduced to its length until it is added there. Values under keys that name personal or secret data (`email`, `name`, `firstName`, `phone`, `address`, `fields`, `ip`, `note`, `message`, `secret`, `password`, `token`, `url`, and body text such as `html`, `text`, `content`, `subject`, `preheader`) become `"[redacted]"`; any other string becomes `"[text, N chars]"`, and anything that looks like an email address becomes `"[email]"`. Arrays keep their first 10 items and a count; depth stops at 5; the summary is at most 2 KB.

**Tamper evidence.** The same scheme as `audit_events`: rows are numbered per workspace (`seq`), and `hash = sha256(prev_hash + "\n" + canonical JSON of the row)`, so editing or deleting a row breaks verification from there on. Rows are written once, after the call finishes, and never updated (approval execution writes a new row). Writers race on `UNIQUE (workspace_id, seq)` and retry. The dashboard shows whether the chain verifies (`GET …/agent-actions/verify`). A request checks at most 10,000 rows, oldest first; while `complete` is false, `ok` covers only the rows checked so far and the client passes `nextCursor` as `cursor` to go on (the dashboard does until the end), so no request reads a whole long log. The cursor is signed (AUTH_KEYS) for its workspace and chain, since it vouches for the rows the earlier requests checked, and each response's `fromSeq` says where that request started.

**Retention.** `max(plan audit retention, 90 days)` (enterprise: kept), applied by the jobs worker's daily cron (`pruneAgentLog`, at most 5,000 rows per workspace a run). As for the audit log, the rows to delete and the first kept row (its link and its own hash) are verified first (a broken chain is never pruned), then one batch moves `agent_action_anchors` to the last pruned row and deletes up to it; verification and new rows continue from the anchor. Unlike the audit log, no prune entry is chained into the agent log itself (it has no system rows); the cron logs each prune.

**Also in the audit log.** `/v2` writes made by a tool are audited as before (null actor, `metadata.via` naming the key or grant). Settings changes and approval decisions are audited (`agent_settings.updated`, `agent_approval.approved`, `agent_approval.rejected`).

## Approvals

A workspace's **approval mode** decides which `/mcp` calls wait for a person, whether or not Copilot is on:

- `destructive` (the default): the destructive tools above.
- `writes`: every tool that is not read-only.
- `never`: nothing waits.

Approvals cover calls through `/mcp` and Copilot. A direct `/v2` request runs with its key's scopes and isn't held, so give an agent's key to its MCP client, not to code that calls `/v2`.

**Keys for agents.** When an admin creates an API key, the dashboard asks who uses it. A key for "An AI agent" (`surface: "mcp"`, the dashboard's default) works on `/mcp` only and `/v2` answers `401` for it, so whoever obtains its value (a leaked config, a compromised agent host, a WordPress options table) can't skip the holds by calling `/v2`. A key for "An integration" (`surface: "both"`) also works on `/v2` directly, where nothing is held; that is a deliberate choice for code the workspace runs itself. Keys created before this, and keys created through the API without `surface`, are `both`; an admin can change a key's surface with `PATCH …/api-keys/{id}`. OAuth tokens were already bound to the resource they were issued for. The scheduled-post lock above still applies to tool calls only: an integration key may correct a scheduled post directly.

A held call:

1. Is checked first: the credential must hold the tool's scope and, when a `channelId` is given, be allowed that Channel. A call that would be refused anyway is refused now, not queued.
2. Creates an `agent_approvals` row (`pending`) with the exact request (method, path, JSON body), the masked summary, the credential and the client, expiring after the workspace's **approval window** (1 to 72 hours, default 24).
3. Returns a normal tool result (`isError: false`) with `structuredContent: { status: "pending_approval", approvalId, expiresAt }` and text telling the model the call is waiting for a person. The agent can poll `get_agent_approval`.

An admin or owner approves or rejects it in Settings → Developers → Open Operator, where the request is shown in full.

- **One intent, one decision.** A call identical to one of the same credential that is still waiting (same tool, method, path and body) joins it: the result names the existing `approvalId` with `duplicate: true`, its log row has `error_code` `duplicate`, and no second approval is added. To run the same thing twice on purpose, wait for the first to be decided. A write that runs at once can be retried safely after a lost answer by sending an `Idempotency-Key` header on the `/mcp` request (1 to 200 visible characters): the call runs through the `/v2` idempotency store (`agent-call-<key>`), so the retry gets the first answer back instead of running again.
- **What the approver sees.** The request, and what it acts on as the server looked it up when it was held (a post's subject, sender and audience; a Member's id and status; a feed source), plus why a write was held when its tool isn't destructive by itself. The client's self-reported name is shown as a claim; the credential (key name and prefix, app, or operator via Copilot) is what the server verified.
- **A second person (optional).** With **Need a second person** on (`separateApprover`, off by default), the person who caused a held call can't approve it, in the dashboard or in Copilot: the operator who asked Copilot, the API key's creator, or the admin who consented to the OAuth grant (and who registered the app in this workspace). Another admin must (`forbidden` otherwise). A workspace with a single admin leaves it off or adds a second admin. The decision is audited with the deciding operator as before.
- **Exactly once.** Approving claims the row with one conditional update (`pending` and not expired → `approved`), so two clicks, two tabs or two admins can't run it twice. The stored request is then run once, through the same internal `/v2` dispatch, with `Idempotency-Key: agent-approval-<id>`. The row ends `executed` (2xx) or `failed`, with the status code and a masked summary of the answer, and the stored body is cleared. If the worker dies between the claim and the result, the row stays `approved` with no result and is never run again on its own; the dashboard shows "Outcome unknown".
- **Finding out an unknown outcome.** After 10 minutes (`APPROVAL_STUCK_MS`) an admin can choose **Find out what happened** (`POST …/agent-approvals/{id}/resolve`, audited as `agent_approval.resolved`). It sends the stored request again under the same `Idempotency-Key: agent-approval-<id>`, so the `/v2` idempotency store answers for the first attempt: a stored answer is replayed and recorded (`executed` or `failed`, `result.summary.replayed: true`, no second effect); a first attempt that started and left no answer runs nothing, and the row stays `approved` with a note to check the target; a request that never reached the API runs now, once (two admins resolving at once run it at most once). Authorisation and the target are checked again as on approval. The store keeps keys for 24 hours; after that the row can only be checked by hand. A call that answered with a server error ends `failed` with a note that part of its effect may have happened.
- **Authorisation is checked again at that moment**, not taken from the time of the call: the approver must be an admin or owner of the workspace now; `open_operator_mcp` must still be on and MCP still allowed in settings (for a call Copilot held, `copilot` and `copilot_actions`); the API key must still exist, be unrevoked and unexpired, or the OAuth grant and app must be unrevoked with at least one live token and the consenting operator still admin or owner; and the credential must still hold the tool's scope and reach the Channel. The route's own checks then run as for any call. A failed check ends the approval `failed` with the reason and runs nothing. (The key's IP allowlist was checked when the call was made; it is not checked again, because the request now comes from the dashboard.)
- **Rejecting** needs the admin role too, works while the approval is pending, takes an optional reason (at most 500 characters), and clears the stored body.
- **Stored path.** Once decided (or expired), the stored path keeps ids and the route's own words; any other segment and every query value not under a listed argument name becomes `[value]` (`maskPath`).
- **Expiry.** A pending approval past `expires_at` reads as `expired` and can't be approved or rejected. Expiry is computed when read, not written by a GET. The daily cron clears the stored body of expired approvals.
- **Erasure.** A Privacy Center erasure clears the stored body, path, summary and result of every approval in the workspace that mentions the address or one of the erased Member ids, and cancels it if it was pending (`canceled`). An address inside a longer one (`ann@` in `joann@`) is not a mention; a body with more than 512 copies of the address is treated as one, so the erasure stays quick.
- The approval queue is not plan-limited; each credential can have at most 50 pending approvals (`conflict` beyond that), so an agent in a loop can't flood it.

## Settings

`agent_settings`, one row per workspace, created on first save (defaults apply without it):

| Setting               | Default       | Notes                                                                                  |
| --------------------- | ------------- | -------------------------------------------------------------------------------------- |
| `mcpEnabled`          | `true`        | Off: `/mcp` answers `403` for every credential of the workspace (`/v2` is unaffected). |
| `approvalMode`        | `destructive` | `never`, `destructive` or `writes`.                                                    |
| `approvalTtlHours`    | `24`          | 1 to 72. Applies to approvals created afterwards.                                      |
| `separateApprover`    | `false`       | The person who caused a held call can't approve it ([Approvals](#approvals)).          |
| `exposedHoldMinutes`  | `0`           | 0 to 1,440: hold a credential's writes after it read outside text (0 = off).           |
| `copilotMemberDetail` | `masked`      | `masked` or `full`: what Copilot's model sees of Members ([copilot.md](copilot.md)).   |

## Dashboard API

All under `/api/v1/workspaces/{workspaceId}`, cookie session, admin role or higher; another workspace is `404`.

| Route                                        | What                                                                          | Flag                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------- |
| `GET /agent-settings`                        | Settings, both flags, the MCP URL and the pending count                       | none                                     |
| `PUT /agent-settings`                        | Change settings (audited)                                                     | `open_operator_mcp`                      |
| `GET /agent-actions`                         | The log, newest first, cursor-paged; filters `outcome`, `tool`, `principalId` | none (the log is on every plan)          |
| `GET /agent-actions/verify`                  | Verifies the chain, a page at a time (`cursor`, `limit`, `complete`)          | none                                     |
| `GET /agent-approvals`                       | Approvals, newest first; filter `status` (`pending` by default, `all`, …)     | none                                     |
| `GET /agent-approvals/{approvalId}`          | One approval with the stored request                                          | none                                     |
| `POST /agent-approvals/{approvalId}/approve` | Approve and run it (audited)                                                  | `open_operator_mcp` or `copilot_actions` |
| `POST /agent-approvals/{approvalId}/reject`  | Reject it (audited)                                                           | none (a held call can always be refused) |

## Reuse by other agents

The registry, the log and the approval queue live in `@swarm/engine` (`operator.ts`) so an in-product agent such as Copilot can use them:

```ts
const outcome = await runAgentTool(deps, {
  principal, // AgentPrincipal: kind, id, workspaceId, channelIds, scopes
  source: 'mcp', // the caller's source label; Copilot would add its own
  client: { name: 'Copilot', version: null },
  toolName: 'schedule_dispatch',
  arguments: { channelId, dispatchId, body: { at } },
});
// outcome.kind: 'result' | 'pending_approval' | 'denied' | 'unknown_tool' | 'invalid_arguments'
```

`deps` supplies the D1 database, the tool list (`deriveAgentTools(v2OpenApiDocument())`), the approval policy and a `dispatch(principal, request)` function that runs a `/v2` request; the API worker's `operatorDeps(c)` builds it. Approving goes through `approveAgentApproval`, which takes `resolvePrincipal(kind, id, row)` and `blockedReason(row)` callbacks so the caller decides how a credential is re-checked and which flags apply to the row.

Copilot uses exactly this (`runCopilotActions` in `packages/engine/src/copilot-actions.ts`): principal kind `copilot` (the operator's id, scoped to one Channel and the scopes of their role), source `copilot`, client name `Copilot` (`migrations/0030_copilot_actions.sql` widens the `CHECK` values). For a `copilot` row, approval re-resolves the operator's role and Channel access at that moment (`copilotPrincipal` in `workers/api/src/lib/operator.ts`) and needs `copilot` and `copilot_actions` instead of the MCP flag and setting.

## Decisions

- **MCP revision 2026-07-28, dual-era.** It is the current revision (checked 2026-10-28). It is stateless, which fits a Worker. Many clients still speak 2025-11-25 or 2025-06-18, so `initialize` is answered too. Both eras are served without sessions.
- **At `/mcp` on the API worker, same origin as `/v2`.** It reuses the credentials, the rate limiter and the routers in-process. `run_worker_first` gains `/mcp`. No new binding, secret or worker.
- **Hand-rolled JSON-RPC, no SDK dependency.** The surface is small (five methods, JSON responses only) and the official SDK pulls in Node transports.
- **Tools come from the OpenAPI document, executed through the router.** This is what makes "same scope, same code path" true by construction. The alternative, calling route handlers directly, would have meant a second calling convention per handler.
- **The internal request carries the principal, not the secret.** A `WeakMap` keyed by the `Request` object (`v2/internal.ts`) hands the resolved principal to `authenticateV2`; it can't be forged from outside because only code in the worker can create that `Request` object. Rate limiting skips it; idempotency applies (approvals use it).
- **Audience-bound tokens, one audience each.** Each OAuth grant is bound to `/v2` or `/mcp`, and each refuses the other's tokens, as the specification asks of MCP servers. A token never carries both: the tools reach `/v2` in-process with the resolved principal, so an `/mcp` token needs no `/v2` audience. Requests without `resource` mean `/v2`, so existing API integrations are unchanged.
- **Client ID Metadata Documents, not dynamic registration.** The specification recommends metadata documents and keeps RFC 7591 only for backwards compatibility. Documents are fetched on the consent page for a signed-in operator only, through the outbound URL guard, and the client is shown as unverified ([oauth.md](oauth.md#client-id-metadata-documents)).
- **Scope errors on `tools/call` are HTTP 403 with a `WWW-Authenticate` challenge**, so OAuth clients can step up, as the authorization specification recommends. Route errors after the scope check (validation, not found, plan) are tool results with `isError`.
- **Pending approval is a completed tool result, not MRTR `input_required`.** The input comes from an operator in the dashboard, maybe hours later, not from the person at the client, and `input_required` expects the client to answer it.
- **Separate chain for agent actions.** The agent log is on every plan and has its own retention, so it can't share `audit_events`' chain and anchors; it copies the scheme.
- **The log is written after the call**, so the row holds the outcome and latency and is never updated, which keeps the hash chain simple.
- **Approval re-runs the stored request, not a fresh tool call.** "Exactly what the agent asked" is the request that was shown to the approver.
- **Masking keeps less rather than more.** Ids stay so an operator can see what was touched; erased Members' ids remain in the chained log (as in `audit_events`), never their addresses.

## Not built

- Resources, prompts, sampling, elicitation, `subscriptions/listen`, SSE responses and progress notifications.
- Dynamic client registration (RFC 7591), deprecated in the specification (see Decisions).
- Per-tool approval rules and per-tool allow or deny lists beyond scopes; an outbound notification when an approval is waiting (the dashboard shows a count).
- The Copilot side (its principal, UI and model calls) is in [copilot.md](copilot.md) "Ask Copilot to do it".
