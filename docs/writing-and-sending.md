# Writing and sending

This guide covers a post from the first word to the numbers after it is sent: the editor, previews and tests, the checks before sending, who gets it, scheduling, and the send report.

It uses the names you see in the dashboard. Some parts of Swarm are optional features that the person who runs your install can switch on or off under **Settings > Instance > Features**. Where this guide says "optional feature", that is where to look if you do not see it.

## Starting a post

Open **Posts** and press **New post**. The menu offers:

- **Blank post.** An empty page with your default footer.
- **From a template.** Opens **Templates**, where you pick a starter or one you saved and press **Use**. See [Templates](templates.md).
- **Duplicate** followed by the subject of your latest post. Copies the subject, preview text and content, not the send.

A new post is a **Draft**. It stays a draft until you send or schedule it. Your work saves by itself; the top of the editor says **Saved** with the time, or **All changes saved**. Leaving the page saves it too.

## The editor

At the top:

- **Subject.** What readers see in their inbox. Up to 200 characters.
- **Preview text.** The line inboxes show after the subject. Leave it empty and inboxes show the post's first line. 40 to 90 characters reads well on a phone.
- **Inbox preview.** Your sender name, subject and preview text as an inbox shows them.
- **Cover image.** Shown large at the top of the post, in the email and on the website.

### The toolbar

- **Text style:** Paragraph, Heading or Subheading.
- **Bold**, **Italic** and **Add link**. To link words, select them, press **Add link**, enter the **Web address** and press **Apply**.
- **Bulleted list**, **Numbered list**, **Quote** and **Divider**.
- **Merge tag.** See [Merge tags](#merge-tags).
- **Undo** and **Redo**.
- **Insert**, which opens the list of blocks.

### Blocks

Press **Insert** in the toolbar, or type `/` on an empty line to open the same list and filter it by typing.

| Block         | What it is                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Heading       | A section heading                                                                                                           |
| Image         | A picture from your media library, or a new upload. Add **Alt text** so everyone can understand it. Optional link and width |
| Button        | A large link with a **Label** and a **Web address**                                                                         |
| Quote         | A quoted passage                                                                                                            |
| Divider       | A line between sections                                                                                                     |
| Link card     | A link shown as a card                                                                                                      |
| Callout       | A highlighted box of text                                                                                                   |
| Two columns   | Side by side on wide screens                                                                                                |
| Embed         | A video or audio link from a supported site, shown as a player on the website                                               |
| Footnote      | A numbered note                                                                                                             |
| File          | A file readers can download                                                                                                 |
| Paywall break | Everything below it is for paying subscribers. One per post. Needs [paid plans](#paid-posts)                                |
| Poll          | A question readers answer with one click                                                                                    |

Depending on which optional features are on, the list can also show Snippet, Product, Sponsor, Raw HTML and others.

After you insert an image, a button or a paywall break, the cursor is on the line after it, so you can keep typing.

You can also drag an image file into the post, or paste one. It is uploaded to your media library and placed where it landed.

To move a block, hold **Alt** and press the up or down arrow, or drag the handle that appears beside the block.

### Merge tags

A merge tag is a placeholder that is filled in for each reader when the email goes out.

1. Put the cursor where the value should go.
2. Open **Merge tag** in the toolbar and choose **First name**, **Last name** or **Email address**.

The tag appears in the text between double curly brackets, with a fallback after a `|` for readers who have no value. A first name with the fallback "there" reads "Hello Rita" for Rita and "Hello there" for someone whose name you do not have. Test emails and previews show the fallback.

Your own profile fields can be used the same way, written as `{{fields.key}}` with the field's key. You create fields on the **Fields and tags** page; see [Audience](audience.md#profile-fields-and-tags).

### More options

At the bottom of the right panel, **More options** holds:

- **Note for your team.** Only people working in this publication see it. It never goes out.
- **Website.** Whether and how the post appears on your website: **Who can read it on the website** (Everyone, Subscribers only, Paid subscribers only, or Hidden from the website), **Search title**, **Search description** and the post's **Web address**. **Publish to web only** puts a draft on the website without emailing anyone.
- **History.** Every save is kept. You can **Name this version**, **Compare** an older version with the current one, and **Restore** it.
- **Test before sending**, when split tests are on. See [Split tests](#split-tests).
- **Planned date**, when the content calendar is on. See [Archive and calendar](#archive-and-calendar).
- **Delete draft.**

### Paid posts

If your publication has paid plans (under **Paid subscriptions**), **Insert > Paywall break** splits a post: free subscribers get what is above the break, paying subscribers get everything. **View as** at the top of the editor switches the preview between **Free subscriber** and **Paid subscriber**.

## Preview and test

The buttons at the top of the editor switch between **Edit** and four previews:

- **Email · desktop**
- **Email · mobile**
- **Email · dark**, how the email looks for readers whose mail app uses a dark theme
- **Web**, the post at web width. Your website adds its own header, navigation and theme around it.

The previews show the saved version before personalisation, so merge tags show their fallback.

A preview is a good guess. A test email is the real thing:

1. Open **Check & send** in the right panel.
2. Under **Send a test**, your own address is filled in. You can enter up to 5 team addresses.
3. Press **Send test**.

The test arrives with `[Test]` at the start of the subject. Links in a test are not tracked, and its unsubscribe link does nothing. Read it on a phone as well as a computer.

## Who gets it

Open **Who gets it** in the right panel. Choosing is deliberate: the send button stays off, with the note "Choose who gets this post first", until you do.

- **Everyone.** Every active subscriber of the publication. The panel shows the number.
- **Only some segments.** Tick one or more segments under **Segments to send to**. Until you tick one, it still goes to everyone.
- **Leave out.** Tick segments whose subscribers should not get this post. It works together with either choice above.
- **Rosters**, when the feature is on. A roster is a list subscribers choose to be on, such as "Events". Ticking a roster limits the send to the people on it. Combined with segments, a subscriber must match both, and gets the email once. See [Rosters](rosters.md).

Nobody gets the same post twice, however many segments they are in. Only **Active** subscribers are sent to: pending, paused, unsubscribed, bounced and complained addresses are always left out.

A segment that shows "updating" instead of a number is being recounted. Wait a moment before you send to it.

**From** is in the same stop. It shows the sender this post goes out from. Pick another one from the list, or follow **Manage senders** to add one.

## The checks before sending

**Check & send** lists the **Checks**. Each one says **Passed** or **Needs attention**, with the reason. A post cannot be sent while a check needs attention.

| Check       | What it looks at                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| Subject     | The post has a subject                                                                                     |
| Content     | The post is not empty and can be turned into an email                                                      |
| Links       | Every link is a valid web address. The line says how many links there are                                  |
| Sender      | Who it is from: the sender's name and address                                                              |
| Domain      | The sending domain is verified, with DMARC at quarantine or reject. Or that it goes from the shared domain |
| Subscribers | How many active subscribers are in the audience you chose. Zero stops the send                             |
| Warm-up     | Warm-up is running or complete. A paused warm-up stops the send until you resume it                        |

Above the checks you may also see advice that does not stop you, such as "Preview text is empty", or that today's warm-up limit is smaller than your audience, so the rest goes out over the next days.

## Sending now

1. Under **When**, keep **Send now**.
2. Press **Send to N subscribers**. The exact number is on the button.
3. Read the question, "Send now to N subscribers? This can't be undone", and press **Confirm**.

Swarm opens the send report. Emails go out in batches. While it is running you can press **Stop sending**; emails that already went out stay out.

A sent post can no longer be edited. To fix a mistake on the website, see the **Website** section in **More options**; the email itself cannot be changed.

## Scheduling

1. Under **When**, choose **Schedule**.
2. Set **Send date and time**. The line below shows your time zone.
3. Press **Schedule for** followed by the day and time, then **Confirm**.

The post's status becomes **Scheduled**. The checks run again at send time. If something is not ready then, the post goes back to draft and nothing is sent, so look at Home on the day: it lists what needs you.

To change your mind, open the post and press **Unschedule**. It becomes a draft again.

### Send at each reader's best time

This is an optional feature. When it is on, **When** shows a checkbox, **Send at each reader's best time**.

With it ticked, each reader gets the post over the 24 hours from the time you chose, at the hour they most often opened or clicked in the last 90 days. It is an estimate, and it needs **Reader profiles** on for the publication; without it the post goes at the chosen time. Readers who asked not to be tracked always get the chosen time. Readers who have opened or clicked fewer than 3 posts get it at the time you chose, and that includes people whose mail app hides opens. It cannot be combined with a split test.

## Split tests

This is an optional feature. A split test sends two or three versions to a small part of your audience, waits, and sends the winner to everyone else.

1. In the editor, open **More options**. Under **Test before sending**, choose the split test instead of **Send to everyone at once**.
2. **What to test:** **Subject line and preview text**, or **Content**.
3. **Variant A** is the post as written. Fill in **Variant B**, and press **Add variant C** if you want a third.
4. **Test on (% of the audience).** The page works out how the audience divides: with 20%, each of two variants goes to about 10%, and the other 80% get the winner.
5. **The winner has the most:** **Opens**, **Clicks** or **Conversions (a goal)**.
6. **Pick the winner after:** from 30 minutes to 7 days, counted from when the test part has gone out.
7. Save it, then send or schedule the post as usual.

A test needs enough people to mean anything. With a list of a few hundred, the difference between two subjects is mostly chance.

## The send report

The report opens after you send. You can return to it from **Posts**, where the date in the **Sent or scheduled** column links to it, or from Home.

At the top: the subject, who it was from, when it started, and its status: **Sending**, then **Sent**, with **Waiting** or **Paused** beside it while the send waits for a sending limit ([When a send waits](#when-a-send-waits)). The bar shows how many emails have been handled out of the total.

| Number           | What it means                                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Delivered        | Emails the receiving mail servers accepted. The line below says how many were sent. Delivered means accepted, not "in the inbox": an accepted email can still be filed as spam                                                                                                             |
| Opened by people | The share of delivered emails opened by a person. Below it: how many people, and how many **privacy proxies**. Some mail apps, Apple Mail among them, load every email on the reader's behalf whether or not they read it. Swarm counts those apart, so they do not inflate your open rate |
| Clicked          | People who clicked at least one link. Below it: the share of openers who clicked, and how many **scanners**. Company mail filters follow every link to check it; Swarm counts those apart too                                                                                              |
| Unsubscribed     | People who unsubscribed from this email                                                                                                                                                                                                                                                    |
| Bounce rate      | The share of emails that could not be delivered, because the address does not exist or the mailbox refused it. Addresses that bounce are blocked so you do not mail them again                                                                                                             |
| Complaint rate   | The share of readers who pressed "report spam". Above 0.1%, mailbox providers start to filter you                                                                                                                                                                                          |
| Failed           | Emails your email service refused to take at all                                                                                                                                                                                                                                           |
| Sending cost     | An estimate at $0.10 per 1,000 emails. What you actually pay depends on your email service                                                                                                                                                                                                 |

Open rates are never exact. Readers who block images are not counted, and privacy proxies hide real opens. Compare your own sends with each other, not with other people's numbers.

Tracking choices change what the report can show ([Tracking and retention](privacy-controls.md)):

- **Open tracking off** for the send: **Opened by people** says **Not tracked**. Clicks still count as opens of the people who clicked.
- **Click tracking off** for the send: **Clicked** says **Not tracked** and **Links** has no counts, because links went straight to their address.
- **Subscribers who asked not to be tracked** get emails with no tracking. They count as sent and delivered, the open rate is worked out from everyone else, and a line under the numbers says how many there were.
- When someone asks not to be tracked later, or when engagement history passes the workspace's retention time, the people are removed from the records but the report's numbers stay the same.

**Links** lists every link in the post. **People** counts each person once. **Their clicks** counts every click those people made, up to 20 per person and link (a link opened more often than that is still followed, but not counted again). **All clicks** adds link scanners and bots. A person's first click on a link is what can start or wake a Flow; clicking it again doesn't. With the click map feature on, the report also shows the email as it went out, with each link marked with how many people clicked it.

### When a send waits

Your email service limits how much it sends in a second, an hour, a day or a month, and the owner of your Swarm sets those limits under **Settings > Instance > Sending limits**. When a send reaches one, the rest of it waits and goes out later. Nobody is dropped and nobody gets it twice. **Do not send the post again.**

The report says what it waits for, how many are left and when it continues, for example "Waiting for your email service's daily limit: 1,240 left, continues at 00:00 UTC". Home mentions it under **Needs you** while it lasts. Times are in UTC.

- **An hour or a day:** sending goes on by itself when the hour or the day turns.
- **Capacity shared with other publications** (installs with several workspaces): the report says "Waiting for capacity" and when it asks again. Other workspaces are sending at the same time, or this send is large, so it goes out in parts and shares the install's sending capacity fairly. It goes on by itself, Home doesn't list it and nobody is emailed: nothing needs fixing.
- **A month:** the send is **Paused** until the 1st, and the publication's owners and admins get an email. It goes on by itself then.
- **The email service stopped accepting mail** (its account is suspended, or it refuses Swarm's key or the sending domain): the send is **Paused**, and the publication's owners and admins get an email. Ask the owner of your Swarm to fix the email service. Swarm also tries it again by itself with one email: after 5 minutes, then less often (each wait as long as the send has been stopped so far, at most 6 hours). As soon as the service takes mail, the rest of the send goes out. The report shows when Swarm tries next.
- **The email service still refuses mail 7 days after it stopped:** the send ends. Its status becomes **Failed**, or **Partially failed** if some of it went out; everyone still waiting is counted as failed and is not sent the post, and the owners and admins get an email. If nobody got it, the post goes back to your drafts, so you can fix the problem and send it again. An automation email keeps going: the subscribers who were waiting are counted as failed, and the next ones to reach it get it once the service works.

Admins of the publication see **Resume sending** on the report. It tries again at once, from everyone not sent yet; if the limit still holds, the send waits again. Use it after the email service is fixed, or after the limit or your plan was raised. Nobody gets the post twice, and resuming never uses up more of the day's warm-up limit than the people it sends to.

Sign-in links, signup confirmations and receipts keep going out while a send waits: a tenth of each limit is kept for them. Warm-up is a separate daily limit for a new sending domain; each day the lower of the two decides how many go out.

### Send again to people who did not open

This is an optional feature. When it is on, the report of a finished send has a button, **Send again to people who didn't open**.

It creates a new draft with the same content, set to go only to people who neither opened nor clicked the first send. Change the subject, check it and send it like any other post. Choosing a segment narrows the audience further. Some people read with a mail app that hides opens, so a few may get it twice. Use it sparingly. People whose email had no open pixel (the send had open tracking off, or they asked not to be tracked) are never included, so after a send with open tracking off this audience is empty.

## The posts list

**Posts** lists every post with its **Status** (Draft, Scheduled, Sending, Sent), who started it, when it was sent or is scheduled, and when it was last edited. **Started by** filters between posts a teammate started and posts made through an agent or the API.

### Archive and calendar

Both are optional features.

- **Post archive.** Sent posts get an **Archive** action, and you can tick several and archive them together. Archiving tidies your list. An archived post keeps its stats and stays on your website. **Show: Archived posts** lists them, with **Restore**. A draft or scheduled post cannot be archived until it is sent.
- **Content calendar.** **Show posts as: Calendar** shows a month, with sent and scheduled posts on their days. **New post** on a future day starts a draft with that day as its **Planned date**. A planned date is a goal for your team and does not schedule or send anything. Drag a draft to another day, or use **Move**. To move a scheduled send, use **Change time**.

## Automations

A post goes out once, when you send it. An automation sends emails by itself when something happens, such as someone confirming their subscription. See [Audience](audience.md#a-welcome-email-for-new-subscribers) for the welcome email, the usual first one.

## Related

- [Getting started](getting-started.md)
- [Templates](templates.md)
- [Warm-up](warm-up.md), which explains why a large send can take several days at first
- [Deliverability guide](deliverability-guide.md)
- [FAQ and troubleshooting](faq.md)
