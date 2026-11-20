import { readFileSync } from 'node:fs';
import { findNodeAtLocation, parse, parseTree } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { assertNoPlaceholders, renderWorkerConfig, type RenderInput } from '../src/config/render';
import { hostnamesFor } from '../src/hostnames';
import { templatePath, REPO_ROOT, WORKERS, type Worker } from '../src/paths';

const template = (worker: Worker) => readFileSync(templatePath(REPO_ROOT, worker), 'utf8');

const base = {
  d1Id: '11111111-2222-3333-4444-555555555555',
  kvId: '0123456789abcdef0123456789abcdef',
  turnstileSiteKey: '0x4AAAAAAATestSiteKey',
  features: { customDomains: false, payments: false, google: false },
};

const inputs: Record<string, RenderInput> = {
  ses: {
    ...base,
    env: 'production',
    hostnames: hostnamesFor('example.com', 'production'),
    mail: {
      provider: 'ses',
      region: 'eu-west-1',
      topicArn: 'arn:aws:sns:eu-west-1:123456789012:swarm-production-ses-events',
    },
  },
  resend: {
    ...base,
    env: 'production',
    hostnames: hostnamesFor('example.com', 'production'),
    mail: { provider: 'resend', region: 'us-east-1' },
  },
};

/** The exact source text of env.<name>. */
function blockText(text: string, env: string) {
  const node = findNodeAtLocation(parseTree(text)!, ['env', env])!;
  return text.slice(node.offset, node.offset + node.length);
}

const block = (text: string, env = 'production') =>
  (parse(text) as { env: Record<string, Record<string, unknown>> }).env[env] as Record<
    string,
    unknown
  > & {
    vars: Record<string, string>;
  };

for (const [provider, input] of Object.entries(inputs)) {
  describe(`render with ${provider}`, () => {
    for (const worker of WORKERS) {
      it(`${worker}: only the production block changes, comments stay, no placeholders`, () => {
        const source = template(worker);
        const rendered = renderWorkerConfig(worker, source, input);
        // Snapshots use LF, so a CRLF checkout (Windows) and an LF one (CI) agree.
        expect(rendered.replaceAll('\r\n', '\n')).toMatchSnapshot();
        expect(blockText(rendered, 'staging')).toBe(blockText(source, 'staging'));
        const sourceDefault = { ...(parse(source) as Record<string, unknown>), env: undefined };
        const renderedDefault = { ...(parse(rendered) as Record<string, unknown>), env: undefined };
        expect(renderedDefault).toEqual(sourceDefault);
        const comments = source.split(/\r?\n/).filter((line) => line.trim().startsWith('//'));
        for (const comment of comments) expect(rendered).toContain(comment);
        expect(() => assertNoPlaceholders(worker, rendered, 'production')).not.toThrow();
        // wrangler deploy turns the workers.dev hostname and preview URLs off from these.
        expect(block(rendered)).toMatchObject({ workers_dev: false, preview_urls: false });
        expect(renderWorkerConfig(worker, source, input)).toBe(rendered);
      });
    }

    it('the committed production blocks do have placeholders', () => {
      expect(() => assertNoPlaceholders('api', template('api'), 'production')).toThrow(
        /unprovisioned/,
      );
    });
  });
}

describe('render details', () => {
  it('fills hostnames, ids and routes', () => {
    const api = block(renderWorkerConfig('api', template('api'), inputs.resend!));
    expect(api.vars.APP_ORIGIN).toBe('https://app.example.com');
    expect(api.vars.PLATFORM_SITE_DOMAIN).toBe('example.com');
    expect(api.vars.SITE_FALLBACK_ORIGIN).toBe('sites.example.com');
    expect(api.vars.MAIL_FROM).toBe('signin@mail.example.com');
    expect(api.vars.LINK_HOSTNAMES).toBe('off');
    expect(api.vars.WEB_HOSTNAMES).toBe('off');
    expect(api.vars.PAYMENTS).toBe('off');
    expect(api.routes).toEqual([{ pattern: 'app.example.com/*', zone_name: 'example.com' }]);
    expect((api.d1_databases as { database_id: string }[])[0]?.database_id).toBe(base.d1Id);
    const site = block(renderWorkerConfig('site', template('site'), inputs.resend!));
    expect(site.routes).toEqual([
      { pattern: 'media.example.com/*', zone_name: 'example.com' },
      { pattern: '*.example.com/*', zone_name: 'example.com' },
    ]);
  });

  it('removes the SES variables with Resend and keeps them with SES', () => {
    for (const worker of ['api', 'send', 'jobs', 'capture', 'site'] as const) {
      const resend = block(renderWorkerConfig(worker, template(worker), inputs.resend!)).vars;
      expect(Object.keys(resend).filter((k) => k.startsWith('SES_'))).toEqual([]);
      expect(resend.MAIL_ADAPTER).toBe('resend');
    }
    expect(
      block(renderWorkerConfig('events', template('events'), inputs.resend!)).vars.SNS_TOPIC_ARNS,
    ).toBeUndefined();
    const api = block(renderWorkerConfig('api', template('api'), inputs.ses!)).vars;
    expect(api.SES_EVENT_TOPIC_ARN).toBe(inputs.ses!.mail.topicArn);
    expect(api.SES_DIRECT_CONFIGURATION_SET).toBe('swarm-production-direct');
    expect(
      block(renderWorkerConfig('send', template('send'), inputs.ses!)).vars.SES_CONFIGURATION_SET,
    ).toBe('swarm-production-broadcasts');
  });

  it('custom domains switch the site route to */* and the hostname modes to cloudflare', () => {
    const input = {
      ...inputs.resend!,
      features: { customDomains: true, payments: true, google: false },
    };
    const site = block(renderWorkerConfig('site', template('site'), input));
    expect(site.routes).toEqual([
      { pattern: 'media.example.com/*', zone_name: 'example.com' },
      { pattern: '*/*', zone_name: 'example.com' },
    ]);
    expect(site.vars.PAYMENTS).toBe('stripe');
    const api = block(renderWorkerConfig('api', template('api'), input)).vars;
    expect(api.LINK_HOSTNAMES).toBe('cloudflare');
    expect(api.WEB_HOSTNAMES).toBe('cloudflare');
  });

  it('staging renders only the staging block, with prefixed hosts and no wildcard', () => {
    const input: RenderInput = {
      ...inputs.resend!,
      env: 'staging',
      hostnames: hostnamesFor('example.com', 'staging'),
    };
    const source = template('site');
    const rendered = renderWorkerConfig('site', source, input);
    expect(blockText(rendered, 'production')).toBe(blockText(source, 'production'));
    const site = block(rendered, 'staging');
    expect(site.routes).toEqual([
      { pattern: 'staging-media.example.com/*', zone_name: 'example.com' },
    ]);
    expect(site.vars.ENVIRONMENT).toBe('staging');
    expect(() => assertNoPlaceholders('site', rendered, 'staging')).not.toThrow();
  });
});
