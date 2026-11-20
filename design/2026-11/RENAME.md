# Plain-word UI rename (Nov 2026)

These rules apply to **visible dashboard copy only**: JSX text, labels, `aria-label`, `title`, placeholders, button text, headings, empty states, toasts, confirmations and error/help text written in `apps/dashboard/src`.

**Never rename:**
- identifiers, types or component names
- file names or routes/URLs
- API paths, query keys, `data-*` attributes
- database or API field names
- server error codes (the messages the dashboard shows were renamed in a later pass, see `docs/vocabulary.md`)
- reader-facing pages served by workers (site, capture)

Database, API and code names stay as they are.

## Mapping

| Old (UI) | New (UI) | Notes |
| --- | --- | --- |
| Dispatch / Dispatches | Post / Posts | "New Dispatch" → "New post" |
| Broadcast (a send) | send | "Broadcast results" / Broadcast page → "Send report"; "Broadcast" as a verb → "send" |
| Member / Members | Subscriber / Subscribers | also "Paid Members" → "Paid subscribers" |
| Member Center | Subscriber settings | the reader's page for managing their subscription |
| Circle / Circles | Segment / Segments | |
| Flow / Flows | Automation / Automations | "Flow builder" → "Automation builder" |
| Capture form(s) | Signup form(s) | |
| Channel / Channels | Publication / Publications | "Create channel" → "Create publication" |
| Membership level(s) | Paid plan(s) | |
| Memberships (section) | Paid subscriptions | |
| Gate / Gates | Paywall / Paywall break | the editor node is "Paywall break"; settings page "Paywall" |
| Gift Pass(es) | Gift subscription(s) | |
| Site Studio | Website | |
| Reputation Ramp | Warm-up | |
| Preheader | Preview text | |
| Champions | Referrals | the growth area is "Referrals & growth" |
| Ask (polls) | Polls & surveys | |
| Signup Journeys, Series, Funnel Explorer, Smart Blocks | keep, in sentence case (Signup journeys, Series, Funnel explorer, Smart blocks) | |
| QuickPass | sign-in link | e.g. "Email me a sign-in link" |
| Workspace | Workspace | unchanged |

**Writing rules:**
- Sentence case. Use the lower-case forms mid-sentence (post, subscriber, segment, automation, publication).
- Fix grammar the swap creates: "a Member" → "a subscriber", "an automation", plural agreement.
- Don't leave half-renamed sentences.
- Keep strings short and plain. No exclamation marks.
