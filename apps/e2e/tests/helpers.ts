import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const API = 'http://localhost:8787';
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** A valid 2×3 PNG, as bytes. */
export const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000002000000030806000000b9eade810000001149444154789c63f8cfc0f01f8419301800a1790bf54dc49a070000000049454e44ae426082',
  'hex',
);

export async function expectAccessible(page: Page) {
  // Line's buttons fade between states over 150ms. A button enabled just now (its data arrived)
  // would be measured halfway through the fade, so let CSS transitions finish first. Only
  // transitions: a spinner's animation never ends. Axe then judges what a reader actually sees.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a instanceof CSSTransition)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  // Timers never fire in a frame sandboxed without scripts, so axe would wait in one forever. Specs
  // audit what such a frame shows on its own (forms-builder.spec.ts does, for the form preview; the
  // website's design preview is the site's own page, sandboxed but on its own origin).
  const results = await new AxeBuilder({ page })
    .exclude('iframe[sandbox]:not([sandbox~="allow-scripts"])')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

/** Reads the newest link for this address from the local dev mailbox. */
export async function mailLink(
  request: APIRequestContext,
  email: string,
  path: string,
): Promise<string> {
  await expect
    .poll(async () =>
      (await request.get(`${API}/__dev/mail/latest.json?to=${encodeURIComponent(email)}`)).status(),
    )
    .toBe(200);
  const res = await request.get(`${API}/__dev/mail/latest.json?to=${encodeURIComponent(email)}`);
  const { data } = (await res.json()) as { data: { text: string } };
  const link = data.text.match(new RegExp(`https?://\\S+${path}\\S*`))?.[0];
  if (!link) throw new Error(`no ${path} link in mail to ${email}`);
  return link;
}

let signIns = 0;

export async function signIn(page: Page, request: APIRequestContext, email: string) {
  // QuickPass allows 10 requests a minute per client IP, and every test signs in from this
  // machine. Locally the api reads CF-Connecting-IP from the request (Cloudflare's edge sets it
  // in staging and production), so each sign-in comes from its own documentation address.
  const ip = `198.51.100.${(process.pid + signIns++) % 250}`;
  await page.route('**/api/v1/auth/quickpass', (route) =>
    route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': ip } }),
  );
  await page.getByLabel('Email address').fill(email);
  const send = page.getByRole('button', { name: 'Email me a sign-in link' });
  await expect(send).toBeEnabled({ timeout: 20_000 });
  await send.click();
  // The api checks the Turnstile token with Cloudflare first; that call has taken 9s here.
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible({
    timeout: 20_000,
  });
  await page.goto(await mailLink(request, email, '/sign-in/continue'));
  await page.getByRole('button', { name: 'Continue' }).click();
  // The session (or the second-factor step, /sign-in/verify) exists once the app has left the
  // continue page; API calls made straight after the click would otherwise race it.
  await page.waitForURL((url) => url.pathname !== '/sign-in/continue');
}

let signupClients = 0;

/**
 * Sign-ups allow 10 per 10 minutes from one client IP, and locally every browser is the same
 * client, kept across runs. A page that joins through a form gets a documentation address of its
 * own, so a spec doesn't fail because earlier ones used the allowance up.
 */
export async function ownSignupClient(page: Page) {
  const ip = `203.0.113.${(process.pid + signupClients++ * 7 + Date.now()) % 250}`;
  await page.route('http://localhost:8791/v1/*/subscribe', (route) =>
    route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': ip } }),
  );
}

/** From the empty Home of a new workspace: creates a publication and lands on its settings. */
export async function createPublication(page: Page, name: string, slug: string) {
  await page.getByRole('link', { name: 'Create publication' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Address').fill(slug);
  await page.getByRole('button', { name: 'Create publication' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

/** Opens a section from the rail. */
export async function openSection(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('link', { name, exact: true })
    .click();
}

/** Starts a blank post from the "New post" menu and waits for the editor. */
export async function newPost(page: Page) {
  await page.getByRole('button', { name: 'New post' }).first().click();
  await page.getByRole('button', { name: /^Blank post/ }).click();
  await expect(page.getByRole('textbox', { name: 'Post body' })).toBeVisible();
}

/** Signs out from the person menu, the last menu button in the rail. */
export async function signOut(page: Page) {
  await page
    .getByRole('complementary', { name: 'Main navigation' })
    .locator('button[aria-expanded]')
    .last()
    .click();
  await page.getByRole('button', { name: 'Sign out' }).click();
}

/** The editor's right panel, with the send route. */
export const postSettings = (page: Page) =>
  page.getByRole('complementary', { name: 'Post settings' });

/** Opens one stop of the send route (Write, Who gets it, Check & send) unless it is open. */
export async function openStop(page: Page, title: 'Write' | 'Who gets it' | 'Check & send') {
  const header = postSettings(page).getByRole('button', { name: new RegExp(`^${title}`) });
  // Until a stop is opened by hand, the open one follows the current stop, and moves when the
  // pre-send checks arrive (SendRoute.tsx). A stop that is only open by default can close a moment
  // later, so close it if it is open and open it by hand, which pins it.
  await expect(async () => {
    if ((await header.getAttribute('aria-expanded')) === 'true') await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'false', { timeout: 1000 });
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'true', { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
}

/** Opens the editor panel's collapsed "More options" (Copilot, website, tests, history, delete). */
export async function openMoreOptions(page: Page) {
  const more = postSettings(page).locator('details', { hasText: 'More options' });
  if ((await more.getAttribute('open')) === null) await more.locator('summary').click();
}

/** The post editor's body. */
export const postBody = (page: Page) => page.getByRole('textbox', { name: 'Post body' });

/** Waits for the autosave: the status reads "All changes saved", then "Saved 14:02" after a save. */
export async function expectPostSaved(page: Page) {
  await expect(
    page.getByRole('status').filter({ hasText: /^(All changes saved|Saved \d\d:\d\d)$/ }),
  ).toBeVisible({ timeout: 15_000 });
}

/** Picks a block from the formatting toolbar's Insert menu. */
export async function insertBlock(page: Page, name: string) {
  const toolbar = page.getByRole('toolbar', { name: 'Formatting' });
  await toolbar.getByRole('button', { name: 'Insert', exact: true }).click();
  await toolbar.getByRole('button', { name, exact: true }).click();
}

/** Chooses Everyone in "Who gets it", which moves the send route on to "Check & send". */
export async function chooseEveryone(page: Page) {
  await openStop(page, 'Who gets it');
  await postSettings(page).getByRole('radio', { name: 'Everyone', exact: true }).check();
  await expect(postSettings(page).getByRole('button', { name: /^Check & send/ })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
}

/** From the "Check & send" stop: presses send, reads the exact count back and confirms. */
export async function sendNow(page: Page, count: number) {
  const route = postSettings(page);
  const send = route.getByRole('button', {
    name: `Send to ${count} subscriber${count === 1 ? '' : 's'}`,
  });
  await expect(send).toBeEnabled({ timeout: 15_000 });
  await send.click();
  const confirm = route.getByRole('group', {
    name: new RegExp(`^Send now to ${count} subscriber${count === 1 ? '' : 's'}\\?`),
  });
  await expect(confirm).toBeVisible();
  await expectAccessible(page);
  await confirm.getByRole('button', { name: 'Confirm' }).click();
}

/**
 * Runs SQL against the local D1 the dev workers use. Wrangler opens the same database file from a
 * second process, so it can find the file locked by a worker in the middle of a write; try again.
 */
export function localSql(sql: string) {
  // From a file: a long statement doesn't fit a Windows command line, and cmd.exe mangles quotes.
  const dir = mkdtempSync(join(tmpdir(), 'swarm-e2e-sql-'));
  const file = join(dir, 'statement.sql');
  writeFileSync(file, sql);
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync(
        'pnpm',
        [
          '--filter',
          '@swarm/api',
          'exec',
          'wrangler',
          'd1',
          'execute',
          'DB',
          '--local',
          '--persist-to',
          '../../.wrangler/state',
          '--file',
          file,
        ],
        { cwd: ROOT, stdio: 'pipe', shell: process.platform === 'win32' },
      );
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 5 || !String(error).includes('SQLITE_BUSY')) {
        rmSync(dir, { recursive: true, force: true });
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
}

/**
 * Deletes one key from the KV namespace the local workers share as CACHE (api and site both use
 * the "local" id), so the next request reads D1 again.
 */
export function forgetCached(key: string) {
  execFileSync(
    'pnpm',
    [
      '--filter',
      '@swarm/api',
      'exec',
      'wrangler',
      'kv',
      'key',
      'delete',
      key,
      '--binding',
      'CACHE',
      '--local',
      '--persist-to',
      '../../.wrangler/state',
    ],
    { cwd: ROOT, stdio: 'pipe', shell: process.platform === 'win32' },
  );
}

/** Turns a flag on for one publication, before anything has cached its flags (for a minute). */
export function enableChannelFlag(key: string, channelId: string) {
  localSql(
    `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at) VALUES ('ff_e2e_${key}_${channelId}', '${key}', 'channel', '${channelId}', 1, ${Date.now()})`,
  );
}

/**
 * Lets the publication's workspace run website code on the platform address, as an instance admin
 * would in Settings → Instance (0065_site_code_rules.sql). Without it new scripts are refused there.
 */
export function allowSiteCode(channelId: string) {
  localSql(
    `INSERT INTO site_code_workspaces (workspace_id, created_at) SELECT workspace_id, ${Date.now()} FROM channels WHERE id = '${channelId}' ON CONFLICT (workspace_id) DO NOTHING`,
  );
}

/** Turns a flag on for one workspace, before anything has cached its flags (for a minute). */
export function enableWorkspaceFlag(key: string, workspaceId: string) {
  localSql(
    `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at) VALUES ('ff_e2e_${key}_${workspaceId}', '${key}', 'workspace', '${workspaceId}', 1, ${Date.now()})`,
  );
}

type TrackingSwitch = 'trackOpens' | 'trackClicks' | 'profileReaders';

/**
 * New publications start with open tracking, click tracking and reader profiles off
 * (NEW_CHANNEL_SETTINGS). Turns the given switches on, as an admin does in Sending & delivery >
 * Tracking, for stories about what they record. Runs from the signed-in dashboard page.
 */
export async function turnOnTracking(
  page: Page,
  channelId: string,
  switches: TrackingSwitch[] = ['trackOpens', 'trackClicks', 'profileReaders'],
) {
  const input = Object.fromEntries(switches.map((key) => [key, true]));
  const result = await page.evaluate(
    async ({ channelId, input }) => {
      const res = await fetch(`/api/v1/channels/${channelId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(input),
      });
      return { status: res.status, body: await res.text() };
    },
    { channelId, input },
  );
  expect(result.status, result.body).toBe(200);
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** The code an authenticator app shows for this secret, `steps` 30-second steps from now. */
export function totpCode(secret: string, steps = 0): string {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of secret.replace(/=+$/, '').toUpperCase()) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + steps));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/**
 * Sets up an authenticator app for the signed-in operator, as Settings > Security does, and
 * returns its secret. Creating API keys, webhook endpoints and export destinations needs a second
 * factor of the operator's own; the first one, just added, also counts as a fresh check on this
 * session for the next few minutes.
 */
export async function addAuthenticatorApp(page: Page): Promise<string> {
  const origin = new URL(page.url()).origin;
  const post = async <T>(path: string, data?: unknown) => {
    const res = await page.request.post(`${origin}${path}`, {
      headers: { origin, 'content-type': 'application/json' },
      ...(data === undefined ? {} : { data }),
    });
    expect(res.ok(), `POST ${path}: ${await res.text()}`).toBe(true);
    return ((await res.json()) as { data: T }).data;
  };
  const { secret } = await post<{ secret: string }>('/api/v1/security/totp');
  await post('/api/v1/security/totp/confirm', { code: totpCode(secret) });
  return secret;
}
