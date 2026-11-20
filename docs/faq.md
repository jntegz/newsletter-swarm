# FAQ and troubleshooting

Common questions about running a newsletter on Swarm, and what to do when something goes wrong. The answers use the names you see in the dashboard.

**Start here when email is the problem:** open **Sending & delivery**, then **Deliverability**, and run the check-up. It looks at your domain, your sender and your recent sends, and lists what to fix first. The [Deliverability guide](deliverability-guide.md) explains every finding.

Contents:

- [Installing](#installing)
- [Signing in](#signing-in)
- [Domains](#domains)
- [Sending](#sending)
- [Subscribers and imports](#subscribers-and-imports)
- [Features that seem to be missing](#features-that-seem-to-be-missing)
- [Costs](#costs)
- [Updating and backing up](#updating-and-backing-up)
- [Moving from another newsletter platform](#moving-from-another-newsletter-platform)
- [Your data](#your-data)

## Installing

The installer's own messages, each with what to do, are listed in [Self-hosting: Troubleshooting](self-hosting.md#troubleshooting). The questions people ask most:

### Should I use the terminal or the browser setup page?

Use the terminal (`pnpm swarm`). The browser setup page installs only a signed release, and Swarm has not had one yet, so it has nothing to install until the first release is published.

### The installer stopped halfway

Fix what its last message names and run `pnpm swarm` again. Finished steps are skipped, nothing is created twice and keys are never replaced. To see what it would do without changing anything, run `pnpm swarm --dry-run`.

### Which Cloudflare plan do I need?

Workers Paid ($5 a month minimum). The Free plan includes Queues and Durable Objects, but Swarm runs six scheduled jobs (Free allows five), and one send to a large list goes past Free's daily queue and request limits.

### My domain is "pending" on Cloudflare

Cloudflare shows a domain as active only once its nameservers point to Cloudflare. Change them at your registrar, wait until the domain shows _Active_, then run `pnpm swarm` again.

### `pnpm swarm doctor` says a worker answers 503, or "the jobs worker (vault heartbeat)" fails

The workers that read encrypted data (`swarm-api`, `swarm-capture`, `swarm-site` and `swarm-jobs`) answer 503 on purpose while they cannot reach `swarm-vault`. Run `pnpm swarm update`, which deploys `swarm-vault` before them, then `pnpm swarm doctor` again. A new deploy can take a minute or two before every check passes. The jobs check waits for its next minute cron.

### The dashboard says "Encrypted data is temporarily unavailable"

The same cause, seen from the dashboard: the vault did not answer within 5 seconds. Nothing was saved. Run `pnpm swarm doctor`; if `swarm-vault` is missing or failing, `pnpm swarm update` deploys it again. If it keeps happening, look at the `swarm-vault` logs in the Cloudflare dashboard (_Workers & Pages > swarm-vault > Logs_).

### What must I keep after installing?

The `.swarm/` folder and the recovery kit. They hold your install's keys. Without `FIELD_KEYS` encrypted subscriber fields can never be read again; see [Back up .swarm/](self-hosting.md#back-up-swarm).

### I develop locally and a worker does not start after pulling

Each worker's `.dev.vars` is written once by `pnpm setup:dev`. When a new version needs new keys, delete `workers/*/.dev.vars` and run `pnpm setup:dev` again.

## Signing in

### The sign-in email does not arrive

Work through these in order.

1. **Check spam**, and search your mailbox for "Your Swarm sign-in link".
2. **Check the address.** A fresh install is invite-only. An address that has no account and no invite gets a short note instead of a sign-in link. The sign-in page says "Check your inbox" either way, so it does not reveal who has an account.
3. **Ask for a new link, once.** A link works once and expires in 10 minutes. On the "Check your inbox" page, use **Send a new link**. Asking many times in a row is limited, so wait a minute between tries.
4. **If you run the install,** make a one-time link on the computer Swarm was installed from:

   ```bash
   pnpm swarm signin-link
   ```

   It works once, for 60 minutes, and does not need email at all.

5. **Check the email service.** If the sign-in page says the email could not be sent, your email service refused it: the mail domain may have lost its verification, or a plan limit was reached. Its own dashboard shows the reason. **Settings > Instance** shows the **Email service** and whether each of its DNS records is in DNS now, and `pnpm swarm doctor` checks the same from the command line. With Amazon SES in the sandbox, email only reaches addresses you verified with AWS. More in the [setup guide](setup-guide.md).

### The link says it was already used or has expired

Each link works once. Some company mail filters open every link in an email before you do. Swarm's link opens a page with a **Continue** button for that reason, and the button is what signs you in. If it still fails, ask for a new link and open it soon after it arrives.

### I am asked to add a second factor

Owners and admins must have a passkey or an authenticator app. You get 14 days after joining; after that, signing in asks you to set one up first. Do it under **Settings > Security**, and keep the recovery codes somewhere safe.

### A teammate cannot get in

Invite them under **Settings > Team**. An invite expires after 7 days; **Withdraw** it and send a new one if it ran out. They must sign in with the address you invited.

## Domains

All the steps and records are in [Domains](domains.md).

### My sending domain does not verify

The domain stays on **Waiting for DNS**. The usual causes:

- **It has not been long enough.** DNS changes usually show up within minutes and can take up to an hour, now and then longer. Press **Check now** after a while.
- **The name was doubled.** Many DNS companies add your domain to whatever you type in the name box. If Swarm shows the name `bounce.news.yourname.com` and your domain there is `yourname.com`, enter `bounce.news` only. If you paste the full name, you can end up with `bounce.news.yourname.com.yourname.com`.
- **The value was changed on the way.** Paste values exactly. Do not add quotes unless your DNS company asks for them, and check that a long value was not cut off.
- **The record is proxied.** At Cloudflare, DKIM records of the CNAME type must be set to **DNS only** (grey cloud).
- **The record went onto the wrong domain.** If you added `news.yourname.com` in Swarm, the records belong under `news`, not under the bare domain.
- **Your email service limits domains.** Some plans allow only one or a few sending domains. Check its dashboard.

Once a domain is verified, the table's **In DNS now** column shows **Found** or **Missing** for each record, which tells you exactly which one to look at.

### It says "DMARC missing", or DMARC is the step I am stuck on

- A domain can have only **one** DMARC record, a TXT record at `_dmarc.` followed by your domain. If one exists already, edit it. Two records count as none.
- The record must say `p=quarantine` or `p=reject`. With `p=none` the domain cannot send.
- Home shows the record to add, with a button to check again.

### My website's custom domain is not becoming active

- On an install you run yourself, custom domains must be switched on once with `pnpm swarm enable custom-domains`. See [Domains](domains.md#before-you-start-switch-custom-domains-on).
- The bare domain usually cannot take a CNAME. Use an ALIAS record or forwarding; the **Domains** tab under **Website** has notes for the common DNS companies.
- At Cloudflare, set the record to **DNS only** so the certificate can be issued.

## Sending

### Only some people got my email

The most common reason is **warm-up**. A new sending domain starts with a daily limit: 200 emails on the first day for a domain of your own, 100 for the install's shared domain. The limit grows after each good day. When a post goes to more people than today's limit, the rest go out over the following days, by themselves. Nobody is skipped and nobody gets it twice. **Do not send the post again.**

Open **Sending & delivery** and look at the **Warm-up** section: it shows today's limit, how much is used, and the date a post sent today finishes going out. [Warm-up](warm-up.md) explains the paces and how to change them.

Other reasons a post reaches fewer people than you expected:

- **Pending subscribers are not sent to.** Check the **Pending** count on **Subscribers**. People who have not confirmed, and people imported without the agreement box ticked, receive nothing.
- **The audience was narrower than you thought.** The send report and the post's **Who gets it** show whether it went to everyone or to segments, and what was left out.
- **Warm-up is paused.** After a spike in bounces or spam complaints, sending stops until you resume it. Home shows this under **Needs you**.
- **Your email service's limit was reached.** Resend's free plan allows 100 emails a day and 3,000 a month. The rest of the send waits and goes out when the limit allows: see [My send says it is waiting](#my-send-says-it-is-waiting).
- **Amazon SES is still in the sandbox.** Until AWS grants production access, email reaches only addresses you verified with AWS.

### My send says it is waiting

The send reached one of your email service's limits: so many emails an hour, a day or a month. The owner of your Swarm sets these under **Settings > Instance > Sending limits**, from the plan you pay for. Nothing is lost: everyone not sent yet gets the post once, when the limit allows. **Do not send it again.**

- **"Waiting for your email service's daily limit: 1,240 left, continues at 00:00 UTC"**: it goes on by itself at that time (UTC). A daily limit of 100 means a list of 1,000 takes ten days.
- **"Paused for your email service's monthly limit"**: it goes on by itself on the 1st. To send sooner, the owner raises the plan and the limit, then an admin chooses **Resume sending** on the send report.
- **"Paused: your email service stopped accepting mail"**: the email service refused Swarm, for example a suspended account, a deleted or wrong API key, or a sending domain it no longer accepts. The send report quotes what it said. Fix that at the email service, then choose **Resume sending**. Swarm also tries again by itself, less often as time goes on, and sends the rest as soon as the service takes mail. If the service still refuses mail 7 days after it stopped, the send ends as **Failed** (or **Partially failed**), the subscribers still waiting are not sent it, and a post nobody got goes back to your drafts.

Sign-in links and signup confirmations keep going out meanwhile. If sends wait every day, your plan is too small for your list: a paid plan, or Amazon SES, lifts the limit. See [Sending limits](self-hosting.md#sending-limits).

### My emails land in spam

Run the check-up under **Sending & delivery > Deliverability** and follow the [Deliverability guide](deliverability-guide.md). In short: send from your own verified domain with DMARC at quarantine or reject, only mail people who asked, let warm-up run, and remove readers who never open.

### The send button is greyed out

- "Choose who gets this post first" means you have not opened **Who gets it** and picked an audience.
- Otherwise a check under **Check & send** needs attention. Each one says what is wrong.

### I cannot edit a post

A post that is sent or being sent can no longer be edited. To reuse it, open **Posts**, press **New post** and choose **Duplicate**, or open the post and press **Save as template**.

### My scheduled post did not go out

The checks run again at send time. If one fails then, for example because the sender was removed or warm-up is paused, the post goes back to draft and nothing is sent. Open the post, fix what **Check & send** shows, and schedule or send it again.

### The open rate looks wrong

Open rates are estimates everywhere. Readers who block images are not counted. Some mail apps load every email whether or not it is read; Swarm lists those as **privacy proxies** and leaves them out of **Opened by people**. Company filters that follow every link are listed as **scanners** and left out of **Clicked**. Compare your own sends with each other.

### Can readers reply?

Yes. Replies go to the sender's address, or to its **Reply-to** address if you set one under **Sending & delivery > Senders**. Swarm does not give you an inbox, so that address must be a real mailbox someone reads.

### I sent a test and the links do not count

Links in test emails are not tracked, and the unsubscribe link in a test does nothing. Only real sends are counted.

## Subscribers and imports

### My import skipped rows

The review step, before anything is written, shows how many rows were skipped in each group, with examples:

| Group                | Why it was skipped                                          | What you can do                                                                                                     |
| -------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Invalid              | Not a usable email address                                  | Fix the address in the file and import again                                                                        |
| Duplicates           | The same address appears earlier in the file                | Nothing. The first one counted                                                                                      |
| Role addresses       | `info@`, `support@` and the like reach a team, not a person | Ask the person for their own address                                                                                |
| Disposable addresses | Throwaway mailboxes                                         | Nothing                                                                                                             |
| Suppressed           | Bounced, complained or was blocked before                   | Nothing, unless you know the mailbox works now. See [Audience](audience.md#unsubscribed-is-not-the-same-as-blocked) |

Importing the same file twice is safe: people already on the list are counted as **Unchanged**, or **Updated** if you ticked **Update subscribers who are already on the list**.

### Imported people are "Pending" and got nothing

You imported without ticking **Everyone on this list agreed to receive this publication**. Pending subscribers receive nothing until they confirm, and an import does not send them a confirmation email.

Importing the file again does not change them: updating people who are already on the list changes names, fields and tags, never the status. If they did agree, do this instead:

1. On **Subscribers**, press **Pending** above the table.
2. Tick the people from that import. The **Tag** filter with the import's own tag narrows the list to them.
3. Choose **Delete** and confirm.
4. Import the file again, this time with the box ticked. The review step says "New subscribers will be active".

### The wrong column went to the wrong place

The dry run writes nothing. Press **Change the mapping** on the review step and map the columns again.

### A segment says "Pending" or "updating"

Its count is being worked out again after subscriber data changed. It normally takes less than a minute. If a segment stays that way, it is picked up again by itself within about a quarter of an hour.

### Why did a subscriber stop getting my emails?

Find them on **Subscribers** and open them. Their **Status** says why:

- **Bounced**: emails to them could not be delivered, and your bounce rules stopped mailing the address. The **Bounces** part of their page says what happened ("The mailbox is full", "The address doesn't exist") and shows what the receiving server said. The rules are under **Sending & delivery > Bounces**: by default Swarm stops at the first hard bounce (the address or its domain does not exist) or after 3 emails in a row bounced softly (a full or switched-off mailbox). If they fixed their address, open **Sending & delivery > Blocked addresses**, remove it and confirm **Mail again**: they get back the status they had. See [Bounces](deliverability-guide.md#bounces).
- **Complained**: they pressed "report spam" in their mail app. Swarm never mails them again.
- **Unsubscribed** or **Paused**: they did it themselves, or a teammate did.
- **Active**, yet nothing arrives: look at **Bounces** on their page. If their emails were **Blocked**, the receiving server refused them because of the sender, not because of them; Swarm keeps mailing them, and the deliverability check-up says which mailbox provider is refusing you and what to do. If nothing bounced, their mail app may be putting you in spam: ask them to look there and mark you as "not spam".

A subscriber on a paid plan is not stopped without you: with **Ask me before stopping a subscriber on a paid plan** on (the default), they appear under **Needs your attention** in **Sending & delivery**, and the workspace's owners and admins get an email.

### Someone says they unsubscribed but still gets email

Find them on **Subscribers** and look at their **Status** and **Activity**. Check whether they are subscribed with a second address that forwards to the first. Unsubscribing takes effect at once, but a post that was already going out to them may still arrive.

### How do I stop emailing an address for good?

Open **Sending & delivery**, find **Blocked addresses**, enter it under **Block an address** and press **Block**.

## Features that seem to be missing

Several parts of Swarm are optional features: split tests, sending at each reader's best time, sending again to people who did not open, the post archive, the content calendar, rosters, website templates, the newspaper home page layout and more. If a guide mentions something you cannot find:

1. Ask the person who runs your install, or, if that is you, open **Settings > Instance > Features**. Only instance admins see the **Instance** tab; the installer makes the owner one.
2. Switch the feature on.
3. Wait a moment. A change can take up to a minute to reach everyone, and up to six minutes on website pages that were already stored.

The same can be done from the command line with `pnpm swarm feature list` and `pnpm swarm feature <key> on`. See [Self-hosting](self-hosting.md#features).

Paid subscriptions, custom domains and Google sign-in need one more step from whoever runs the install: `pnpm swarm enable payments`, `enable custom-domains` or `enable google`.

## Costs

Swarm itself is free and open source, and takes no share of what your readers pay you. You pay the services it runs on, directly.

- **Cloudflare.** Swarm needs the Workers Paid plan ($5 a month minimum). Usage beyond what the plan includes is billed by Cloudflare, and so is Cloudflare Images (resized copies of your site's images) beyond its free 5,000 transformations a month. See Cloudflare's pricing page for current prices.
- **A domain name**, on Cloudflare.
- **An email service.** This is usually the main cost as your list grows.
  - **Resend:** a free plan of 100 emails a day and 3,000 a month, then paid plans by monthly volume.
  - **Amazon SES:** you pay per email. The send report's **Sending cost** estimates it at $0.10 per 1,000 emails.
  - Mailgun, Postmark and your own mail server are available as previews and have not been run against real accounts yet.
- **Stripe**, if you sell paid subscriptions, charges its own fees on each payment.
- **Copilot**, the writing assistant, is off at install because it uses a paid AI service. See [Copilot](copilot.md).

Prices change. Check each service before you rely on a number here.

## Updating and backing up

### How do I update Swarm?

On the computer Swarm was installed from, in its folder:

```bash
pnpm swarm update
```

It fetches the latest version, applies database changes, and deploys everything, without questions. Your settings and feature choices are kept. Read `CHANGELOG.md` first for anything that needs a manual step. Details: [Self-hosting](self-hosting.md#update-pnpm-swarm-update).

Afterwards, `pnpm swarm doctor` checks that everything is healthy.

### What do I need to back up?

1. **The `.swarm/` folder.** This is the important one. It is on the computer you installed from, it is not in git, and it holds the keys of your install. Without it you cannot run updates, and **if the key called `FIELD_KEYS` is lost, encrypted subscriber fields can never be read again**. Keep a copy somewhere safe and private, such as a password manager, and copy it again after each `pnpm swarm enable`. See [Self-hosting](self-hosting.md#back-up-swarm).
2. **Your subscribers.** Export them now and then: **Subscribers > Export**. An export destination can copy subscriber data to storage of your own on a schedule; find it under **Subscribers > Fields and tags > Export destinations**.
3. **The database.** Everything lives in a Cloudflare D1 database in your own Cloudflare account, named `swarm-production`. Cloudflare can restore a D1 database to an earlier point in time; see Cloudflare's documentation for D1. Swarm does not add a backup command of its own.

Images and files are in R2 buckets in the same Cloudflare account.

## Moving from another newsletter platform

A plan that works:

1. **Install Swarm** and walk through [Getting started](getting-started.md) with a small test list first.
2. **Set up your sending domain** and a sender on it. If you already send from that domain with your old platform, mailbox providers know it. Read "Skipping warm-up" in [Warm-up](warm-up.md) before you decide. If the domain is new to sending, let warm-up run.
3. **Export your subscribers** from the old platform. Take active subscribers only. Leave out everyone who unsubscribed, bounced or complained there.
4. **Import them**: **Subscribers > Import subscribers**. Under **Where the file comes from**, pick the option for another newsletter platform's file if a plain CSV does not map well. Tick the agreement box only for people who really opted in. See [Audience](audience.md#importing).
5. **Bring your old posts**, if you want them on your new website. **Import past issues** is an optional feature under **Website**; imported posts go on the website and are never emailed. If your site runs on WordPress, see [WordPress](wordpress.md).
6. **Move signups.** Replace the old signup forms on your site with a Swarm [signup form](audience.md#signup-forms).
7. **Point your web address** at the new website, if you used a custom domain: [Domains](domains.md#a-custom-domain-for-the-website).
8. **Tell your readers** in your first post from the new home, and ask them to reply or to add your address to their contacts. Replies help delivery.
9. **Send to your most engaged readers first** for the first week or two. Old, quiet addresses bounce, and bounces pause sending.

Paid subscribers are a separate matter: moving payments between platforms depends on your payment provider, and this guide does not cover it.

## Your data

### Who has my data?

You do. Swarm runs in your own Cloudflare account: the database, the files and the settings are there, and nobody else operates it. The services that touch subscriber data on the way are your email service, which delivers the emails, and Stripe if you sell paid subscriptions. The list is in [Subprocessors](subprocessors.md), and where things are stored is in [Data residency](data-residency.md).

### Can I get everything out?

- **Subscribers:** **Subscribers > Export**, as CSV or JSON Lines, with every profile field.
- **Posts:** they stay on your website, and each publication has a feed at `/feed`.
- **Templates:** each of your templates has **Export HTML** on the **Templates** page.
- **Everything else:** it is your database. The [API](api.md) reads most of it, and the D1 database itself can be exported with Cloudflare's tools.

### A reader asks for their data, or to be deleted

Readers can do both themselves from the settings page linked in every email. You can also file a request for them under **Settings > Privacy Center**, which lists every request with its due date. Deleting a subscriber from **Subscribers** removes the person and erases their address from delivery history.

### How do I remove Swarm completely?

There is no uninstall command. [Self-hosting](self-hosting.md#removing-swarm) lists what to delete by hand. Export what you want to keep first; deleting the database deletes all your data.

## Still stuck?

- `pnpm swarm doctor` checks an install and says how to fix what is wrong.
- [Self-hosting](self-hosting.md#troubleshooting) and the [setup guide](setup-guide.md) cover install problems.
- To report a security problem, see `SECURITY.md` in the repository.
