// Rosters (Phase 8, flag rosters; docs/rosters.md) in imports and exports: Roster name columns
// join live Rosters without re-adding anyone who left one; exports list each Member's Rosters
// and can be limited to one Roster. Joining and leaving a Roster start Flows.
import { env } from 'cloudflare:test';
import { FlowGraphSchema, newId, type ImportReport } from '@swarm/domain';
import { applyRosterChanges, enrollFromEvents, parseCsv } from '@swarm/engine';
import { beforeEach, describe, expect, it } from 'vitest';
import { runExport } from '../src/handlers/exports';
import { analyzeImport, runImport } from '../src/handlers/imports';
import { harness, makeTag, publishFlow } from './flows-helpers';
import { addMember, count, jobsEnv, one, seedChannel, seedFeedAdmin, seedImport } from './helpers';

let seed: { workspaceId: string; channelId: string };
let deals: string;
let events: string;

async function rosterRows(email: string) {
  const { results } = await env.DB.prepare(
    `SELECT r.name, rm.status, rm.source FROM roster_members rm
       JOIN rosters r ON r.id = rm.roster_id JOIN members m ON m.id = rm.member_id
      WHERE m.channel_id = ?1 AND m.email = ?2 ORDER BY r.name`,
  )
    .bind(seed.channelId, email)
    .all<{ name: string; status: string; source: string }>();
  return results.map((r) => [r.name, r.status, r.source]);
}

beforeEach(async () => {
  seed = await seedChannel();
  deals = newId('roster');
  events = newId('roster');
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO rosters (id, channel_id, name, created_at, updated_at)
     VALUES (?1, ?3, 'Deals', ?4, ?4), (?2, ?3, 'Events', ?4, ?4)`,
  )
    .bind(deals, events, seed.channelId, now)
    .run();
});

describe('importing Roster names', () => {
  const csv = [
    'Email,Lists',
    'new@example.com,deals; Events; Unknown', // new: joins both, ignores the unknown name
    'current@example.com,Events', // existing: joins Events
    'left@example.com,Deals', // existing, left Deals themselves: unchanged
    '',
  ].join('\r\n');

  it('joins new and existing Members, never someone who left', async () => {
    await addMember(seed.channelId, 'current@example.com');
    const left = await addMember(seed.channelId, 'left@example.com');
    await env.DB.prepare(
      `INSERT INTO roster_members (roster_id, member_id, status, source, unsubscribed_at, created_at, updated_at)
       VALUES (?1, ?2, 'unsubscribed', 'member', 1, 1, 1)`,
    )
      .bind(deals, left)
      .run();
    const map = { Email: 'email' as const, Lists: 'rosters' as const };
    const { env: jobs } = jobsEnv();

    const dry = await seedImport(seed, csv, ['Email', 'Lists'], map, { update: true });
    await analyzeImport(jobs, dry);
    const report = JSON.parse(
      (await one<{ report_json: string }>(
        'SELECT report_json FROM import_jobs WHERE id = ?1',
        dry,
      ))!.report_json,
    ) as ImportReport;
    expect(report.counts).toMatchObject({ new: 1, updated: 1, unchanged: 1 });

    const jobId = await seedImport(seed, csv, ['Email', 'Lists'], map, {
      update: true,
      consent: true,
      status: 'importing',
    });
    await runImport(jobs, jobId);
    expect(await rosterRows('new@example.com')).toEqual([
      ['Deals', 'subscribed', 'import'],
      ['Events', 'subscribed', 'import'],
    ]);
    expect(await rosterRows('current@example.com')).toEqual([['Events', 'subscribed', 'import']]);
    expect(await rosterRows('left@example.com')).toEqual([['Deals', 'unsubscribed', 'member']]);
    // Each join is a roster_joined event (the roster.subscribed webhook), the skipped row none.
    const joined = await env.DB.prepare(
      `SELECT m.email, json_extract(e.payload_json, '$.source') AS source FROM member_events e
         JOIN members m ON m.id = e.member_id
        WHERE e.channel_id = ?1 AND e.type IN ('roster_joined', 'roster_left') ORDER BY m.email`,
    )
      .bind(seed.channelId)
      .all<{ email: string; source: string }>();
    expect(joined.results.map((r) => [r.email, r.source])).toEqual([
      ['current@example.com', 'import'],
      ['new@example.com', 'import'],
      ['new@example.com', 'import'],
    ]);
  });
});

describe('exporting Rosters', () => {
  async function exportJob(filter: Record<string, unknown>) {
    const id = newId('exportJob');
    // Asked for by an admin of the workspace: an export runs only while one stands behind it.
    const by = await seedFeedAdmin(seed.workspaceId);
    await env.DB.prepare(
      `INSERT INTO export_jobs (id, workspace_id, channel_id, format, filter_json, created_by, created_at)
       VALUES (?1, ?2, ?3, 'csv', ?4, ?5, ?6)`,
    )
      .bind(id, seed.workspaceId, seed.channelId, JSON.stringify(filter), by, Date.now())
      .run();
    return id;
  }

  async function rows(jobId: string) {
    const { env: jobs } = jobsEnv();
    await runExport(jobs, jobId);
    const { r2_key } = (await one<{ r2_key: string }>(
      'SELECT r2_key FROM export_jobs WHERE id = ?1',
      jobId,
    ))!;
    let text = '';
    const listed = await env.EXPORTS.list({ prefix: r2_key });
    for (const key of listed.objects.map((o) => o.key).sort()) {
      text += await (await env.EXPORTS.get(key))!.text();
    }
    return parseCsv(text);
  }

  it('adds a rosters column when the flag was on, and filters by Roster', async () => {
    const a = await addMember(seed.channelId, 'a@example.com');
    await addMember(seed.channelId, 'b@example.com');
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO roster_members (roster_id, member_id, status, source, created_at, updated_at)
       VALUES (?1, ?3, 'subscribed', 'operator', ?4, ?4), (?2, ?3, 'subscribed', 'operator', ?4, ?4)`,
    )
      .bind(deals, events, a, now)
      .run();

    const all = await rows(await exportJob({ rosters: true }));
    const header = all[0]!;
    const column = header.indexOf('rosters');
    expect(column).toBeGreaterThan(header.indexOf('ref'));
    const byEmail = new Map(all.slice(1).map((r) => [r[1], r[column]]));
    expect(byEmail.get('a@example.com')).toBe('Deals; Events');
    expect(byEmail.get('b@example.com')).toBe('');

    const one_ = await rows(await exportJob({ rosters: true, rosterId: deals }));
    expect(one_.slice(1).map((r) => r[1])).toEqual(['a@example.com']);

    // Without the marker the file is exactly as before.
    expect((await rows(await exportJob({})))[0]).not.toContain('rosters');
  });
});

describe('Roster Flow triggers', () => {
  it('enrols on joining or leaving the chosen Roster only', async () => {
    const tagId = await makeTag(seed.channelId);
    const flowFor = (event: 'roster_joined' | 'roster_left', rosterId: string) =>
      publishFlow(
        seed,
        FlowGraphSchema.parse({
          schema: 1,
          nodes: [
            { id: 'trigger', type: 'trigger', config: { event, rosterId } },
            { id: 'tag', type: 'add_tag', config: { tagId } },
          ],
          edges: [{ from: 'trigger', to: 'tag' }],
        }),
        { name: event },
      );
    const joinedDeals = await flowFor('roster_joined', deals);
    const leftDeals = await flowFor('roster_left', deals);
    const joinedEvents = await flowFor('roster_joined', events);
    const member = await addMember(seed.channelId, 'flow@example.com');
    const h = harness();
    const runs = (flowId: string) =>
      count(
        'SELECT count(*) AS n FROM flow_runs WHERE flow_id = ?1 AND member_id = ?2',
        flowId,
        member,
      );

    await applyRosterChanges(env.DB, [
      { rosterId: deals, memberId: member, status: 'subscribed', source: 'member' },
    ]);
    await enrollFromEvents(h.env, h.clock.now);
    expect([await runs(joinedDeals.flowId), await runs(leftDeals.flowId)]).toEqual([1, 0]);
    expect(await runs(joinedEvents.flowId)).toBe(0);

    await applyRosterChanges(env.DB, [
      { rosterId: deals, memberId: member, status: 'unsubscribed', source: 'unsubscribe' },
    ]);
    await enrollFromEvents(h.env, h.clock.now);
    expect(await runs(leftDeals.flowId)).toBe(1);
  });
});
