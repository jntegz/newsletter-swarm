# Domains and addresses

Swarm uses several kinds of web and email address. This page lists every kind, says which ones are set up for you and which you add yourself, and gives the DNS records for each with a way to check that they work.

The short version:

| Address                                 | Example                       | Who sets it up                         | Where                           |
| --------------------------------------- | ----------------------------- | -------------------------------------- | ------------------------------- |
| The install's own subdomains            | `app.example.com`             | The installer, once                    | [Self-hosting](self-hosting.md) |
| A publication's website address         | `harbour.example.com`         | Swarm, when the publication is created | Automatic                       |
| A custom domain for the website         | `www.harbourletters.com`      | You, per publication                   | **Website > Domains**           |
| A sending domain and its From addresses | `ava@news.harbourletters.com` | You, per publication                   | **Sending & delivery**          |
| A branded link domain                   | `go.harbourletters.com`       | You, per publication                   | **Sending & delivery**          |

In the examples, `example.com` is the domain Swarm was installed on, and `harbourletters.com` is a domain the writer owns.

**A word on DNS.** DNS is the address book of the internet. Each domain has a list of records, kept by a DNS company, often the one you bought the domain from. To add a record you sign in there, find the DNS settings of your domain, and add a row with a **type** (such as CNAME or TXT), a **name** and a **value**. Swarm always shows the exact name and value, each with a copy button. Changes usually show up within minutes and can take up to an hour, sometimes a few hours.

## The install's own subdomains

When Swarm is installed on `example.com`, the installer creates these addresses. You do not add anything yourself.

| Address                   | What it is                                                                    |
| ------------------------- | ----------------------------------------------------------------------------- |
| `app.example.com`         | The dashboard, where you sign in                                              |
| `forms.example.com`       | Signup forms, confirm pages and the page readers manage their subscription on |
| `link.example.com`        | Tracked links and open tracking in your emails                                |
| `media.example.com`       | Images and files                                                              |
| `events.example.com`      | Delivery reports from your email service                                      |
| `mail.example.com`        | The shared sending domain. Sign-in emails come from it too                    |
| `unsubscribe.example.com` | Unsubscribe by email                                                          |
| `dmarc.example.com`       | DMARC reports                                                                 |

**How to check they work.** The person who runs the install can run `pnpm swarm doctor`, which checks every address and DNS record and says how to fix what is wrong. In the dashboard, **Settings > Instance** shows the **Email service** with each of its DNS records and whether it is in DNS now. See [Self-hosting](self-hosting.md) for the full list of what the installer creates.

## A publication's website address

Every publication gets a website at its address followed by the install's domain. A publication with the address `harbour` on an install at `example.com` is at `harbour.example.com`.

- You choose the address when you create the publication. It is permanent.
- There is nothing to set up. The website is live as soon as the publication exists.
- A few names are reserved for Swarm itself, such as `app`, `forms`, `link`, `media`, `mail` and `www`.

**How to check it works.** Open **Website** in the left menu. The **Site address** is at the top, and **View site** opens it.

## A custom domain for the website

You can serve a publication's website from a domain you own, such as `www.harbourletters.com`, with the bare domain `harbourletters.com` redirecting to it. The original address keeps working.

### Before you start: switch custom domains on

On an install you run yourself, custom domains have to be switched on once for the whole install, from the computer Swarm was installed from:

```bash
pnpm swarm enable custom-domains
```

It needs Cloudflare for SaaS turned on for the install's domain, and it asks for one more Cloudflare token. The steps are in [Self-hosting](self-hosting.md#turn-things-on-later-pnpm-swarm-enable). Until this has been done, a domain you add cannot become active. This command also switches on [branded link domains](#a-branded-link-domain).

### Add the domain

You need the Admin role or higher.

1. Open **Website**, then the **Domains** tab.
2. Under **Your domain**, type the domain in **Domain**. Use the form with `www`, or another subdomain such as `news.harbourletters.com`.
3. Press **Add domain**.
4. The page lists the domain with a status, and shows a record for it with a **name** and a **target**. If you added a `www` address, it also shows a row for the bare domain, **Root redirect**, which sends `harbourletters.com` to the website.
5. At your DNS company, add each record.
6. Back in Swarm, press **Check now**.

### The DNS records

| For             | Type                       | Name                    | Value                                                                         |
| --------------- | -------------------------- | ----------------------- | ----------------------------------------------------------------------------- |
| The website     | CNAME                      | `www` (your subdomain)  | The target the page shows, `sites.example.com` on an install at `example.com` |
| The bare domain | CNAME, ALIAS or forwarding | `@` (the domain itself) | The same target                                                               |

The bare domain is the awkward one. Most DNS companies do not allow a CNAME on the domain itself. Use an ALIAS or "flattened" record where it is offered, or use the company's forwarding feature to send the bare domain to your `www` address. The **Domains** tab has step-by-step notes for Cloudflare, Namecheap, GoDaddy, Squarespace Domains and Amazon Route 53.

If your domain's DNS is at Cloudflare, set the record's proxy status to **DNS only** (grey cloud), so the certificate can be issued.

### How to check it works

- On the **Domains** tab the status changes from **Not set up** or pending to **Active**. A secure certificate is issued for you; this can take a few minutes after the record is found.
- Open the domain in a browser. Your website should load with a padlock.
- **Website > General** now shows your domain as the **Site address**, with the original address listed as "which always works".

The **Domains** tab also shows, for the same domain, whether it is used for **Email sending** and for **Links**. Those are set up under **Sending & delivery**, described next.

## Sending domains and From addresses

A sending domain is the part after the `@` in the address your emails come from. Without one, your posts go out from the install's shared domain, at your publication's address: `harbour@mail.example.com`. With one, they come from an address of your choosing, such as `ava@news.harbourletters.com`.

Why add one, and what warm-up does to a new domain, is covered in [Getting started](getting-started.md#3-add-a-sender-and-a-sending-domain) and [Warm-up](warm-up.md).

**Which domain to use.** A subdomain used only for the newsletter, such as `news.harbourletters.com`, keeps the newsletter's reputation apart from your everyday email. You cannot use an address at a free mailbox service such as gmail.com: only that service's own servers may send for it.

### Add the domain

1. Open **Sending & delivery**.
2. In the **Domains** section, type the domain in **Domain**, leave **Use** on **Sending (From address)** and press **Add domain**.
3. The domain appears with the label **Waiting for DNS** and a table of records.
4. Add each record at your DNS company.
5. Press **Check now**. Swarm also checks every few minutes by itself.

### The DNS records

The table shows the records your email service needs. The names and values are generated for your domain, so always copy them from the page. They look like this:

| For     | Type         | Name                                   | What it does                                                                           |
| ------- | ------------ | -------------------------------------- | -------------------------------------------------------------------------------------- |
| DKIM    | CNAME or TXT | Ends in `._domainkey.` and your domain | Signs your emails. Amazon SES uses three CNAME records; Resend uses one TXT record     |
| Bounces | MX           | `bounce.` and your domain              | Where mailbox providers report addresses that do not exist                             |
| SPF     | TXT          | `bounce.` and your domain              | Lists which servers may send for the domain                                            |
| DMARC   | TXT          | `_dmarc.` and your domain              | Tells providers what to do with email that fails the checks, and where to send reports |

The DMARC value Swarm suggests starts with `v=DMARC1; p=quarantine` and includes a reporting address at your install, so reports about your domain reach your Deliverability page.

**DMARC must say quarantine or reject.** A sending domain cannot send until its DMARC record has `p=quarantine` or `p=reject`. A domain can only have one DMARC record. If yours already has one that says `p=none`, edit that record; do not add a second.

**If you already have an SPF record** on the domain itself, leave it alone. The SPF record Swarm asks for is on the `bounce.` subdomain and does not collide with it.

### How to check it works

- The label next to the domain changes to **Verified**, and a second label shows the DMARC policy that was found, for example **DMARC quarantine**. **DMARC missing** in red means the DMARC record was not found.
- Once verified, the table gains a column, **In DNS now**, that says **Found** or **Missing** for each record. Keep every record published for as long as you send.
- Home shows the first two setup steps, **Sending domain** and **DMARC set to quarantine**, as done.
- **Sending & delivery > Deliverability** has a check-up that looks at the domain from the outside. See the [Deliverability guide](deliverability-guide.md).

If the domain stays on **Waiting for DNS**, see the [FAQ](faq.md#my-sending-domain-does-not-verify).

### From addresses (senders)

A verified domain is only used once a sender is on it.

1. On **Sending & delivery**, in the **Senders** section, fill in **Sender name**.
2. Choose your domain under **Domain**. A domain that is not verified yet is marked "(not verified)".
3. Fill in **Address before @**.
4. Optional: **Reply-to**, where replies go. It defaults to the sender address.
5. Press **Add sender**.

The sender marked **Default** is used for new posts. Each post can use a different sender, chosen under **Who gets it** in the editor.

**How to check it works.** In the editor, the **Inbox preview** shows the sender name, and **Check & send** has a line that starts with "From" and shows the full address. If Home says your domain is verified but no sender uses it yet, your posts are still going out from the shared address.

Replies go to the sender address or the reply-to address, so make sure that mailbox exists and someone reads it. Swarm sends email; it does not give you an inbox.

## A branded link domain

Links in your emails pass through Swarm on their way to where they point, so that clicks can be counted. By default those links start with the install's link address, `link.example.com`. A branded link domain makes them start with a domain of yours, such as `go.harbourletters.com`. Readers see a name they know, and mailbox providers see links that match the sender.

On an install you run yourself this needs [`pnpm swarm enable custom-domains`](#before-you-start-switch-custom-domains-on) first, the same as website domains.

### Add the domain

1. Open **Sending & delivery**.
2. In the **Domains** section, type the subdomain in **Domain**, for example `go.harbourletters.com`.
3. Set **Use** to **Branded links** and press **Add domain**.
4. Add the record below at your DNS company, then press **Check now**.

Use a subdomain that nothing else uses. Do not use the address of your website.

### The DNS record

| For       | Type  | Name                  | Value                                                                    |
| --------- | ----- | --------------------- | ------------------------------------------------------------------------ |
| Link host | CNAME | `go` (your subdomain) | The value the page shows: the install's link address, `link.example.com` |

### How to check it works

- The domain's label changes from **Waiting for DNS** to **Verified**.
- Send yourself a real post (not a test: links in test emails are not tracked) and hover over a link. It should start with your link domain.
- Click it. You should land on the page the link points to, and the click should appear on the send report.

Do not remove the record later. Links in emails you have already sent keep using it.

## Quick reference: who can do what

- Adding and removing sending domains, link domains, senders and website domains needs the Admin role or higher in the workspace.
- `pnpm swarm enable custom-domains` and `pnpm swarm doctor` are run by whoever installed Swarm, on the computer with the `.swarm/` folder.

## Related

- [Getting started](getting-started.md)
- [Website](website.md)
- [Warm-up](warm-up.md)
- [Deliverability guide](deliverability-guide.md)
- [Self-hosting](self-hosting.md)
- [FAQ and troubleshooting](faq.md)
