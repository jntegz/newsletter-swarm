# Vocabulary

Swarm has two layers of names.

- **UI word:** what the dashboard shows. Plain words that readers and writers already know, in sentence case (lower-case mid-sentence: post, subscriber, segment, automation, publication). Since Nov 2026.
- **Internal name:** what the database, API, code and developer docs use. These did not change: tables, API paths, query keys, webhook event names, merge tags and type names keep the internal names.

`UI_VOCABULARY` and `VOCABULARY` in `packages/domain/src/vocabulary.ts` hold both layers under the same keys. The rename rules for dashboard copy are in `design/2026-11/RENAME.md`. Generic industry words that nobody coined stay generic: email, link, tag, page, domain, template, coupon, trial.

`pnpm check:vocabulary` fails the build when UI source or docs use a banned term, or when an old UI word leaks back into visible dashboard copy or into a message the server writes for the dashboard. This file is excluded because it lists them. A line can opt out with the marker `vocabulary-allow`, for example in an import guide that quotes another platform.

## Product terms

| Concept                        | UI word                              | Internal name      | Database table                         | API path                        |
| ------------------------------ | ------------------------------------ | ------------------ | -------------------------------------- | ------------------------------- |
| Dashboard user                 | Teammate                             | Operator           | `operators`                            | `/operators`                    |
| Workspace role                 | Seat                                 | Seat               | `seats`                                | `/seats`                        |
| Newsletter                     | Publication                          | Channel            | `channels`                             | `/channels/:channelId`          |
| Issue                          | Post                                 | Dispatch           | `dispatches`, `dispatch_revisions`     | `/dispatches`                   |
| A send of a post               | Send (results: Send report)          | Broadcast          | `broadcasts`                           | `/broadcasts`                   |
| Per-recipient send             | Delivery                             | Delivery           | `deliveries`                           | `/broadcasts/:id/deliveries`    |
| Reader on the list             | Subscriber                           | Member             | `members`                              | `/members`                      |
| Custom attribute               | Profile field                        | Member field       | `member_fields`, `member_field_values` | `/member-fields`                |
| Rule-based group               | Segment                              | Circle             | `circles`, `circle_members`            | `/circles`                      |
| Paid plan                      | Paid plan                            | Membership level   | `membership_levels`                    | `/levels`                       |
| Everything readers pay for     | Paid subscriptions                   | Memberships        | —                                      | —                               |
| Paywall                        | Paywall (editor node: Paywall break) | Gate               | `gates`                                | `/gates`                        |
| Automated journey              | Automation                           | Flow               | `flows`, `flow_runs`                   | `/flows`                        |
| Signup form                    | Signup form                          | Capture form       | `capture_forms`                        | `/capture-forms`                |
| Referral programme             | Referrals (area: Referrals & growth) | Champions          | `referrals`                            | `/champions`                    |
| Passwordless sign-in           | Sign-in link                         | QuickPass          | `quickpass_tokens`                     | `/auth/quickpass`               |
| Sending warm-up                | Warm-up                              | Reputation Ramp    | `reputation_ramps`                     | `/sending-domains/:id/ramp`     |
| Self-service page              | Subscriber settings                  | Member Center      | —                                      | `/m/*` (capture worker)         |
| Data-subject request queue     | Privacy Center, data request         | Privacy Center     | `dsr_requests`                         | `/workspaces/:id/privacy`       |
| Sync to the operator's bucket  | Export destination                   | Export destination | `export_destinations`                  | `/export-destinations`          |
| Multiple lists                 | Roster                               | Roster             | `rosters`                              | `/rosters`                      |
| Uploaded file                  | Media                                | Media              | `media`                                | `/media`                        |
| Higher paid plan               | Founding plan                        | Founding Level     | `membership_levels.founding`           | `/levels`                       |
| Gifted subscription            | Gift subscription                    | Gift Pass          | `gift_passes`                          | `/gift-passes`                  |
| Reading score for a subscriber | Engagement score                     | Engagement score   | `member_engagement`                    | `/members/engagement`           |
| Cross-publication picks        | Partner Exchange, Partner Picks      | Partner Exchange   | —                                      | —                               |
| Acquisition credits            | Signals                              | Signals            | —                                      | —                               |
| Sponsorship marketplace        | Sponsor Match                        | Sponsor Match      | —                                      | —                               |
| Digital products               | Goods                                | Goods              | —                                      | —                               |
| Website builder                | Website                              | Site Studio        | —                                      | —                               |
| Community                      | Commons                              | Commons            | —                                      | —                               |
| In-product assistant           | Copilot                              | Copilot            | `copilot_requests`, `copilot_keys`     | `/copilot`                      |
| Subscriber activity log        | — (internal)                         | Member event       | `member_events`                        | —                               |
| Automation email               | Automation email                     | Flow email         | `dispatches` (`kind = flow`)           | `/flows/:id`                    |
| What starts an automation      | Start event                          | Flow trigger       | `flows.trigger_type`, `graph_json`     | `/flows/:id`                    |
| Limits on automated email      | Inbox rules                          | Inbox rules        | `channels.settings_json`, `flow_holds` | `/channels/:id/inbox-rules`     |
| Built-in onboarding            | Welcome email                        | Welcome Dispatch   | `flows` (`recipe = welcome`)           | `/flows`                        |
| Starting automation graphs     | Recipe                               | Flow Recipe        | `flows.recipe`                         | `/flows/recipes`                |
| Saved post layouts             | Template                             | Template           | `templates`                            | `/templates`                    |
| A/B test of a send             | Split test                           | Split Test         | `split_tests`, `split_test_variants`   | `/dispatches/:id/split-test`    |
| Send to a share first          | Cohort sampling                      | Cohort Sampling    | `cohort_samples`                       | `/dispatches/:id/cohort-sample` |
| Conditional content block      | Smart block                          | Smart Block        | — (editor node `smartBlock`)           | —                               |
| Referrer                       | Referrer                             | Champion           | `members.champion_code`                | `/champions`                    |
| Referral reward step           | Milestone                            | Milestone          | `champion_milestones`                  | `/champions/milestones`         |
| Poll or survey                 | Polls & surveys; poll, survey        | Ask                | `asks`, `ask_responses`                | `/asks`                         |
| Steps after subscribing        | Signup journey                       | Signup Journey     | `signup_journeys`                      | `/journeys`                     |
| On-site signup prompt          | Smart Prompt                         | Smart Prompt       | `capture_forms` (`kind = prompt`)      | `/capture-forms`                |
| Acquisition analytics          | Funnel explorer                      | Funnel Explorer    | `funnel_daily`                         | `/analytics/funnel`             |
| Ordered post group             | Series                               | Series             | `series`, `series_dispatches`          | `/series`                       |
| Inbox preview line             | Preview text                         | Preheader          | `dispatches.preheader`                 | `/dispatches`                   |
| Link-in-bio page               | Link Hub                             | Link Hub           | `hub_settings`, `hub_links`            | `/link-hub`                     |
| Feeds that become posts        | Feed Sync                            | Feed Sync          | `feed_sources`, `feed_items`           | `/feed-sources`                 |

## Status values

Status values are API and database values, so they keep the internal names.

- **Member (subscriber):** `pending`, `active`, `paused`, `unsubscribed`, `bounced`, `complained`.
- **Dispatch (post):** `draft`, `scheduled`, `sending`, `sent`, `canceled`.
- **Broadcast (send):** `queued`, `snapshotting`, `sending`, `sent`, `partially_failed`, `failed`, `canceled`.
- **Flow (automation):** `draft`, `live`, `paused`, `archived`.
- **Flow run:** `running`, `waiting`, `paused`, `completed`, `exited`, `failed`.
- **Split Test:** `draft`, `testing`, `promoted`, `canceled`.
- **Referral:** `pending`, `counted`, `held`, `rejected`.
- **Ask (poll or survey):** `draft`, `open`, `closed`.

## Merge tags

Merge tags are part of the stored content format, so they keep the internal names. The tags are `{{member.first_name}}`, `{{member.last_name}}`, `{{member.email}}`, `{{channel.name}}`, `{{fields.<key>}}`, `{{links.member_center}}` and `{{links.unsubscribe}}`.

Every tag can take a fallback, written `{{member.first_name | "there"}}`. Values are HTML-escaped.

## Banned in product surfaces

**Old UI words (dashboard copy only):** the internal names stay in code, the database, the API and developer docs, but visible dashboard copy uses the UI word. `pnpm check:vocabulary` flags these when they appear capitalised in JSX text or string literals under `apps/dashboard/src`.

| Don't show           | Show instead        |
| -------------------- | ------------------- |
| Dispatch, Dispatches | Post, Posts         |
| Broadcast            | Send, Send report   |
| Member, Members      | Subscriber(s)       |
| Member Center        | Subscriber settings |
| Circle, Circles      | Segment(s)          |
| Flow, Flows          | Automation(s)       |
| Capture form         | Signup form         |
| Membership level     | Paid plan           |
| Gift Pass            | Gift subscription   |
| Site Studio          | Website             |
| Reputation Ramp      | Warm-up             |
| Preheader            | Preview text        |

**Server messages:** the dashboard shows API error messages, pre-send checks, render warnings and validation messages as the server wrote them, so they use the UI words too ("Post not found.", "This publication is paused."). Error codes, field names and the OpenAPI summaries and descriptions keep the internal names. The check reads string literals in a message position (an argument of an error constructor, a `message` value, a render warning) under `workers/api`, `workers/jobs`, `workers/send`, `workers/events`, `packages/engine`, `packages/mail` and `packages/domain`.

**Legacy terms (everywhere the check runs):**

| Don't write                | Write instead |
| -------------------------- | ------------- |
| campaign                   | post, send    |
| tier (meaning a paid plan) | paid plan     |

**Terms coined by other platforms:**

| Don't write             | Write instead       |
| ----------------------- | ------------------- |
| Boost                   | Signals             |
| Smart Warming           | Warm-up             |
| Restack                 | Relay               |
| Recommendation Network  | Partner Exchange    |
| Ad Network              | Sponsor Match       |
| Subscriber Center       | Subscriber settings |
| Notes (short-post feed) | Commons             |

Competitor product names may not appear in product surfaces either.
