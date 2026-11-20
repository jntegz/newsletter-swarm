// Writes a CycloneDX 1.5 SBOM (JSON) of the third-party packages the workspace ships: every
// production dependency of every workspace package, transitively, as `pnpm list` resolves them,
// with the integrity hash from pnpm-lock.yaml. No dependencies of its own.
//
//   pnpm sbom                 → dist/sbom.cdx.json
//   pnpm sbom -- --dev        → also dev dependencies (build and test tools)
//   pnpm sbom -- --out <path> → another path
//   --version <v> --commit <sha>  name the release it describes (release-bundle.mjs passes both,
//                                 and puts the file inside the signed bundle)
//
// The scope is stated in metadata.properties (swarm:scope), so a reader can tell whether build
// tools are covered.
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const args = process.argv.slice(2);
const dev = args.includes('--dev');
const outIndex = args.indexOf('--out');
const out = outIndex >= 0 ? args[outIndex + 1] : join(ROOT, 'dist', 'sbom.cdx.json');
const optionValue = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const releaseVersion = optionValue('version');
const releaseCommit = optionValue('commit');

const listed = JSON.parse(
  execSync(`pnpm list --recursive --json --depth Infinity ${dev ? '' : '--prod'}`, {
    cwd: ROOT,
    maxBuffer: 512 * 1024 * 1024,
    encoding: 'utf8',
  }),
);

// name@version → sha512 hex, from the lockfile's `packages:` entries.
const lock = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8').replace(/\r\n/g, '\n');
const integrity = new Map();
for (const match of lock.matchAll(
  /^ {2}'?((?:@[^@\s/]+\/)?[^@\s']+@[^\s'(:]+)[^:\n]*:\n {4}resolution: \{integrity: (sha\d+)-([A-Za-z0-9+/=]+)/gm,
)) {
  const [, id, alg, base64] = match;
  integrity.set(id, {
    alg: alg.replace('sha', 'SHA-'),
    content: Buffer.from(base64, 'base64').toString('hex'),
  });
}

const purl = (name, version) =>
  `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${encodeURIComponent(version)}`;

const components = new Map();
const edges = new Map();

/** Walks one dependency tree; returns the bom-ref of `name@version`, or null for workspace links. */
function visit(name, node) {
  const version = node.version ?? '';
  if (!version || version.startsWith('link:') || version.startsWith('file:')) {
    for (const [child, sub] of Object.entries({ ...node.dependencies })) visit(child, sub);
    return null;
  }
  const ref = purl(name, version);
  if (!components.has(ref)) {
    const hash = integrity.get(`${name}@${version}`);
    components.set(ref, {
      type: 'library',
      'bom-ref': ref,
      name,
      version,
      purl: ref,
      ...(hash ? { hashes: [hash] } : {}),
      ...(node.resolved
        ? { externalReferences: [{ type: 'distribution', url: node.resolved }] }
        : {}),
    });
    edges.set(ref, new Set());
    for (const [child, sub] of Object.entries({
      ...node.dependencies,
      ...(dev ? node.devDependencies : {}),
    })) {
      const childRef = visit(child, sub);
      if (childRef) edges.get(ref).add(childRef);
    }
  }
  return ref;
}

const rootRef = 'swarm';
const workspaceRefs = [];
for (const project of listed) {
  const ref = `workspace:${project.name}`;
  workspaceRefs.push(ref);
  edges.set(ref, new Set());
  const deps = { ...project.dependencies, ...(dev ? project.devDependencies : {}) };
  for (const [name, node] of Object.entries(deps)) {
    const childRef = visit(name, node);
    if (childRef) edges.get(ref).add(childRef);
  }
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: { components: [{ type: 'application', name: 'swarm scripts/sbom.mjs' }] },
    component: {
      type: 'application',
      'bom-ref': rootRef,
      name: pkg.name,
      version: releaseVersion ?? process.env.GITHUB_REF_NAME ?? pkg.version ?? '0.0.0',
    },
    properties: [
      {
        name: 'swarm:scope',
        value: dev
          ? 'Production and development dependencies of every workspace package, including the build tools (bundler, wrangler, vite) that shape release output.'
          : 'Production dependencies of every workspace package, as installed. Build and test tools are excluded; see the --dev SBOM for them.',
      },
      ...(releaseCommit ? [{ name: 'swarm:commit', value: releaseCommit }] : []),
    ],
  },
  components: [
    ...listed.map((project) => ({
      type: 'application',
      'bom-ref': `workspace:${project.name}`,
      name: project.name,
      version: project.version ?? '0.0.0',
    })),
    ...[...components.values()].sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref'])),
  ],
  dependencies: [
    { ref: rootRef, dependsOn: workspaceRefs },
    ...[...edges.entries()].map(([ref, set]) => ({ ref, dependsOn: [...set].sort() })),
  ],
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(bom, null, 2)}\n`);
console.log(`SBOM: ${components.size} packages → ${out}`);
