// Migrations are forward-only: once a file in migrations/ is committed it may have been applied to
// staging or production, so it never changes. migrations/SHA256SUMS records each file's checksum
// (the `shasum -a 256` format); a new migration is appended with `pnpm migrations:lock`, and the
// tests fail when a recorded file was edited, renamed or removed.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);
export const LOCK_FILE = join(MIGRATIONS_DIR, 'SHA256SUMS');

export function migrationFiles(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

export function checksum(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** `[{ name, sha256 }]` in file order. */
export function parseLock(text) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
      if (!match) throw new Error(`bad SHA256SUMS line: ${line}`);
      return { sha256: match[1], name: match[2] };
    });
}

export function formatLock(entries) {
  return entries.map((e) => `${e.sha256}  ${e.name}\n`).join('');
}

/**
 * What is wrong with the migrations against the lock: a recorded file that changed or is gone, a
 * new file that sorts before a recorded one (it would run out of order on a fresh database but
 * never on an existing one), bad or shared numbers, and new files not yet recorded.
 */
export function verifyMigrations({ files, read, lock }) {
  const problems = [];
  const unlocked = [];
  // Numbers only go up and are never shared. Gaps are allowed: branches reserve numbers.
  let previous = 0;
  for (const name of files) {
    const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(name);
    if (!match) {
      problems.push(`${name}: name must be NNNN_lower_snake.sql`);
      continue;
    }
    if (Number(match[1]) === previous) problems.push(`${name}: number ${match[1]} is taken`);
    previous = Number(match[1]);
  }
  const lastLocked = lock.at(-1)?.name ?? '';
  for (const entry of lock) {
    if (!files.includes(entry.name)) {
      problems.push(`${entry.name}: applied migration was removed or renamed`);
    } else if (checksum(read(entry.name)) !== entry.sha256) {
      problems.push(`${entry.name}: applied migration was edited; add a new migration instead`);
    }
  }
  for (const name of files) {
    if (lock.some((e) => e.name === name)) continue;
    if (name < lastLocked) problems.push(`${name}: new migration sorts before ${lastLocked}`);
    unlocked.push(name);
  }
  return { problems, unlocked };
}

export function readMigrations(dir = MIGRATIONS_DIR) {
  const files = migrationFiles(dir);
  const read = (name) => readFileSync(join(dir, name), 'utf8');
  return { files, read };
}
