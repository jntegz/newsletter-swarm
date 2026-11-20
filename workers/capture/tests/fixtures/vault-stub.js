// Stands in for the vault Worker (workers/vault) so this worker's VAULT service binding resolves
// in tests: its four named entrypoints answer ping and nothing else. Tests that exercise vault
// operations use the in-process fake instead (@swarm/vault createFakeVault, useVaultForTests),
// which runs the vault's own code; workers/vault/tests covers the real bindings.
import { WorkerEntrypoint } from 'cloudflare:workers';

const entrypoint = (name) =>
  class extends WorkerEntrypoint {
    fetch() {
      return new Response('Not found', { status: 404 });
    }
    ping() {
      return { ok: true, entrypoint: name };
    }
  };

export const ApiVault = entrypoint('api');
export const CaptureVault = entrypoint('capture');
export const SiteVault = entrypoint('site');
export const JobsVault = entrypoint('jobs');

export default {
  fetch() {
    return new Response('Not found', { status: 404 });
  },
};
