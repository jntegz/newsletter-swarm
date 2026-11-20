// Static checks of the GitHub workflows and the toolchain pins. Workflows can't run here, so this
// reads them: what each job may do, and what runs where the write token is.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/release.yml'];

/** The jobs of a workflow, by name, as their text (two-space job keys under `jobs:`). */
function jobs(text) {
  const body = text.slice(text.indexOf('\njobs:\n') + 7);
  const found = {};
  let name = null;
  for (const line of body.split('\n')) {
    const key = /^ {2}([\w-]+):\s*$/.exec(line);
    if (key) name = key[1];
    else if (name) found[name] = `${found[name] ?? ''}${line}\n`;
  }
  return found;
}

describe('the workflows', () => {
  it('pin every action by commit, and name a fixed runner image and Node version', () => {
    for (const file of WORKFLOWS) {
      const text = read(file);
      for (const [, ref] of text.matchAll(/uses:\s*[\w./-]+@(\S+)/g)) {
        assert.match(ref, /^[0-9a-f]{40}$/, `${file}: ${ref}`);
      }
      assert.doesNotMatch(text, /ubuntu-latest/, file);
      assert.doesNotMatch(text, /node-version:\s*\d/, file);
      assert.match(text, /node-version-file: \.node-version/, file);
    }
  });

  it('give the release workflow no permission by default', () => {
    assert.match(read('.github/workflows/release.yml'), /^permissions: \{\}$/m);
    assert.match(read('.github/workflows/ci.yml'), /^permissions:\n {2}contents: read$/m);
  });

  it('run no repository, dependency or package-manager code where the write token is', () => {
    const release = jobs(read('.github/workflows/release.yml'));
    const writers = Object.entries(release).filter(([, text]) => /contents: write/.test(text));
    assert.deepEqual(
      writers.map(([name]) => name),
      ['attach'],
    );
    const [, attach] = writers[0];
    assert.doesNotMatch(attach, /uses:/);
    assert.doesNotMatch(attach, /\b(pnpm|npm|npx|node|corepack|git)\b/);
    const commands = [...attach.matchAll(/^\s+run: (.+)$/gm)].map((m) => m[1]);
    for (const command of commands.filter((c) => c !== '|')) {
      assert.match(command, /^\/usr\/bin\//, command);
    }
    assert.match(attach, /\/usr\/bin\/sha256sum[\s\S]*= "\$EXPECTED"/);
    assert.doesNotMatch(attach, /--clobber/);
    // The job that runs the install and the SBOM script can only read.
    assert.match(release.sbom, /permissions:\n\s+contents: read/);
    assert.doesNotMatch(release.sbom, /GH_TOKEN|github\.token|^\s+cache:/m);
  });
});

/** The steps of a job, as their text, in order. */
const steps = (job) => job.split(/\n(?= {6}- )/).filter((step) => /^ {6}- /m.test(step));

describe('pnpm in CI', () => {
  it('comes from corepack, checked against packageManager, in every job that runs it', () => {
    for (const file of WORKFLOWS) {
      const text = read(file);
      assert.doesNotMatch(text, /pnpm\/action-setup/, file);
      // setup-node's pnpm cache would need pnpm before corepack has checked it.
      assert.doesNotMatch(text, /cache: pnpm/, file);
      for (const [name, job] of Object.entries(jobs(text))) {
        const list = steps(job);
        const runsPnpm = (step) =>
          step
            .split('\n')
            .filter((line) => !/^\s*(#|- name:|name:)/.test(line))
            .some((line) => /(^|[\s"'(])pnpm\b/.test(line));
        const firstPnpm = list.findIndex(runsPnpm);
        if (firstPnpm === -1) continue;
        const node = list.findIndex((step) => /actions\/setup-node@/.test(step));
        const check = list.findIndex((step) => /run: node scripts\/ci-pnpm\.mjs$/m.test(step));
        assert.ok(node !== -1 && check > node, `${file} ${name}: Node, then the checked pnpm`);
        assert.ok(check < firstPnpm, `${file} ${name}: pnpm is checked before it first runs`);
        assert.doesNotMatch(job, /COREPACK_INTEGRITY_KEYS|COREPACK_HOME:/, `${file} ${name}`);
      }
    }
  });

  it('records the toolchain and tests the versions against the pins', () => {
    const ci = jobs(read('.github/workflows/ci.yml')).ci;
    assert.match(ci, /name: Record the toolchain/);
    assert.match(ci, /test "pnpm@\$\(pnpm --version\)" = /);
    assert.match(ci, /test "v\$\(cat \.node-version\)" = "\$\(node --version\)"/);
  });
});

describe('scripts/ci-pnpm.mjs', () => {
  const script = fileURLToPath(new URL('../ci-pnpm.mjs', import.meta.url));
  const HASH = 'a'.repeat(128);
  /** A corepack stand-in that records `STUB_HASH` for what it "installed", or fails. */
  function world({
    packageManager = `pnpm@10.28.0+sha512.${HASH}`,
    recorded = `sha512.${HASH}`,
  } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'swarm-ci-pnpm-'));
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(dir, 'temp'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ packageManager }));
    const stub = join(dir, 'bin', 'corepack');
    writeFileSync(
      stub,
      [
        '#!/bin/sh',
        'echo "$@" >> "$STUB_LOG"',
        'if [ "$1" = install ]; then',
        '  if [ -n "$STUB_FAIL" ]; then echo "Mismatch hashes" >&2; exit 1; fi',
        '  mkdir -p "$COREPACK_HOME/v1/pnpm/10.28.0"',
        `  printf '{"hash":"%s"}' "$STUB_HASH" > "$COREPACK_HOME/v1/pnpm/10.28.0/.corepack"`,
        'fi',
        '',
      ].join('\n'),
    );
    chmodSync(stub, 0o755);
    const run = (extra = {}) =>
      spawnSync(process.execPath, [script], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
          RUNNER_TEMP: join(dir, 'temp'),
          GITHUB_ENV: join(dir, 'github-env'),
          STUB_LOG: join(dir, 'log'),
          STUB_HASH: recorded,
          ...extra,
        },
      });
    return { dir, run };
  }

  it(
    'installs pnpm into an empty corepack folder and hands it to later steps',
    { skip: process.platform === 'win32' },
    () => {
      const { dir, run } = world();
      const result = run();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(join(dir, 'log'), 'utf8'), 'enable pnpm\ninstall\n');
      assert.equal(
        readFileSync(join(dir, 'github-env'), 'utf8'),
        `COREPACK_HOME=${join(dir, 'temp', 'corepack')}\n`,
      );
    },
  );

  it('fails when corepack refuses the download', { skip: process.platform === 'win32' }, () => {
    const result = world().run({ STUB_FAIL: '1' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /corepack install failed/);
  });

  it(
    'fails when what corepack kept is not the pnpm packageManager names',
    { skip: process.platform === 'win32' },
    () => {
      const { dir, run } = world({ recorded: `sha512.${'b'.repeat(128)}` });
      const result = run();
      assert.equal(result.status, 1);
      assert.match(result.stderr, /but packageManager names sha512\.a{128}/);
      assert.equal(existsSync(join(dir, 'github-env')), false);
    },
  );

  it(
    'refuses a packageManager without a hash, before running corepack',
    { skip: process.platform === 'win32' },
    () => {
      const { dir, run } = world({ packageManager: 'pnpm@10.28.0' });
      const result = run();
      assert.equal(result.status, 1);
      assert.match(result.stderr, /must be pnpm@<version>\+sha512/);
      assert.equal(existsSync(join(dir, 'log')), false);
    },
  );

  it(
    'refuses a corepack folder that already holds something',
    { skip: process.platform === 'win32' },
    () => {
      const { dir, run } = world();
      mkdirSync(join(dir, 'temp', 'corepack'));
      const result = run();
      assert.equal(result.status, 1);
      assert.match(result.stderr, /must start from an empty folder/);
    },
  );
});

describe('the toolchain pins', () => {
  it('name pnpm by content, and Node by exact version', () => {
    const { packageManager } = JSON.parse(read('package.json'));
    assert.match(packageManager, /^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/);
    assert.match(read('.node-version').trim(), /^\d+\.\d+\.\d+$/);
  });
});
