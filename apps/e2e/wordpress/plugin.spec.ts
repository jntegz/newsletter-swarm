// An administrator connects the plugin, publishes a form, a visitor subscribes through it, an agent
// reaches Swarm through the site, Swarm goes away, and the plugin is uninstalled. docs/wordpress.md.
import { Buffer } from 'node:buffer';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API, enableWorkspaceFlag, signIn } from '../tests/helpers';

const WP = 'http://127.0.0.1:9411';
const DASHBOARD = 'http://localhost:5273';
const SETTINGS = `${WP}/wp-admin/options-general.php?page=swarm-newsletter`;

async function swarm<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(`${DASHBOARD}${path}`, {
    method,
    headers: { origin: DASHBOARD, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { data }),
  });
  expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
  return ((await res.json()) as { data: T }).data;
}

const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'WordPress test agent', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

const mcp = (
  request: APIRequestContext,
  url: string,
  authorization: string,
  method: string,
  params: Record<string, unknown> = {},
) =>
  request.post(url, {
    headers: {
      authorization,
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
      ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
    },
    data: { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: META } },
  });

test('the plugin, from connecting to uninstalling', async ({ page, request, browser }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();

  const versions = (await (
    await request.post(`${WP}/?rest_route=/swarm-test/v1/versions`)
  ).json()) as { php: string; wp: string };
  console.log(`WordPress ${versions.wp}, PHP ${versions.php}`);
  if (process.env.WP_VERSION) expect(versions.wp).toMatch(new RegExp(`^${process.env.WP_VERSION}`));
  if (process.env.PHP_VERSION) {
    expect(versions.php).toMatch(new RegExp(`^${process.env.PHP_VERSION}`));
  }

  // ---- In Swarm: a publication, a published form and a key ------------------------------------
  const swarmPage = await (await browser.newContext()).newPage();
  await swarmPage.goto(DASHBOARD);
  await signIn(swarmPage, request, `wp-${stamp}@example.com`);
  const me = await swarm<{ workspaces: { id: string }[] }>(
    swarmPage,
    'GET',
    '/api/v1/auth/session',
  );
  const workspaceId = me.workspaces[0]!.id;
  enableWorkspaceFlag('open_operator_mcp', workspaceId);
  const channel = await swarm<{ id: string }>(
    swarmPage,
    'POST',
    `/api/v1/workspaces/${workspaceId}/channels`,
    { name: 'Field Notes', slug: `wp-${stamp.toString(36)}` },
  );
  const form = await swarm<{ id: string }>(
    swarmPage,
    'POST',
    `/api/v1/channels/${channel.id}/capture-forms`,
    { name: 'Footer form' },
  );
  await swarm(swarmPage, 'POST', `/api/v1/capture-forms/${form.id}/publish`);
  const { secret } = await swarm<{ secret: string }>(
    swarmPage,
    'POST',
    `/api/v1/workspaces/${workspaceId}/api-keys`,
    { name: 'WordPress', scopes: ['channels:read', 'forms:read'], surface: 'both' },
  );
  // The bridge forwards with an agent key of its own, which works on /mcp only.
  const { secret: agentSecret } = await swarm<{ secret: string }>(
    swarmPage,
    'POST',
    `/api/v1/workspaces/${workspaceId}/api-keys`,
    { name: 'WordPress agents', scopes: ['channels:read', 'dispatches:write'], surface: 'mcp' },
  );

  // ---- In WordPress: sign in and connect ------------------------------------------------------
  // Straight to the settings page: once, landing on the dashboard after login never finished here.
  // It makes network calls of its own, for news and update checks.
  await page.goto(`${WP}/wp-login.php?redirect_to=${encodeURIComponent(SETTINGS)}`);
  await page.getByLabel('Username or Email Address').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('password');
  await page.getByRole('button', { name: 'Log In' }).click();
  await page.waitForURL('**/wp-admin/**');

  await page.getByLabel('Swarm address').fill('http://example.com');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByText('Use an https:// address')).toBeVisible();

  await page.getByLabel('Swarm address').fill(API);
  await page.getByLabel('API key').fill(secret);
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByLabel('Publication')).toBeVisible();
  // The key is never sent back to the page.
  expect(await page.content()).not.toContain(secret);

  await page.getByLabel('Publication').selectOption(channel.id);
  await page.getByRole('button', { name: 'Save Changes' }).click();
  const shortcode = `[swarm_form id="${form.id}"]`;
  await expect(page.getByRole('cell', { name: shortcode })).toBeVisible();

  // ---- Pages: the shortcode, the block, and a bad id ------------------------------------------
  const nonce = await page.evaluate(() =>
    fetch('/wp-admin/admin-ajax.php?action=rest-nonce').then((res) => res.text()),
  );
  const publish = async (title: string, content: string) => {
    const res = await page.request.post(`${WP}/?rest_route=/wp/v2/pages`, {
      headers: { 'x-wp-nonce': nonce },
      data: { title, content, status: 'publish' },
    });
    expect(res.status(), await res.text()).toBe(201);
    return ((await res.json()) as { link: string }).link;
  };
  // The block first: it fetches the form, and the shortcodes below then use that copy. Playground's
  // PHP crashes on any network call inside a shortcode (a bare wp_remote_get does it too, because
  // shortcodes run inside preg_replace_callback); real PHP doesn't. So a shortcode's first fetch
  // can't run here, and the steps that need a fresh fetch below go through the block.
  const blockPage = await publish(
    'Join by block',
    `<!-- wp:swarm-newsletter/form {"formId":"${form.id}"} /-->`,
  );
  const shortcodePage = await publish('Join by shortcode', shortcode);
  const scriptPage = await publish('Join by script', `[swarm_form id="${form.id}" mode="script"]`);
  const badPage = await publish('Bad id', '[swarm_form id="nonsense"]');

  // An editor sees why a form is missing; a visitor doesn't.
  await page.goto(badPage);
  await expect(page.getByText('This form has no valid id')).toBeVisible();

  // ---- A visitor -------------------------------------------------------------------------------
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(badPage);
  await expect(visitor.getByText('This form has no valid id')).toHaveCount(0);

  await visitor.goto(blockPage);
  await expect(visitor.getByRole('button', { name: 'Join' })).toBeVisible();

  await visitor.goto(scriptPage);
  await expect(
    visitor.locator(`script[src*="/v1/${form.id}.js"][integrity][crossorigin="anonymous"]`),
  ).toHaveCount(1);

  await visitor.goto(shortcodePage);
  const trap = visitor.locator('.swarm-nl-form input[name="website"]');
  await expect(trap).toHaveCSS('position', 'absolute');
  expect((await trap.boundingBox())!.x).toBeLessThan(0);

  const email = `wp-reader-${stamp}@example.org`;
  await visitor.getByLabel('Email').fill(email);
  await visitor.getByRole('button', { name: 'Join' }).click();
  // The post goes straight to Swarm's capture address, not through WordPress.
  await expect(visitor.getByRole('heading', { name: 'One more step' })).toBeVisible();
  expect(new URL(visitor.url()).port).toBe('8791');
  await expect(visitor.locator('input[name="cf-turnstile-response"]')).not.toHaveValue('', {
    timeout: 30_000,
  });
  await visitor.getByRole('button', { name: 'Continue' }).click();
  await expect(visitor.getByRole('heading', { name: 'Thank you' })).toBeVisible();
  await expect
    .poll(async () => {
      const pending = await swarm<{ items: { email: string }[] }>(
        swarmPage,
        'GET',
        `/api/v1/channels/${channel.id}/members?status=pending`,
      );
      return pending.items.map((m) => m.email);
    })
    .toContain(email);

  // ---- The block in the editor ----------------------------------------------------------------
  await page.goto(`${WP}/wp-admin/post-new.php?post_type=page`);
  await page.waitForFunction(() => {
    const wp = (window as unknown as { wp?: { blocks?: { getBlockType(n: string): unknown } } }).wp;
    return !!wp?.blocks?.getBlockType('swarm-newsletter/form');
  });
  await page.evaluate((formId) => {
    const { wp } = window as unknown as {
      wp: {
        blocks: { createBlock(name: string, attributes: unknown): unknown };
        data: { dispatch(store: string): { insertBlocks(block: unknown): void } };
      };
    };
    wp.data
      .dispatch('core/block-editor')
      .insertBlocks(wp.blocks.createBlock('swarm-newsletter/form', { formId }));
  }, form.id);
  await expect(
    page.frameLocator('iframe[name="editor-canvas"]').getByRole('button', { name: 'Join' }),
  ).toBeVisible({ timeout: 30_000 });

  // ---- An agent, through the site -------------------------------------------------------------
  const proxy = `${WP}/?rest_route=/swarm-newsletter/v1/mcp`;
  const direct = `${API}/mcp`;
  const bearer = `Bearer ${agentSecret}`;
  expect((await request.post(proxy, { data: {} })).status()).toBe(404);

  await page.goto(SETTINGS);
  await page.getByLabel('Let AI agents reach Swarm through this site').check();
  await page.getByLabel('Agent key', { exact: true }).fill(agentSecret);
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByLabel('Let AI agents reach Swarm through this site')).toBeChecked();

  // Nobody gets in without signing in to WordPress, even with the Swarm key.
  expect((await mcp(request, proxy, bearer, 'tools/list')).status()).toBe(401);

  const password = await page.request.post(
    `${WP}/?rest_route=/wp/v2/users/me/application-passwords`,
    { headers: { 'x-wp-nonce': nonce }, data: { name: 'Test agent' } },
  );
  expect(password.status(), await password.text()).toBe(201);
  const { password: appPassword } = (await password.json()) as { password: string };
  const basic = `Basic ${Buffer.from(`admin:${appPassword}`).toString('base64')}`;

  // Swarm's answer, byte for byte: PHP decoding it would turn {} into [].
  const viaSite = await mcp(request, proxy, basic, 'tools/list');
  expect(viaSite.status(), await viaSite.text()).toBe(200);
  expect(viaSite.headers()['content-type']).toContain('application/json');
  expect(await viaSite.text()).toBe(
    await (await mcp(request, direct, bearer, 'tools/list')).text(),
  );
  expect(viaSite.headers()['ratelimit-limit']).toBeTruthy();

  // The key's scopes still decide.
  const refused = await mcp(request, proxy, basic, 'tools/call', {
    name: 'list_members',
    arguments: { channelId: channel.id },
  });
  expect(refused.status()).toBe(403);
  expect(refused.headers()['www-authenticate']).toBeUndefined();

  // Swarm's approvals still decide: a draft is fine, a send waits for a person.
  const draft = await mcp(request, proxy, basic, 'tools/call', {
    name: 'create_dispatch',
    arguments: { channelId: channel.id, body: { subject: 'Through WordPress' } },
  });
  const dispatchId = (
    (await draft.json()) as { result: { structuredContent: { data: { id: string } } } }
  ).result.structuredContent.data.id;
  const send = await mcp(request, proxy, basic, 'tools/call', {
    name: 'schedule_dispatch',
    arguments: {
      channelId: channel.id,
      dispatchId,
      body: { publishAt: new Date(Date.now() + 86_400_000).toISOString() },
    },
  });
  expect(((await send.json()) as { result: { structuredContent: unknown } }).result).toMatchObject({
    structuredContent: { status: 'pending_approval' },
  });

  // ---- Swarm goes away ------------------------------------------------------------------------
  await page.goto(SETTINGS);
  await page.getByLabel('Swarm address').fill('http://localhost:1');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.locator('.notice-error').first()).toBeVisible();
  // The picker is gone, and saving without it kept the publication.
  await expect(page.getByLabel('Publication')).toHaveCount(0);
  await request.post(`${WP}/?rest_route=/swarm-test/v1/expire`);
  await visitor.goto(blockPage);
  await expect(visitor.getByRole('button', { name: 'Join' })).toBeVisible();

  // ---- The form is deleted in Swarm: it leaves the site ---------------------------------------
  await page.getByLabel('Swarm address').fill(API);
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByLabel('Publication')).toHaveValue(channel.id);
  await swarm(swarmPage, 'DELETE', `/api/v1/capture-forms/${form.id}`).catch(() => undefined);
  await request.post(`${WP}/?rest_route=/swarm-test/v1/expire`);
  await visitor.goto(blockPage);
  await expect(visitor.getByRole('button', { name: 'Join' })).toHaveCount(0);

  // ---- Uninstalling leaves nothing behind, the key included -----------------------------------
  const left = await request.post(`${WP}/?rest_route=/swarm-test/v1/uninstall`);
  expect(await left.json()).toEqual([]);
});
