// The jobs worker's vault (workers/vault, JobsVault), and the engine ports built on it. jobs holds
// no FIELD_KEYS: every encrypted field, data request address, webhook secret, export destination
// key, PayPal secret and own Stripe key is used through the vault, under the stored row that is
// the authority for it (a running export, a leased delivery, a run at its step). A vault that is
// down throws here, so the queue message or cron step is retried; nothing falls back.
import {
  ExportTargetError,
  type ExportVault,
  type FieldVault,
  type FlowsVault,
  type PayPalVault,
  type PrivacyVault,
} from '@swarm/engine';
import {
  markerPort,
  openedOrNull,
  vaultClient,
  vaultFetch,
  vaultValue,
  type JobsPrincipal,
} from '@swarm/vault';
import type { FieldValue } from '@swarm/domain';
import type { JobsEnv } from './env';

const jobsVault = (env: JobsEnv) => vaultClient('jobs', env.VAULT);

/**
 * Pings the vault through this worker's binding and records the answer (worker_heartbeats), so
 * the installer, which can't reach jobs over HTTP, knows jobs can reach it before it prunes keys.
 */
export async function recordVaultHeartbeat(env: JobsEnv, now: number): Promise<boolean> {
  const ok = await jobsVault(env).ping();
  await env.DB.prepare(
    `INSERT INTO worker_heartbeats (worker, checked_at, ok, ok_at) VALUES ('jobs', ?1, ?2, ?3)
     ON CONFLICT (worker) DO UPDATE SET checked_at = excluded.checked_at, ok = excluded.ok,
       ok_at = coalesce(excluded.ok_at, worker_heartbeats.ok_at)`,
  )
    .bind(now, ok ? 1 : 0, ok ? now : null)
    .run();
  return ok;
}

/** Erasure markers, and a data request's address and export (the request is the authority). */
export function privacyVault(env: JobsEnv): PrivacyVault {
  const vault = jobsVault(env);
  return {
    ...markerPort(vault, { bulk: true }),
    openRequestAddress: async (requestId) =>
      openedOrNull(await vault.openDsrAddress({ kind: 'dsr-request', requestId })),
    buildRequestExport: async (requestId) =>
      vaultValue(await vault.buildDsrExport({ kind: 'dsr-request', requestId })) as Record<
        string,
        unknown
      >,
  };
}

/** Encrypted fields of one Channel's Members, under a stored principal (an export, an import…). */
export function fieldVault(env: JobsEnv, principal: JobsPrincipal, channelId: string): FieldVault {
  const vault = jobsVault(env);
  return {
    seal: async (memberId, values) => {
      if (
        principal.kind !== 'import-job' &&
        principal.kind !== 'bulk-job' &&
        principal.kind !== 'flow-run'
      ) {
        throw new Error(`A ${principal.kind} can't seal profile fields.`);
      }
      const sealed = vaultValue(
        await vault.sealMemberFieldsBulk(principal, { channelId, rows: [{ memberId, values }] }),
      );
      return sealed[memberId] ?? {};
    },
    open: async (memberIds, fieldKeys) =>
      vaultValue(
        await vault.openMemberFields(principal, {
          channelId,
          memberIds,
          ...(fieldKeys ? { fieldKeys } : {}),
        }),
      ),
  };
}

/** Many Members' values sealed in one call, each for its own row (imports, bulk edits). */
export async function sealFieldsBulk(
  env: JobsEnv,
  principal: { kind: 'import-job' | 'bulk-job'; jobId: string },
  channelId: string,
  rows: { memberId: string; values: Record<string, FieldValue> }[],
): Promise<Record<string, Record<string, string>>> {
  if (!rows.length) return {};
  return vaultValue(await jobsVault(env).sealMemberFieldsBulk(principal, { channelId, rows }));
}

/** The Flows engine's vault: the run at its step is the authority. */
export function flowsVault(env: JobsEnv): FlowsVault {
  const vault = jobsVault(env);
  const principal = (run: { runId: string; nodeId: string }) => ({
    kind: 'flow-run' as const,
    runId: run.runId,
    nodeId: run.nodeId,
  });
  return {
    sealFields: async (run, memberId, values) => {
      const sealed = vaultValue(
        await vault.sealMemberFieldsBulk(principal(run), {
          channelId: run.channelId,
          rows: [{ memberId, values }],
        }),
      );
      return sealed[memberId] ?? {};
    },
    openFields: async (run, memberIds) =>
      vaultValue(
        await vault.openMemberFields(principal(run), { channelId: run.channelId, memberIds }),
      ),
    signWebhook: async (run, timestamp, body) =>
      openedOrNull(await vault.signFlowWebhook(principal(run), { timestamp, body }))?.signature ??
      null,
  };
}

/** An Event Webhook delivery's signature (the leased delivery is the authority). */
export const signDelivery =
  (env: JobsEnv) => async (deliveryId: string, timestamp: number, body: string) =>
    openedOrNull(
      await jobsVault(env).signWebhookDelivery(
        { kind: 'webhook-delivery', deliveryId },
        { timestamp, body },
      ),
    )?.signature ?? null;

/** An export destination's fields and signed requests (the destination is the authority). */
export function exportVault(env: JobsEnv): ExportVault {
  const vault = jobsVault(env);
  return {
    fields: async (destination, memberIds) =>
      vaultValue(
        await vault.openMemberFields(
          { kind: 'export-destination', destinationId: destination.id },
          { channelId: destination.channelId, memberIds },
        ),
      ),
    sign: async (destinationId, request) => {
      const signed = await vault.signDestinationRequest(
        { kind: 'export-destination', destinationId },
        { request },
      );
      // Keys no key opens, or sealed for another row: retrying can't help, the admin must act.
      if (!signed.ok && (signed.reason === 'refused' || signed.reason === 'unreadable')) {
        throw new ExportTargetError('The stored keys can’t be opened. Enter them again.');
      }
      return vaultValue(signed);
    },
  };
}

/** PayPal reconciliation: the vault gets each account's token and attaches it. */
export function payPalVault(env: JobsEnv): PayPalVault {
  const vault = jobsVault(env);
  return {
    fetchFor: (channelId) =>
      vaultFetch(vault, { kind: 'cron', task: 'paypal-reconcile' }, { kind: 'paypal', channelId }),
    markers: markerPort(vault, { bulk: true }),
  };
}

/** Own Stripe keys in the payments lifecycle: their calls go out through the vault. */
export const ownStripeKeyFetch = (env: JobsEnv) => (channelId: string) =>
  vaultFetch(
    jobsVault(env),
    { kind: 'cron', task: 'payments-lifecycle' },
    { kind: 'stripe', channelId },
  );
