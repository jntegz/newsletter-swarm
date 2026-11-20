/**
 * Every place in D1 that holds a value sealed with FIELD_KEYS (packages/engine/src/fields.ts:
 * `<kid>.<iv>.<ciphertext>`, `<purpose>~<kid>.<iv>.<ciphertext>`, or the vault's row-bound
 * `fv3.<purpose>.<kid>.<iv>.<ciphertext>`). The jobs worker and the vault's cron walk these to
 * seal each value again with the current key after a rotation, the vault also into v3 (its
 * core/columns.ts says how each place's row binding is read), and `pnpm swarm rotate-keys
 * FIELD_KEYS --retire` counts what is still sealed with an older one. A new sealed column belongs
 * here, or an old key could be removed while it still opens something.
 */
export interface SealedColumn {
  table: string;
  column: string;
  /** The primary key columns, to walk the table in order. */
  key: readonly string[];
  /** Set when the column is a JSON object holding the sealed value at this path. */
  jsonPath?: string;
}

export const FIELD_SEALED_COLUMNS: readonly SealedColumn[] = [
  { table: 'member_field_values', column: 'value_enc', key: ['member_id', 'field_id'] },
  { table: 'flows', column: 'webhook_secret_enc', key: ['id'] },
  { table: 'webhook_endpoints', column: 'secret_enc', key: ['id'] },
  { table: 'webhook_endpoints', column: 'previous_secret_enc', key: ['id'] },
  { table: 'totp_secrets', column: 'secret_enc', key: ['operator_id'] },
  { table: 'sso_connections', column: 'config_json', key: ['id'], jsonPath: '$.clientSecretEnc' },
  { table: 'export_destinations', column: 'credentials_enc', key: ['id'] },
  { table: 'dsr_requests', column: 'email_enc', key: ['id'] },
  { table: 'address_confirmations', column: 'email_enc', key: ['id'] },
  { table: 'copilot_keys', column: 'key_enc', key: ['id'] },
  { table: 'app_connections', column: 'key_enc', key: ['id'] },
  { table: 'stripe_accounts', column: 'own_key_enc', key: ['channel_id'] },
  { table: 'stripe_accounts', column: 'webhook_secret_enc', key: ['channel_id'] },
  { table: 'paypal_accounts', column: 'secret_enc', key: ['channel_id'] },
];

/** The sealed value of a place, as SQL; `table` qualifies the column. */
export function sealedValueSql(place: SealedColumn, table?: string): string {
  const column = table ? `${table}.${place.column}` : place.column;
  return place.jsonPath ? `json_extract(${column}, '${place.jsonPath}')` : column;
}

/**
 * SQL that is true when the place holds a value sealed with a key other than the one bound at
 * `?<param>` (the kid starts the value, follows `<purpose>~`, or is the third part of `fv3.…`).
 */
export function sealedWithOtherKeySql(place: SealedColumn, param = 1): string {
  const value = sealedValueSql(place);
  const v3Rest = `substr(${value}, 5)`;
  const v3Kid = `substr(${v3Rest}, instr(${v3Rest}, '.') + 1)`;
  return `(${value} IS NOT NULL AND CASE WHEN ${value} LIKE 'fv3.%' THEN instr(${v3Kid}, ?${param} || '.') <> 1 ELSE (instr(${value}, ?${param} || '.') <> 1 AND instr(${value}, '~' || ?${param} || '.') = 0) END)`;
}
