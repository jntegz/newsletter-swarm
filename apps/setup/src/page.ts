// The wizard's one page, in the dashboard's Line system (DESIGN.md): the steps are a transit line,
// you are the yellow stop, and green means done. It has no build step and no dependencies, and
// everything from the server is shown with textContent, never as HTML.
import { SES_SETUP_POLICY } from '@swarm/installer/wizard';

const PERMISSIONS = [
  ['workers_scripts', 'edit'],
  ['workers_kv_storage', 'edit'],
  ['workers_r2', 'edit'],
  ['d1', 'edit'],
  ['queues', 'edit'],
  ['account_settings', 'read'],
  ['turnstile_sites', 'edit'],
  ['zone', 'read'],
  ['zone_settings', 'edit'],
  ['dns', 'edit'],
  ['workers_routes', 'edit'],
  ['email_routing_rules', 'edit'],
].map(([key, type]) => ({ key, type }));

export const TOKEN_LINK =
  'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=' +
  encodeURIComponent(JSON.stringify(PERMISSIONS)) +
  '&accountId=*&zoneId=all&name=swarm-setup';

/** The install's steps as a person would describe them. Every step belongs to exactly one. */
const SES_POLICY_TEXT = JSON.stringify(SES_SETUP_POLICY, null, 2);

export const STAGES: { title: string; steps: (id: string) => boolean }[] = [
  { title: 'Checking your account', steps: (id) => ['account', 'prompts'].includes(id) },
  { title: 'Creating storage', steps: (id) => ['resources', 'keys', 'turnstile'].includes(id) },
  { title: 'Setting up email', steps: (id) => ['mail', 'dns'].includes(id) },
  { title: 'Preparing the database', steps: (id) => id === 'migrations' },
  { title: 'Uploading Swarm', steps: (id) => id.startsWith('deploy-') },
  {
    title: 'Checking email works',
    steps: (id) => ['post-deploy', 'ses-events', 'email-check'].includes(id),
  },
  { title: 'Creating your account', steps: (id) => ['bootstrap', 'signin'].includes(id) },
  { title: 'Checking it all works', steps: (id) => ['health', 'summary'].includes(id) },
];

const stageIndex = `function stageOf(id) {
  if (id === 'account' || id === 'prompts') return 0;
  if (id === 'resources' || id === 'keys' || id === 'turnstile') return 1;
  if (id === 'mail' || id === 'dns') return 2;
  if (id === 'migrations') return 3;
  if (id.indexOf('deploy-') === 0) return 4;
  if (id === 'post-deploy' || id === 'ses-events' || id === 'email-check') return 5;
  if (id === 'bootstrap' || id === 'signin') return 6;
  return 7;
}`;

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Set up Swarm</title>
<link rel="preload" href="/fonts/atkinson-next.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<div class="shell">
<aside class="rail">
  <p class="brand">
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M2 12h20" stroke="#1c8c5e" stroke-width="3" stroke-linecap="round"/><circle cx="12" cy="12" r="6" fill="#d5dcea"/><circle cx="12" cy="12" r="2.5" fill="#14203a"/></svg>
    Swarm setup
  </p>
  <nav aria-label="Setup steps">
    <ol class="line" id="stations">
      <li data-station="welcome"><span>Before you start</span></li>
      <li data-station="connect"><span>Connect Cloudflare</span></li>
      <li data-station="details"><span>Your details</span></li>
      <li data-station="installing"><span>Install</span></li>
      <li data-station="save-kit"><span>Save your recovery kit</span></li>
      <li data-station="finished"><span>Sign in</span></li>
    </ol>
  </nav>
  <p class="rail-where" id="rail-where" aria-hidden="true"></p>
</aside>
<main>
<div id="error" class="error" role="alert" hidden></div>

<section id="login" hidden>
  <h1>Enter your setup password</h1>
  <p class="lede">You chose this password when you deployed this page.</p>
  <form id="login-form">
    <label for="password">Setup password</label>
    <input id="password" type="password" autocomplete="current-password" required>
    <button type="submit">Continue</button>
  </form>
</section>

<section id="welcome" hidden>
  <h1>Before you start</h1>
  <p class="lede">This takes about 30 to 60 minutes, and longer if you need to move a domain or wait for an email service to approve you. You can close this page and come back.</p>
  <h2>What you need</h2>
  <ul class="needs">
    <li><b>Cloudflare's Workers Paid plan, $5 a month.</b> Swarm can't run on the free plan: it allows too little work per request and too few queue operations a day, so a send could stop partway through your list. Turn it on under Workers &amp; Pages &gt; Plans.</li>
    <li><b>A domain on your Cloudflare account.</b> A new or spare one is safest, because moving a domain you already use can interrupt its website or email.</li>
    <li><b>An account with an email service,</b> to send your posts.</li>
  </ul>
  <button id="welcome-next" type="button">I have these</button>
  <p class="hint">Already installed Swarm? <button id="welcome-change" type="button" class="link">Change your email service</button></p>
</section>

<section id="connect" hidden>
  <h1>Connect Cloudflare</h1>
  <p class="lede">Swarm installs itself on your own Cloudflare account, so it needs a token that lets it do that.</p>
  <ol class="how">
    <li><a id="token-link" class="button ghost" target="_blank" rel="noreferrer">Create a token on Cloudflare</a><br>The permissions are filled in for you.</li>
    <li>Choose <b>Continue to summary</b>, then <b>Create Token</b>, and copy it.</li>
    <li>Paste it below.</li>
  </ol>
  <form id="connect-form">
    <label for="token">Cloudflare token</label>
    <input id="token" class="secret" type="password" autocomplete="off" spellcheck="false" required>
    <p class="hint">It goes only to this page, which runs on your own account, and is used only to talk to Cloudflare. This page forgets it when you finish.</p>
    <div id="missing" class="notice warn" role="status" hidden>
      <p><b>This token is missing some permissions.</b> On Cloudflare, edit the token, add these rows, and save it. Then connect again.</p>
      <ul id="missing-list"></ul>
    </div>
    <button type="submit">Connect</button>
  </form>
</section>

<section id="change" hidden>
  <h1>Change your email service</h1>
  <p class="lede">Your current service keeps sending until you choose to move, and you can go back for 14 days. Your kit stays in this browser, and its encryption keys never leave it.</p>
  <label for="change-kit">Your recovery kit</label>
  <input id="change-kit" type="file" accept="application/json,.json">
  <label for="change-kit-passphrase">The kit's passphrase</label>
  <input id="change-kit-passphrase" class="secret" type="password" autocomplete="off" spellcheck="false">
  <p class="hint">The one you chose when you saved the kit. It opens the kit here, in this browser, and seals the updated kit you save. An older kit without one is sealed under it when you save.</p>
  <button id="change-kit-open" type="button" class="ghost">Open the kit</button>
  <label for="change-token">Cloudflare token</label>
  <input id="change-token" class="secret" type="password" autocomplete="off" spellcheck="false">
  <p class="hint">The same kind you made to install. Delete it afterwards.</p>
  <p class="error" id="change-error" role="alert" hidden></p>
  <p class="notice warn" id="change-warnings" role="status"></p>

  <div id="change-start" hidden>
    <fieldset class="choices">
      <legend><h2>Change to</h2></legend>
      <label class="choice"><input type="radio" name="change-provider" value="resend" checked><span><b>Resend</b></span></label>
      <label class="choice"><input type="radio" name="change-provider" value="ses"><span><b>Amazon SES <i class="pill">Preview</i></b></span></label>
      <label class="choice"><input type="radio" name="change-provider" value="mailgun"><span><b>Mailgun <i class="pill">Preview</i></b></span></label>
      <label class="choice"><input type="radio" name="change-provider" value="postmark"><span><b>Postmark <i class="pill">Preview</i></b></span></label>
    </fieldset>
    <label for="change-region">Region</label>
    <input id="change-region" value="eu-west-1" spellcheck="false">
    <p class="hint">For Mailgun, us or eu. Postmark doesn't use this.</p>
    <div id="change-key-field">
      <label for="change-key">API key or account token</label>
      <input id="change-key" class="secret" type="password" autocomplete="off" spellcheck="false">
    </div>
    <div id="change-ses-fields" hidden>
      <label for="change-aws-id">AWS access key ID</label>
      <input id="change-aws-id" autocomplete="off" spellcheck="false">
      <label for="change-aws-secret">AWS secret access key</label>
      <input id="change-aws-secret" class="secret" type="password" autocomplete="off" spellcheck="false">
      <label class="choice"><input type="checkbox" id="change-production"><span><b>Ask AWS for production access now</b></span></label>
    </div>
    <button id="change-begin" type="button">Set up the new service</button>
  </div>

  <div id="change-prepared" hidden>
    <h2>Moving to <span id="change-to"></span></h2>
    <p>Your current service is still sending. Each publication can see its new records under Sending &amp; delivery. When they're published, move over. Warm-up starts again, so large lists take a couple of weeks to reach everyone.</p>
    <button id="change-check" type="button">Check what's missing</button>
    <div id="change-move-aws">
      <p class="hint">Moving to Amazon SES? Your setup key connects bounce and complaint reports, so paste it again.</p>
      <label for="change-move-aws-id">AWS access key ID</label>
      <input id="change-move-aws-id" autocomplete="off" spellcheck="false">
      <label for="change-move-aws-secret">AWS secret access key</label>
      <input id="change-move-aws-secret" class="secret" type="password" autocomplete="off" spellcheck="false">
    </div>
    <label class="choice"><input type="checkbox" id="change-ack"><span><b>Move even if something above isn't ready</b><small>A domain that isn't ready can't send until it is.</small></span></label>
    <button id="change-cutover" type="button">Move email to the new service</button>
    <button id="change-cancel" type="button" class="quiet">Drop this change</button>
  </div>

  <div id="change-moved" hidden>
    <h2>Email has moved</h2>
    <p>Reports from your old service keep arriving until <span id="change-until"></span>. After that, finish to remove its keys and records.</p>
    <button id="change-finish" type="button">Finish and remove the old service</button>
    <button id="change-rollback" type="button" class="quiet">Go back to the old service</button>
  </div>

  <div id="change-kit-save" hidden>
    <p class="notice warn"><b>Save your updated kit, and keep only this one.</b> Your old kit has out-of-date email settings, and using it would be refused.</p>
    <button id="change-save" type="button">Save your updated recovery kit</button>
  </div>
  <pre id="change-log" tabindex="0"></pre>
</section>

<section id="details" hidden>
  <h1>Your details</h1>
  <form id="details-form">
    <div id="account-field" hidden>
      <label for="account">Cloudflare account</label>
      <select id="account"></select>
    </div>
    <label for="zone">Domain</label>
    <select id="zone" required></select>
    <div class="pair">
      <div>
        <label for="owner-name">Your name</label>
        <input id="owner-name" autocomplete="name" maxlength="80" required>
      </div>
      <div>
        <label for="owner-email">Your email address</label>
        <input id="owner-email" type="email" autocomplete="email" required>
        <p class="hint">You'll sign in with this address.</p>
      </div>
    </div>
    <label for="publication-name">Publication name</label>
    <input id="publication-name" maxlength="80" required>

    <fieldset class="choices">
      <legend><h2>Where readers find your publication</h2></legend>
      <label class="choice"><input type="radio" name="publication-at" value="root" checked><span><b>Your main domain <i class="pill" id="root-name"></i></b><small>Your newsletter's landing page and past posts, right at your domain. This replaces anything your domain shows today. Email on it isn't affected.</small></span></label>
      <label class="choice"><input type="radio" name="publication-at" value="subdomain"><span><b>A subdomain</b><small>For when your main domain already has a website you want to keep.</small></span></label>
    </fieldset>
    <div id="slug-field" hidden>
      <label for="publication-slug">Subdomain</label>
      <input id="publication-slug" maxlength="48" pattern="[a-z0-9][a-z0-9-]*" spellcheck="false">
      <p class="hint" id="slug-hint">Lowercase letters, numbers and dashes.</p>
    </div>

    <h2>Your dashboard</h2>
    <label for="dashboard">Subdomain for signing in and writing</label>
    <input id="dashboard" value="app" maxlength="63" pattern="[a-z0-9][a-z0-9-]*" spellcheck="false" required>
    <p class="hint" id="dashboard-hint"></p>

    <fieldset class="choices">
      <legend><h2>Email service</h2></legend>
      <label class="choice"><input type="radio" name="provider" value="resend" checked><span><b>Resend</b><small>The quickest start. One API key.</small></span></label>
      <label class="choice"><input type="radio" name="provider" value="mailgun"><span><b>Mailgun <i class="pill">Preview</i></b><small>One API key, with US or EU data storage.</small></span></label>
      <label class="choice"><input type="radio" name="provider" value="postmark"><span><b>Postmark <i class="pill">Preview</i></b><small>One account token. New accounts need Postmark to approve them.</small></span></label>
      <label class="choice"><input type="radio" name="provider" value="ses"><span><b>Amazon SES <i class="pill">Preview</i></b><small>Cheapest at volume. Needs an AWS account, and AWS has to approve it before you can email subscribers.</small></span></label>
      <label class="choice"><input type="radio" name="provider" value="smtp"><span><b>Your own mail server <i class="pill">Preview</i></b><small>For advanced users.</small></span></label>
    </fieldset>

    <div id="api-key-fields">
      <label id="api-key-label" for="api-key">API key</label>
      <input id="api-key" class="secret" type="password" autocomplete="off" spellcheck="false">
      <p class="hint">Stored on your own account, for your Workers to send with.</p>
    </div>
    <div id="region-field">
      <label for="region">Region</label>
      <select id="region"></select>
    </div>
    <div id="ses-fields" hidden>
      <p class="notice warn">A new AWS account starts in the SES sandbox: email only reaches addresses you've verified, up to 200 a day, until a person at AWS approves it, usually within a day. AWS will email you a link to verify your own address during this setup.</p>
      <label for="aws-access-key">AWS access key ID</label>
      <input id="aws-access-key" autocomplete="off" spellcheck="false">
      <label for="aws-secret-key">AWS secret access key</label>
      <input id="aws-secret-key" class="secret" type="password" autocomplete="off" spellcheck="false">
      <p class="hint">Swarm uses this key only to set up SES, and forgets it as soon as the email connection is confirmed, or after 2 hours. Your Workers get their own key, which can only send mail and manage sending domains. <b>Delete this key in AWS when the install is done</b>, because it can create IAM users.</p>
      <details>
        <summary>The permissions this key needs</summary>
        <p class="hint">In AWS, create an IAM user with this policy, then create an access key for it. An administrator key also works.</p>
        <pre tabindex="0">${SES_POLICY_TEXT}</pre>
      </details>
      <label class="choice"><input type="checkbox" id="production-access"><span><b>Ask AWS for production access now</b><small>Sends AWS a request describing how Swarm handles opt-in, unsubscribes and bounces.</small></span></label>
    </div>
    <div id="smtp-fields" hidden>
      <p class="notice warn">Plain SMTP doesn't report spam complaints, so Swarm can't pause a send when they rise unless your server reports them. You also publish your server's DKIM and SPF records yourself.</p>
      <label for="smtp-host">Server address</label>
      <input id="smtp-host" spellcheck="false">
      <div class="pair">
        <div>
          <label for="smtp-port">Port</label>
          <select id="smtp-port"><option>587</option><option>465</option></select>
        </div>
        <div>
          <label for="smtp-selector">DKIM selector</label>
          <input id="smtp-selector" value="default" spellcheck="false">
        </div>
      </div>
      <div class="pair">
        <div>
          <label for="smtp-username">Username</label>
          <input id="smtp-username" autocomplete="off" spellcheck="false">
        </div>
        <div>
          <label for="smtp-password">Password</label>
          <input id="smtp-password" class="secret" type="password" autocomplete="off">
        </div>
      </div>
    </div>
    <button type="submit">Install Swarm</button>
  </form>
</section>

<section id="installing" hidden>
  <h1>Installing Swarm</h1>
  <form id="approve-form" class="notice" hidden>
    <h2>Check the release before anything is installed</h2>
    <p>Nothing has changed on your Cloudflare account yet. Compare these with what the Swarm project publishes in SECURITY.md in its own repository, not with anything the release's site says.</p>
    <dl class="facts">
      <dt>Version</dt><dd id="offer-version"></dd>
      <dt>Signing key</dt><dd id="offer-key" class="mono"></dd>
      <dt>Manifest SHA-256</dt><dd id="offer-digest" class="mono"></dd>
    </dl>
    <p id="offer-trust"></p>
    <label class="check"><input id="approve-check" type="checkbox" required> I compared these, and this is the release I mean to install</label>
    <button type="submit">Install this release</button>
  </form>
  <div id="withdrawn" class="error" hidden>
    <p>The release this install uses has been withdrawn. Nothing more is installed from it.</p>
    <p>Serve the replacement at RELEASE_URL and raise RELEASE_MIN_VERSION to it, then use it here. The database and Worker steps run again from the replacement.</p>
    <button id="replace-release" type="button">Use the replacement release</button>
  </div>
  <p id="install-release" class="hint" hidden></p>
  <p id="install-status" class="lede" role="status">Starting.</p>
  <ol class="route" id="route"></ol>
  <div id="retry" hidden>
    <div class="error">
      <p id="retry-message"></p>
      <p id="retry-hint"></p>
    </div>
    <button id="retry-button" type="button">Try this step again</button>
    <form id="aws-key-form" hidden>
      <label for="replacement-aws-access-key">AWS access key ID</label>
      <input id="replacement-aws-access-key" autocomplete="off" spellcheck="false" required>
      <label for="replacement-aws-secret-key">AWS secret access key</label>
      <input id="replacement-aws-secret-key" class="secret" type="password" autocomplete="off" spellcheck="false" required>
      <button type="submit">Use this key and try again</button>
    </form>
    <details id="new-token">
      <summary>Use a different Cloudflare token</summary>
      <form id="token-form">
        <label for="replacement-token">New Cloudflare token</label>
        <input id="replacement-token" class="secret" type="password" autocomplete="off" spellcheck="false" required>
        <button type="submit" class="ghost">Use this token and try again</button>
      </form>
    </details>
  </div>
  <p class="hint" id="installing-hint">You can close this page. Come back to this address within 8 hours, and the install carries on from here. After 8 hours without a step, this page forgets your Cloudflare token and every key it made.</p>
  <p class="notice warn" id="expired-note" hidden>This install was left unfinished for more than 8 hours, so this page forgot your Cloudflare token, your mail service key and the keys it made. Delete your Cloudflare token, remove what the install created, and deploy the swarm-setup Worker again to start over.</p>
  <details>
    <summary>Show the details</summary>
    <pre id="log" tabindex="0"></pre>
  </details>
</section>

<section id="save-kit" hidden>
  <h1>Save your recovery kit</h1>
  <p class="notice warn"><b>Do this now.</b> The kit holds the keys that encrypt your subscribers' fields. Without them, those fields can never be read again. On Cloudflare they are held by Swarm's vault worker, which has no public address. This page removes its copy when you continue.</p>
  <p class="lede kit-where">Keep the file in a password manager or another private place. You don't upload it anywhere. You'd only need it if you lose access or have to rebuild this install, and the setup guide explains how.</p>
  <form id="kit-download-form">
    <label for="kit-passphrase">A passphrase for the kit</label>
    <input id="kit-passphrase" class="secret" type="password" autocomplete="new-password" minlength="12" required>
    <label for="kit-passphrase-again">The same passphrase again</label>
    <input id="kit-passphrase-again" class="secret" type="password" autocomplete="new-password" minlength="12" required>
    <p class="hint">At least 12 characters. The kit is encrypted under it, so the file alone is no use to someone who finds it in a backup or a downloads folder. Keep the passphrase apart from the file, in a password manager. <b>Without it the kit can't be opened, and nobody can recover it for you.</b></p>
    <button type="submit" class="ghost">Download recovery kit</button>
  </form>
  <p class="hint" id="kit-left"></p>
  <form id="kit-form">
    <label class="check"><input id="kit-saved" type="checkbox" required> I've saved the file somewhere private and safe</label>
    <button type="submit">Continue</button>
  </form>
</section>

<section id="finished" hidden>
  <h1>Swarm is installed</h1>
  <p id="sign-in-note" class="lede">Use this link to sign in. It works once, for 60 minutes.</p>
  <a id="sign-in" class="button" rel="noreferrer">Sign in to Swarm</a>
  <p class="hint" id="test-email" hidden></p>
  <p class="notice warn" id="mail-note" hidden></p>
  <p class="hint" id="publication-at-note" hidden>Your publication is at <a id="publication-url" rel="noreferrer"></a>.</p>
  <h2>Two things to tidy up</h2>
  <ul class="needs">
    <li><b>Delete your Cloudflare token now.</b> It can change your whole Cloudflare account, and you don't need it any more. This page has forgotten it, but the token works until you delete it, under <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">My Profile &gt; API Tokens</a>.</li>
    <li><b>Delete the swarm-setup Worker</b> from your Cloudflare dashboard. It has forgotten your keys, and you don't need it any more.</li>
  </ul>
  <button id="end-sessions" class="ghost" type="button">Sign every browser out of this setup page</button>
</section>
</main>
</div>
<script src="/app.js"></script>
</body>
</html>`;

export const STYLES = `@font-face{font-family:"Atkinson Next";src:url(/fonts/atkinson-next.woff2) format("woff2");font-weight:200 800;font-display:swap}
@font-face{font-family:"Atkinson Mono";src:url(/fonts/atkinson-mono.woff2) format("woff2");font-weight:200 800;font-display:swap}
:root{--ink:#111827;--sub:#4b5568;--muted:#687082;--night:#14203a;--night-hover:#22325a;--soft:#eef1f6;--alt:#f4f6f9;--line:#e2e6ec;--control:#8a94a6;--control-hover:#6b7486;--route:#12724b;--danger:#b42318;--danger-soft:#fef0ee;--danger-ink:#7a1a11;--warn:#8a5300;--warn-soft:#fff5db;--rail:#14203a;--rail-2:#1d2b4b;--rail-text:#d5dcea;--rail-muted:#9aa6bf;--rail-line:#33446a;--signal:#ffc83d;--signal-soft:#ffe7a3;--route-rail:#1c8c5e}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:#fff;color:var(--ink);font:400 15px/1.55 "Atkinson Next",system-ui,sans-serif;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
::selection{background:var(--signal-soft);color:var(--ink)}
.shell{display:grid;grid-template-columns:280px minmax(0,1fr);min-height:100vh;background:linear-gradient(90deg,var(--rail) 280px,#fff 280px)}
.rail{position:sticky;top:0;align-self:start;height:100vh;padding:28px 28px 28px 32px;background:var(--rail);color:var(--rail-text)}
.brand{display:flex;align-items:center;gap:10px;margin:0 0 44px;font-size:15px;font-weight:650;color:#fff}
.line{position:relative;margin:0;padding:0;list-style:none}
.line::before{content:"";position:absolute;left:6px;top:22px;bottom:22px;width:2px;background:var(--rail-line)}
.line li{position:relative;display:flex;align-items:center;gap:16px;min-height:44px;color:var(--rail-muted);font-size:15px}
.line li::before{content:"";position:relative;flex:none;width:14px;height:14px;border:2px solid var(--rail-muted);border-radius:50%;background:var(--rail);transition:background-color 200ms ease-out,border-color 200ms ease-out}
.line li.done{color:var(--rail-text)}
.line li.done::before{border-color:var(--route-rail);background:var(--route-rail)}
.line li[aria-current]{color:#fff;font-weight:600}
.line li[aria-current]::before{width:18px;height:18px;margin:0 -2px;border:5px solid var(--signal);background:var(--rail)}
.rail-where{display:none}
main{width:100%;max-width:640px;padding:64px 32px 96px;margin:0}
h1{margin:0 0 12px;font-size:26px;font-weight:600;line-height:1.2;letter-spacing:-.01em;text-wrap:balance}
h1:focus{outline:none}
h2{margin:32px 0 10px;padding:0;font-size:17px;font-weight:650;line-height:1.3;letter-spacing:-.005em}
.lede{margin:0 0 24px;color:var(--sub)}
a{color:var(--night);text-underline-offset:2px}
form{margin:0}
label{display:block;margin:20px 0 6px;font-size:13px;font-weight:600}
input,select{display:block;width:100%;min-height:38px;padding:8px 11px;border:1px solid var(--control);border-radius:8px;background:#fff;color:inherit;font:inherit;transition:border-color 150ms ease-out}
input:hover,select:hover{border-color:var(--control-hover)}
select{appearance:none;padding-right:34px;background-image:linear-gradient(45deg,transparent 50%,var(--sub) 50%),linear-gradient(135deg,var(--sub) 50%,transparent 50%);background-position:calc(100% - 18px) 50%,calc(100% - 13px) 50%;background-size:5px 5px;background-repeat:no-repeat}
input.secret{font-family:"Atkinson Mono",ui-monospace,monospace}
input[type=checkbox],input[type=radio]{width:18px;height:18px;min-height:0;flex:none;margin:2px 0 0;padding:0;accent-color:var(--night)}
:focus-visible{outline:2px solid var(--night);outline-offset:2px}
.rail :focus-visible{outline-color:var(--signal)}
button,.button{display:inline-flex;align-items:center;justify-content:center;min-height:36px;margin-top:24px;padding:8px 16px;border:1px solid var(--night);border-radius:8px;background:var(--night);color:#fff;font:inherit;font-size:14px;font-weight:600;line-height:1;text-decoration:none;cursor:pointer;transition:background-color 150ms ease-out,border-color 150ms ease-out}
button:hover,.button:hover{background:var(--night-hover);border-color:var(--night-hover)}
button:disabled{opacity:.55;cursor:default}
.ghost,.button.ghost{background:#fff;color:var(--night);border-color:var(--control)}
.ghost:hover,.button.ghost:hover{background:var(--alt);border-color:var(--control-hover)}
.hint{margin:6px 0 0;font-size:13px;color:var(--sub)}
.notice,.error{margin:16px 0 0;padding:12px 14px;border-radius:8px}
.notice p,.error p{margin:0}
.error p+p{margin-top:6px}
.error p:empty{display:none}
.notice{background:var(--soft)}
.notice.warn{background:var(--warn-soft);color:#5c3700}
.notice ul{margin:8px 0 0;padding-left:18px;font-weight:600}
.error{background:var(--danger-soft);color:var(--danger-ink)}
main>.error{margin:0 0 24px}
.needs,.how{margin:0;padding:0;list-style:none}
.needs li{padding:14px 0;border-top:1px solid var(--line)}
.needs li:last-child{border-bottom:1px solid var(--line)}
.how{counter-reset:how}
.how li{counter-increment:how;position:relative;padding:14px 0 14px 36px;border-top:1px solid var(--line)}
.how li:last-child{border-bottom:1px solid var(--line)}
.how li::before{content:counter(how);position:absolute;left:0;top:14px;width:24px;height:24px;border-radius:50%;background:var(--soft);font-size:13px;font-weight:650;line-height:24px;text-align:center}
.how .button{margin:0 0 8px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}
.choices{margin:12px 0 0;padding:0;border:0}
.choices legend{padding:0}
.choices h2{margin:32px 0 10px}
label.choice{display:flex;gap:12px;align-items:flex-start;margin:0;padding:12px 2px;border-top:1px solid var(--line);font-size:15px;font-weight:400;cursor:pointer}
label.choice:last-of-type{border-bottom:1px solid var(--line)}
label.choice b{display:block;font-weight:600}
label.choice small{display:block;font-size:13px;color:var(--sub)}
.pill{display:inline-block;margin-left:6px;padding:1px 8px;border-radius:999px;background:var(--soft);color:var(--sub);font-size:12px;font-style:normal;font-weight:600;vertical-align:1px}
.kit-where{margin:16px 0 20px}
#test-email,#publication-at-note{margin-top:12px}
label.check{display:flex;gap:10px;align-items:flex-start;margin:24px 0 0;font-size:15px;font-weight:400}
.route{position:relative;margin:0 0 20px;padding:0;list-style:none}
.route li{position:relative;display:flex;align-items:center;gap:12px;min-height:40px;color:var(--muted)}
.route li:not(:last-child)::after{content:"";position:absolute;left:8px;top:29px;bottom:-11px;width:3px;background:var(--line)}
.route li.done:not(:last-child)::after{background:var(--route)}
.route i{position:relative;z-index:1;flex:none;width:19px;height:19px;border:2px solid var(--control);border-radius:50%;background:#fff}
.route li.done{color:var(--ink)}
.route li.done i{border-color:var(--route);background:var(--route)}
.route li.done i::after{content:"";position:absolute;left:4.5px;top:1.5px;width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}
.route li.now{color:var(--ink);font-weight:600}
.route li.now i{border:5px solid var(--signal);background:var(--night);box-shadow:0 0 0 1px var(--night)}
.route li.stopped i{border:2px solid var(--danger);background:var(--danger)}
.route li.stopped i::after{content:"";position:absolute;left:6.5px;top:3px;width:2px;height:6px;background:#fff;box-shadow:0 8px 0 #fff}
.route small{margin-left:auto;font-size:13px;font-weight:400;color:var(--sub)}
#change-warnings:empty{display:none}
#change button{margin-top:14px}
#change-log:empty{display:none}
button.quiet,button.link{background:none;color:inherit;border:1px solid var(--line)}
button.link{border:0;padding:0;min-height:0;text-decoration:underline;font:inherit;margin:0}
#retry{margin:4px 0 20px}
#retry button{margin-top:14px}
details{margin-top:20px;font-size:13px}
summary{cursor:pointer;color:var(--sub);font-weight:600}
summary:hover{color:var(--ink)}
#new-token form{padding-bottom:4px}
.facts{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:10px 0}
.facts dt{color:var(--sub)}
.facts dd{margin:0}
.mono{font:12.5px/1.55 "Atkinson Mono",ui-monospace,monospace;overflow-wrap:anywhere}
pre{overflow:auto;max-height:280px;margin:10px 0 0;padding:12px;border-radius:8px;background:var(--alt);font:12.5px/1.55 "Atkinson Mono",ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;scrollbar-color:var(--control) transparent;scrollbar-width:thin}
[hidden]{display:none!important}
@media (max-width:820px){
.shell{display:block;background:#fff}
.rail{position:static;height:auto;padding:14px 16px 12px}
.brand{margin:0}
.rail nav{display:none}
.rail-where{display:block;margin:8px 0 0;font-size:13px;color:var(--rail-text)}
main{max-width:none;padding:28px 16px 64px}
button,.button{min-height:44px}
input,select{min-height:44px;font-size:16px}
.pair{grid-template-columns:1fr}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}`;

export const APP_JS = `'use strict';
var $ = function (id) { return document.getElementById(id); };
var SCREENS = ['login', 'welcome', 'connect', 'details', 'installing', 'save-kit', 'finished', 'change'];
var STAGE_TITLES = ${JSON.stringify(STAGES.map((stage) => stage.title))};
${stageIndex}
var REGIONS = {
  resend: ['us-east-1', 'eu-west-1', 'sa-east-1', 'ap-northeast-1'],
  mailgun: ['us', 'eu'],
  ses: ['eu-west-1', 'eu-west-2', 'eu-central-1', 'us-east-1', 'us-east-2', 'us-west-2', 'ca-central-1', 'sa-east-1', 'ap-south-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1'],
};
var KEY_LABELS = {
  resend: 'Resend API key, with Full access',
  mailgun: 'Mailgun Private API key',
  postmark: 'Postmark Account API token',
};
var cloudflareToken = '';
var stepping = false;

function provider() {
  return document.querySelector('input[name=provider]:checked').value;
}
function showStation(name) {
  var stations = Array.prototype.slice.call(document.querySelectorAll('[data-station]'));
  var at = stations.findIndex(function (li) { return li.dataset.station === name; });
  stations.forEach(function (li, index) {
    li.classList.toggle('done', at > -1 && index < at);
    if (index === at) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  });
  $('rail-where').textContent = at > -1
    ? 'Step ' + (at + 1) + ' of ' + stations.length + ': ' + stations[at].textContent.trim()
    : '';
}
function show(name) {
  SCREENS.forEach(function (id) { $(id).hidden = id !== name; });
  showStation(name);
  var heading = $(name).querySelector('h1');
  if (heading) { heading.tabIndex = -1; heading.focus(); }
  window.scrollTo(0, 0);
}
function showError(message) {
  $('error').textContent = message || '';
  $('error').hidden = !message;
  if (message) window.scrollTo(0, 0);
}
function api(method, path, body) {
  return fetch(path, {
    method: method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (data) {
      if (!res.ok) {
        var error = new Error(data.error || 'Something went wrong. Try again.');
        error.status = res.status;
        throw error;
      }
      return data;
    });
  });
}
function submitting(form, run) {
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    showError('');
    var button = form.querySelector('button[type=submit]');
    button.disabled = true;
    Promise.resolve().then(run).catch(function (error) { showError(error.message); })
      .then(function () { button.disabled = false; });
  });
}
function options(select, values) {
  select.textContent = '';
  values.forEach(function (item) {
    var option = document.createElement('option');
    option.value = item.value;
    option.textContent = item.label;
    select.appendChild(option);
  });
}
function providerChanged() {
  var chosen = provider();
  var smtp = chosen === 'smtp';
  $('smtp-fields').hidden = !smtp;
  $('ses-fields').hidden = chosen !== 'ses';
  $('api-key-fields').hidden = smtp || chosen === 'ses';
  $('api-key-label').textContent = KEY_LABELS[chosen] || '';
  var regions = REGIONS[chosen];
  $('region-field').hidden = !regions;
  if (regions) options($('region'), regions.map(function (r) { return { value: r, label: r }; }));
}
function drawRoute(progress) {
  var stages = STAGE_TITLES.map(function (title) { return { title: title, total: 0, done: 0 }; });
  progress.steps.forEach(function (step) {
    var stage = stages[stageOf(step.id)];
    stage.total++;
    if (step.done) stage.done++;
  });
  var route = $('route');
  route.textContent = '';
  var nowFound = false;
  stages.forEach(function (stage) {
    var li = document.createElement('li');
    li.appendChild(document.createElement('i'));
    var label = document.createElement('span');
    label.textContent = stage.title;
    li.appendChild(label);
    if (stage.done === stage.total) {
      li.className = 'done';
    } else if (!nowFound) {
      nowFound = true;
      li.className = progress.failed ? 'now stopped' : 'now';
      li.setAttribute('aria-current', 'step');
      if (stage.total > 1 && stage.done > 0) {
        var count = document.createElement('small');
        count.textContent = stage.done + ' of ' + stage.total;
        li.appendChild(count);
      }
    }
    route.appendChild(li);
  });
}
var lastProgress = null;
function render(progress) {
  lastProgress = progress;
  if (progress.phase === 'answers') return false;
  if (progress.phase === 'finished' || progress.phase === 'save-kit') {
    show(progress.phase === 'finished' ? 'finished' : 'save-kit');
    if (progress.testEmailTo) {
      $('test-email').textContent = 'We sent a test email to ' + progress.testEmailTo + '. If it isn\\'t in your inbox, check spam.';
      $('test-email').hidden = false;
    }
    if (progress.mailNote) {
      $('mail-note').textContent = progress.mailNote;
      $('mail-note').hidden = false;
    }
    if (progress.publicationUrl) {
      $('publication-url').href = progress.publicationUrl;
      $('publication-url').textContent = progress.publicationUrl.replace('https://', '');
      $('publication-at-note').hidden = false;
    }
    if (progress.signInLink) {
      $('sign-in').href = progress.signInLink;
    } else {
      $('sign-in').hidden = true;
      $('sign-in-note').textContent = 'Your install is ready. The sign-in link is shown only once: sign in at your dashboard address with your email.';
    }
    $('kit-left').textContent = progress.kitDownloadsLeft > 0
      ? 'You can download it ' + progress.kitDownloadsLeft + ' more time' + (progress.kitDownloadsLeft === 1 ? '' : 's') + '.'
      : 'It has been downloaded the most times allowed.';
    return true;
  }
  if (progress.phase === 'expired') {
    show('installing');
    drawRoute(progress);
    $('expired-note').hidden = false;
    $('installing-hint').hidden = true;
    $('retry').hidden = true;
    $('install-status').textContent = 'This install stopped and can not carry on.';
    $('log').textContent = progress.log.join('\\n');
    return true;
  }
  if ($('installing').hidden) show('installing');
  drawRoute(progress);
  var offer = progress.offer;
  var asking = !progress.approved && !!offer;
  $('approve-form').hidden = !asking;
  if (asking) {
    $('offer-version').textContent = offer.version;
    $('offer-key').textContent = offer.keyId;
    $('offer-digest').textContent = offer.digest;
    $('offer-trust').className = offer.projectKey ? 'hint' : 'notice warn';
    $('offer-trust').textContent = offer.projectKey
      ? 'This signing key is one the Swarm project publishes, and this page knows it.'
      : 'This page does not know this signing key as the Swarm project\\'s. Install only if you got RELEASE_PUBLIC_KEY from the project yourself and the key id above matches what it publishes.';
  }
  $('withdrawn').hidden = !progress.withdrawn;
  $('install-release').hidden = !progress.approved;
  $('install-release').textContent = progress.approved
    ? 'Release ' + progress.release + ', checked against its signature, signed by key ' + (offer ? offer.keyId.slice(0, 16) : '') + '…, approved by you.'
    : '';
  var next = progress.steps.find(function (s) { return !s.done; });
  $('install-status').textContent = progress.failed
    ? 'The install stopped here. Nothing is lost, and it can carry on from this step.'
    : next
      ? 'Now: ' + STAGE_TITLES[stageOf(next.id)] + '.'
      : 'Finishing up.';
  $('log').textContent = progress.log.join('\\n');
  $('retry').hidden = !progress.failed;
  if (progress.failed) {
    $('retry-message').textContent = progress.failed.message;
    $('retry-hint').textContent = progress.failed.hint || '';
  }
  $('aws-key-form').hidden = !(progress.failed && progress.needsAwsKey);
  $('retry-button').hidden = !$('aws-key-form').hidden;
  return true;
}
/** Steps run one after another only once the person has approved the release. */
function running(progress) {
  return progress.phase === 'installing' && !progress.failed && progress.approved && !progress.withdrawn;
}
function advance() {
  if (stepping) return;
  stepping = true;
  api('POST', '/api/step').then(function (progress) {
    stepping = false;
    render(progress);
    if (running(progress)) advance();
    else if (progress.failed) $('retry-button').focus();
  }).catch(function (error) {
    stepping = false;
    showError(error.message + ' Reload this page to carry on.');
  });
}
function resume() {
  return api('GET', '/api/status').then(function (progress) {
    if (!render(progress)) return show('welcome');
    if (running(progress)) advance();
  });
}

$('token-link').href = ${JSON.stringify(TOKEN_LINK)};
document.querySelectorAll('input[name=provider]').forEach(function (input) {
  input.addEventListener('change', providerChanged);
});
providerChanged();
function publicationAt() {
  return document.querySelector('input[name=publication-at]:checked').value;
}
function addressesChanged() {
  var zone = $('zone').value;
  var slug = $('publication-slug').value.trim();
  var subdomain = publicationAt() === 'subdomain';
  $('root-name').textContent = zone;
  $('slug-field').hidden = !subdomain;
  $('publication-slug').required = subdomain;
  $('slug-hint').textContent = slug && zone
    ? 'Your publication will be at ' + slug + '.' + zone
    : 'Lowercase letters, numbers and dashes.';
  $('dashboard-hint').textContent = 'You will sign in at ' + ($('dashboard').value.trim() || 'app') + '.' + zone;
}
['publication-slug', 'dashboard'].forEach(function (id) { $(id).addEventListener('input', addressesChanged); });
$('zone').addEventListener('change', addressesChanged);
document.querySelectorAll('input[name=publication-at]').forEach(function (input) {
  input.addEventListener('change', addressesChanged);
});
$('welcome-next').addEventListener('click', function () { show('connect'); });
$('welcome-change').addEventListener('click', function () { show('change'); });

// The recovery kit is sealed under a passphrase, the same way as packages/installer/src/kit.ts:
// PBKDF2-SHA256 (100000 rounds) and AES-256-GCM. Opened and sealed here, in the browser.
function kitBytes(text) { return Uint8Array.from(atob(text), function (c) { return c.charCodeAt(0); }); }
function kitText(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return btoa(out);
}
function kitKey(passphrase, salt, iterations) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']).then(function (base) {
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  });
}
function openSealedKit(sealedKit, passphrase) {
  return kitKey(passphrase, kitBytes(sealedKit.kdf.salt), sealedKit.kdf.iterations).then(function (key) {
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: kitBytes(sealedKit.cipher.iv), additionalData: new TextEncoder().encode('swarm-recovery-kit:2') }, key, kitBytes(sealedKit.sealed));
  }).then(function (plain) {
    return JSON.parse(new TextDecoder().decode(plain));
  });
}
function sealOpenKit(contents, passphrase, meta) {
  var salt = crypto.getRandomValues(new Uint8Array(16));
  var iv = crypto.getRandomValues(new Uint8Array(12));
  return kitKey(passphrase, salt, 100000).then(function (key) {
    return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: new TextEncoder().encode('swarm-recovery-kit:2') }, key, new TextEncoder().encode(JSON.stringify({ state: contents.state, secrets: contents.secrets })));
  }).then(function (sealed) {
    return {
      format: 'swarm-recovery-kit',
      version: 2,
      what: meta.what,
      createdAt: meta.createdAt,
      domain: meta.domain,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 100000, salt: kitText(salt) },
      cipher: { name: 'AES-GCM', iv: kitText(iv) },
      sealed: kitText(new Uint8Array(sealed)),
    };
  });
}
function saveFile(data) {
  var link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  link.download = 'swarm-recovery-kit.json';
  link.click();
  URL.revokeObjectURL(link.href);
}

// Changing the email service. The recovery kit stays here: only its settings and mail keys go to
// the server with each request, and never its encryption keys.
var kit = null;
var kitChanged = false;
var kitFile = null;
var kitMeta = null;
function kitToSend() {
  var secrets = Object.assign({}, kit.secrets);
  delete secrets.keys;
  return { state: kit.state, secrets: secrets };
}
function changeService() {
  return document.querySelector('input[name=change-provider]:checked').value;
}
function drawChange() {
  var open = kit && kit.state.mailChange;
  var phase = open ? open.phase : null;
  $('change-start').hidden = !kit || !!open;
  $('change-prepared').hidden = !(phase === 'prepared' || phase === 'preparing');
  $('change-moved').hidden = !(phase === 'cut_over' || phase === 'cutting_over');
  $('change-kit-save').hidden = !kitChanged;
  var fields = changeService();
  $('change-ses-fields').hidden = fields !== 'ses';
  $('change-key-field').hidden = fields === 'ses' || fields === 'smtp';
  if (open && open.to) $('change-to').textContent = open.to.provider;
  if (open && open.drainUntil) $('change-until').textContent = new Date(open.drainUntil).toISOString().slice(0, 10);
}
function changeAction(action, extra) {
  $('change-error').hidden = true;
  $('change-log').textContent = 'Working. This can take a minute or two.';
  return fetch('/api/change', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.assign({ action: action, token: $('change-token').value.trim() }, kitToSend(), extra || {})),
  }).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (data) {
      $('change-log').textContent = (data.log || []).join('\\n');
      if (!res.ok) {
        $('change-error').textContent = (data.error || 'Something went wrong. Try again.') + (data.hint ? ' ' + data.hint : '');
        $('change-error').hidden = false;
        return null;
      }
      kit.state = data.state;
      kit.secrets = Object.assign({}, data.secrets, { keys: kit.secrets.keys });
      kitChanged = true;
      $('change-warnings').textContent = (data.warnings || []).join(' ');
      drawChange();
      return data;
    });
  });
}
function openChosenKit() {
  var file = $('change-kit').files[0];
  if (!file) return;
  var passphrase = $('change-kit-passphrase').value;
  file.text().then(function (text) {
    kitFile = JSON.parse(text);
    if (kitFile.format !== 'swarm-recovery-kit') return kitFile;
    if (!passphrase) throw new Error('passphrase');
    return openSealedKit(kitFile, passphrase).catch(function () { throw new Error('wrong'); });
  }).then(function (parsed) {
    if (!parsed.state || !parsed.secrets || !parsed.secrets.keys) throw new Error('incomplete');
    kit = { state: parsed.state, secrets: parsed.secrets };
    kitMeta = {
      what: kitFile.what || 'The recovery kit for your Swarm install, encrypted under the passphrase you chose.',
      createdAt: new Date().toISOString(),
      domain: kitFile.domain || null,
    };
    kitChanged = false;
    $('change-error').hidden = true;
    drawChange();
  }).catch(function (error) {
    kit = null;
    $('change-error').textContent = error.message === 'passphrase'
      ? "Enter the kit's passphrase, then choose Open the kit."
      : error.message === 'wrong'
        ? "That passphrase doesn't open this kit."
        : "This doesn't look like a recovery kit. Use the file the setup page gave you.";
    $('change-error').hidden = false;
    drawChange();
  });
}
$('change-kit').addEventListener('change', openChosenKit);
$('change-kit-open').addEventListener('click', openChosenKit);
document.querySelectorAll('input[name=change-provider]').forEach(function (input) {
  input.addEventListener('change', drawChange);
});
$('change-begin').addEventListener('click', function () {
  var chosen = changeService();
  var mail = { provider: chosen, region: $('change-region').value };
  if (chosen === 'ses') {
    mail.accessKeyId = $('change-aws-id').value.trim();
    mail.secretAccessKey = $('change-aws-secret').value.trim();
    mail.requestProductionAccess = $('change-production').checked;
  } else {
    mail.apiKey = $('change-key').value.trim();
  }
  changeAction('prepare', { mail: mail });
});
$('change-check').addEventListener('click', function () { changeAction('status'); });
$('change-cutover').addEventListener('click', function () {
  changeAction('cutover', {
    acknowledged: $('change-ack').checked,
    accessKeyId: $('change-move-aws-id').value.trim(),
    secretAccessKey: $('change-move-aws-secret').value.trim(),
  });
});
$('change-cancel').addEventListener('click', function () { changeAction('cancel'); });
$('change-rollback').addEventListener('click', function () { changeAction('rollback'); });
$('change-finish').addEventListener('click', function () { changeAction('finish'); });
$('change-save').addEventListener('click', function () {
  var passphrase = $('change-kit-passphrase').value;
  if (passphrase.length < 12) {
    $('change-error').textContent = 'Enter a kit passphrase of at least 12 characters: the updated kit is sealed under it.';
    $('change-error').hidden = false;
    return;
  }
  sealOpenKit(kit, passphrase, kitMeta).then(function (sealed) {
    saveFile(sealed);
    kitChanged = false;
    drawChange();
  });
});
$('retry-button').addEventListener('click', function () { $('retry').hidden = true; advance(); });

submitting($('login-form'), function () {
  return api('POST', '/api/login', { password: $('password').value }).then(function () {
    $('password').value = '';
    return resume();
  });
});
submitting($('connect-form'), function () {
  var token = $('token').value.trim();
  $('missing').hidden = true;
  return api('POST', '/api/connect', { token: token }).then(function (found) {
    if (found.missing.length) {
      var list = $('missing-list');
      list.textContent = '';
      found.missing.forEach(function (row) {
        var li = document.createElement('li');
        li.textContent = row;
        list.appendChild(li);
      });
      $('missing').hidden = false;
      return;
    }
    if (!found.zones.length) throw new Error('This Cloudflare account has no domains yet. Add one, then try again.');
    cloudflareToken = token;
    $('token').value = '';
    options($('zone'), found.zones.map(function (z) { return { value: z.name, label: z.name }; }));
    options($('account'), found.accounts.map(function (a) { return { value: a.id, label: a.name }; }));
    $('account-field').hidden = found.accounts.length < 2;
    addressesChanged();
    show('details');
  });
});
submitting($('details-form'), function () {
  var chosen = provider();
  var mail = { provider: chosen };
  if (chosen === 'smtp') {
    mail.host = $('smtp-host').value.trim();
    mail.port = $('smtp-port').value;
    mail.username = $('smtp-username').value;
    mail.password = $('smtp-password').value;
    mail.dkimSelector = $('smtp-selector').value.trim();
  } else if (chosen === 'ses') {
    mail.accessKeyId = $('aws-access-key').value.trim();
    mail.secretAccessKey = $('aws-secret-key').value.trim();
    mail.region = $('region').value;
    mail.requestProductionAccess = $('production-access').checked;
  } else {
    mail.apiKey = $('api-key').value.trim();
    if (REGIONS[chosen]) mail.region = $('region').value;
  }
  return api('POST', '/api/begin', {
    token: cloudflareToken,
    account: $('account').value,
    zone: $('zone').value,
    ownerName: $('owner-name').value.trim(),
    ownerEmail: $('owner-email').value.trim(),
    publicationName: $('publication-name').value.trim(),
    publicationSlug: $('publication-slug').value.trim(),
    publicationAt: publicationAt(),
    dashboard: $('dashboard').value.trim(),
    mail: mail,
  }).then(function (progress) {
    cloudflareToken = '';
    render(progress);
    if (running(progress)) advance();
  });
});
submitting($('token-form'), function () {
  return api('POST', '/api/token', { token: $('replacement-token').value.trim() }).then(function (progress) {
    $('replacement-token').value = '';
    $('new-token').open = false;
    render(progress);
    if (running(progress)) advance();
  });
});
submitting($('aws-key-form'), function () {
  return api('POST', '/api/aws-key', {
    accessKeyId: $('replacement-aws-access-key').value.trim(),
    secretAccessKey: $('replacement-aws-secret-key').value.trim(),
  }).then(function (progress) {
    $('replacement-aws-access-key').value = '';
    $('replacement-aws-secret-key').value = '';
    render(progress);
    if (running(progress)) advance();
  });
});
submitting($('approve-form'), function () {
  var offer = lastProgress && lastProgress.offer;
  if (!offer) return;
  return api('POST', '/api/approve', { version: offer.version, digest: offer.digest }).then(function (progress) {
    $('approve-check').checked = false;
    render(progress);
    if (running(progress)) advance();
  }).catch(function (error) {
    // The offer changed under the page: show the new one, approved by nobody.
    return api('GET', '/api/status').then(render).then(function () { throw error; });
  });
});
$('replace-release').addEventListener('click', function () {
  api('POST', '/api/replace-release').then(render).catch(function (error) { showError(error.message); });
});
submitting($('kit-download-form'), function () {
  var passphrase = $('kit-passphrase').value;
  if (passphrase !== $('kit-passphrase-again').value) throw new Error('The two passphrases differ.');
  return api('POST', '/api/recovery-kit', { passphrase: passphrase }).then(function (sealed) {
    saveFile(sealed);
    $('kit-passphrase').value = '';
    $('kit-passphrase-again').value = '';
  });
});
$('end-sessions').addEventListener('click', function () {
  api('POST', '/api/sessions/end', {}).then(function () { show('login'); }).catch(function (error) {
    showError(error.message);
  });
});
submitting($('kit-form'), function () {
  return api('POST', '/api/finish').then(render);
});

api('GET', '/api/status').then(function (progress) {
  if (!render(progress)) show('welcome');
  else if (running(progress)) advance();
}).catch(function (error) {
  show('login');
  if (error.status !== 401) showError(error.message);
});
`;
