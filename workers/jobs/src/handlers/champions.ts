// Champions (Phase 6): the counting pass over pending referrals, then milestone awards and their
// emails. Runs on the minute cron; see packages/engine/src/champions.ts for the rules.
import {
  countReferrals,
  linksFor,
  localMemberLinks,
  mailAdapter,
  type ChampionDeps,
} from '@swarm/engine';
import { createLogger } from '@swarm/runtime';
import type { JobsEnv } from '../env';

const log = createLogger({ service: 'jobs' });

export function championDeps(env: JobsEnv): ChampionDeps {
  return {
    db: env.DB,
    mail: {
      adapter: mailAdapter(env, env.PLATFORM_MAIL_DOMAIN),
      platformMailDomain: env.PLATFORM_MAIL_DOMAIN,
      memberLinks: localMemberLinks(linksFor(env)),
      captureOrigin: env.CAPTURE_ORIGIN.replace(/\/$/, ''),
    },
    log: (message, fields) => log.warn(message, fields),
  };
}

export async function runChampions(env: JobsEnv, now: number): Promise<void> {
  const result = await countReferrals(championDeps(env), now);
  if (result.held || result.counted || result.rejected || result.awards) {
    log.info('champions counted', { ...result });
  }
}
