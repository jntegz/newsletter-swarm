# UI and workflow audit: 8 Nov 2026

Goal: take the dashboard from about 8/10 to 10/10. This audit covers the Line dashboard (`apps/dashboard`) as it runs with `?mock=1`, compared with the best newsletter and SaaS dashboards in use today.

## Status, 8 Nov 2026 (later the same day)

Done on `claude/optimistic-heisenberg-hvqwss`:

- **P0, all of it:** #1 the editor no longer saves on open; #2 a page that fails stays in the shell with "Try again" and "Go to Home", and unknown addresses get "Page not found"; #3 no page scrolls sideways at 390px; #4 one `.table-head` class, plus a guard in `check:vocabulary` against uppercase; #5 fields line up at the top; #6 referral errors wait for blur or save; #27 heading order.
- **Editor, #7 to #11 and more:**
  - The subject is the title and the preview text is the line under it. Cover image and inbox preview sit in one quiet row, so the body starts about 300px higher.
  - A new post opens in the title. Enter moves on to the preview text, then the body.
  - The editor bar is sticky, with the save state, a word count and reading time.
  - Selected text gets a formatting bar. The Insert menu and "+" search like "/". Empty lines hint at "/".
  - Focus mode (Ctrl/⌘ \\, Esc to leave). Ctrl/⌘ S saves. Ctrl/⌘ / lists every shortcut.
  - **Create a segment** comes back to the post with the segment chosen.
  - #10 was wrong (see below).
- **Mock data:** the send report and the subscribers list now render under `?mock=1`.

Measured again after the changes, on the same 31 screens at both widths: sideways scrolling went from 3 pages to 0, and axe violations from 5 to 0. Every editor state (inbox preview open, insert menu, selection bar, focus mode, shortcuts) is clean at both widths.

Then #12 to #26, the same day:

- **Lists, #12 to #15:**
  - The Posts list has search, status chips with counts, Opens and Clicks for the latest send, real authors and a Filter menu, and works from the keyboard. The API gained `q`, `status`, `startedBy` and opt-in `stats=latest` (one query), plus `/dispatches/counts`.
  - Subscribers keeps its filters in the address and has saved views shared with the team (migration `0081_member_views.sql`), listed in Ctrl/⌘ K. It also works from the keyboard, and its toolbar controls are all 36px.
- **Settings pages, #16 to #19:**
  - Sending, Referrals, segments and the website's General, Branding, SEO and Domains tabs are bands. Sending went from 2141 to 1328px tall, Referrals from 1911 to 1499.
  - Add forms open on demand. A warm-up under 3 days is a sentence and a meter.
  - One save model: "Saved · Undo" for single controls, a sticky "Unsaved changes" bar for forms.
  - Inactive readers links to the re-engagement recipe.
- **Polish:**
  - #20: Archive and Restore act at once with an Undo toast.
  - #21: loading rows wait 200ms.
  - #22: every tab names its page, and a send in progress shows "Sending 42%" there.
  - #23: Home's send table wraps subjects.
  - #25: radio and checkbox labels are 24px+ targets.
  - #26: a whole row opens its post.
- **#24 is left out on purpose.** Home's setup route and Sending health already flag the shared domain, and a band on every page would nag. Test sends are marked with [Test] in the subject.
- **API tests run offline now.** Turnstile is answered from the moment the setup loads, so suites that sign in from `beforeAll` no longer call Cloudflare. All 3707 pass in the container.

Measured after everything was merged, on the same 31 screens at both widths: 0 axe violations, 0 pages scrolling sideways, 0 page errors.

Open questions for later:
- Letting a first post go out on the shared domain while DMARC is still pending needs a deliverability decision, so it was not changed.
- The unsaved-changes bar guards reload and closing the tab, not in-app navigation (that needs the router's blocker).
- The website's Navigation, Bot Rules and other tabs still use their old save rows.
- Saved views have no feature flag. They are part of the list, like the column picker.

The Playwright suite could not run in the cloud session: local workers verify Turnstile against Cloudflare, and the worker runtime there can't reach the internet. The new specs (`editor-writing`, `posts-list`, `subscriber-views`) and the updated ones are typechecked. Run it with the rest of the suite locally or in CI.

## How it was run

- 31 screens loaded in Chromium at 1440×900 and 390×844 (62 page loads), each with a full-page screenshot.
- axe-core 4.10 (WCAG 2.0/2.1/2.2 A and AA plus best practice) on every desktop screen.
- Each screen measured for sideways scrolling, interactive targets under 24px, console errors and heading structure.
- The main jobs walked through by hand in the browser: first run, write and send, choose an audience, posts list, segments, automations, sending setup.
- Benchmarked against Ghost Admin, beehiiv, Kit, Buttondown, Substack, Loops and Resend Broadcasts (newsletter tools), and Linear, Stripe, Vercel, Notion and Attio (general SaaS). We borrow interaction principles from them, never names, copy or visuals (see `PRODUCT.md`).

## Scorecard

| Area                                         | Score | In one line                                                                                           |
| -------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------- |
| Visual system (Line)                         | 8.5   | Distinctive and calm. Drifts from its own rules in tables, cards and control sizes.                   |
| Home                                         | 9     | Best screen in the product. Answers "what needs me" first, and the setup route is excellent.          |
| Send flow (Write, Who gets it, Check & send) | 9     | Pre-send checks, test send, exact recipient count and a confirm step. On par with the best.           |
| Editor (writing)                             | 7.5   | Settings sit above the text, so the body starts below the fold. It also saves when you only open it.  |
| Posts list                                   | 7     | No search, no status filter, no results per post, and authors show as "Teammate".                     |
| Audience (subscribers, segments)             | 7.5   | Good status chips and a live "who matches" preview. Layout bugs in forms.                             |
| Automations                                  | 7.5   | Clear list with good stats. Empty canvas and recipe entry points could guide more.                    |
| Settings-style pages (Sending, Referrals, …) | 6.5   | Long stacks of boxed cards, add forms always open, red errors before you type.                        |
| Phone (390px)                                | 7.5   | Works overall. 3 pages scroll sideways, and the send panel sits at the bottom of a long page.         |
| Accessibility                                | 8.5   | axe found 0 violations on 29 of 31 pages. Small radios and checkboxes, one heading-order issue.       |
| Resilience                                   | 6     | There is no error boundary, so one bad field blanks the whole page with no message.                   |
| **Overall**                                  | **8** | The core loop is strong. The gap to 10 is consistency, writing focus, list power and polish.          |

## What is already 10/10 (keep it)

- **Home's order:** Needs you, then Up next, then the last send as a route, then trends, then growth and money. The setup route gives the current step the most room and holds the fix itself (the DMARC record with Copy and Check again).
- **Send panel:** three stops in a fixed order. Checks are written in plain words with the fix next to each one ("Preview text is empty … Add preview text"). Test send is in place, the button shows the exact count ("Send to 12,731 subscribers"), and you confirm before it goes. After sending you land on the live send report. This matches the best publish flows in the benchmark and beats Substack and Kit.
- **Preview as each reader:** desktop email, mobile email, dark email and web, plus "View as" a free or paid subscriber. Few tools offer all of these.
- **Ctrl/⌘K command menu** with Jump to, Create and Recent groups.
- **Plain words and honest empty states:** "Nothing waits for review", "Results appear after your first send" and similar.
- **Accessibility baseline:** skip link, `aria-current` on the rail, live save status (`role="status"`), tabular numbers, measured contrast.

## Findings, by priority

### P0: bugs and broken rules

1. **The editor saves on open.** Opening a draft without typing shows "Unsaved changes", then "Saved 21:09". Something dispatches a document-changing transaction on mount, which fires `onUpdate: changed` in `pages/Editor.tsx:274`. Side effects: a write on every view, a "Last edited" time that moves when someone only reads, false "unsaved" anxiety, and noise in history and diff. Fix: ignore transactions until the first user input, or compare against the loaded document before marking it dirty.
2. **No error boundary.** `router.tsx` has no `errorComponent` or `defaultErrorComponent`, and there is no React error boundary. When the send report received a broadcast without `from`, `Broadcast.tsx:71` threw and the whole page went blank: no heading, no navigation inside the page, no way to retry. Add a route-level `defaultErrorComponent` with the page title, a plain message, "Try again" and "Go to Home", and report the error.
3. **Sideways scrolling at 390px** on three pages:
   - Sending & delivery: the Senders card grows to 689px, pushed by the DNS records table and the sender row.
   - Deliverability: the Domain health `<dl>` grows to 596px.
   - Settings tabs (Team and the rest): the tab row runs to 684px. The row should scroll inside its own container, or turn into a select below 640px.
4. **Uppercase micro labels in 58 places,** which `DESIGN.md` forbids ("No uppercase micro labels"). They are the table headers in Posts, Automations, Sending, Revenue, Import, Flow stats, Champions, Journeys, Funnel, Site Studio and the Copilot panel. All of them repeat `text-[10.5px] tracking-[0.12em] uppercase`. Make one `.table-head` class in `theme-line.css` (13px, weight 600, sentence case, `text-sub`), then add the pattern to the design detector and `check:vocabulary` so it can't come back.
5. **Form fields out of line.** In a two- or three-column grid, an input moves down when its neighbour has a hint or error and it doesn't:
   - New segment: Name sits about 40px lower than Description, and its box is about 80px tall.
   - Referrals: "Within (hours)" sits lower than the two fields next to it.
   Fix it once in the shared field component: put labels at the top (`align-items: start`) and reserve hint space, or put hints under the row.
6. **Errors before the user acts.** Referral settings load with three red "Use a whole number" errors. Validate on blur or submit, never on first render.

### P1: writing focus (editor)

7. **The text starts below the fold.** At 1440×900 the first paragraph is at y=720. Above it come a duplicate title (the h1 repeats the subject), Subject, Preview text, Inbox preview and Cover image. The best editors start with the title and the text, and put email details in a side panel or a collapsible header.
   Proposal: keep Subject as the large title line. Fold Preview text, Inbox preview and Cover image into one "Email details" row under it, which shows a summary ("Preview text: empty · Cover: none") and opens on click. The send panel's checks already catch an empty preview text.
8. **Three ways to insert:** the gutter "+", the toolbar "Insert" button and the "/" menu. Keep "/" and the gutter "+", which both open the same menu, and make the toolbar button open that menu too, so there is one list with the same order and names everywhere.
9. **Focus mode:** let the writer hide the rail and the send panel (for example with a shortcut and a button), and bring the panel back when they press "Send…".
10. ~~**Who gets it does not move you on.**~~ Wrong in the first version of this audit: choosing "Everyone" already opens Check & send. The test script had clicked the stop closed again.
11. **Making a segment while sending leaves the editor.** "Create a segment" in the send panel (`circles/AudiencePicker.tsx:117`) goes to `/circles/new` with no way back. It is also a primary (night) button inside the send flow, competing with Send. Open the segment builder in a dialog or drawer, or pass a `returnTo` that comes back to the post with the new segment selected. Make the button secondary.

### P1: lists that work like tools (Posts, Subscribers, Automations)

12. **Posts list:**
    - Add search.
    - Add status chips (All, Drafts, Scheduled, Sent) like the ones on Subscribers.
    - Add Opens and Clicks columns for sent posts, so writers compare issues without opening each report.
    - Show the real author (name and avatar) instead of "Teammate".
    - Move "Started by" into a filter menu. It currently takes a whole row above the table.
13. **Keyboard on lists:** arrow keys move between rows, Enter opens, `x` selects, and selected rows get bulk actions. Shortcuts: `c` for a new post, `/` for search. Show the shortcuts in the command menu.
14. **Saved views:** save a filtered Subscribers view (status, tag, segment) and reopen it from the rail or the command menu.
15. **One control height:** the subscriber search box is 42px, buttons are 32px and selects are 40px. Use 36px for every control in a toolbar row.

### P1: settings-style pages

16. **Bands, not boxes.** `DESIGN.md` says "single column of bands separated by hairline rules … not a grid of cards", but Sending, Referrals, New segment and Site Studio stack boxed cards. Turn each card into a band: heading and description on the left (about 280px), controls on the right, a hairline between bands. Pages get shorter and match Home.
17. **Forms open only when needed:** "Add sender", "Add domain", "Block an address" and "Add Milestone" should be buttons that open a short inline form. They should not be empty forms that are always showing.
18. **Warm-up chart:** with one day of data it is a single 200px grey bar. Below 3 days, show a sentence and a small progress meter instead ("Day 1 of warm-up · today's cap 40,000").
19. **One save model:** some pages save each field as you change it, and others have a "Save settings" button that stays greyed out. Pick one per page type. Toggles and selects save on change and show "Saved" with Undo. Multi-field forms show a sticky "Unsaved changes · Save · Discard" bar.

### P2: delight and speed

20. **Undo instead of confirm for things you can reverse:** archive, remove a tag, delete a draft. Act at once and show "Archived · Undo" for 6 seconds. Keep confirmations for sending, deleting for good and money.
21. **Loading without flicker:** wait about 200ms before showing loading rows, then keep them up for at least 400ms. Do the same in `LoadingRows`.
22. **Status in the tab:** while a send runs, show progress in the document title ("Sending 42% · Field Notes").
23. **Home:** in Last 8 sends, subjects are cut off at about 18 characters. Give the table more width, or let it wrap to two lines. "edited 2 hours ago" wraps into three lines in Up next. Use "2h ago" or a wider date column.
24. **A test mode you can't miss:** when a test send goes out, or a publication uses the shared domain, show a thin band in the top bar.

### P2: accessibility polish

25. **Radios and checkboxes are 16×16** (`size-4`). WCAG 2.2 AA (2.5.8) passes because the labels are clickable, but make the whole row the target, with at least 24px of height and a hover background.
26. **Inline text links are 17 to 20px tall** in tables. Make the whole row clickable as the main target, and keep the link for keyboard and screen readers.
27. **Deliverability:** heading order skips from h2 to h4.

## Workflows

| Job                         | Steps today                                                                                    | Best in class                         | Gap                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| First send (new account)    | 4 stations on Home (domain, DMARC, subscribers, post). About 10 min                            | 3 guided steps                        | Small. Consider letting the first post go out on the shared domain while DMARC is pending      |
| Write and send a post       | New post, Start from, write, Who gets it, open Check & send, Send, Confirm (7)                 | About 5 interactions                  | Auto-open the next stop (#10), and put the text first (#7)                                     |
| Send to a new segment       | Leaves the editor with no way back                                                             | Builder in a dialog, then back        | #11                                                                                            |
| Check how a send did        | Home's last-send route, or Send report                                                         | Report with link table and click map  | Add opens and clicks to the posts list (#12). Check the report with live data (not mocked)     |
| Find an old post            | Scroll the list, or Ctrl/⌘K Recent (latest only)                                               | Search in the list and in Ctrl/⌘K     | Search posts by subject and text (#12)                                                         |
| Clean up inactive readers   | Sending & delivery, Inactive readers (radio)                                                   | Segment, re-engage, then sunset       | Link it to a "re-engagement automation" recipe from the same band                              |

## The path to 10

1. **Week 1 (P0, small):** #1 save on open, #2 error boundary, #3 three overflows, #4 one table-head class and a lint rule, #5 field alignment, #6 validate on blur.
2. **Week 2 (editor):** #7 to #11. This is the biggest felt change, because writers live in the editor.
3. **Week 3 (lists):** #12 to #15, then mock data for the subscribers list and the send report so both can be reviewed with `?mock=1`.
4. **Week 4 (settings pages and polish):** #16 to #27, then run this audit again and aim for no sideways scrolling, no uppercase labels, no axe violations and no blank pages.

## Mock gaps found while testing

With `?mock=1`, the send report crashes (the mock broadcast has no `from`) and the subscribers table is empty while the chips show 13,220. Neither is a product bug. Both stop these screens from being reviewed and tested with Playwright. Add both to `dev/mockApi.ts`.

## Tools

These plugins are in the Anthropic plugin directory. Install them in Claude Code to repeat this audit:

- **Design** (Anthropic): design critique, accessibility review, UX copy and design-system skills.
- **frontend-design** (Anthropic): guidance for building UI.
- **Axe Accessibility** (Deque): scan, fix and check accessibility, including guided keyboard tests.
- **ux-ui-audit** (community): browser checks for contrast, target sizes and design-system conformance.
