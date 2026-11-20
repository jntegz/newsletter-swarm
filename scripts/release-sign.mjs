// Signs a release that release-bundle.mjs has built, as a separate act: it runs no build tool, no
// package script and no dependency, only Node's own crypto, so nothing that ran during the build
// is running while the key is open. See docs/releasing.md.
//
//   pnpm release:sign -- --new-key <path>           a new signing key, encrypted under a passphrase
//   pnpm release:sign -- --dir dist/release/0.1.0 --key <path>
//
// It refuses a plain (unencrypted) key, a key file inside this repository, a trial build, a build
// whose commit is not the one tagged v<version>, and a bundle whose files no longer match its
// manifest. It shows what it is about to sign and asks you to type the version. The passphrase is
// asked for on the terminal, or read from RELEASE_KEY_PASSPHRASE. Every signature is appended to
// <key>.signing-log, which you can review.
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  MIN_PASSPHRASE,
  keyIdOfPrivate,
  newSigningKey,
  sha256,
  signManifest,
  signedManifest,
  signingProblems,
  signingRecord,
} from './lib/release.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name) => argv.includes(`--${name}`);
const option = (name) => (flag(name) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
const refuse = (message) => {
  console.error(message);
  process.exit(1);
};
const here = process.env.INIT_CWD ?? process.cwd();

/** Whether `path` is inside this repository, where a build could read it. */
function insideRepository(path) {
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  // A file that doesn't exist yet: its folder decides.
  const target = existsSync(path) ? real(path) : join(real(dirname(path)), basename(path));
  const rel = relative(real(ROOT), target);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/** Reads a line from the terminal without echoing it. */
function ask(question, { hidden = false } = {}) {
  if (!process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (text) => {
        if (text.includes(question)) process.stdout.write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      done(answer);
    });
  });
}

async function passphrase({ twice }) {
  const fromEnv = process.env.RELEASE_KEY_PASSPHRASE;
  if (fromEnv) return fromEnv;
  const first = await ask('Signing key passphrase: ', { hidden: true });
  if (first === null) {
    refuse(
      'No terminal to ask for the passphrase on. Set RELEASE_KEY_PASSPHRASE for this command.',
    );
  }
  if (twice && (await ask('The same passphrase again: ', { hidden: true })) !== first) {
    refuse('The two passphrases differ, so no key was written.');
  }
  return first;
}

if (process.platform === 'win32') {
  console.warn(
    'Note: on Windows file modes do not restrict who can read the key file. Its protection is the passphrase, so choose a long one and keep the file off shared folders and backups others can read.',
  );
}

if (flag('new-key')) {
  const path = option('new-key');
  if (!path) refuse('Say where to write the key: --new-key <path outside the repository>.');
  const file = resolve(here, path);
  if (insideRepository(file)) {
    refuse(`${file} is inside the repository. Keep the signing key where no build can read it.`);
  }
  const secret = await passphrase({ twice: true });
  if (secret.length < MIN_PASSPHRASE)
    refuse(`Use a passphrase of ${MIN_PASSPHRASE} characters or more.`);
  const { privateKey, publicKey, keyId } = newSigningKey(secret);
  writeFileSync(file, privateKey, { mode: 0o600, flag: 'wx' });
  writeFileSync(`${file}.pub`, publicKey, { flag: 'wx' });
  console.log(
    `Wrote ${file} (encrypted) and ${file}.pub.\nKey id: ${keyId}\n` +
      'Publish the public key and this id through a channel separate from the release host (docs/releasing.md). Back the private key up, encrypted, somewhere only you can reach.',
  );
  process.exit(0);
}

const dirOption = option('dir');
const keyOption = option('key');
if (!dirOption || !keyOption) {
  refuse('Usage: pnpm release:sign -- --dir dist/release/<version> --key <path>');
}
const dir = resolve(here, dirOption);
const keyPath = resolve(here, keyOption);
if (insideRepository(keyPath)) {
  refuse(`${keyPath} is inside the repository. Move the signing key out of it; builds run here.`);
}
const keyPem = readFileSync(keyPath, 'utf8');

function walk(at) {
  return readdirSync(at).flatMap((entry) => {
    const path = join(at, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
const manifestText = readFileSync(join(dir, 'manifest.json'), 'utf8');
const listed = walk(dir).map((path) => relative(dir, path).split(sep).join('/'));
const tagCommit = (version) => {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', `v${version}^{commit}`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
};
const problems = signingProblems({
  manifestText,
  readFile: (path) => {
    try {
      return readFileSync(join(dir, path));
    } catch {
      return null;
    }
  },
  listed,
  tagCommit,
});
if (problems.length) refuse(`Not signed:\n${problems.join('\n')}`);

const manifest = JSON.parse(manifestText);
console.log(
  [
    `Version:   ${manifest.version}`,
    `Commit:    ${manifest.commit} (tag v${manifest.version})`,
    `Files:     ${manifest.files.length}, every one matching the manifest`,
    `SBOMs:     ${manifest.sbom?.runtime}, ${manifest.sbom?.withBuildTools}`,
    `Build:     ${manifest.build}`,
  ].join('\n'),
);
if (!flag('yes')) {
  const typed = await ask(`Type the version to sign it (${manifest.version}): `);
  if (typed?.trim() !== manifest.version) refuse('Not signed.');
}
const secret = await passphrase({ twice: false });
let id;
let final;
let signature;
try {
  id = keyIdOfPrivate(keyPem, secret);
  final = signedManifest(manifestText, id);
  signature = signManifest(final, keyPem, secret);
} catch (error) {
  refuse(error instanceof Error ? error.message : String(error));
}
writeFileSync(join(dir, 'manifest.json'), final);
writeFileSync(join(dir, 'manifest.sig'), signature);
appendFileSync(
  `${keyPath}.signing-log`,
  signingRecord({ manifestText: final, id, signer: userInfo().username }),
  { mode: 0o600 },
);
console.log(
  `Signed ${manifest.version} with key ${id}.\nManifest sha256: ${sha256(final)}\nRecorded in ${keyPath}.signing-log.`,
);
