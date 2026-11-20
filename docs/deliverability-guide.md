# Deliverability guide: why email is not arriving, and what to fix

This guide is for the person who writes and sends the newsletter. You do not need to know how email works to use it. Developers who want the internals should read [deliverability.md](deliverability.md).

"Deliverability" means one thing: whether your email reaches the inbox, lands in spam, or is refused. Three things decide it, in this order:

1. **Who you are.** Can the mailbox provider prove the email really comes from your domain? (SPF, DKIM, DMARC.)
2. **How readers react.** Do they open and reply, or do they ignore you and press "spam"? (Complaints, bounces, engagement.)
3. **What the email looks like.** Does the content resemble junk mail? (Subject, links, images.)

Swarm checks all three for you. Start with the check-up.

## The check-up

Open **Sending & delivery → Deliverability**. The **Check-up** at the top runs every check for your publication and gives you:

- **A verdict.** "3 problems to fix", "No problems, 2 things to improve", or "Everything checks out".
- **A score out of 100.** It starts at 100. Each problem takes off 20 and each warning takes off 5. It never goes below 0, and checks that could not run do not change it. The score is a quick way to see progress after you fix something. It is not a rating from Gmail or anyone else, and no mailbox provider will ever see it.
- **Findings**, in four groups:

| Group           | What it means                                                                   | What to do                           |
| --------------- | ------------------------------------------------------------------------------- | ------------------------------------ |
| Fix these first | A problem. It stops email from arriving, or sends it to spam.                   | Fix it before your next send.        |
| Worth improving | A warning. Your email still goes out, but this makes the inbox less likely.     | Fix it when you can.                 |
| Couldn't check  | The check did not finish or cannot be done automatically. No result either way. | Run again, or follow the link given. |
| Working well    | Fine as it is. Folded away by default.                                          | Nothing.                             |

Findings are listed with the most harmful first, so work from the top down. Each one says what it means, the exact steps to fix it, and has a button to the right page.

Press **Run again** after you change something. DNS changes can take up to an hour to show, so a record you just added may still read as missing for a while. Blocklist answers are remembered for 15 minutes.

Anyone on the team can read the check-up, including viewers. Most fixes need an admin.

## Every finding and its fix

### Sender

**Your From address is on a free mailbox service (problem).** Addresses on gmail.com, yahoo.com, outlook.com, icloud.com and similar can only be sent by that service's own servers. A newsletter sent "from" such an address by anyone else fails DMARC and is rejected or filed as spam. No setting works around this. Fix: use a domain you own. Add it under **Sending → Domains**, publish the DNS records shown, then make an address on it your default under **Senders**. You can keep your personal address as the reply-to.

**Your From address tells readers not to reply (warning).** Addresses such as no-reply@ throw away the best signal there is: mailbox providers treat replies as proof that people want your email. Fix: change the sender to an address a person reads, under **Sending → Senders**.

**No sender is set up yet (warning).** Until you add one, email goes out from a shared address named after your publication. Fix: add a name and address under **Sending → Senders**.

**You send from the shared domain (good).** This works and needs no setup. Its reputation is shared with every other publication on this Swarm that uses it. A domain of your own builds a reputation that is yours alone, which matters more as your list grows.

### Sending domain and DNS records

**Your domain is not verified (problem).** Your email service has not confirmed that you control the domain, so nothing is sent from it. Fix: open the domain under **Sending → Domains**, copy each record into the DNS settings where your domain is registered, wait up to an hour, then press "Check again".

**The DKIM record is missing or wrong (problem).** Without it your email is not signed for your domain, and Gmail and Yahoo refuse unsigned bulk mail. Fix: the finding shows the exact record type, name and value. Add or correct it in your DNS.

**The SPF (return path) record is missing or wrong, or there are two (problem).** A name may hold only one SPF record. Two make SPF fail for every email. Fix: add the record shown, or merge the two into one.

**The return path MX record is missing or wrong (problem).** Bounces come back through this record. Without it bounces can be lost and dead addresses stay on your list. Fix: add the record shown.

### DMARC

**No DMARC record, or the policy is "none" (problem).** Gmail and Yahoo require a DMARC record from anyone who sends newsletters, and Swarm will not send from a domain without an enforced one. Fix: publish the TXT record that **Sending → Domains** shows for `_dmarc.<your domain>`. If you already have one with `p=none`, change that part to `p=quarantine`. If other tools send email as the same domain (office mail, a shop, a help desk), make sure they sign with DKIM first, or their mail will start going to spam.

**More than one DMARC record (problem).** Providers ignore both. Fix: delete all but one.

**A share of mail sent as your domain fails DMARC (warning under 98% passing, problem under 90%).** Counted once reports cover at least 100 messages in 30 days. Either another tool sends as your domain without being set up for it, or someone is faking your address. Fix: scroll to **DMARC reports → Sources with problems** on the same page. A source you recognise needs DKIM set up in that tool. A source you do not recognise is an impostor, and your DMARC policy is already dealing with it.

**No DMARC reports have arrived, or they stopped (warning).** Shown only once your domain has been verified for a week and you have sent at least 100 emails to Gmail, Outlook or Yahoo. Your email still goes out. Without reports Swarm cannot warn you when authentication breaks. Fix: make sure the DMARC record is the one Swarm shows, including the `rua=mailto:...` part. Reports arrive a day or two after a send.

### Reputation: bounces, complaints, providers

All of these read the last 30 days and need at least 100 emails sent. With fewer, the check-up says "Not enough sending yet" rather than showing a rate that would mean nothing.

**Bounce rate (warning from 1%, problem above 2%).** A bounce is an email that could not be delivered. A high rate tells providers your list is old, bought or scraped. Above 2% Swarm also pauses your warm-up. Hard bounces and blocks count, soft bounces do not (see [Bounces](#bounces)). Swarm stops mailing addresses that bounce by your bounce rules, so you do not need to remove them. Fix: look at where recent subscribers came from, send to imported lists in small parts, and turn on double opt-in.

**Complaint rate (warning from 0.1%, problem from 0.3%).** A complaint is a reader pressing "spam". These are the limits Gmail and Yahoo publish: stay under 0.1%, and never reach 0.3%. A single complaint is never counted as a trend, because on a small list one person can move the rate a long way. People who complain are blocked from future sends automatically. Fix: send only to people who asked for it, say at the top of the email who you are, and turn on inactive-reader cleanup.

One honest limit: **Gmail does not tell senders about individual complaints.** The rate Swarm shows comes from the providers that do (Yahoo, Outlook and others). For Gmail readers the real figure is only in Google Postmaster Tools (see below).

**A mailbox provider is refusing your emails (warning from 0.5% of what you sent there, problem above 2%).** Shown when Gmail, Outlook, Yahoo or iCloud refused at least 3 of your emails in 30 days because of you as the sender, not the address: your domain's reputation there, SPF, DKIM or DMARC, a blocklist, or what the emails contained. Swarm keeps those subscribers, because it is not their fault, but the refusals count towards your bounce rate and can pause your warm-up. Fix: fix the authentication and complaint findings first. Then open a subscriber whose email was refused: the **Bounces** part of their page shows what the provider said, which usually names the reason and links to the provider's help for senders. Sign up for the provider's own tool (Google Postmaster Tools, Microsoft SNDS, Yahoo Sender Hub, see below), and for a few sends mail only your most engaged readers there.

**One provider's readers open far less than everyone else (warning).** If, say, Outlook readers open at less than half the rate of everyone else, Outlook is probably putting you in the spam folder. Swarm cannot see inside a mailbox, so this gap is the best sign available. It needs at least 200 delivered emails at that provider and 200 elsewhere. iCloud is left out of the comparison, because Apple's privacy protection hides most real opens. Fix: send a test to your own address at that provider, sign up for the provider's own tool, and for a few sends mail only your most engaged readers there.

### Warm-up

**Warm-up is paused (problem).** Nothing is being sent. Swarm pauses on its own when bounces or complaints jump, because continuing would do more damage. Fix the cause first (see the bounce and complaint findings), then resume under **Sending → Warm-up**.

**Warm-up is in progress (good).** A new domain has no reputation, so Swarm raises the daily limit step by step. A send larger than today's limit is spread over the following days. That is expected.

See [warm-up.md](warm-up.md) for how warm-up works, what a pause means, and how to resume.

### Your list

**Double opt-in is off, or a signup form skips it (warning).** Without a confirmation email, anyone can type any address into a form: typos, fake addresses, bots. Those bounce or complain. Fix: turn on "Double opt-in" in the publication settings, and set each form named in the finding back to the publication default under **Signup forms**.

**A large share of subscribers have not opened in 180 days (warning from 30%).** Counted among subscribers who have been sent at least five emails, once there are 100 of them. Providers watch how many people ignore you, and abandoned addresses can become spam traps. Fix: send those readers one "do you still want this?" email, then turn on inactive-reader cleanup.

**Inactive-reader cleanup is off (warning).** Fix: under **Sending → Inactive readers**, choose how long someone may go without opening before they are unsubscribed. Six months to a year suits most newsletters. Paying subscribers are never removed.

**Inactive-reader cleanup needs open tracking (unknown).** The publication has **Open tracking** or **Reader profiles** off, so Swarm can't tell who stopped reading and the cleanup doesn't run. The share of silent subscribers isn't checked either. Fix: every few months, send one "do you still want this?" email and remove what bounces, or, once your readers have agreed to it, turn tracking on. See [Tracking and retention](privacy-controls.md).

**You recently imported a large list (warning, for 14 days).** Shown for an import of at least 500 addresses that is also at least a fifth of your list. A sudden jump in volume to people who have never heard from your domain is the most common reason a healthy sender lands in spam. Fix: send to part of the import first, introduce yourself, and watch bounces after each send.

**No postal address in the footer (warning).** Anti-spam laws such as CAN-SPAM in the United States require a postal address in every newsletter. A PO box or business address is enough. Fix: under **Sending → Email design**, put the address in the "Footer" field. Swarm cannot tell whether your footer line is an address, so when one is present the check-up only reminds you to make sure.

### Blocklists

A blocklist is a public list of domains that have been seen in spam. Many mail servers consult them.

**Your domain is listed (problem).** The finding links to that list's own lookup page, which says why. Fix the cause first (usually complaints, a hacked website on the domain, or harmful links), then use the removal request on that page. Do not send large emails while listed.

**Could not check (couldn't check).** This is common, and it is not a bad sign. The main lists (Spamhaus, SURBL, URIBL) refuse automatic questions that arrive through shared DNS services, which is how Swarm has to ask. Swarm never guesses: it reports "not listed" only when the list has proved it is answering. Use the links in the finding to look your domain up by hand. It takes a few seconds, and "not listed" there means all is well.

## Bounces

When an email cannot be delivered, the receiving server sends back a reason. Swarm sorts every bounce into one of three kinds and reacts by the rules under **Sending & delivery > Bounces**. The rules cover every publication in the workspace, and only the workspace's owners and admins can change them.

| Kind        | What it means                                             | Examples                                                                                                                         | What Swarm does by default                   |
| ----------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Hard bounce | The address will never work                               | The mailbox or the domain does not exist; your email service refuses the address because it hard-bounced before                  | Stops mailing it at the first one            |
| Soft bounce | The address may work later                                | A full mailbox, a mailbox switched off for now, an email too large, a server that asks to try again later                        | Stops after 3 emails in a row bounced softly |
| Blocked     | The receiving server refused because of you as the sender | Your domain or sending server is on a blocklist, the email failed SPF, DKIM or DMARC, it looked like spam, too much mail at once | Never stops mailing the subscriber           |

Swarm reads the reason from what your email service passes on: its own bounce type and the receiving server's status code and message (a code like 5.1.1 means "no such mailbox", 4.2.2 "mailbox full", 5.7.1 "refused by policy"). When the signs disagree, Swarm calls the bounce soft rather than hard, so nobody is dropped on a guess. An out-of-office reply is not a bounce and is ignored.

### Your choices

- **Hard bounces.** **Stop mailing at the first hard bounce** is recommended. Mailbox providers judge senders by how many hard bounces they cause, so mailing a dead address again hurts delivery for the rest of your list. **Stop after 2 hard bounces within 30 days** is only for a list where your email service sometimes reports a working address as dead. Amazon SES, Resend, Mailgun and Postmark stop sending to an address after its first hard bounce by themselves, so the second try usually comes straight back from them; the choice mostly matters when your install sends through its own mail server.
- **Soft bounces.** **Stop after N emails in a row bounced softly** (2 to 10, 3 recommended). A delivered email starts the count again, so this works the same for a daily newsletter and a monthly one. **Stop after N soft bounces within D days** counts every soft bounce in that time, even with delivered emails in between. Before bounce rules, Swarm only had "3 soft bounces in 7 days", which a weekly or monthly newsletter can never reach: a mailbox that was full for good stayed on the list for ever. You can use either rule, both, or neither. With neither, Swarm never stops mailing an address for soft bounces, and those addresses keep raising your bounce rate.
- **Blocks** are not a choice. Swarm never stops mailing a subscriber because a server refused you; the fix is on your side. Blocks count towards your bounce rate and the warm-up pause, and the check-up tells you when one mailbox provider is refusing you.
- **Spam complaints** are not a choice either: the first complaint always stops mailing that address. Mailing someone who reported you as spam goes against the law in many countries and hurts your reputation more than anything else.
- **Ask me before stopping a subscriber on a paid plan** is on by default. Instead of stopping a reader who pays (or was given a paid plan), Swarm lists them under **Needs your attention** on the same page and emails the workspace's owners and admins once. They keep getting your emails until you choose **Keep mailing** (the bounce counts start again) or **Stop mailing**. Quietly stopping the emails someone pays for is worse than one more bounce. Check the address with them first: a full mailbox or a new job is common.

### Changing the rules

When you change a rule, Swarm counts how many subscribers the new rules would stop, from the last 90 days of bounces: "With these rules, 14 subscribers would be stopped". Saving applies the new rules from each address's next bounce. Tick **Apply to past bounces too** before **Save bounce rules** to stop those subscribers at once.

### What "stopped" means

The subscriber becomes **Bounced** in every publication of the workspace, and the address appears under **Blocked addresses** with the reason, what the receiving server said and the date. The subscriber's page (**Subscribers**, click the address) shows the same under **Bounces**, with their recent bounces. If the reader fixes their address, remove it from **Blocked addresses** and confirm **Mail again**: their subscriptions get back the status they had, and the counts start again from zero.

## Advice before you send

When you open **Check & send** on a post, the checklist shows what must be fixed before sending (red) and, below it, **Inbox advice**. Advice never blocks a send. It points out things in this particular email that spam filters and readers hold against a message:

| Advice                            | When it appears                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| Subject in capitals               | At least 10 letters, and 80% or more of them capitals                                        |
| Repeated punctuation              | `!!!`, `???`, `$$$` (three in a row), or four exclamation marks anywhere in the subject      |
| Very long subject                 | More than 90 characters (inboxes show about 60)                                              |
| Subject says almost nothing       | Fewer than three letters or digits, or a placeholder such as "Untitled" or "test"            |
| No preview text                   | The preview text field is empty                                                              |
| Spam phrases                      | Three or more different phrases such as "act now", "free gift", "risk free". One is harmless |
| Public link shortener             | A link through bit.ly, tinyurl.com and similar. Your own short-link domain is never flagged  |
| Link text does not match the link | The visible text is a web address on one site, but the link opens another                    |
| Very many links                   | More than 60 different links                                                                 |
| Link to a bare IP address         | For example `http://203.0.113.9/...`                                                         |
| Insecure link                     | A link that starts with `http://` instead of `https://`                                      |
| Mostly images                     | At least one image and fewer than 20 words of text                                           |
| One huge image                    | An image file over 1 MB                                                                      |

The limits are deliberately loose. An ordinary newsletter should see no advice at all. If you see some and you have a reason for what you wrote, send anyway.

The same checklist also warns when the email is over 102 KB (Gmail cuts it off) and when an image has no description.

## Troubleshooting

### "My emails land in spam"

1. Run the check-up. Fix everything under **Fix these first**, top to bottom. Authentication problems (domain, DKIM, DMARC) come first because nothing else helps until they are fixed.
2. Look at the complaint and bounce findings. If either is a warning or a problem, the cause is your list, not your setup. Think about who was added recently.
3. Check the blocklist finding. If it says "Couldn't check", follow its links and look your domain up by hand.
4. Open the post's **Check & send** and read the Inbox advice.
5. Send yourself a test at Gmail, Outlook and Yahoo. If only one of them files it as spam, continue with the section for that provider below.
6. If everything is clean and it is still spam, your domain's reputation is low. Reputation only recovers through engagement: for the next few sends, mail only people who opened recently (make a segment), keep a steady schedule, and widen the audience slowly.

### "Only Gmail"

- Sign up for **Google Postmaster Tools** and add your sending domain. Look at the spam rate first. Above 0.1% is a warning; at 0.3% Gmail stops trusting you.
- Gmail weighs engagement heavily. Mail your most engaged Gmail readers only for a few sends.
- Gmail's Promotions tab is not spam. Email there was delivered to the inbox, in a different tab, and no setting moves it.
- Make sure DMARC passes: the check-up's alignment finding should be good.

### "Only Outlook" (Outlook.com, Hotmail, Live)

- Outlook leans on blocklists and on its own complaint data. Check the blocklist finding by hand.
- **Microsoft SNDS** shows data per sending IP address. It is only useful if you have a dedicated IP (see **Deliverability → Dedicated sending**). On shared IPs, ask your email service instead.
- If your mail is being refused outright with a message naming Microsoft, the bounce message itself usually includes a link to their sender support form. Ask whoever runs your Swarm for the bounce message from your email service.

### "Bounces are high"

- Swarm already stops mailing addresses that bounce, by your [bounce rules](#bounces). You do not need to delete them.
- The cause is almost always where addresses came from: an old list, an import, or forms without double opt-in.
- Turn on double opt-in. For an imported list, send in small parts and stop if bounces pass 2%.
- If nearly everything bounces at once with the same message, it is not your list. It is a block. Check the blocklist finding and the "refusing your emails" finding, and open one of the subscribers concerned: the **Bounces** part of their page shows what the receiving server said, which names who refused the email and why.

### "I got a complaint-rate pause"

Swarm paused your warm-up because too many readers pressed "spam" in one day. It did this to protect you: carrying on would have made things worse.

1. Do not simply resume. Find out which send caused it and who received it.
2. If that send went to imported or newly added people, remove them from future sends or ask them to confirm again.
3. Make it obvious at the top of the email who you are and why they are hearing from you.
4. Resume under **Sending → Warm-up** and send next to your engaged readers only. See [warm-up.md](warm-up.md).

## SPF, DKIM and DMARC in a paragraph each

**SPF** is a DNS record that lists which servers may send email for a domain. When your email arrives, the receiving server checks that it came from a server on the list. In Swarm the SPF record sits on a subdomain used for bounces (the "return path"), which is why the check-up calls it "SPF (return path)". SPF breaks when email is forwarded, so it is never enough on its own.

**DKIM** is a signature. Your email service signs every message with a private key, and a DNS record on your domain publishes the matching public key. The receiving server uses it to confirm that the message really comes from your domain and was not changed on the way. DKIM survives forwarding. It is the one that matters most.

**DMARC** ties the two to the address readers actually see. It is a DNS record at `_dmarc.<your domain>` that says: "if a message claims to be from my domain and passes neither SPF nor DKIM for my domain, do this with it" (`none`: nothing, `quarantine`: send to spam, `reject`: refuse). It also asks providers to send you daily reports, which is where Swarm's DMARC numbers come from. Swarm requires `quarantine` or `reject`.

## The Gmail and Yahoo rules for bulk senders

Since 2024, Gmail and Yahoo require the following from anyone who sends newsletters, most strictly above 5,000 emails a day:

- **Authentication.** SPF and DKIM set up, and a DMARC record on the From domain, with the From domain matching the domain that signed the message. The check-up verifies all of this.
- **One-click unsubscribe.** A machine-readable unsubscribe header so the mail app can show its own "Unsubscribe" button, honoured within two days. **Swarm adds this to every newsletter automatically** and unsubscribes the reader at once. You do not need to do anything.
- **A visible unsubscribe link** in the email. Swarm puts one in every footer.
- **A complaint rate under 0.3%**, and ideally under 0.1%. The check-up tracks this.

## What Swarm does for you automatically

- Signs every email with DKIM and sets the return path, once your domain's records are published.
- Adds the one-click unsubscribe header and a footer unsubscribe link to every newsletter.
- Stops mailing addresses that bounce, by the [bounce rules](#bounces) you choose (by default the first hard bounce, or 3 emails in a row that bounced softly), and addresses that complain. Subscribers on a paid plan are listed for you to decide instead.
- Warms up a new domain by raising its daily limit gradually, and pauses on its own when bounces or complaints jump.
- Leaves out privacy-proxy and scanner opens, so open rates reflect people.
- Collects DMARC reports and shows who is sending as your domain.
- Unsubscribes long-inactive readers, if you turn that on.
- Checks every email against the pre-send checklist.

What Swarm cannot do: see inside anyone's mailbox, see Gmail's complaint data, or change how a mailbox provider rates your domain. Only your readers' behaviour does that.

## Tools outside Swarm, and their limits

**Google Postmaster Tools** (postmaster.google.com). Free. Shows how Gmail sees your domain: spam complaint rate, authentication results, delivery errors. It is the only place to see Gmail complaints. Limits: you must prove you own the domain with a DNS record, it shows nothing until you send a few hundred emails a day to Gmail, and the data is a day or two old.

**Microsoft SNDS** (Smart Network Data Services). Free. Shows complaint and spam-trap data for Outlook.com, Hotmail and Live. Limits: it works per IP address, not per domain, so it only helps with a dedicated IP that you can prove you control. On shared sending it shows you nothing.

**Yahoo Sender Hub** (senders.yahooinc.com). Free. Lets you register for Yahoo's complaint feedback and read their requirements. Limits: less detail than Google's tool.

**Seed tests** ("mail-tester" style tools). You send your email to an address the tool gives you and get a score with a list of technical findings. Useful for catching a broken DKIM signature, a missing record, or content a common filter dislikes. Limits: a test score is not inbox placement. These tools run generic filters, and cannot know how Gmail or Outlook rate your particular domain with your particular readers. A perfect score with a poor reputation still lands in spam, and the reverse. Use them to find mistakes, not to predict the inbox.

**Blocklist lookups.** Each list has its own lookup page, linked from the check-up's blocklist finding. Use the list's own page rather than a third-party "check 100 blocklists" site: most of the lists on those sites are used by nobody, and a listing on an obscure one is not worth worrying about.
