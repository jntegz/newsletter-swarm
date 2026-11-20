/**
 * What engine code needs from FIELD_KEYS, as ports. Inside the vault Worker (workers/vault) these
 * are the keyring itself; in api, capture, site and jobs, which hold no FIELD_KEYS, they are the
 * vault's operations through the caller's binding (@swarm/vault), wrapped by the caller. A port
 * either answers or throws: a caller's adapter turns a vault that is down into its own error (503
 * on a request, a retry on a queue), so nothing here ever falls back to opening a value itself.
 */
import type { FieldValue } from '@swarm/domain';
import type { Keyring } from '@swarm/tokens';

/** @swarm/vault AddressMarkerSet, and privacy.ts AddressMarkers. */
export interface AddressMarkerForms {
  keyed: string;
  legacy: string;
  forms: string[];
}

/**
 * Privacy operations that need FIELD_KEYS (privacy.ts): erasure markers, the sealed address of a
 * data request, the sealed address of a public-page confirmation. Each caller offers what its
 * vault entrypoint allows in that context; an operation that is missing is refused.
 */
export interface PrivacyVault {
  /** The marker forms of an address in a workspace. */
  addressMarkers(workspaceId: string, email: string): Promise<AddressMarkerForms>;
  /** The same for many addresses (imports, bulk deletes), by lowercased address. */
  addressMarkersMany?(
    workspaceId: string,
    emails: string[],
  ): Promise<Record<string, AddressMarkerForms>>;
  /** Seals a data request's address for its row (dsr_requests.email_enc). */
  sealRequestAddress?(workspaceId: string, requestId: string, email: string): Promise<string>;
  /** A data request's address, or null when it can't be opened (lost key, another row's value). */
  openRequestAddress?(requestId: string): Promise<string | null>;
  /** Everything the workspace holds about a request's address (buildMemberExport), opened. */
  buildRequestExport?(requestId: string): Promise<Record<string, unknown>>;
  /** Seals an address typed into the public request page, with its keyed marker. */
  sealAddressConfirmation?(
    channelId: string,
    email: string,
  ): Promise<{ sealed: string; emailHash: string }>;
  /** The address of an unused, unexpired public-page confirmation, or null. */
  openAddressConfirmation?(confirmationId: number, workspaceId: string): Promise<string | null>;
  /** Seals that confirmation's address again for the data request it files. */
  sealConfirmedAddress?(
    confirmationId: number,
    workspaceId: string,
    requestId: string,
  ): Promise<string>;
}

/** FIELD_KEYS (the vault), the vault (callers), or neither (salted markers only). */
export type PrivacyKeys = Keyring | PrivacyVault | undefined;

export const isPrivacyVault = (keys: PrivacyKeys): keys is PrivacyVault =>
  !!keys && typeof (keys as PrivacyVault).addressMarkers === 'function';

/** Raised when a privacy operation needs a vault operation this caller doesn't have here. */
export class VaultPortMissing extends Error {
  constructor(operation: string) {
    super(`The vault operation ${operation} is not available here.`);
    this.name = 'VaultPortMissing';
  }
}

/** Encrypted profile field values by key. */
export type FieldValues = Record<string, FieldValue>;

/**
 * Encrypted profile fields of Members of one Channel, through the vault. `seal` seals values for
 * one Member's rows (throws when it can't: the write must not happen); `open` opens the encrypted
 * fields of several Members, or answers null when the vault can't be reached and the caller shows
 * them as unavailable (a queue path's port throws instead, so the work is retried).
 */
export interface FieldVault {
  seal(memberId: string, values: FieldValues): Promise<Record<string, string>>;
  open(memberIds: string[], fieldKeys?: string[]): Promise<Record<string, FieldValues> | null>;
}

/** A fetch whose requests the vault sends with a stored provider credential attached. */
export type ProviderFetch = typeof fetch;
