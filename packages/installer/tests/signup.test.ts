// The sign-up gate against the real schema: every migration, on SQLite, so ON CONFLICT and the
// NULL owner of the early row behave as they do on D1.
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { DatabaseSync as Database } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { D1Executor, Row, Statement } from '../src/d1';
import { bootstrapOwner, closeSignup } from '../src/steps/bootstrap';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof Database;
};
const MIGRATIONS = fileURLToPath(new URL('../../../migrations/', import.meta.url));

function executor(sqlite: Database): D1Executor {
  return {
    run: async (statements: Statement[]) =>
      statements.map(({ sql, params }) => {
        const prepared = sqlite.prepare(sql);
        const values = params as (string | number | null)[];
        if (/^\s*SELECT|\bRETURNING\b/i.test(sql)) {
          return { results: prepared.all(...values) as Row[], changes: 0 };
        }
        return { results: [], changes: Number(prepared.run(...values).changes) };
      }),
  };
}

const owner = {
  email: 'ada@example.com',
  name: 'Ada',
  workspaceName: 'Letter',
  publication: { name: 'Letter', slug: 'letter' },
};

describe('sign-up during an install', () => {
  let sqlite: Database;
  let db: D1Executor;
  const signup = () =>
    sqlite.prepare("SELECT value, updated_by FROM instance_settings WHERE key = 'signup'").get() as
      { value: string; updated_by: string | null } | undefined;

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:');
    for (const file of (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort()) {
      sqlite.exec(await readFile(`${MIGRATIONS}${file}`, 'utf8'));
    }
    db = executor(sqlite);
  });

  it('is closed from before the deploy, and the owner then claims the setting', async () => {
    expect(signup()).toBeUndefined();
    await closeSignup(db);
    expect(signup()).toEqual({ value: 'invite_only', updated_by: null });

    const result = await bootstrapOwner(db, owner);
    expect(result.inviteOnly).toBe('set');
    expect(signup()).toEqual({ value: 'invite_only', updated_by: result.operatorId });
  });

  it('survives a run that stopped before the owner existed', async () => {
    await closeSignup(db);
    await closeSignup(db);
    expect(signup()).toEqual({ value: 'invite_only', updated_by: null });
    expect((await bootstrapOwner(db, owner)).inviteOnly).toBe('set');
  });

  it('changes nothing on a re-run', async () => {
    await closeSignup(db);
    const { operatorId } = await bootstrapOwner(db, owner);
    await closeSignup(db);
    expect((await bootstrapOwner(db, owner)).inviteOnly).toBe('kept');
    expect(signup()).toEqual({ value: 'invite_only', updated_by: operatorId });
  });

  it('stays open when the owner chose open', async () => {
    await closeSignup(db);
    const { operatorId } = await bootstrapOwner(db, owner);
    sqlite.prepare("UPDATE instance_settings SET value = 'open' WHERE key = 'signup'").run();

    await closeSignup(db);
    expect((await bootstrapOwner(db, owner)).inviteOnly).toBe('kept');
    expect(signup()).toEqual({ value: 'open', updated_by: operatorId });
  });

  it('allows the owner’s own workspace the install’s domain and DeBounce, by explicit rows', async () => {
    const grants = (table: string) =>
      sqlite.prepare(`SELECT workspace_id, allowed_by FROM ${table}`).all() as {
        workspace_id: string;
        allowed_by: string;
      }[];
    const first = await bootstrapOwner(db, owner);
    for (const table of ['site_code_workspaces', 'email_check_workspaces']) {
      expect(grants(table)).toEqual([
        { workspace_id: first.workspaceId, allowed_by: first.operatorId },
      ]);
    }
    // The owner is an instance admin already but lost their owner seat: the installer makes them
    // a new workspace, and allows it itself (no new instance_admins row, so no trigger).
    sqlite.exec(
      'DELETE FROM seats; DELETE FROM site_code_workspaces; DELETE FROM email_check_workspaces',
    );
    const again = await bootstrapOwner(db, owner);
    expect(again).toMatchObject({ operatorId: first.operatorId, createdWorkspace: true });
    for (const table of ['site_code_workspaces', 'email_check_workspaces']) {
      expect(grants(table)).toEqual([
        { workspace_id: again.workspaceId, allowed_by: again.operatorId },
      ]);
    }
    // An instance admin removed the grant on purpose: a re-run does not bring it back.
    sqlite.prepare('DELETE FROM site_code_workspaces').run();
    expect((await bootstrapOwner(db, owner)).createdWorkspace).toBe(false);
    expect(grants('site_code_workspaces')).toEqual([]);
  });

  it('stays open even when whoever chose it is gone', async () => {
    sqlite
      .prepare(
        "INSERT INTO instance_settings (key, value, updated_by, updated_at) VALUES ('signup', 'open', NULL, 1)",
      )
      .run();
    await closeSignup(db);
    expect((await bootstrapOwner(db, owner)).inviteOnly).toBe('kept');
    expect(signup()?.value).toBe('open');
  });
});
