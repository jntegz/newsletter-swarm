# Warm-up

Warm-up is how a new sending domain earns the trust of mailbox providers. This page explains what it is, what Swarm does for you, the choices you have, and what to do when sending pauses. You find it in the dashboard under **Sending & delivery**, in the **Warm-up** section.

The last part of the page is for developers and people running their own instance.

## What warm-up is

Mailbox providers such as Gmail, Outlook and Yahoo are wary of a domain they have never seen send email. If a new domain sends thousands of emails on its first day, it looks like a spammer. The emails land in spam, or are refused.

The way around this is to start small and send a little more each day. Providers watch how people react: do they open, do the emails bounce, does anyone press "report spam". After a couple of weeks of good days, they know you, and your emails reach the inbox.

Swarm does this for you. You write and send as usual.

## What Swarm does

- **A daily limit per sending domain.** A new domain may send 200 emails on its first day. The limit resets at 00:00 UTC.
- **The limit grows after a good day.** A good day is one where bounces and spam complaints stayed low and you used at least half of the limit. At the Standard pace the limit grows by half each time: 200, 300, 450, 675, 1,013, 1,520 and so on.
- **The rest goes out over the following days.** When a post goes to more people than today's limit, Swarm sends as many as the limit allows and keeps the rest for tomorrow, and the day after if needed. Nobody is skipped, nobody gets the email twice, and you do not need to send again.
- **Engaged readers first.** The emails that fit in today's limit go to the readers most likely to open: people who opened or clicked in the last 90 days first, then readers Swarm knows little about, then readers who have gone quiet. Opens from the first group build trust fastest.
- **An automatic pause.** If more than 2% of the emails from the last day bounce, or more than 0.08% are marked as spam, Swarm pauses sending from that domain. This is only judged once at least 100 emails have gone out, so one bounce in ten does not stop you.
- **An email when it pauses.** The publication's owners and admins get an email with the domain and the reason.

## The paces

You choose how fast the limit grows. Open **Change pace** on the domain's card.

| Pace     | First day | Growth after a good day | Good for                                                      |
| -------- | --------- | ----------------------- | ------------------------------------------------------------- |
| Careful  | 50        | 25%                     | A brand-new domain, or a list you have not emailed in a while |
| Standard | 200       | 50%                     | Most publications. Every domain starts here.                  |
| Fast     | 500       | 100%                    | A list that opens your emails often                           |
| Custom   | you set   | you set                 | When you know what your domain can take                       |

With Custom, the first day can be from 10 to 100,000 emails and the growth from 5% to 200%.

A faster pace reaches your whole list sooner, and a problem with your list shows up sooner too. A slower pace gives providers more time. If you are not sure, keep Standard.

**Changing pace in the middle of warm-up never lowers today's limit.** If your limit has already grown to 1,520 and you switch to Careful, it stays at 1,520 and grows by 25% from there. If you pick a pace whose first day is higher than today's limit, the limit goes up at once. On the very first day, before the limit has grown, the new pace's first day applies, but never less than what you already sent today.

The shared domain has its own, slower paces, because every publication on the instance shares its reputation:

| Pace     | First day | Growth after a good day |
| -------- | --------- | ----------------------- |
| Careful  | 50        | 20%                     |
| Standard | 100       | 30%                     |
| Fast     | 200       | 50%                     |

On the shared domain a custom first day can be at most 500 and the growth at most 50%.

## The plan

Under each domain the dashboard shows the plan from today: the limit for each coming day, and how many of your subscribers a post sent to everyone today will have reached by the end of that day. It also tells you:

- the date **your whole list fits in one day**, which is the day warm-up stops holding anything back for a list your size;
- the date **a post sent today finishes going out**.

The plan is made for how often you send. Under **How often do you send?** choose **Every day**, **A few times a week** or **Once a week**. It starts at once a week, the usual newsletter. The choice is kept in your browser and only changes the dates you are shown, not what Swarm sends.

The plan assumes you send a post to your whole list today and again at that rhythm, and that every day goes well. See [How to warm up well](#how-to-warm-up-well) for why the rhythm matters and what a weekly newsletter can expect.

The steps on the card show where the domain is:

1. **Domain verified.** Your DNS records are in place.
2. **Pace chosen.** Standard, unless you changed it.
3. **Warming up.** Which day you are on, and how much of today's limit is used.
4. **Whole list in one day.** The date from the plan, or done.
5. **Complete.** The limit has reached its ceiling and is switched off.

For most publications step 4 is the one that counts. The ceiling of a domain of your own is 1,000,000 emails a day. A smaller list never gets there, because the limit only grows on days when half of it is used: it stops growing once it is more than twice your list. That is fine: once the limit is above your list size, nothing is held back.

## The install's shared domain

Every Swarm install has one shared sending domain. A publication that has not added a sending domain of its own sends from it, and so does a fresh install's first publication. On a hosted Swarm with many publications, they all share its reputation. On your own install, it is simply your domain.

Warm-up on the shared domain is more cautious: it starts at 100 emails a day, grows 30% after a good day, and **ends when the daily limit reaches 5,000**. That takes 16 good days. After that, warm-up is complete and nothing is held back. For a list of a few thousand that is all you need. For a larger list it means the step from 5,000 a day to the whole list happens in one go, without the gradual build-up.

There are two ways past the 5,000 ceiling:

1. **Add your own sending domain to the publication** (Domains, on the same page). It gets a warm-up of its own with a ceiling of 1,000,000 a day, readers see your name in the address, and its reputation is yours alone. This is the right choice for most publications, and the only one for people who are not instance admins.
2. **If you are an instance admin** (the person who installed Swarm, or someone they named in Settings), the Warm-up card for the shared domain shows two extra controls, because on your install the domain's reputation is yours:
   - **Raise the ceiling.** Set it to at least your list size. The limit then keeps growing step by step until one day covers everyone.
   - **My domain already sends this much mail.** Skips warm-up on the shared domain, as described below.

   An instance admin can also set a custom pace on the shared domain with the same range as on a domain of their own. Each of these is recorded in the audit log as an instance admin override. The ceiling is set per publication.

Publication owners and admins who are not instance admins can change the pace within the shared domain's range and lower the ceiling, but cannot raise it above 5,000 or skip.

## How to warm up well

The same checklist is on the Warm-up section in the dashboard.

1. **Keep a rhythm.** The limit grows after a day that used at least half of it. A post larger than the limit keeps going out day after day, and each of those days counts, so one post to your whole list carries warm-up forward for several days. Days with no send do no harm: the limit stays where it is and never goes down. It just does not grow.
2. **Send to your whole list. Swarm picks who goes first.** Each post goes to readers who opened or clicked in the last 90 days first, then to new readers and readers Swarm knows little about, then to readers who have gone quiet. You do not need to build a segment for this. Sending only to a small segment uses less of the limit, so the limit grows more slowly.
3. **Clean the list before the first big send.** Leave out addresses you have not emailed in a long time. An import already skips addresses that bounced or complained before, role addresses such as info@ and throwaway mailboxes.
4. **Turn on double opt-in.** People confirm by email before they become subscribers, so mistyped and made-up addresses never get a post. It is in Publication settings.
5. **Do not import an old list in the middle of warm-up.** Old addresses bounce, and bounces pause sending. Wait until your list fits in one day, or import it in parts. The import review tells you what an import does to your next posts before you confirm it.
6. **If sending pauses, fix the cause first.** See [When sending pauses](#when-sending-pauses). The pause looks at the last 24 hours, so if you resume without a fix, the next bounce or complaint can pause it again.
7. **Skip only for a domain that already sends this much.** See [Skipping warm-up](#skipping-warm-up).

### What a weekly newsletter can expect

Take a new domain of your own, the Standard pace and 5,000 subscribers, with one post a week to everyone.

| Day    | What happens                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1      | You send the first post. 200 readers get it.                                                                                               |
| 2 to 6 | The same post keeps going out: 300, 450, 675, 1,013 and 1,520 more. Each of these days uses the whole limit, so the limit grows every day. |
| 7      | The last 842 readers get it. The limit is 2,280, and 842 is less than half of that, so the limit stays at 2,280.                           |
| 8      | You send the second post. 2,280 readers get it.                                                                                            |
| 9      | The other 2,720 get it. The limit that day is 3,420, more than half is used, so it grows to 5,130.                                         |
| 15     | You send the third post. The limit is above your list, so all 5,000 get it that day. From here on warm-up holds nothing back.              |

So the first post takes a week to reach everyone, the second takes two days, and the third goes out in one. A publication that fills the limit every day would have a limit above 5,000 on day 9. For the weekly newsletter it is day 10, and the first post that uses it goes out on day 15.

The limit then grows twice more, after the third and fourth posts, to 11,543. After that a post of 5,000 is less than half of the limit, and the limit stays there. It never reaches the ceiling of 1,000,000 and the card never says Complete. Nothing is held back all the same.

The difference is larger on the shared domain, which starts at 100 and grows 30%. A list of 1,000 fits in one day on day 10 when the limit is filled every day, and on day 23 for a weekly newsletter. A list of 5,000 reaches the end of warm-up there on day 16, or on day 23 when sending weekly.

Two things follow:

- A date on the plan is for the rhythm you chose. Choose yours and the dates are the ones you will see, as long as each post goes to the whole list and every day goes well.
- A post bigger than the limit is not a problem to solve. It is what moves warm-up forward. Do not split it or send it again.

## When sending pauses

A pause means bounces or spam complaints went over the limit. The card says which, with the numbers. Posts that were going out wait where they are. When you resume, they carry on, and nobody gets an email twice.

Before you resume, find the cause:

1. Open **Deliverability** and look at which send the bounces or complaints came from.
2. If they came from an import or an old list, remove those subscribers. Addresses that bounced are already blocked, so they will not be tried again.
3. If complaints are the problem, ask whether those readers expected your email. A list collected somewhere else, or long ago, is the usual cause.
4. Press **Resume sending**. Warm-up carries on at the limit it had. It does not start over.

If you resume without fixing the cause, the next send will most likely pause again, and each bad day costs trust with mailbox providers.

Owners and admins can also pause by hand with **Pause sending**, for example while cleaning up a list. A pause by hand is always theirs to resume. Pausing a domain that is already paused changes nothing: the reason it paused stays, and so does the email about it.

On the shared domain, a pause Swarm made itself (over bounces or complaints) can only be resumed by an instance admin, because every publication on the install sends from that domain. Publication owners and admins see the reason and are asked to contact an instance admin.

## Skipping warm-up

If your domain already sends email regularly from another service, mailbox providers know it and warm-up is not needed. An owner or admin can choose **My domain already sends this much mail** on the domain's card.

Swarm asks how many emails the domain sends on a normal day and asks you to confirm. Skipping is recorded in the audit log with your name and the number you gave.

- If the number is lower than your list, Swarm suggests a safer choice: keep warming up, starting from the volume the domain already sends. One click does that.
- After skipping, nothing limits how much the domain sends in a day, and Swarm no longer pauses on its own when bounces or complaints spike. Watch the Deliverability page yourself.
- On the shared domain only an instance admin can skip, because its reputation may belong to every publication on the install. See [The install's shared domain](#the-installs-shared-domain).

Do not skip for a domain that is new to sending. It is the quickest way to land in spam, and recovering takes longer than warming up would have.

**Start warm-up again** undoes a skip, and also restarts a warm-up that finished. Use it after a long break from sending, or when emails have started landing in spam. The limit goes back to the first day of the pace you choose. Emails already sent today count towards today's limit.

## Questions

**Why did only 200 people get my email?**
Your domain is on its first day of warm-up and the limit is 200. The other readers get the same post over the following days, without you doing anything. The send panel says this before you send, with the day the send finishes, and the send report says it while the post is going out.

**Where does the dashboard tell me about warm-up?**
On Home while a domain is warming up or paused, under a sending domain once it is verified, on the import review when an import changes how your next posts go out, in the send panel before you confirm, and on the send report of a post that is still going out. Each of them links to the Warm-up section.

**Can I choose who gets the email first?**
Swarm sends to engaged readers first. If you want more control, send to a segment.

**The limit did not grow today. Why?**
The limit grows only after a day when at least half of it was used and bounces and complaints stayed low. If nothing went out yesterday, or only a few emails did, it stays where it was. It never goes down.

**I imported a large list and warm-up started again. Why?**
An import that adds 10,000 or more new subscribers puts a finished warm-up back to warming (a warm-up that is still going is left as it is), so the new addresses are introduced gradually. Today's limit is set to the number of subscribers you had before the import, so your existing readers keep getting every post. The limit then grows at your pace until it covers the whole list.

**I changed my email service and warm-up started again. Why?**
When an instance moves to a different email service, the sending history with the old service does not carry over, so every domain warms up again from its first day.

**Is this the same as warming up a dedicated IP address?**
No. This page is about your domain's reputation. A dedicated IP address has its own warm-up, which the email service runs and the Deliverability page reports. A domain can be fully warmed up while a new dedicated IP is still warming, and the other way round.

**Do test emails and sign-in emails count?**
No. The limit applies to posts and automation emails sent to your subscribers.

**I send from two domains. Do they share a limit?**
No. Each sending domain has its own warm-up, and so does the shared domain.

**What time does the limit reset?**
At 00:00 UTC. The Warm-up card shows that in your own time.

**How does warm-up combine with the sending limits under Settings > Instance?**
They are two different limits and both apply. The sending limits are what your email service allows the whole Swarm, counted for every email together; warm-up is each sending domain's own daily limit while it builds a reputation. Each day the lower of the two decides how many of a post go out, and the rest go out on later days. See [Sending limits](self-hosting.md#sending-limits).

## For developers and instance owners

Internally warm-up is the Reputation Ramp. The names below are the ones used in the code, the database and the API.

- **Engine:** `packages/engine/src/ramp.ts`. `reserve()` hands out today's allowance atomically; `rollover()` moves a ramp to a new UTC day and grows the cap by `growth` (rounded up, held at `max_cap`) when the last day was healthy and `sent_today >= cap_today / 2`; `checkRampHealth()` pauses on the thresholds over the last 24 hours once 100 emails were sent. Recipients over the cap wait for the next UTC day (`packages/engine/src/pipeline.ts`). `updateRamp()`, `skipRamp()` and `restartRamp()` are the three writes behind the routes below.
- **Paces and the plan:** `packages/domain/src/warmup.ts`. `RAMP_PACES` and `RAMP_BOUNDS` hold the numbers in the tables above. `projectWarmup()` is a pure function that returns the plan: at most 60 days are listed, and dates are looked for up to 730 days ahead (`null` beyond that). Without its last argument it assumes every day uses at least half of the cap, the fastest a ramp can go; this is the `plan` the API returns. With `sendEveryDays` (`WARMUP_CADENCES`: 1, 2 or 7) it follows a publication that sends one post to its whole audience today and every that many days: what does not fit waits for the next day, and the cap grows only after a day that used half of it. The dashboard calls it this way for the rhythm the teammate chose, and `workers/api/tests/warmup.test.ts` checks it against `reserve()` day by day. `rampCapAfterPaceChange()` mirrors the SQL rule in `updateRamp()` so the dashboard can preview a pace.
- **Defaults:** a domain of the Channel's own starts at 200 a day, grows 1.5 times, with a ceiling of 1,000,000. The shared platform domain starts at 100, grows 1.3 times, with a ceiling of 5,000. Thresholds: 2% bounces, 0.08% complaints.
- **Tables:** `reputation_ramps` and `reputation_ramp_days` (`migrations/0003_dispatch_send.sql`); `skipped_at` and `started_day` (`migrations/0062_warmup_plan.sql`); `paused_by` (`migrations/0069_review_fixes.sql`).
- **Who paused it:** `paused_by` is `system` when the ramp paused itself (`checkRampHealth()`, or `rollover()` judging the last day) and `person` when someone paused it with `PATCH … { "status": "paused" }`; null when not paused. It is the only thing the resume check reads: `paused_reason` is free text for people. `updateRamp()` changes the status, reason, `paused_by` and `pause_notice` only on a real change (warming to paused, or paused to warming), so a pause of a paused ramp is a no-op. For a caller who may not resume a `system` pause, the condition is in the `UPDATE`'s `WHERE` (`RampUpdateGuard`), so a pause that happens between the route's read and its write still answers 403. `rollover()` writes the status it judged only if the stored status is still the one it read, so a pause or resume made meanwhile stands. `0069` set `paused_by` on ramps already paused: `person` where the reason is "Paused by a teammate." or the older "Paused by an operator.", `system` otherwise.
- **Complete** means the cap reached `max_cap`. A complete ramp grants every reservation and is no longer judged by `checkRampHealth()`.

### API

| Route                                 | Role   | What it does                                                                                                                                                          |
| ------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/channels/{id}/ramps`     | viewer | Every ramp of the Channel, each with `kind`, `pace`, `skipped`, `startedDay`, `sharedOverride` and `plan`                                                             |
| `PATCH /api/v1/ramps/{rampId}`        | admin  | `pace` (careful, standard, fast), or `startCap` and `growth`; also `maxCap`, the thresholds and `status` to pause or resume                                           |
| `POST /api/v1/ramps/{rampId}/skip`    | admin  | Body `{ "confirm": true, "dailyVolume": 40000 }`. Marks the ramp complete. On the shared domain only for an instance admin (403 otherwise). 409 when already complete |
| `POST /api/v1/ramps/{rampId}/restart` | admin  | Body `{ "confirm": true, "pace": "careful" }` (`pace` optional). 409 unless the ramp is complete                                                                      |

`plan` is made for the Channel's active Members at the time of the request: `audience`, `today`, `days` (`day`, `cap`, `reach`), `fullListDay`, `sendDoneDay`, `completeDay`, `assumesResume` (true for a paused ramp) and `truncated`.

`sharedOverride` is true on the shared domain's ramp when the caller is in `instance_admins`. With it, `PATCH` accepts a `maxCap` above 5,000 (`SHARED_RAMP_MAX_CAP`) and the `startCap` and `growth` bounds of a custom domain, higher pause thresholds, resuming a ramp with `pausedBy: "system"`, and `skip`. Without it, a `maxCap` above 5,000, looser thresholds or `{ "status": "warming" }` on a `system` pause of the shared ramp answer 403. Each ramp carries `pausedBy` (`system`, `person` or null) next to `pausedReason`; the dashboard decides from `pausedBy` whether a pause was made by hand. The caller still needs the admin role in the Channel. The audit entry carries `instanceAdminOverride: true` whenever the override was what let the change through.

A Channel the caller cannot see answers 404. Audit actions: `ramp.updated` (with the pace before and after), `ramp.skipped` (with `dailyVolume`, the status and cap before, and the audience), `ramp.restarted`, next to the existing `ramp.paused` and `ramp.pause_notified`.

### Things to know

- A restart raises `max_cap` to at least the number of active Members, so the ramp cannot complete before the cap covers the list.
- A warm import (`startWarmImport` in `packages/engine/src/members.ts`) and a change of email service (`REWARM_SQL` in `packages/mail/src/service-change.ts`) also put complete ramps back to warming, clear a skip and start the day count over.
- Days are UTC days everywhere.
- `rollover()` runs when something is reserved, not on a timer, and judges only the last day the ramp was used. So a quiet week costs nothing: the cap grows once for the last used day if that day used half of it, and stays there.
- The notes about warm-up on Home, the import review, the send panel and the send report are worked out in `apps/dashboard/src/send/warmup-notes.ts` from `GET /ramps`. The API is unchanged.
