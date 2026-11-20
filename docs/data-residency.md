# Data residency

## Today

- **One region.** Every workspace is stored in one Cloudflare D1 database and one set of R2 buckets per environment. Where that database and those buckets live is fixed when the environment is provisioned (`scripts/provision.mjs`, see [deployment.md](deployment.md)); it is not chosen per workspace.
- **`workspaces.region`** (`global` or `eu`) is recorded on every workspace, defaulting to `global`. Nothing routes on it yet: it is a marker, so that a later split knows which workspaces asked for the EU.
- **Requests** are served by Cloudflare's network close to the visitor, whatever the region. Workers keep no data between requests except in D1, R2, KV, Queues and Durable Objects.
- **Email** goes through Amazon SES in the configured `AWS_REGION` (eu-west-1 in the hosted service). **Payments** run on each Channel's own Stripe account, under Stripe's terms. See [subprocessors.md](subprocessors.md).
- **Operators' own copies** (exports to their R2 or S3 bucket, webhook receivers) live wherever the operator puts them.

## Decision

EU data residency is not a launch requirement (decision 2026-10-28, Phase 7). It is revisited before Swarm takes on a customer that needs data stored only in the EU.

## What EU residency would take

1. **A second D1 database** created with the EU location hint, bound into every worker next to the current one (`DB_EU`), with the same migrations applied to both.
2. **Routing by workspace.** Every query for a workspace's data goes to the database its `region` names. Today a request often starts from an id (a Member, a Dispatch, a token) rather than a workspace, so each entry point needs a way to find the region first: ids would carry the region, or a small global index (in the current database or KV) would map ids and hostnames to regions.
3. **EU-jurisdiction R2 buckets** (`EXPORTS`, `IMPORTS`, `MEDIA`, `REPORTS`, the dev mailbox) for EU workspaces, chosen by the same routing.
4. **Cross-region features.** Sign-in and seats span workspaces, so operators, sessions and seats would stay global (they hold operator data, not Member data), or move with a home region per operator. Suppressions, Circles, Flows, webhooks and exports already stay within one workspace.
5. **Durable Objects** (rate limiters, the send monitor) created with an EU jurisdiction for EU workspaces.
6. **SES** in an EU region, which the hosted service already uses.
7. **Moving an existing workspace** between regions: an export, import and cut-over job with a short write freeze, since D1 has no cross-database transactions.

None of this changes the API or the dashboard; it is storage and routing work in the workers and `@swarm/db`.
