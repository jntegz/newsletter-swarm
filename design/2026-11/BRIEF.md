# Redesign round, Nov 2026 — shared brief for all three directions

Swarm is a newsletter platform for independent writers and small editorial teams (1–15 people). They use the dashboard on a laptop, in daylight, a few times a week: write a post, send it, check how it landed, glance at growth. Some check results on a phone (390px).

The goal of this round: people find their way instantly, and the post editor is easy. Three directions, each a **Home** dashboard and a **post editor**, as static clickable HTML mockups. Each direction has its own visual world AND its own layout; all three share the information architecture, content, and behaviour below.

## Rules that apply to every file

- One self-contained HTML file per screen: inline `<style>`, small inline vanilla `<script>`, no frameworks, no CDN, nothing fetched from the network. Fonts load with `@font-face` from `../fonts/*.woff2` (files already there, see each direction).
- Light mode. Standard web controls (button, input, select, radio, checkbox, tabs, details). Every interactive element is keyboard reachable with a visible focus ring themed from the palette. Theme `::selection`, caret-color, scrollbars, `accent-color`.
- Icons: authored inline SVG, 24px viewBox, stroke 2 (or the direction's stated weight), round caps, `currentColor`, one consistent style. **No emoji, no Unicode glyphs as icons** (no •, →, ✓ characters as icons; draw them).
- `font-variant-numeric: tabular-nums` on every number.
- Contrast: body text ≥ 4.5:1, large text ≥ 3:1, including on coloured surfaces (tint secondary text from the surface hue, never plain grey on colour).
- Voice: calm, plain, specific, sentence case, no exclamation marks, no hype. Buttons name their action ("New post", "Send to 12,731 subscribers").
- Every screen shows a small "Sample data" label (e.g. in the footer or beside the page title). Never present sample numbers as real claims.
- Responsive: must work at 1440 and at 390 wide. Narrow: navigation collapses to a top bar with a menu button that opens the nav; multi-column areas stack; nothing overflows horizontally (tables may scroll inside their own container).
- Motion: 150–200ms state transitions only (hover, open/close). No page-load choreography. Honour `prefers-reduced-motion`.
- A tiny fixed "mockup switcher" pill in the bottom-right corner: `Design X · Name — Home | Editor | All designs` linking `home.html`, `editor.html`, `../index.html`. Small, quiet, never covering content at 390px (move it into normal flow at the page bottom on narrow screens).

**Banned** (these mark AI-made UI): gradient text; glass/blur decoration; coloured `border-left`/`border-right` thicker than 1px on cards, list items or alerts; hard offset shadows (`4px 4px 0`); glows; decorative blobs/radial glows; eyebrow/kicker labels above headings; section numbers like 01/02/03 (unless the number is a real step order); same-size icon+heading+text card grids as page structure; nested cards; the "big number + tiny label + accent" hero-metric template as the lead of the page; sparklines/rings standing in for content; monospace as a "techy" costume (mono is fine for figures and DNS records only); emoji. Fewer boxes: use alignment, rules and whitespace before reaching for a card.

## Information architecture (identical in all three; presentation differs)

Publication switcher at the top of the shell: **Field Notes** (fieldnotes.example) with a menu: Field Notes (current), Morning Ledger, + "New publication", "Manage publications". Publications are a context, not a menu item.

Navigation, grouped:

- **Home**
- **Write:** Posts · Templates
- **Audience:** Subscribers · Segments · Signup forms
- **Grow:** Automations · Referrals & growth
- **Earn:** Paid subscriptions
- **Publish:** Website · Sending & delivery
- **Settings** (separate, at the end)

Signed-in person: **Mara Lind**, Owner. Every page shows a visible page title and a breadcrumb (e.g. `Field Notes / Home`, `Field Notes / Posts / Notes on the popup economy`).

⌘K / Ctrl+K (and clicking the search field) opens a command menu overlay: a text input plus grouped results — "Jump to" (Posts, Subscribers, Sending & delivery, Settings), "Create" (New post, Import subscribers, New segment), "Recent" (#42 The slow web, revisited; Notes on the popup economy). Esc closes. Arrow keys optional; clicking works.

Non-built destinations are links to `#` (fine for a mockup). "Posts" in the nav and every post title that is a draft link to `editor.html`.

## Home — what it answers, in this order

1. **What needs me?** Setup steps (first run) or open problems (established).
2. **What's next?** The next scheduled post and drafts in progress.
3. **How did the last send do?** Delivered, opened, clicked, with history.
4. Then growth (subscribers, automations, referrals) and revenue.

The page header has the title "Home", the breadcrumb, a "Sample data" label, a segmented **state toggle "Setup | Established"** (switches the whole page between the two states with JS; default Established; also honour `?state=setup`), and the primary **New post** button. New post opens a small popover/menu "Start from": **Blank post**, **Template: Weekly issue**, **Duplicate #42 The slow web, revisited** — each links to `editor.html`.

### Established state content (use exactly these numbers)

- **Needs you** (1 item): "#43 sends Fri 31 Oct, 06:00 — preview text is empty. Inboxes will show the first line of the post instead." Action: "Add preview text" (links to editor.html).
- **Up next:** #43 "The gate question: free or paid?" — scheduled Fri 31 Oct, 06:00 — to Everyone, 12,731 subscribers. Draft: "Notes on the popup economy" — edited 2h ago, 642 words.
- **Last send:** #42 "The slow web, revisited", sent Tue 28 Oct, 06:00. Queued 12,731 → Delivered 12,617 (99.1%) → Opened 6,081 (48.2% unique) → Clicked 593 (4.7%). Unsubscribed 9, bounced 114 (0.9%), spam complaints 0. Inbox placement by provider: Gmail 99.4%, Outlook 98.8%, Apple 99.2%, Yahoo 97.6%. Link "Send report".
- **Last 8 sends, unique open % / click %:** #35 44.1/4.2, #36 45.8/5.1, #37 43.2/3.9, #38 47.5/5.4, #39 46.0/4.4, #40 49.3/5.9, #41 50.1/5.2, #42 48.2/4.7. Charts are hand-made inline SVG with axes labels, a legend or direct labels, and a caption.
- **Subscribers:** 12,731, +2.1% vs 30 days ago (+262). New this month 1,212. Unsubscribed this month 87. Top signup form: "Footer form", 38% of new subscribers. 30-day trend (daily totals) rising from 12,469 to 12,731 with small dips — author 30 plausible points.
- **Automations:** Welcome series — 342 entered, 298 completed. Re-engagement — 156 entered, 89 completed.
- **Referrals:** 64 subscribers referred someone this month; 141 new subscribers came from referrals.
- **Paid subscriptions:** 418 paid subscribers, +12 vs 30 days ago. Monthly revenue $2,508. Paid at Stripe, 0% platform fee.
- **Sending health:** Domain mail.fieldnotes.example verified (DKIM 2048-bit), DMARC p=quarantine, warm-up finished (day 21, daily cap 40,000).

### Setup state content

Lead with the path to the first send: four steps, about ten minutes in total.

1. **Sending domain** — done — "mail.fieldnotes.example verified, DKIM 2048-bit".
2. **DMARC set to quarantine** — current step — "Your record says p=none. Add this TXT record at your DNS host, then check again." Host `_dmarc.fieldnotes.example`, value `v=DMARC1; p=quarantine; rua=mailto:dmarc+fn@reports.swarm.example` with a **Copy** button (JS copies to clipboard and changes label to "Copied" for 2s), and a **Check again** button. Note: "DNS changes can take up to an hour to appear."
3. **First subscribers** — done — "212 imported, 4 already suppressed".
4. **First post** — "Write it now. It sends once the steps above are done." Button "Write your first post" → editor.html.

Other areas show honest empty states that teach (e.g. "Results appear after your first send", "Subscribers: 212 · from your import"), not zeros pretending to be data.

## Post editor — behaviour (identical in all three; layout differs)

Post: **Notes on the popup economy** (draft, #44). Breadcrumb `Field Notes / Posts / Notes on the popup economy`. Save state visible near the title: "Saved 12:04" (after any edit, show "Saving…" then "Saved" + current time via JS).

Fields at the top of the writing area, **with visible labels**:
- **Subject** — value: "Notes on the popup economy" (max 200; show a character count when focused or always, quietly).
- **Preview text** — empty, placeholder "Shown after the subject in most inboxes". Helper text below.
- **Inbox preview** — a small rendering of one inbox row: sender "Field Notes", subject (bold), preview text (grey) — updating live as the user types in Subject/Preview text. When preview text is empty show the post's first line in grey instead, as inboxes do.

Toolbar (sticky): Paragraph/Heading select, Bold, Italic, Link, Bulleted list, Numbered list, Quote, Divider, Undo, Redo — SVG icons with `aria-label` and tooltips (title). Body is a `contenteditable` region that really accepts typing.

**Inserting blocks:** a "+" button beside the current/empty paragraph opens an inline insert menu (not a modal) with: Heading, Image, Button, Quote, Divider, Link card, File, Paywall break. Also typing "/" at the start of an empty line could open it (optional). Selecting an item inserts a simple placeholder block of that type into the body.

Body content (author it; ~350 words visible, realistic writing, a calm essayist voice):
- Opening paragraph about how a reader now meets three popups before reading one sentence on many small sites.
- H2 "What a popup costs".
- Two paragraphs, one with a link.
- A pull quote: "Ask once, at the end, when the reader has had something worth staying for." 
- A **button block**: "Read the full notes on the website".
- A **paywall break** block, clearly drawn: "Paywall break — paid subscribers read on below this line. Free subscribers see a prompt to upgrade."
- One paragraph below the break, and an H2 "A better ask" with a short list (3 bullets).

**Send flow, always in this order: Write → Audience → Check & send.** The send button is last.
- **Audience** (who gets it): radio "Everyone · 12,731 subscribers" / "Only some segments". Segments (checkboxes, with counts): Paid subscribers 418 · Opened in the last 90 days 8,904 · New this month 1,212 · Free subscribers 12,313. "Leave out" (checkboxes): Bounced in the last 30 days 37 · Unsubscribed from weekly 0 (or similar). A live line: "Goes to N subscribers". Initial state: **nothing chosen** (neither radio selected).
- **From:** select "Mara at Field Notes <mara@mail.fieldnotes.example>" (default) / "Field Notes <hello@mail.fieldnotes.example>". Link "Manage senders".
- **When:** radio "Send now" / "Schedule" (datetime-local input appears when Schedule chosen; default Fri 7 Nov, 06:00; show "Your time zone: Europe/Prague").
- **Checks** (computed live by JS):
  - Blocking: "Choose who gets this post" — shown until an audience is chosen (and, if "Only some segments", until at least one segment is ticked).
  - Warning (non-blocking): "Preview text is empty. Inboxes will show the first line instead." with "Add preview text" which focuses the field. Disappears when filled.
  - Passed: "Sender domain verified", "Unsubscribe link included", "Links checked (4 links, all reachable)", "Paywall break placed — paid subscribers get the full post".
- **Send button:** disabled with the reason visible next to it ("Choose who gets this post first") while blocked; when ready reads "Send to 12,731 subscribers" (or the segment count) or "Schedule for Fri 7 Nov, 06:00". Clicking shows an inline confirmation (not a browser alert): "Send now to 12,731 subscribers? This can't be undone." Confirm / Cancel. Confirm shows a success state in place ("Sending… view the send report").
- **Send a test:** a secondary action near the send button: an inline email field prefilled "mara@fieldnotes.example" + "Send test".
- **More options** (collapsed `<details>` or equivalent): Split test (Off; "Test two subject lines on 20% first"), Website ("Who can read it on the website": Everyone / Subscribers only / Paid subscribers only / Hidden; web address `fieldnotes.example/p/notes-on-the-popup-economy`), Revisions (3 saved versions with times; "Compare").
- **Preview:** a single Preview control that switches the writing area (or a pane) between **Edit**, **Email · desktop**, **Email · mobile**, **Web**, plus a "View as" select: "Free subscriber", "Paid subscriber" (paid shows content below the paywall; free shows the upgrade prompt instead). The preview renders the post as an email (sender row, subject, body, footer with unsubscribe link and postal address "Field Notes, Vinohradská 12, Prague").

On narrow screens the send flow moves below the writing area or into a bottom sheet; all steps stay reachable.
