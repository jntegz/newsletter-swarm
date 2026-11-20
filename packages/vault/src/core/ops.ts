/**
 * The four entrypoints' operations, on one context per call. workers/vault's entrypoint classes
 * and the in-process fake (fake.ts) both expose exactly these, so a test of a caller against the
 * fake exercises the same authorization as the deployed vault.
 *
 * Every call goes through `step`: one log line with the op, the entrypoint, the principal kind,
 * the tenant, a count, the decision and the time taken (never a value); a vault_audit row for a
 * refusal or a rate-limit hit; and any failure as a VaultResult, so nothing throws across RPC.
 */
import { first } from '@swarm/db';
import type {
  ApiVault,
  CaptureVault,
  CredentialPrincipal,
  JobsVault,
  Principal,
  PrincipalKind,
  SiteVault,
  StoredPrincipal,
  VaultCaller,
  VaultFor,
  VaultResult,
} from '../api';
import { recordBulkOpen, subjectHash, writeVaultAudit } from './audit';
import { fail, invalid, ok, plainRecord, refuse, VaultRefusal, type VaultContext } from './context';
import {
  addressMarkers,
  addressMarkersBulk,
  buildRequestExport,
  openAddressConfirmation,
  openRequestAddress,
  sealAddressConfirmation,
  sealConfirmedAddress,
  sealErasureAddress,
  sealRequestAddress,
} from './dsr';
import { openMemberFields, sealMemberFields } from './fields';
import {
  mintChannelMemberLinks,
  mintGoodsLinkFromEvidence,
  mintJoinToken,
  mintJourneyToken,
  mintMemberLinkFromEvidence,
  mintOrderGoodsLinks,
  openJoinToken,
  openJourneyToken,
} from './mint';
import {
  reachChannel,
  reachWorkspace,
  resolveCredential,
  resolvedId,
  resolveStored,
  verifyMemberLink,
} from './principals';
import { checkCredential, providerFetch, providerStream } from './proxy';
import { take } from './ratelimit';
import { sealValue } from './sealing';
import {
  beginTotp,
  confirmTotp,
  createFlowWebhookSecret,
  createWebhookSecret,
  credentialWorkspace,
  flowForSecret,
  hasNoFactor,
  sealCredential,
  signDestinationRequest,
  signFlowWebhook,
  signWebhookDelivery,
  ssoTokenExchange,
  verifyStripeWebhook,
  verifyTotp,
} from './secrets';

/** What an operation says about itself for the log and the audit row. */
interface Note {
  principalKind: PrincipalKind | 'none';
  principalId?: string | null;
  workspaceId?: string | null;
  channelId?: string | null;
  count?: number;
}

const kindOf = (principal: unknown): PrincipalKind | 'none' => {
  const kind = (principal as { kind?: unknown } | null)?.kind;
  return typeof kind === 'string' ? (kind.slice(0, 40) as PrincipalKind) : 'none';
};

async function step<T>(
  ctx: VaultContext,
  op: string,
  principal: unknown,
  body: (note: Note) => Promise<T>,
): Promise<VaultResult<T>> {
  const started = Date.now();
  const note: Note = { principalKind: kindOf(principal) };
  const line = (decision: string, reason?: string) => ({
    op,
    entrypoint: ctx.caller,
    principal: note.principalKind,
    workspaceId: note.workspaceId ?? null,
    channelId: note.channelId ?? null,
    count: note.count ?? 0,
    decision,
    ...(reason ? { reason } : {}),
    ms: Date.now() - started,
  });
  try {
    const value = await body(note);
    ctx.log.info('vault op', line('allowed'));
    return ok(value);
  } catch (error) {
    if (error instanceof VaultRefusal) {
      const decision = error.reason === 'rate_limited' ? 'rate_limited' : 'refused';
      ctx.log.warn('vault op', line(decision, error.reason));
      if (error.reason !== 'invalid' && error.reason !== 'not_found') {
        await writeVaultAudit(ctx, {
          op,
          principalKind: note.principalKind,
          principalId: note.principalId ?? null,
          workspaceId: note.workspaceId ?? null,
          channelId: note.channelId ?? null,
          decision: decision === 'rate_limited' ? 'rate_limited' : 'refused',
          reason: error.detail ?? error.reason,
        }).catch(() => undefined);
      }
      return fail(error.reason);
    }
    ctx.log.error('vault op failed', { ...line('failed'), error: (error as Error).message });
    return fail('unavailable');
  }
}

/** The caller's principal must be one of these kinds, or the call is refused before any lookup. */
function expectKind<K extends PrincipalKind>(principal: unknown, kinds: readonly K[]): K {
  const kind = kindOf(principal);
  if (!(kinds as readonly string[]).includes(kind)) return refuse('principal kind');
  return kind as K;
}

const CREDENTIAL_KINDS = ['operator-session', 'api-key', 'oauth'] as const;
const ping = (ctx: VaultContext) => async () => ({
  ok: true as const,
  entrypoint: ctx.caller,
});

type Ctx = () => Promise<VaultContext>;

/** Runs `fn` with a fresh context: each method builds its own, so state never leaks between calls. */
const withCtx =
  <A extends unknown[], R>(make: Ctx, fn: (ctx: VaultContext, ...args: A) => Promise<R>) =>
  async (...args: A): Promise<R> => {
    let ctx: VaultContext;
    try {
      ctx = await make();
    } catch (error) {
      // A missing or malformed key or var: refuse everything rather than run without it.
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'vault environment is invalid',
          error: (error as Error).message,
        }),
      );
      return fail('unavailable') as R;
    }
    return fn(ctx, ...args);
  };

// ---- api ---------------------------------------------------------------------------------------

function apiOps(make: Ctx): ApiVault {
  const credential = async (ctx: VaultContext, principal: unknown, note: Note) => {
    expectKind(principal, CREDENTIAL_KINDS);
    const resolved = await resolveCredential(ctx, principal as CredentialPrincipal);
    note.principalId = resolvedId(resolved);
    return resolved;
  };
  return {
    ping: async () => ping(await make())(),
    openMemberFields: withCtx(make, (ctx, principal, args) =>
      step(ctx, 'openMemberFields', principal, async (note) => {
        const resolved = await credential(ctx, principal, note);
        const reach = await reachChannel(ctx, resolved, args?.channelId, {
          role: 'viewer',
          scope: 'members:read',
        });
        Object.assign(note, reach);
        const result = await openMemberFields(ctx, reach, args.memberIds, args.fieldKeys);
        note.count = result.opened;
        return result.values;
      }),
    ),
    sealMemberFields: withCtx(make, (ctx, principal, args) =>
      step(ctx, 'sealMemberFields', principal, async (note) => {
        const resolved = await credential(ctx, principal, note);
        const reach = await reachChannel(ctx, resolved, args?.channelId, {
          role: 'editor',
          scope: 'members:write',
        });
        Object.assign(note, reach);
        const sealed = await sealMemberFields(ctx, reach, args.memberId, args.values, {
          keepUnchanged: true,
        });
        note.count = Object.keys(sealed).length;
        return sealed;
      }),
    ),
    sealCredential: withCtx(make, (ctx, principal, args) =>
      step(ctx, 'sealCredential', principal, async (note) => {
        const resolved = await credential(ctx, principal, note);
        const ref = args?.ref;
        if (!ref || typeof ref !== 'object') invalid('ref');
        const workspaceId = await credentialWorkspace(ctx, ref);
        note.workspaceId = workspaceId;
        if ('channelId' in ref) {
          await reachChannel(ctx, resolved, ref.channelId, { role: 'admin', scope: null });
        } else {
          await reachWorkspace(ctx, resolved, workspaceId, { role: 'admin', scope: null });
        }
        return sealCredential(ctx, ref, workspaceId, args.plaintext);
      }),
    ),
    sealDsrAddress: withCtx(make, (ctx, principal, args) =>
      step(ctx, 'sealDsrAddress', principal, async (note) => {
        const resolved = await credential(ctx, principal, note);
        await reachWorkspace(ctx, resolved, args?.workspaceId, { role: 'admin', scope: null });
        note.workspaceId = args.workspaceId;
        return sealRequestAddress(ctx, args.workspaceId, args.requestId, args.email);
      }),
    ),
    createWebhookSecret: withCtx(make, (ctx, principal, args) =>
      step(ctx, 'createWebhookSecret', principal, async (note) => {
        const resolved = await credential(ctx, principal, note);
        await reachWorkspace(ctx, resolved, args?.workspaceId, {
          role: 'admin',
          scope: 'webhooks:write',
        });
        note.workspaceId = args.workspaceId;
        return createWebhookSecret(ctx, args.workspaceId, args.endpointId);
      }),
    ),
    createFlowWebhookSecret: withCtx(make, (ctx, principal, args) =>
      step(ctx, 'createFlowWebhookSecret', principal, async (note) => {
        const resolved = await credential(ctx, principal, note);
        const flow = await flowForSecret(ctx, args?.flowId);
        Object.assign(note, { workspaceId: flow.workspaceId, channelId: flow.channelId });
        await reachChannel(ctx, resolved, flow.channelId, { role: 'editor', scope: 'flows:write' });
        return createFlowWebhookSecret(ctx, flow.workspaceId, flow.flowId);
      }),
    ),
    beginTotp: withCtx(make, (ctx, principal) =>
      step(ctx, 'beginTotp', principal, async (note) => {
        expectKind(principal, ['operator-session']);
        const pending = await resolveCredential(ctx, principal, { allowPendingSecondFactor: true });
        if (pending.kind !== 'operator') return refuse('operator');
        note.principalId = pending.operatorId;
        // A session still waiting for its second factor may only enrol a first one.
        await resolveCredential(ctx, principal, {
          allowPendingSecondFactor: await hasNoFactor(ctx, pending.operatorId),
        });
        return beginTotp(ctx, pending.operatorId);
      }),
    ),
    confirmTotp: withCtx(make, (ctx, principal, args) =>
      step(ctx, 'confirmTotp', principal, async (note) => {
        expectKind(principal, ['operator-session']);
        const pending = await resolveCredential(ctx, principal, { allowPendingSecondFactor: true });
        if (pending.kind !== 'operator') return refuse('operator');
        note.principalId = pending.operatorId;
        await resolveCredential(ctx, principal, {
          allowPendingSecondFactor: await hasNoFactor(ctx, pending.operatorId),
        });
        return { step: await confirmTotp(ctx, pending.operatorId, args?.code) };
      }),
    ),
    verifyTotp: withCtx(make, (ctx, args) =>
      step(ctx, 'verifyTotp', { kind: 'operator-session' }, async (note) => {
        const resolved = await resolveCredential(
          ctx,
          { kind: 'operator-session', sessionToken: args?.sessionToken },
          { allowPendingSecondFactor: true },
        );
        if (resolved.kind !== 'operator') return refuse('operator');
        note.principalId = resolved.operatorId;
        return { step: await verifyTotp(ctx, resolved.operatorId, args.code) };
      }),
    ),
    sealSsoSecret: withCtx(make, (ctx, principal, args) =>
      step(ctx, 'sealSsoSecret', principal, async (note) => {
        const resolved = await credential(ctx, principal, note);
        await reachWorkspace(ctx, resolved, args?.workspaceId, { role: 'admin', scope: null });
        note.workspaceId = args.workspaceId;
        const row = await first<{ workspace_id: string }>(
          ctx.db,
          'SELECT workspace_id FROM sso_connections WHERE id = ?1',
          args.connectionId,
        );
        if (row && row.workspace_id !== args.workspaceId) refuse('connection');
        if (typeof args.connectionId !== 'string' || !args.connectionId) invalid('connection');
        if (
          typeof args.clientSecret !== 'string' ||
          !args.clientSecret ||
          args.clientSecret.length > 4096
        ) {
          invalid('secret');
        }
        return sealValue(
          ctx,
          'sso-client-secret',
          { w: args.workspaceId, sso: args.connectionId },
          args.clientSecret,
        );
      }),
    ),
    ssoTokenExchange: withCtx(make, (ctx, args) =>
      step(ctx, 'ssoTokenExchange', { kind: 'none' }, async (note) => {
        const { workspaceId, ...result } = await ssoTokenExchange(ctx, args ?? {});
        note.workspaceId = workspaceId;
        return result;
      }),
    ),
    verifyStripeWebhook: withCtx(make, (ctx, args) =>
      step(ctx, 'verifyStripeWebhook', { kind: 'none' }, async (note) => {
        note.channelId = args?.channelId ?? null;
        await verifyStripeWebhook(ctx, args?.channelId, args?.payload, args?.signature);
        return true as const;
      }),
    ),
    mintMemberLinks: withCtx(make, (ctx, principal, args) =>
      step(ctx, 'mintMemberLinks', principal, async (note) => {
        const kind = expectKind(principal, [...CREDENTIAL_KINDS, 'payment-event']);
        if (kind === 'payment-event') {
          const reach = await resolveStored(ctx, principal as StoredPrincipal);
          note.principalId = reach.id;
          if (reach.channelId !== args?.channelId) refuse('event of another channel');
        } else {
          const resolved = await credential(ctx, principal, note);
          await reachChannel(ctx, resolved, args?.channelId, {
            role: 'editor',
            scope: 'sends:write',
          });
        }
        note.channelId = args.channelId;
        const links = await mintChannelMemberLinks(ctx, args.channelId, args.memberIds, kind);
        note.count = Object.keys(links).length;
        return links;
      }),
    ),
    mintGoodsLinks: withCtx(make, (ctx, principal, args) =>
      step(ctx, 'mintGoodsLinks', principal, async (note) => {
        expectKind(principal, ['payment-event']);
        const reach = await resolveStored(ctx, principal);
        note.principalId = reach.id;
        if (reach.channelId !== args?.channelId) refuse('event of another channel');
        note.channelId = args.channelId;
        return mintOrderGoodsLinks(ctx, args.channelId, args.orderId);
      }),
    ),
    signDestinationRequest: withCtx(make, (ctx, principal, args) =>
      step(ctx, 'signDestinationRequest', principal, async (note) => {
        const resolved = await credential(ctx, principal, note);
        const destination = await first<{ workspace_id: string }>(
          ctx.db,
          'SELECT workspace_id FROM export_destinations WHERE id = ?1',
          args?.destinationId,
        );
        if (!destination) return refuse('destination');
        note.workspaceId = destination.workspace_id;
        await reachWorkspace(ctx, resolved, destination.workspace_id, {
          role: 'admin',
          scope: null,
        });
        const signed = await signDestinationRequest(ctx, args.destinationId, args.request);
        return { url: signed.url, headers: signed.headers };
      }),
    ),
    providerFetch: withCtx(make, (ctx, principal, ref, request) =>
      step(ctx, 'providerFetch', principal, async (note) => {
        note.channelId = (ref as { channelId?: string } | null)?.channelId ?? null;
        return providerFetch(ctx, principal as Principal, ref, request);
      }),
    ),
    providerStream: withCtx(make, (ctx, principal, ref, request) =>
      step(ctx, 'providerStream', principal, async (note) => {
        expectKind(principal, CREDENTIAL_KINDS);
        note.workspaceId = (ref as { workspaceId?: string } | null)?.workspaceId ?? null;
        return providerStream(ctx, principal, ref, request);
      }),
    ),
    checkCredential: withCtx(make, (ctx, principal, ref) =>
      step(ctx, 'checkCredential', principal, async (note) => {
        expectKind(principal, CREDENTIAL_KINDS);
        note.workspaceId = (ref as { workspaceId?: string } | null)?.workspaceId ?? null;
        return checkCredential(ctx, principal, ref);
      }),
    ),
    addressMarkers: withCtx(make, (ctx, args) =>
      step(ctx, 'addressMarkers', { kind: 'none' }, async (note) => {
        note.workspaceId = args?.workspaceId ?? null;
        return addressMarkers(ctx, args?.workspaceId, args?.email);
      }),
    ),
  };
}

// ---- capture -----------------------------------------------------------------------------------

/** The Member Center shows and edits profile fields only within an hour of an emailed link. */
const STEP_UP_MS = 3_600_000;

function captureOps(make: Ctx): CaptureVault {
  const memberCenter = async (ctx: VaultContext, token: unknown, note: Note) => {
    const link = await verifyMemberLink(ctx, token as string);
    Object.assign(note, {
      principalId: await subjectHash(link.memberId),
      workspaceId: link.workspaceId,
      channelId: link.channelId,
    });
    if (!(await take(ctx, 'member-center', link.memberId))) {
      throw new VaultRefusal('rate_limited', 'member center');
    }
    return { link, steppedUp: link.emailed && ctx.now() - link.issuedAt < STEP_UP_MS };
  };
  return {
    ping: async () => ping(await make())(),
    openMemberCenter: withCtx(make, (ctx, args) =>
      step(ctx, 'openMemberCenter', { kind: 'member-link' }, async (note) => {
        const { link, steppedUp } = await memberCenter(ctx, args?.token, note);
        const fields = steppedUp
          ? ((await openMemberFields(ctx, link, [link.memberId])).values[link.memberId] ?? {})
          : {};
        note.count = Object.values(fields).filter((value) => value !== null).length;
        return {
          memberId: link.memberId,
          channelId: link.channelId,
          emailed: link.emailed,
          issuedAt: link.issuedAt,
          fields,
        };
      }),
    ),
    sealMemberCenterFields: withCtx(make, (ctx, args) =>
      step(ctx, 'sealMemberCenterFields', { kind: 'member-link' }, async (note) => {
        const { link, steppedUp } = await memberCenter(ctx, args?.token, note);
        if (!steppedUp) refuse('needs a fresh emailed link');
        const sealed = await sealMemberFields(ctx, link, link.memberId, args.values, {
          mustExist: true,
          keepUnchanged: true,
        });
        note.count = Object.keys(sealed).length;
        return sealed;
      }),
    ),
    sealSignupFields: withCtx(make, (ctx, args) =>
      step(ctx, 'sealSignupFields', { kind: 'public-channel' }, async (note) => {
        if (typeof args?.formId !== 'string' || !args.formId) invalid('form');
        const form = await first<{ channel_id: string; workspace_id: string }>(
          ctx.db,
          `SELECT f.channel_id, f.workspace_id FROM capture_forms f JOIN channels c ON c.id = f.channel_id
            WHERE f.id = ?1 AND f.status = 'published' AND f.deleted_at IS NULL AND c.deleted_at IS NULL`,
          args.formId,
        );
        if (!form) return refuse('form');
        const reach = { workspaceId: form.workspace_id, channelId: form.channel_id };
        Object.assign(note, reach);
        const sealed = await sealMemberFields(ctx, reach, args.memberId, args.values);
        note.count = Object.keys(sealed).length;
        return sealed;
      }),
    ),
    mintJoinToken: withCtx(make, (ctx, args) =>
      step(ctx, 'mintJoinToken', { kind: 'public-channel' }, () => mintJoinToken(ctx, args ?? {})),
    ),
    mintJourneyToken: withCtx(make, (ctx, args) =>
      step(ctx, 'mintJourneyToken', { kind: 'public-channel' }, () =>
        mintJourneyToken(ctx, args ?? {}),
      ),
    ),
    openJourneyToken: withCtx(make, (ctx, args) =>
      step(ctx, 'openJourneyToken', { kind: 'public-channel' }, () =>
        openJourneyToken(ctx, args?.token),
      ),
    ),
    sealMemberDsrAddress: withCtx(make, (ctx, args) =>
      step(ctx, 'sealMemberDsrAddress', { kind: 'member-link' }, async (note) => {
        const link = await verifyMemberLink(ctx, args?.token);
        Object.assign(note, {
          principalId: await subjectHash(link.memberId),
          workspaceId: link.workspaceId,
          channelId: link.channelId,
        });
        return sealRequestAddress(ctx, link.workspaceId, args.requestId, link.email);
      }),
    ),
    sealErasureAddress: withCtx(make, (ctx, args) =>
      step(ctx, 'sealErasureAddress', { kind: 'none' }, async (note) => {
        note.principalId = String(args?.confirmationId ?? '');
        const { sealed, workspaceId } = await sealErasureAddress(ctx, args ?? {});
        note.workspaceId = workspaceId;
        return sealed;
      }),
    ),
    sealAddressConfirmation: withCtx(make, (ctx, args) =>
      step(ctx, 'sealAddressConfirmation', { kind: 'public-channel' }, async (note) => {
        note.channelId = args?.channelId ?? null;
        const { sealed, emailHash, workspaceId } = await sealAddressConfirmation(
          ctx,
          args?.channelId,
          args?.email,
        );
        note.workspaceId = workspaceId;
        return { sealed, emailHash };
      }),
    ),
    openAddressConfirmation: withCtx(make, (ctx, args) =>
      step(ctx, 'openAddressConfirmation', { kind: 'none' }, async (note) => {
        note.workspaceId = args?.workspaceId ?? null;
        note.principalId = String(args?.confirmationId ?? '');
        const email = await openAddressConfirmation(ctx, args?.confirmationId, args?.workspaceId);
        note.count = 1;
        return email;
      }),
    ),
    sealConfirmedAddress: withCtx(make, (ctx, args) =>
      step(ctx, 'sealConfirmedAddress', { kind: 'none' }, async (note) => {
        note.workspaceId = args?.workspaceId ?? null;
        note.principalId = String(args?.confirmationId ?? '');
        return sealConfirmedAddress(ctx, args?.confirmationId, args?.workspaceId, args?.requestId);
      }),
    ),
    mintMemberLink: withCtx(make, (ctx, evidence) =>
      step(ctx, 'mintMemberLink', { kind: 'member-link' }, async (note) => {
        const links = await mintMemberLinkFromEvidence(ctx, evidence);
        note.count = links.length;
        return links;
      }),
    ),
    providerFetch: withCtx(make, (ctx, principal, ref, request) =>
      step(ctx, 'providerFetch', principal, async (note) => {
        expectKind(principal, ['member-link', 'reader-session', 'public-channel']);
        note.channelId = (ref as { channelId?: string } | null)?.channelId ?? null;
        return providerFetch(ctx, principal, ref, request);
      }),
    ),
    addressMarkers: withCtx(make, (ctx, args) =>
      step(ctx, 'addressMarkers', { kind: 'none' }, async (note) => {
        note.workspaceId = args?.workspaceId ?? null;
        return addressMarkers(ctx, args?.workspaceId, args?.email);
      }),
    ),
  };
}

// ---- site --------------------------------------------------------------------------------------

function siteOps(make: Ctx): SiteVault {
  return {
    ping: async () => ping(await make())(),
    openJoinToken: withCtx(make, (ctx, args) =>
      step(ctx, 'openJoinToken', { kind: 'public-channel' }, async (note) => {
        note.channelId = args?.channelId ?? null;
        return openJoinToken(ctx, args?.token, args?.channelId);
      }),
    ),
    mintGoodsLink: withCtx(make, (ctx, evidence) =>
      step(ctx, 'mintGoodsLink', { kind: 'public-channel' }, async (note) => {
        note.channelId = evidence?.channelId ?? null;
        const links = await mintGoodsLinkFromEvidence(ctx, evidence);
        note.count = links ? 1 : 0;
        return links;
      }),
    ),
    providerFetch: withCtx(make, (ctx, principal, ref, request) =>
      step(ctx, 'providerFetch', principal, async (note) => {
        expectKind(principal, ['member-link', 'reader-session', 'public-channel']);
        note.channelId = (ref as { channelId?: string } | null)?.channelId ?? null;
        return providerFetch(ctx, principal, ref, request);
      }),
    ),
    // Gift Pass claims and checkouts must not bring an erased address back.
    addressMarkers: withCtx(make, (ctx, args) =>
      step(ctx, 'addressMarkers', { kind: 'none' }, async (note) => {
        note.workspaceId = args?.workspaceId ?? null;
        return addressMarkers(ctx, args?.workspaceId, args?.email);
      }),
    ),
  };
}

// ---- jobs --------------------------------------------------------------------------------------

const BULK_OPENS = {
  'export-job': { action: 'vault.export_open', targetType: 'export_job' },
  'export-destination': { action: 'vault.destination_open', targetType: 'export_destination' },
  'dsr-request': { action: 'vault.dsr_open', targetType: 'dsr_request' },
} as const;

function jobsOps(make: Ctx): JobsVault {
  const stored = async (
    ctx: VaultContext,
    principal: unknown,
    kinds: readonly StoredPrincipal['kind'][],
    note: Note,
  ) => {
    expectKind(principal, kinds);
    const reach = await resolveStored(ctx, principal as StoredPrincipal);
    Object.assign(note, {
      principalId: reach.id,
      workspaceId: reach.workspaceId,
      channelId: reach.channelId,
    });
    return reach;
  };
  return {
    ping: async () => ping(await make())(),
    openMemberFields: withCtx(make, (ctx, principal, args) =>
      step(ctx, 'openMemberFields', principal, async (note) => {
        const reach = await stored(
          ctx,
          principal,
          ['export-job', 'import-job', 'flow-run', 'export-destination', 'dsr-request'],
          note,
        );
        if (reach.channelId !== args?.channelId) refuse('another channel');
        const channel = { workspaceId: reach.workspaceId, channelId: args.channelId };
        const result = await openMemberFields(ctx, channel, args.memberIds, args.fieldKeys);
        note.count = result.opened;
        const kind = (principal as StoredPrincipal).kind;
        const bulk = BULK_OPENS[kind as keyof typeof BULK_OPENS];
        if (bulk) {
          await recordBulkOpen(ctx, {
            op: 'openMemberFields',
            action: bulk.action,
            principalKind: kind,
            principalId: reach.id,
            workspaceId: reach.workspaceId,
            channelId: args.channelId,
            count: result.opened,
            targetType: bulk.targetType,
          });
        }
        return result.values;
      }),
    ),
    sealMemberFieldsBulk: withCtx(make, (ctx, principal, args) =>
      step(ctx, 'sealMemberFieldsBulk', principal, async (note) => {
        const reach = await stored(ctx, principal, ['import-job', 'bulk-job', 'flow-run'], note);
        if (reach.channelId !== args?.channelId) refuse('another channel');
        if (!Array.isArray(args.rows) || args.rows.length > 1000) invalid('rows');
        const channel = { workspaceId: reach.workspaceId, channelId: args.channelId };
        const out: Record<string, Record<string, string>> = Object.create(null) as Record<
          string,
          Record<string, string>
        >;
        let count = 0;
        for (const row of args.rows) {
          const sealed = await sealMemberFields(ctx, channel, row?.memberId, row?.values, {
            keepUnchanged: true,
          });
          out[row.memberId] = sealed;
          count += Object.keys(sealed).length;
        }
        note.count = count;
        return plainRecord(out);
      }),
    ),
    openDsrAddress: withCtx(make, (ctx, principal) =>
      step(ctx, 'openDsrAddress', principal, async (note) => {
        const reach = await stored(ctx, principal, ['dsr-request'], note);
        note.count = 1;
        return (await openRequestAddress(ctx, reach.id)).email;
      }),
    ),
    buildDsrExport: withCtx(make, (ctx, principal) =>
      step(ctx, 'buildDsrExport', principal, async (note) => {
        const reach = await stored(ctx, principal, ['dsr-request'], note);
        return buildRequestExport(ctx, reach.id);
      }),
    ),
    signWebhookDelivery: withCtx(make, (ctx, principal, args) =>
      step(ctx, 'signWebhookDelivery', principal, async (note) => {
        const reach = await stored(ctx, principal, ['webhook-delivery'], note);
        return { signature: await signWebhookDelivery(ctx, reach.id, args?.timestamp, args?.body) };
      }),
    ),
    signFlowWebhook: withCtx(make, (ctx, principal, args) =>
      step(ctx, 'signFlowWebhook', principal, async (note) => {
        const reach = await stored(ctx, principal, ['flow-run'], note);
        return { signature: await signFlowWebhook(ctx, reach.id, args?.timestamp, args?.body) };
      }),
    ),
    signDestinationRequest: withCtx(make, (ctx, principal, args) =>
      step(ctx, 'signDestinationRequest', principal, async (note) => {
        const reach = await stored(ctx, principal, ['export-destination'], note);
        const signed = await signDestinationRequest(ctx, reach.id, args?.request);
        return { url: signed.url, headers: signed.headers };
      }),
    ),
    providerFetch: withCtx(make, (ctx, principal, ref, request) =>
      step(ctx, 'providerFetch', principal, async (note) => {
        expectKind(principal, ['cron', 'payment-event']);
        note.channelId = (ref as { channelId?: string } | null)?.channelId ?? null;
        return providerFetch(ctx, principal, ref, request);
      }),
    ),
    addressMarkersBulk: withCtx(make, (ctx, args) =>
      step(ctx, 'addressMarkersBulk', { kind: 'none' }, async (note) => {
        note.workspaceId = args?.workspaceId ?? null;
        const markers = await addressMarkersBulk(ctx, args?.workspaceId, args?.emails);
        note.count = Object.keys(markers).length;
        return markers;
      }),
    ),
    addressMarkers: withCtx(make, (ctx, args) =>
      step(ctx, 'addressMarkers', { kind: 'none' }, async (note) => {
        note.workspaceId = args?.workspaceId ?? null;
        return addressMarkers(ctx, args?.workspaceId, args?.email);
      }),
    ),
  };
}

/** The operations of one caller's entrypoint. */
export function opsFor<C extends VaultCaller>(caller: C, make: Ctx): VaultFor[C] {
  const table: { [K in VaultCaller]: (make: Ctx) => VaultFor[K] } = {
    api: apiOps,
    capture: captureOps,
    site: siteOps,
    jobs: jobsOps,
  };
  return table[caller](make) as VaultFor[C];
}
