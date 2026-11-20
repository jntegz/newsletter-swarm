// Appends new migrations to migrations/SHA256SUMS. Never rewrites a recorded checksum: if an
// applied migration was edited, it stops and says so (write a new migration instead).
// Usage: pnpm migrations:lock
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  LOCK_FILE,
  checksum,
  formatLock,
  parseLock,
  readMigrations,
  verifyMigrations,
} from './lib/migrations.mjs';

const lock = existsSync(LOCK_FILE) ? parseLock(readFileSync(LOCK_FILE, 'utf8')) : [];
const { files, read } = readMigrations();
const { problems, unlocked } = verifyMigrations({ files, read, lock });
if (problems.length > 0) {
  console.error(`Not locking, fix these first:\n${problems.join('\n')}`);
  process.exit(1);
}
if (unlocked.length === 0) {
  console.log('migrations/SHA256SUMS is up to date.');
} else {
  const added = unlocked.map((name) => ({ name, sha256: checksum(read(name)) }));
  writeFileSync(LOCK_FILE, formatLock([...lock, ...added]));
  console.log(`Locked ${unlocked.join(', ')}.`);
}
