/**
 * The vault's operations. Only workers/vault and the fake (../fake.ts) import this: it opens
 * sealed values, so a caller importing it would hold FIELD_KEYS authority again.
 */
export { pruneVaultRecords } from './audit';
export { contextFromEnv } from './env';
export { opsFor } from './ops';
export { resealToCurrent } from './reseal';
export { COLUMN_SPECS, openValue } from './sealing';
