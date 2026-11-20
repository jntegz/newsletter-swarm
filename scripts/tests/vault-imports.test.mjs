// The lint rule that keeps FIELD_KEYS authority in the vault (eslint.config.js): only
// packages/vault and workers/vault may import the sealing primitives, and no worker's runtime
// code may take the test fixtures that re-export them.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const eslint = new ESLint({ cwd: root });

async function problems(file, code) {
  const [result] = await eslint.lintText(code, { filePath: join(root, file) });
  return result.messages.filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message);
}

const sealing = "import { decrypt, encrypt } from '@swarm/engine';\nexport { decrypt, encrypt };\n";

test('a caller may not import the sealing primitives', async () => {
  for (const file of [
    'workers/api/src/lib/x.ts',
    'workers/capture/src/x.ts',
    'workers/site/src/x.ts',
    'workers/jobs/src/x.ts',
    'apps/setup/src/x.ts',
  ]) {
    assert.equal((await problems(file, sealing)).length, 2, file);
  }
  const toStored =
    "import { macFor, toStored } from '@swarm/engine';\nexport { macFor, toStored };\n";
  assert.equal((await problems('workers/api/src/x.ts', toStored)).length, 2);
});

test('the vault may, and so may callers take the rest of the engine', async () => {
  assert.deepEqual(await problems('packages/vault/src/core/x.ts', sealing), []);
  assert.deepEqual(await problems('workers/vault/src/x.ts', sealing), []);
  const fine = "import { channelFields } from '@swarm/engine';\nexport { channelFields };\n";
  assert.deepEqual(await problems('workers/api/src/x.ts', fine), []);
});

test('the test fixtures and the vault core stay out of runtime code', async () => {
  const fixtures = "import { encrypt } from '@swarm/vault/testing';\nexport { encrypt };\n";
  assert.equal((await problems('workers/jobs/src/x.ts', fixtures)).length, 1);
  assert.deepEqual(await problems('workers/jobs/tests/x.test.ts', fixtures), []);
  const core = "import { opsFor } from '@swarm/vault/core';\nexport { opsFor };\n";
  assert.equal((await problems('workers/api/tests/x.test.ts', core)).length, 1);
});
