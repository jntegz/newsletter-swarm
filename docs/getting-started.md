# Getting started: your first hour

This guide takes you from a fresh install to your first post in subscribers' inboxes. It is for the person who writes the newsletter. You do not need to know how email or DNS works; where you have to add a DNS record, the dashboard shows the exact values to copy.

If Swarm is not installed yet, start with [Self-hosting](self-hosting.md). This guide uses the names you see in the dashboard.

What you will do, in order:

1. [Sign in](#1-sign-in)
2. [Set up your publication](#2-set-up-your-publication)
3. [Add a sender and a sending domain](#3-add-a-sender-and-a-sending-domain)
4. [Add subscribers](#4-add-subscribers)
5. [Create a signup form](#5-create-a-signup-form)
6. [Look at your website](#6-look-at-your-website)
7. [Write and send your first post](#7-write-and-send-your-first-post)
8. [Understand warm-up](#8-what-warm-up-does-to-your-first-sends)
9. [Check the results](#9-check-the-results)

**Home shows you where you are.** Until your first post is sent, the top of Home has four steps: **Sending domain**, **DMARC set to quarantine**, **First subscribers** and **First post**. The step you are on has a button that takes you to the right page. DNS can take a while, so you do not have to wait for it: **First subscribers** always has links to import a list or add a signup form, and you can write your first post at any time. A post can go out from the shared domain before your own domain is verified; you need at least one active subscriber to send to.

## 1. Sign in

Swarm has no passwords. You sign in with a link sent to your email address.

1. The installer prints a one-time sign-in link when it finishes. Open it. It works once, for 60 minutes.
2. After that, go to your dashboard address (`app.` followed by your domain) and enter your email address.
3. Press **Email me a sign-in link**. The page says **Check your inbox**.
4. Open the email and follow the link, then press **Continue**. The link works once and expires in 10 minutes.

A fresh install is invite-only: only you and people you invite can sign in. See [Settings: team and security](#settings-worth-a-look) below.

If the email does not arrive, see the [FAQ](faq.md#the-sign-in-email-does-not-arrive).

## 2. Set up your publication

A publication is one newsletter: its posts, its subscribers and its website. The installer creates your first one. If you see **Create your first publication** on Home instead, press **Create publication** and fill in:

- **Name.** What readers see. You can change it later.
- **Address.** Lowercase letters, numbers and dashes. It becomes the first part of your website address, and it is permanent.
- **Description.** One or two sentences readers see on your site.

Then open the publication's settings. The name of your publication at the top of the left menu opens a list with **Manage publications**; choose your publication there. Worth setting now:

- **Accent colour** and **Logo.** Your website, emails and signup forms share them.
- **Double opt-in.** New subscribers confirm by email before they receive anything. It is on by default, and it is the best protection against fake signups and spam complaints. Leave it on unless you have a reason not to.

Press **Save changes**.

## 3. Add a sender and a sending domain

Open **Sending & delivery** in the left menu. This page decides who your emails come from.

### Why you want your own sending domain

Out of the box, your posts go out from the install's shared address: your publication's address at the install's mail domain, for example `harbour@mail.example.com`. That works, and on your own install the shared domain is yours too. A sending domain of your own, such as `news.yourname.com`, is still worth the ten minutes:

- Readers see your own name in the From address.
- Mailbox providers such as Gmail and Outlook build trust in that domain, and that trust is yours alone.
- It can send far more per day once it is warmed up (see [warm-up](warm-up.md)).

### Add the domain

1. In the **Domains** section, type the domain in **Domain**. A subdomain you use only for the newsletter, such as `news.yourname.com`, is a good choice.
2. Leave **Use** on **Sending (From address)** and press **Add domain**.
3. The domain appears with the label **Waiting for DNS** and a table of records: **DKIM**, **Bounces**, **SPF** and **DMARC**. The exact records depend on your email service.
4. Sign in where your domain's DNS is managed (often the company you bought the domain from). For each row, add a record with the **Type**, **Name** and **Value** shown. Each value has a copy button.
5. Back in Swarm, press **Check now**.

What the records are for, in one line each:

| Record  | What it does                                                                  |
| ------- | ----------------------------------------------------------------------------- |
| DKIM    | Signs your emails so providers can prove they were not changed on the way     |
| Bounces | Tells providers where to report an address that does not exist                |
| SPF     | Lists which servers may send for your domain                                  |
| DMARC   | Tells providers what to do with email that fails the checks, and reports back |

**How long it takes.** Swarm checks every few minutes by itself. DNS changes usually show up within minutes and can take up to an hour, sometimes longer with some DNS companies. When everything is found, the label changes to **Verified**, and the table gains a column, **In DNS now**, that says **Found** or **Missing** for each record. Keep the records published for as long as you send.

**DMARC must be set to quarantine or reject.** A sending domain cannot send until its DMARC record says `p=quarantine` or `p=reject`. If your domain already has a DMARC record that says `p=none`, change it. Home shows this as its own step, with the record to add.

More detail on every kind of address, and on what to do when a domain will not verify: [Domains](domains.md).

### Add a sender

A sender is the name and address readers see in their inbox. **A verified domain does nothing until a sender uses it**, so do not skip this.

1. In the **Senders** section, fill in **Sender name**, for example `Ava at Harbour Letters`.
2. Under **Domain**, choose your verified domain. (**Shared domain** keeps the install's address.)
3. Fill in **Address before @**, for example `ava`. Use an address a person reads. Replies are a good sign to mailbox providers, so avoid `no-reply`.
4. Optional: **Reply-to**, if replies should go somewhere else.
5. Press **Add sender**.

The sender marked **Default** is used for new posts. You can pick another sender for a single post in the editor.

## 4. Add subscribers

Open **Subscribers**. An empty list offers two buttons: **Import subscribers** and **Add subscriber**.

### One at a time

1. Press **Add subscriber**.
2. Enter the **Email**, and a name if you have one.
3. Tick **They asked to receive this publication** only if that is true.
4. Press **Add subscriber**.

With the box ticked, the person is **Active** and gets your next post. Without it, they are added as **Pending** and receive nothing until they confirm.

### Import a list

1. Press **Import subscribers**.
2. Under **Where the file comes from**, keep **CSV file** (or pick the option for another newsletter platform's export) and choose your file. It can be comma, semicolon or tab separated, up to 50 MB and 200 columns. A header row helps.
3. **Map the columns.** Swarm suggests where each column goes: **Email**, **First name**, **Last name**, **Tags**, one of your profile fields, or **Don't import**. One column must be the email address.
4. Tick **Everyone on this list agreed to receive this publication** if that is true. Without it, new subscribers are imported as pending and receive nothing.
5. Press **Run the dry run**. Nothing is written yet. You see how many rows would be added, and how many are skipped and why.
6. Press **Import N subscribers**.

Rows are skipped when the address is not usable, is a duplicate of an earlier row, is a role address such as `info@`, is a throwaway mailbox, or has bounced, complained or been blocked before. See [Audience](audience.md#importing) for the details.

### Consent, in plain words

Only add people who asked to hear from this publication. This is the law in many countries, and it is also what keeps you out of spam: people who did not ask press "report spam", and a few of those are enough for mailbox providers to distrust everything you send. Do not import a bought, scraped or very old list.

## 5. Create a signup form

A signup form lets new readers join by themselves.

1. Open **Signup forms** and press **Create a signup form**.
2. Give it a **Name** only your team sees, such as `Footer form`, and press **Create form**.
3. On the **Build** tab, set what you need. A new form asks only for an email address, shows inline, and is ready to use as it is. You can add **First name** and **Last name**, a consent checkbox, change the heading and button text, and choose where and when it shows.
4. Press **Publish** and confirm. Nothing is live until you publish.
5. Open the **Embed** tab and press **Copy embed code**. Paste it into your own site where the form should appear.

You do not need a site of your own to collect signups: your publication's website has a **Subscribe** button and a signup box on every page from the start.

When someone joins and double opt-in is on, they get an email with the subject "Confirm your email for" followed by your publication's name. They become an active subscriber when they press **Confirm**.

More: [Audience](audience.md#signup-forms).

## 6. Look at your website

Every publication has a website from the start. Open **Website** in the left menu and press **View site**.

- The home page lists your posts.
- **Archive** lists every post on the site, and each post has its own page.
- **RSS** in the footer is the feed address, at `/feed`.
- Sent posts appear on the website by default. In the editor, **More options** has a **Website** section where you choose who can read a post there, or keep it off the site.

To try a setting: open **Website**, then **Branding**, pick a **Colour scheme** and press **Save changes**. Reload the site to see it.

More: [Website](website.md). To use your own web address, see [Domains](domains.md#a-custom-domain-for-the-website).

## 7. Write and send your first post

1. Open **Posts**, press **New post**, then **Blank post**. (**From a template** offers ready-made starters.)
2. Fill in **Subject** and **Preview text**. The **Inbox preview** shows how it will look in an inbox.
3. Write in the body. The toolbar has text styles, bold, italic, links, lists, **Quote** and **Divider**. **Insert** adds a heading, an image, a button and more.
4. The panel on the right, **Send**, has three stops. **Write** is done when the post has a subject and some content.
5. Open **Who gets it** and choose **Everyone**.
6. In **Check & send**, read the **Checks**. Each line says **Passed** or what needs attention.
7. Under **Send a test**, press **Send test**. The test goes to your own address, with `[Test]` at the start of the subject. Look at it on your phone too.
8. Press **Send to N subscribers**, then **Confirm**. A send cannot be undone.

Your work saves by itself as you type; the top of the editor says **Saved** with the time.

Everything about the editor, scheduling and tests: [Writing and sending](writing-and-sending.md).

## 8. What warm-up does to your first sends

Mailbox providers are wary of a domain they have never seen send email. So Swarm starts every sending domain with a daily limit and raises it after each good day. This is called warm-up, and it runs by itself.

What you will notice:

- **A first post to a large list goes out over several days.** A new domain of your own may send 200 emails on its first day; the install's shared domain starts at 100. The rest follows on the next days. Nobody is skipped and nobody gets the email twice. You do not need to send again.
- **The readers most likely to open get it first.**
- **Sending pauses if bounces or spam complaints spike.** The Warm-up section says why, and you resume it there.

You see the limit, the plan for the coming days and the controls under **Sending & delivery**, in the **Warm-up** section. The full explanation, including how to choose a faster or slower pace and when it is safe to skip warm-up, is in [Warm-up](warm-up.md).

## 9. Check the results

After you confirm, Swarm opens the **Send report**. It updates live while the send goes out and says **Sent** when it is done.

- **Delivered**, **Opened by people**, **Clicked**, **Unsubscribed**, **Bounce rate** and **Complaint rate** are explained in [Writing and sending](writing-and-sending.md#the-send-report).
- **Links** lists each link in the post with how many people clicked it.

You can open the report again from **Posts**: the date in the **Sent or scheduled** column is a link to it. Home shows your last send, and the trend of opens and clicks from your second send on.

If your emails land in spam, open **Sending & delivery**, then **Deliverability**, and read the [Deliverability guide](deliverability-guide.md).

## Settings worth a look

**Settings** is at the bottom of the left menu.

- **Team.** Invite a teammate: enter their **Email address**, choose a **Role** (Admin, Editor, Author or Viewer) and press **Send invite**. The invite expires in 7 days.
- **Security.** Owners and admins need a second factor: a passkey or an authenticator app. Swarm gives you 14 days to add one. Add it now, and keep the recovery codes somewhere safe.
- **Devices.** Where you are signed in. Sign out any device you do not recognise.
- **Instance.** Only instance admins see this tab; the installer makes the owner one. It holds **Who can sign up**, your **Email service** with its DNS records, and **Features**, where parts of Swarm are switched on or off for everyone.

## Next

- A welcome email for new subscribers: open **Automations**, press **New automation**, choose the **Welcome email** recipe, then **Publish**. See [Audience](audience.md#a-welcome-email-for-new-subscribers).
- [Writing and sending](writing-and-sending.md)
- [Audience](audience.md)
- [Domains](domains.md)
- [FAQ and troubleshooting](faq.md)
