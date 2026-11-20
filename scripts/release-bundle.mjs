// Builds a release locally, because GitHub Actions stays off: every Worker bundled, the dashboard,
// the migrations, the SBOMs, and a manifest of every file. It never signs: signing is a separate
// step (`pnpm release:sign`, see docs/releasing.md) over a manifest you can review, so no build
// tool, dependency or install script ever runs in a process that has the signing key.
//
//   pnpm release:bundle -- --version 0.1.0     a release build of the commit tagged v0.1.0
//   pnpm release:bundle -- --version 0.1.0 --trial [--allow-dirty]
//                                              a quick build of this checkout; never signable
//
// A release build refuses unless this checkout is clean and HEAD is tagged v<version>. It then
// clones that commit into a fresh directory (no ignored files come along: no node_modules, dist,
// .env or .dev.vars), installs with --frozen-lockfile, which checks every package against the
// lockfile's integrity hashes, and builds there. It needs the package registry, or a pnpm store
// that already holds every locked package.
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SBOM_FILES, buildManifest, linkSigningOf, sha256 } from './lib/release.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name) => argv.includes(`--${name}`);
const option = (name) => (flag(name) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
const refuse = (message) => {
  console.error(message);
  process.exit(1);
};

/** Children get no signing material, whatever the shell that started this has set. */
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^RELEASE_KEY|PASSPHRASE/i.test(name)),
);
const run = (command, args, cwd = ROOT) =>
  execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 512 * 1024 * 1024,
  });

if (flag('key') || flag('new-key')) {
  refuse(
    'release:bundle no longer signs or makes keys. Build first, then sign the built bundle in a separate step:\n' +
      '  pnpm release:sign -- --new-key <path outside the repository>\n' +
      '  pnpm release:sign -- --dir dist/release/<version> --key <path>\n' +
      'See docs/releasing.md.',
  );
}

const version = option('version');
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  refuse('Give a version: --version 0.1.0');
}
// --unsigned was the old name for a trial build.
const trial = flag('trial') || flag('unsigned');
if (flag('allow-dirty') && !trial) {
  refuse('--allow-dirty is for trial builds only: uncommitted changes can never be signed.');
}

const dirty = run('git', ['status', '--porcelain', '--untracked-files=all']).trim() !== '';
if (dirty && !flag('allow-dirty')) {
  refuse(
    trial
      ? 'There are uncommitted changes. Commit them, or say --allow-dirty for a trial build.'
      : 'There are uncommitted or untracked files. A release build starts from a clean checkout of the tagged commit.',
  );
}
const head = run('git', ['rev-parse', 'HEAD']).trim();
const commit = head + (dirty ? '-dirty' : '');
if (!trial) {
  const tags = run('git', ['tag', '--points-at', 'HEAD']).split('\n').filter(Boolean);
  if (!tags.includes(`v${version}`)) {
    refuse(
      `HEAD (${head.slice(0, 12)}) is not tagged v${version}. Tag the reviewed commit first (git tag -s v${version}), or say --trial for a build that can't be signed.`,
    );
  }
}

const out = join(ROOT, 'dist', 'release', version);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// A release build happens in a fresh clone, so nothing ignored or left over in this checkout
// reaches the bundle.
let source = ROOT;
let clean = null;
try {
  if (!trial) {
    clean = mkdtempSync(join(tmpdir(), `swarm-release-${version}-`));
    source = join(clean, 'src');
    console.log(`Cloning ${head.slice(0, 12)} into a fresh directory`);
    run('git', ['clone', '--quiet', '--no-local', '--no-hardlinks', ROOT, source], tmpdir());
    run('git', ['checkout', '--quiet', '--detach', head], source);
    console.log('Installing exactly what pnpm-lock.yaml names (--frozen-lockfile)');
    run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], source);
    if (run('git', ['status', '--porcelain'], source).trim() !== '') {
      throw new Error(
        'The install changed tracked files in the clean clone, so nothing was built.',
      );
    }
  }

  console.log('Building the dashboard');
  run('pnpm', ['--filter', '@swarm/dashboard', 'build'], source);
  cpSync(join(source, 'apps/dashboard/dist'), join(out, 'dashboard'), { recursive: true });

  console.log('Copying the migrations');
  mkdirSync(join(out, 'migrations'));
  for (const file of readdirSync(join(source, 'migrations'))) {
    if (file.endsWith('.sql')) {
      cpSync(join(source, 'migrations', file), join(out, 'migrations', file));
    }
  }

  const workers = readdirSync(join(source, 'workers')).filter((name) => {
    try {
      return statSync(join(source, 'workers', name, 'wrangler.jsonc')).isFile();
    } catch {
      return false;
    }
  });
  for (const name of workers) {
    console.log(`Bundling ${name}`);
    const dir = join(source, 'workers', name);
    const target = join(out, 'workers', name);
    mkdirSync(target, { recursive: true });
    run(
      'pnpm',
      ['exec', 'wrangler', 'deploy', '--dry-run', '--outdir', target, '--env', 'production'],
      dir,
    );
    // An install only needs the code. Source maps are most of the size, and README.md is wrangler's.
    for (const file of readdirSync(target)) {
      if (file.endsWith('.map') || file === 'README.md') rmSync(join(target, file));
    }
    // The setup renders this per install, the same way `pnpm swarm` does.
    cpSync(join(dir, 'wrangler.jsonc'), join(target, 'wrangler.jsonc'));
  }

  // From the same tree the bundle was built from, so the inventory describes this release. The
  // runtime SBOM lists production dependencies; the other adds the build and test tools.
  console.log('Writing the SBOMs');
  const sbom = (file, extra) =>
    run(
      'node',
      [
        join(source, 'scripts', 'sbom.mjs'),
        '--out',
        join(out, file),
        '--version',
        version,
        '--commit',
        commit,
        ...extra,
      ],
      source,
    );
  sbom(SBOM_FILES.runtime, []);
  sbom(SBOM_FILES.withBuildTools, ['--dev']);

  function walk(dir) {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  }
  const files = walk(out).map((path) => {
    const content = readFileSync(path);
    return {
      path: relative(out, path).split(sep).join('/'),
      size: content.length,
      sha256: sha256(content),
    };
  });
  const manifest = buildManifest({
    version,
    commit,
    files,
    build: trial ? 'trial' : 'clean',
    // Whether these workers sign links per family, from the tree they were built from.
    linkSigning: linkSigningOf((path) => readFileSync(join(source, path), 'utf8')),
    sbom: {
      ...SBOM_FILES,
      scope:
        'sbom.cdx.json: every production dependency of every workspace package, as installed for this build. sbom-build-tools.cdx.json: the same plus development dependencies, which include the bundler, wrangler and vite that produced the output.',
    },
  });
  writeFileSync(join(out, 'manifest.json'), manifest);

  const size = (prefix) =>
    files.filter((f) => f.path.startsWith(prefix)).reduce((n, f) => n + f.size, 0);
  const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  for (const name of workers) console.log(`  ${name}: ${mb(size(`workers/${name}/`))}`);
  console.log(
    `  dashboard: ${mb(size('dashboard/'))}, ${files.filter((f) => f.path.startsWith('dashboard/')).length} files`,
  );
  console.log(
    trial
      ? `Trial build ${version} in ${relative(ROOT, out)}: ${files.length} files. It can't be signed.`
      : `Release build ${version} in ${relative(ROOT, out)}: ${files.length} files, manifest sha256 ${sha256(manifest)}.\n` +
          `Review it, then sign it: pnpm release:sign -- --dir ${relative(ROOT, out)} --key <path>`,
  );
} catch (error) {
  // A failed build leaves no bundle that looks finished.
  rmSync(out, { recursive: true, force: true });
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (clean) rmSync(clean, { recursive: true, force: true });
}
