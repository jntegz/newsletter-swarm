import {
  AudienceEnvFields,
  DedicatedEnvFields,
  EngineEnvFields,
  LinkEnvFields,
  ProviderEnvFields,
  SiteOriginEnvFields,
  checkDedicatedEnv,
  checkLinkEnv,
  checkProviderEnv,
  checkSiteOriginEnv,
  linkKeyFields,
  type SendMessage,
} from '@swarm/engine';
import { BaseEnvSchema, binding, defineEnv } from '@swarm/runtime';
import { z } from 'zod';

const SendEnvSchema = BaseEnvSchema.extend({
  /**
   * A ceiling on the per-second sending limit set under Settings > Instance: the lower of the two
   * applies, to every email the install sends (the send worker tells the SendPacer). Optional;
   * the setting is the place for limits now.
   */
  MAIL_MAX_PER_SECOND: z.coerce.number().int().positive().optional(),
  DB: binding<D1Database>(),
  CACHE: binding<KVNamespace>(),
  SEND_QUEUE: binding<Queue<SendMessage>>(),
  /** The realtime worker's SendMonitor. Optional: without it the dashboard polls. */
  SEND_MONITOR: binding<DurableObjectNamespace>().optional(),
  // SEND_PACER comes with ProviderEnvFields: the install's sending limits. Without it, or when it
  // can't be reached, a batch keeps to the per-second limit on its own.
  MEDIA_ORIGIN: z.url(),
  ...EngineEnvFields,
  ...LinkEnvFields,
  /**
   * Link keys (docs/security.md "Keys"): Member Center links in every footer and one-tap Ask
   * links, which capture checks with the public keys.
   */
  ...linkKeyFields('MEMBER_SIGNING_KEYS', 'ASK_SIGNING_KEYS'),
  CAPTURE_ORIGIN: AudienceEnvFields.CAPTURE_ORIGIN,
  ...ProviderEnvFields,
  /** Web addresses of Dispatches, for the gate's "continue reading" link in paid email. */
  ...SiteOriginEnvFields,
  /** Paid Channels' own configuration sets and dedicated IP pools (Phase 7). */
  ...DedicatedEnvFields,
}).superRefine((env, ctx) => {
  checkLinkEnv(env, ctx, { signs: true });
  checkProviderEnv(env, ctx);
  checkDedicatedEnv(env, ctx);
  checkSiteOriginEnv(env, ctx);
});

export type SendEnv = z.infer<typeof SendEnvSchema>;

export const parseSendEnv = defineEnv(SendEnvSchema);
