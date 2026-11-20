# Contributing to Swarm

Swarm is AGPL-3.0. By contributing, you agree to license your contributions under AGPL-3.0, the same license as the repository. See `LICENSE`.

## Setup

- Node.js 22+ and pnpm 10 (`corepack enable`).
- `pnpm install`, then `pnpm setup:dev`, then `pnpm dev`. `setup:dev` writes each worker's `.dev.vars` from its example, with random keys shared between the workers that need the same one, and creates the local database. Run it again after pulling new migrations.
- Secrets for local development live in each worker's `.dev.vars` (gitignored). A worker with a missing secret refuses requests and logs which key is missing.

## Rules that are not negotiable

1. **No secret fallbacks.** Every env value is declared in the worker's env schema (`@swarm/runtime` `defineEnv`). Never write `env.X ?? 'default'`; lint rejects it.
2. **No state changes on a GET** that a mail client or link scanner could prefetch. Show a page; perform the action on POST.
3. **One tenancy check.** Channel routes resolve access through `channelAccess` in `@swarm/db`; never hand-write a membership join. A channel the operator cannot see returns 404.
4. **Vocabulary.** Use the terms in `docs/vocabulary.md` in the database, API, code and UI copy. `pnpm check:vocabulary` enforces UI copy and docs.
5. **Contract first.** Routes are defined with zod schemas in the API worker; `pnpm openapi` regenerates `docs/openapi.json`, and CI fails if it is stale.
6. **Optional features sit behind a flag** registered in `packages/flags/src/registry.ts`, off by default, enforced on the server.

## Definition of done (every change)

- [ ] Spec or docs updated before the code.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm check:dead-code` green; new routes have cross-tenant and role tests.
- [ ] A Playwright story for user-facing flows; axe reports no violations.
- [ ] UI follows `DESIGN.md`, including default, hover, focus, disabled, loading, empty and error states.
- [ ] Every new binding and secret is in `docs/deployment.md`.

## Code style

- Prettier (`.prettierrc`): 100 columns, single quotes, trailing commas.
- Strict TypeScript (`tsconfig.base.json`), ESLint (`eslint.config.js`).
- Dependencies are pinned once in the `catalog:` section of `pnpm-workspace.yaml`.
- Imports: package imports (`node:`, `cloudflare:`, npm, `@swarm/*`) first, then relative ones (`import-x/order`).
- Migrations are forward-only. Never edit a committed file in `migrations/`; add the next numbered one, run `pnpm migrations:lock` (appends it to `migrations/SHA256SUMS`) and update the schema snapshot with `pnpm --filter @swarm/api exec vitest run tests/schema.test.ts -u`.
