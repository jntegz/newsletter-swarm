# Vulnerability disclosure policy

We welcome reports of security problems in Swarm: the code in this repository and the services it runs (the dashboard, the API, Capture Forms, the Member Center, Channel websites, tracking and mail). This page is the policy that `/.well-known/security.txt` on every public worker points to.

## How to report

Report privately through GitHub Security Advisories: <https://github.com/jntegz/newsletter-swarm/security/advisories/new>.

Include what you found, where (a URL, an endpoint or a file and line), how to reproduce it, and what an attacker could do with it. A short proof of concept helps. Write in English if you can.

Do not open a public issue, pull request or discussion for a vulnerability.

## What we promise

- An acknowledgement within 5 working days.
- A triage outcome and a fix plan within 15 working days, and updates while we work on it.
- No legal action against research done in good faith under this policy. We consider it authorised, and we will say so if anyone asks.
- Credit in the release notes and the advisory, if you would like it.

Swarm does not run a paid bounty programme yet.

## Rules for testing

- Use your own account, workspace and Channels, or ones whose owner has agreed. Never access, change or delete data that isn't yours; if you reach someone else's data by accident, stop, don't keep it, and tell us.
- Don't degrade the service for others: no denial of service, load testing or spam, and keep automated scanning gentle.
- Don't use social engineering, phishing or physical attacks against people or offices.
- Give us a reasonable time to fix the problem before you disclose it. We aim to publish an advisory within 90 days of the report, sooner when a fix ships.

## In scope

- Authentication and sessions (QuickPass, Google sign-in, passkeys, TOTP, SSO), authorisation between roles, workspaces and Channels.
- The dashboard API (`/api/v1`) and the public API (`/v2`), including scoped keys, OAuth and webhooks.
- Capture Forms, confirm and Member Center pages, Privacy Center requests and data exports.
- Channel websites, Gates and paid access, reader sign-in.
- Tracking links and pixels, unsubscribe handling, mail headers.
- Secrets handling, encryption of profile fields and credentials, and the dependencies we ship.

## Out of scope

- Reports from automated scanners without a demonstrated impact.
- Missing best-practice headers or settings without a way to exploit them.
- Attacks that need a compromised device, browser or mailbox of the victim.
- Rate limits that only cost the reporter time, and self-inflicted problems such as self-XSS.
- Vulnerabilities in Cloudflare, AWS or Stripe themselves; report those to them.

## Containment

For a critical issue we may rotate keys or take part of the service offline before a code fix ships.

See also [SECURITY.md](../SECURITY.md) and the security model in [security.md](security.md).
