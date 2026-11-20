/**
 * How the vault seals and opens each kind of stored value, in both formats:
 * - v3 (fields.ts sealV3), bound to the row: what it writes once VAULT_WRITE_FORMAT is v3;
 * - the legacy format each kind had before the vault (what callers holding FIELD_KEYS still read
 *   while VAULT_WRITE_FORMAT is legacy), which opens only while VAULT_LEGACY_OPEN is on.
 *
 * The row binding is always built here from ids the vault read from D1 or checked against it,
 * never from a value inside the plaintext. COLUMN_SPECS says, for the re-seal cron, how each
 * sealed column's binding is read in SQL; a new sealed column needs an entry, or the cron refuses
 * to start (columns.test.ts).
 */
import { FIELD_SEALED_COLUMNS, type SealedColumn } from '@swarm/domain';
import {
  decrypt,
  decryptFor,
  encrypt,
  encryptFor,
  isSealedV3,
  openV3,
  sealedBinding,
  sealV3,
  type SealedBindingParts,
} from '@swarm/engine';
import type { VaultContext } from './context';

type LegacyForm =
  /** `encrypt(plaintext)`: profile fields (JSON of the value), webhook, Flow, TOTP and SSO secrets. */
  | 'plain'
  /** `encryptFor('dsr-address', email)`: data request and address confirmation addresses. */
  | 'dsr'
  /** `encrypt(JSON {w, k})`: provider keys (shorthop.ts sealAppKey) and Copilot keys. */
  | 'workspace-json'
  /** `encrypt(JSON {w, d, accessKeyId, secretAccessKey})`: export destination credentials. */
  | 'destination-json';

interface KindSpec {
  purpose: string;
  legacy: LegacyForm;
}

export const SEALED_KINDS = {
  'member-field': { purpose: 'member-field', legacy: 'plain' },
  'dsr-address': { purpose: 'dsr-address', legacy: 'dsr' },
  'webhook-secret': { purpose: 'webhook-secret', legacy: 'plain' },
  'flow-webhook-secret': { purpose: 'flow-webhook-secret', legacy: 'plain' },
  totp: { purpose: 'totp', legacy: 'plain' },
  'sso-client-secret': { purpose: 'sso-client-secret', legacy: 'plain' },
  'export-credentials': { purpose: 'export-credentials', legacy: 'destination-json' },
  'copilot-key': { purpose: 'copilot-key', legacy: 'workspace-json' },
  'app-key': { purpose: 'app-key', legacy: 'workspace-json' },
} as const satisfies Record<string, KindSpec>;

type SealedKind = keyof typeof SEALED_KINDS;

/**
 * Seals `plaintext` of `kind` for the row `parts` names, in the format the vault writes now. For
 * export credentials the plaintext is JSON `{accessKeyId, secretAccessKey}`.
 */
export async function sealValue(
  ctx: VaultContext,
  kind: SealedKind,
  parts: SealedBindingParts,
  plaintext: string,
): Promise<string> {
  const spec: KindSpec = SEALED_KINDS[kind];
  const binding = sealedBinding(parts);
  const keys = ctx.keys.field;
  if (ctx.config.writeFormat === 'v3') return sealV3(keys, spec.purpose, binding, plaintext);
  switch (spec.legacy) {
    case 'plain':
      return encrypt(keys, plaintext);
    case 'dsr':
      return encryptFor(keys, 'dsr-address', plaintext);
    case 'workspace-json':
      return encrypt(keys, JSON.stringify({ w: parts.w, k: plaintext }));
    case 'destination-json': {
      const creds = JSON.parse(plaintext) as Record<string, unknown>;
      return encrypt(keys, JSON.stringify({ w: parts.w, d: parts.d, ...creds }));
    }
  }
}

/**
 * Opens a stored value of `kind` read from the row `parts` names. Null when it does not open: no
 * key, another row's value, another kind's, or a legacy value while legacy opening is off.
 */
export async function openValue(
  ctx: VaultContext,
  kind: SealedKind,
  parts: SealedBindingParts,
  sealed: string,
): Promise<string | null> {
  const spec: KindSpec = SEALED_KINDS[kind];
  const keys = ctx.keys.field;
  if (isSealedV3(sealed)) return openV3(keys, spec.purpose, sealedBinding(parts), sealed);
  if (!ctx.config.legacyOpen) return null;
  switch (spec.legacy) {
    case 'plain':
      // A value sealed for a purpose (`<purpose>~…`) is never a plain one.
      return sealed.includes('~') ? null : decrypt(keys, sealed);
    case 'dsr':
      return decryptFor(keys, 'dsr-address', sealed);
    case 'workspace-json': {
      const plain = sealed.includes('~') ? null : await decrypt(keys, sealed);
      const parsed = parseJson(plain);
      return parsed && parsed.w === parts.w && typeof parsed.k === 'string' ? parsed.k : null;
    }
    case 'destination-json': {
      const parsed = parseJson(sealed.includes('~') ? null : await decrypt(keys, sealed));
      if (!parsed) return null;
      // Credentials saved before {w, d} existed carry neither, and are accepted as the engine does.
      if (
        (parsed.w !== undefined || parsed.d !== undefined) &&
        (parsed.w !== parts.w || parsed.d !== parts.d)
      ) {
        return null;
      }
      const { accessKeyId, secretAccessKey } = parsed;
      if (typeof accessKeyId !== 'string' || typeof secretAccessKey !== 'string') return null;
      return JSON.stringify({ accessKeyId, secretAccessKey });
    }
  }
}

function parseJson(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// ---- Columns, for the re-seal cron -------------------------------------------------------------

interface ColumnSpec {
  kind: SealedKind;
  /** SQL per binding part, evaluated on the row (`<table>.<column>` is in scope). */
  binding: Partial<Record<keyof SealedBindingParts, string>>;
}

const memberWorkspace = (table: string) =>
  `(SELECT c.workspace_id FROM members m JOIN channels c ON c.id = m.channel_id WHERE m.id = ${table}.member_id)`;

/** Keyed by `table.column`, for every place in FIELD_SEALED_COLUMNS. */
export const COLUMN_SPECS: Readonly<Record<string, ColumnSpec>> = {
  'member_field_values.value_enc': {
    kind: 'member-field',
    binding: {
      w: memberWorkspace('member_field_values'),
      c: '(SELECT m.channel_id FROM members m WHERE m.id = member_field_values.member_id)',
      m: 'member_field_values.member_id',
      f: 'member_field_values.field_id',
    },
  },
  'flows.webhook_secret_enc': {
    kind: 'flow-webhook-secret',
    binding: { w: 'flows.workspace_id', fl: 'flows.id' },
  },
  'webhook_endpoints.secret_enc': {
    kind: 'webhook-secret',
    binding: { w: 'webhook_endpoints.workspace_id', e: 'webhook_endpoints.id' },
  },
  'webhook_endpoints.previous_secret_enc': {
    kind: 'webhook-secret',
    binding: { w: 'webhook_endpoints.workspace_id', e: 'webhook_endpoints.id' },
  },
  'totp_secrets.secret_enc': { kind: 'totp', binding: { o: 'totp_secrets.operator_id' } },
  'sso_connections.config_json': {
    kind: 'sso-client-secret',
    binding: { w: 'sso_connections.workspace_id', sso: 'sso_connections.id' },
  },
  'export_destinations.credentials_enc': {
    kind: 'export-credentials',
    binding: { w: 'export_destinations.workspace_id', d: 'export_destinations.id' },
  },
  'dsr_requests.email_enc': {
    kind: 'dsr-address',
    binding: { w: 'dsr_requests.workspace_id', r: 'dsr_requests.id' },
  },
  'address_confirmations.email_enc': {
    kind: 'dsr-address',
    // Bound to the address's keyed marker, which the row holds: its id is assigned on insert.
    binding: { w: 'address_confirmations.workspace_id', ac: 'address_confirmations.email_hash' },
  },
  'copilot_keys.key_enc': {
    kind: 'copilot-key',
    binding: { w: 'copilot_keys.workspace_id', copilot: 'copilot_keys.id' },
  },
  'app_connections.key_enc': {
    kind: 'app-key',
    binding: {
      w: 'app_connections.workspace_id',
      app: 'app_connections.id',
      kind: 'app_connections.app',
    },
  },
  'stripe_accounts.own_key_enc': {
    kind: 'app-key',
    binding: {
      w: 'stripe_accounts.workspace_id',
      c: 'stripe_accounts.channel_id',
      kind: "'stripe-own'",
    },
  },
  'stripe_accounts.webhook_secret_enc': {
    kind: 'app-key',
    binding: {
      w: 'stripe_accounts.workspace_id',
      c: 'stripe_accounts.channel_id',
      kind: "'stripe-webhook'",
    },
  },
  'paypal_accounts.secret_enc': {
    kind: 'app-key',
    binding: {
      w: 'paypal_accounts.workspace_id',
      c: 'paypal_accounts.channel_id',
      kind: "'paypal'",
    },
  },
};

const placeKey = (place: SealedColumn) => `${place.table}.${place.column}`;

/** The column spec of a place; throws for a sealed column the vault does not know (a bug). */
export function columnSpec(place: SealedColumn): ColumnSpec {
  const spec = COLUMN_SPECS[placeKey(place)];
  if (!spec) throw new Error(`no binding for sealed column ${placeKey(place)}`);
  return spec;
}

/** Every sealed column has a spec: checked when the cron starts. */
export function assertColumnSpecs(): void {
  for (const place of FIELD_SEALED_COLUMNS) columnSpec(place);
}

/** The SQL that selects a place's binding parts as `b_<part>` columns. */
export function bindingColumnsSql(place: SealedColumn): string {
  return Object.entries(columnSpec(place).binding)
    .map(([part, sql]) => `${sql} AS b_${part}`)
    .join(', ');
}

/** The binding parts of a row read with bindingColumnsSql; null when one is missing. */
export function bindingFromRow(
  place: SealedColumn,
  row: Record<string, unknown>,
): SealedBindingParts | null {
  const parts: Record<string, string> = {};
  for (const part of Object.keys(columnSpec(place).binding)) {
    const value = row[`b_${part}`];
    if (typeof value !== 'string' || !value) return null;
    parts[part] = value;
  }
  return parts as SealedBindingParts;
}
