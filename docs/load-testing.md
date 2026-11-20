# Load testing: the Phase 2 exit gate

The Phase 2 gate is one Broadcast to 100,000 Members on staging, through the real pipeline (snapshot, fan-out, the send worker, SES, SNS feedback to the events worker), that ends with:

- no duplicate Deliveries, and every recipient with exactly one Delivery;
- every bounce and complaint simulator recipient's Member moved to `bounced` or `complained` within 1 minute of its Delivery;
- the SES cost of the run reported.

The tooling lives in `scripts/load/`:

| File                  | Runs on              | What it does                                                                                                           |
| --------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `seed-members.mjs`    | Node 22              | Writes SQL that adds N mailbox simulator Members to a Channel, and optionally completes the Channel's Reputation Ramp. |
| `broadcast-100k.js`   | [k6](https://k6.io)  | Creates a Dispatch over `/v2`, schedules it, waits for the Broadcast and watches it to the end.                        |
| `check-broadcast.mjs` | Node 22 and Wrangler | Reads D1 and checks the gate's criteria; exits 1 when one fails.                                                       |

None of them can run in CI: they need a deployed staging environment and an SES account.

## Prerequisites

- **Staging deployed** with every worker and migration (docs/deployment.md), and the `send` cron running: a scheduled Dispatch starts only from that cron.
- **SES out of the sandbox** in the staging region, with a daily quota of at least 100,000 and a send rate you want to measure. The mailbox simulator works in the sandbox too, but the sandbox allows 200 messages a day.
- **SES feedback wired:** the configuration set publishes to the SNS topic in the events worker's `SNS_TOPIC_ARNS`, and the topic's HTTPS subscription to `/sns/ses` is confirmed. Without it no bounce or complaint reaches D1 and the feedback checks fail.
- **A sender SES accepts.** The shared platform domain (`<channel slug>@PLATFORM_MAIL_DOMAIN`) must be a verified SES identity, or the Dispatch uses a sender identity on a verified custom sending domain with DMARC at quarantine or reject (the pre-send checklist refuses anything else).
- **A staging Channel**, created in the dashboard (Channels are not created over `/v2`), with no other active Members you mind mailing. A fresh Channel is best.
- **An API key** for the Channel's workspace (Settings → Developers → API keys) with the scopes `dispatches:read`, `dispatches:write` and `broadcasts:read`.
- **Tools:** k6 (`brew install k6`, or see k6's install page), Node 22, and a Wrangler login with access to the staging D1 database (`pnpm --filter @swarm/api exec wrangler login`).

About the simulator: SES's mailbox simulator addresses (`success@`, `bounce@`, `complaint@simulator.amazonses.com`) produce real SES events, accept a `+label`, and, per AWS, do not count toward the account's bounce and complaint rates, so the run cannot hurt the staging account's reputation. They do count toward the sending quota and rate. Check AWS's current SES pricing page for how simulator sends are billed; the checker reports list price.

The bounce and complaint simulator addresses are suppressions afterwards like any others, and the jobs worker queues them for the SES account-level suppression list (docs/deliverability.md "Suppressions"). The `--run` tag gives every run new addresses, so that never shrinks the next run's audience.

## 1. Seed the Members

```sh
node scripts/load/seed-members.mjs --channel ch_… --count 100000 \
  --bounce 0.01 --complaint 0.005 --run gate1 --complete-ramp
cd workers/api
node_modules/.bin/wrangler d1 execute DB --env staging --remote --file ../../scripts/load/out/seed.sql
```

This writes `scripts/load/out/seed.sql` (keep `out/` out of commits) with:

- 100,000 active Members whose addresses are `success+gate1-000001@simulator.amazonses.com`, with 1% `bounce+…` (a hard bounce) and 0.5% `complaint+…`, spread evenly through the list. The `--run` tag makes every run's addresses new, so a bounce suppressed by an earlier run never shrinks the next audience.
- With `--complete-ramp`, the Channel's Reputation Ramp for the shared domain created and marked `complete` (add `--ramp-domain sd_…` for a custom sending domain's ramp). A fresh ramp starts at 100 or 200 a day, and the shared domain's tops out at 5,000, so without this the Broadcast would wait for the ramp for weeks. Completing it is a staging-only shortcut: the gate measures the pipeline, not the ramp. The ramp can't be completed over the API (`PATCH /api/v1/ramps/{rampId}` takes only `warming` or `paused`).

Why SQL and not an import: an import of 100,000 rows runs through analysis and chunked import jobs, and an import with 1,000 or more new Members puts the Channel's Reputation Ramp back to warming. The script writes the same columns an import would, in statements of 200 rows, each `ON CONFLICT (channel_id, email) DO NOTHING`, so applying the file twice adds nothing.

## 2. Send the Broadcast

```sh
k6 run scripts/load/broadcast-100k.js \
  -e API_ORIGIN=https://app.staging.swarm.example \
  -e API_KEY=sk_live_… -e CHANNEL_ID=ch_… \
  -e EXPECTED_RECIPIENTS=100000
```

Options: `SENDER_IDENTITY_ID=si_…` (send from a custom domain; otherwise the Channel's default sender), `CIRCLE_ID=cl_…` (only that Circle; otherwise every active Member), `READ_RATE` and `READ_MINUTES` (that many stats reads a minute while it sends, as an open dashboard would; default off), `MAX_MINUTES` (default 180).

What it does, all over `/v2` with the API key:

1. `GET /v2/channels/{channelId}`, then `POST /v2/channels/{channelId}/dispatches` with a short document, and `PATCH …/dispatches/{dispatchId}` for the sender or audience when given.
2. `POST …/dispatches/{dispatchId}/schedule` 75 seconds ahead. `/v2` has no "send now"; scheduling runs the pre-send checklist and answers `409` with the failing checks, which k6 prints.
3. Polls `GET …/dispatches/{dispatchId}` until `latestBroadcastId` appears (the send cron started it), then `GET /v2/channels/{channelId}/broadcasts/{broadcastId}` every 10 seconds until it is `sent`, `partially_failed`, `canceled` or `failed`, logging progress and messages per second.

Thresholds: every check passes (finished as `sent`, `sentCount` equals `recipientCount`, nothing failed, at least `EXPECTED_RECIPIENTS` recipients) and no API call failed. A `429` waits for `Retry-After` and retries; keep `READ_RATE` plus the 6 polls a minute under the plan's `/v2` rate (60 a minute on Free). The last line prints the checker command with the Broadcast id.

## 3. Check the result

```sh
node scripts/load/check-broadcast.mjs --broadcast bc_… --env staging --wait 5
```

`--wait` waits up to that many minutes for the Broadcast to finish. Run it a few minutes after the last send, so the last complaints have arrived (SES sends the simulator's complaint shortly after the delivery). It reads D1 through `wrangler d1 execute DB --remote --json` in `workers/api` (`WRANGLER_BIN` overrides the binary; `--local` reads the local database). Each check prints PASS or FAIL with counts:

| Check                               | How                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Broadcast finished, no failed sends | `broadcasts.status = 'sent'`, `failed_count = 0`                                                                                      |
| No duplicate Deliveries             | No Member and no address (case-insensitive) with two `deliveries` rows for the Broadcast                                              |
| Exactly one Delivery per recipient  | Every `broadcast_recipients` row has exactly one Delivery, every Delivery has a recipient, and the snapshot matches `recipient_count` |
| No failed Deliveries                | No Delivery with status `failed`                                                                                                      |
| Bounces within 1 minute             | Every `bounce+…` recipient's Member is `bounced`, and its `updated_at` is at most 60 s after the Delivery's `sent_at`                 |
| Complaints within 1 minute          | The same for `complaint+…` and `complained`                                                                                           |

`sent_at` is written when the send batch starts and the Member's `updated_at` by the statement that changes its status (`packages/engine/src/feedback.ts`), so the measured time covers SES, SNS and the events worker. `--feedback-limit-ms` changes the limit.

The summary prints the totals, the time from start to finish, and the SES cost: messages handed to SES × `--price-per-1000` (default $0.10), plus the estimated outbound data (the frozen HTML and text plus 2 KB of headers per message) × `--price-per-gb` (default $0.12). Confirm the figure against Cost Explorer (service SES) for the day of the run.

## The gate passes when

- k6 exits 0;
- `check-broadcast.mjs` exits 0 (every line PASS);
- the throughput and the SES cost are written into the Phase 2 sign-off, with the Broadcast id.

## Cleanup

Run the check first: deleting Members removes their `broadcast_recipients` rows. Then, from `workers/api`:

```sh
node_modules/.bin/wrangler d1 execute DB --env staging --remote --command "
  DELETE FROM suppressions WHERE email LIKE '%@simulator.amazonses.com'
     AND workspace_id = (SELECT workspace_id FROM channels WHERE id = 'ch_…');
  DELETE FROM members WHERE channel_id = 'ch_…' AND email LIKE '%@simulator.amazonses.com';
  UPDATE reputation_ramps SET status = 'warming', cap_today = start_cap, paused_reason = NULL
   WHERE channel_id = 'ch_…';"
```

The last statement puts the Channel's Reputation Ramp back to the start; leave it out to keep the Channel ready for the next run. Deleting the Channel in the dashboard removes everything instead.

## Local load runs: the Phase 3 exit gate

Two scripts measure audience work at size on this machine. They start their own copy of the api, jobs and realtime workers in one `wrangler dev`, with a database in a temp folder, so they don't touch `.wrangler/state`. They are not part of `pnpm test`. Don't edit worker code while one runs: wrangler reloads the workers and the queue loses its work.

| Command             | What it does                                                                                                                                                                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm load:import`  | Uploads a 50,000-row CSV with a known number of rows in every class, checks the dry run counts each exactly and writes no Members, confirms, waits for the import, then checks D1 and that a finished Reputation Ramp went back to warming. `--rows` changes the size.                  |
| `pnpm load:circles` | Seeds 120,000 Members plus 20,000 in another Channel, times `POST /circles/preview` over HTTP for 15 kinds of rule, and fails on any request of 1.5 seconds or more or any full table scan in `EXPLAIN QUERY PLAN`. No `ANALYZE` unless you pass `--analyze`: nothing in Swarm runs it. |

**These numbers are local D1, which is workerd's SQLite on your disk.** They show that the plans use indexes and the order of magnitude. They include no network, no replicas and none of Cloudflare's limits, so repeat the run on staging before trusting a timing for production.

The dry run holds every address it has seen in memory, so it runs in one invocation. It reads 1,000 rows at a time to stay well inside the D1 and R2 calls one invocation may make; a file of several hundred thousand rows has not been tried on Cloudflare.
