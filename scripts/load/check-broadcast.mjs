#!/usr/bin/env node
// Phase 2 exit gate: checks a finished load-test Broadcast in D1. See docs/load-testing.md.
//
//   node scripts/load/check-broadcast.mjs --broadcast bc_… [--env staging] [--local]
//     [--wait 30] [--feedback-limit-ms 60000] [--price-per-1000 0.10] [--price-per-gb 0.12]
//
// Reads D1 through `wrangler d1 execute DB --json` run in workers/api (WRANGLER_BIN overrides the
// binary), so it needs the same Cloudflare login as a deploy. Every query aggregates in SQL;
// only the bounce and complaint rows come back one by one. Exit status: 0 pass, 1 fail, 2 usage
// or tooling error.
//
// Checks:
// 1. The Broadcast finished (status sent) with no failed sends.
// 2. No duplicate Deliveries: none per Member, none per address.
// 3. Every recipient in the snapshot (broadcast_recipients) has exactly one Delivery, and every
//    Delivery belongs to a recipient.
// 4. Every bounce@ and complaint@ simulator recipient's Member moved to bounced or complained
//    within the limit (default 1 minute) of its Delivery's sent_at, judged by the Member's
//    updated_at (written by the same statement that changes the status).
// 5. Reports the SES cost: messages × price per 1,000, plus the estimated outbound data.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    broadcast: { type: 'string' },
    env: { type: 'string', default: 'staging' },
    local: { type: 'boolean', default: false },
    wait: { type: 'string', default: '0' },
    'feedback-limit-ms': { type: 'string', default: '60000' },
    'price-per-1000': { type: 'string', default: '0.10' },
    'price-per-gb': { type: 'string', default: '0.12' },
    'persist-to': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
});

if (values.help) {
  console.log(
    'Usage: check-broadcast.mjs --broadcast bc_… [--env staging] [--local] [--wait minutes] [--feedback-limit-ms 60000] [--price-per-1000 0.10] [--price-per-gb 0.12]',
  );
  process.exit(0);
}

const usage = (message) => {
  console.error(`check-broadcast: ${message}`);
  process.exit(2);
};

const broadcastId = values.broadcast ?? '';
// Interpolated into SQL below, so it must be exactly an id.
if (!/^bc_[0-9a-f]{32}$/.test(broadcastId))
  usage('--broadcast must be a Broadcast id (bc_ + 32 hex).');
if (!/^[a-z]+$/.test(values.env)) usage('--env is a wrangler environment name.');
const waitMinutes = Number(values.wait);
const feedbackLimitMs = Number(values['feedback-limit-ms']);
const pricePer1000 = Number(values['price-per-1000']);
const pricePerGb = Number(values['price-per-gb']);
for (const [name, value] of [
  ['wait', waitMinutes],
  ['feedback-limit-ms', feedbackLimitMs],
  ['price-per-1000', pricePer1000],
  ['price-per-gb', pricePerGb],
]) {
  if (!Number.isFinite(value) || value < 0) usage(`--${name} must be a number of at least 0.`);
}

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const API_DIR = join(ROOT, 'workers', 'api');
const WRANGLER = process.env.WRANGLER_BIN ?? join(API_DIR, 'node_modules', '.bin', 'wrangler');
if (!process.env.WRANGLER_BIN && !existsSync(WRANGLER)) {
  usage(`wrangler not found at ${WRANGLER}; run pnpm install or set WRANGLER_BIN.`);
}

/** Runs one or more statements (separated by ';') and returns each one's rows. */
function query(sql) {
  const args = ['d1', 'execute', 'DB', '--json', '--command', sql];
  if (values.local) {
    args.push('--local');
    if (values['persist-to']) args.push('--persist-to', values['persist-to']);
  } else {
    args.push('--remote', '--env', values.env);
  }
  let stdout;
  try {
    stdout = execFileSync(WRANGLER, args, {
      cwd: API_DIR,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    console.error(error.stderr?.toString() ?? error.message);
    usage('wrangler d1 execute failed.');
  }
  const parsed = JSON.parse(stdout.slice(stdout.indexOf('[')));
  for (const result of parsed) if (!result.success) usage(`query failed: ${sql.slice(0, 120)}`);
  return parsed.map((result) => result.results ?? []);
}

const one = (sql) => query(sql)[0][0] ?? {};
const B = `'${broadcastId}'`;

// ---- Wait for the Broadcast to finish ----------------------------------------------------------

const FINISHED = new Set(['sent', 'partially_failed', 'canceled', 'failed']);
const loadBroadcast = () =>
  one(
    `SELECT id, status, recipient_count, sent_count, failed_count, failure_reason, created_at,
            completed_at, snapshot_done, fanout_done, length(html) AS html_bytes, length(text) AS text_bytes,
            length(subject) AS subject_bytes, workspace_id, channel_id
       FROM broadcasts WHERE id = ${B}`,
  );
let broadcast = loadBroadcast();
if (!broadcast.id) usage(`Broadcast ${broadcastId} not found.`);
const deadline = Date.now() + waitMinutes * 60_000;
while (!FINISHED.has(broadcast.status) && Date.now() < deadline) {
  console.error(
    `waiting: ${broadcast.status}, ${broadcast.sent_count}/${broadcast.recipient_count} sent`,
  );
  await new Promise((done) => setTimeout(done, 15_000));
  broadcast = loadBroadcast();
}

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

check(
  'Broadcast finished',
  broadcast.status === 'sent',
  `status ${broadcast.status}${broadcast.failure_reason ? ` (${broadcast.failure_reason})` : ''}`,
);
check(
  'No failed sends',
  broadcast.failed_count === 0,
  `${broadcast.failed_count} failed, ${broadcast.sent_count} sent of ${broadcast.recipient_count}`,
);

// ---- Deliveries ------------------------------------------------------------------------------

const [counts, byMember, byEmail, recipientStatus, mismatched, orphans] = query(
  [
    `SELECT count(*) AS deliveries, coalesce(sum(status = 'failed'), 0) AS failed,
            coalesce(sum(status = 'delivered'), 0) AS delivered, coalesce(sum(status = 'bounced'), 0) AS bounced,
            coalesce(sum(status = 'complained'), 0) AS complained, min(sent_at) AS first_sent, max(sent_at) AS last_sent
       FROM deliveries WHERE broadcast_id = ${B}`,
    `SELECT count(*) AS n FROM (SELECT member_id FROM deliveries WHERE broadcast_id = ${B} AND member_id IS NOT NULL
       GROUP BY member_id HAVING count(*) > 1)`,
    `SELECT count(*) AS n FROM (SELECT lower(email) FROM deliveries WHERE broadcast_id = ${B}
       GROUP BY lower(email) HAVING count(*) > 1)`,
    `SELECT status, held, count(*) AS n FROM broadcast_recipients WHERE broadcast_id = ${B} GROUP BY status, held`,
    `SELECT count(*) AS n FROM broadcast_recipients r WHERE r.broadcast_id = ${B}
        AND (SELECT count(*) FROM deliveries d WHERE d.broadcast_id = r.broadcast_id AND d.member_id = r.member_id) <> 1`,
    `SELECT count(*) AS n FROM deliveries d WHERE d.broadcast_id = ${B}
        AND NOT EXISTS (SELECT 1 FROM broadcast_recipients r WHERE r.broadcast_id = d.broadcast_id AND r.member_id = d.member_id)`,
  ].join(';\n'),
);
const c = counts[0];
const recipients = recipientStatus.reduce((sum, row) => sum + row.n, 0);

check(
  'No duplicate Deliveries per Member',
  byMember[0].n === 0,
  `${byMember[0].n} Members with more than one`,
);
check(
  'No duplicate Deliveries per address',
  byEmail[0].n === 0,
  `${byEmail[0].n} addresses with more than one`,
);
check(
  'Every recipient got exactly one Delivery',
  recipients > 0 && mismatched[0].n === 0,
  `${recipients} recipients, ${c.deliveries} Deliveries, ${mismatched[0].n} recipients without exactly one; by status: ${recipientStatus
    .map((row) => `${row.status}${row.held ? ' (held)' : ''} ${row.n}`)
    .join(', ')}`,
);
check(
  'Every Delivery has a recipient',
  orphans[0].n === 0,
  `${orphans[0].n} Deliveries outside the snapshot`,
);
check(
  'Snapshot matches the recipient count',
  recipients === broadcast.recipient_count,
  `broadcast_recipients ${recipients}, recipient_count ${broadcast.recipient_count}`,
);
check('No failed Deliveries', c.failed === 0, `${c.failed} failed`);

// ---- Feedback: bounce and complaint simulator addresses ------------------------------------------

const feedback = query(
  `SELECT d.email, d.status AS delivery_status, d.sent_at, d.bounced_at, d.complained_at,
          m.status AS member_status, m.updated_at
     FROM deliveries d LEFT JOIN members m ON m.id = d.member_id
    WHERE d.broadcast_id = ${B}
      AND (d.email LIKE 'bounce%@simulator.amazonses.com' OR d.email LIKE 'complaint%@simulator.amazonses.com')`,
)[0];

const percentile = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] : null;

for (const kind of ['bounce', 'complaint']) {
  const want = kind === 'bounce' ? 'bounced' : 'complained';
  const rows = feedback.filter((row) => row.email.toLowerCase().startsWith(kind));
  const changed = rows.filter((row) => row.member_status === want);
  const latencies = changed.map((row) => row.updated_at - row.sent_at).sort((a, b) => a - b);
  const late = latencies.filter((ms) => ms > feedbackLimitMs).length;
  const missing = rows.length - changed.length;
  const examples = rows
    .filter((row) => row.member_status !== want)
    .slice(0, 3)
    .map((row) => `${row.email} is ${row.member_status ?? 'gone'}`);
  check(
    `${kind}@ Members ${want} within ${feedbackLimitMs / 1000} s`,
    rows.length > 0 && missing === 0 && late === 0,
    rows.length
      ? `${rows.length} recipients, ${changed.length} ${want}, ${missing} unchanged, ${late} late; p50 ${percentile(latencies, 0.5)} ms, p95 ${percentile(latencies, 0.95)} ms, max ${latencies.at(-1) ?? null} ms${examples.length ? `; e.g. ${examples.join('; ')}` : ''}`
      : `no ${kind}@ simulator recipients in this Broadcast (seed with --${kind} > 0)`,
  );
}

// ---- Cost ------------------------------------------------------------------------------------

// Messages handed to SES: every Delivery that is not 'failed'. Size estimate: the frozen HTML and
// text plus about 2 KB of headers per message (personalisation changes it only slightly).
const messages = c.deliveries - c.failed;
const approxBytes = broadcast.html_bytes + broadcast.text_bytes + broadcast.subject_bytes + 2048;
const gigabytes = (messages * approxBytes) / 1024 ** 3;
const messageCost = (messages / 1000) * pricePer1000;
const dataCost = gigabytes * pricePerGb;
const durationMs =
  broadcast.completed_at && broadcast.created_at
    ? broadcast.completed_at - broadcast.created_at
    : null;

const failedChecks = results.filter((r) => !r.ok);
console.log(`\nBroadcast ${broadcastId} (Channel ${broadcast.channel_id})`);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}: ${r.detail}`);
console.log('\nSummary');
console.log(
  JSON.stringify(
    {
      pass: failedChecks.length === 0,
      status: broadcast.status,
      recipients,
      deliveries: c.deliveries,
      delivered: c.delivered,
      bounced: c.bounced,
      complained: c.complained,
      startToCompleteSeconds: durationMs === null ? null : Math.round(durationMs / 1000),
      firstToLastSendSeconds:
        c.first_sent && c.last_sent ? Math.round((c.last_sent - c.first_sent) / 1000) : null,
      sesCost: {
        messages,
        pricePer1000,
        messagesUsd: Number(messageCost.toFixed(2)),
        approxBytesPerMessage: approxBytes,
        approxGigabytes: Number(gigabytes.toFixed(3)),
        pricePerGb,
        dataUsd: Number(dataCost.toFixed(2)),
        totalUsd: Number((messageCost + dataCost).toFixed(2)),
        note: 'Estimate at list price; confirm against the AWS bill for the run (Cost Explorer, service SES).',
      },
    },
    null,
    2,
  ),
);
process.exit(failedChecks.length ? 1 : 0);
