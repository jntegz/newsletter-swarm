# Audience: subscribers, segments and signup forms

This guide covers the people who receive your publication: how they get on your list, what you know about them, how to group them, how they leave, and how to keep the list healthy.

It uses the names you see in the dashboard. Parts marked "optional feature" can be switched on or off by the person who runs your install, under **Settings > Instance > Features**.

## Subscribers

Open **Subscribers** in the left menu. Each row is one person: **Email**, **Name**, **Status**, **Tags** and when they **Joined**.

### What the statuses mean

The buttons above the table filter by status and show a count for each.

| Status       | What it means                                                               | Gets your posts |
| ------------ | --------------------------------------------------------------------------- | --------------- |
| Pending      | Added or signed up, but has not confirmed yet                               | No              |
| Active       | Confirmed, or added with their agreement                                    | Yes             |
| Paused       | Taking a break until a date. They become active again by themselves         | No              |
| Unsubscribed | Left the list. They can join again whenever they like                       | No              |
| Bounced      | Their emails bounced and your [bounce rules](#bounces) stopped mailing them | No              |
| Complained   | They pressed "report spam". Swarm stops mailing them                        | No              |

### Finding people

- **Search** by email address or name.
- **Tag** filters to one tag. It appears once the publication has tags.
- **Columns** chooses which columns the table shows.

### One subscriber

Click an email address to open that subscriber. From top to bottom you find:

- **Status**, with **Pause until** a date and **Unsubscribe**.
- **Bounces**, once their address has bounced: what happened, what the receiving server said, how many emails in a row bounced softly, and whether Swarm stopped mailing them or is waiting for you to decide. See [Bounces](#bounces).
- **Paid subscription**: free, or their paid plan.
- **Profile**: first and last name. Press **Save profile** after a change.
- **Tags**: remove one, or type a new one under **Add a tag**.
- **Profile fields**, if the publication has any.
- **Source**: when and how they joined (a signup form, an import, added by hand), when they confirmed, and who referred them.
- **Referrals**: their own share link and how many people joined through it.
- **Automations**: which automations they have been through.
- **Activity**: what they were sent, and what they opened and clicked. Only for the workspace's engagement history time (13 months unless changed under **Settings > Privacy**), and without opens and clicks for someone who asked not to be tracked.
- **Delete subscriber** removes the person from this publication and erases their address from delivery history. This cannot be undone. It is not a full erasure: their tracking history, stored webhook payloads and orders stay, and a later import can add the address again. When someone asks for their data to be deleted, use **Settings → Privacy → New request** and choose **Their data to be deleted** instead: that clears all of it, in every publication of the workspace, and stops the address being added again.

### Changing many at once

Tick the box in front of several rows, or the one in the table's header, and choose an action: **Add tag**, **Remove tag**, **Set field**, **Unsubscribe** or **Delete**.

### Adding someone by hand

1. Press **Add subscriber**.
2. Enter the **Email** and, if you have them, **First name** and **Last name**.
3. Tick **They asked to receive this publication** only if they did.
4. Press **Add subscriber**.

Ticked, they are active and get your next post. Not ticked, they are added as pending and receive nothing until they confirm.

## Profile fields and tags

On **Subscribers**, press **Fields and tags**.

**Tags** are simple labels, such as `Lisbon` or `event-2026`. You add them by hand, in bulk, or from a column of an import. **Create tag** makes one, and each tag can be renamed or deleted. Every import also adds a tag that starts with `import:` to the people it brought in, so you can find them later.

**Profile fields** hold a value per subscriber, such as a company or a birthday. Press **Add profile field**, give it a label and choose a type: **Text**, **Number**, **Date**, **Yes or no**, **One choice** or **Several choices**. You can use a field:

- in a post, as a merge tag written `{{fields.key}}` with the field's key (see [Writing and sending](writing-and-sending.md#merge-tags));
- in a segment rule;
- on a signup form, to ask for it when people join.

Use a tag when someone either has it or not. Use a field when there is a value to store.

## Importing

Bring a list you already have from a file.

1. On **Subscribers**, press **Import subscribers**.
2. **Upload.** Under **Where the file comes from**, keep **CSV file**, or pick one of the options for a file exported from another newsletter platform. Choose the file. It can be comma, semicolon or tab separated text in UTF-8, up to 50 MB and 200 columns. A header row helps Swarm suggest where each column goes.
3. **Map columns.** For each column choose **Email**, **First name**, **Last name**, **Tags**, one of your profile fields, or **Don't import**. Exactly one column holds the email addresses. Any number of columns can add tags.
4. Decide two things:
   - **Everyone on this list agreed to receive this publication.** Tick it only if it is true. Without it, new subscribers are imported as pending. No email is sent, and they receive nothing until they confirm.
   - **Update subscribers who are already on the list.** Without it, people already on your list are left exactly as they are.
5. **Review.** Press **Run the dry run**. Nothing is written yet. The review shows how many rows fall into each group, with examples.
6. **Import.** Press **Import N subscribers**. When it finishes you see how many were added, updated and skipped.

If you leave partway, the file is listed under **Recent imports** on the import page. Click it to carry on.

### Why rows are skipped

| Group                | Why                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| Invalid              | Not a usable email address                                                                     |
| Duplicates           | An earlier row has the same address. Only the first counts. Capital letters make no difference |
| Role addresses       | Addresses like `info@` or `support@` reach a team, not a person                                |
| Disposable addresses | Throwaway mailboxes that stop working soon                                                     |
| Suppressed           | Bounced, complained or was blocked before. Swarm never mails them again                        |

The review also shows **Unchanged** (already a subscriber, and nothing in the file changes them) and **Updated**.

### Rules of thumb

- **Only import people who agreed to hear from this publication.** A bought, scraped or borrowed list gets you spam complaints, and a handful of those is enough for mailbox providers to file everything you send as spam.
- **Leave out people who unsubscribed elsewhere.** If you are moving from another platform, export only your active subscribers.
- **Be careful with old lists.** Addresses nobody has mailed for a year or more bounce, and too many bounces pause your sending. Import the people who opened recently first, or tick **Check addresses during import** to leave out the ones that will bounce (see [Email checks](email-verification.md)).
- **A very large import during warm-up slows you down.** See [Warm-up](warm-up.md).

## Exporting

Your list is yours, and you can take it out at any time. You need the Admin role or higher.

1. On **Subscribers**, press **Export**.
2. Choose a **Format**: **CSV**, which opens in any spreadsheet, or **JSON Lines**, for scripts.
3. Choose which **Subscribers**: every status, or one status only.
4. Press **Start export**, and download the file when it is ready.

The file includes every profile field. Each download is recorded in the audit log, and the file is deleted after 72 hours.

**Fields and tags** also links to **Export destinations**, which can copy your subscriber data to storage of your own on a schedule. A new destination sends subscribed readers only, without profile fields; under **What it sends** you can pick fields, or choose everyone for a full backup. Destinations added before you could choose say **Older scope: everything** and keep sending everyone with every field until you change them.

## Segments

A segment is a group of subscribers defined by rules, such as "has the tag Lisbon" or "opened a post in the last 30 days". People move in and out by themselves as their data changes. You send a post to a segment, or leave a segment out of one.

### Create a segment

1. Open **Segments** and press **Create a segment**.
2. Give it a **Name**. The **Description** is optional and only your team sees it.
3. Build the **Rule**. The first line reads "Subscribers who match **all** of these"; change **all** to **any** or **none** if you need to.
4. For each condition pick what to look at, how to compare, and a value. You can look at:
   - **Email**, **First name**, **Last name**
   - **Status** and **Delivery**
   - **Joined** and **Confirmed** dates
   - **Tag**
   - **Opened a post** and **Clicked a link** (these never match someone who asked not to be tracked, so a group of people who did _not_ open includes them; check before using one to remove people)
   - **Referrals made**, **Referrer** and **Referral code**
   - where they signed up: **Signup form id** and the link tags that start with `utm_`
   - **Paid plan**
   - any profile field of the publication
5. **Add condition** adds another line. **Add group** adds a set of conditions with its own all, any or none.
6. Watch **Who matches now**. It shows how many subscribers match the rule as it stands, saved or not, and up to 25 of them.
7. Press **Create segment**.

The segment's page has two tabs, **Rule** and **Subscribers**. Its status is **Ready** when the count is up to date. After subscriber data changes it can briefly show **Pending** while Swarm counts again; segments are also recounted regularly, so rules about "the last 30 days" stay current. **Refresh now** recounts on the spot.

### Use a segment

In the post editor, under **Who gets it**, choose **Only some segments** and tick it, or tick it under **Leave out**. See [Writing and sending](writing-and-sending.md#who-gets-it).

Segments are rule-based groups you define. **Rosters** are different: lists subscribers choose to be on themselves. Rosters are an optional feature; see [Rosters](rosters.md).

## Signup forms

A signup form is how new readers join.

### Where people can sign up

- **On your publication's website.** Every page has a **Subscribe** button and a signup box from the start. There is nothing to set up.
- **On a site of your own**, with a form you build under **Signup forms** and paste in as a line of code.

### Build a form

1. Open **Signup forms** and press **Create a signup form**.
2. Give it a **Name** only your team sees and press **Create form**. It starts as a draft with just an email field.
3. On the **Build** tab:
   - **Fields.** Email is always asked for. Add **First name**, **Last name** or a profile field, and set each **Label** and **Placeholder**.
   - **Ask for consent.** A checkbox under the fields, such as agreeing to your privacy policy.
   - **Layout:** **Regular** (heading, text and stacked fields) or **Slim** (fields and button on one line).
   - **Placement:** **Inline**, a **Slide-in**, a **Popup**, or a **Sticky bar** at the top or bottom.
   - **When it shows:** as soon as the page loads, after a delay, after scrolling, when the visitor is about to leave, and more. **How often** decides whether a returning visitor sees it every time.
   - **After someone joins:** show a message, or send them to a page on your site.
   - **Double opt-in:** follow the publication's setting, or set it for this form.
   - **Look:** the accent colour and a light or dark scheme.
   - **Allowed sites:** leave empty to let the form load anywhere, or list the sites that may show it.
   - **Text:** the heading, the text under it and the button.
4. The **Preview** on the right shows the draft on a sample page, on **Desktop** and **Mobile**, with a simulator for the trigger you chose.
5. Press **Publish** and confirm. Nothing goes live until you publish.

### Put it on your site

Open the **Embed** tab.

- **Embed code.** Press **Copy embed code** and paste it into your page where the form should appear.
- **Form without JavaScript.** A plain HTML form for pages that cannot load scripts. It carries the email, name and consent fields; profile fields need the embed code.

**The embed code belongs to one version of the form.** When you change a form and publish again, the sites that show it keep the old version until you paste the new embed code.

The **Stats** tab shows how the form is doing.

### Confirm opt-in

With double opt-in on, someone who fills in a form is not a subscriber yet.

1. They see a message asking them to check their inbox.
2. They get an email with the subject "Confirm your email for" and your publication's name.
3. They open the link and press **Confirm**. The link itself changes nothing; the button does. This stops mail scanners, which open every link, from confirming people by accident.
4. They are now active, and the page tells them so.

Until then they are **Pending** and receive nothing else. The confirm link works for 7 days by default.

You set this per publication. Open the publication's settings (the publication name at the top of the left menu, then **Manage publications**):

- **Double opt-in.** New subscribers confirm by email before they receive anything. Signup forms follow this unless they set their own.
- **Every subscriber must confirm.** Forms cannot turn confirmation off, and people you add by hand or through the API are emailed a confirmation too. Imported lists, where you state they agreed, are the exception. People who pay at checkout confirm too, unless they were signed in when they paid: their purchase is theirs from the start, but they can read it once their address is confirmed.
- **Confirm links work for (days).**

Keep double opt-in on unless you have a strong reason. It keeps mistyped and fake addresses off your list, and it is your proof that someone asked to hear from you.

### A welcome email for new subscribers

An automation can greet each person the moment they confirm.

1. Open **Automations** and press **New automation**.
2. Keep **A recipe** and choose **Welcome email**. It comes with two versions of the email already written; Swarm tests them against each other and the better one wins.
3. Press **Create automation**. The builder shows the steps: **Confirmed**, the **A/B test**, and the two emails.
4. Click an email step to change its subject and text.
5. Press **Publish**, then **Publish version 1**.

From then on, everyone who confirms gets the welcome email, usually within a minute or two. The **Runs** tab lists who went through it, and **Stats** shows how each step did. **Test run** sends it to one subscriber you choose.

## What a subscriber can do themselves

Every email ends with two links: one to the reader's own settings page and one to unsubscribe.

**A note on names.** In the dashboard this page is called **Subscriber settings**, and readers see the same title on the page. The link to it in the email footer and on the confirmation page reads "Manage your subscription".

On that page a reader can:

- change their **first name** and **last name**;
- **take a break** for 2, 4 or 8 weeks. Their status becomes Paused and they return by themselves;
- **stop emails and keep their membership**: posts and automation emails skip them, while their status, website sign-in and any paid subscription stay as they are, and receipts, sign-in links and billing notices still come. One click turns it on and one turns emails back on. The subscriber's drawer in the dashboard says when they did it, and the API's subscriber object has `emailsOffAt`. Only the subscriber can turn emails back on, and the inactive-reader cleanup leaves them alone;
- **unsubscribe**, with an optional reason. Unsubscribing also ends website sign-in, so a paying subscriber who only wants fewer emails is better served by the choice above;
- ask for **a copy of their data** by email, or **delete their data**. These requests show up under **Settings > Privacy Center**.

A reader who has lost the link can ask for a new one. On the install's forms address, `/m` shows a page where they enter their email address and get a link that works for 30 days.

### Unsubscribing

There are three ways out, and all of them work without signing in:

- **The unsubscribe link in the email.** It opens a page that asks "Stop receiving these emails?" with an **Unsubscribe** button. The link alone changes nothing, so a mail scanner cannot unsubscribe someone by opening it.
- **The unsubscribe button of their mail app.** Gmail, Apple Mail and others show their own button next to the sender's name. It unsubscribes with one click.
- **The settings page** described above.

The subscriber's status becomes **Unsubscribed** at once, and the send report counts them under **Unsubscribed**.

## Unsubscribed is not the same as blocked

These are two different lists, and the difference matters.

**Unsubscribed** is a status on one publication. The person chose to leave. They can sign up again whenever they like, and if they do, they are a subscriber again.

**Blocked addresses** (also called suppressions) are addresses Swarm will not email at all. Open **Sending & delivery** and find **Blocked addresses**:

- Addresses that **complain** (the reader pressed "report spam") are added for you, and so are addresses that **bounce**, when your [bounce rules](#bounces) say so. Each bounce row says why, with what the receiving server said under **What the receiving server said**.
- **Block an address** adds one by hand, for example when someone writes to you and asks never to be contacted again.
- **Find an address** tells you whether an address is blocked and why.
- An import skips blocked addresses and lists them under **Suppressed**.
- Removing an address you blocked by hand does not subscribe it again. It only allows it to be mailed if the person joins again.
- Removing a **bounce** is how you say the address works again (the reader emptied their mailbox, or the typo was fixed). Swarm asks you to confirm with **Mail again**, then gives their subscriptions back the status they had before the bounce, and the bounce counts start again from zero. If it bounces again, the rules apply as usual.

Do not remove a bounced address unless you know the mailbox works now. If your install sends through Resend, note that Resend keeps a list of its own that Swarm does not change: see [Self-hosting](self-hosting.md#choosing-resend-or-amazon-ses).

## Checking addresses

With [email checks](email-verification.md) set up, each address gets a colour (green, orange or red) from DeBounce, an email verification service: at signup, on import, when someone is added, and across your list with **Check addresses** on the Subscribers page. Filter the list by colour, make segments where **Email check is** a colour, and stop mailing red addresses before they bounce.

## Bounces

A bounce is an email that could not be delivered. The receiving server says why, and Swarm sorts each bounce into one of three kinds:

- **Hard bounce**: the address will never work. The mailbox or its domain does not exist, or your email service refuses the address because it hard-bounced before.
- **Soft bounce**: the address may work later. The mailbox is full or switched off for now, the email was too large, or the server asked to try again later.
- **Blocked**: the receiving server refused because of you as the sender (your reputation, a blocklist, the content, SPF, DKIM or DMARC), not because of the address.

Under **Sending & delivery > Bounces**, the workspace's owners and admins choose when Swarm stops mailing an address. The recommended rules, which every workspace starts with:

- Stop at the **first hard bounce**. The other choice is after 2 hard bounces within 30 days, for an email service that sometimes calls a working address dead.
- Stop after **3 emails in a row bounced softly** (you can pick 2 to 10). An email that is delivered starts the count again, so a reader whose mailbox was full for a week keeps getting your posts, and an address that only ever bounces softly is stopped whether you send daily or monthly. You can also turn on "N soft bounces within D days", or turn both off so soft bounces never stop anyone (not recommended: dead addresses then stay on your list and raise your bounce rate).
- **Blocked** emails never stop a subscriber: it is not their fault. They count towards your bounce rate, and the deliverability check-up tells you which mailbox provider is refusing you and how to fix it.
- A **spam complaint** always stops mailing that address at once. That one cannot be changed.
- **Ask me before stopping a subscriber on a paid plan.** Instead of stopping someone who pays, or was given a paid plan, Swarm lists them under **Needs your attention** on the same page and emails the workspace's owners and admins. They keep getting your emails until you choose **Keep mailing** or **Stop mailing**.

When you change the rules, Swarm shows how many subscribers they would stop now, counted from the last 90 days of bounces. The new rules apply from each address's next bounce, unless you tick **Apply to past bounces too**.

A stopped subscriber shows the status **Bounced** in every publication of the workspace, and their address is listed under **Blocked addresses** with the reason and the date. To mail them again once the address works, remove it there.

## Cleaning up inactive readers

Sending to people who never open hurts delivery for everyone else on your list. Mailbox providers watch how many of your readers engage.

On **Sending & delivery**, the **Inactive readers** section can unsubscribe them for you. Choose under **When to unsubscribe inactive readers**:

- **Keep everyone (off)**, the default
- **After 6 months with no opens or clicks**
- **After 1 year with no opens or clicks**
- **After 2 years with no opens or clicks**

Only readers who have been sent at least 5 emails with an open pixel during the whole period are considered, so a new subscriber is never removed for being quiet.

Nobody is removed without warning. When a reader first qualifies, Swarm emails them that they will be unsubscribed in 14 days, with a **Keep me subscribed** button on their subscriber settings page. One click keeps them, and the period starts again from then. If they do nothing and still show no opens or clicks, they are unsubscribed after the 14 days. The reason recorded on the subscriber says it was automatic, which rule it used and what it saw, and their subscriber settings page tells them why and offers **Join again**. People removed this way are unsubscribed, not blocked.

The period is measured from each reader's own emails over the whole time you chose, not from the 90-day engagement score. That needs the email history to go back that far: if your workspace keeps less engagement history than the period (**Settings > Privacy > Engagement history**, for example 6 months of history with **After 1 year**), the cleanup does nothing until you keep more history or choose a shorter period, and the section says so. With the default 13 months of history, **After 2 years** waits. The cleanup never reads email history older than what the workspace keeps, so it stays within the period you told your readers.

This needs engagement scores, an optional feature. Before you turn it on, consider trying to win quiet readers back first: **Automations > New automation** has a **Re-engagement** recipe that checks in with subscribers who have not opened anything for 60 days.

A reader whose mail app hides opens can look inactive while reading every issue. Swarm never treats such a reader as inactive: when most of their emails were opened only by a machine (a privacy proxy fetching the images), or their engagement score says opens are hidden, the cleanup leaves them alone. A click always counts, which is one more reason to give readers something to click.

The cleanup never unsubscribes anyone for not opening when Swarm can't see opens: it doesn't run while the publication has **Open tracking** or **Reader profiles** off (**Sending & delivery > Tracking**), it skips subscribers who asked not to be tracked, and it counts only emails that had an open pixel. See [Tracking and retention](privacy-controls.md).

## Related

- [Getting started](getting-started.md)
- [Writing and sending](writing-and-sending.md)
- [Rosters](rosters.md)
- [Warm-up](warm-up.md)
- [Deliverability guide](deliverability-guide.md)
- [FAQ and troubleshooting](faq.md)
