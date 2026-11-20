// The vault Worker in the installer: deployed right after realtime and before every caller, with
// only its own keys, no route, its vars from state, each caller's binding pinned to that caller's
// entrypoint in every environment, and a health check that says when a caller can't reach it.
import { readFileSync } from 'node:fs';
import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { renderWorkerConfig, type RenderInput } from '../src/config/render';
import { hostnamesFor } from '../src/hostnames';
import { cutOverLinkKeys, featureWorkers, secretNames, SECRET_MATRIX } from '../src/keys';
import { DEPLOY_ORDER, REPO_ROOT, templatePath, WORKERS } from '../src/paths';
import { INSTALL_STEPS, runSteps } from '../src/steps';
import { checkHealth } from '../src/steps/postdeploy';
import { bindingsFrom } from '../src/wizard/deploy';
import { fakeRun } from './helpers';

const DAY = 86_400_000;
const CALLERS = { api: 'ApiVault', capture: 'CaptureVault', site: 'SiteVault', jobs: 'JobsVault' };

const input = (vault?: RenderInput['vault']): RenderInput => ({
  env: 'production',
  hostnames: hostnamesFor('example.com', 'production'),
  d1Id: '11111111-2222-3333-4444-555555555555',
  kvId: '0123456789abcdef0123456789abcdef',
  turnstileSiteKey: '0x4AAAAAAATestSiteKey',
  mail: { provider: 'resend', region: 'us-east-1' },
  features: { customDomains: false, payments: false, google: false },
  ...(vault ? { vault } : {}),
});

type Block = {
  vars?: Record<string, string>;
  routes?: unknown;
  workers_dev?: boolean;
  preview_urls?: boolean;
  services?: { binding: string; service: string; entrypoint?: string }[];
};
const config = (worker: string) =>
  parse(readFileSync(templatePath(REPO_ROOT, worker as never), 'utf8')) as Block & {
    env: Record<string, Block>;
  };

describe('the vault in the installer', () => {
  it('deploys second, after realtime and before api, capture, site and jobs', async () => {
    expect(DEPLOY_ORDER[0]).toBe('realtime');
    expect(DEPLOY_ORDER[1]).toBe('vault');
    const { ctx, transport } = await fakeRun({});
    await runSteps(ctx, INSTALL_STEPS);
    const order = transport.actions
      .filter((a) => a.startsWith('wrangler deploy'))
      .map((a) => /workers\/(\w+)\/wrangler/.exec(a)?.[1]);
    expect(order.slice(0, 2)).toEqual(['realtime', 'vault']);
  });

  it('holds FIELD_KEYS and the keys it signs links with, and nothing a public worker needs', () => {
    expect([...SECRET_MATRIX.vault].sort()).toEqual(
      [
        'FIELD_KEYS',
        'GOODS_SIGNING_KEYS',
        'MEMBER_KEYS',
        'MEMBER_SIGNING_KEYS',
        'MEMBER_VERIFY_KEYS',
        'SIGNUP_KEYS',
      ].sort(),
    );
    const all = { customDomains: true, payments: true, google: true, debounce: true };
    const names = secretNames('vault', {
      provider: 'ses',
      features: all,
      resendWebhookSecret: true,
    });
    expect(names).toContain('STRIPE_SECRET_KEY');
    expect(names).toContain('DEBOUNCE_API_KEY');
    for (const name of [
      'TURNSTILE_SECRET_KEY',
      'AWS_ACCESS_KEY_ID',
      'CF_API_TOKEN',
      'GOOGLE_CLIENT_SECRET',
    ]) {
      expect(names).not.toContain(name);
    }
    expect(featureWorkers('payments')[0]).toBe('vault');
    expect(featureWorkers('google')).toEqual(['api']);
  });

  it('keeps MEMBER_KEYS for 30 days after the cutover, then drops it', () => {
    const linkKeys = cutOverLinkKeys(1000);
    const ctx = (now: number) => ({
      provider: 'resend' as const,
      features: { customDomains: false, payments: false, google: false },
      resendWebhookSecret: false,
      linkKeys,
      now,
    });
    expect(secretNames('vault', ctx(1000 + 29 * DAY))).toContain('MEMBER_KEYS');
    expect(secretNames('vault', ctx(1000 + 30 * DAY))).not.toContain('MEMBER_KEYS');
    expect(secretNames('vault', ctx(1000 + 30 * DAY))).toContain('FIELD_KEYS');
  });

  it('has no route, no workers.dev name and no preview URL in any environment', () => {
    const vault = config('vault');
    for (const block of [vault, vault.env.staging, vault.env.production] as Block[]) {
      expect(block.workers_dev).toBe(false);
      expect(block.preview_urls).toBe(false);
      expect(block.routes).toBeUndefined();
    }
    const rendered = parse(
      renderWorkerConfig('vault', readFileSync(templatePath(REPO_ROOT, 'vault'), 'utf8'), input()),
    ) as {
      env: Record<string, Block>;
    };
    expect(rendered.env.production?.routes).toBeUndefined();
  });

  it('renders how it seals from state, legacy and open by default', () => {
    const template = readFileSync(templatePath(REPO_ROOT, 'vault'), 'utf8');
    const vars = (given?: RenderInput['vault']) =>
      (parse(renderWorkerConfig('vault', template, input(given))) as { env: Record<string, Block> })
        .env.production?.vars;
    expect(vars()).toMatchObject({
      ENVIRONMENT: 'production',
      VAULT_WRITE_FORMAT: 'legacy',
      VAULT_LEGACY_OPEN: 'on',
      LINK_SIGNING_MODE: 'v1',
    });
    expect(vars({ writeFormat: 'v3', legacyOpen: false })).toMatchObject({
      VAULT_WRITE_FORMAT: 'v3',
      VAULT_LEGACY_OPEN: 'off',
    });
  });

  it('pins each caller to its own entrypoint in every environment, and nobody else binds to it', () => {
    for (const worker of WORKERS) {
      const block = config(worker);
      const expected = (service: string) =>
        worker in CALLERS
          ? [{ binding: 'VAULT', service, entrypoint: CALLERS[worker as keyof typeof CALLERS] }]
          : undefined;
      expect(block.services, worker).toEqual(expected('swarm-vault-local'));
      expect(block.env.staging?.services, worker).toEqual(expected('swarm-vault-staging'));
      expect(block.env.production?.services, worker).toEqual(expected('swarm-vault'));
    }
  });

  it('uploads the entrypoint with the service binding, as wrangler does', () => {
    expect(
      bindingsFrom(
        { services: [{ binding: 'VAULT', service: 'swarm-vault', entrypoint: 'SiteVault' }] },
        {},
      ),
    ).toEqual([
      { type: 'service', name: 'VAULT', service: 'swarm-vault', entrypoint: 'SiteVault' },
    ]);
    expect(bindingsFrom({ services: [{ binding: 'X', service: 'swarm-x' }] }, {})).toEqual([
      { type: 'service', name: 'X', service: 'swarm-x' },
    ]);
  });

  it('reports a caller that cannot reach the vault as unhealthy, saying so', async () => {
    const { ctx, transport } = await fakeRun({});
    const http = transport.http.bind(transport);
    transport.http = async (request) =>
      request.url.endsWith('/healthz')
        ? {
            status: 503,
            headers: {},
            text: JSON.stringify({
              error: {
                code: 'unavailable',
                message: 'The vault does not answer through this worker.',
              },
            }),
          }
        : http(request);
    const result = await checkHealth(ctx, 'app.example.com');
    expect(result.ok).toBe(false);
    expect(result.problem).toBe('answered 503: The vault does not answer through this worker.');
  });
});
