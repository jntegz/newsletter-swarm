// Single sign-on domain proof, re-checked every day for every verified domain (engine
// sso-domains.ts), with the same lapse rules as at sign-in: owners and admins are warned once
// when the record goes missing, and the proof lapses after SSO_DOMAIN_LAPSE_DAYS of failing.
import {
  mailAdapter,
  recheckSsoDomains,
  sendOperatorNotice,
  ssoDomainFailingNotice,
  ssoTxtResolver,
  workspaceAdminEmails,
} from '@swarm/engine';
import { createLogger } from '@swarm/runtime';
import type { JobsEnv } from '../env';

const log = createLogger({ service: 'jobs' });

export async function recheckSsoDomainProofs(env: JobsEnv, now: number) {
  const result = await recheckSsoDomains(
    {
      db: env.DB,
      resolver: ssoTxtResolver(env),
      log,
      warn: async (domain) => {
        const notice = ssoDomainFailingNotice(domain.domain);
        await sendOperatorNotice(
          {
            mail: mailAdapter(env, env.PLATFORM_MAIL_DOMAIN),
            from: `notifications@${env.PLATFORM_MAIL_DOMAIN}`,
          },
          {
            to: await workspaceAdminEmails(env.DB, domain.workspace_id),
            subject: notice.subject,
            lines: [...notice.lines, new URL('/settings/security', env.APP_ORIGIN).toString()],
            category: 'sso_domain_failing',
            tags: { kind: 'sso_domain_failing' },
          },
        ).catch((error: Error) => log.warn('sso domain notice failed', { error: error.message }));
      },
    },
    now,
  );
  if (result.checked) log.info('sso domains re-checked', result);
  return result;
}
