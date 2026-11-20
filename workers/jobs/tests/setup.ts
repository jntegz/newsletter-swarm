import { applyD1Migrations, env } from 'cloudflare:test';
import { createFakeVault, fakeVaultEnv, useVaultForTests } from '@swarm/vault';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
// The vault's own code in process, on this test D1, with the same field key as TEST_FIELD_KEYS.
useVaultForTests('jobs', createFakeVault('jobs', await fakeVaultEnv(env.DB)));
