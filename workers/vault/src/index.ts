/**
 * The vault Worker (docs/security.md "The vault"). No route: `fetch` answers 404 on every
 * entrypoint, and wrangler gives it no workers.dev name or preview URL. Each caller's service
 * binding names one of the four entrypoints below, so capture, say, can call CaptureVault's
 * methods and no other: the binding is the caller's identity.
 *
 * The methods are declared on each class (RPC exposes prototype methods only) and hand over to
 * @swarm/vault/core with a context for that caller; they never throw across RPC.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { upgradeAddressMarkers } from '@swarm/engine';
import type {
  ApiVault as ApiContract,
  CaptureVault as CaptureContract,
  JobsVault as JobsContract,
  SiteVault as SiteContract,
  VaultCaller,
  VaultFor,
} from '@swarm/vault';
import { contextFromEnv, opsFor, pruneVaultRecords, resealToCurrent } from '@swarm/vault/core';

type Ops<C extends VaultCaller> = VaultFor[C];

const notFound = () =>
  new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found.' } }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });

/** The operations of one caller on this request's env. */
function ops<C extends VaultCaller>(caller: C, env: unknown): Ops<C> {
  return opsFor(caller, () => contextFromEnv(env, caller));
}

/** The api worker's entrypoint. */
export class ApiVault extends WorkerEntrypoint<Env> implements ApiContract {
  #ops = (): Ops<'api'> => ops('api', this.env);

  override fetch(): Response {
    return notFound();
  }

  ping(): ReturnType<ApiContract['ping']> {
    return this.#ops().ping();
  }

  openMemberFields(
    ...args: Parameters<ApiContract['openMemberFields']>
  ): ReturnType<ApiContract['openMemberFields']> {
    return this.#ops().openMemberFields(...args);
  }

  sealMemberFields(
    ...args: Parameters<ApiContract['sealMemberFields']>
  ): ReturnType<ApiContract['sealMemberFields']> {
    return this.#ops().sealMemberFields(...args);
  }

  sealCredential(
    ...args: Parameters<ApiContract['sealCredential']>
  ): ReturnType<ApiContract['sealCredential']> {
    return this.#ops().sealCredential(...args);
  }

  sealDsrAddress(
    ...args: Parameters<ApiContract['sealDsrAddress']>
  ): ReturnType<ApiContract['sealDsrAddress']> {
    return this.#ops().sealDsrAddress(...args);
  }

  createWebhookSecret(
    ...args: Parameters<ApiContract['createWebhookSecret']>
  ): ReturnType<ApiContract['createWebhookSecret']> {
    return this.#ops().createWebhookSecret(...args);
  }

  createFlowWebhookSecret(
    ...args: Parameters<ApiContract['createFlowWebhookSecret']>
  ): ReturnType<ApiContract['createFlowWebhookSecret']> {
    return this.#ops().createFlowWebhookSecret(...args);
  }

  beginTotp(...args: Parameters<ApiContract['beginTotp']>): ReturnType<ApiContract['beginTotp']> {
    return this.#ops().beginTotp(...args);
  }

  confirmTotp(
    ...args: Parameters<ApiContract['confirmTotp']>
  ): ReturnType<ApiContract['confirmTotp']> {
    return this.#ops().confirmTotp(...args);
  }

  verifyTotp(
    ...args: Parameters<ApiContract['verifyTotp']>
  ): ReturnType<ApiContract['verifyTotp']> {
    return this.#ops().verifyTotp(...args);
  }

  sealSsoSecret(
    ...args: Parameters<ApiContract['sealSsoSecret']>
  ): ReturnType<ApiContract['sealSsoSecret']> {
    return this.#ops().sealSsoSecret(...args);
  }

  ssoTokenExchange(
    ...args: Parameters<ApiContract['ssoTokenExchange']>
  ): ReturnType<ApiContract['ssoTokenExchange']> {
    return this.#ops().ssoTokenExchange(...args);
  }

  verifyStripeWebhook(
    ...args: Parameters<ApiContract['verifyStripeWebhook']>
  ): ReturnType<ApiContract['verifyStripeWebhook']> {
    return this.#ops().verifyStripeWebhook(...args);
  }

  mintMemberLinks(
    ...args: Parameters<ApiContract['mintMemberLinks']>
  ): ReturnType<ApiContract['mintMemberLinks']> {
    return this.#ops().mintMemberLinks(...args);
  }

  mintGoodsLinks(
    ...args: Parameters<ApiContract['mintGoodsLinks']>
  ): ReturnType<ApiContract['mintGoodsLinks']> {
    return this.#ops().mintGoodsLinks(...args);
  }

  signDestinationRequest(
    ...args: Parameters<ApiContract['signDestinationRequest']>
  ): ReturnType<ApiContract['signDestinationRequest']> {
    return this.#ops().signDestinationRequest(...args);
  }

  providerFetch(
    ...args: Parameters<ApiContract['providerFetch']>
  ): ReturnType<ApiContract['providerFetch']> {
    return this.#ops().providerFetch(...args);
  }

  providerStream(
    ...args: Parameters<ApiContract['providerStream']>
  ): ReturnType<ApiContract['providerStream']> {
    return this.#ops().providerStream(...args);
  }

  checkCredential(
    ...args: Parameters<ApiContract['checkCredential']>
  ): ReturnType<ApiContract['checkCredential']> {
    return this.#ops().checkCredential(...args);
  }

  addressMarkers(
    ...args: Parameters<ApiContract['addressMarkers']>
  ): ReturnType<ApiContract['addressMarkers']> {
    return this.#ops().addressMarkers(...args);
  }
}

/** The capture worker's entrypoint. */
export class CaptureVault extends WorkerEntrypoint<Env> implements CaptureContract {
  #ops = (): Ops<'capture'> => ops('capture', this.env);

  override fetch(): Response {
    return notFound();
  }

  ping(): ReturnType<CaptureContract['ping']> {
    return this.#ops().ping();
  }

  openMemberCenter(
    ...args: Parameters<CaptureContract['openMemberCenter']>
  ): ReturnType<CaptureContract['openMemberCenter']> {
    return this.#ops().openMemberCenter(...args);
  }

  sealMemberCenterFields(
    ...args: Parameters<CaptureContract['sealMemberCenterFields']>
  ): ReturnType<CaptureContract['sealMemberCenterFields']> {
    return this.#ops().sealMemberCenterFields(...args);
  }

  sealSignupFields(
    ...args: Parameters<CaptureContract['sealSignupFields']>
  ): ReturnType<CaptureContract['sealSignupFields']> {
    return this.#ops().sealSignupFields(...args);
  }

  mintJoinToken(
    ...args: Parameters<CaptureContract['mintJoinToken']>
  ): ReturnType<CaptureContract['mintJoinToken']> {
    return this.#ops().mintJoinToken(...args);
  }

  mintJourneyToken(
    ...args: Parameters<CaptureContract['mintJourneyToken']>
  ): ReturnType<CaptureContract['mintJourneyToken']> {
    return this.#ops().mintJourneyToken(...args);
  }

  openJourneyToken(
    ...args: Parameters<CaptureContract['openJourneyToken']>
  ): ReturnType<CaptureContract['openJourneyToken']> {
    return this.#ops().openJourneyToken(...args);
  }

  sealMemberDsrAddress(
    ...args: Parameters<CaptureContract['sealMemberDsrAddress']>
  ): ReturnType<CaptureContract['sealMemberDsrAddress']> {
    return this.#ops().sealMemberDsrAddress(...args);
  }

  sealErasureAddress(
    ...args: Parameters<CaptureContract['sealErasureAddress']>
  ): ReturnType<CaptureContract['sealErasureAddress']> {
    return this.#ops().sealErasureAddress(...args);
  }

  sealAddressConfirmation(
    ...args: Parameters<CaptureContract['sealAddressConfirmation']>
  ): ReturnType<CaptureContract['sealAddressConfirmation']> {
    return this.#ops().sealAddressConfirmation(...args);
  }

  openAddressConfirmation(
    ...args: Parameters<CaptureContract['openAddressConfirmation']>
  ): ReturnType<CaptureContract['openAddressConfirmation']> {
    return this.#ops().openAddressConfirmation(...args);
  }

  sealConfirmedAddress(
    ...args: Parameters<CaptureContract['sealConfirmedAddress']>
  ): ReturnType<CaptureContract['sealConfirmedAddress']> {
    return this.#ops().sealConfirmedAddress(...args);
  }

  mintMemberLink(
    ...args: Parameters<CaptureContract['mintMemberLink']>
  ): ReturnType<CaptureContract['mintMemberLink']> {
    return this.#ops().mintMemberLink(...args);
  }

  providerFetch(
    ...args: Parameters<CaptureContract['providerFetch']>
  ): ReturnType<CaptureContract['providerFetch']> {
    return this.#ops().providerFetch(...args);
  }

  addressMarkers(
    ...args: Parameters<CaptureContract['addressMarkers']>
  ): ReturnType<CaptureContract['addressMarkers']> {
    return this.#ops().addressMarkers(...args);
  }
}

/** The site worker's entrypoint. */
export class SiteVault extends WorkerEntrypoint<Env> implements SiteContract {
  #ops = (): Ops<'site'> => ops('site', this.env);

  override fetch(): Response {
    return notFound();
  }

  ping(): ReturnType<SiteContract['ping']> {
    return this.#ops().ping();
  }

  openJoinToken(
    ...args: Parameters<SiteContract['openJoinToken']>
  ): ReturnType<SiteContract['openJoinToken']> {
    return this.#ops().openJoinToken(...args);
  }

  mintGoodsLink(
    ...args: Parameters<SiteContract['mintGoodsLink']>
  ): ReturnType<SiteContract['mintGoodsLink']> {
    return this.#ops().mintGoodsLink(...args);
  }

  providerFetch(
    ...args: Parameters<SiteContract['providerFetch']>
  ): ReturnType<SiteContract['providerFetch']> {
    return this.#ops().providerFetch(...args);
  }

  addressMarkers(
    ...args: Parameters<SiteContract['addressMarkers']>
  ): ReturnType<SiteContract['addressMarkers']> {
    return this.#ops().addressMarkers(...args);
  }
}

/** The jobs worker's entrypoint. */
export class JobsVault extends WorkerEntrypoint<Env> implements JobsContract {
  #ops = (): Ops<'jobs'> => ops('jobs', this.env);

  override fetch(): Response {
    return notFound();
  }

  ping(): ReturnType<JobsContract['ping']> {
    return this.#ops().ping();
  }

  openMemberFields(
    ...args: Parameters<JobsContract['openMemberFields']>
  ): ReturnType<JobsContract['openMemberFields']> {
    return this.#ops().openMemberFields(...args);
  }

  sealMemberFieldsBulk(
    ...args: Parameters<JobsContract['sealMemberFieldsBulk']>
  ): ReturnType<JobsContract['sealMemberFieldsBulk']> {
    return this.#ops().sealMemberFieldsBulk(...args);
  }

  openDsrAddress(
    ...args: Parameters<JobsContract['openDsrAddress']>
  ): ReturnType<JobsContract['openDsrAddress']> {
    return this.#ops().openDsrAddress(...args);
  }

  buildDsrExport(
    ...args: Parameters<JobsContract['buildDsrExport']>
  ): ReturnType<JobsContract['buildDsrExport']> {
    return this.#ops().buildDsrExport(...args);
  }

  signWebhookDelivery(
    ...args: Parameters<JobsContract['signWebhookDelivery']>
  ): ReturnType<JobsContract['signWebhookDelivery']> {
    return this.#ops().signWebhookDelivery(...args);
  }

  signFlowWebhook(
    ...args: Parameters<JobsContract['signFlowWebhook']>
  ): ReturnType<JobsContract['signFlowWebhook']> {
    return this.#ops().signFlowWebhook(...args);
  }

  signDestinationRequest(
    ...args: Parameters<JobsContract['signDestinationRequest']>
  ): ReturnType<JobsContract['signDestinationRequest']> {
    return this.#ops().signDestinationRequest(...args);
  }

  providerFetch(
    ...args: Parameters<JobsContract['providerFetch']>
  ): ReturnType<JobsContract['providerFetch']> {
    return this.#ops().providerFetch(...args);
  }

  addressMarkers(
    ...args: Parameters<JobsContract['addressMarkers']>
  ): ReturnType<JobsContract['addressMarkers']> {
    return this.#ops().addressMarkers(...args);
  }

  addressMarkersBulk(
    ...args: Parameters<JobsContract['addressMarkersBulk']>
  ): ReturnType<JobsContract['addressMarkersBulk']> {
    return this.#ops().addressMarkersBulk(...args);
  }
}

export default {
  fetch(): Response {
    return notFound();
  },
  /** Every 5 minutes: a bounded share of the re-seal, then pruning of the vault's own records. */
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const vault = await contextFromEnv(env, 'vault');
    ctx.waitUntil(
      (async () => {
        const result = await resealToCurrent(vault);
        if (result && (result.resealed || result.unreadable || result.finished)) {
          vault.log.info('vault reseal', { ...result });
        }
        // Erasure markers of older forms, rewritten install-keyed (the jobs worker did this while
        // it held FIELD_KEYS).
        const upgraded = await upgradeAddressMarkers(vault.db, vault.keys.field);
        if (upgraded) vault.log.info('erasure markers upgraded', { rows: upgraded });
        const pruned = await pruneVaultRecords(vault);
        if (pruned) vault.log.info('vault records pruned', { rows: pruned });
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
