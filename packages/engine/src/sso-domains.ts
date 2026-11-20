/**
 * Single sign-on domain proof as a continuing fact (docs/security.md "Proof is re-checked").
 * A verified domain's TXT record `_swarm-sso.<domain>` is looked up again: at sign-in once the
 * last check is older than SSO_DOMAIN_RECHECK_HOURS (api worker), when another workspace tries
 * to verify the same domain (api worker), and every day for every verified domain (jobs worker,
 * recheckSsoDomains on the five-minute cron, a bounded batch per run). Seen: the proof is fresh.
 * Missing, or the lookup failed: the proof is failing from now and the workspace's owners and
 * admins are warned once; after SSO_DOMAIN_LAPSE_DAYS of failing it lapses, so the domain stops
 * capturing sign-in and a workspace that proves it now can verify it.
 */
import {
  SSO_DOMAIN_LAPSE_DAYS,
  SSO_DOMAIN_RECHECK_HOURS,
  SSO_TXT_PREFIX,
  SSO_TXT_VALUE_PREFIX,
} from '@swarm/domain';
import { appendAudit } from '@swarm/db';
import { all, run, toIso } from './db';
import type { ProviderEnv } from './adapters';
import { DohResolver, type TxtResolver } from './domains';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Domains the jobs worker re-checks per run; the five-minute cron covers 7,200 a day. */
export const SSO_RECHECK_BATCH = 25;

/** The sso_domains columns a re-check reads. */
export interface SsoProofDomain {
  id: string;
  connection_id: string;
  workspace_id: string;
  domain: string;
  verification_token: string;
  verified_at: number | null;
  failing_since: number | null;
}

export interface SsoProofDeps {
  db: D1Database;
  resolver: TxtResolver;
  /** Tells the workspace's owners and admins, once, that the record is missing. */
  warn: (domain: SsoProofDomain) => Promise<void>;
  log: { warn: (message: string, data?: Record<string, unknown>) => void };
}

/**
 * TXT lookups for SSO proof. Locally (DNS_RESOLVER=dev) records come from KV `dev:txt:<name>`, a
 * JSON array, so tests and the dev stack can publish and remove one.
 */
export function ssoTxtResolver(
  env: Pick<ProviderEnv, 'DNS_RESOLVER'> & { CACHE: KVNamespace },
): TxtResolver {
  if (env.DNS_RESOLVER !== 'dev') return new DohResolver();
  return { txt: async (name) => (await env.CACHE.get<string[]>(`dev:txt:${name}`, 'json')) ?? [] };
}

/** Keeps sso_connections.domains_json equal to the verified domain names. */
export async function syncSsoDomains(db: D1Database, connectionId: string, now = Date.now()) {
  await run(
    db,
    `UPDATE sso_connections SET updated_at = ?2, domains_json = (
       SELECT json_group_array(domain) FROM sso_domains
        WHERE connection_id = ?1 AND verified_at IS NOT NULL)
      WHERE id = ?1`,
    connectionId,
    now,
  );
}

/** Looks up a verified domain's record again. Returns whether the proof still stands. */
export async function reproveSsoDomain(
  deps: SsoProofDeps,
  domain: SsoProofDomain,
  now = Date.now(),
): Promise<boolean> {
  if (domain.verified_at === null) return false;
  const expected = `${SSO_TXT_VALUE_PREFIX}${domain.verification_token}`;
  let records: string[] = [];
  try {
    records = await deps.resolver.txt(`${SSO_TXT_PREFIX}.${domain.domain}`);
  } catch (error) {
    deps.log.warn('sso txt re-check failed', { error: (error as Error).message });
  }
  if (records.some((record) => record.trim() === expected)) {
    await run(
      deps.db,
      'UPDATE sso_domains SET checked_at = ?1, failing_since = NULL WHERE id = ?2',
      now,
      domain.id,
    );
    return true;
  }
  const since = domain.failing_since ?? now;
  if (now - since >= SSO_DOMAIN_LAPSE_DAYS * DAY_MS) {
    await run(
      deps.db,
      'UPDATE sso_domains SET verified_at = NULL, failing_since = NULL, checked_at = ?1 WHERE id = ?2',
      now,
      domain.id,
    );
    await syncSsoDomains(deps.db, domain.connection_id, now);
    await appendAudit(deps.db, {
      workspaceId: domain.workspace_id,
      actorId: null,
      action: 'sso.domain_lapsed',
      targetType: 'sso_connection',
      targetId: domain.connection_id,
      metadata: { domain: domain.domain, failingSince: toIso(since) },
      ipPrefix: null,
    });
    return false;
  }
  await run(
    deps.db,
    'UPDATE sso_domains SET checked_at = ?1, failing_since = ?2 WHERE id = ?3',
    now,
    since,
    domain.id,
  );
  if (domain.failing_since === null) {
    await appendAudit(deps.db, {
      workspaceId: domain.workspace_id,
      actorId: null,
      action: 'sso.domain_proof_failing',
      targetType: 'sso_connection',
      targetId: domain.connection_id,
      metadata: { domain: domain.domain },
      ipPrefix: null,
    });
    await deps.warn(domain);
  }
  return true;
}

/**
 * The daily re-check: every verified domain whose last check is older than
 * SSO_DOMAIN_RECHECK_HOURS, oldest first, a bounded batch per call.
 */
export async function recheckSsoDomains(
  deps: SsoProofDeps,
  now = Date.now(),
  limit = SSO_RECHECK_BATCH,
): Promise<{ checked: number; standing: number; lapsed: number }> {
  const due = await all<SsoProofDomain>(
    deps.db,
    `SELECT id, connection_id, workspace_id, domain, verification_token, verified_at, failing_since
       FROM sso_domains
      WHERE verified_at IS NOT NULL AND coalesce(checked_at, 0) < ?1
      ORDER BY coalesce(checked_at, 0) LIMIT ?2`,
    now - SSO_DOMAIN_RECHECK_HOURS * HOUR_MS,
    limit,
  );
  let standing = 0;
  for (const domain of due) {
    if (await reproveSsoDomain(deps, domain, now)) standing++;
  }
  return { checked: due.length, standing, lapsed: due.length - standing };
}

/** The warning text, shared by the api and jobs workers. */
export function ssoDomainFailingNotice(domain: string): { subject: string; lines: string[] } {
  return {
    subject: `The single sign-on record for ${domain} is missing`,
    lines: [
      `The TXT record ${SSO_TXT_PREFIX}.${domain} that proves your workspace controls ${domain} could not be found.`,
      `Single sign-on keeps working for now. If the record is still missing after ${SSO_DOMAIN_LAPSE_DAYS} days, ${domain} stops signing people in through your identity provider and anyone who proves the domain can claim it. Publish the record again to keep it.`,
    ],
  };
}
