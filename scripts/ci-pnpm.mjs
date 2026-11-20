// Sets up pnpm in CI through corepack, checked against the sha512 that `packageManager` in
// package.json names, and fails if it isn't that file. Run by .github/workflows/*.yml right after
// actions/setup-node; it uses only Node and the corepack that came with it.
//
// - It refuses a packageManager without a sha512, because corepack would then fetch pnpm by name.
// - It points COREPACK_HOME at a new, empty folder (and hands it to later steps through
//   GITHUB_ENV): corepack reuses a copy it already has without checking its hash again, so nothing
//   left on the runner image may stand in for the download.
// - `corepack install` downloads pnpm and stops with "Mismatch hashes" if it isn't the one named.
//   The hash corepack recorded for what it kept is then compared with packageManager once more,
//   so a corepack that skipped the check fails here too.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SPEC = /^pnpm@(\d+\.\d+\.\d+)\+sha512\.([0-9a-f]{128})$/;

function fail(message) {
  console.error(`ci-pnpm: ${message}`);
  process.exit(1);
}

function corepack(args, env) {
  const result = spawnSync('corepack', args, { stdio: 'inherit', env });
  if (result.error) fail(`could not run corepack: ${result.error.message}`);
  if (result.status !== 0) fail(`corepack ${args.join(' ')} failed (exit ${result.status})`);
}

const spec = JSON.parse(readFileSync('package.json', 'utf8')).packageManager ?? '';
const match = SPEC.exec(spec);
if (!match) fail(`packageManager must be pnpm@<version>+sha512.<hash>, not "${spec}"`);
const [, version, hash] = match;

const temp = process.env.RUNNER_TEMP;
if (!temp) fail('RUNNER_TEMP is not set; this runs in GitHub Actions');
const home = join(temp, 'corepack');
if (existsSync(home)) fail(`${home} already exists; corepack must start from an empty folder`);

const env = { ...process.env, COREPACK_HOME: home, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' };
// An empty value turns off corepack's own checks of what it downloads.
delete env.COREPACK_INTEGRITY_KEYS;
corepack(['enable', 'pnpm'], env);
corepack(['install'], env);

const recordFile = join(home, 'v1', 'pnpm', version, '.corepack');
let recorded = '';
try {
  recorded = JSON.parse(readFileSync(recordFile, 'utf8')).hash ?? '';
} catch {
  fail(`corepack kept no record of pnpm ${version} at ${recordFile}`);
}
if (recorded !== `sha512.${hash}`) {
  fail(`pnpm ${version} has hash ${recorded}, but packageManager names sha512.${hash}`);
}

if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `COREPACK_HOME=${home}\n`);
console.log(`pnpm ${version}, sha512.${hash.slice(0, 16)}…, checked by corepack in ${home}`);
