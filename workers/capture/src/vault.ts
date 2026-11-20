// The capture worker's vault (workers/vault, CaptureVault), and the engine ports built on it.
// Capture holds no FIELD_KEYS, no member or signup signing key, no platform Stripe key and no
// DeBounce key. Everything that needs one goes through the vault with the evidence capture has
// for the person: a Member Center link, a confirm request just confirmed, an address typed into a
// public form (rate-limited there). Failures fail closed: a seal answers 503, an open shows the
// encrypted fields as unavailable, a link that can't be minted isn't sent.
import {
  MemberLinkRefused,
  VAULT_HELD_KEY,
  debounceClient,
  type DebounceClient,
  type FieldValues,
  type MemberLinkMinter,
  type PayPalVault,
  type PrivacyVault,
} from '@swarm/engine';
import {
  markerPort,
  openedOrNull,
  vaultClient,
  vaultFetch,
  vaultValue,
  type MemberLinkEvidence,
} from '@swarm/vault';
import type { CaptureEnv } from './env';

export const captureVault = (e: CaptureEnv) => vaultClient('capture', e.VAULT);

/** Erasure markers through the vault (rate-limited there per workspace). */
export const captureMarkers = (e: CaptureEnv): PrivacyVault => markerPort(captureVault(e));

/** A Member Center link holder's own data requests: the vault seals the link's Member's address. */
export function memberPrivacy(e: CaptureEnv, token: string): PrivacyVault {
  const vault = captureVault(e);
  return {
    ...markerPort(vault),
    sealRequestAddress: async (_workspaceId, requestId) =>
      vaultValue(await vault.sealMemberDsrAddress({ token, requestId })),
  };
}

/** An erasure confirmed from the inbox: the vault seals the confirmation's Member's address. */
export function erasurePrivacy(
  e: CaptureEnv,
  link: { confirmationId: number; memberId: string; nonce: string | null },
): PrivacyVault {
  const vault = captureVault(e);
  return {
    ...markerPort(vault),
    sealRequestAddress: async (_workspaceId, requestId) =>
      vaultValue(await vault.sealErasureAddress({ ...link, requestId })),
  };
}

/** The public request page: a typed address sealed for its confirmation, opened once confirmed. */
export function addressPrivacy(e: CaptureEnv): PrivacyVault {
  const vault = captureVault(e);
  return {
    ...markerPort(vault),
    sealAddressConfirmation: async (channelId, email) =>
      vaultValue(await vault.sealAddressConfirmation({ channelId, email })),
    openAddressConfirmation: async (confirmationId, workspaceId) =>
      openedOrNull(await vault.openAddressConfirmation({ confirmationId, workspaceId })),
    sealConfirmedAddress: async (confirmationId, workspaceId, requestId) =>
      vaultValue(await vault.sealConfirmedAddress({ confirmationId, workspaceId, requestId })),
  };
}

/**
 * Member Center links the vault mints from `evidence`, for the Members it names. A Member the
 * vault made no link for gets none (MemberLinkRefused: the mail isn't sent). One call per minter.
 */
export function evidenceLinks(e: CaptureEnv, evidence: MemberLinkEvidence): MemberLinkMinter {
  let minted: Promise<{ memberId: string; token: string }[] | null> | null = null;
  return {
    memberToken: async (member) => {
      minted ??= (async () => openedOrNull(await captureVault(e).mintMemberLink(evidence)))();
      const links = await minted;
      const link = links?.find((l) => l.memberId === member.memberId);
      if (!link) throw new MemberLinkRefused();
      return link.token;
    },
  };
}

/** Where no evidence is at hand: no Member Center link is minted. */
export const noMemberLinks: MemberLinkMinter = {
  memberToken: () => Promise.reject(new MemberLinkRefused()),
};

/** Seals profile edits from the Member Center for the link's own Member. */
export const memberCenterSealer =
  (e: CaptureEnv, token: string) => async (_memberId: string, values: FieldValues) =>
    vaultValue(await captureVault(e).sealMemberCenterFields({ token, values }));

/**
 * The link's Member's encrypted fields, opened by the vault (only within an hour of an emailed
 * link: otherwise none). Null when the vault can't be reached: they show as unavailable.
 */
export async function memberCenterFields(
  e: CaptureEnv,
  token: string,
): Promise<FieldValues | null> {
  const opened = await captureVault(e).openMemberCenter({ token });
  if (opened.ok) return opened.value.fields;
  return opened.reason === 'unavailable' || opened.reason === 'unreadable' ? null : {};
}

/** Stripe for the link's Member (their own subscription, customer and portal only). */
export const memberStripeFetch = (e: CaptureEnv, token: string, channelId: string) =>
  vaultFetch(captureVault(e), { kind: 'member-link', token }, { kind: 'stripe', channelId });

/** PayPal for the link's Member (canceling their own subscription). */
export const memberPayPal = (e: CaptureEnv, token: string): Pick<PayPalVault, 'fetchFor'> => ({
  fetchFor: (channelId) =>
    vaultFetch(captureVault(e), { kind: 'member-link', token }, { kind: 'paypal', channelId }),
});

/**
 * The install's DeBounce for a sign-up check, through the vault (which holds the key and answers
 * "not allowed" when there is none: the sign-up then goes ahead unchecked).
 */
export const signupDebounce = (e: CaptureEnv, channelId: string): DebounceClient =>
  debounceClient(
    VAULT_HELD_KEY,
    vaultFetch(
      captureVault(e),
      { kind: 'public-channel', channelId },
      { kind: 'debounce', channelId },
    ),
  );
