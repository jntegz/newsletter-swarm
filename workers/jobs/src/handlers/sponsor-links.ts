// Sponsor report links after the link cutover: the ones from before lived 365 days and now end 90
// days after it, so each sponsor whose booking still runs or ran within the last 90 days is
// emailed a fresh one, once (packages/engine/src/sponsor-report-links.ts).
import { linksFor, mailAdapter, reissueSponsorReportLinks } from '@swarm/engine';
import { createLogger } from '@swarm/runtime';
import type { JobsEnv } from '../env';

const log = createLogger({ service: 'jobs' });

export async function runSponsorLinkReissue(env: JobsEnv, now: number): Promise<void> {
  const links = linksFor(env);
  const cutoff = links.mode.legacyCutoffMs;
  if (links.mode.signing !== 'v2' || cutoff === null) return;
  const sent = await reissueSponsorReportLinks(
    {
      db: env.DB,
      mail: mailAdapter(env, env.PLATFORM_MAIL_DOMAIN),
      links,
      site: { scheme: env.SITE_SCHEME, platformDomain: env.PLATFORM_SITE_DOMAIN },
      platformMailDomain: env.PLATFORM_MAIL_DOMAIN,
      now,
    },
    cutoff,
  );
  if (sent) log.info('sponsor report links sent again after the link cutover', { sent });
}
