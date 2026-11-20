import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  SBOM_FILES,
  buildManifest,
  checkFiles,
  keyId,
  keyIdOfPrivate,
  linkSigningOf,
  newSigningKey,
  sha256,
  signManifest,
  signedManifest,
  signingProblems,
  signingRecord,
  verifyManifest,
} from '../lib/release.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PASSPHRASE = 'test-only passphrase, long enough';
const pair = () => {
  const { privateKey, publicKey } = newSigningKey(PASSPHRASE);
  return { secret: privateKey, open: publicKey };
};
const manifest = (files = [{ path: 'a.js', size: 1, sha256: sha256('a') }]) =>
  buildManifest({ version: '0.1.0', commit: 'abc', files });

const scratch = mkdtempSync(join(tmpdir(), 'swarm-release-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

describe('the link signing field', () => {
  it('says v2 only when the tree signs v2 links, and survives signing', () => {
    const files = [{ path: 'a.js', size: 1, sha256: sha256('a') }];
    const v2 = buildManifest({ version: '0.1.0', commit: 'abc', files, linkSigning: 'v2' });
    assert.equal(JSON.parse(v2).linkSigning, 'v2');
    // A manifest without it means v1, so a v1 tree writes none.
    const v1 = buildManifest({ version: '0.1.0', commit: 'abc', files, linkSigning: 'v1' });
    assert.equal('linkSigning' in JSON.parse(v1), false);
    assert.equal(JSON.parse(signedManifest(v2, 'k'.repeat(64))).linkSigning, 'v2');
  });

  it('reads the flag from the token library, and refuses anything else', () => {
    const tree = (text) => () => text;
    assert.equal(linkSigningOf(tree('export const LINK_V2_SIGNING_READY = true;\n')), 'v2');
    assert.equal(linkSigningOf(tree('export const LINK_V2_SIGNING_READY = false;\n')), 'v1');
    assert.throws(() => linkSigningOf(tree('export const LINK_V2_SIGNING_READY = !0;\n')));
    // This tree's own value is readable, so a release build of it can record it.
    const own = linkSigningOf((path) => readFileSync(join(ROOT, path), 'utf8'));
    assert.ok(own === 'v1' || own === 'v2');
  });
});

describe('the signed manifest', () => {
  it('verifies with the matching key', () => {
    const { secret, open } = pair();
    const text = manifest();
    assert.equal(verifyManifest(text, signManifest(text, secret, PASSPHRASE), open), true);
  });

  it('refuses a changed manifest, and another key', () => {
    const { secret, open } = pair();
    const text = manifest();
    const signature = signManifest(text, secret, PASSPHRASE);
    assert.equal(verifyManifest(text.replace('0.1.0', '0.1.1'), signature, open), false);
    assert.equal(verifyManifest(text, signature, pair().open), false);
  });

  it('does not depend on the order files were found in', () => {
    const a = { path: 'a.js', size: 1, sha256: 'x' };
    const b = { path: 'b.js', size: 1, sha256: 'y' };
    assert.equal(manifest([a, b]), manifest([b, a]));
  });

  it('is format 2, says how it was built, and names the signing key once signed', () => {
    const { secret, open } = pair();
    const draft = JSON.parse(manifest());
    assert.equal(draft.format, 2);
    assert.equal(draft.build, 'trial');
    assert.equal(draft.keyId, undefined);
    const signed = JSON.parse(signedManifest(manifest(), keyIdOfPrivate(secret, PASSPHRASE)));
    assert.equal(signed.keyId, keyId(open));
    assert.match(signed.keyId, /^[0-9a-f]{64}$/);
  });
});

describe('the signing key', () => {
  it('is written encrypted, and only opens with its passphrase', () => {
    const { secret } = pair();
    assert.match(secret, /-----BEGIN ENCRYPTED PRIVATE KEY-----/);
    assert.throws(
      () => signManifest('x', secret, 'not the passphrase'),
      /passphrase does not open/,
    );
  });

  it('refuses a plain key file, which anyone who copies it could use', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const plain = privateKey.export({ type: 'pkcs8', format: 'pem' });
    assert.throws(() => signManifest('x', plain, PASSPHRASE), /not encrypted/);
  });

  it('needs a long passphrase', () => {
    assert.throws(() => newSigningKey('short'), /at least 16/);
  });

  it('has one id for both halves, and another key has another', () => {
    const { secret, open } = pair();
    assert.equal(keyIdOfPrivate(secret, PASSPHRASE), keyId(open));
    assert.notEqual(keyId(open), keyId(pair().open));
  });
});

describe('what may be signed', () => {
  const COMMIT = 'a'.repeat(40);
  const contents = new Map([
    ['workers/api/index.js', 'export default {};'],
    [SBOM_FILES.runtime, '{"bomFormat":"CycloneDX"}'],
    [SBOM_FILES.withBuildTools, '{"bomFormat":"CycloneDX","dev":true}'],
  ]);
  const files = [...contents].map(([path, text]) => ({
    path,
    size: text.length,
    sha256: sha256(text),
  }));
  const built = (extra = {}) =>
    buildManifest({
      version: '0.2.0',
      commit: COMMIT,
      files,
      build: 'clean',
      sbom: SBOM_FILES,
      ...extra,
    });
  const check = (manifestText, options = {}) =>
    signingProblems({
      manifestText,
      readFile: options.readFile ?? ((path) => contents.get(path) ?? null),
      listed: options.listed ?? [...contents.keys(), 'manifest.json'],
      tagCommit: options.tagCommit ?? ((version) => (version === '0.2.0' ? COMMIT : null)),
    });

  it('is a clean build of the tagged commit, with both SBOMs, every file unchanged', () => {
    assert.deepEqual(check(built()), []);
  });

  it('is never a trial build, a dirty tree or an untagged commit', () => {
    assert.match(check(built({ build: 'trial' })).join(), /trial build/);
    assert.match(check(built({ commit: `${COMMIT}-dirty` })).join(), /not a clean commit/);
    assert.match(check(built(), { tagCommit: () => null }).join(), /no tag v0\.2\.0/);
    assert.match(check(built(), { tagCommit: () => 'b'.repeat(40) }).join(), /not at the built/);
  });

  it('refuses a file changed or added after the build', () => {
    const changed = (path) => (path === 'workers/api/index.js' ? 'evil' : contents.get(path));
    assert.deepEqual(check(built(), { readFile: changed }), ['changed: workers/api/index.js']);
    assert.deepEqual(
      check(built(), { listed: [...contents.keys(), 'manifest.json', 'workers/api/extra.js'] }),
      ['extra: workers/api/extra.js'],
    );
  });

  it('refuses a bundle without its SBOMs, or one already signed', () => {
    const noSbom = buildManifest({ version: '0.2.0', commit: COMMIT, files, build: 'clean' });
    const fewer = JSON.parse(noSbom);
    fewer.files = fewer.files.filter((f) => f.path !== SBOM_FILES.runtime);
    assert.match(check(JSON.stringify(fewer)).join(), /no sbom\.cdx\.json/);
    assert.match(check(built({ keyId: 'f'.repeat(64) })).join(), /already signed/);
  });

  it('records each signature without any secret in the record', () => {
    const { secret } = pair();
    const id = keyIdOfPrivate(secret, PASSPHRASE);
    const final = signedManifest(built(), id);
    const record = JSON.parse(signingRecord({ manifestText: final, id, signer: 'maintainer' }));
    assert.equal(record.version, '0.2.0');
    assert.equal(record.manifestSha256, sha256(final));
    assert.equal(record.keyId, id);
    assert.doesNotMatch(JSON.stringify(record), /PRIVATE KEY|passphrase/);
  });
});

describe('checkFiles', () => {
  const text = manifest();
  it('passes the files the manifest lists', () => {
    assert.deepEqual(
      checkFiles(text, () => 'a', ['a.js']),
      [],
    );
  });
  it('names missing, changed and extra files', () => {
    assert.deepEqual(
      checkFiles(text, () => null, []),
      ['missing: a.js'],
    );
    assert.deepEqual(
      checkFiles(text, () => 'evil', ['a.js']),
      ['changed: a.js'],
    );
    assert.deepEqual(
      checkFiles(text, () => 'a', ['a.js', 'b.js']),
      ['extra: b.js'],
    );
  });
});

/** Runs a release script; every case here stops before any build or network use. */
const script = (name, args, env = {}) =>
  spawnSync(process.execPath, [join(ROOT, 'scripts', name), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, INIT_CWD: ROOT, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

describe('pnpm release:bundle', () => {
  it('no longer signs: the key never reaches the process that runs the build', () => {
    const result = script('release-bundle.mjs', ['--version', '0.1.0', '--key', '/x/key.pem']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no longer signs.*release:sign/s);
  });

  it('allows a dirty tree only for a trial build', () => {
    const result = script('release-bundle.mjs', ['--version', '0.1.0', '--allow-dirty']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /trial builds only/);
  });

  it('refuses a release build of an untagged or unclean checkout, before building anything', () => {
    const result = script('release-bundle.mjs', ['--version', '99.99.99']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not tagged v99\.99\.99|uncommitted or untracked/);
    assert.equal(existsSync(join(ROOT, 'dist', 'release', '99.99.99')), false);
  });
});

describe('pnpm release:sign', () => {
  const env = { RELEASE_KEY_PASSPHRASE: PASSPHRASE };

  it('writes a new key encrypted, outside the repository only', () => {
    const inside = script('release-sign.mjs', ['--new-key', 'scripts/tests/new.pem'], env);
    assert.equal(inside.status, 1);
    assert.match(inside.stderr, /inside the repository/);
    assert.equal(existsSync(join(ROOT, 'scripts/tests/new.pem')), false);

    const file = join(scratch, 'signing.pem');
    const made = script('release-sign.mjs', ['--new-key', file], env);
    assert.equal(made.status, 0, made.stderr);
    assert.match(readFileSync(file, 'utf8'), /BEGIN ENCRYPTED PRIVATE KEY/);
    assert.match(made.stdout, /Key id: [0-9a-f]{64}/);
  });

  it('refuses a key kept inside the repository', () => {
    const result = script('release-sign.mjs', ['--dir', scratch, '--key', 'package.json'], env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /inside the repository/);
  });

  it('refuses a trial build, and writes no signature', () => {
    const dir = join(scratch, 'trial');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.js'), 'a');
    writeFileSync(
      join(dir, 'manifest.json'),
      buildManifest({
        version: '0.1.0',
        commit: 'a'.repeat(40),
        files: [{ path: 'a.js', size: 1, sha256: sha256('a') }],
      }),
    );
    const key = join(scratch, 'trial-key.pem');
    writeFileSync(key, newSigningKey(PASSPHRASE).privateKey);
    const result = script('release-sign.mjs', ['--dir', dir, '--key', key, '--yes'], env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Not signed:[\s\S]*trial build/);
    assert.equal(existsSync(join(dir, 'manifest.sig')), false);
    assert.equal(existsSync(`${key}.signing-log`), false);
  });
});
