#!/usr/bin/env node
// Prepares a clone for local development: writes each worker's .dev.vars from its committed
// example and creates the local database. Safe to run again: an existing .dev.vars is left alone.
//
// Workers share keyrings (the send worker signs unsubscribe links the track worker checks), so
// every worker must get the same value for a key of the same name. One random value is made per
// name and reused. If some workers already have a .dev.vars, their values are reused for the rest.
// An Ed25519 keyring (*_SIGNING_KEYS) gets a real key pair, and its *_VERIFY_KEYS the public half.
import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workersDir = join(root, 'workers');
const KEYRING = /^([A-Z_]+_KEYS)=(.*)$/;

/** Reads KEY=value lines, skipping comments and blanks. */
export function parseVars(text) {
  const vars = new Map();
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) vars.set(match[1], match[2]);
  }
  return vars;
}

const SIGNING = /_SIGNING_KEYS$/;
const VERIFY = /_VERIFY_KEYS$/;

/** `kid:<base64url raw public key>` for each `kid:<base64url PKCS#8>` of an Ed25519 keyring. */
export function publicKeysOf(signing) {
  return signing
    .split(',')
    .map((entry) => {
      const [kid, secret] = entry.trim().split(':');
      const key = createPrivateKey({
        key: Buffer.from(secret, 'base64url'),
        format: 'der',
        type: 'pkcs8',
      });
      return `${kid}:${createPublicKey(key).export({ format: 'jwk' }).x}`;
    })
    .join(',');
}

function newSigningKeyring() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return `k1:${privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')}`;
}

/** The example with every keyring replaced by this clone's own random key. */
export function fillExample(example, keys, makeKey = () => randomBytes(32).toString('hex')) {
  const keyFor = (name) => {
    if (keys.has(name)) return keys.get(name);
    if (VERIFY.test(name)) {
      const signing = name.replace(VERIFY, '_SIGNING_KEYS');
      keys.set(name, publicKeysOf(keyFor(signing)));
    } else {
      keys.set(name, SIGNING.test(name) ? newSigningKeyring() : `k1:${makeKey()}`);
    }
    return keys.get(name);
  };
  return example
    .split('\n')
    .map((line) => {
      const match = KEYRING.exec(line);
      return match ? `${match[1]}=${keyFor(match[1])}` : line;
    })
    .join('\n');
}

function main() {
  const skipDatabase = process.argv.includes('--no-database');
  const workers = readdirSync(workersDir).filter((name) =>
    existsSync(join(workersDir, name, '.dev.vars.example')),
  );

  // Keys a previous run (or the developer) already chose win, so workers keep agreeing.
  const keys = new Map();
  for (const name of workers) {
    const file = join(workersDir, name, '.dev.vars');
    if (!existsSync(file)) continue;
    for (const [key, value] of parseVars(readFileSync(file, 'utf8'))) {
      if (key.endsWith('_KEYS') && !keys.has(key)) keys.set(key, value);
    }
  }

  for (const name of workers) {
    const file = join(workersDir, name, '.dev.vars');
    if (existsSync(file)) {
      console.log(`kept     workers/${name}/.dev.vars`);
      continue;
    }
    const example = readFileSync(join(workersDir, name, '.dev.vars.example'), 'utf8');
    writeFileSync(file, fillExample(example, keys), { mode: 0o600 });
    console.log(`created  workers/${name}/.dev.vars`);
  }

  if (!skipDatabase) {
    console.log('\nCreating the local database…');
    const result = spawnSync('pnpm', ['db:migrate:local'], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (result.status !== 0) {
      console.error('\nThe local database could not be created. Fix the error above and run');
      console.error('`pnpm setup:dev` again; it picks up where it stopped.');
      process.exit(result.status ?? 1);
    }
  }

  console.log('\nReady. Start everything with `pnpm dev`, then open http://localhost:5273.');
  console.log(
    'Local email is not sent. Ask for a sign-in link, then open the dev mailbox the page',
  );
  console.log('links to (http://localhost:5273/__dev/mail).');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
