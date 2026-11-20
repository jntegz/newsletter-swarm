// plan/00-audit.md §5, the two rows about the code's shape rather than its behaviour: the capture
// worker's automation steps were a copy of the API's, and its suite ran with --passWithNoTests.
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

test('the capture worker has no step engine of its own: it runs through @swarm/engine', () => {
  for (const file of sources(join(ROOT, 'workers/capture/src'))) {
    const text = readFileSync(file, 'utf8');
    for (const copy of [/function\s+runStep\b/, /function\s+(enroll|enrol)\w*\b/, /flow_steps/]) {
      assert.doesNotMatch(text, copy, `${file} holds automation logic`);
    }
  }
  const subscribe = readFileSync(join(ROOT, 'workers/capture/src/routes/subscribe.ts'), 'utf8');
  assert.match(subscribe, /\bsubscribe,\n[\s\S]*from '@swarm\/engine'/);
  assert.doesNotMatch(subscribe, /INSERT INTO members/);
});

test('every worker runs a real test suite', () => {
  for (const name of readdirSync(join(ROOT, 'workers'))) {
    const dir = join(ROOT, 'workers', name);
    const { scripts } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.doesNotMatch(scripts.test, /passWithNoTests/, `${name} may pass without tests`);
    assert.ok(
      readdirSync(join(dir, 'tests')).some((file) => file.endsWith('.test.ts')),
      `${name} has no tests`,
    );
  }
});
