/**
 * @swarm/vault: the vault Worker's contract (api.ts), the client callers wrap their binding in
 * (client.ts) and an in-process stand-in for tests that runs the same code (fake.ts). The
 * operations themselves are in ./core, which only workers/vault and the fake import.
 */
export * from './api';
export { useVaultForTests, vaultClient, vaultError, vaultValue, VAULT_TIMEOUT_MS } from './client';
export {
  createDownVault,
  createFakeVault,
  fakeVaultEnv,
  forgetProviderTokens,
  testVaultEnv,
} from './fake';
export { markerPort, openedOrNull, vaultFetch } from './ports';
export { checkVaultEnv, vaultEnvFields } from './env';
