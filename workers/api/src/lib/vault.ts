// The api's vault (workers/vault, ApiVault), and the engine ports built on it. The api holds no
// FIELD_KEYS and no Member Center or goods signing keys: every encrypted field, sealed secret, data
// request address and Member Center or goods link goes through the vault, which is handed the
// request's own credential (the session cookie, API key or OAuth token: c.get('credential')) and
// resolves it itself. Route policy stays here; the vault is a second boundary. Failures fail
// closed: a seal answers 503, an open shows encrypted fields as unavailable (null).
import type { FieldVault, GoodsLinkMinter, MemberLinkMinter, PrivacyVault } from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import {
  markerPort,
  vaultClient,
  vaultFetch,
  vaultValue,
  type CredentialPrincipal,
  type CredentialRef,
  type Principal,
  type StoredPrincipal,
} from '@swarm/vault';
import { env, type AppContext } from './context';

export const apiVault = (c: AppContext) => vaultClient('api', env(c).VAULT);

/** The request's own credential, for the vault. Every vault route sits behind sign-in. */
export function credentialOf(c: AppContext): CredentialPrincipal {
  const credential = c.get('credential');
  if (!credential) throw new ApiError('unauthorized', 'Sign in first.');
  return credential;
}

/** Erasure markers through the vault (no credential: rate-limited per workspace there). */
export const privacyVault = (c: AppContext): PrivacyVault => markerPort(apiVault(c));

/** Markers, and a data request's address sealed for its row (needs admin, checked by the vault). */
export function requestVault(c: AppContext): PrivacyVault {
  const vault = apiVault(c);
  return {
    ...markerPort(vault),
    sealRequestAddress: async (workspaceId, requestId, email) =>
      vaultValue(await vault.sealDsrAddress(credentialOf(c), { workspaceId, requestId, email })),
  };
}

/**
 * A Channel's encrypted fields under the request's credential. A seal that fails throws (503,
 * nothing saved). An open that fails leaves them null and adds the Members it was for to
 * `unavailableFor` (fail closed; the response flags them `encryptedUnavailable`); a refusal is
 * the vault's answer to a credential that may not read them, and is an error.
 */
export function memberFieldVault(
  c: AppContext,
  channelId: string,
): FieldVault & { unavailableFor: Set<string> } {
  const vault = apiVault(c);
  const port: FieldVault & { unavailableFor: Set<string> } = {
    unavailableFor: new Set(),
    seal: async (memberId, values) =>
      vaultValue(await vault.sealMemberFields(credentialOf(c), { channelId, memberId, values })),
    open: async (memberIds, fieldKeys) => {
      const result = await vault.openMemberFields(credentialOf(c), {
        channelId,
        memberIds,
        ...(fieldKeys ? { fieldKeys } : {}),
      });
      if (result.ok) return result.value;
      if (result.reason === 'unavailable' || result.reason === 'unreadable') {
        for (const id of memberIds) port.unavailableFor.add(id);
        return null;
      }
      return vaultValue(result);
    },
  };
  return port;
}

/** A provider fetch through the vault with `credential` attached there. */
export const providerFetch = (c: AppContext, principal: Principal, credential: CredentialRef) =>
  vaultFetch(apiVault(c), principal, credential);

/** A provider fetch under the request's own credential (dashboard and /v2 work). */
export const credentialFetch = (c: AppContext, credential: CredentialRef) =>
  providerFetch(c, credentialOf(c), credential);

/** A recorded payment event, the authority for the work that follows it. */
export type PaymentEvent = Extract<StoredPrincipal, { kind: 'payment-event' }>;

/**
 * Member Center links minted by the vault: under the request's credential (Direct Sends,
 * Champions mail: editor or sends:write on the Channel) or a recorded payment event.
 */
export function vaultMemberLinks(
  c: AppContext,
  principal: CredentialPrincipal | PaymentEvent,
): MemberLinkMinter {
  const vault = apiVault(c);
  return {
    memberToken: async (member) => {
      const links = vaultValue(
        await vault.mintMemberLinks(principal, {
          channelId: member.channelId,
          memberIds: [member.memberId],
        }),
      );
      const token = links[member.memberId];
      if (!token) throw new ApiError('unavailable', 'The subscriber link could not be made.');
      return token;
    },
  };
}

/** Member Center links under the request's credential, resolved when one is minted. */
export const requestMemberLinks = (c: AppContext): MemberLinkMinter => ({
  memberToken: (member, options) =>
    vaultMemberLinks(c, credentialOf(c)).memberToken(member, options),
});

/** Goods links for a paid order, minted by the vault for a recorded payment event. */
export function vaultGoodsLinks(c: AppContext, event: PaymentEvent): GoodsLinkMinter {
  const vault = apiVault(c);
  const mint = async (channelId: string, orderId: string) =>
    vaultValue(await vault.mintGoodsLinks(event, { channelId, orderId }));
  return {
    libraryToken: async ({ channelId, orderId }) => (await mint(channelId, orderId)).library,
    orderToken: async ({ channelId, orderId }) => (await mint(channelId, orderId)).order,
  };
}
