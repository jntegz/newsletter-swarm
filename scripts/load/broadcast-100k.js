// Phase 2 exit gate: one Broadcast to the seeded simulator audience, driven through the public
// API (/v2) the way an integration would. See docs/load-testing.md.
//
//   k6 run scripts/load/broadcast-100k.js \
//     -e API_ORIGIN=https://api.staging.swarm.example -e API_KEY=sk_live_… -e CHANNEL_ID=ch_… \
//     [-e EXPECTED_RECIPIENTS=100000] [-e SENDER_IDENTITY_ID=si_…] [-e CIRCLE_ID=cl_…] \
//     [-e READ_RATE=20] [-e READ_MINUTES=30] [-e MAX_MINUTES=180]
//
// Flow (all /v2, Bearer API key with dispatches:read, dispatches:write and broadcasts:read):
// 1. setup: GET the Channel, POST a draft Dispatch, PATCH its sender and audience when given,
//    POST /schedule a minute ahead (the API has no "send now"; the schedule runs the same
//    pre-send checklist and answers 409 with the failing checks), then poll the Dispatch until
//    the send worker's cron has started its Broadcast (latestBroadcastId).
// 2. watch (1 VU): polls the Broadcast until it finishes, recording progress and throughput.
// 3. readers (optional, READ_RATE a minute for READ_MINUTES): the Broadcast's stats while it
//    sends, as a dashboard would. Keep watch (6 a minute) + readers under the plan's /v2 rate
//    (60 a minute on Free).
// Channels are created in the dashboard (cookie session), not over /v2, so CHANNEL_ID is required.
/* global __ENV */ // k6 injects -e values here.
import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Counter, Gauge, Trend } from 'k6/metrics';

const ORIGIN = (__ENV.API_ORIGIN || '').replace(/\/$/, '');
const KEY = __ENV.API_KEY || '';
const CHANNEL = __ENV.CHANNEL_ID || '';
const EXPECTED = Number(__ENV.EXPECTED_RECIPIENTS || '100000');
const SENDER = __ENV.SENDER_IDENTITY_ID || '';
const CIRCLE = __ENV.CIRCLE_ID || '';
const READ_RATE = Number(__ENV.READ_RATE || '0');
const READ_MINUTES = Number(__ENV.READ_MINUTES || '30');
const MAX_MINUTES = Number(__ENV.MAX_MINUTES || '180');
const POLL_SECONDS = 10;

const sendSeconds = new Trend('broadcast_send_seconds');
const sendRate = new Gauge('broadcast_messages_per_second');
const sentCount = new Gauge('broadcast_sent_count');
const failedCount = new Gauge('broadcast_failed_count');
const apiErrors = new Counter('api_errors');

export const options = {
  setupTimeout: '15m',
  scenarios: {
    watch: {
      executor: 'per-vu-iterations',
      exec: 'watch',
      vus: 1,
      iterations: 1,
      maxDuration: `${MAX_MINUTES}m`,
    },
    ...(READ_RATE > 0
      ? {
          readers: {
            executor: 'constant-arrival-rate',
            exec: 'readStats',
            rate: READ_RATE,
            timeUnit: '1m',
            duration: `${Math.min(READ_MINUTES, MAX_MINUTES)}m`,
            preAllocatedVUs: 2,
          },
        }
      : {}),
  },
  thresholds: {
    // The gate: everything sent, nothing failed, no API errors along the way.
    broadcast_failed_count: ['value==0'],
    api_errors: ['count==0'],
    checks: ['rate==1'],
  },
};

const headers = (extra) =>
  Object.assign(
    { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    extra || {},
  );

/** One /v2 call; returns `data` from the envelope, or fails the run on an unexpected status. */
function api(method, path, body, expected, extra) {
  const res = http.request(
    method,
    `${ORIGIN}${path}`,
    body === undefined ? null : JSON.stringify(body),
    {
      headers: headers(extra),
      tags: { name: `${method} ${path.replace(/\/(ch|dp|bc|si|cl)_[0-9a-f]{32}/g, '/$1_…')}` },
    },
  );
  if (res.status === 429) {
    // Over the plan's rate: wait as told and try once more.
    sleep(Number(res.headers['Retry-After'] || '5'));
    return api(method, path, body, expected, extra);
  }
  if (res.status !== expected) {
    apiErrors.add(1);
    fail(`${method} ${path} answered ${res.status}: ${res.body}`);
  }
  return res.json('data');
}

export function setup() {
  if (!ORIGIN || !/^sk_live_/.test(KEY) || !/^ch_[0-9a-f]{32}$/.test(CHANNEL)) {
    fail('Set API_ORIGIN, API_KEY (sk_live_…) and CHANNEL_ID (ch_…).');
  }
  const channel = api('GET', `/v2/channels/${CHANNEL}`, undefined, 200);
  const stamp = new Date().toISOString();
  const dispatch = api(
    'POST',
    `/v2/channels/${CHANNEL}/dispatches`,
    {
      subject: `Load test ${stamp}`,
      preheader: 'Phase 2 exit gate',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Hello {{ first_name | there }},' }],
          },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: `This is a load test of ${channel.name} at ${stamp}.` },
            ],
          },
        ],
      },
    },
    201,
    { 'idempotency-key': `load-${CHANNEL}-${stamp}` },
  );
  const patch = {};
  if (SENDER) patch.senderIdentityId = SENDER;
  if (CIRCLE) patch.audience = { include: [CIRCLE], exclude: [] };
  if (Object.keys(patch).length) {
    api('PATCH', `/v2/channels/${CHANNEL}/dispatches/${dispatch.id}`, patch, 200);
  }
  // A minute is the API's minimum; the send worker's every-minute cron starts it after that.
  const publishAt = new Date(Date.now() + 75_000).toISOString();
  api('POST', `/v2/channels/${CHANNEL}/dispatches/${dispatch.id}/schedule`, { publishAt }, 200);
  console.log(`Dispatch ${dispatch.id} scheduled for ${publishAt}`);

  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    const current = api('GET', `/v2/channels/${CHANNEL}/dispatches/${dispatch.id}`, undefined, 200);
    if (current.latestBroadcastId) {
      console.log(`Broadcast ${current.latestBroadcastId} started (Dispatch ${current.status})`);
      return {
        dispatchId: dispatch.id,
        broadcastId: current.latestBroadcastId,
        startedAt: Date.now(),
      };
    }
    if (current.status === 'draft') {
      fail('The Dispatch went back to draft: the pre-send checklist failed when its time came.');
    }
    sleep(POLL_SECONDS);
  }
  return fail(
    'No Broadcast started within 12 minutes of scheduling. Is the send worker cron running?',
  );
}

const FINISHED = ['sent', 'partially_failed', 'canceled', 'failed'];

export function watch(data) {
  const path = `/v2/channels/${CHANNEL}/broadcasts/${data.broadcastId}`;
  let broadcast = api('GET', path, undefined, 200);
  let last = { at: Date.now(), sent: broadcast.sentCount };
  while (FINISHED.indexOf(broadcast.status) === -1) {
    sleep(POLL_SECONDS);
    broadcast = api('GET', path, undefined, 200);
    const now = Date.now();
    const rate = (broadcast.sentCount - last.sent) / ((now - last.at) / 1000);
    sendRate.add(rate);
    sentCount.add(broadcast.sentCount);
    console.log(
      `${broadcast.status}: ${broadcast.sentCount}/${broadcast.recipientCount} sent, ${broadcast.failedCount} failed, ${rate.toFixed(1)}/s`,
    );
    last = { at: now, sent: broadcast.sentCount };
  }
  const started = Date.parse(broadcast.createdAt);
  const completed = broadcast.completedAt ? Date.parse(broadcast.completedAt) : Date.now();
  sendSeconds.add((completed - started) / 1000);
  sentCount.add(broadcast.sentCount);
  failedCount.add(broadcast.failedCount);
  check(broadcast, {
    'Broadcast finished as sent': (b) => b.status === 'sent',
    'every recipient was sent to': (b) => b.sentCount === b.recipientCount,
    'no failed sends': (b) => b.failedCount === 0,
    [`at least ${EXPECTED} recipients`]: (b) => b.recipientCount >= EXPECTED,
  });
  console.log(
    `Done: ${broadcast.id} ${broadcast.status}, ${broadcast.sentCount} sent, ${broadcast.failedCount} failed, ${Math.round((completed - started) / 1000)} s. Now run: node scripts/load/check-broadcast.mjs --broadcast ${broadcast.id} --wait 5`,
  );
}

export function readStats(data) {
  api('GET', `/v2/channels/${CHANNEL}/broadcasts/${data.broadcastId}/stats`, undefined, 200);
}
