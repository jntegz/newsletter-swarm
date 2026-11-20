# Self-hosting Swarm on Cloudflare

Swarm runs entirely on your own Cloudflare account. One command, `pnpm swarm`, creates everything it needs, deploys it on a domain you already have on Cloudflare, and gives you a sign-in link for the owner account.

This guide is for people running their own Swarm. For the manual, binding-by-binding reference, see [deployment.md](deployment.md).

## What you need

- **A Cloudflare account with a domain on it.** The domain's status must be _Active_, which means its nameservers point to Cloudflare. Swarm only adds subdomains (`app.`, `forms.`, `mail.` and a few more); your main site and the domain's own mail are not touched.
- **A Cloudflare plan that includes Queues and Durable Objects.** Swarm uses both. The Workers Paid plan has them; check your plan if you are on another one.
- **Node.js 22 or newer, pnpm 10 and git.** Run `corepack enable` once to get pnpm.
- **A way to send email**, one of:
  - a [Resend](https://resend.com) API key with _Full access_, or
  - an AWS account and an access key that can manage SES, SNS and IAM (an administrator key works). The installer uses it only while it runs and never saves it.
- **A browser on the same computer**, so wrangler can sign in to Cloudflare.

Payments (Stripe), Google sign-in and custom domains for publications are optional and can be turned on later.

## Install

```bash
git clone https://github.com/jntegz/newsletter-swarm.git swarm && cd swarm
pnpm install
pnpm swarm
```

The installer explains each step as it goes. If it stops, for any reason, run `pnpm swarm` again: finished steps are skipped, nothing is created twice, and keys are never replaced.

To see every action before anything happens, run `pnpm swarm --dry-run`. It asks the same questions and lists each call it would make, with made-up ids, but changes nothing.

### With the browser setup page

The `swarm-setup` Worker (`apps/setup`) installs the same Workers from a signed release instead of from this checkout. Deploy it with the secret `SETUP_PASSWORD` and the variables `RELEASE_URL`, `RELEASE_PUBLIC_KEY` and `RELEASE_MIN_VERSION`. Take the public key, its key id and the current version from [SECURITY.md](../SECURITY.md#release-signing) in this repository, never from the release host itself. `RELEASE_MIN_VERSION` is required: every release ever signed passes the signature check, so without that floor whoever serves `RELEASE_URL` could hand your install an older signed release, and the page opens nothing until it is set (`RELEASE_ACCEPT_ANY_VERSION=true` overrides this; don't). `RELEASE_WITHDRAWN` lists releases or keys the project has withdrawn. Before anything is changed on your Cloudflare account, the page shows the release's version, manifest sha256 and signing key id, says whether the key is one the project publishes, and waits for you to approve exactly that release; the install then keeps to it. The [setup guide](setup-guide.md) covers the rest, and [releasing.md](releasing.md) how releases are made.

### What the installer asks

1. **Cloudflare sign-in.** A browser window opens so you can let wrangler use your account. If the sign-in can see several accounts, you pick one.
2. **Which domain.** Pick a domain on that account. The installer then shows the addresses it will set up (see the table below) and asks you to confirm.
3. **A DNS token.** The installer prints a link to the Cloudflare dashboard with the permissions filled in: _Zone > DNS > Edit_, _Zone > Zone > Read_, _Zone > Workers Routes > Edit_ and _Zone > Zone Settings > Edit_. Create the token and paste it. It is used during the install and is not given to any worker. You can choose to keep it in `.swarm/` so that `update` and `doctor` can fix DNS later; by default it is not kept, and you paste it again when needed.
4. **Subdomains to leave alone.** Publication websites live at `<address>.<your domain>`, served through a `*.<your domain>/*` route. If you already have proxied subdomains (say `shop.example.com`), the installer lists them and adds an exclusion route for each one you keep, so they go on working as they do now.
5. **Your name and email.** You become the owner of this Swarm and sign in with this address.
6. **Your first publication.** A name, and a web address: `<address>.<your domain>`. Swarm reserves `app`, `forms`, `link`, `media`, `events`, `sites`, `mail`, `unsubscribe`, `dmarc`, `www` and anything starting with `staging-`.
7. **How to send email.** Resend, Amazon SES, Mailgun, Postmark or your own mail server (see [Choosing Resend or Amazon SES](#choosing-resend-or-amazon-ses)), the region, and the API key or the AWS key.
8. **Amazon SES only: production access.** A new AWS account starts in the SES sandbox. The installer explains what that means and offers to send AWS the request to leave it.

### Addresses

For the domain `example.com`, production gets these addresses:

| Address                   | What it is                                                            |
| ------------------------- | --------------------------------------------------------------------- |
| `app.example.com`         | The dashboard and the API                                             |
| `forms.example.com`       | Signup forms and the pages subscribers manage their account on        |
| `link.example.com`        | Click and open tracking                                               |
| `media.example.com`       | Images and files                                                      |
| `events.example.com`      | Delivery events from your mail provider                               |
| `<address>.example.com`   | Publication websites                                                  |
| `mail.example.com`        | The sending domain; sign-in mail comes from `signin@mail.example.com` |
| `unsubscribe.example.com` | Unsubscribe by email                                                  |
| `dmarc.example.com`       | DMARC reports                                                         |

Every web address is a Worker route on your zone (`app.example.com/*` and so on) with a proxied `AAAA 100::` record, so no custom-domain setup is needed. The most specific route wins, so `app.example.com/*` is never caught by `*.example.com/*`.

### What it creates

On Cloudflare, for the environment `production` (`staging` uses `staging` in the same places):

| Kind             | Names                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workers          | `swarm-realtime`, `swarm-vault`, `swarm-track`, `swarm-events`, `swarm-site`, `swarm-capture`, `swarm-send`, `swarm-jobs`, `swarm-api`                        |
| D1 database      | `swarm-production`                                                                                                                                            |
| KV namespace     | `swarm-production-cache`                                                                                                                                      |
| R2 buckets       | `swarm-production-media`, `swarm-production-imports`, `swarm-production-exports`, `swarm-production-reports`                                                  |
| Queues           | `swarm-production-send`, `-send-dlq`, `-jobs`, `-jobs-dlq`, `-webhooks`, `-webhooks-dlq`, `-public`, `-public-dlq` (each with the `swarm-production-` prefix) |
| Turnstile widget | `swarm-production`                                                                                                                                            |
| Email Routing    | rules `swarm-production-unsubscribe` and `swarm-production-dmarc`, sending to `swarm-events`                                                                  |

DNS records in your zone:

| Record                                    | Type    | Value                                                               |
| ----------------------------------------- | ------- | ------------------------------------------------------------------- |
| `app`, `forms`, `link`, `media`, `events` | AAAA    | `100::`, proxied                                                    |
| `*` (production only)                     | AAAA    | `100::`, proxied: publication websites                              |
| `_dmarc.mail`                             | TXT     | `v=DMARC1; p=quarantine; adkim=r; aspf=r`                           |
| `*._report._dmarc.dmarc`                  | TXT     | `v=DMARC1`, so mailbox providers may send DMARC reports to `dmarc.` |
| Resend: `resend._domainkey.mail`          | TXT     | the DKIM key Resend gives                                           |
| Resend: `bounce.mail`                     | MX, TXT | the return-path records Resend gives                                |
| SES: three `<token>._domainkey.mail`      | CNAME   | `<token>.dkim.amazonses.com`                                        |
| SES: `bounce.mail`                        | MX      | `feedback-smtp.<region>.amazonses.com`, priority 10                 |
| SES: `bounce.mail`                        | TXT     | `v=spf1 include:amazonses.com ~all`                                 |

Email Routing adds its own records for `unsubscribe.` and `dmarc.` when the installer turns it on for those two subdomains. Your domain's own MX records are left as they are.

With your mail provider:

- **Resend:** the domain `mail.<your domain>` (open and click tracking off, because Swarm tracks those itself) and a webhook to `https://events.<your domain>/resend`.
- **Amazon SES:** the SNS topic `swarm-production-ses-events`; the configuration sets `swarm-production-broadcasts`, `swarm-production-transactional` and `swarm-production-direct`; the IAM user `swarm-production-workers` with an inline policy `swarm-send-mail` that can only send mail, manage sending domains and keep the SES suppression list, and one access key for the workers; the identity `mail.<your domain>` with a `bounce.` MAIL FROM domain; and your own email address as a verified identity, so sign-in mail reaches you while the account is in the sandbox. It also sets the account's suppression list to add addresses for hard bounces only (`PutAccountSuppressionAttributes`), so one workspace's complaints stay with that workspace (docs/deliverability.md "Suppressions"). Re-running changes nothing once it is set; `--dry-run` shows the step.

In the database: your owner account, a workspace named after your first publication, the publication itself, and two instance settings: you are an instance admin, and sign-up is invite-only.

On your computer:

- `.swarm/production.json` (ids and your answers) and `.swarm/production.secrets.json` (keys, encrypted under a passphrase you choose the first time the installer saves them). Both are ignored by git. See [Back up .swarm/](#back-up-swarm).
- `workers/<worker>/wrangler.production.generated.jsonc`, the deployed config of each worker, rendered from the committed `wrangler.jsonc`. Also ignored by git. The committed files are never edited, so `git pull` stays clean.

### Signing in

At the end the installer prints a one-time sign-in link:

```
Sign in (works once, for 60 minutes):
https://app.example.com/sign-in/continue#token=…
```

Open it to sign in as the owner. It works even before your sending domain is verified, so you are not waiting on DNS. Treat it like a password until you have used it. For a new link later, run:

```bash
pnpm swarm signin-link
```

After that, sign in with your email address as usual: Swarm emails you a sign-in link.

## Choosing Resend or Amazon SES

Both send every kind of Swarm mail: posts, automations, sign-in and signup confirmations. Bounces and spam complaints come back to Swarm either way and suppress the address.

|                     | Resend                                                              | Amazon SES                                                                                          |
| ------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Getting started     | Fastest: one API key, and the domain often verifies within minutes. | Needs an AWS account. New accounts start in the sandbox.                                            |
| Free use            | The free plan allows 100 emails a day and 3,000 a month.            | You pay per email, apart from any AWS free allowance.                                               |
| At volume           | Paid plans by monthly volume.                                       | The cheapest option once you send a lot.                                                            |
| Speed               | 2 requests a second per team by default; set it as a sending limit. | Up to your SES sending rate; set it as a sending limit.                                             |
| Before you can send | Nothing beyond the verified domain.                                 | Production access. In the sandbox, SES delivers only to verified addresses, up to 200 emails a day. |
| Dedicated sending   | Not available.                                                      | Available: configuration sets and dedicated IPs per publication, under Sending & delivery.          |

Things to know about each:

- **Set your plan's limits under Sending limits.** When a send reaches Resend's daily limit, the rest waits for the next day and goes out by itself; at the monthly limit, it pauses until the next month or until you resume it. Nobody is dropped. See [Sending limits](#sending-limits). On the free plan, a list of more than 100 subscribers takes days to reach everyone, so it needs a paid plan.
- **Each publication's own sending domain is another domain on your Resend account.** Check how many domains your Resend plan allows before publications add their own.
- **Swarm never uses a domain your mail service account already has.** A publication that adds one is asked to have it removed first, because it may be your own or the other environment's. Remove it at the service (or in Swarm, if a publication added it) and add it again.
- **Removing a suppression in Swarm does not reach Resend.** Resend keeps its own suppression list, and Swarm does not sync with it. If you remove a suppression in Swarm, the address stays on Resend's list, so the next send to it is refused, Swarm records that as a hard bounce, and the address is suppressed again. To mail the address again, also remove it on the _Suppressions_ page of the Resend dashboard, after fixing whatever made it bounce. With SES, Swarm removes hard bounces from the SES list for you.
- **SES production access is a request a person at AWS reviews**, usually within a day. The installer can send it for you (it describes Swarm's opt-in, one-click unsubscribe and bounce handling). Until it is granted, sign-in mail reaches you once you click the link in the email from AWS, and posts reach only verified addresses.
- **Mailgun is also available, as a preview.** Choose it in the installer with your account's Private API key (a domain sending key is not enough) and your region, US or EU. It is tested against a stand-in for Mailgun's API only, not yet with a real account or a real send. Dedicated sending stays SES-only, Swarm does not sync with Mailgun's suppression lists, and Mailgun documents no way to stop a retried request from mailing twice, so a server error during a send can in rare cases send one email twice.
- **Postmark is also available, as a preview.** Choose it in the installer with your Account API token. Swarm creates a server and a separate stream for posts, because Postmark keeps bulk mail apart. It is tested against a stand-in for Postmark's API only, not yet with a real account or a real send. Until Postmark approves a new account, it only delivers to addresses on your own domain. Postmark handles unsubscribes on that stream unless it has approved your account for custom handling, so readers may see its unsubscribe link as well as Swarm's. Dedicated sending stays SES-only, and a server error during a send can in rare cases send one email twice.
- **Your own mail server (SMTP) is an option for advanced users, as a preview.** Workers can reach mail servers on ports 465 and 587, but Cloudflare blocks port 25, and a server on an address Cloudflare proxies can't be reached. Your server must sign with DKIM, and you publish its DKIM and SPF records yourself. **Plain SMTP doesn't report spam complaints**, so Swarm can't pause a send when they rise unless your server reports them. Bounces reach Swarm only if your server keeps Swarm's return path or reports them. It is tested against a stand-in server only, not yet with a real send.
- **You can change service later.** The installer keeps the provider in `.swarm/`. `pnpm swarm mail switch <service>` starts a change, with your current service still sending until you move. See [Changing your email service](setup-guide.md#changing-your-email-service). It hasn't run against real accounts yet.

## Sending limits

Every email service limits how much you can send: so many emails a second, and on some plans so many a day or a month. Tell Swarm your plan's limits under **Settings > Instance > Sending limits** (instance admins only) and everything this install sends keeps to them together, because it all goes through one email account: posts, automation emails, the Direct Send API, sign-in links, signup confirmations, invites, receipts and notices.

**The limits.** Each is optional; an empty field means no limit of that kind.

| Limit           | Allowed values    | What is counted                                   |
| --------------- | ----------------- | ------------------------------------------------- |
| Emails a second | 0.1 to 1,000      | A steady rate: 0.5 is one email every two seconds |
| Emails an hour  | 10 to 100,000,000 | Each UTC clock hour, from :00 to the next :00     |
| Emails a day    | 10 to 100,000,000 | Each UTC calendar day, from 00:00                 |
| Emails a month  | 10 to 100,000,000 | Each UTC calendar month, from the 1st             |

The hour, day and month are fixed windows: the count starts again at zero when the next one begins. An hour can't allow more than its day, or a day more than its month. Some services count a rolling 24 hours rather than the calendar day (Amazon SES does); if yours does, set the daily limit a little lower than the service's.

**Start from your plan.** The form can fill in the published limits of common plans. These were the services' published limits when this was written, so check your plan before you rely on them:

| Service    | Plan         | Filled in                                                         |
| ---------- | ------------ | ----------------------------------------------------------------- |
| Resend     | Free         | 2 a second, 100 a day, 3,000 a month                              |
| Resend     | Paid         | 2 a second (ask Resend for a higher rate)                         |
| Amazon SES | Sandbox      | 1 a second, 200 a day                                             |
| Amazon SES | Your account | Your account's maximum send rate and 24-hour quota, read from SES |
| Mailgun    | Free         | 100 a day                                                         |
| Postmark   | Free         | 100 a month                                                       |

**Mail people wait for comes first.** Posts, automation emails and one-off Direct Sends may use 90% of each hour, day and month. The last 10% is kept for mail someone is waiting for: sign-in links, signup confirmations, invites, receipts, transactional Direct Sends and notices. That mail may use all of each window, and it goes ahead of every part of a big send that hasn't been handed out yet in the per-second line, so a send to 50,000 people holds up a sign-in link by a few seconds at most, and the two together never go over the per-second limit.

**Nothing is lost over a limit.** Swarm never drops a reader to stay under a limit. What doesn't fit waits and goes out later, each person once:

- **Hour or day:** the rest of the send waits for the next hour or day and goes on by itself. Its send report says so: "Waiting for your email service's daily limit: 1,240 left, continues at 00:00 UTC". Home mentions it while it lasts.
- **Month:** the send pauses until the 1st, and the publication's owners and admins get an email. It goes on by itself when the month turns, or sooner when an admin chooses **Resume sending** on the send report after you raise the limit.
- **Saving new limits** applies them to the next email everywhere, and lets sends waiting for this Swarm's own limits try again at once. If the new limit still holds, they wait again.
- **Automation emails** wait the same way, and **Direct Send** answers `429` with `Retry-After` until the limit allows ([direct-send.md](direct-send.md)).

**When the email service itself says no:**

- **Its daily or monthly quota is used up** (Resend `daily_quota_exceeded` and `monthly_quota_exceeded`, SES "Daily message quota exceeded", Postmark "Not allowed to send"): the send waits for the next UTC day, or pauses until the next month as above, and every other send and every Direct Send stops asking the service until then (Direct Send answers `429`). Sign-in links, signup confirmations and other mail Swarm sends itself are still tried, in case the service accepts them. This happens when the limits in Swarm are higher than your plan's, or when something else uses the same account.
- **It stops accepting mail** (a suspended account, a key it refuses, a domain it doesn't accept): the send pauses with everyone not yet sent still waiting, and the owners get an email if the service still sends it. Swarm tries the service again by itself with one email, after 5 minutes and then less often (at most 6 hours apart), and the rest of the send goes out as soon as it takes mail. Fix the email service, then choose **Resume sending** on the send report to go at once. If it still refuses mail 7 days after it stopped, the send ends as failed (partially failed if some went), everyone still waiting is counted as failed, and the owners get an email; a post nobody got goes back to drafts. An automation email's subscribers who were waiting are counted as failed the same way, and the automation goes on with the next ones.
- **It asks Swarm to slow down** (a `429` or a server error): the batch is tried again with a growing delay, up to 15 minutes apart, for as long as it takes. A batch never reaches the dead-letter queue just for waiting.

**Usage.** Settings > Instance shows how many emails were counted this hour, today and this month against each limit, whether the email service said its quota is used up, and how many sends are waiting.

**Warm-up is a separate limit.** While a sending domain warms up, it also has its own daily limit ([Warm-up](warm-up.md)). Both apply: each day, the lower of the two decides how many go out.

**`MAIL_MAX_PER_SECOND`.** Installs that set this variable on the send worker keep it: it is now a ceiling on the per-second limit, and the lower of the two applies to every email the install sends. You can remove the variable once the setting says what you want.

**If the limit counter can't be reached** (the realtime worker is down), email still goes out: sends keep to the per-second limit on their own, hours, days and months aren't counted until it is back, and the email service's own quota answers are still handled. A change to the limits applies from the next email; if the counter couldn't be reached when you saved, it reaches every part of Swarm within 30 seconds.

## Who can sign up

A fresh install is **invite-only**: only the owner and people with an invite can get in.

- Someone with an unknown address who asks for a sign-in link gets an email instead, saying that this Swarm is invite-only and to ask the owner for an invite. The sign-in page answers the same way for every address, so it does not reveal who has an account. One address gets at most three of these emails at once, then one every eight hours; further requests get the same answer and send nothing.
- Google sign-in with an unknown address returns to the sign-in page with the same message.
- Someone with a pending invite can sign in, and joins the workspace that invited them. They do not get a workspace of their own.
- Single sign-on, which is off by default, does not follow this setting when you turn it on: see [Single sign-on](#single-sign-on).

To change it, go to **Settings > Instance** (only instance admins see this tab; the installer makes the owner one) and choose:

- **Only people you invite**, or
- **Anyone with the link**: anyone who can open your Swarm can sign up and gets a workspace of their own.

The installer sets invite-only right after the database migrations, before it deploys any worker, so sign-up is never open while the install runs. Re-running the installer keeps whatever you chose. The setting lives in the `instance_settings` table (migration `0032_instance.sql`); with no row, local development is open, and a deployed install lets in only its first account and then needs invites.

There is no screen yet for adding another instance admin. To add one, run this from `workers/api` (use your own address and environment):

```bash
pnpm exec wrangler d1 execute DB --remote --config wrangler.production.generated.jsonc --env production \
  --command "INSERT INTO instance_admins (operator_id, created_at) SELECT id, strftime('%s','now') * 1000 FROM operators WHERE email = 'someone@example.com'"
```

The person must have signed in once, so their account exists. The workspace their first sign-in made is then allowed to run website code on this Swarm's domain and use its DeBounce credits; any other workspace, even one where they are an owner, is allowed in Settings > Instance.

**Instance admins need a second factor of their own.** Settings > Instance opens only for a session that proved a passkey, an authenticator app or a recovery code (an SSO provider's MFA claim does not count, and there is no grace period), and every change there asks for that check again if it is more than 10 minutes old. Each change is emailed to the other instance admins. Add a factor under **Settings > Security** before you need it. If the only instance admin loses theirs, the commands in this guide (`pnpm swarm …`, or `wrangler d1 execute` as above) still change instance settings with your Cloudflare credentials, and deleting that account's rows in `passkeys` and `totp_secrets` lets it set up a new factor.

## Features

Parts of Swarm can be turned on or off for everyone using your install. After an install, these are **on**:

| Area               | Features                                                                                                                                                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Writing            | Raw HTML posts (`raw_html_mode`), code blocks (`code_embeds`), Smart blocks (`smart_blocks`), email or website blocks (`block_visibility`), Series (`post_series`), design templates (`design_templates`), custom email styles (`custom_email_css`)                              |
| Sending            | Split tests (`split_tests`), cohort sampling (`cohort_sampling`), best-time sending (`best_time_send`), the click map (`click_map`), Rosters (`rosters`), feed sync (`feed_sync`)                                                                                                |
| Signups and growth | Signup journeys (`signup_journeys`), survey after signup (`reader_survey_on_subscribe`), welcome page (`welcome_page`), Smart prompts (`smart_prompts`), referral leaderboard and awards (`referral_awards`)                                                                     |
| Website            | Homepage layouts (`site_homepage_layouts`), sections (`site_sections`), previous and next links (`site_prev_next_nav`), drop caps and type options (`site_drop_caps`), author pages (`author_pages`), link hub (`link_hub`), paid posts in search engines (`gated_seo_exposure`) |
| Paid subscriptions | Founding plan (`founding_level`), pay what you want (`pay_what_you_want`), coupons at the paywall (`paywall_coupon`), gift subscriptions (`gift_passes`), gift a post (`gift_articles`), pledges (`pledges`)                                                                     |
| Apps               | App directory (`app_directory`), AI tools over MCP (`open_operator_mcp`), email checks with DeBounce (`email_verification`, inert until `pnpm swarm enable debounce` sets its key)                                                                                               |

**Copilot starts off**, because it uses a paid AI service: `copilot`, `copilot_byok` (a workspace's own AI key) and `copilot_actions`. With these on, Copilot runs on Cloudflare Workers AI and bills to your Cloudflare account, unless a workspace brings its own key. See [copilot.md](copilot.md).

Some settings go further than the switch. "Paid posts in search engines" also needs each publication to choose it in its website settings, and paid subscriptions need `pnpm swarm enable payments`.

**Where subscribers came from starts off** (`subscribe_attribution_fields`). When on, Swarm keeps each signup's link tags, referrer and landing page, which is personal data in some countries. Check what your privacy notice says before you turn it on.

**Single sign-on also starts off** (`sso`), because it has never been tested with a real identity provider. See [Single sign-on](#single-sign-on).

**To change a feature**, use either of these. They change the same setting:

- In the dashboard, go to **Settings > Instance > Features** (only instance admins see this).
- On the command line, on the computer you installed from:

  ```bash
  pnpm swarm feature list
  pnpm swarm feature split_tests off
  pnpm swarm feature copilot on
  ```

**A change can take up to a minute** to reach everyone, because each worker keeps its copy of the settings for up to 60 seconds. Website pages can take up to six minutes, because a page that is already stored stays as it is for up to five minutes more. The dashboard and `feature list` show what is saved straight away.

Your choices stay. Running `pnpm swarm` again or `pnpm swarm update` only fills in features that have no setting yet, such as a feature new in that version, which then starts on (or off, for those that start off). So after updating an install from before this existed, these features are on unless you turn them off. Turning a feature off is saved as off and an update never turns it back on.

The setting for each feature is a row in `feature_flags` with `scope = 'platform'`. A row for one workspace or publication overrides it, but nothing in Swarm writes those; they exist only if you added them yourself.

The plain subscribe form (`nojs_subscribe`) is in `feature list` but has no switch in the dashboard: it always works, so changing it does nothing.

### Tracking and retention

Open and click tracking per person, and reader profiles (engagement scores and best-time sending), are off for a publication made after this version, including the first one an install creates; publications that already existed keep what they had. Each publication turns them on or off under **Sending & delivery > Tracking** (get your readers' consent before turning them on), and each subscriber can turn tracking off for themselves in their subscriber settings. Per-person engagement history is kept for 13 months by default and then stripped of the person, with send report numbers kept; change it under **Settings > Privacy**. Say in your privacy notice what you track and for how long. Details: [Tracking and retention](privacy-controls.md).

## Single sign-on

Swarm has single sign-on with OpenID Connect (OIDC). It is built but off by default, because it has not been tested with a real identity provider. If you have one, you can turn it on:

- in **Settings > Instance**, or
- with `pnpm swarm feature sso on`.

The change takes up to a minute to reach every request. It applies to the whole install. SSO also needs a workspace on Pro or up, and the workspace the installer creates is.

Then a workspace admin sets it up under **Settings > Security > Single sign-on**: add the issuer URL, client ID and client secret, register `https://app.<your domain>/api/v1/auth/sso/callback` as the redirect URI at the provider, publish the TXT record shown for each email domain, verify it, and activate the connection.

**What is untested.** Only a fake identity provider in the automated tests has ever answered Swarm: discovery, the token exchange and ID token checks have not met a real one. Try it on a staging install first, and leave **enforced** off until people can sign in. Owners can always get in without SSO. SAML and SCIM are not built, and are not scheduled until there is a provider to test with.

**Invite-only does not apply to SSO.** A connection with _Seat for new teammates on first sign-in_ set creates an account and a seat, with no invite, for anyone new whose provider vouches for an address on a verified domain. This happens even when your Swarm is invite-only, because SSO is a separate way in. To let in only people you invite, set that option to _Off: invite people yourself_; a new address is then refused. Someone who already has an account with seats in other workspaces is never given a seat this way: invite them, and once they accept, SSO signs them in to that workspace only (their other workspaces need their own second factor or a sign-in link).

**Turning it off again.** The sign-in option and the settings disappear, and every SSO route answers `404 feature_disabled`. Connections stay stored and enforced ones stop applying, so people can sign in with a link instead. Sessions that were signed in through SSO end at once (people sign in again with a link); other sessions are not affected.

## Commands

```
pnpm swarm [command] [options]

  install                 Set up Swarm on your Cloudflare account (the default)
  doctor                  Check an install and say how to fix what is wrong
  update                  Pull the latest version and deploy it
  enable <feature>        Turn on custom-domains, payments or google
  feature list            Show which features are on
  feature <key> on|off    Turn one feature on or off for this Swarm
  signin-link             Make a new one-time sign-in link for the owner
  rotate-keys <KEYRING>   A new key for one keyring; the old one keeps verifying
  rotate-keys <KEYRING> --retire
                          Remove the old key, once nothing that still matters needs it

  --env production|staging   Which environment (default: production)
  --dry-run                  Show every action without changing anything
  --answers <file.json>      Answer the questions from a file (non-interactive)
  --yes                      Accept the defaults without asking
  --kit <file.json>          Where rotate-keys writes the new recovery kit
  --link-keys=verify-only    update: give every worker the per-link keys, but keep signing
                             links the old way (run update again to finish)
```

### Check an install: `pnpm swarm doctor`

`doctor` changes nothing. It checks, and for each problem says how to fix it:

- the worker configs match what the installer would render now;
- every Cloudflare resource exists, every worker has all the secrets it needs, and none still holds a keyring it no longer should (such as `MEMBER_KEYS` after its time);
- the public workers (`swarm-capture`, `swarm-events`) can write to the public queue only;
- `swarm-api`, `swarm-capture`, `swarm-site` and `swarm-jobs` reach the vault only through their own entrypoint, and no other worker binds to it;
- where the move to [per-link keys](#per-link-keys) is, and whether an `update` would finish it;
- the database has no pending migrations;
- every address answers on `/healthz` and reports the right environment (a worker bound to the vault answers 503 when the vault does not answer it), and the jobs worker, which has no address, has recorded a successful vault check since the deploy;
- the DKIM, MAIL FROM and DMARC records resolve (checked over DNS-over-HTTPS), and DMARC is `p=quarantine` or stricter;
- the mail provider reports the sending domain as verified, and whether SES is still in the sandbox;
- the owner account exists, and which sign-up mode is on.

It exits with status 1 when it finds a problem, so it can run in a scheduled job.

### Update: `pnpm swarm update`

`update` runs `git pull --ff-only` and `pnpm install --frozen-lockfile`, then, without questions: creates any new resources, renders the configs, applies database migrations, fills in any [feature](#features) with no setting yet, builds the dashboard, deploys every worker (`swarm-realtime` first, then `swarm-vault`, `swarm-api` last), removes keyrings a worker no longer holds (below) and checks health. DNS records are only rewritten if the DNS token is kept in `.swarm/`; otherwise that step is skipped with a note.

**The public queue.** Installs made before it get two new queues on their next update, `swarm-<env>-public` and `swarm-<env>-public-dlq`, and nothing else changes on the account. The update creates them before it deploys, `swarm-events` and `swarm-capture` deploy onto the new queue and lose their binding to the jobs queue, and `swarm-jobs` deploys last of the three with the new queue's consumer. Changes made in the seconds between wait on the queue for the consumer. Nothing on the jobs queue needs draining: what capture and events queued there before the update still runs. Rolling back to an older release puts capture and events back on the jobs queue; messages left on the public queue then wait there for the next update and are harmless (a Circle re-evaluation, a check of a confirmed signup).

`git pull --ff-only` fails if your clone has commits of its own. Pull or rebase yourself, then run `pnpm swarm update` again.

**Existing Amazon SES installs must re-run the installer once with the AWS admin key.** The workers' IAM policy now also allows `ses:PutSuppressedDestination`, `ses:DeleteSuppressedDestination` and `ses:ListSuppressedDestinations`, and only the admin key can change it, so `update` warns and leaves the policy alone. Run `pnpm swarm`, which asks for the key, or pass `mail.awsAccessKeyId` and `mail.awsSecretAccessKey` with `--answers`. Until then, mail still sends and Swarm's own suppressions still apply, but the SES list stays out of step.

**Existing Amazon SES installs: set the suppression list to bounces only.** Installs made before the installer did this still have SES adding addresses for complaints, account-wide. Run `pnpm swarm` once with the AWS admin key (it does it and says `done`), or run `aws sesv2 put-account-suppression-attributes --suppressed-reasons BOUNCE` yourself. Without the admin key, `pnpm swarm` and `pnpm swarm update` warn, and `pnpm swarm doctor` reports it under _SES suppression list_ with the fix. Complaint entries already on the list stay until removed (docs/deliverability.md "Suppressions" shows how). The workers' IAM policy does not change for this.

Changes SES refused before the policy was updated stay `failed`. To try them again, run this from `workers/api` (use your own environment):

```bash
pnpm exec wrangler d1 execute DB --remote --config wrangler.production.generated.jsonc --env production \
  --command "UPDATE provider_suppression_sync SET status = 'pending', attempts = 0, next_attempt_at = 0 WHERE status = 'failed'"
```

#### Per-link keys

Links in mail and on pages (subscriber settings, confirmations, asks, data downloads, goods, checkout and sponsor report links) used to be signed with one keyring, `MEMBER_KEYS`, which every public worker held. Each kind of link now has its own keyring, and a worker holds only those it needs; where one worker signs a link and another only checks it, the link is signed with Ed25519 and the checking worker gets only the public key (`<NAME>_VERIFY_KEYS`, made from the private one at each deploy). `update` moves an install over in two passes:

1. It creates the new keyrings (keeping every existing one) and deploys every worker with them. Every worker then accepts the new links; links are still signed with `MEMBER_KEYS`. An install stays here only with `--link-keys=verify-only`, or while an address does not answer its health check (`doctor` says which).
2. In the same `update`, once that is so and every address answers its health check, it records the moment (`linkKeys.cutoffAt` in `.swarm/<env>.json`) and deploys the signing workers again (`swarm-vault`, `swarm-events`, `swarm-site`, `swarm-capture`, `swarm-send`, `swarm-jobs`, `swarm-api`) to sign the new links from then on.

Links sent before that moment keep working for their own lifetime, at most 90 days: Member Center links and checkout references 30 days, asks, goods links and form stamps 90. A sponsor report link was good for a year; one made before the switch works for 90 days after it, and new ones last 90 days. So that no sponsor is left with a link that stops early, the jobs worker emails the sponsor contact of every accepted booking that still runs, or ran within the 90 days before the switch, a new link, once, in the hours after it (from the publication's sender, like other subscriber mail). Admins can send a sponsor a new link from the booking at any time (Partners, Bookings, "Send a new report link"). A link made with `MEMBER_KEYS` after the moment is refused. Each worker keeps `MEMBER_KEYS` only until the last old link it checks has expired (the api 30 days, capture and site 90; send and jobs, which only signed, lose it at once). Each later `update` removes it from the workers whose time is up (wrangler never removes a secret by itself), and when no worker holds it any more, from `.swarm/` too. To give every worker the new keys but stay on the old links, run `pnpm swarm update --link-keys=verify-only`; a later `update` finishes. A new install starts on the new links and never has `MEMBER_KEYS`. The browser setup decides this from the release it installs (the `linkSigning` field of its signed manifest; a release without it signs the old way), never from its own build.

What changes once at the switch: the `swarm_member` reference a form passes to your own thank-you page is a new value for every subscriber (it is keyed with `CAPTURE_KEYS` now), a returning address may see a different signup journey variant, and a checkout's signed reference moves from `client_reference_id` to the session's metadata (`swarm_ref`; `client_reference_id` then holds the plain reference you see in Stripe). Links are longer: a Member Center link gains about 90 characters. Local development (`wrangler.jsonc`) signs the new links from the start (`LINK_SIGNING_MODE=v2`, `LINK_LEGACY_CUTOFF=0`), so `MEMBER_KEYS` in `.dev.vars` is not used there. After the `update` that created the new keyrings, back up `.swarm/` again and save a new recovery kit if you keep one: an older copy does not have them.

#### The vault

Installs made before it get one new worker, `swarm-vault`, on their next update. It has no address: `swarm-api`, `swarm-capture`, `swarm-site` and `swarm-jobs` reach it through a binding each. The update deploys it right after `swarm-realtime`, with `FIELD_KEYS` (the same value: nothing is re-encrypted) and the keys for the links it signs on the others' behalf, before the four workers that bind to it. It starts by writing values the way they are stored now, so going back to the previous release is still safe; docs/deployment.md "The vault" says when to switch it to values bound to their row, which older code can't read. The other workers make every call that needs `FIELD_KEYS` through the vault; once every worker answers its health check, the same `update` removes `FIELD_KEYS` from them (and the signup, member and goods signing keys from capture, site and the api, the Stripe key from capture and site, the DeBounce key from capture). If one doesn't answer, nothing is removed and the update says so; run it again once it does. When the install has run on the vault for a week, `pnpm swarm vault --write-format v3` (and later `--legacy-open off`) finish the move; `pnpm swarm doctor` says when.

### Turn things on later: `pnpm swarm enable`

- **`enable custom-domains`** lets publications use their own domains, for websites and for tracked links. Turn on Cloudflare for SaaS for the zone first (_SSL/TLS > Custom Hostnames_). The installer asks for a token with _Zone > SSL and Certificates > Edit_ (the workers keep it as `CF_API_TOKEN`) and for the DNS token again. It adds `sites.<your domain>` as the fallback origin, routes every hostname on the zone to the website worker, and redeploys the site, send, jobs and api workers.
- **Without this command:** turn on **Stripe with a restricted key** in Settings → Instance, and each publication's owner adds a restricted Stripe key under Settings → Payments ([details](deployment.md#payments-with-a-publications-own-key)).
- **`enable payments`** turns on paid subscriptions through Stripe Connect. It asks for the platform account's full secret key (`sk_live_…` or `sk_test_…`; a restricted key is not enough) and the Connect client id (`ca_…`), creates the Connect webhook at `https://app.<your domain>/api/v1/stripe/webhook`, and redeploys. One step is left for you in Stripe: add `https://app.<your domain>/api/v1/payments/connect/callback` as a redirect URI under _Connect > Settings > OAuth_.
- **`enable google`** turns on Google sign-in. Create an OAuth client (type _Web application_) in Google Cloud Console with the redirect URI `https://app.<your domain>/api/v1/auth/google/callback`, then paste the client id and secret.
- **`enable debounce`** turns on [email checks](email-verification.md): subscriber addresses checked with DeBounce at signup, on import and across the list. Create a DeBounce account at [tegze.link/debounce](https://tegze.link/debounce), copy the API key from DeBounce's API settings and paste it. The installer checks it with DeBounce (not in a dry run), keeps it in `.swarm/<env>.secrets.json` and redeploys the capture, jobs and api workers with it as `DEBOUNCE_API_KEY`. The credits are yours: only workspaces an instance admin owns use them, until you allow others on the DeBounce card under Apps. `pnpm swarm doctor` reports whether the key is set and how many credits are left. In an answers file the key is `debounceApiKey`, or set `DEBOUNCE_API_KEY` in the environment.

### Rotate keys: `pnpm swarm rotate-keys`

Each keyring is a list `kid:secret,kid:secret,…`: the first key signs or encrypts, the others only verify or decrypt. Rotate one when you suspect it was exposed (a lost laptop, a leaked backup, someone who held `.swarm/` leaving), or on a schedule:

```bash
pnpm swarm rotate-keys TRACK_KEYS            # add a new signing key
pnpm swarm rotate-keys TRACK_KEYS --retire   # later: remove the old one
```

`rotate-keys <KEYRING>`:

1. makes a new key (`k<yyyymmdd>`, with a letter after it for a second one on the same day) and saves the ring as `new,old` in `.swarm/` before any worker has it, so a key a worker signs or encrypts with is never lost;
2. writes a new recovery kit, `swarm-recovery-kit-<env>-<date>.json` where you ran the command (or `--kit <file>`), sealed under a passphrase you choose (or `SWARM_KIT_PASSPHRASE`). It does this before any worker gets the key and stops if it can't. **Keep the new kit in place of the old one**: an older kit doesn't have the new key, and restoring it and running `update` would put the old ring back;
3. gives the ring to every worker that holds it, first with the new key last (verify only) and then first (signing), so no worker meets something signed with a key it doesn't have yet. For an Ed25519 keyring, the workers that only check its links get the new public key first, and never the private one. If this is interrupted, run the same command again: it finishes the same rotation instead of making another key;
4. says when the old key may be removed. Until then, everything signed with it keeps working.

When the old key may go, after the longest lifetime of what the ring signs, counted from the rotation:

| Keyring                       | Signs, or holds                                                                                                                                   | Held by (signs; checks)               | `--retire` from                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------- |
| `AUTH_KEYS`                   | export download links and audit-chain cursors (sign-in state lasts 30 minutes)                                                                    | api                                   | 1 day                                                                |
| `TRACK_KEYS`                  | open and click links in mail already sent                                                                                                         | send; track                           | 400 days                                                             |
| `UNSUBSCRIBE_KEYS`            | unsubscribe links in mail already sent, which never expire                                                                                        | send, api; track, events              | never by default: `--retire --yes` removes it and breaks those links |
| `BOUNCE_KEYS`                 | the bounce address of each message (events takes reports for 7 days; codes signed with `UNSUBSCRIBE_KEYS` before the switch for 14 days after it) | send; events                          | 7 days                                                               |
| `READER_KEYS`                 | reader sessions on publication websites (90 days at most)                                                                                         | site                                  | 90 days                                                              |
| `CONFIRM_KEYS`                | confirm and leave links in confirmation mail                                                                                                      | api, capture, site; capture           | 30 days                                                              |
| `CAPTURE_KEYS`                | the bot check, erasure confirmations, the `swarm_member` reference                                                                                | capture                               | 1 day                                                                |
| `FORM_STAMP_KEYS`             | the stamp a rendered form carries (which version was shown)                                                                                       | capture, site; capture                | 90 days                                                              |
| `SIGNUP_KEYS`                 | join and signup journey links                                                                                                                     | vault; vault (for capture and site)   | 1 day                                                                |
| `MEMBER_SIGNING_KEYS`         | Member Center links (Ed25519)                                                                                                                     | vault, send, jobs; vault, capture     | 30 days                                                              |
| `ASK_SIGNING_KEYS`            | one-tap ask answers in mail (Ed25519)                                                                                                             | send; capture                         | 90 days                                                              |
| `ASK_PAGE_SIGNING_KEYS`       | ask pages (Ed25519)                                                                                                                               | capture; site                         | 7 days                                                               |
| `DSR_EXPORT_SIGNING_KEYS`     | data download links (Ed25519)                                                                                                                     | jobs; capture                         | 7 days                                                               |
| `GOODS_SIGNING_KEYS`          | goods library and order links (Ed25519)                                                                                                           | vault; site                           | 90 days                                                              |
| `CHECKOUT_SIGNING_KEYS`       | checkout references (Ed25519)                                                                                                                     | site; api                             | 30 days                                                              |
| `SITE_LINK_SIGNING_KEYS`      | design previews (Ed25519); sponsor reports signed with it before their own ring still verify for 90 days                                          | api; site                             | 90 days                                                              |
| `SPONSOR_REPORT_SIGNING_KEYS` | sponsor report links (Ed25519)                                                                                                                    | api, jobs; site                       | 90 days                                                              |
| `MEMBER_KEYS`                 | before the switch to per-link keys, all of the links above; after it, nothing (it is not rotated)                                                 | api, send, jobs, capture, site, vault | 365 days                                                             |
| `FIELD_KEYS`                  | every stored encrypted value until it is encrypted again (below); join links for a day                                                            | vault                                 | when none is left, and 1 day                                         |

`--retire` before that date stops and says when; `--retire --yes` removes the key anyway and breaks what it signed. After the switch to per-link keys, `rotate-keys MEMBER_KEYS` refuses: rotate the keyring that signs the link instead. Rotating `CAPTURE_KEYS` (or `MEMBER_KEYS` before the switch) also changes the `swarm_member` reference a form passes to your own thank-you page, and a returning address may see a different signup journey variant.

**`FIELD_KEYS`** encrypts stored values: subscribers' encrypted profile fields, Privacy Center addresses, operators' two-factor secrets, single sign-on client secrets, and the webhook, export, Copilot, application, Stripe and PayPal secrets. After a rotation the vault worker encrypts each of them again with the new key, every five minutes, a few hundred rows of each table at a time, and records how far it got in the `field_key_reseal` table, so a failed run loses nothing and the next one continues. A value is replaced only if it hasn't changed since it was read. `pnpm swarm rotate-keys FIELD_KEYS --retire` then counts, in the database, the values still encrypted with an older key, and refuses while there are any; if the vault had finished and some were written since, it starts it over. Once a pass has finished, `--yes` removes the key even with values left, which then can never be read: use it only when what is left is what the vault counted as opened by no key (`unreadable` in `field_key_reseal`). After that, a copy of the old key opens nothing in the database, though a database backup or a D1 Time Travel restore from before the pass still holds values it opens.

The vault worker (`swarm-vault`) is the only one that holds `FIELD_KEYS`, so this runs from its cron alone. Once it writes row-bound values (`VAULT_WRITE_FORMAT=v3`, see docs/deployment.md "The vault"), its cron also moves every older value to that format, and `--retire` counts those under their key too.

Each `--retire` gives the shortened ring to every worker that holds it, saves it, and writes another recovery kit. Back up `.swarm/` again after each step.

### Answer from a file

For a scripted install, put the answers in a JSON file and pass `--answers answers.json`. Every key is optional; a missing answer the run needs stops it with the name of the key. Keys can also come from the environment: `SWARM_DNS_TOKEN`, `RESEND_API_KEY`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, so they need not sit in the file.

```json
{
  "zone": "example.com",
  "owner": { "name": "Ada Example", "email": "ada@example.com" },
  "publication": { "name": "The Example Letter", "slug": "letter" },
  "mail": { "provider": "resend", "region": "us-east-1" },
  "excludeHosts": []
}
```

Other keys: `account` (when the sign-in sees several Cloudflare accounts), `dnsToken`, `storeDnsToken`, `mail.resendApiKey`, `mail.awsAccessKeyId`, `mail.awsSecretAccessKey`, `mail.requestProductionAccess`, and, for `enable`, `cfApiToken`, `stripe` (`secretKey`, `connectClientId`) and `google` (`clientId`, `clientSecret`). The file `packages/installer/tests/fixtures/answers.json` is a complete example, used for the dry run in CI.

## Back up .swarm/

`.swarm/` holds everything the installer knows about your install, and the keys your workers use. It is not in git, so back it up somewhere safe and private (a password manager or an encrypted disk), and again after each `enable` and `rotate-keys`.

**If you lose `FIELD_KEYS`, encrypted subscriber fields can never be read again.** There is no way to recover them. On Cloudflare it is held by `swarm-vault`, which has no public address; the copy in `.swarm/` and the recovery kit is the only other one. Losing the other keys is also disruptive: a re-run would create new ones, so unsubscribe and tracking links in emails already sent stop working, and everyone is signed out.

`.swarm/production.secrets.json` contains every keyring in the table above (the Ed25519 ones as private keys; their public keys are made from them at each deploy), the Turnstile secret, the workers' mail credentials (the Resend key and webhook secret, or the SES IAM user's key), and the Stripe, Google, SSL and DNS tokens you gave it.

**The secrets file is encrypted under a passphrase.** The first time the installer saves it, it asks you to choose one (at least 12 characters, typed twice), and every later command that reads the file (`doctor`, `update`, `enable`, `mail`, `signin-link`, `rotate-keys`, dry runs) asks for it once. Without a terminal, or to avoid typing it, set `SWARM_SECRETS_PASSPHRASE` for that command; the installer reads it and removes it from what it passes to wrangler and git. The file uses the same scheme as the recovery kit (PBKDF2-SHA256, here with 600,000 iterations, and AES-256-GCM), bound to its environment, so a copy of the folder or a backup gives nobody the keys without the passphrase. **If you lose the passphrase, nobody can open the file**: keep it apart from the backup, for example in a password manager. A plain secrets file written by an older installer is still read, and is encrypted the next time the installer saves it.

The secrets file is also written with mode 0600 on macOS and Linux. On Windows, where modes don't limit readers, the installer removes the access the file inherited and grants it to your user alone (`icacls <file> /inheritance:r /grant:r <you>:F`), and warns if that fails. The rest of `.swarm/` (ids and answers) is not secret, but keep the folder private anyway.

While a deploy runs, the secrets a worker needs are written to a temporary file for `wrangler deploy --secrets-file` (mode 0600) and removed straight after.

To run the commands from another computer, clone the repository there and copy `.swarm/` into it; you need the passphrase there too.

## Staging

```bash
pnpm swarm --env staging
```

Staging is a second, separate install on the same domain: its own resources (`swarm-staging`, `swarm-staging-cache`, …), workers (`swarm-api-staging`, …), keys and `.swarm/staging*.json` files. Its addresses put `staging-` in front, so they stay one level under the domain's certificate: `staging-app.example.com`, `staging-forms.example.com`, `staging-mail.example.com`, and so on.

Staging has no publication websites, because the `*.example.com` wildcard belongs to production, and no custom domains on that zone. If staging needs them, install it on a separate domain. Every command takes `--env staging`.

## Troubleshooting

Installing through the browser setup page? See the [setup guide](setup-guide.md), which also covers the recovery kit.

Every error the installer prints ends with what to do about it. Run the same command again after fixing the cause; finished steps are skipped. The common ones:

| Message                                                             | What to do                                                                                                                                                                   |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Swarm needs Node.js 22 or newer                                     | Install Node.js 22 LTS from nodejs.org.                                                                                                                                      |
| The dependencies are not installed                                  | Run `pnpm install` in the repository, then `pnpm swarm`.                                                                                                                     |
| wrangler is not signed in to Cloudflare                             | Happens in non-interactive runs. Run `pnpm --filter @swarm/installer exec wrangler login` once.                                                                              |
| This sign-in can see several Cloudflare accounts                    | Add `"account": "<id or name>"` to the answers file.                                                                                                                         |
| This Cloudflare account has no domains                              | Add your domain to Cloudflare first (_Websites > Add a domain_).                                                                                                             |
| `example.com` is "pending" on Cloudflare                            | Point the domain's nameservers to Cloudflare at your registrar, and wait until Cloudflare shows it as active.                                                                |
| Cloudflare did not accept the DNS token, or the token is not active | Create a new token with the link the installer prints, and paste the whole token.                                                                                            |
| `<name>` already has a `<type>` record                              | A record of your own is in the way. Remove or rename it in the Cloudflare dashboard (_DNS > Records_).                                                                       |
| Resend did not accept the API key                                   | Create a key with _Full access_ at resend.com/api-keys. A sending-only key is not enough.                                                                                    |
| AWS refused `<service>:<operation>`                                 | Use an AWS key that can manage SES, SNS and IAM, for example an administrator key.                                                                                           |
| The IAM user `swarm-production-workers` already has two access keys | Delete one of its keys in the AWS console (_IAM > Users_). AWS allows two per user.                                                                                          |
| Cloudflare did not return the secret of the Turnstile widget        | Delete the widget `swarm-production` in the Cloudflare dashboard (_Turnstile_).                                                                                              |
| The dashboard build failed                                          | Run `pnpm --filter @swarm/dashboard build` to see the full error.                                                                                                            |
| `wrangler … failed`                                                 | Read wrangler's message above it; it usually names a missing permission or a plan limit.                                                                                     |
| Not answering yet: `app.example.com` …                              | New certificates can take a few minutes. Run `pnpm swarm doctor` a little later. If it still fails, check the proxied `AAAA 100::` record for that address.                  |
| Resend did not return the webhook signing secret                    | Delete the webhook to `https://events.<your domain>/resend` in the Resend dashboard (_Webhooks_), then run `pnpm swarm` again so it is created afresh.                       |
| SES events are not connected yet                                    | The events worker was not answering yet. Run `pnpm swarm` again in a few minutes, with the AWS key.                                                                          |
| Email Routing for `unsubscribe.…` could not be set up               | Unsubscribe links still work. To finish by hand: _Email > Email Routing > Settings_, add the subdomain, then a rule for its address that sends to the Worker `swarm-events`. |
| This version of Swarm has no invite-only setting yet                | Your clone predates migration `0019`. Run `pnpm swarm update`.                                                                                                               |
| There is no production install recorded in .swarm/                  | Run `pnpm swarm` to install, or restore `.swarm/` from your backup. Check `--env`.                                                                                           |
| This run is non-interactive, but it needs an answer                 | Add the answer to the `--answers` file, or run without `--answers` to be asked.                                                                                              |
| `.swarm/….json` could not be read                                   | Restore the file from your backup of `.swarm/`.                                                                                                                              |

Other things that can go wrong:

- **The sign-in link says it has expired or was used.** Run `pnpm swarm signin-link` for a new one.
- **Sign-in mail does not arrive with SES.** In the sandbox, SES delivers only to verified addresses. Click the link in the email from AWS that verifies your address, or wait for production access.
- **Replies to the unsubscribe address do nothing.** Emails offer `unsub+<code>@unsubscribe.<your domain>` as a second way to unsubscribe, and the installer's routing rule is for `unsub@`. Check that _Subaddressing_ is turned on under _Email > Email Routing > Settings_, so plus addresses reach that rule. The same applies to `dmarc+<id>@dmarc.<your domain>` for DMARC reports.
- **An existing subdomain started showing a Swarm 404 page.** It is proxied and the `*.<your domain>/*` route caught it. Run `pnpm swarm` again and keep it when asked; the installer adds an exclusion route.

## Removing Swarm

There is no uninstall command. To remove an install, delete these by hand (names for `production`; staging has `staging` in them, and its workers end in `-staging`):

**Cloudflare**

- Workers: `swarm-api`, `swarm-send`, `swarm-jobs`, `swarm-capture`, `swarm-site`, `swarm-events`, `swarm-track`, `swarm-vault`, `swarm-realtime` (delete `swarm-vault` after the four workers bound to it, and `swarm-realtime` last; the others use its Durable Objects). Then check _Workers Routes_ on the zone for leftover routes, including the exclusion routes the installer added.
- D1 database `swarm-production` (this deletes all your data; export what you need first).
- KV namespace `swarm-production-cache`.
- R2 buckets `swarm-production-media`, `-imports`, `-exports` and `-reports`. A bucket must be empty before it can be deleted.
- Queues `swarm-production-send`, `-send-dlq`, `-jobs`, `-jobs-dlq`, `-webhooks`, `-webhooks-dlq`, `-public`, `-public-dlq`.
- Turnstile widget `swarm-production`.
- Email Routing rules `swarm-production-unsubscribe` and `swarm-production-dmarc`, and the subdomains `unsubscribe.` and `dmarc.` under _Email Routing > Settings_.
- DNS records: the proxied `AAAA 100::` records for `app`, `forms`, `link`, `media`, `events`, `*` (and `sites` if custom domains were on); `_dmarc.mail`, `*._report._dmarc.dmarc`; the DKIM records under `_domainkey.mail`; and the `bounce.mail` MX and TXT records.
- With custom domains on: the publications' custom hostnames and the fallback origin under _SSL/TLS > Custom Hostnames_.
- The API tokens you created for the install (`swarm-installer`, and the SSL token for custom domains), under _My Profile > API Tokens_.

**Resend**: the domain `mail.<your domain>`, any domains publications added, the webhook to `https://events.<your domain>/resend`, and the API key.

**Amazon SES** (in the region you chose): the configuration sets `swarm-production-broadcasts`, `-transactional` and `-direct`, plus any that dedicated sending created for publications; dedicated IP pools, which AWS bills monthly; the SNS topic `swarm-production-ses-events` and its subscription; the identities `mail.<your domain>`, your own email address and any publication domains; and the IAM user `swarm-production-workers` with its access keys and its policy `swarm-send-mail`.

**Stripe**: the Connect webhook to `https://app.<your domain>/api/v1/stripe/webhook` and the redirect URI. **Google**: the OAuth client.

**Your computer**: `.swarm/` and `workers/*/wrangler.*.generated.jsonc`. Keep a copy of `.swarm/` until you are sure you no longer need the data it unlocks.
