# Setting up Swarm: a guide

This guide is for the browser setup page. It covers what to expect, what can go wrong, and how to get back in if you ever lose access.

## What you'll choose

- **Your dashboard's address.** Where you sign in and write. It's `app.yourdomain.com` unless you pick another subdomain.
- **Where readers find your publication.**
  - **Your main domain** (the default): `yourdomain.com` becomes your newsletter's landing page, with its past posts. This replaces anything the domain shows today. Email on the domain, such as `you@yourdomain.com`, isn't affected.
  - **A subdomain**, such as `news.yourdomain.com`: use this if your main domain already has a website you want to keep.

Swarm also adds a few subdomains it needs: `forms`, `link`, `media`, `events`, `mail`, `unsubscribe` and `dmarc`. It never changes your main domain's email records.

## Before anything is installed

The page opens the release and shows its **version**, its **manifest SHA-256** and its **signing key** id. Nothing has changed on your Cloudflare account yet. Compare them with what the Swarm project lists in SECURITY.md in its repository (not with anything on the release's own site), tick the box and choose **Install this release**. The install keeps to exactly that release from then on; if `RELEASE_URL` later serves anything else, it stops.

The page also says whether the signing key is one the Swarm project publishes. If it says it doesn't know the key, install only if you took `RELEASE_PUBLIC_KEY` from the project yourself and the key id matches.

If the page says `RELEASE_MIN_VERSION is not set`, set it to the release you mean to install (the current one in SECURITY.md) and deploy the `swarm-setup` Worker again.

## After the install

1. **Save your recovery kit** when the page asks. See [Your recovery kit](#your-recovery-kit). The page hands it over at most 3 times, so keep the first copy that downloads.
   The one-time sign-in link appears once, on the last screen; the page doesn't keep it. If you lose it, sign in at your dashboard address with your email.
2. **Delete your Cloudflare token.** It can change your whole Cloudflare account, and you don't need it any more. Go to _My Profile > API Tokens_ on Cloudflare and delete `swarm-setup`.
3. **Delete the `swarm-setup` Worker** in your Cloudflare dashboard. It has already forgotten your keys.
4. **Turn on a passkey or an authenticator app** under _Settings > Security_ once you've signed in, and save the recovery codes it gives you.

## How long the setup page keeps your secrets

- It keeps your Cloudflare token, your email service key and the keys it generates only while the install runs. When you continue past the recovery kit, it forgets all of them, along with the step log.
- An install left alone for **8 hours** (no step run, no new token) forgets them too. If no step had run yet, start again from the beginning. Otherwise the page says the install expired: delete your Cloudflare token, remove what the install created, and deploy the `swarm-setup` Worker again.
- An install can be started only once; another browser with the password can't start it again over yours.
- Error messages and the step log hide every secret the install holds (the token, the AWS key, your email service key or SMTP login, and every generated key), whichever step or provider wrote them.
- **Sign every browser out of this setup page** (on the last screen) ends every setup session at once, without changing the password.

## If something goes wrong

The install stops at the problem and tells you what happened. Nothing is lost: fix the cause, then choose **Try this step again** (within 8 hours, see above).

### The page says the release was withdrawn

The Swarm project withdrew the release this install uses, or the key that signed it. Serve the replacement at `RELEASE_URL` (with its public key, if the key changed), raise `RELEASE_MIN_VERSION` to it, and deploy the `swarm-setup` Worker again. Then choose **Use the replacement release**, check it as before, and approve it. The database and Worker steps run again from the replacement. For an install that had already finished, see [releasing.md](releasing.md#withdraw-a-release-or-a-key).

### The Connect screen says the token is missing permissions

Cloudflare's link doesn't always fill in every permission. On Cloudflare, go to _My Profile > API Tokens_, choose **Edit** on the token, add each row the page lists, and save. Then choose **Connect** again. The token itself doesn't change.

### "Cloudflare answered 403" or "Authentication error" during the install

The token is missing a permission for that step. Add it as above, then try the step again. If you had to create a new token, use **Use a different Cloudflare token** under the error.

### The install stops at "Checking email works"

Swarm won't call the install finished until your email service has verified your domain and accepted a test email, because you sign in by email.

- **"hasn't verified … yet".** DNS changes usually take minutes, and sometimes longer. Wait 10 minutes and try again.
- **It still doesn't verify.** Open your email service's dashboard, find `mail.yourdomain.com`, and see which records it says are missing. Compare them with _DNS > Records_ on Cloudflare. Each record's name must end in exactly `.mail.yourdomain.com`, with `mail` only once.
- **"refused a test email".** The message gives the service's reason. Common ones are a new account waiting for approval, or a free plan's limit.

### "points directly at another server"

You chose your main domain for your publication, but it has a DNS record that sends visitors straight to another server. On Cloudflare, under _DNS > Records_, turn on the orange cloud (Proxied) for that record, or delete it if you don't need that server. Then try the step again.

### "already has a record"

A subdomain Swarm needs is already in use. Rename or remove your record on Cloudflare, or start over with a different dashboard address.

### "We couldn't send your sign-in email" when signing in

Your email service refused the email. Check its dashboard: the domain may have lost its verification, or a plan limit may have been reached. Its logs show the reason.

### The sign-in page says the email was sent, but nothing arrives

Check spam. Then check that you used the address you entered during setup: sign-up is invite-only, so any other address gets a short note and no sign-in link.

## Using Amazon SES

Amazon SES costs the least at higher volumes, but takes more setup than the other services, and it's a preview: it has only been tested against a stand-in for AWS.

**The key.** In AWS, create an IAM user, give it the policy shown under _The permissions this key needs_ on the setup page, and create an access key for it. An administrator key also works. Swarm uses this key only to set up SES, and forgets it when the email connection is confirmed, or after 2 hours. Your Workers get a key of their own. **Delete the setup key in AWS when the install is done**, because it can create IAM users.

**The sandbox.** A new AWS account starts in the SES sandbox, where email only reaches addresses you've verified, up to 200 a day. During the install:

1. AWS emails your address a link. Click it, and the install's email check can pass. If it stops at _Checking email works_, this is usually why.
2. Tick _Ask AWS for production access now_ on the setup page, or ask in the AWS console later. A person at AWS reviews the request, usually within a day.

Your install works in the sandbox, but subscribers won't get your posts until AWS approves it.

**The suppression list.** SES keeps one list of addresses it won't send to for the whole AWS account, and a new account adds an address to it after a hard bounce or a spam complaint. The setup sets it to hard bounces only, so a complaint about one publisher's email doesn't stop every other publisher on your install from reaching that person; Swarm still stops sending to them from the publication they complained about. It's safe to run again. If you installed before this, run `pnpm swarm` once with an AWS admin key (or the setup key), or run `aws sesv2 put-account-suppression-attributes --suppressed-reasons BOUNCE`; `pnpm swarm doctor` tells you if it's still needed.

## Changing your email service

Settings → Instance shows the records each service needs. Your current service keeps sending until you choose to move, and you can go back for 14 days.

**You'll need your recovery kit** and a new Cloudflare token. If you've deleted the `swarm-setup` Worker, deploy it again the way you did to install: run `wrangler deploy` in `apps/setup` with `SETUP_PASSWORD`, `RELEASE_URL`, `RELEASE_PUBLIC_KEY` and `RELEASE_MIN_VERSION` set. Delete the Worker and the token again when you're done.

1. Open the setup page and choose **Change your email service**. Enter the kit's passphrase and pick your kit. It is opened in your browser, and its encryption keys are never sent anywhere. The updated kits you save are sealed under the same passphrase (an older kit without one is sealed under the passphrase you enter).
2. Choose the new service and set it up. Your current service is still sending.
3. **Save your updated kit each time the page offers it, and keep only the newest.** An old one is refused, because it would put your Workers back on the old settings.
4. Publish the new records. Swarm writes its own if it can. Each publication's owner sees theirs under _Sending & delivery_, with a check.
5. Move over. The page tells you what isn't ready first, because a domain without its records can't send until it has them. A post scheduled on such a domain goes back to being a draft.
6. After 14 days, finish, which removes the old service's keys and records. Reports from it keep counting until then, because a complaint can arrive long after the email went out.

**A new service has no sending history**, so warm-up starts again after the move. Starting from 200 emails a day and growing by half each day, reaching 50,000 readers takes about two weeks, and posts over the day's cap carry on the next day. This doesn't apply to a warm-up that's paused, which stays paused for you to look at.

**If you've lost your kit,** you can't do this from the browser, because Swarm can't prove the install is yours or read your settings back. See _Using the kit_ below for what it holds.

In the terminal, the same steps are `pnpm swarm mail switch <service>`, `mail status`, `mail cutover`, `mail rollback`, `mail cancel` and `mail finish`.

This has only been tested against stand-ins for each service and for Cloudflare, not with real accounts. Try it on a test install first.

## Your recovery kit

The kit is a file holding your install's settings and keys, encrypted under a passphrase you choose when you download it (at least 12 characters; PBKDF2 and AES-256-GCM). The file alone gives nobody your keys, so a copy left in a downloads folder or a backup is not enough to read your subscribers' fields. **You don't upload it anywhere.** Keep the file and the passphrase apart, for example the passphrase in a password manager. **If you lose the passphrase, the kit can't be opened, and nobody can recover it for you**: your encrypted subscriber fields would then depend on the install itself staying intact.

It isn't a way to sign in by itself. Here's what to do for each problem:

| Problem                                                 | What to do                                                           |
| ------------------------------------------------------- | -------------------------------------------------------------------- |
| You can't find your sign-in email                       | Ask for a new one on the sign-in page.                               |
| You lost your passkey or authenticator                  | Use one of the recovery codes you saved under _Settings > Security_. |
| Email is broken, so sign-in links can't reach you       | Use the kit to make a sign-in link yourself. See below.              |
| You're moving to a new computer, or want to run updates | Use the kit in the same way.                                         |

### Using the kit

This part needs a terminal, with Node.js 22 and pnpm 10. It's on our list to make this possible from a browser.

1. Download Swarm's code, and run `pnpm install` in its folder.
2. Run `pnpm swarm restore path/to/swarm-recovery-kit.json` and enter the kit's passphrase when asked (or set `SWARM_KIT_PASSPHRASE` for that one command). This sets up your computer and changes nothing on Cloudflare. It writes the keys to `.swarm/`, encrypted under a second passphrase it asks you to choose for this computer (or `SWARM_SECRETS_PASSPHRASE`), and readable only by your user (on Windows it limits the file with `icacls`, and says so if it can't). See [Back up .swarm/](self-hosting.md#back-up-swarm).
3. Run `pnpm swarm signin-link`, and sign in to Cloudflare when asked. It prints a one-time link for the owner.

**Keep the kit safe.** Your subscribers' encrypted fields can't be read without its `FIELD_KEYS`, and nobody can recover them for you. Anyone holding the kit holds those keys.
