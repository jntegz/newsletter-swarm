/**
 * @swarm/tokens: signed, purpose-scoped, expiring tokens.
 *
 * - v1.ts: `v1.<purpose>.<kid>.<payload>.<mac>`, HMAC-SHA256 with one keyring per caller.
 * - links.ts: `v2.<purpose>.<kid>.<payload>.<sig>`, one keyring per family (families.ts), HMAC or
 *   Ed25519 as the family says, and the rule for v1 links issued before the cutover.
 */

export * from './keyring';
export * from './v1';
export * from './families';
export * from './keyrings';
export * from './links';
