/**
 * Test fixtures only: the sealing primitives, for callers' tests that seed stored values in the
 * legacy format (as a database from before the vault holds them) or check what the vault stored.
 * Only the vault may import these at runtime; the lint rule (eslint.config.js) refuses this
 * module in any worker's src.
 */
export { decrypt, encrypt, fromStored, toStored } from '@swarm/engine';
