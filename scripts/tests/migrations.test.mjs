import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  LOCK_FILE,
  checksum,
  parseLock,
  readMigrations,
  verifyMigrations,
} from '../lib/migrations.mjs';

describe('migrations', () => {
  const { files, read } = readMigrations();

  it('are forward-only: every applied migration matches migrations/SHA256SUMS', () => {
    const lock = parseLock(readFileSync(LOCK_FILE, 'utf8'));
    const { problems, unlocked } = verifyMigrations({ files, read, lock });
    assert.deepEqual(problems, []);
    assert.deepEqual(unlocked, [], 'record new migrations with `pnpm migrations:lock`');
  });

  it('apply cleanly, in order, to an empty database', () => {
    // The D1 run of the same files is workers/api/tests/schema.test.ts; this one names the file
    // that fails.
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const name of files) {
      assert.doesNotThrow(() => db.exec(read(name)), name);
    }
    const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get();
    assert.ok(tables.n > 0);
    db.close();
  });
});

describe('0069_review_fixes', () => {
  const { files, read } = readMigrations();
  const before = files.filter((name) => name < '0069_review_fixes.sql');
  const from0069 = files.filter((name) => name >= '0069_review_fixes.sql');

  /** The schema just before 0069, the rows an install could have then, and 0069 on top. */
  function upgrade(seed) {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const name of before) db.exec(read(name));
    seed(db);
    for (const name of from0069) db.exec(read(name));
    return db;
  }
  const run = (db, sql, ...params) => db.prepare(sql).run(...params);
  const operator = (db, id) =>
    run(
      db,
      'INSERT INTO operators (id, email, created_at, updated_at) VALUES (?, ?, 0, 0)',
      id,
      `${id}@example.com`,
    );
  /** A workspace made by `creator` (its workspace.created audit entry names them). */
  const workspace = (db, id, creator) => {
    run(
      db,
      'INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, 0, 0)',
      id,
      id,
    );
    run(
      db,
      `INSERT INTO audit_events (id, workspace_id, seq, actor_operator_id, action, target_type, target_id, created_at, prev_hash, hash)
       VALUES (?, ?, 1, ?, 'workspace.created', 'workspace', ?, 0, '', 'h')`,
      `ae_${id}`,
      id,
      creator,
      id,
    );
  };
  const seat = (db, workspaceId, operatorId, role, at = 0) =>
    run(
      db,
      'INSERT INTO seats (id, workspace_id, operator_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      `st_${workspaceId}_${operatorId}`,
      workspaceId,
      operatorId,
      role,
      at,
      at,
    );
  const grants = (db, table) =>
    db
      .prepare(`SELECT workspace_id, allowed_by FROM ${table} ORDER BY workspace_id`)
      .all()
      .map((r) => ({ ...r }));

  it('allows the workspaces an instance admin made and still owns, and no other', () => {
    const db = upgrade((db) => {
      for (const id of ['op_admin', 'op_tenant']) operator(db, id);
      run(db, 'INSERT INTO instance_admins (operator_id, created_at) VALUES (?, 0)', 'op_admin');
      // The install owner's own workspace.
      workspace(db, 'ws_own', 'op_admin');
      seat(db, 'ws_own', 'op_admin', 'owner');
      // A tenant invited the install owner as a viewer and promoted them to owner, then stepped
      // down, so the instance admin's seat is the only (and so the earliest) owner seat.
      workspace(db, 'ws_tenant', 'op_tenant');
      seat(db, 'ws_tenant', 'op_tenant', 'admin', 0);
      seat(db, 'ws_tenant', 'op_admin', 'owner', 10);
      // Made by the instance admin, but they are no longer an owner there.
      workspace(db, 'ws_left', 'op_admin');
      seat(db, 'ws_left', 'op_admin', 'editor');
      seat(db, 'ws_left', 'op_tenant', 'owner', 10);
    });
    const expected = [{ workspace_id: 'ws_own', allowed_by: 'op_admin' }];
    assert.deepEqual(grants(db, 'site_code_workspaces'), expected);
    assert.deepEqual(grants(db, 'email_check_workspaces'), expected);
    db.close();
  });

  it('allows the workspaces someone made when they are made an instance admin later', () => {
    const db = upgrade((db) => {
      for (const id of ['op_new', 'op_tenant']) operator(db, id);
    });
    workspace(db, 'ws_mine', 'op_new');
    seat(db, 'ws_mine', 'op_new', 'owner');
    workspace(db, 'ws_theirs', 'op_tenant');
    seat(db, 'ws_theirs', 'op_tenant', 'owner');
    seat(db, 'ws_theirs', 'op_new', 'owner', 10);
    run(db, 'INSERT INTO instance_admins (operator_id, created_at) VALUES (?, 5)', 'op_new');
    const expected = [{ workspace_id: 'ws_mine', allowed_by: 'op_new' }];
    assert.deepEqual(grants(db, 'site_code_workspaces'), expected);
    assert.deepEqual(grants(db, 'email_check_workspaces'), expected);
    // Being made an owner of a tenant's workspace afterwards allows nothing either.
    workspace(db, 'ws_later', 'op_tenant');
    seat(db, 'ws_later', 'op_tenant', 'owner');
    seat(db, 'ws_later', 'op_new', 'owner', 10);
    assert.deepEqual(grants(db, 'site_code_workspaces'), expected);
    assert.deepEqual(grants(db, 'email_check_workspaces'), expected);
    db.close();
  });

  it('records who paused each paused warm-up, from the words a person pause wrote', () => {
    const db = upgrade((db) => {
      operator(db, 'op_a');
      workspace(db, 'ws_a', 'op_a');
      run(
        db,
        "INSERT INTO channels (id, workspace_id, slug, name, created_at, updated_at) VALUES ('ch_a', 'ws_a', 'pub-a', 'A', 0, 0)",
      );
      const ramp = (id, status, reason, domain) => {
        if (domain) {
          run(
            db,
            `INSERT INTO sending_domains (id, workspace_id, channel_id, domain, kind, status, created_at, updated_at)
             VALUES (?, 'ws_a', 'ch_a', ?, 'email', 'verified', 0, 0)`,
            domain,
            `${domain}.example.com`,
          );
        }
        run(
          db,
          `INSERT INTO reputation_ramps (id, channel_id, sending_domain_id, status, day, cap_today, start_cap, growth,
             max_cap, bounce_threshold, complaint_threshold, paused_reason, created_at, updated_at)
           VALUES (?, 'ch_a', ?, ?, '2026-11-01', 100, 100, 1.3, 5000, 0.02, 0.0008, ?, 0, 0)`,
          id,
          domain,
          status,
          reason,
        );
      };
      ramp('rr_teammate', 'paused', 'Paused by a teammate.', null);
      ramp('rr_operator', 'paused', 'Paused by an operator.', 'sd_1');
      ramp('rr_spike', 'paused', 'Bounce rate 3.0% is over the 2.0% limit.', 'sd_2');
      ramp('rr_null', 'paused', null, 'sd_3');
      ramp('rr_warming', 'warming', null, 'sd_4');
    });
    const rows = db
      .prepare('SELECT id, paused_by FROM reputation_ramps ORDER BY id')
      .all()
      .map((r) => ({ ...r }));
    assert.deepEqual(rows, [
      { id: 'rr_null', paused_by: 'system' },
      { id: 'rr_operator', paused_by: 'person' },
      { id: 'rr_spike', paused_by: 'system' },
      { id: 'rr_teammate', paused_by: 'person' },
      { id: 'rr_warming', paused_by: null },
    ]);
    db.close();
  });

  it('gives a bounce state its own last bounce back where a block overwrote it', () => {
    const db = upgrade((db) => {
      operator(db, 'op_a');
      workspace(db, 'ws_a', 'op_a');
      const event = (email, kind, cause, at) =>
        run(
          db,
          `INSERT INTO bounce_events (workspace_id, email, send_id, kind, cause, detail, created_at)
           VALUES ('ws_a', ?, ?, ?, ?, ?, ?)`,
          email,
          `dl_${email}_${at}`,
          kind,
          cause,
          `${cause} said`,
          at,
        );
      const state = (email) =>
        run(
          db,
          `INSERT INTO bounce_states (id, workspace_id, email, soft_streak, last_kind, last_cause, last_detail,
             last_bounced_at, held_at, held_rule, created_at, updated_at)
           VALUES (?, 'ws_a', ?, 3, 'blocked', 'blocklist', 'blocklist said', 30, 25, 'soft_streak', 0, 30)`,
          `bn_${email}`,
          email,
        );
      event('held@example.com', 'soft', 'temporary', 10);
      event('held@example.com', 'soft', 'mailbox_full', 20);
      event('held@example.com', 'blocked', 'blocklist', 30);
      state('held@example.com');
      event('blocks@example.com', 'blocked', 'blocklist', 30);
      state('blocks@example.com');
    });
    const rows = db
      .prepare(
        'SELECT email, last_kind, last_cause, last_detail, last_bounced_at FROM bounce_states ORDER BY email',
      )
      .all()
      .map((r) => ({ ...r }));
    assert.deepEqual(rows, [
      {
        email: 'blocks@example.com',
        last_kind: 'blocked',
        last_cause: 'blocklist',
        last_detail: 'blocklist said',
        last_bounced_at: 30,
      },
      {
        email: 'held@example.com',
        last_kind: 'soft',
        last_cause: 'mailbox_full',
        last_detail: 'mailbox_full said',
        last_bounced_at: 20,
      },
    ]);
    db.close();
  });
});

describe('verifyMigrations', () => {
  const contents = { '0001_a.sql': 'one', '0002_b.sql': 'two', '0003_c.sql': 'three' };
  const read = (name) => contents[name];
  const lock = [
    { name: '0001_a.sql', sha256: checksum('one') },
    { name: '0002_b.sql', sha256: checksum('two') },
  ];

  it('allows a new migration after the recorded ones and reports it as unlocked', () => {
    const files = Object.keys(contents);
    assert.deepEqual(verifyMigrations({ files, read, lock }), {
      problems: [],
      unlocked: ['0003_c.sql'],
    });
  });

  it('rejects an edited, removed or out-of-order migration', () => {
    const edited = (name) => (name === '0002_b.sql' ? 'two, changed' : contents[name]);
    assert.deepEqual(
      verifyMigrations({ files: ['0001_a.sql', '0002_b.sql'], read: edited, lock }).problems,
      ['0002_b.sql: applied migration was edited; add a new migration instead'],
    );
    assert.deepEqual(verifyMigrations({ files: ['0001_a.sql'], read, lock }).problems, [
      '0002_b.sql: applied migration was removed or renamed',
    ]);
    const late = [{ name: '0002_b.sql', sha256: checksum('two') }];
    assert.deepEqual(
      verifyMigrations({ files: ['0001_a.sql', '0002_b.sql'], read, lock: late }).problems,
      ['0001_a.sql: new migration sorts before 0002_b.sql'],
    );
  });

  it('allows gaps but rejects a shared number and bad names', () => {
    const files = ['0001_a.sql', '0003_c.sql', '0003_d.sql', 'x.sql'];
    assert.deepEqual(verifyMigrations({ files, read, lock: [] }).problems, [
      '0003_d.sql: number 0003 is taken',
      'x.sql: name must be NNNN_lower_snake.sql',
    ]);
  });
});
