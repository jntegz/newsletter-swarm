# Security

## Status

Swarm is feature-complete for a first release and has not had a tagged release yet.

- **In place and tested on every change:** the controls in [docs/security.md](docs/security.md), including passkeys and two-step sign-in, a single tenancy check with a declared role for every API route, a hash-chained audit log, signed and expiring tokens, optional encryption of sensitive subscriber fields, and signature checks on payment and email-service webhooks.
- **Not done yet:** an independent security review, and a record of running in production. The first installs on real accounts are still ahead.

Decide with that in mind. For a first install, start with a list you can afford to re-import, keep the `.swarm/` backup safe, and turn on a passkey or an authenticator app for every owner and admin.

## Reporting a vulnerability

Report privately through GitHub Security Advisories: <https://github.com/jntegz/newsletter-swarm/security/advisories/new>.

Do not open public issues or pull requests for vulnerabilities. Every deployed worker also serves `/.well-known/security.txt` with the same contact.

The [vulnerability disclosure policy](docs/disclosure.md) covers scope, the rules for testing and our safe-harbour promise. Each signed release carries two CycloneDX SBOMs inside the bundle, covered by its signature: one of production dependencies and one that adds the build tools (see [docs/releasing.md](docs/releasing.md)).

## Release signing

This section is the place to take the release values from, not the release host. It changes only by a reviewed commit.

- **Release signing key:** none published yet. When one is, its public key (PEM) and key id (the sha256 of its public half) go here, and the key id also goes into `PROJECT_RELEASE_KEYS` in `packages/installer/src/wizard/trust.ts`.
- **Current release:** none yet. Set `RELEASE_MIN_VERSION` on your Setup Worker to the version listed here, and compare the manifest sha256 the setup page shows with the one listed here.
- **Withdrawn releases and keys:** none. Withdrawn ones are listed here, in an advisory, and in `WITHDRAWN_RELEASES`; add them to `RELEASE_WITHDRAWN` on your Setup Worker.

## What to expect

- Acknowledgement within 5 working days.
- A triage outcome and a fix plan within 15 working days.
- Credit in the release notes if you would like it.

Critical issues may be contained by rotating keys or taking affected infrastructure offline before a code fix ships.

## Security model

See [docs/security.md](docs/security.md).
