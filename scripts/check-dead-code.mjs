// Dead-code check: ts-prune lists exports that nothing imports; the repository's own TypeScript
// checker then confirms each one, because ts-prune cannot see through `export *` barrels and its
// bundled parser predates syntax this codebase uses (`satisfies`).
//
// An export fails the check when no other file uses it. Two kinds are reported:
//   unused        nothing references it at all: delete it
//   local only    only its own file uses it: drop the `export`
// Runtime entry points (Worker entry modules, Durable Object classes, named entrypoints, tool
// configs) and the published SDK are exempt, since code outside this repository loads them by
// name.
//
// Run: pnpm check:dead-code
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const tsconfigPath = path.join(root, 'tsconfig.dead-code.json');
const require = createRequire(import.meta.url);

/** Paths are repository-relative with forward slashes. */
const rel = (file) => path.relative(root, file).split(path.sep).join('/');

function wranglerConfigs() {
  const files = [];
  for (const group of ['apps', 'workers']) {
    for (const name of readdirSync(path.join(root, group))) {
      const file = path.join(root, group, name, 'wrangler.jsonc');
      if (existsSync(file)) files.push(file);
    }
  }
  return files;
}

/** Entry modules and class names that the Workers runtime loads by name. */
function runtimeEntryPoints() {
  const entryFiles = new Set();
  const classNames = new Set();
  for (const file of wranglerConfigs()) {
    const text = readFileSync(file, 'utf8');
    const main = /"main"\s*:\s*"([^"]+)"/.exec(text);
    if (main?.[1]) entryFiles.add(rel(path.join(path.dirname(file), main[1])));
    for (const m of text.matchAll(/"class_name"\s*:\s*"([^"]+)"/g)) classNames.add(m[1]);
    // Named entrypoints another Worker's service binding names (the vault's ApiVault, …).
    for (const m of text.matchAll(/"entrypoint"\s*:\s*"([^"]+)"/g)) classNames.add(m[1]);
  }
  return { entryFiles, classNames };
}

const { entryFiles, classNames } = runtimeEntryPoints();
const CONFIG_FILE = /(^|\/)(vite|vitest|playwright)(\.[\w-]+)*\.config\.ts$/;

function exempt(file, name) {
  if (file.startsWith('packages/sdk/src/')) return true;
  if (name === 'default' && (entryFiles.has(file) || CONFIG_FILE.test(file))) return true;
  return entryFiles.has(file) && classNames.has(name);
}

// 1. Candidates from ts-prune.
const tsPrune = path.join(
  path.dirname(require.resolve('ts-prune/package.json')),
  'lib',
  'index.js',
);
const pruneOutput = execFileSync(process.execPath, [tsPrune, '-p', path.basename(tsconfigPath)], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const candidates = [];
for (const line of pruneOutput.split('\n')) {
  const m = /^(.+?):\d+ - (\S+)/.exec(line);
  // ts-prune prints paths with the platform's separator, and a leading one on Windows.
  if (m?.[1] && m[2]) {
    candidates.push({ file: m[1].split(path.sep).join('/').replace(/^\//, ''), name: m[2] });
  }
}

// 2. One TypeScript program over the same files ts-prune read.
const parsed = ts.getParsedCommandLineOfConfigFile(
  tsconfigPath,
  {},
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    },
  },
);
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const checker = program.getTypeChecker();
const resolveAlias = (symbol) =>
  symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

/** The symbol a module exports under `name`, following `export *` barrels to its declaration. */
function exportedSymbol(file, name) {
  const source = program.getSourceFile(path.join(root, file));
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  if (!moduleSymbol) return undefined;
  const found = checker.getExportsOfModule(moduleSymbol).find((s) => s.getName() === name);
  return found && resolveAlias(found);
}

/** `export { name } from '…'` or `export { name }` in `file` itself, not reached through `export *`. */
function namedReExport(file, name) {
  const source = program.getSourceFile(path.join(root, file));
  return source?.statements.some(
    (s) =>
      ts.isExportDeclaration(s) &&
      s.exportClause &&
      ts.isNamedExports(s.exportClause) &&
      s.exportClause.elements.some((e) => e.name.text === name),
  );
}

// Names that only the old ts-prune parser reports (keywords it misreads as exports) resolve to
// nothing and drop out here.
const targets = new Map();
const reExports = [];
for (const { file, name } of candidates) {
  if (exempt(file, name)) continue;
  const symbol = exportedSymbol(file, name);
  const declaration = symbol?.declarations?.[0];
  if (!symbol || !declaration) continue;
  const declaredIn = rel(declaration.getSourceFile().fileName);
  if (declaredIn !== file && namedReExport(file, name)) reExports.push({ file, name });
  if (exempt(declaredIn, name)) continue;
  targets.set(symbol, { name, declaredIn, uses: new Set(), localUses: 0 });
}

/** Which names each module is imported for: "file#name", or "file#*" for namespace and star forms. */
const imported = new Set();
function recordImport(statement) {
  const specifier = statement.moduleSpecifier;
  const target = specifier && checker.getSymbolAtLocation(specifier)?.valueDeclaration;
  if (!target || !ts.isSourceFile(target)) return;
  const from = rel(target.fileName);
  const named = (elements) =>
    elements.forEach((e) => imported.add(`${from}#${(e.propertyName ?? e.name).text}`));
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (!clause) return;
    if (clause.name) imported.add(`${from}#default`);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) imported.add(`${from}#*`);
    else if (bindings) named(bindings.elements);
  } else if (!statement.exportClause || ts.isNamespaceExport(statement.exportClause)) {
    imported.add(`${from}#*`);
  } else {
    named(statement.exportClause.elements);
  }
}

// 3. Count every reference to those symbols, in one pass over the program's identifiers.
const wanted = new Set([...targets.values()].map((t) => t.name));
for (const source of program.getSourceFiles()) {
  if (source.isDeclarationFile || source.fileName.includes('/node_modules/')) continue;
  const file = rel(source.fileName);
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
      recordImport(statement);
  }
  const visit = (node) => {
    if (ts.isIdentifier(node) && wanted.has(node.text)) {
      const at = checker.getSymbolAtLocation(node);
      const target = at && targets.get(resolveAlias(at));
      const declaration = target && at.declarations?.[0];
      const isOwnDeclaration = declaration && ts.getNameOfDeclaration(declaration) === node;
      if (target && !isOwnDeclaration) {
        // An import or re-export statement is not a use by itself.
        const inImportOrExport = ts.findAncestor(
          node,
          (n) => ts.isImportDeclaration(n) || ts.isExportDeclaration(n),
        );
        if (!inImportOrExport) {
          if (file === target.declaredIn) target.localUses++;
          else target.uses.add(file);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

const unused = [];
const localOnly = [];
for (const t of targets.values()) {
  if (t.uses.size > 0) continue;
  (t.localUses > 0 ? localOnly : unused).push(`${t.declaredIn}  ${t.name}`);
}

const unusedReExports = reExports
  .filter(({ file, name }) => !imported.has(`${file}#${name}`) && !imported.has(`${file}#*`))
  .map(({ file, name }) => `${file}  ${name}`);

if (unused.length + localOnly.length + unusedReExports.length === 0) {
  console.log(
    `check:dead-code: no dead exports (${candidates.length} ts-prune candidates checked)`,
  );
} else {
  if (unused.length) console.error(`Unused (delete):\n  ${unused.sort().join('\n  ')}`);
  if (localOnly.length) {
    console.error(
      `Exported but only used in their own file (drop "export"):\n  ${localOnly.sort().join('\n  ')}`,
    );
  }
  if (unusedReExports.length) {
    console.error(
      `Re-exported but never imported from there (remove from the export list):\n  ${unusedReExports.sort().join('\n  ')}`,
    );
  }
  process.exitCode = 1;
}
