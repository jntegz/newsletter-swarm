# Email checks with DeBounce

Swarm can check your subscribers' addresses with [DeBounce](https://tegze.link/debounce), an email verification service. A check tells you, before you send, which addresses will bounce, which are worth a closer look and which are fine. Fewer bounces keep mailbox providers trusting you, so more of your email reaches the inbox.

Checks happen in four places:

- **Signup forms**: on a form that asks people to confirm by email, a signup is checked once the person has confirmed, never before. On a single opt-in form, and only if you turn it on, a signup is checked while the person waits, and an address that will bounce can be turned away.
- **Imports**: tick "Check addresses during import" on the review step, and addresses that will bounce are left out.
- **Adding someone by hand or through the API**: checked a few seconds later, in the background.
- **Your whole list**: on the Subscribers page, choose **Check addresses**.

Each address DeBounce checks uses one DeBounce credit. Swarm's own checks come first and are free, and an address checked recently is never checked again.

## Setting it up

DeBounce is set up once for the whole Swarm, by the person who installed it. The key is a secret of the Swarm's workers, like its email service key: it is never typed into the dashboard and never stored in the database.

1. **Create a DeBounce account** at [tegze.link/debounce](https://tegze.link/debounce) and buy credits there.
2. In DeBounce, open **API settings** ([app.debounce.io/api](https://app.debounce.io/api)) and copy the API key.
3. On the computer you installed Swarm from, run:

   ```bash
   pnpm swarm enable debounce
   ```

   and paste the key. The installer checks it with DeBounce, keeps it in `.swarm/<env>.secrets.json` (back that folder up) and redeploys the api, capture and jobs workers with it. `pnpm swarm doctor` then reports whether the key is set and how many credits are left.

   Installed by hand? Run `wrangler secret put DEBOUNCE_API_KEY --env production` in `workers/api`, `workers/capture` and `workers/jobs`, then deploy them.

4. In the dashboard, open **Apps** and the **DeBounce** card. It shows your credit balance.

The feature switch is `email_verification` (on after an install; see [self-hosting.md](self-hosting.md#features)). It does nothing until the key is set.

### Who can use the credits

The credits are the install owner's. On the DeBounce card, instance admins choose who may use them:

- **Only the workspaces you allow** (the default), one by one under "Allowed workspaces". A workspace an instance admin makes is allowed when it is made: the installer allows the owner's, and making someone an instance admin allows the workspaces they made (their `workspace.created` audit entry names them). Being an owner of a workspace allows nothing by itself, because any owner can make a teammate an owner without asking; the list shows where an instance admin is an owner, so you can allow it with one tick.
- **Every workspace on this Swarm.**

**Each workspace's share.** Instance admins set both numbers per workspace under **Settings > Instance > DeBounce credits per workspace** (or with `PUT /api/v1/instance/email-checks/workspaces/{id}`, `dailyChecks` and `listChecks`, null for the default); an empty field means the default.

- **Single checks** (signups, people added by hand or through the API, signups once they confirm, and **Check again**) are counted per workspace per UTC day: 200 by default. A result that still counts is reused, so the same address posted to a form again costs nothing, and **Check again** asks DeBounce only once an hour per address. When a workspace's share is used up, its signups pass unchecked and added people wait for a later check of the list, and its card says so; other workspaces keep their own share.
- **Checks of a list** (whole-list or segment checks, and imports that check their addresses) are counted per workspace per calendar month (UTC): 25,000 addresses sent to DeBounce by default (`EMAIL_CHECK_MONTHLY_LIST_CHECKS`). A check takes what its plan needs when it starts. The plan shows how many the workspace has left this month, and a check that needs more doesn't start: the dashboard says so before you press Start, and the API answers 409. What a stopped check never sent to DeBounce is given back; a part DeBounce already has stays counted, since it uses the credits. An import whose check doesn't fit goes on without the check, and the import screen says why. Each workspace may run one check of a list at a time.

Anyone else sees on the card whether checking is available to them, never the key or any part of it. In an allowed workspace, its admins choose what happens to each colour and run checks of the list; everyone can see the colours.

## Colours and reasons

Every checked address gets one colour. An address with no result is **not checked**. The Subscribers page shows a small dot next to each address; hover it (or use a screen reader) for its words.

| Colour | DeBounce result      | What it means                                                                           |
| ------ | -------------------- | --------------------------------------------------------------------------------------- |
| Green  | Deliverable          | The mailbox exists and takes email.                                                     |
| Orange | Can't be confirmed   | The server accepts every address (accept-all), so this one can't be confirmed.          |
| Orange | Server didn't answer | The mail server could not be reached, even after DeBounce tried again.                  |
| Orange | Team address         | An address like info@ or support@ that reaches a team, not one person.                  |
| Orange | Temporary address    | A throwaway mailbox that stops working after a while.                                   |
| Red    | Will bounce          | The mailbox does not exist.                                                             |
| Red    | Not an email address | The address is written wrong.                                                           |
| Red    | Spam trap            | An address kept to catch senders who mail people who never asked. Mailing it hurts you. |

Swarm's own free checks settle three of these without DeBounce: addresses that are written wrong (red), addresses at well-known throwaway providers (orange) and team addresses (orange). The subscriber's page says which check gave the result.

A result counts for **6 months** by default (change it on the DeBounce card). After that it still shows, marked as old, and the next check of the list asks DeBounce again.

Filter the Subscribers list by colour, and by reason once a colour is picked. In segments, use the condition **Email check is** Green, Orange, Red or Not checked.

## What happens to each colour

On the DeBounce card, admins set what each colour does for each place an address comes from.

| Where from                       | Choices                                                                                    | Default                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Signup forms                     | accept, accept and tag, ask them to confirm by email, refuse (shown only if you choose)    | green and orange accepted, red refused quietly         |
| Imports                          | import, import and tag, import as pending to confirm by email, skip and list in the report | green and orange imported, red skipped                 |
| Added by hand or through the API | keep, keep and tag                                                                         | green and orange kept, red kept and tagged `email-red` |

Tags are named `email-green`, `email-orange` and `email-red`.

### Signup forms

**Forms that ask people to confirm by email** (double opt-in) send nothing to DeBounce when someone signs up. The address is checked once its owner has clicked the confirmation link (**Check signups once they confirm** on the DeBounce card, on by default), so addresses typed by someone else, and addresses nobody confirms, never leave your Swarm. The signup rules then apply: accept, or accept and tag, as at the form; "ask them to confirm" has nothing left to do; and **refuse** stops mailing them, with a suppression for this publication (reason "Email check: red", removable on the Sending page), as **Stop mailing them** does. Subscribers with a paid subscription are never stopped. The check runs in the background a few seconds after the confirmation and never changes the confirmation page.

**Single opt-in forms** have no confirmation step. Checking signups there is **off unless you turn it on** (**Check signups at single opt-in forms while they wait** on the DeBounce card). When it is on, each address typed into your forms goes to DeBounce before the person has confirmed anything, including addresses that are then refused and addresses typed by someone other than their owner; nothing about a refused address is kept in Swarm. Say so in your privacy notice before you turn it on. Workspaces that saved their DeBounce settings before this changed keep what they saved; the others now start with it off. People added without a check are covered by a later check of the list, by confirmation mail and by bounce handling.

On a single opt-in form, a signup is checked after every other check on the form (the bot check included), so bots never use your credits. The person waits at most about 4 seconds. If DeBounce is slow, down, out of credits or busy, they are let in and stay "not checked", so a later check of the list covers them. A signup is never lost because of DeBounce.

The defaults follow DeBounce's own advice for forms: accept-all and unknown results are real people more often than not, so only red is refused. By default the form does not say so: a refused address gets exactly the answer any signup gets and is simply not added, so nobody can use your form to learn what DeBounce thinks of someone else's address. Turn on **Tell people at the form what the check found** to show the refusal instead. Then, when DeBounce suggests a spelling, the form offers it: "Did you mean jan@gmail.com?" fills the field in. The plain form on your website shows the same question on a page of its own, with one button to sign up with the suggested address. Swarm's own free checks (a malformed address, a throwaway provider) always answer with their message, since anyone can tell those.

A refusal only says the address can't receive email. It never says whether the address is already on your list, and every signup is asked about, so the answer's timing doesn't tell either.

Swarm's own list of throwaway providers still turns those addresses away at signup, whatever the colour rules say: that check came before DeBounce and stays.

### Imports

On the review step, tick **Check addresses during import**. It shows the most credits it can take: one per new address, fewer once Swarm's free checks and recent results are taken out. Confirming the import then checks the new addresses first; the import screen says how far the check is, and the import starts when it is done. Red addresses are skipped and listed under "Email check" in the import's summary. Addresses already on the list are not checked by an import.

Without DeBounce, the review step mentions it once; dismiss it and it stays away.

### Added by hand or through the API

The subscriber is added straight away. The check follows a few seconds later and never blocks anything. Open a subscriber to see their check, or choose **Check again** (it uses a credit).

## Checking your whole list

On the Subscribers page, admins choose **Check addresses**.

1. **Choose what to check**: this publication, every publication in the workspace (an address in two publications is checked once), or one segment. Tick **Only addresses that were never checked** to skip old results too.
2. **Count addresses.** This sends nothing to DeBounce. The plan shows how many different addresses there are, how many were checked recently (skipped), how many Swarm settles for free, how many credits the rest need, and your DeBounce balance, with a warning when it isn't enough.
3. **Start the check.** Swarm's own results are stored first. The rest go to DeBounce in parts of 5,000 addresses, one part at a time, because DeBounce checks one list at a time per account. The screen shows the part, how many have a result and the credits used so far. You can close it: the check carries on. A check of 100 addresses or fewer asks DeBounce one address at a time instead. If DeBounce keeps failing for an address (busy, down, an answer Swarm can't read, or no free place to ask), Swarm tries it 3 times, then leaves it not checked and finishes the check; the result says how many addresses that was.

**Stop** sends no further part. DeBounce can't cancel a part it already has, so that part finishes, uses its credits, and its results are still stored.

**Out of credits** pauses the check with a message. Add credits in DeBounce, then choose **Resume**: it carries on with the addresses that are left. An import whose check paused shows the same message on the import screen, with **Resume the check** and **Import without checking the rest**.

One check runs at a time in a workspace.

## What to do with red and orange

**Red** addresses only add bounces. With the Red filter on (or in the results), choose:

- **Stop mailing them** (recommended): each gets a suppression for this publication, so no email goes to them. It can be undone: remove the suppression on the Sending page.
- **Delete them**: they are deleted, which can't be undone.

Both show how many subscribers they change and ask first. **Subscribers with a paid subscription are never changed**: they are listed under "Needs your attention", to look at one by one (the address may have a typo, or they may pay with another one).

**Orange** addresses are often real people. Don't remove them: make a segment where **Email check is Orange**, send them a re-engagement automation, and let the [inactive-reader cleanup](audience.md#cleaning-up-inactive-readers) take those who never open.

The deliverability check-up mentions email checks once: when much of your list has never been checked, when many checked addresses are red, or (without DeBounce) that checking is possible.

## Privacy

When you check addresses, **DeBounce becomes a processor of the addresses Swarm sends it**: only the address, never names, profile fields or anything else. Add it to your privacy notice and your record of processing, and check DeBounce's own data processing terms. See [subprocessors.md](subprocessors.md) and [gdpr.md](gdpr.md#email-checks-with-debounce).

To check a list, DeBounce's bulk service fetches each part from a web address on your own Swarm (`/api/v1/public/email-check-lists/<random>.csv`). That file holds addresses only, one per line. Its address carries a random 256-bit token made for that part alone; Swarm stores only the token's hash. The file and its address stop working as soon as DeBounce has finished the part, and after 24 hours at the latest. Anyone who learned the address in that window could download the part, so it is never shown anywhere or written to logs by Swarm. Signup and single checks send one address straight to DeBounce's API. A signup through a form that asks people to confirm is sent only after its owner confirmed it.

Swarm keeps one result per address per workspace: the colour, DeBounce's code and words, its suggested spelling, who gave the result and when. A refused signup's result is not kept. A subscriber's data export includes their result. Erasing an address through the Privacy Center deletes its result, and its place in a check that is still running.

## For developers

**Code.** `packages/engine/src/debounce.ts` is the only code that talks to DeBounce: `debounceClient` (single check, balance, bulk upload, status, results download), `parseBulkResults`, and `fakeDebounceFetch`, the fake used in development and every test (the key `dev`, refused outside development). `packages/engine/src/email-checks.ts` holds the rules: availability (`emailCheckAccess`, the `site_code_rules` shape), Swarm's free checks (`localCheck`, on `addresses.ts`), the signup check (`checkSignup`, `afterJoin`), background checks, runs (`createRun`, `planRun`, `startRun`, `advanceRun`, `stopRun`, `resumeRun`), the served file (`emailCheckFile`) and summaries. Shared shapes and the colour mapping: `packages/domain/src/email-checks.ts`, with `DEBOUNCE_SIGNUP_URL`, the only copy of the referral link.

**Tables** (`migrations/0068_email_verification.sql`): `email_check_rules` and `email_check_workspaces` (who may use the key), `email_check_budgets` and `email_check_list_budgets` (each workspace's own numbers, `0099` and `0118`, with use counted in `usage_windows`), `email_check_settings` (a workspace's rules), `email_checks` (one result per workspace and address; no row means not checked), `email_check_runs`, `email_check_items` (a run's addresses, deleted when it ends), `email_check_parts` (bulk parts: list id, file key, token hash, expiry), `email_check_leases` (the concurrency limit), and `import_jobs.check_addresses` / `email_check_run_id`.

**Concurrency.** DeBounce allows 5 calls at once per account. Every single check takes a lease in `email_check_leases` first: one D1 batch deletes expired leases and inserts a new one only while fewer than 5 are live (D1 runs one write at a time, so the count and the insert can't interleave). Background checks stop at 4, leaving the last place to signup forms. A lease ends by itself after 20 seconds, so one a worker never gave back frees its place. In a small run an address that gets no answer (a temporary `DebounceError`, or no lease in time) counts one try in `email_check_items.attempts` (`0069`); at `SINGLE_ATTEMPTS` (3) it is done without a result, the run's `error` says how many, and the run goes on to `finishRun` (Circle refresh, the import carrying on) instead of asking again every minute.

**Runs.** Planning (`email_check_plan` messages on the jobs queue, 20 batches of 500 per message) sorts each address into recent result, Swarm's own result or for DeBounce, deduplicated by `(run_id, email)`. Starting stores Swarm's results and queues `email_check_run`. Each step claims the next part's row first, numbers 5,000 addresses, writes the file to the `IMPORTS` bucket under `email-checks/`, makes a token and calls DeBounce's upload with `<APP_ORIGIN>/api/v1/public/email-check-lists/<token>.csv`. The jobs worker's minute cron polls parts at DeBounce, applies finished ones (only addresses that were in the part), drops every file past 24 hours whatever its run is doing (`dropExpiredFiles`), and gives up on a part after 7 days. 402 pauses a run (`paused_reason = 'credits'`), 401 and 403 too (`'key'`); 429 and outages wait for the next minute. Finished runs refresh the workspace's segments and, for an import's run, queue `import_run`. A duplicated or replayed message never spends credits twice: a worker sending a part (an upload, or one step of a small check) holds it in `email_check_parts.claimed_until` (0140) for up to 10 minutes, so a second delivery or the minute cron finds it taken, or already at DeBounce, and sends nothing; the claim is let go when the work ends, and one left by a worker that died runs out on its own. Two starts of the same run (a duplicated plan message for an import, a double click) take the workspace's list checks once: the start that loses gives back what it took.

**Routes** (zod schemas in `@swarm/domain`, policy in `workers/api/src/lib/policy.ts`):

| Route                                                                            | Who                                                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `GET`, `PUT /api/v1/instance/email-checks`                                       | instance admins: key set, balance, every workspace                              |
| `PUT /api/v1/instance/email-checks/workspaces/{workspaceId}`                     | instance admins: allow one workspace                                            |
| `GET /api/v1/workspaces/{workspaceId}/email-checks`                              | viewer (the balance for admins only)                                            |
| `PUT /api/v1/workspaces/{workspaceId}/email-checks/settings`                     | admin                                                                           |
| `POST /api/v1/workspaces/{workspaceId}/email-checks/runs`                        | admin: plan a check                                                             |
| `GET /api/v1/workspaces/{workspaceId}/email-checks/runs/{runId}`                 | admin                                                                           |
| `POST …/runs/{runId}/start`, `…/stop`, `…/resume`                                | admin                                                                           |
| `GET /api/v1/channels/{channelId}/email-checks`                                  | viewer: counts by colour and reason, latest check                               |
| `POST /api/v1/channels/{channelId}/email-checks/red`                             | admin: count, then suppress or delete red subscribers                           |
| `GET`, `POST /api/v1/members/{memberId}/email-check`                             | viewer reads, editor checks again                                               |
| `PUT /api/v1/imports/{importId}/email-check`                                     | editor: "Check addresses during import"                                         |
| `GET /api/v1/imports/{importId}/email-check`, `POST …/email-check/{resume,stop}` | viewer follows an import's check, editor resumes it or imports without the rest |
| `GET /api/v1/public/email-check-lists/{token}.csv`                               | public: the random token is the proof                                           |

The member list (`/api/v1/channels/{channelId}/members` and `/v2`) returns `emailCheck` on each subscriber and takes `emailCheck` (`green`, `orange`, `red`, `unchecked`) and `emailCheckCode` filters. Segments take the `email_check` condition (`circles.ts`).

**The results file.** Swarm fetches it from the link in DeBounce's status answer, treating that link like any address it didn't choose: it must pass the outbound guard, redirects (at most 3) are followed by hand and each target is checked again before it is contacted, and the body is read to at most 64 KB plus 1 KB per address in the part (32 MB at most, `debounceResultsLimit`). A file over that is refused before any result is applied; the run shows the error and tries again on its next step, and a part DeBounce never delivers properly fails after 7 days as before. Results for addresses that are not in the part are ignored. DeBounce does not document the columns of its bulk results file, so `parseBulkResults` finds them by header name (the address, the code, the result words, the reason, `did_you_mean`) and falls back from code to result words. It has been tested with files shaped like DeBounce's documented single-check fields, not yet with a real results file: check one against it when you first run a bulk check.
