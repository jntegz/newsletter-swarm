import { upsertRecord, type DnsRecord, type WantedRecord } from '../cloudflare';
import { dnsApi, oauthApi, zoneId, type Ctx } from '../context';
import { hostnamesFor, proxiedHosts } from '../hostnames';
import { InstallError } from '../ui';
import type { Step } from './step';

/** Every record the installer owns in the zone, in a stable order. */
function wantedRecords(ctx: Ctx): WantedRecord[] {
  const zone = ctx.state.zone?.name;
  if (!zone) throw new InstallError('No zone is selected.', 'Run `pnpm swarm` first.');
  const h = hostnamesFor(zone, ctx.env, ctx.state.choices?.addresses);
  return [
    // Worker-only hostnames: 100:: is the documented placeholder address for proxied routes.
    ...proxiedHosts(h, ctx.state.features).map((name) => ({
      type: 'AAAA' as const,
      name,
      content: '100::',
      proxied: true,
    })),
    ...(ctx.state.mailRecords ?? []),
    { type: 'TXT', name: `_dmarc.${h.mail}`, content: 'v=DMARC1; p=quarantine; adkim=r; aspf=r' },
    // Lets every sending domain send aggregate reports to dmarc+<id>@dmarc.D (RFC 7489 §7.1).
    { type: 'TXT', name: `*._report._dmarc.${h.dmarc}`, content: 'v=DMARC1' },
  ];
}

/** Worker-less routes keep the person's own proxied subdomains away from *.D/*. */
async function ensureExclusionRoutes(ctx: Ctx) {
  const hosts = ctx.state.choices?.excludeHosts ?? [];
  if (hosts.length === 0) return;
  const cf = oauthApi(ctx);
  const zone = zoneId(ctx);
  const routes = await cf.list<{ pattern: string; script?: string }>(
    `/zones/${zone}/workers/routes`,
  );
  for (const host of hosts) {
    const pattern = `${host}/*`;
    const existing = routes.find((r) => r.pattern === pattern);
    await ctx.ui.task(
      `Keeping ${host} out of the publication websites`,
      async () => {
        if (existing)
          return existing.script ? `left alone (routed to ${existing.script})` : 'already there';
        await cf.post(`/zones/${zone}/workers/routes`, { pattern });
        return 'done';
      },
      (s) => s,
    );
  }
}

/**
 * The domain itself, when the publication lives there. A proxied record of the person's own stays,
 * because the route takes over from it. A DNS-only one would send visitors past Swarm, and only the
 * person can decide to change it, so the install stops here, before anything else is public.
 */
async function ensureRootRecord(ctx: Ctx) {
  const zone = ctx.state.zone?.name;
  const h = hostnamesFor(zone ?? '', ctx.env, ctx.state.choices?.addresses);
  const cf = dnsApi(ctx);
  if (!h.root || !cf) return;
  const records = await cf.list<DnsRecord>(`/zones/${zoneId(ctx)}/dns_records`, { name: h.zone });
  const web = records.filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type));
  const direct = web.find((r) => !r.proxied);
  if (direct) {
    throw new InstallError(
      `${h.zone} points directly at another server (${direct.type} ${direct.content}), so visitors would never reach your publication.`,
      `In Cloudflare, open DNS > Records and turn on the orange cloud (Proxied) for that record, or delete it if you no longer need that server. Then try this step again. Email on ${h.zone} isn't affected.`,
    );
  }
  if (web.length > 0) {
    ctx.ui.warn(`${h.zone} will now show your publication instead of what it shows today.`);
    return;
  }
  await ctx.ui.task(`Pointing ${h.zone} at Swarm`, () =>
    upsertRecord(cf, zoneId(ctx), { type: 'AAAA', name: h.zone, content: '100::', proxied: true }),
  );
}

export async function writeDns(ctx: Ctx) {
  const cf = dnsApi(ctx);
  if (!cf) {
    ctx.ui.warn(
      'Skipping DNS: this run has no DNS token. Run `pnpm swarm` (install) to paste one, or keep it in .swarm/.',
    );
    return;
  }
  const zone = zoneId(ctx);
  for (const record of wantedRecords(ctx)) {
    const label =
      record.type === 'AAAA'
        ? `Pointing ${record.name} at Swarm`
        : `Adding ${record.type} ${record.name}`;
    await ctx.ui.task(
      label,
      () => upsertRecord(cf, zone, record),
      (what) => (what === 'created' ? 'done' : what === 'updated' ? 'updated' : 'already there'),
    );
  }
  await ensureRootRecord(ctx);
  await ensureExclusionRoutes(ctx);
}

export const dns: Step = { id: 'dns', title: 'DNS records', run: writeDns };
