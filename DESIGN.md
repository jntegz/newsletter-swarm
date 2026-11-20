# DESIGN.md: Swarm · "Line"

Status: the dashboard's design system, chosen in the Nov 2026 redesign round (Direction A) and built in `apps/dashboard`. Canonical mockups: `design/2026-11/a-line/home.html` and `design/2026-11/a-line/editor.html`. The brief all three directions answered is `design/2026-11/BRIEF.md`; the comparison is `design/2026-11/index.html`.

This file documents what is built. The source of truth for values is `apps/dashboard/src/theme-line.css`; when this file and that one disagree, the CSS wins and this file gets fixed.

**Scope.** Line is the dashboard. Publication websites use each publication's own brand; see [Publication websites](#publication-websites).

## The idea

The navigation is drawn as a transit line, and you are the yellow stop. Everything else is quiet: a white page, one dark "night" colour for structure and actions, a green route for things that are done, and a single yellow signal for where you are and what comes next. Fewer boxes: alignment, rules and whitespace before cards.

The people using it are writers and small editorial teams, on a laptop in daylight, a few times a week. The dashboard answers, in this order: what needs me, what's next, how did the last send do, then growth and money.

## How the theme is wired

`apps/dashboard/src/index.css` imports `@swarm/ui/theme.css` (Indigo) and then `theme-line.css`, which **redefines the existing variable values** for the dashboard. Class names stay as they are, so the existing utilities (`bg-lavender`, `text-purple-deep`, `border-line-app`, …) pick up the new palette without a rename. The names stay; the meaning shifts:

| Variable        | Means in Line                                            |
| --------------- | -------------------------------------------------------- |
| `--purple`      | night `#14203A`: the primary action and structure colour |
| `--purple-deep` | night hover `#22325A`                                    |
| `--lavender`    | the soft tint for active and selected states, `#EEF1F6`  |

New code may use the Line names directly: `bg-rail`, `text-rail-text`, `bg-signal`, `text-route`, `text-warn`, `bg-warn-soft`, `text-danger-ink` are mapped in `@theme inline`.

## Tokens

```css
:root {
  /* Surfaces */
  --surface: #ffffff;
  --surface-alt: #f4f6f9;
  --page: #ffffff;

  /* Text (all at least 4.5:1 on white) */
  --ink: #111827;
  --text-sub: #4b5568;
  --text-muted: #687082;

  /* Night replaces purple */
  --purple: #14203a;
  --purple-deep: #22325a;
  --lavender: #eef1f6;
  --lavender-line: #d9dfea;

  /* Lines */
  --line: #e2e6ec;
  --line-soft: #eef1f5;
  --line-app: #e2e6ec;
  --line-control: #8a94a6; /* 3.1:1 on white */
  --line-control-hover: #6b7486;

  /* Status */
  --success: #12724b;
  --success-soft: #e7f3ec;
  --danger: #b42318;
  --danger-soft: #fef0ee;
  --danger-ink: #7a1a11;
  --warn: #8a5300;
  --warn-soft: #fff5db;
  --rose: #b4235f;
  --scheduled: #2f4a7a;
  --scheduled-soft: #eef2f8;

  /* Charts */
  --chart-1: #14203a;
  --chart-2: #aeb8cb;
  --chart-3: #c9772b;
  --chart-grid: #e2e6ec;
  --chart-marker: #cbd2dc;
  --chart-track: #eef1f5;
  --meter-track: #e2e6ec;

  /* Elevation: soft and close */
  --shadow-card: 0 1px 2px rgba(17, 24, 39, 0.06), 0 8px 24px -12px rgba(17, 24, 39, 0.18);
  --shadow-soft: 0 1px 2px rgba(17, 24, 39, 0.05);
  --shadow-purple: none;

  /* Radii: controls 8, cards 10, pills stay round */
  --r-pill: 999px;
  --r-card: 10px;
  --r-card-app: 10px;
  --r-shell: 10px;
  --r-control: 8px;

  /* The line */
  --rail: #14203a;
  --rail-2: #1d2b4b; /* hover and the current item on the rail */
  --rail-3: #2c3c63;
  --rail-text: #d5dcea;
  --rail-muted: #9aa6bf; /* station labels */
  --rail-line: #33446a; /* the track */
  --signal: #ffc83d; /* you are here / next step, nothing else */
  --signal-soft: #ffe7a3; /* text selection */
  --route: #12724b; /* done, on white */
  --route-rail: #1c8c5e; /* the line in the logo mark */

  --duration-hover: 150ms;
}
```

Measured contrast:

| Pair                                      | Ratio       | Use                                        |
| ----------------------------------------- | ----------- | ------------------------------------------ |
| `--ink` on white                          | 17.7:1      | body text                                  |
| `--text-sub` on white                     | 7.5:1       | secondary text                             |
| `--text-muted` on white / `--surface-alt` | 5.0 / 4.6:1 | hints, placeholders                        |
| `--route` on white                        | 5.9:1       | done states, success text                  |
| `--danger` on white                       | 6.6:1       | errors                                     |
| `--warn` on `--warn-soft`                 | 5.8:1       | warnings                                   |
| `--rail-text` on `--rail`                 | 11.8:1      | rail items                                 |
| `--rail-muted` on `--rail`                | 6.6:1       | station labels                             |
| `--signal` on `--rail`                    | 10.5:1      | the current stop, focus ring on the rail   |
| `--signal` on white                       | 1.55:1      | never alone on white (see the signal rule) |

## Type

- **Atkinson Hyperlegible Next** (variable, with its italic) for everything, and **Atkinson Hyperlegible Mono** (variable) for code. Both are self-hosted through `@fontsource-variable/*`, imported in `apps/dashboard/src/main.tsx`. Never load a hosted font stylesheet.
- The faces were drawn for legibility: letters that are easy to confuse (I, l, 1; O, 0) are made distinct. The **slashed zero is the face's legibility glyph**, not a mono costume and not a bug. Keep it; don't switch it off with font features.
- Mono is for things people copy or compare character by character: DNS records, email addresses, API keys, paths. Not for decoration, not for headings.
- `font-variant-numeric: tabular-nums` is set on `body`, so every number aligns.

Scale as built:

| Role                       | Size                   | Weight                | Tracking | Line-height |
| -------------------------- | ---------------------- | --------------------- | -------- | ----------- |
| Page title (`h1`)          | 26px (24px on a phone) | 600                   | −0.01em  | 1.2         |
| Section heading (`h2`)     | 17px                   | 650                   | −0.005em | 1.3         |
| Body                       | 15px                   | 400                   | 0        | 1.55        |
| Small, helper text         | 13px                   | 400                   | 0        | 1.55        |
| Button                     | 14px                   | 600                   | 0        | 1           |
| Small button               | 13px                   | 600                   | 0        | 1           |
| Rail item                  | 15px                   | 400; 600 when current | 0        | –           |
| Rail station label         | 13px                   | 650                   | 0        | –           |
| Route figure (Home)        | 28px                   | 600                   | −0.01em  | 1.1         |
| Editor body                | 17px                   | 400                   | 0        | 1.65        |
| Editor headings (h1/h2/h3) | 28 / 22 / 18px         | 650                   | −0.005em | 1.3         |

Sentence case everywhere. No uppercase micro labels and no eyebrow labels above headings. Table column headings and small labels over a group use `.table-head` (13px, 600, `--text-sub`, no letter-spacing). `pnpm check:vocabulary` fails on the `uppercase` class in dashboard components; a typed code shown in capitals, such as a currency code in its field, carries an `uppercase-allow` comment with the reason.

## Layout

- **Shell:** a 240px rail and the content column (`AppShell.tsx`). Below 1020px the rail folds into a 56px top bar; its menu button opens the rail as a full-height drawer, and Esc or navigating closes it.
- **Top bar:** sticky, with the breadcrumb (publication, then section, then page; a page can name its last crumb, such as a post's subject) and the search field that opens the command menu.
- **Page header** (`PageHeader`, `.page-head`): the title (`.page-title`, the one `h1` style), one line under it (`.page-sub`) and the page's actions on the right, every one a 36px button. They wrap under the title on a phone.
- **Content:** 16px side padding, 32px from 640px up. Pages are a single column of bands separated by hairline rules (`border-line`), not a grid of cards (see [Settings pages](#settings-pages-bands-add-forms-and-one-save-model-pagescommontsx-shellinlineaddtsx-shellsavednotetsx-shellunsavedbartsx)).
- **Radii:** 8px controls, 10px cards, menus, notices and empty states, round pills for status and tags. Nothing in between: no 12px or 14px corners (`rounded-card-app` is the 10px one).
- **Phone width:** nothing scrolls the page sideways at 390px. Wide tables and tab rows (Settings) scroll inside their own box; sections and cards in a grid carry `min-w-0` so their content can't widen the page.
- **Elevation:** cards have a hairline and no shadow (`.card-app`). Only floating things (menus, the command menu, dialogs) get `--shadow-card`.

## The rail: a transit line

The navigation (`.line-nav` in `theme-line.css`, the map in `shell/nav.ts`) is drawn in CSS:

- **The track** is a 2px vertical line in `--rail-line`.
- **Stations** are the groups: Home, Write, Audience, Grow, Earn, Publish. A station is an open ring (14px, 2px `--rail-text` border, night centre) with its label in `--rail-muted`. Home is a station you can open.
- **Stops** are the pages in a group (Posts, Templates, Subscribers, …), each joined to the track by a short 9px spur.
- **You are here:** the current page gets a yellow stop with a night centre on the track and a `--rail-2` background. It is driven by `aria-current="page"`, which `NavItem.matches()` sets for the page and the pages under it, so screen readers hear the same thing the eye sees.
- **Top of the rail:** the logo mark (a night dot on a green line) and the **publication switcher**, a button that opens a menu of publications, "New publication" and "Manage publications". The current publication comes from `?channel=`, then the last one used, then the first.
- **Bottom of the rail:** Settings, then the signed-in person with a menu (workspaces, Security, sign out).
- Focus rings on the rail are yellow (`.on-rail :focus-visible`), so they stay visible on night.

## The signal rule

Signal yellow means **"you are here" or "this is the next step"**, and nothing else. It appears in exactly these places:

- the current page's stop on the rail;
- the current stop of a route (`.is-now`): the first unfinished step of the setup route, the editor's send route;
- the marker beside **Needs you** on Home;
- the focus ring on the rail.

The pale `--signal-soft` is used for text selection only.

Yellow is 1.55:1 on white, so it is never text, never a lone shape on white, and always carries a night centre or sits on night. It is never used for warnings (`--warn`), buttons, chart series, badges or decoration. If two things on one screen are yellow, one of them is wrong.

## The route

Green `--route` means done. Routes (`.line-route`, `.line-steps`) show progress through a fixed sequence:

- A marker per stop (`.line-mk`, 19px; `.line-smk`, 21px in the editor). Done stops are filled green; the current stop is yellow with a night centre; future stops are an outlined grey ring.
- A 3px line joins the stops: green behind done stops, `--line` ahead of the current one.
- Routes run horizontally and turn vertical in narrow containers (container queries: the setup route below 760px, the last-send route below 560px), so they never overflow at 390px.
- Every stop has a text label and, where it applies, a figure. Colour is never the only signal.

## Components as built

### Home (`Overview.tsx`, `home/`)

In the order the page answers:

1. **Needs you** (setup steps, warnings on the next scheduled post, failed pre-send checks) and **Up next** (scheduled posts and drafts).
2. **Last send as a route:** Queued → Delivered → Opened → Clicked, each with its figure, then "Lost from this send" (bounced, unsubscribed, spam complaints) and inbox placement by provider. Links to the send report.
3. **Last 8 sends:** opens and clicks over the last 4 sends with their change against the sends before, then two small line charts sharing the x axis (unique opens, clicks), drawn by `home/LineChart.tsx`: a night line, white dots, the last value labelled directly, and a table.
4. **Growth and money** as one ruled row, not a card grid: subscribers with their 30-day change, automations (`FlowsMeter`), referrals (only with real figures; they have no summary API yet, so only the sample states show numbers), paid subscriptions.
5. **Sending health:** one line of checks (sending domain, DMARC, warm-up), each marked ok, needs attention or not yet, in words as well as icons.

On first run the top of the page is the **setup route**: four stations to the first send, where the current station gets the room (columns `1fr 2.6fr 1fr 1fr`) and holds the action, such as the DMARC record with Copy and Check again. Anything shown without live data carries a visible "Sample data" tag.

In development (and with `?mock=1`), the header also has **Development preview**, a small dashed select of Your data, First run, Ready to send and Established. It is drawn as a tool, dashed, so it can't be read as part of the page, and real users never see it.

**New post** opens a "Start from" menu (`home/NewPostMenu.tsx`): Blank post, a template, or a duplicate of the last post. The posts list uses the same menu.

### Posts list and calendar (`pages/Dispatches.tsx`, `pages/PostsCalendar.tsx`)

The posts page has two views, **List** and **Calendar**, chosen with a segmented control and remembered in the browser. Each view has its own flag (`post_archive`, `content_calendar`).

**The list as a tool.**

- **Above the table:** a search field ("Search by subject", 36px) and a **Filter** menu holding Started by (Anyone, A teammate, An agent or the API). The button names the choice when one is set.
- **Status chips** with counts: All, Drafts, Scheduled, Sent, and Archived while the archive is on. A past issue counts as sent.
- **In the address:** the search, chip and filter, so they survive a reload and coming Back from a post.
- **Columns:** Subject, Status, Author (the person's name with initials; agent, API and Feed Sync posts keep their pill), Sent or scheduled, Opens and Clicks, and Last edited from 1280px. Opens and Clicks are the latest send's unique rates, counting people and never privacy proxies or link scanners, as on Home and the send report.
- **Dates:** the day ("21 Sept"; the year only when it isn't this one), with the full date and time on hover. A scheduled post keeps its time ("12 Nov, 14:23").
- **Archive** in a row shows on hover or focus where there is a pointer (`.row-reveal`), so the list doesn't read as a column of buttons; touch screens always show it.
- **The row opens the post.** The subject stays a real link for the keyboard and screen readers. Checkboxes, buttons, links and selecting text keep their own click.
- **Keyboard:** the arrow keys, Home and End move between rows. Enter opens, x selects, / goes to the search and c opens New post. Single keys are ignored while typing, and a quiet line under the table says so on devices with a pointer.

**Archive.** A sent or canceled post, or a past issue, has **Archive** in its row, plus checkboxes for several at once. Archive and Restore act at once, with no confirmation, and say what happened in a toast with Undo.

- What archiving doesn't do is said next to the selection and on the Archived chip: the post keeps its stats and stays on the website. Taking a post off the website is separate, in its Website settings.
- A draft has no Archive (it can be deleted), and a post scheduled or being sent says it can't be archived yet. Deleting for good still asks first.

**Calendar.** A month of ruled days with no cards. Scheduled and sent posts sit on the day they send, in the person's time zone; drafts on their planned date; past issues on their website date. Each entry has a small marker and always a word: "Draft, planned", "Scheduled, 06:00", "Sending", "Sent, 09:15", "Past issue". Today is a night circle with the word Today, because yellow already marks the current page on the rail. Drafts drag between days, and **Move** does the same from the keyboard. Dragging only ever changes a planned date, which has no effect on sending. A scheduled send can't be dragged: **Change time** opens a dialog that uses the same scheduling route and pre-send checks as the editor. An empty day from today on offers **New post** with that planned date, on hover or focus. Below 768px the grid becomes a list of the month's days with posts, with a date field and **New post** above it.

**Past issues.** An issue from **Import past issues** is stored as a draft and never shown as one: the pill says Past issue, Home leaves it out of Up next, and the editor has a note in place of the send route. The server refuses to send or schedule it.

### The editor's send route (`send/SendRoute.tsx`)

The right-hand panel of the post editor is a route with three stops, always in this order: **Write → Who gets it → Check & send**. The send button comes last.

- It is an exclusive accordion: one stop open at a time. Until you open one yourself, the open stop follows the yellow marker, which sits on the first stop that isn't finished.
- **Write** summarises the post: word count and whether there is a paywall break.
- **Who gets it** holds the audience picker and the From field, with the sending address as helper text. Sending to everyone is never a silent default: the stop is done only after a deliberate choice. Choosing Everyone moves on by itself; with segments, a "Continue to Check & send" button does. With no segments yet, **Create a segment** opens the segment builder for this post: creating it adds the segment to the post's audience and comes back to the post, and **Back to the post** leaves without one.
- **Check & send** has When (send now or schedule), the live pre-send checks, Send a test, and the send button. Checks come from the preflight API and are sorted into stops by key: subject and content belong to Write, audience and sender to Who gets it, the rest to Check & send. A disabled send button says why next to it. Sending asks for confirmation inline, never in a browser alert.
- **More options**, collapsed below: split test or cohort sampling, website visibility, Smart Blocks (when on), revisions, and Delete draft.

### The writing area (`editor/PostHeader.tsx`, `pages/Editor.tsx`)

The post is drawn as the post, not as a form, so the text starts high on the page (at 1440×900 the first paragraph is about 410px from the top).

- **Cover image** first: with none, a quiet **Add cover image** button; with one, the image, its **Alt text**, **Change image** and **Remove image** (`editor/CoverImageField.tsx`). People who can't edit see the image read-only, and nothing when there is none. A deleted media item leaves a warning in its place.
- **Subject as the title:** a borderless 34px (28px on phones) field, labelled Subject for assistive technology, that grows with what's typed and has no line breaks. **Preview text** is the 19px line under it, in `--text-sub`. A short night rule in the gutter marks the field being written in. A new, empty post opens with the cursor in the title. Enter moves from the subject to the preview text, then into the body; Arrow up and down move between them.
- **One quiet row under them:** "Post · Publication" on the left. While the subject or preview text has focus, the same place shows both lengths and advice on the preview text ("Short: 40 to 90 reads well on a phone"). On the right, **Inbox preview** opens one inbox row as mail apps draw it (`editor/InboxPreview.tsx`): sender, subject in bold, the preview text or, without one, the post's first line. Whether it is open is remembered in this browser.
- **The body's hints:** an empty post says "Write your post, or type / to insert a block…", and any later empty line "Type / to insert a block".
- **Selection bar** (`editor/SelectionBar.tsx`): selecting text shows a small night bar over it with Bold, Italic, Link, Heading and Quote. It acts on mouse down, so the selection and focus stay; it is hidden below 640px, where phones have their own selection menu.

### The editor bar

Sticky under the top bar from 1020px. On a phone it is two rows: the state and **Save as template**, then the preview modes across the full width; **Focus** steps away there, unless focus mode is on. On the left: the status pill, the save state (with a green tick once saved) and "37 words · 1 min read". On the right: the preview control, **View as** (only while previewing), **Save as template**, **Keyboard shortcuts** and **Focus**. The formatting toolbar sticks under the editor bar, and the send panel fits under both; their offsets come from `--editor-bar`, which follows the bar's height as it wraps.

**Focus mode** (Ctrl/⌘ \\, or **Focus**): the rail, the top bar and the send panel step away and the post is centred. **Leave focus**, the same shortcut or Esc brings them back, and leaving the editor always does (`shell/focusMode.ts`).

**Keyboard** (`editor/shortcuts.tsx`): Ctrl/⌘ S saves now; Ctrl/⌘ / lists every shortcut, including the formatting keys and the Markdown-style ones typed at the start of a line (`## `, `- `, `1. `, `> `, `---`).

### Insert menu (`pages/Editor.tsx`)

Blocks are added from the labelled **Insert** button in the toolbar, the round **+** in the left gutter (level with the block holding the cursor), or by typing **/** on an empty line. All three offer the same blocks in the same order. Insert and **+** open the same inline menu (`.line-menu`), not a modal, with a **Find a block** field first: typing narrows the list as the "/" menu does, Enter takes the first match, and a line at the bottom points to "/". The blocks: Heading, Image, Button, Quote, Divider, Link card, Callout, Two columns, Embed, Snippet, Footnote, File, Product and Sponsor when on, Paywall break (once per post; it then reads "Paywall break added" and is disabled), Raw HTML where allowed, and Smart Block and poll when those are on. Image, File, Button and Link card then ask for their details in a dialog. Toolbar buttons are SVG icons with an `aria-label` and a tooltip.

### Block handle (`editor/BlockControls.tsx`)

A grip in the left gutter, beside the **+**, for the top-level block under the mouse or else the one holding the cursor. Drag it to move the block between top-level blocks, with a night line showing where it lands. Click it for a `.line-menu` with **Move up**, **Move down** and, with the `block_visibility` flag, **Show this block in**: Email and website, Email only, Website only. Alt with an arrow key moves the block holding the cursor. A block kept to one place has a small outlined label above it, in words; a click on the label opens the same menu.

### Snippet block (`editor/snippetNode.tsx`)

Insert → **Snippet** links the post to a saved snippet by default; **Insert a copy** keeps the old way. A linked snippet sits between top-level blocks as a labelled box: the **Snippet** tag, the snippet's name, **Edit snippet** and **Detach**, then its content read-only. Detach swaps the block for an editable copy. **Edit snippet** is a dialog with the name, the content, how many posts use it, and what saving changes: the website copy of every post, past ones included, and emails that start sending after it, but never an email already sent. A snippet that has been deleted shows a warning in `--warn` and **Remove block**; the post still works and renders nothing there, and the pre-send checks warn.

### Preview

One segmented control in the editor bar: **Edit | Email · desktop | Email · mobile | Email · dark | Web** (icons only below 1536px, named for assistive technology and in tooltips). While previewing, **View as** Free subscriber or Paid subscriber appears next to it.

**Email · dark** (`darkEmail` in `@swarm/mail/dark-preview`) recolours the rendered email from its inline styles and says on the page that it is an approximation. Dark text with no background of its own stays dark, as it does in some mail apps, and is listed under the preview.

### When a page fails (`shell/RouteError.tsx`)

A page that throws while loading or rendering is replaced, inside the shell, by **This page didn’t load**: a plain sentence, **Try again** (drops the page's loaded data and renders it again) and **Go to Home**. The rail and the top bar stay, and the error goes to the console. An address that matches no page shows **Page not found** in the shell the same way.

### Send report (`pages/Broadcast.tsx`)

Bands, like Sending: **Delivery** (the progress bar), **Results** and **Links**, then the click map. Results is a ruled row of figures, not tiles: Delivered, Opened by people, Clicked and Unsubscribed at 28px, then a hairline and Bounce rate, Complaint rate, Failed and Sending cost at 20px, each with what it is made of under it. The Links table scrolls in a region the keyboard can reach on a phone.

### Toasts (`shell/toast.tsx`)

Short notes after an action, with at most one action, usually Undo. A toast is a white card with a hairline and `--shadow-card`, at the bottom left of the content (full width along the bottom on a phone).

- It is announced through a polite `role="status"` region and never takes focus.
- It stays about 6 seconds, and waits while the pointer or focus is on it or the tab is hidden.
- Ctrl or ⌘ Z, outside a text field, runs the newest toast's action.
- Toasts confirm; they never carry the only copy of something a person must act on.

### Saved subscriber views (`pages/MemberViews.tsx`, `pages/member-views.ts`)

On Subscribers the filters live in the address (`?status=&tag=&circle=&q=&cols=`), so a filtered list survives a reload and can be bookmarked.

- **Views**, next to the status chips, lists the publication's saved views. A view is a name plus the status, tag, segment, search and columns, shared with everyone on the publication's team.
- Choosing a view shows its filters. While the list matches a view, the button names it ("View: Paid readers") and the menu marks it with a night tick.
- Editors and up can **Save view**, **Rename view** and **Delete view**; deleting leaves the list as it is and doesn't touch any subscriber. Viewers can use views and are told who can save them.
- Saved views also appear in the command menu under **Subscriber views**.
- **Keyboard:** the arrow keys move between rows, Home and End jump to the first and last, Enter opens the subscriber, x selects them for bulk actions, and / goes to the search. A line under the table says so.
- **One toolbar row:** search (with its icon), Tag and Segment on the left, **Views** and **Columns** on the right, all 36px (`size="sm"` and `hideLabel` on `TextField` and `SelectField`: the label stays for assistive technology, the placeholder and the "Any tag" choice say it on screen). The status chips sit in their own row under it. On a phone, Tag and Segment share a row.
- Rows are about 44px, dates show the day, and a selected row is `--lavender`.

### Settings pages: bands, add forms and one save model (`pages/common.tsx`, `shell/InlineAdd.tsx`, `shell/SavedNote.tsx`, `shell/UnsavedBar.tsx`)

**Bands.** Settings-style pages (Sending, Referrals, segments, the website's tabs) are a single column of bands, built with `Bands` and `Section` (or `Band`). A band has its heading and a one-line description on the left (280px wide from 1020px up) and its controls on the right, with a hairline (`border-line`) under it and no card border or background. Below 1020px the two parts stack. Lists inside a band are ruled rows, not boxes.

**Add forms open only when asked for.** "Add sender", "Add domain", "Block an address", "Add Milestone" and "Add reward" are buttons that open a short form in their place. Focus moves into the form, Cancel or Esc closes it and puts focus back on the button, and a successful add closes it and says what was added in a status line.

**Warm-up.** A warm-up with fewer than 3 days of data is one sentence and a small meter ("Day 1 of warm-up · today's cap 40,000 · 0 sent so far"), not a chart. A finished warm-up is one sentence with its final cap.

**One save model per kind of control.**

- A toggle, radio group or select saves as it changes, and shows "Saved" with Undo beside it when the change can be taken back (`role="status"`).
- A form of several fields shows nothing to press until something changes. Then a bar sticks to the bottom of the window with "Unsaved changes · Discard · Save", and the browser asks before the page is closed or reloaded.
- There are no greyed-out Save buttons.
- **Workspace and Team settings** are bands too: Team lists each teammate by name and address with their role, then Invite a teammate, then Pending invites.
- **Inactive readers** also offers "Start a re-engagement automation", which opens New automation with that recipe chosen, or the existing one.

### Browser tab (`shell/tabStatus.ts`)

The tab names the page, then the publication, then Swarm ("Subscribers · Field Notes · Swarm"), focus mode included. A send in progress puts "Sending 42%" in front, and a post that didn't save puts "Not saved".

### Design studio (`design/DesignStudio.tsx`)

Website → Design is a workspace, not a page of bands.

The website's pages are a row of links in three groups, with a hairline between them: what readers see (Design, Branding, Navigation, Pages, Authors, and Link Hub and Import past issues when on), how the site is set up (General, Domains, SEO, Redirects, Bot Rules, Cookies and code), and how it is doing (Analytics). The row scrolls inside itself on a phone.

- **The bar:** sticky under the top bar. It holds the draft state ("Published", or an "Unpublished changes" pill with "Draft saved 21:10", "Saving…" or "Not saved. Trying again…"), Preview as, the Desktop/Phone segmented control, Versions, a problems menu when there are any, and Publish, which is disabled with its reason beside it. Publish is a split button: the main part publishes now, and the chevron beside it opens a menu with Schedule…, an inline form under the bar (date and time with the time zone named, quick picks, and the line "The draft as it is now: Launch theme, 7 sections"). A waiting schedule is a line of its own under the bar, "Scheduled for Mon 10 Nov, around 09:00" with Change and Cancel; a failed one names its first problem with See problems and Dismiss.
- **Template** is a grid of compact cards, two to a row: the template's picture, its name with "In use" in green on the chosen one, and two lines of description. The chosen card has a night ring.
- **The development preview** (`?mock=1`) draws the design inside the site's shell, the essentials of its base stylesheet and layout (page width, 22px gutters, header and footer), as the theme gallery does, so it looks as the site does.
- **The panel and the preview:** a 380px panel with Template, Style, Sections and Code tabs (Code widens to about half for admins), and the live preview filling the rest on `--surface-alt`, sticky under the bar. Below 1020px the preview opens full screen from a Preview button.
- **Saving:** the draft saves itself (800ms after a change, 250ms for style), retries until stored and is kept in memory until it is, so there is no Save button. Ctrl/⌘ S saves at once, and the browser asks before closing with unsaved work.
- **Undo instead of asking:** every change that can surprise (switching template, deleting a section, Reset to a theme, restoring a version, importing) happens at once and is offered back in a toast with Undo.
- **Controls come from the theme's declarations:** colours as a picker plus a hex field with contrast warnings under them, fonts as a menu showing each name in its own face, 2 to 4 choices as segmented buttons, checkboxes as switches.
- **Fonts:** the menu lists the built-in fonts, then "Your fonts" (the publication's uploaded fonts, each name in its own face, loaded from the media library), then "Upload a font…", which opens the upload form under the control: the file, its name and a required "Its licence allows use on a website" checkbox. Once uploaded it is chosen. A chosen font that was deleted keeps the control calm: the default's name in the field and a quiet `--surface-alt` note under it saying the site uses the theme's own font. The media library shows a font as "Aa Bb Cc" and a sample line in its face, never a broken image.
- **Sections** are ruled rows. Drag them, or use Alt with ↑/↓ on a row (Move up/Move down in its menu). An eye hides a section, and a menu holds Duplicate, Delete, Who sees it and Where, which the row also states in words ("Visitors only · Phones only").
- **Section numbers:** each row says what the section reached and signed up over the period chosen at the top of the panel (7, 30 or 90 days, segmented): "1,204 reached · 38 signups · 3.2%", or only what it reached when it has no form.
- **A/B tests:** "Test a variant" in a row's menu copies the section's settings into B and opens them on B; the row then says "A/B test running". In the section's settings an A | B segmented switch picks which variant the controls edit (the preview follows B), and a results card gives the result in words ("B is ahead: 4.1% against 3.2%, 96% sure"), the two signup rates as night bars on one scale with their figures beside them, a note that it counts views, not people, and Use B and Keep A, which end the test into the draft with Undo. Preview as gains Variant B while a test runs.
- **The code editor** is CodeMirror 6, loaded on demand. Tab indents, and Esc then Tab moves on.

### Command menu (`shell/CommandMenu.tsx`)

Ctrl K or ⌘K, or a click on the search field, opens a native `<dialog>` with a filter field and four groups. While the field has focus, the first result is shaded and labelled Enter, because Enter opens it. The groups are **Jump to** (every page on the rail), **Create** (New post, Import subscribers, New segment), **Recent** (the publication's latest posts) and **Subscriber views** (the publication's saved views). Esc closes it.

### Controls

- **Buttons** (`.btn-primary`, `.btn-ghost`, `.btn-quiet`, `.btn-danger`): 36px high (32px with `.btn-sm`), 8px radius, 14px semibold, no shadow and no lift on hover. Primary is a night fill. A disabled button keeps full opacity: primary turns `--line-soft` with `--text-sub` text, the others turn `--text-muted`. A busy button keeps its colour; only the spinner says it is working. A split button (`.btn-split`) joins an action and a chevron that opens its menu, with a hairline of the surface between them; the chevron has its own name ("More ways to publish") and both are disabled for the same reason.
- **Fields** (`TextField`, `SelectField`, `.line-input`): 40px in a form, 36px (`size="sm"`) in a toolbar beside buttons; 1px `--line-control` border, 8px radius, night focus ring. Read-only fields get `--surface-alt`. Every single-line select draws Line's chevron, not the browser's (an unlayered rule in `theme-line.css`, so it wins over a utility's padding). `hideLabel` keeps a toolbar field's label for assistive technology only. In a row of fields, labels and controls line up at the top whatever hint or error a neighbour has (`FieldShell` packs to the top). A field's error shows once the person leaves it or tries to save, never on first render.
- **Dialogs** (`Dialog`): the title and the actions stay put and the middle scrolls, with a hairline above the actions when there is content. Never give a form inside a dialog its own scroll area.
- **Access lists** (`pages/ScopePicker.tsx`): one row per resource with radios for No access, Read, and Read and write, used for API keys and OAuth apps instead of a wall of selects. Granted access is a night fill, so what a key can do reads at a glance.
- **Menus** (`.line-menu`, `.line-menu-item`): white, hairline, 10px radius, `--shadow-card`; items 14px with a `--surface-alt` hover. Used by the publication switcher, New post, Insert and the person menu.
- **Status pills** (`.status-pill`): outlined in `currentColor`, 12px, sentence case.
- **Radios and checkboxes** inside their label make the whole label the target, at least 24px high, with a soft wash on hover drawn as a shadow so rows don't move (`theme-line.css`).
- **Loading rows** (`LoadingRows`) wait 200ms before they show (`.loading-delayed`), so a fast answer never flashes grey rows. They hold their space all along.
- **Toolbar rows** above a table use 36px for every control: `size="sm"` on `TextField` and `SelectField`, and the default button.
- **Filter chips** (`.line-chips`, `.line-chip`): status filters with their counts under a list's toolbar (Posts, Subscribers, Media). 32px pills; the chosen one has a night hairline on `--lavender`, the count in `--text-sub`. On a phone the row scrolls sideways inside itself instead of wrapping into several rows.

### Sign-in

Sign-in and app consent are a single card on white under the line mark on a night tile, the same mark as the rail's.

## Icons

Hand-drawn inline SVG in `apps/dashboard/src/icons.tsx`: 24px viewBox, stroke 2, round caps and joins, `currentColor`. Decorative icons are `aria-hidden`; icon-only controls have an accessible name. No emoji and no Unicode glyphs as icons.

## Charts and data

- Series: `--chart-1` night, then `--chart-2` `#AEB8CB`, then `--chart-3` `#C9772B`. Grid lines `--chart-grid`.
- Label lines directly where there is room; otherwise a legend. Every chart has a caption.
- No sparklines or rings standing in for content, and no big-number hero tiles as the lead of a page.
- Sample numbers are labelled "Sample data" and never shown as real.

## Motion

State changes only: 150ms colour transitions on hover, focus and open/close. No page-load choreography and no lift on hover. `prefers-reduced-motion: reduce` turns transitions off.

## Accessibility floor

- Text at least 4.5:1, large text at least 3:1 (see the contrast table). Secondary text on tinted surfaces is tinted from the surface, never plain grey on colour.
- Focus: `outline: 2px solid var(--purple)` (night) with a 2px offset; yellow on the rail. Never removed without a replacement.
- Selection: `--signal-soft` with `--ink` text. `accent-color` and `caret-color` are night.
- Status is never colour alone: routes, checks and pills all carry text.
- Current location is exposed with `aria-current`; menus with `aria-expanded`; the skip link goes to `#main`.
- Everything works by keyboard, at 1440 and at 390 wide.
- Field and button borders (`--line-control`, 3.1:1 on white) meet the 3:1 guideline for component boundaries.

## Voice and plain words

Plain, calm, specific. Sentence case. No hype words and no exclamation marks. Buttons name their action and, where it helps, the count: "New post", "Send to 12,731 subscribers", "Schedule for Fri 7 Nov, 06:00". A disabled action says why. Errors say what went wrong and what to do.

The interface uses plain words. Database and API names are unchanged; `docs/vocabulary.md` is the full reference.

| Say in the UI          | Internal name (schema, API, code) |
| ---------------------- | --------------------------------- |
| Post                   | Dispatch                          |
| Subscriber             | Member                            |
| Segment                | Circle                            |
| Automation             | Flow                              |
| Signup form            | Capture form                      |
| Publication            | Channel                           |
| Send report            | Broadcast results                 |
| Preview text           | Preheader                         |
| Paywall break, paywall | Gate                              |
| Warm-up                | Reputation Ramp                   |
| Paid subscriptions     | Memberships                       |
| Website                | Site Studio                       |
| Referrals & growth     | Growth, Champions                 |

## Do and don't

Do:

- Reach for alignment, a hairline rule and whitespace before a card.
- Use the route for any fixed sequence (setup, sending), with text on every stop.
- Keep one primary action per area, in night.
- Show the real state, including honest empty states that say what will appear and when.

Don't:

- Use yellow for anything but "you are here" or "next step".
- Use gradient text, glass or blur, glows, decorative blobs, or hard offset shadows.
- Use coloured side borders thicker than 1px on cards, list items or alerts.
- Nest cards, or build pages from same-size icon-and-heading card grids.
- Add eyebrow labels, uppercase micro labels, or section numbers that aren't real steps.
- Use mono as decoration, or emoji anywhere.
- Hardcode hex in components: use the tokens.

## Publication websites

Publication websites are reader-facing, not dashboard surfaces, and Line does not apply to them. They use the publication's brand: its accent colour, logo, font choice and colour scheme (light, dark or auto). The Indigo tokens are only the defaults when a publication sets nothing. Pages are readable without JavaScript, load nothing from third parties, and keep a reading measure of about 680px. The dashboard is light only.

With the `site_templates` flag, the home page is a theme: Gate, Letter, Magazine, Newspaper, Launch, Night, Zine or Brief, or the owner's own code (`docs/site-themes.md`). Each theme has its own character, and all of them follow the same rules: the signup form in the first screen for visitors at 390px and 1440px, the promise beside it, proof near it, a sample of the writing, one `<h1>`, sections that pitch to visitors and a "Welcome back" first screen for subscribers that opens on the newest issue, dark mode derived from the tokens (raised surfaces a step lighter, shadows in black, never a glow of the text colour), no script, and no sideways scroll from 320px up. The sections sit in the page-width wrapper and reach past it themselves for full-bleed bands. On phones the header is one line: the name, the navigation when it fits (else a line of its own that scrolls sideways) and a search link in place of the field. The theme's tokens also style post pages and the archive, so the site reads as one design.

- **Night:** dark first and cinematic. A near-black page with a fine film grain drawn in gradients, the name very large in a soft light (its own colour, `glow`), the form in a frosted panel, the issues on a reel of covers that scrolls sideways, and readers' words in light type.
- **Zine:** risograph print. The accent and two more inks overprint where shapes cross, heavy condensed type with a misregistered shadow, sticker badges for the issue and the readers, halftone dots, cut-paper edges, readers' notes taped up and the issues as a stack of colour cards. Tilts only show with motion allowed.
- **Brief:** Swiss and exact. A twelve-column grid (shown as hairlines by default), black rules, one sharp accent, numbered issues and figures in monospace, key figures large in a ruled band (in the heading face, so a comma doesn't take a whole figure's width), benefits as numbered points, the archive as a ruled table and the author as a short signed note.

Indigo, the earlier look (2026-10-26, mockups `design/v2-landing.html` and `design/v2-dashboard.html`), is no longer used by any app. Its values are still the base in `packages/ui/src/tokens.css`, which the dashboard overrides, and they remain the defaults for a publication website that sets nothing.
