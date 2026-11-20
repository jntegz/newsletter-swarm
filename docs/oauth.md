# OAuth apps

Third-party apps act on a workspace through the public API (`/v2`) or the MCP server (`/mcp`, [open-operator.md](open-operator.md)) with an OAuth 2.0 access token instead of an API key. Swarm supports one flow: **authorization code with PKCE**, `S256` only, required for every client, public or confidential. Every grant is bound to one resource ([RFC 8707](#resource-indicators-rfc-8707)). A client is either an app registered in a workspace or, for public clients such as MCP clients, a [Client ID Metadata Document](#client-id-metadata-documents) URL. Code: `workers/api/src/routes/oauth.ts` (protocol and consent), `routes/oauthApps.ts` (registration and authorised apps), `v2/oauth.ts` (tokens), `lib/oauthClients.ts` (metadata documents). Shared constants: `packages/domain/src/p7-platform.ts` and `p7-oauth.ts`. Tables: `oauth_apps`, `oauth_grants`, `oauth_tokens` (`migrations/0012_platform.sql`, indexes in `0014_oauth_sends.sql`), `oauth_client_documents` and the `resource` and `metadata_url` columns (`0031_oauth_mcp.sql`).

## Who registers, who authorises

- An app is **registered by one workspace** (Settings → Developers → OAuth apps, admin or owner). Registering counts against `PLAN_LIMITS.oauthApps` of that workspace (`conflict` when the count is reached).
- An app may be **authorised by an admin or owner of any workspace**: on the consent page the operator picks one of their own workspaces where they hold admin or owner, optionally limits the app to some Channels, and reviews the scopes. Operators below admin are not offered the workspace; the API refuses them too (`403`), and a workspace they have no seat in is `404`.
- The consent page names the workspace that registered the app. Any admin can register an app under any name, so that is not a check: only an app whose App Directory listing platform staff approved (`docs/app-directory.md`) is marked **Verified** (`verified: true` in `GET /api/v1/oauth/consent`); every other registered app says Swarm has not reviewed it. A change to the app's name, redirect URIs or homepage, or a wider scope, returns its listing to draft, so the pill only ever describes what staff reviewed. The homepage, which the page links to, must be https (http on a loopback host only in development).
- The resulting **grant** belongs to the authorising workspace. Its tokens carry that workspace's plan, never the registering workspace's.
- A grant stays live only while the operator who consented keeps admin or owner in that workspace. Demote or remove them and every token of the grant answers `401`.

## Registering an app

`POST /api/v1/workspaces/{workspaceId}/oauth-apps` with a name, a client type, redirect URIs and the scopes the app may ask for.

| Field          | Rules                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `clientType`   | `confidential` (runs on a server; gets a client secret) or `public` (browser or device; no secret, PKCE alone). Fixed once registered.                 |
| `redirectUris` | 1 to 10 absolute URLs, `https` (plain `http` only in development), no fragment, no credentials, no `*`. Authorization requests must match one exactly. |
| `scopes`       | A subset of `API_SCOPES`. Narrowing them later applies at once to every token already issued (tokens carry grant scopes ∩ app scopes).                 |

- The client id is `swc_` + 24 base62 characters. A confidential secret is `swcs_` + 40 base62 characters, returned once (on create and on `rotate-secret`); only its SHA-256 is stored. Rotation replaces the secret immediately; issued tokens keep working.
- `DELETE …/oauth-apps/{appId}` revokes the app: every grant and token of it, in every workspace, stops working.
- Registration, edits, rotations and revocations are audited (`oauth_app.*`).

## The flow

```
app                       browser                         Swarm
 │ code_verifier = random(43–128 chars)
 │ code_challenge = base64url(sha256(code_verifier))
 │──── redirect ─────────▶ GET /oauth/authorize?… ───────▶ checks the request (changes nothing)
 │                                                ◀─────── 302 /oauth/consent?…  (dashboard page)
 │                         operator signs in if needed, picks workspace and Channels, Allow
 │                         POST /api/v1/oauth/consent ───▶ creates the grant + single-use code
 │                                                ◀─────── { redirectUrl }
 │◀─── redirect_uri?code=…&state=…&iss=… ─────────────────
 │──── POST /oauth/token (code, redirect_uri, code_verifier, client auth) ──────▶
 │◀─── { access_token: oat_…, refresh_token: ort_…, expires_in: 3600, scope } ──
 │──── GET /v2/… Authorization: Bearer oat_… ───────────────────────────────────▶
```

### `GET /oauth/authorize`

Parameters: `client_id`, `redirect_uri`, `response_type=code`, `scope` (space-separated), `state`, `code_challenge`, `code_challenge_method=S256`, and optionally `resource` ([below](#resource-indicators-rfc-8707)).

- An unknown or revoked `client_id`, or a `redirect_uri` that is not registered for it character for character, shows an **error page** (`400`). It is never redirected, so the endpoint cannot be used as an open redirect.
- Every other problem goes back to the redirect URI with RFC 6749 §4.1.2.1 parameters (`error`, `error_description`, `state`, plus `iss`):
  - `unsupported_response_type`: anything but `code`.
  - `invalid_request`: no `code_challenge` (PKCE is required), a method other than `S256` (including a missing method, which RFC 7636 treats as `plain`), a malformed challenge, or no `state`.
  - `invalid_scope`: no scope, an unknown scope, or one the app may not ask for.
  - `invalid_target`: a `resource` Swarm does not serve.
  - `access_denied`: the operator chose Deny.
- A valid request is handed to the consent page with the same parameters. The GET changes nothing; the consent page reads the request back (`GET /api/v1/oauth/consent`) and posts the decision (`POST /api/v1/oauth/consent`, session and CSRF-checked like every `/api/v1` write). Both re-check the whole request.
- Every redirect back to the app carries `iss=<APP_ORIGIN>` (RFC 9207).

### `POST /oauth/token`

Form-encoded (`application/x-www-form-urlencoded`), as RFC 6749 requires; other content types are refused (`415`). Errors use the RFC shape `{ "error": "…", "error_description": "…" }`, not the API envelope, because OAuth client libraries expect it. Responses carry `Cache-Control: no-store`.

**Client authentication.** Confidential apps send `Authorization: Basic base64(client_id:client_secret)` or `client_id` and `client_secret` in the body (not both). Public apps send `client_id` only; a secret sent by a public app is refused. Failure is `401 invalid_client`.

**`grant_type=authorization_code`** needs `code`, `redirect_uri` (the same one as in the authorization request) and `code_verifier`.

- The code lives 60 seconds and is single-use. It is consumed with a conditional `UPDATE … WHERE code_consumed_at IS NULL`, so two concurrent exchanges cannot both succeed.
- A code presented a second time is refused (`invalid_grant`) **and revokes the grant and every token issued from it** (RFC 6749 §4.1.2).
- A wrong `code_verifier`, a different `redirect_uri`, an expired code or a code of another app is `invalid_grant`. These do not consume the code.

**`grant_type=refresh_token`** needs `refresh_token`.

- Refresh tokens **rotate on every use**: the response carries a new refresh token and the old one is marked used.
- All tokens issued from one grant share a `family_id`. **A refresh token presented after it was used revokes the whole family** (every access and refresh token of the grant, and the grant itself) and answers `invalid_grant`. The app must send the operator through the flow again.
- A refresh token presented by another app is `invalid_grant` and revokes nothing.
- An optional `scope` (RFC 6749 section 6) asks for less: the new access token, and the response's `scope`, carry only those scopes. Asking for a scope the grant does not hold is `invalid_scope`. The new refresh token keeps the grant's scopes, so a later refresh without `scope` gets all of them again.
- `scope` may be sent; asking for more than the grant holds is `invalid_scope`. Tokens always carry the grant's scopes (narrowing is not supported).

Both grant types take an optional `resource`. When sent it must name the grant's own resource, or the answer is `invalid_target` (checked before the code or refresh token is used, so a corrected request still works).

### `POST /oauth/revoke` (RFC 7009)

Form-encoded, with the same client authentication. `token` (and optional `token_type_hint`). Revoking a refresh token revokes every token of its grant; revoking an access token revokes that token. Unknown tokens and tokens of another app answer `200` and change nothing.

### Metadata

`GET /.well-known/oauth-authorization-server` (RFC 8414): issuer, endpoints, `code_challenge_methods_supported: ["S256"]`, the supported client authentication methods, `scopes_supported`, `authorization_response_iss_parameter_supported: true` and `client_id_metadata_document_supported: true`. There is no `registration_endpoint`.

### Why `/oauth/token` has no CSRF check

The token and revocation endpoints are called by the app's server, not by a browser carrying Swarm's cookie. They sit outside `/api`, so the CSRF middleware and session loading do not run there, and they never read cookies. They authenticate the client (secret or PKCE verifier) instead. Keep them outside `/api`.

## Resource indicators (RFC 8707)

A grant, and every token issued from it, is bound to exactly one resource, chosen by the `resource` parameter of the authorization request:

| `resource`                                        | Audience | Tokens work on |
| ------------------------------------------------- | -------- | -------------- |
| absent, `<APP_ORIGIN>/v2` or `<APP_ORIGIN>`       | `v2`     | `/v2` only     |
| `<APP_ORIGIN>/mcp` (what `/mcp`'s metadata names) | `mcp`    | `/mcp` only    |

- Scheme and host compare without case and one trailing slash is ignored. Any other value, a query or a fragment is `invalid_target`. One `resource` per request; to use both, an app authorises twice (two grants, each listed and revoked on its own).
- No `resource` means `/v2`, so apps written before resource indicators keep working unchanged (for unreviewed apps, see below). Grants made before migration `0031` are `/v2` grants: an MCP client that connected with one has to authorise again with `resource=<APP_ORIGIN>/mcp`.
- **Unreviewed apps get the MCP server only.** Allowing a `/v2` grant (resource absent or `/v2`) is refused (`forbidden`) unless the app is registered by the workspace being authorised, or platform staff approved its App Directory listing. A Client ID Metadata Document client, or an app another workspace registered under a name of its choosing, can connect only with `resource=<APP_ORIGIN>/mcp`, where the workspace's approval rules hold its sends, deletions and webhook endpoints. The consent page says so before the admin decides. Grants are audited (`oauth_grant.created`, with the resource) and listed for every admin under authorised apps, where any admin can revoke them. When an admin allows an app, the workspace's other owners and admins are emailed the app's name, who allowed it, what it can do and a link to **Settings → Developers → OAuth apps**, where they can revoke it.
- `/v2` answers `401` to a `/mcp` token and `/mcp` answers `401` (with its `WWW-Authenticate` resource metadata challenge) to a `/v2` token, the same answer as for any invalid token. API keys are not OAuth tokens and work on both, unless a key was created for an agent (MCP server only, [open-operator.md](open-operator.md#approvals)).
- Why one audience per token: the MCP specification asks an MCP server to accept only tokens issued for it, and a `/v2` integration has no business driving the agent surface (or the other way round). The tools inside `/mcp` call `/v2` routes in-process with the resolved principal, never with the token, so an `/mcp` token needs no `/v2` audience.
- Consent shows which one the app asks for ("the API" or "the MCP server"), and Settings → Developers → OAuth apps shows it on each authorised app.

## Client ID Metadata Documents

Public clients that have no registered app, MCP clients first of all, can use the https URL of a JSON document about themselves as their `client_id` ([draft-ietf-oauth-client-id-metadata-document](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00), the registration method the MCP authorization specification recommends; dynamic client registration, RFC 7591, is deprecated there and not offered). The authorization server metadata says so with `client_id_metadata_document_supported: true`.

```json
{
  "client_id": "https://agent.example/oauth/client.json",
  "client_name": "Agent Desk",
  "client_uri": "https://agent.example",
  "redirect_uris": ["http://127.0.0.1:33418/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

- **The URL.** `https`, with a path (not just `/`), no credentials, no fragment, in normal form (what the URL parser gives back). Its host must pass the outbound URL guard (no IP literals, `localhost`, single-label, `.local`, `.internal` or `.home.arpa` names).
- **When it is fetched.** Never by `/oauth/authorize`, which is unauthenticated: a URL `client_id` there is only checked for shape and the browser goes on to the consent page. The consent page (`GET /api/v1/oauth/consent`, signed-in operator) fetches the document, and the decision re-checks it.
- **The fetch.** `GET` with `redirect: manual` (a redirect is refused: the document must be at the `client_id` URL), at most 5 KB counted while it streams, 5 seconds in all. Anything but `200` with a JSON object is refused.
- **The document.** `client_id` must equal the URL character for character; `client_name` and `redirect_uris` (1 to 10) are required. Only public clients: `token_endpoint_auth_method` absent or `none`, and a document with `client_secret` is refused. `grant_types` (if given) must include `authorization_code` and nothing beyond `refresh_token`; `response_types` only `code`. Redirect URIs are `https` (no wildcard, fragment or credentials) or `http` on a loopback host (`127.0.0.1`, `[::1]`, `localhost`); custom schemes are refused. `client_uri` is shown only when it is https; logos are not shown.
- **Redirect matching.** Exactly as listed, except that a loopback redirect matches on any port (RFC 8252 §7.3), because native clients pick a free port each time.
- **Cache.** By URL, for `Cache-Control: max-age` clamped to 5 minutes to 24 hours (1 hour without one; `no-store` means 5 minutes). A failed fetch is remembered for 60 seconds. The token endpoint never fetches.
- **Abuse limits.** Each operator can cause at most 20 document fetches an hour (cached documents don't count); after that the consent page answers "Too many new apps were checked in the last hour". Fetching needs a signed-in operator, so the endpoint can't be used anonymously to make Swarm fetch URLs.
- **Consent.** The page shows "Unverified app", the host that serves the document and that nobody has checked it; the redirect host as always, and a warning when the redirect goes to this computer (a loopback address, which any local program can listen on). Only an admin or owner can allow it, as for every app, and any scope may be asked for: the operator decides.
- **What is stored.** Allowing creates one `oauth_apps` row per workspace and document URL (`metadata_url`; its own `client_id` is an internal `swm_…` value that is never used by the client). It is not a registered app: it is not listed among the workspace's apps, does not count against `PLAN_LIMITS.oauthApps` and can't be edited, but its grants appear under authorised apps (marked "Unverified", with the document's host) and are revoked the same way. Its name and redirect URIs are refreshed from the document on each consent.
- **Tokens.** The client sends the URL as `client_id` and no secret (a secret is `invalid_client`). Codes and refresh tokens are matched to the URL, so another client, registered or not, can't redeem them (`invalid_grant`).
- **Clean-up.** The jobs worker's daily cron deletes cached documents a week past expiry, and the app rows of metadata clients (older than a day) with no live grant: every grant revoked, or nothing left that can be used (no unused code, no unexpired unused refresh token). Their grants and tokens go with them.

## Tokens

| Token              | Format                     | Lifetime      | Stored       |
| ------------------ | -------------------------- | ------------- | ------------ |
| Authorization code | 32 random bytes, base64url | 60 seconds    | SHA-256 only |
| Access token       | `oat_` + 40 base62         | 1 hour        | SHA-256 only |
| Refresh token      | `ort_` + 40 base62         | 30 days       | SHA-256 only |
| Client secret      | `swcs_` + 40 base62        | until rotated | SHA-256 only |

An access token resolves (`resolveOAuthAccess`) to an `ApiPrincipal` with `kind: 'oauth'`, the grant's workspace and Channel list, scopes = grant scopes ∩ app scopes (∩ the subset a narrowing refresh asked for, stored on the token as `scopes_json`), the workspace's plan and no per-key rate cap. The principal id is the **grant id**, not the token id, so rate limits and `Idempotency-Key` replays carry over when the app refreshes. A replay needs the same scopes too: an access token from a narrowing refresh never gets the stored response of a request made with scopes it lacks (it gets `409`). A revoked or expired token, a revoked grant or app, or a consenting operator below admin all answer the same `401`.

## Operator controls

- Settings → Developers → OAuth apps lists the apps this workspace registered and, below, the apps authorised on this workspace (`GET /api/v1/workspaces/{workspaceId}/oauth-grants`): app, scopes, Channels, who authorised it and when it was last used.
- **Revoke access** (`DELETE …/oauth-grants/{grantId}`) revokes the grant and its tokens at once (audited `oauth_grant.revoked`).
- Every route needs the admin role; other workspaces' apps and grants are `404`.

## PKCE example

```js
const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
const challenge = base64url(
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
);
location.href =
  'https://app.swarm.example/oauth/authorize?' +
  new URLSearchParams({
    client_id: 'swc_…',
    redirect_uri: 'https://yourapp.example/callback',
    response_type: 'code',
    scope: 'members:read sends:write',
    state: crypto.randomUUID(),
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

// On the callback, after checking state:
const res = await fetch('https://app.swarm.example/oauth/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: 'https://yourapp.example/callback',
    code_verifier: verifier,
    client_id: 'swc_…',
  }),
});
const { access_token, refresh_token } = await res.json();
```
