# Swarm documentation

Pick the section that matches what you are doing. Guides for writers use the words you see in the dashboard. Reference pages for developers use the internal names in the code and API; [vocabulary.md](vocabulary.md) maps one to the other.

## Run your own Swarm

| Page                                          | What it covers                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| [Self-hosting](self-hosting.md)               | Installing with `pnpm swarm`, what it creates, updates, backups, staging and removal  |
| [Setup guide](setup-guide.md)                 | The browser setup page, the recovery kit and changing your email service              |
| [Releasing](releasing.md)                     | Building, signing, publishing and withdrawing a signed release                        |
| [Deployment](deployment.md)                   | Every binding, variable and secret, for people who set up by hand                     |
| [FAQ and troubleshooting](faq.md)             | Common questions and what to do when something goes wrong                             |
| [Data residency](data-residency.md)           | Where your data is stored                                                             |
| [GDPR](gdpr.md)                               | Who is responsible, what Swarm stores, data requests and what is left to you          |
| [Tracking and retention](privacy-controls.md) | Open and click tracking switches, a reader's own choice, and how long history is kept |

## Publish a newsletter

| Page                                          | What it covers                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| [Getting started](getting-started.md)         | The first hour: sender, domain, subscribers, a signup form and your first post  |
| [Writing and sending](writing-and-sending.md) | The editor, previews and tests, who gets a post, scheduling and the send report |
| [Templates](templates.md)                     | Starter templates, saving your own, and how your emails are designed            |
| [Audience](audience.md)                       | Subscribers, imports, segments, signup forms and inactive readers               |
| [Email checks](email-verification.md)         | Checking addresses with DeBounce at signup, on import and across your list      |
| [Rosters](rosters.md)                         | Several lists inside one publication                                            |
| [Website](website.md)                         | Website templates, settings, pages and sections                                 |
| [Landing pages](landing-pages.md)             | Single-purpose pages for signups, downloads and waitlists                       |
| [Link hub](link-hub.md)                       | A link-in-bio page on your website                                              |
| [Feed sync](feed-sync.md)                     | Turning an RSS feed into posts                                                  |
| [Copilot](copilot.md)                         | The writing assistant                                                           |

## Reach the inbox

| Page                                            | What it covers                                                          |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| [Domains](domains.md)                           | Sending domains, From addresses, website domains and link domains       |
| [Warm-up](warm-up.md)                           | Why a new domain sends gradually, the daily plan, pauses and recovery   |
| [Deliverability guide](deliverability-guide.md) | The check-up, each problem and its fix, and what to do about spam       |
| [Deliverability reference](deliverability.md)   | How DMARC reports, suppressions and dedicated sending work inside Swarm |
| [Engagement scores](engagement-scores.md)       | How Swarm scores how engaged each subscriber is                         |

## Earn and grow

| Page                              | What it covers                           |
| --------------------------------- | ---------------------------------------- |
| [Products](goods.md)              | Selling digital products                 |
| [Partners](partner-exchange.md)   | Recommending other publications          |
| [Sponsors](sponsor-match.md)      | A booking page for sponsors              |
| [Apps](applications.md)           | Connecting other services                |
| [App directory](app-directory.md) | Listing an app or a community automation |
| [WordPress](wordpress.md)         | The WordPress plugin                     |

## Build on Swarm

| Page                                  | What it covers                                       |
| ------------------------------------- | ---------------------------------------------------- |
| [API](api.md)                         | The public API (`/v2`), keys, limits and idempotency |
| [OpenAPI document](openapi-v2.json)   | The machine-readable contract for `/v2`              |
| [OAuth](oauth.md)                     | OAuth2 with PKCE for apps                            |
| [Webhooks](webhooks.md)               | Signed event webhooks, retries and redrive           |
| [Direct send](direct-send.md)         | Sending one-off email through the API                |
| [AI tools over MCP](open-operator.md) | Connecting an AI agent to a publication              |

## Understand the system

| Page                              | What it covers                                     |
| --------------------------------- | -------------------------------------------------- |
| [Architecture](architecture.md)   | How the workers, queues and database fit together  |
| [Security](security.md)           | Security controls and their status                 |
| [Vocabulary](vocabulary.md)       | The words in the dashboard and their names in code |
| [Load testing](load-testing.md)   | Scripts for a large send and a large import        |
| [Subprocessors](subprocessors.md) | Services that handle data on an install's behalf   |
| [Disclosure](disclosure.md)       | The vulnerability disclosure policy                |
