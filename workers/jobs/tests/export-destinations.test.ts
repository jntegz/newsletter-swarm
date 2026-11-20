// Incremental exports to the operator's bucket (Phase 7): what a run writes to a fake S3, the
// cursor, retries after a failure, and the notice to admins.
import { env } from 'cloudflare:test';
import { EXPORT_DESTINATION_NOTIFY_AFTER, EXPORT_SETTLE_MS, newId } from '@swarm/domain';
import {
  createDsrRequest,
  eraseAddress,
  openCredentials,
  recordMemberEvent,
  sealCredentials,
  setMemberTracking,
} from '@swarm/engine';
import { parseKeyring } from '@swarm/tokens';
import { describe, expect, it } from 'vitest';
import { encrypt } from '@swarm/vault/testing';
import { runExportDestinations, runPrivacy } from '../src/handlers/privacy';
import { addField, addMember, jobsEnv, one, seedChannel, seedFeedAdmin } from './helpers';

const fieldKeys = parseKeyring(env.TEST_FIELD_KEYS);
const HOUR = 3_600_000;

interface Put {
  method: string;
  url: string;
  body: string;
  authorization: string;
  redirect: RequestInit['redirect'];
}

/** An S3 API that records calls, answering 200 or `fail` with an S3 error. */
function fakeS3(fail: number | null = null) {
  const calls: Put[] = [];
  const fetch = async (input: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    calls.push({
      method: init.method ?? 'GET',
      url: input,
      body: typeof init.body === 'string' ? init.body : '',
      authorization: headers.get('authorization') ?? '',
      redirect: init.redirect,
    });
    if (fail && fail >= 300 && fail < 400) {
      return new Response(null, { status: fail, headers: { location: 'https://10.0.0.2/x' } });
    }
    if (fail) {
      return new Response(
        '<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>',
        { status: fail },
      );
    }
    return new Response(null, { status: 200 });
  };
  return { calls, fetch };
}

const KEYS = {
  accessKeyId: 'AKIDEXAMPLE1234',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

async function seedDestination(
  channel: { workspaceId: string; channelId: string },
  options: {
    schedule?: 'hourly' | 'daily';
    sealed?: string;
    endpoint?: string;
    confirmedBy?: string;
    /** As stored. Omitted, the column default applies (subscribed Members, no fields). */
    scope?: { members: 'active' | 'all'; fields: 'all' | string[] };
  } = {},
) {
  const id = newId('exportDestination');
  // Each destination writes under its own prefix, so a test can pick out its objects.
  const prefix = `swarm/${id.slice(-8)}/`;
  const now = Date.now();
  // A paid plan, and an admin standing behind it: a destination runs only with both.
  await env.DB.prepare("UPDATE workspaces SET plan = 'pro' WHERE id = ?1 AND plan = 'free'")
    .bind(channel.workspaceId)
    .run();
  const admin = options.confirmedBy ?? (await seedFeedAdmin(channel.workspaceId));
  await env.DB.prepare(
    `INSERT INTO export_destinations (id, workspace_id, channel_id, kind, config_json, credentials_enc,
       schedule, created_at, updated_at, created_by, confirmed_by, confirmed_at, scope_json)
     VALUES (?1, ?2, ?3, 'r2', ?4, ?5, ?6, ?7, ?7, ?8, ?8, ?7,
       coalesce(?9, '{"members":"active","fields":[]}'))`,
  )
    .bind(
      id,
      channel.workspaceId,
      channel.channelId,
      JSON.stringify({
        endpoint: options.endpoint ?? 'https://acct.r2.cloudflarestorage.com',
        region: 'auto',
        bucket: 'warehouse',
        prefix,
      }),
      options.sealed ??
        (await sealCredentials(
          fieldKeys,
          { workspaceId: channel.workspaceId, destinationId: id },
          KEYS,
        )),
      options.schedule ?? 'hourly',
      now,
      admin,
      options.scope ? JSON.stringify(options.scope) : null,
    )
    .run();
  return { id, path: `/warehouse/${prefix}`, admin };
}

const later = () => Date.now() + EXPORT_SETTLE_MS + 1000;

describe('export destinations', () => {
  it('writes changed Members, events and deletions as signed JSON Lines objects', async () => {
    const channel = await seedChannel();
    const field = await addField(channel.channelId, 'city', 'text', { encrypted: true });
    const ada = await addMember(
      channel.channelId,
      `ada-${crypto.randomUUID().slice(0, 6)}@example.org`,
      {
        firstName: 'Ada',
      },
    );
    const bo = await addMember(
      channel.channelId,
      `bo-${crypto.randomUUID().slice(0, 6)}@example.org`,
    );
    await env.DB.prepare(
      'INSERT INTO member_field_values (member_id, field_id, value_enc, updated_at) VALUES (?1, ?2, ?3, ?4)',
    )
      .bind(ada, field, await encrypt(fieldKeys, JSON.stringify('Lisbon')), Date.now())
      .run();
    await recordMemberEvent(env.DB, {
      type: 'member_joined',
      memberId: ada,
      payload: { source: 'form', status: 'active' },
    });
    // Everyone with every field: what a destination from before scopes sends (0111).
    const { id, path } = await seedDestination(channel, {
      scope: { members: 'all', fields: 'all' },
    });
    const s3 = fakeS3();
    await runExportDestinations(jobsEnv().env, later(), s3.fetch);

    const mine = (calls: Put[]) => calls.filter((c) => new URL(c.url).pathname.startsWith(path));
    const keys = mine(s3.calls).map((c) => new URL(c.url).pathname);
    expect(keys).toEqual([
      `${path}members/0000000000000-0.jsonl`,
      `${path}events/000000000000.jsonl`,
    ]);
    for (const call of mine(s3.calls)) {
      expect(call.method).toBe('PUT');
      expect(new URL(call.url).origin).toBe('https://acct.r2.cloudflarestorage.com');
      expect(call.authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE1234\/\d{8}\/auto\/s3\/aws4_request/,
      );
      // The secret never travels.
      expect(JSON.stringify(call)).not.toContain('wJalrXUtnFEMI');
    }
    const lines = mine(s3.calls)[0]!
      .body.trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { id: string; fields: Record<string, unknown> });
    // Rows come in updated_at, id order; ids are time-ordered, so sorting them gives that order
    // even when both Members were written in the same millisecond.
    expect(lines.map((l) => l.id)).toEqual([ada, bo].sort());
    expect(lines.find((l) => l.id === ada)?.fields).toEqual({ city: 'Lisbon' });

    const row = await one<{
      status: string;
      cursor_json: string;
      last_run_at: number;
      last_error: string | null;
    }>(
      'SELECT status, cursor_json, last_run_at, last_error FROM export_destinations WHERE id = ?1',
      id,
    );
    expect(row).toMatchObject({ status: 'active', last_error: null });
    const cursor = JSON.parse(row!.cursor_json) as { membersId: string; events: number };
    expect(cursor.membersId).toBe([ada, bo].sort()[1]);
    expect(cursor.events).toBeGreaterThan(0);

    // Not due again within the hour; once due, only what changed is written.
    const again = fakeS3();
    await runExportDestinations(jobsEnv().env, later(), again.fetch);
    expect(mine(again.calls)).toHaveLength(0);
    await env.DB.prepare('UPDATE members SET first_name = ?1, updated_at = ?2 WHERE id = ?3')
      .bind('Bo', Date.now(), bo)
      .run();
    await eraseAddress(env.DB, {
      workspaceId: channel.workspaceId,
      email: (await one<{ email: string }>('SELECT email FROM members WHERE id = ?1', ada))!.email,
      keys: fieldKeys,
    });
    const next = fakeS3();
    await runExportDestinations(jobsEnv().env, later() + HOUR, next.fetch);
    const written = mine(next.calls);
    expect(written.map((c) => new URL(c.url).pathname)).toEqual([
      expect.stringContaining(`${path}members/`),
      `${path}deletions/000000000000.jsonl`,
    ]);
    expect(JSON.parse(written[0]!.body.trim())).toMatchObject({ id: bo, firstName: 'Bo' });
    expect(JSON.parse(written[1]!.body.trim())).toMatchObject({ memberId: ada });
  });

  it('by default sends subscribed Members without profile fields, and only picked fields', async () => {
    const channel = await seedChannel();
    const city = await addField(channel.channelId, 'city', 'text', { encrypted: true });
    const plan = await addField(channel.channelId, 'plan', 'text');
    const active = await addMember(
      channel.channelId,
      `on-${crypto.randomUUID().slice(0, 6)}@example.org`,
      {
        firstName: 'Ines',
      },
    );
    const left = await addMember(
      channel.channelId,
      `off-${crypto.randomUUID().slice(0, 6)}@example.org`,
      {
        status: 'unsubscribed',
        firstName: 'Oskar',
      },
    );
    for (const member of [active, left]) {
      await env.DB.batch([
        env.DB.prepare(
          'INSERT INTO member_field_values (member_id, field_id, value_enc, updated_at) VALUES (?1, ?2, ?3, ?4)',
        ).bind(member, city, await encrypt(fieldKeys, JSON.stringify('Porto')), Date.now()),
        env.DB.prepare(
          'INSERT INTO member_field_values (member_id, field_id, value_text, updated_at) VALUES (?1, ?2, ?3, ?4)',
        ).bind(member, plan, 'gold', Date.now()),
      ]);
      await recordMemberEvent(env.DB, {
        type: 'member_joined',
        memberId: member,
        payload: { source: 'form', status: 'active' },
      });
    }
    const plain = await seedDestination(channel);
    const picked = await seedDestination(channel, {
      scope: { members: 'active', fields: ['plan'] },
    });
    const s3 = fakeS3();
    await runExportDestinations(jobsEnv().env, later(), s3.fetch);
    const objects = (path: string, stream: string) =>
      s3.calls
        .filter((c) => new URL(c.url).pathname.startsWith(`${path}${stream}/`))
        .flatMap((c) => c.body.trim().split('\n'))
        .map((l) => JSON.parse(l) as Record<string, unknown>);

    const lines = objects(plain.path, 'members');
    expect(lines.find((l) => l.id === active)).toMatchObject({ firstName: 'Ines', fields: {} });
    // Someone who left: enough for the copy to drop them, nothing about who they are.
    const reduced = lines.find((l) => l.id === left)!;
    expect(reduced).toMatchObject({ id: left, status: 'unsubscribed', reduced: true });
    expect(reduced).not.toHaveProperty('email');
    expect(reduced).not.toHaveProperty('firstName');
    expect(reduced).not.toHaveProperty('fields');
    const all = JSON.stringify(s3.calls.map((c) => c.body));
    expect(all).not.toContain('Porto');
    expect(all).not.toContain('Oskar');
    // Events only for people who are subscribed.
    expect(objects(plain.path, 'events').map((e) => e.memberId)).toEqual([active]);

    // An explicitly picked field is sent, and only that one.
    expect(objects(picked.path, 'members').find((l) => l.id === active)?.fields).toEqual({
      plan: 'gold',
    });
  });

  it('marks a failing destination, retries it on the next run and emails admins once', async () => {
    const channel = await seedChannel();
    await addMember(channel.channelId, `x-${crypto.randomUUID().slice(0, 6)}@example.org`);
    const operator = newId('operator');
    const adminEmail = `admin-${crypto.randomUUID().slice(0, 6)}@example.com`;
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO operators (id, email, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)',
      ).bind(operator, adminEmail, now),
      env.DB.prepare(
        "INSERT INTO seats (id, workspace_id, operator_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, 'admin', ?4, ?4)",
      ).bind(newId('seat'), channel.workspaceId, operator, now),
    ]);
    const { id } = await seedDestination(channel, { schedule: 'daily' });
    let at = later();
    for (let run = 1; run <= EXPORT_DESTINATION_NOTIFY_AFTER + 1; run++) {
      await runExportDestinations(jobsEnv().env, at, fakeS3(403).fetch);
      at += 25 * HOUR;
    }
    const row = await one<{
      status: string;
      last_error: string;
      failure_count: number;
      cursor_json: string;
    }>(
      'SELECT status, last_error, failure_count, cursor_json FROM export_destinations WHERE id = ?1',
      id,
    );
    expect(row).toMatchObject({
      status: 'failing',
      failure_count: EXPORT_DESTINATION_NOTIFY_AFTER + 1,
      cursor_json: '{}',
    });
    expect(row?.last_error).toContain('AccessDenied');
    const listing = await env.DEV_MAILBOX.list({ prefix: 'mail/', include: ['customMetadata'] });
    const notices = listing.objects.filter(
      (o) =>
        o.customMetadata?.to === adminEmail &&
        o.customMetadata?.category === 'export_destination_failing',
    );
    expect(notices).toHaveLength(1);

    // It recovers on the next good run.
    await runExportDestinations(jobsEnv().env, at, fakeS3().fetch);
    expect(
      await one('SELECT status, failure_count FROM export_destinations WHERE id = ?1', id),
    ).toEqual({ status: 'active', failure_count: 0 });
  });

  it('never follows a redirect with the signed request, and fails the run instead', async () => {
    const channel = await seedChannel();
    await addMember(channel.channelId, `r-${crypto.randomUUID().slice(0, 6)}@example.org`);
    const { id, path } = await seedDestination(channel);
    const s3 = fakeS3(307);
    await runExportDestinations(jobsEnv().env, later(), s3.fetch);
    const mine = s3.calls.filter((c) => new URL(c.url).pathname.startsWith(path));
    expect(mine).toHaveLength(1);
    // A followed redirect would resend the SigV4 headers to wherever the Location points.
    expect(mine[0]?.redirect).toBe('manual');
    const row = await one<{ status: string; last_error: string }>(
      'SELECT status, last_error FROM export_destinations WHERE id = ?1',
      id,
    );
    expect(row?.status).toBe('failing');
    expect(row?.last_error).toMatch(/redirect/i);
  });

  it('checks the endpoint again at run time, not only when it was saved', async () => {
    const channel = await seedChannel();
    await addMember(channel.channelId, `l-${crypto.randomUUID().slice(0, 6)}@example.org`);
    // A row from before the save-time check, or written around it.
    const { id } = await seedDestination(channel, { endpoint: 'https://10.0.0.2' });
    const s3 = fakeS3();
    await runExportDestinations(jobsEnv().env, later(), s3.fetch);
    expect(s3.calls.filter((c) => new URL(c.url).hostname === '10.0.0.2')).toHaveLength(0);
    const row = await one<{ status: string; last_error: string }>(
      'SELECT status, last_error FROM export_destinations WHERE id = ?1',
      id,
    );
    expect(row?.status).toBe('failing');
    expect(row?.last_error).toMatch(/public https endpoint/);
  });

  it('skips paused destinations', async () => {
    const channel = await seedChannel();
    await addMember(channel.channelId, `p-${crypto.randomUUID().slice(0, 6)}@example.org`);
    const { id, path } = await seedDestination(channel);
    await env.DB.prepare("UPDATE export_destinations SET status = 'paused' WHERE id = ?1")
      .bind(id)
      .run();
    const s3 = fakeS3();
    await runExportDestinations(jobsEnv().env, later(), s3.fetch);
    expect(s3.calls.filter((c) => new URL(c.url).pathname.startsWith(path))).toHaveLength(0);
    expect(await one('SELECT last_run_at FROM export_destinations WHERE id = ?1', id)).toEqual({
      last_run_at: null,
    });
  });

  it('signals a tracking objection on the member line, matched by id', async () => {
    const channel = await seedChannel();
    const ada = await addMember(
      channel.channelId,
      `o-${crypto.randomUUID().slice(0, 6)}@example.org`,
    );
    const { path } = await seedDestination(channel);
    await runExportDestinations(jobsEnv().env, later(), fakeS3().fetch);
    await setMemberTracking(env.DB, ada, false, Date.now());
    const next = fakeS3();
    await runExportDestinations(jobsEnv().env, later() + HOUR, next.fetch);
    const line = next.calls.find((c) => new URL(c.url).pathname.startsWith(`${path}members/`));
    expect(JSON.parse(line!.body.trim())).toMatchObject({
      id: ada,
      trackingOptOutAt: expect.any(String),
    });
  });

  it("stops sending a deleted publication's subscribers while it can be restored", async () => {
    const channel = await seedChannel();
    await addMember(channel.channelId, `d-${crypto.randomUUID().slice(0, 6)}@example.org`);
    const { id, path } = await seedDestination(channel);
    await env.DB.prepare('UPDATE channels SET deleted_at = ?1 WHERE id = ?2')
      .bind(Date.now(), channel.channelId)
      .run();
    const s3 = fakeS3();
    await runExportDestinations(jobsEnv().env, later(), s3.fetch);
    expect(s3.calls.filter((c) => new URL(c.url).pathname.startsWith(path))).toHaveLength(0);
    expect(await one('SELECT last_run_at FROM export_destinations WHERE id = ?1', id)).toEqual({
      last_run_at: null,
    });
  });

  it('names destinations that may hold earlier copies on the finished erasure', async () => {
    const channel = await seedChannel();
    const email = `e-${crypto.randomUUID().slice(0, 6)}@example.org`;
    const memberId = await addMember(channel.channelId, email);
    const { path } = await seedDestination(channel);
    await runExportDestinations(jobsEnv().env, later(), fakeS3().fetch);
    const requestId = await createDsrRequest(env.DB, fieldKeys, {
      workspaceId: channel.workspaceId,
      channelId: channel.channelId,
      memberId,
      email,
      kind: 'erase',
      source: 'operator',
      status: 'processing',
    });
    await runPrivacy(jobsEnv().env, Date.now());
    const row = await one<{ status: string; note: string }>(
      'SELECT status, note FROM dsr_requests WHERE id = ?1',
      requestId,
    );
    expect(row!.status).toBe('completed');
    expect(row!.note).toContain(
      `Earlier copies may remain at export destinations: r2 warehouse/${path.slice('/warehouse/'.length)}`,
    );
    expect(row!.note).not.toContain(email);
  });

  it('refuses keys sealed for another destination, and runs on legacy keys the vault opens', async () => {
    const a = await seedChannel();
    const b = await seedChannel();
    await addMember(a.channelId, `k-${crypto.randomUUID().slice(0, 6)}@example.org`);
    await addMember(b.channelId, `k-${crypto.randomUUID().slice(0, 6)}@example.org`);
    // Workspace B's row holding workspace A's sealed keys (a copied value) does not run.
    const source = await seedDestination(a);
    const sealedForA = (await one<{ credentials_enc: string }>(
      'SELECT credentials_enc FROM export_destinations WHERE id = ?1',
      source.id,
    ))!.credentials_enc;
    const copied = await seedDestination(b, { sealed: sealedForA });
    // A value sealed before binding still runs, and comes out bound.
    const legacy = await seedDestination(b, {
      sealed: await encrypt(fieldKeys, JSON.stringify(KEYS)),
    });
    const s3 = fakeS3();
    await runExportDestinations(jobsEnv().env, later(), s3.fetch);
    const wrote = (path: string) =>
      s3.calls.filter((c) => new URL(c.url).pathname.startsWith(path)).length;
    expect(wrote(copied.path)).toBe(0);
    expect(
      await one('SELECT status, last_error FROM export_destinations WHERE id = ?1', copied.id),
    ).toMatchObject({ status: 'failing', last_error: expect.stringContaining('can’t be opened') });
    expect(wrote(legacy.path)).toBeGreaterThan(0);
    // jobs never holds the keys, so it no longer seals them again itself: the vault's re-seal
    // cron moves the value onto the row-bound format (workers/vault tests/reseal.test.ts).
    const kept = (await one<{ credentials_enc: string }>(
      'SELECT credentials_enc FROM export_destinations WHERE id = ?1',
      legacy.id,
    ))!.credentials_enc;
    const owner = { workspaceId: b.workspaceId, destinationId: legacy.id };
    expect(await openCredentials(fieldKeys, owner, kept)).toEqual({ ...KEYS, legacy: true });
  });
});

describe('the authority behind a destination (S04-X-V-feed-survives-authority-end)', () => {
  /** A Channel with a Member and a destination, ready to run; and what a run writes there. */
  async function ready() {
    const channel = await seedChannel();
    await addMember(channel.channelId, `m-${crypto.randomUUID().slice(0, 6)}@example.org`);
    const destination = await seedDestination(channel);
    const run = async () => {
      const s3 = fakeS3();
      await runExportDestinations(jobsEnv().env, later(), s3.fetch);
      return s3.calls.filter((c) => new URL(c.url).pathname.startsWith(destination.path));
    };
    return { channel, destination, run };
  }

  it('runs while the admin who confirmed it keeps the role', async () => {
    const { run } = await ready();
    expect((await run()).length).toBeGreaterThan(0);
  });

  it('stops when that admin’s seat is removed', async () => {
    const { channel, destination, run } = await ready();
    await env.DB.prepare('DELETE FROM seats WHERE workspace_id = ?1 AND operator_id = ?2')
      .bind(channel.workspaceId, destination.admin)
      .run();
    expect(await run()).toEqual([]);
  });

  it('stops when that admin is demoted below admin, and runs again once an admin adopts it', async () => {
    const { channel, destination, run } = await ready();
    await env.DB.prepare(
      "UPDATE seats SET role = 'editor' WHERE workspace_id = ?1 AND operator_id = ?2",
    )
      .bind(channel.workspaceId, destination.admin)
      .run();
    expect(await run()).toEqual([]);
    const row = await one<{ status: string }>(
      'SELECT status FROM export_destinations WHERE id = ?1',
      destination.id,
    );
    // Suspended, not deleted or failed: its settings and cursor are kept.
    expect(row?.status).toBe('active');
    const adopter = await seedFeedAdmin(channel.workspaceId);
    await env.DB.prepare(
      'UPDATE export_destinations SET confirmed_by = ?1, confirmed_at = ?2 WHERE id = ?3',
    )
      .bind(adopter, Date.now(), destination.id)
      .run();
    expect((await run()).length).toBeGreaterThan(0);
  });

  it('stops when the Channel is deleted', async () => {
    const { channel, run } = await ready();
    await env.DB.prepare('UPDATE channels SET deleted_at = ?1 WHERE id = ?2')
      .bind(Date.now(), channel.channelId)
      .run();
    expect(await run()).toEqual([]);
  });

  it('stops when the workspace moves to a plan without destinations', async () => {
    const { channel, run } = await ready();
    await env.DB.prepare("UPDATE workspaces SET plan = 'free' WHERE id = ?1")
      .bind(channel.workspaceId)
      .run();
    expect(await run()).toEqual([]);
  });

  it('a destination no admin confirmed sends nothing, not even the existing Members', async () => {
    const { destination, run } = await ready();
    await env.DB.prepare(
      'UPDATE export_destinations SET confirmed_by = NULL, confirmed_at = NULL WHERE id = ?1',
    )
      .bind(destination.id)
      .run();
    expect(await run()).toEqual([]);
  });
});
