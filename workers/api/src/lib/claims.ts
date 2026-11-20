/**
 * Who holds a sending, link or web domain is decided by proof, not by who added it first (0065). A
 * claim that never verified gives way to another Channel that publishes the TXT proof (claimProof),
 * however old the claim is. Without that proof the name stays put: the DNS that verifies a link or
 * web domain is the same for every Channel, so a newcomer would inherit the earlier owner's records.
 * The mail and hostname services keep one copy of a name, so the claim that gives way is removed,
 * copy and all. The same holds with no claim at all: a name whose DNS still points at the platform
 * (its earlier owner removed the domain but not the record) needs the proof too.
 */
import { first } from '@swarm/db';
import {
  claimProof,
  dnsLookup,
  domainIdentities,
  hasClaimProof,
  linkHostnames,
  txtResolver,
  type DomainRow,
  type TxtResolver,
} from '@swarm/engine';
import type { DnsLookup } from '@swarm/mail';
import { ApiError } from '@swarm/runtime';
import type { ApiEnv } from '../env';
import { appendAudit } from './audit';

/** TXT lookups. Locally (DNS_RESOLVER=dev) records come from KV `dev:txt:<name>`, as for SSO. */
function proofResolver(e: ApiEnv): TxtResolver {
  if (e.DNS_RESOLVER !== 'dev') return txtResolver(e);
  return { txt: async (name) => (await e.CACHE.get<string[]>(`dev:txt:${name}`, 'json')) ?? [] };
}

/**
 * CNAME and A lookups (DNS over HTTPS, as for TXT). Locally (DNS_RESOLVER=dev) answers come from
 * KV `dev:cname:<name>` and `dev:a:<name>`; an answer that isn't a list fails the lookup, as a
 * resolver outage would.
 */
function targetLookup(e: ApiEnv): DnsLookup {
  if (e.DNS_RESOLVER !== 'dev') return dnsLookup(e);
  return {
    lookup: async (name, type) => {
      const answer = await e.CACHE.get<unknown>(`dev:${type.toLowerCase()}:${name}`, 'json');
      if (answer !== null && !Array.isArray(answer)) throw new Error('DNS lookup failed');
      return (answer as string[] | null) ?? [];
    },
  };
}

/**
 * Every host a custom hostname's DNS can point at to be served: the track host (link domains) and
 * the SaaS zone's fallback origin (web hostnames). Both kinds live in the same zone, so a record
 * left for one activates a name added as the other.
 */
function platformTargets(e: ApiEnv): string[] {
  return [new URL(e.TRACK_ORIGIN).hostname, e.SITE_FALLBACK_ORIGIN];
}

const host = (value: string) => value.trim().replace(/\.$/, '').toLowerCase();

/** How many CNAME hops are followed; resolvers give up on longer chains too. */
const MAX_CNAME_HOPS = 8;

/**
 * Whether a name's DNS already sends it to one of the platform's targets: a CNAME chain with a hop
 * at one, or a name with no CNAME of its own (the name itself, or where its chain ends) that has
 * exactly one target's addresses (a flattened CNAME or an ALIAS, as at a bare domain). Exactly,
 * not any overlap: Cloudflare's anycast addresses are shared by unrelated zones. The hostname
 * service activates such a name for whoever adds it. Throws when DNS doesn't answer, so an outage
 * can't wave a name through.
 */
async function pointsAtPlatform(dns: DnsLookup, name: string, targets: string[]): Promise<boolean> {
  const platform = new Set(targets.map(host));
  const flattenedToPlatform = async (end: string) => {
    const addresses = new Set(await dns.lookup(end, 'A'));
    if (!addresses.size) return false;
    for (const target of platform) {
      const own = new Set(await dns.lookup(target, 'A'));
      if (own.size === addresses.size && [...own].every((a) => addresses.has(a))) return true;
    }
    return false;
  };
  try {
    let hops = (await dns.lookup(name, 'CNAME')).map(host);
    if (!hops.length) return await flattenedToPlatform(name);
    // Follow the chain as Cloudflare does: a hop an earlier owner left pointing here counts.
    const seen = new Set([host(name)]);
    for (let depth = 1; ; depth++) {
      if (hops.some((hop) => platform.has(hop))) return true;
      const fresh = [...new Set(hops)].filter((hop) => !seen.has(hop));
      // Nothing new: a loop, which resolves nowhere, or chain ends already checked below.
      if (!fresh.length) return false;
      // Longer than we follow: we can't see where it ends, so ask for the proof.
      if (depth === MAX_CNAME_HOPS) return true;
      for (const hop of fresh) seen.add(hop);
      const next = await Promise.all(fresh.map((hop) => dns.lookup(hop, 'CNAME')));
      // A hop with no CNAME is where the chain ends, and may be flattened to a target too.
      for (const [i, hop] of fresh.entries()) {
        if (!next[i]!.length && (await flattenedToPlatform(hop))) return true;
      }
      hops = next.flat().map(host);
    }
  } catch {
    throw new ApiError(
      'unavailable',
      `DNS for ${name} couldn’t be checked. Try again in a minute.`,
    );
  }
}

interface Claim {
  name: string;
  channelId: string;
  provenAt: number | null;
  /** A claim that can't be removed now (a service change has it at another service). */
  held?: boolean;
}

/**
 * Checks that every claim in the way of `channelId` gives way: none is proven, the Channel's own
 * or held, and the Channel has published its proof for each name. Each of `shared` that no claim
 * holds needs the proof too when its DNS already points at a platform target (platformTargets),
 * which every Channel's records point at. Throws 409 otherwise, naming the records to publish when
 * that would help. The caller removes the claims.
 */
export async function requireClaimsGiveWay(
  e: ApiEnv,
  channelId: string,
  claims: Claim[],
  taken: (name: string) => string,
  options: { field?: string; shared?: string[] } = {},
): Promise<void> {
  const { field = 'domain', shared } = options;
  const kept = claims.find((c) => c.provenAt !== null || c.channelId === channelId || c.held);
  if (kept) throw new ApiError('conflict', taken(kept.name));
  const needed = claims.map((claim) => claim.name);
  if (shared) {
    const dns = targetLookup(e);
    const targets = platformTargets(e);
    for (const name of shared) {
      if (needed.some((n) => n.toLowerCase() === name.toLowerCase())) continue;
      if (await pointsAtPlatform(dns, name, targets)) needed.push(name);
    }
  }
  const resolver = proofResolver(e);
  const unproven: string[] = [];
  for (const name of needed) {
    if (await hasClaimProof(resolver, channelId, name)) continue;
    if (!unproven.includes(name)) unproven.push(name);
  }
  if (!unproven.length) return;
  const proofs = await Promise.all(unproven.map((name) => claimProof(channelId, name)));
  const records = proofs
    .map((p) => `a TXT record named ${p.name} with the value ${p.value}`)
    .join(', and ');
  // Say why each name needs it: another Channel's claim, or DNS that already points here.
  const taking = unproven.filter((name) => claims.some((c) => c.name === name));
  const pointing = unproven.filter((name) => !taking.includes(name));
  const added = `${taking.join(' and ')} ${taking.length > 1 ? 'were' : 'was'} added by another Channel but never verified`;
  const points = `${pointing.join(' and ')} already ${pointing.length > 1 ? 'point' : 'points'} at Swarm`;
  const message = !pointing.length
    ? `${added}. If it’s yours, publish ${records}, then add it again.`
    : !taking.length
      ? `${points}, so we need to check ${pointing.length > 1 ? 'they’re' : 'it’s'} yours. Publish ${records}, then add it again.`
      : `${added}, and ${points}. If they’re yours, publish ${records}, then add it again.`;
  throw new ApiError(
    'conflict',
    message,
    proofs.map((p) => ({ path: field, message: `TXT ${p.name} ${p.value}` })),
  );
}

/** The row's own copy at its service; nothing on a service the row isn't on (see refreshDomain). */
export async function removeDomainCopy(e: ApiEnv, row: DomainRow): Promise<void> {
  if (row.kind === 'email') {
    if (!row.provider || row.provider === e.MAIL_ADAPTER) {
      await domainIdentities(e).remove(row.domain, row.provider_ref);
    }
  } else if (row.provider_ref) await linkHostnames(e)?.remove(row.provider_ref);
}

/** Removes a sending or link domain claim that gave way, and notes it in its own workspace. */
export async function releaseSendingDomain(e: ApiEnv, row: DomainRow): Promise<void> {
  // Only while still unproven: one that verified a moment ago keeps its domain.
  const gone = await first(
    e.DB,
    'DELETE FROM sending_domains WHERE id = ?1 AND proven_at IS NULL RETURNING id',
    row.id,
  );
  if (!gone) throw new ApiError('conflict', `${row.domain} is already set up.`);
  await removeDomainCopy(e, row);
  await appendAudit(e.DB, {
    workspaceId: row.workspace_id,
    actorId: null,
    action: 'sending_domain.released',
    targetType: 'sending_domain',
    targetId: row.id,
    metadata: { domain: row.domain, kind: row.kind },
  });
}
