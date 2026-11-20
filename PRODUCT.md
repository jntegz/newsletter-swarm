# PRODUCT.md — Swarm

> Product truth. Durable. Update deliberately.

## What it is

**Swarm** — a newsletter platform: write dispatches, grow a member list, run journeys, publish a site, and get paid. Built entirely on Cloudflare infrastructure with AWS SES as the outbound mail engine (behind a swappable adapter).

One-line: _The newsletter platform that runs itself at the edge._

## Who it's for

- Independent writers and operator-led publications (1–3 people) who send weekly and care about deliverability.
- Small editorial teams (3–15) who need roles, approval, and audit trails without enterprise contracts.
- Publishers moving from a hosted newsletter platform who want 0% platform take and privacy-first analytics.

## The job

"I want my words to reach inboxes, my list to grow, and my time spent writing — not stitching tools together."

## Positioning

Compared with hosted newsletter platforms, these are the honest edges:

- **Deliverability in the open:** enforced DMARC (≥ quarantine) before first send, parsed DMARC reports, visible warmup curve (Reputation Ramp), per-provider verdicts, unlimited lookback on paid plans.
- **Privacy by architecture:** zero third-party JS on product surfaces and on a website by default; first-party analytics built in. An owner can add their own analytics or other code to their website, which is their choice and waits for each reader's consent; optional field-level encryption for sensitive PII. Data lives in the operator's own Cloudflare account, in the region its database was created in; choosing a region per workspace is not built (docs/data-residency.md).
- **Security baseline higher:** passkeys/WebAuthn, SSO on Pro (not Enterprise-only), audit logs + granular roles on all paid plans, scoped/expiring API keys, HMAC webhooks with delivery log and redrive.
- **Cloudflare-native:** proxied tenant custom domains, tenant-level AI-bot rules, edge rendering <50ms, SES cost transparency.
- **0% take** on paid tiers; money moves directly through the publisher's Stripe.

## Product vocabulary

| Concept                 | UI word                                             | Internal name (schema/API)                  |
| ----------------------- | --------------------------------------------------- | ------------------------------------------- |
| Post / issue            | **Post** (a send = Send, its results = Send report) | **Dispatch** (a send = Broadcast)           |
| Subscriber              | **Subscriber**                                      | **Member**                                  |
| Publication / workspace | **Publication** (+ Workspace)                       | **Channel** (+ workspace)                   |
| Segments                | **Segments**                                        | **Circles**                                 |
| Automations             | **Automations**                                     | **Flows**                                   |
| Embeds / signup forms   | **Signup forms**                                    | **Capture Forms**                           |
| Referral program        | **Referrals** (area: Referrals & growth)            | **Champions**                               |
| Partner recommendations | **Partners**; credits = **Signals** (not built)     | **Partner Exchange**; credits = **Signals** |
| Sponsor bookings        | **Sponsors**                                        | **Sponsor Match**                           |
| Paid tiers / paywall    | **Paid plans** / **Paywall**                        | **Membership Levels** / **Gates**           |
| Digital products        | **Products**                                        | **Goods**                                   |
| Website builder         | **Website**                                         | **Site Studio**                             |
| Community               | **Commons**                                         | **Commons**                                 |
| Passwordless login      | **Sign-in link**                                    | **QuickPass**                               |
| Warmup engine           | **Warm-up**                                         | **Reputation Ramp**                         |
| Multi-list              | **Rosters**                                         | **Rosters**                                 |
| Subscriber self-serve   | **Subscriber settings**                             | **Member Center**                           |
| In-product AI           | **Copilot**                                         | **Copilot**                                 |
| MCP + agent access      | **Open Operator**                                   | **Open Operator**                           |
| Outbound API            | **Direct Send API**                                 | **Direct Send API**                         |

Since Nov 2026 the UI uses plain words (the "UI word" column). Code, the database and the API keep the internal names. Full list and rules: `docs/vocabulary.md` and `design/2026-11/RENAME.md`.

## Constraints (hard)

- Cloudflare only for app/runtime: Workers, D1, R2, KV, Queues, Durable Objects, Pages/Assets, Turnstile, Cron Triggers.
- Outbound email: **AWS SES** primary via `MailAdapter` interface; adapters for Emailjet/Mailgun/Resend possible. Cloudflare cannot send bulk outbound mail — never present it as an option.
- Payments: Stripe only, through Stripe Connect Standard (each Channel connects its own account; no application fee); no card data touches Swarm.
- Public API v2 uses Swarm's own resource shapes (the dashboard's schemas). Migration is import only (D2): exports from other newsletter platforms are accepted as an import source; there is no compatibility API for other platforms' endpoints.
- No third-party client-side analytics/tracking SDKs from Swarm itself. Code an owner adds to their own website is theirs.

## Design commitment

- Design system: the dashboard uses the **Line** system (see `DESIGN.md`).
- Voice: calm, plain, specific. Sentence case. No hype, no exclamation marks in product UI.
- All UI, copy, illustrations, and brand assets are original work. No other product's names, copy, or design are reused.
- Naming: "Swarm" pending trademark and domain clearance; treat as final until cleared.

## Current status

Greenfield rebuild started 2026-10-27. The first implementation is preserved under the `legacy-v0` tag; it was replaced because the core loop did not work and its security defaults were unsafe.

Decisions (2026-10-27):

- Rebuild from scratch on the same stack (Cloudflare Workers, D1, R2, KV, Queues, Durable Objects; SES; Stripe; React).
- The vocabulary above applies everywhere, **including the database schema**.
- Optional and later features ship behind feature flags, off by default.

Phase 0 (foundation) is done. Phase 1 (identity and Channels) is done locally: QuickPass and Google sign-in, sessions, roles, invites, audit log, Channels and media, and the dashboard shell. Phase 2 (editor and send engine) is built: the Dispatch editor with history and diff, the send flow with its checklist, the live send monitor, sending domains with the DMARC gate, tracking, unsubscribe, bounce handling and the media library. Phase 3 (audience and capture) is built: full Member management with typed and encrypted profile fields, tags, import with a dry-run report, export and bulk actions; Capture Forms with every placement and trigger, Turnstile, confirm opt-in, Gentle Reminders and the Member Center; Circles compiled to SQL with live counts, and sends targeted at Circles. Staging verification of both phases is outstanding.

## Success signals (first 90 days)

- First 100 channels created; ≥20 send weekly.
- ≥99% delivered with zero conscious spam complaints on onboarded domains.
- Every custom sending domain enforces DMARC (quarantine or reject) before its first send.
- Time-to-first-send under 10 minutes from signup.
