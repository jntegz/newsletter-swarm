# Releasing

How a signed release is built, signed, published and, if it has to be, withdrawn. It is for the maintainer who holds the release signing key. Operators who install from a release need only the [setup guide](setup-guide.md) and the values in [SECURITY.md](../SECURITY.md#release-signing).

No release has been tagged yet. The first one also settles the owner decisions listed at the end.

## What a release is

A directory with every Worker bundled, the dashboard build, the migrations, two CycloneDX SBOMs and `manifest.json`, which lists every file with its size and sha256. `manifest.sig` is an Ed25519 signature over `manifest.json`. The manifest (format 2) also holds:

- `version` and `commit`: the release version and the commit tagged `v<version>`;
- `build`: `clean` for a release build, `trial` for anything else. Only `clean` can be signed, and the Setup Worker opens nothing else;
- `keyId`: the sha256 of the signing key's public half (SPKI), added at signing. The Setup Worker refuses a manifest whose `keyId` is not the key in its `RELEASE_PUBLIC_KEY`;
- `sbom`: the two SBOM files and what each covers. Both are listed in `files`, so the signature covers them too.

## Build

```bash
git tag -s v0.1.0            # the reviewed commit; a signed tag if you can
pnpm release:bundle -- --version 0.1.0
```

`release:bundle` refuses unless the checkout is clean (untracked files count) and `HEAD` is tagged `v<version>`. It then clones that commit into a fresh temporary directory, so nothing ignored in your checkout comes along (`node_modules`, `dist`, `.env`, `.dev.vars`), runs `pnpm install --frozen-lockfile` there, which checks every package against the lockfile's integrity hashes, and builds from that tree. It needs the package registry, or a pnpm store that already holds every locked package. Children it runs get no environment variable that looks like signing material.

It writes the SBOMs from the same tree: `sbom.cdx.json` (production dependencies of every workspace package) and `sbom-build-tools.cdx.json` (the same plus development dependencies, which include the bundler, wrangler and vite that produced the output). Each states its scope in `metadata.properties` (`swarm:scope`) and names the release and commit.

`--trial` (or the old `--unsigned`) builds this checkout in place, quickly, and marks the manifest `build: "trial"`. `--allow-dirty` is accepted only with it. A trial build can never be signed. `--key` is refused: the builder never signs.

What this does not give you: a byte-for-byte reproducible build. Nobody has shown the dashboard and worker bundles are deterministic, so a second builder can't yet confirm the output. The build still runs on your machine with your user's rights.

## Sign

```bash
pnpm release:sign -- --new-key ~/swarm-release/signing.pem     # once
pnpm release:sign -- --dir dist/release/0.1.0 --key ~/swarm-release/signing.pem
```

`release:sign` runs no build tool, package script or dependency: only Node's own crypto. It:

- refuses a key file inside the repository, and a key that is not encrypted (`--new-key` writes PKCS#8 encrypted with AES-256 under a passphrase of at least 16 characters, asked for twice on the terminal, or read from `RELEASE_KEY_PASSPHRASE`);
- refuses a trial build, a commit with `-dirty`, a commit that is not the one `v<version>` points at, a bundle without its SBOMs, and any file added, missing or changed since the build;
- prints the version, commit, file count and SBOMs, and asks you to type the version;
- adds `keyId` to the manifest, writes `manifest.sig`, and appends a line to `<key>.signing-log` (time, version, commit, key id, manifest sha256, your user name; no secret). Review that log: a line you don't recognise means the key was used without you.

`--new-key` prints the key id. On Windows file modes do not restrict who can read the key file, so the passphrase is its protection there.

### Custody (organizational, not enforced by code)

- Keep the key where builds can't read it: removable or hardware-backed storage attached only to sign, or a separate machine that receives only the built directory. The code refuses a key inside the repository but can't see the rest of your disk.
- Keep one encrypted backup somewhere only you can reach, and the passphrase apart from it. Losing the key means new installs and updates must move to a new key.
- A single maintainer holding the key is a single point of failure whichever storage you choose.

## Publish

1. Upload the signed directory to the release host behind `RELEASE_URL`. Who runs that host is an owner decision; nothing in the repository depends on it.
2. Publish the public key and its key id **somewhere other than the release host**: in [SECURITY.md](../SECURITY.md#release-signing) in this repository, through a reviewed commit, and add the key id to `PROJECT_RELEASE_KEYS` in `packages/installer/src/wizard/trust.ts`. A Setup Worker deployed from that commit then says whether the key it was given is the project's.
3. List the release in SECURITY.md as the current one, with its manifest sha256, so operators can set `RELEASE_MIN_VERSION` to it and compare what the setup page shows.

The setup page shows the version, the manifest sha256 and the signing key id before anything is installed, and installs only after the operator approves exactly that release.

## The release workflow on GitHub

`.github/workflows/release.yml` attaches an SBOM to a GitHub release when one is published, if GitHub Actions is enabled. It describes the tagged source as CI installs it, not the signed bundle; the signed bundle's own SBOMs are the ones to rely on. The workflow has no permissions by default. Its `sbom` job runs the install and `pnpm sbom` with a read-only token and no cache, and hands the file on as an artifact with its sha256. The `attach` job, the only one that can write, runs on a fresh runner, uses no action and no repository, package or Node code, calls preinstalled tools by absolute path (`/usr/bin/gh`, `/usr/bin/jq`), checks the downloaded file against that sha256 and the tag, and uploads it without replacing an existing asset (a re-run after a partial upload needs the old asset deleted by hand). `scripts/tests/workflows.test.mjs` checks this shape.

**Decision: the workflow stays, in this shape.** The owner chose to keep it rather than remove it and move the SBOM into the local procedure, because:

- the project says every GitHub release carries an SBOM, and this keeps that true without a maintainer remembering a manual step;
- it is a second description of the tagged source, made on a machine other than the maintainer's, from the same lockfile, so a difference from the signed bundle's own SBOMs is something to look into;
- it can't weaken the signed release: it never sees the signing key, never touches the signed bundle, and the Setup Worker trusts only the signature, not anything this workflow attaches;
- its authority is small and checked: no permissions by default, the install and the SBOM run with a read-only token and no cache, and the one job that can write runs no repository, dependency or package-manager code and never replaces an asset.

It only runs if GitHub Actions is enabled for the repository. Changing any of the points above reopens the decision; the test fails on a cache in the `sbom` job, `--clobber`, an action or package-manager command in `attach`, or a second job that can write.

## Toolchain

- **pnpm** is named by content: `packageManager` in `package.json` carries the sha512 of the pnpm package. Every job that runs pnpm (CI, e2e and the release `sbom` job) gets it from `node scripts/ci-pnpm.mjs` right after setting up Node, not from `pnpm/action-setup`. The script refuses a `packageManager` without a sha512, points `COREPACK_HOME` at a new empty folder (corepack reuses a copy it already holds without checking it again, so nothing left on the runner image can stand in), runs `corepack enable pnpm` and `corepack install`, which stops with "Mismatch hashes" if the download is not the file the hash names, and then compares the hash corepack recorded for what it kept with `packageManager` once more. Any of these failing fails the job. The jobs then record the pnpm and Node versions and test them against the pins. Because pnpm now arrives after Node, CI no longer uses setup-node's pnpm store cache; installs download from the registry each run and are checked against the lockfile. `scripts/tests/workflows.test.mjs` checks the workflows' shape and runs the script against a stand-in corepack; the workflows themselves can only be tried on GitHub.
- **Node** is pinned to an exact version in `.node-version`, used by both workflows; each run checks it and records the binary's sha256. `engines` still accepts any Node 22 or later for local work.
- **Runner image** is the fixed label `ubuntu-24.04`. GitHub still updates that image weekly, which the repository can't pin; each run prints `ImageOS` and `ImageVersion`.
- **Actions** are pinned by commit sha. Renovate (14-day minimum release age) proposes updates; a change to any of these pins is a reviewed commit.

To update pnpm: `corepack use pnpm@<version>` writes the new version and hash.

## Withdraw a release or a key

Withdrawal data lives in two places the release host does not control:

- `WITHDRAWN_RELEASES` in `packages/installer/src/wizard/trust.ts`, changed by a reviewed commit, so a Setup Worker deployed from a newer commit refuses it;
- `RELEASE_WITHDRAWN` on the operator's own Setup Worker: versions, manifest digests or key ids, separated by commas or spaces.

A withdrawn release or key is refused at the first open and at every later step. To withdraw:

1. Publish an advisory (GitHub Security Advisories) naming the version, manifest sha256 or key id, and the replacement.
2. Add the entry to `WITHDRAWN_RELEASES` and to SECURITY.md, and remove a withdrawn key from `PROJECT_RELEASE_KEYS`.
3. For a key: make a new key, sign the replacement release with it, publish the new public key and id as above.

Operators then:

- **Install in progress:** set `RELEASE_WITHDRAWN`, serve the replacement at `RELEASE_URL` (with the new `RELEASE_PUBLIC_KEY` if the key changed) and raise `RELEASE_MIN_VERSION`. The page stops, says the release was withdrawn, and offers **Use the replacement release**: it offers the replacement for approval and runs the database and Worker steps again from it, so nothing from the withdrawn release stays deployed and no two releases are mixed. Migrations the withdrawn release already applied stay applied; the advisory must say if one needs undoing.
- **Finished install:** restore the recovery kit into a checkout of the replacement's tag (`pnpm swarm restore`) and run `pnpm swarm update`, which deploys from that checkout.

This has been rehearsed only in the Setup Worker's tests with throwaway keys, not with a real release host. Self-hosted installs have no channel the project can push to; operators learn of a withdrawal only by watching the advisories.

## Decisions for the owner

- Who operates the release host behind `RELEASE_URL`.
- Where the key lives and who may use it; whether a second person must review a release before it is signed.
- The first key id and current version to publish in SECURITY.md and `trust.ts`.

Settled: `.github/workflows/release.yml` stays, as described [above](#the-release-workflow-on-github).
