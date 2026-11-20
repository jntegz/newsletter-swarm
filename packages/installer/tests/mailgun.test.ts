import { readFileSync } from 'node:fs';
import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { renderInput, renderWorkerConfig } from '../src/config/render';
import { secretNames, secretValues } from '../src/keys';
import { REPO_ROOT, templatePath } from '../src/paths';
import { MailgunRest, mailgunSigningKey, mailgunZoneRecords, multipartBody } from '../src/mailgun';
import { INSTALL_STEPS, runSteps } from '../src/steps';
import { FakeTransport } from '../src/fake';
import { answers, fakeRun } from './helpers';

const mailgunAnswers = (region = 'eu') =>
  answers({
    mail: { provider: 'mailgun', region, mailgunApiKey: 'test-only-mailgun-key' },
  });

describe('a dry-run install with Mailgun', () => {
  it('adds the domain, writes its records and connects the webhooks', async () => {
    const { ctx, transport, output } = await fakeRun({ answers: await mailgunAnswers() });
    await runSteps(ctx, INSTALL_STEPS);

    expect(transport.actions).toContain('GET api.eu.mailgun.net/v5/accounts/http_signing_key');
    expect(transport.mailgunDomains.get('mail.example.com')).toBe('active');
    expect(ctx.state.mailgun).toEqual({ domain: 'mail.example.com', status: 'active' });

    // SPF and DKIM go into the zone; the tracking CNAME doesn't, because tracking is off.
    expect(ctx.state.mailRecords?.map((r) => r.name)).toEqual([
      'mail.example.com',
      'k1._domainkey.mail.example.com',
    ]);

    const endpoint = 'https://events.example.com/mailgun';
    expect([...transport.mailgunWebhooks]).toEqual([
      ['delivered', [endpoint]],
      ['permanent_fail', [endpoint]],
      ['temporary_fail', [endpoint]],
      ['complained', [endpoint]],
    ]);
    expect(output.join('\n')).toContain('Email: Mailgun (EU)');
    // Keys never reach the output.
    expect(output.join('\n')).not.toContain('test-only-mailgun-key');
  });

  it('gives the events worker its signing key on the first deploy', async () => {
    const { ctx } = await fakeRun({ answers: await mailgunAnswers() });
    await runSteps(ctx, INSTALL_STEPS);
    expect((await secretValues('events', ctx.state, ctx.secrets)).MAILGUN_WEBHOOK_SIGNING_KEY).toBe(
      'key-dryrun0000000000000000',
    );
    expect((await secretValues('send', ctx.state, ctx.secrets)).MAILGUN_API_KEY).toBe(
      'test-only-mailgun-key',
    );
    expect((await secretValues('send', ctx.state, ctx.secrets)).RESEND_API_KEY).toBeUndefined();
  });

  it('creates nothing new on a second run, and keeps webhooks others added', async () => {
    const first = await fakeRun({ answers: await mailgunAnswers() });
    first.transport.mailgunWebhooks.set('complained', ['https://other.example/hook']);
    await runSteps(first.ctx, INSTALL_STEPS);
    expect(first.transport.mailgunWebhooks.get('complained')).toEqual([
      'https://other.example/hook',
      'https://events.example.com/mailgun',
    ]);

    const second = await fakeRun({
      answers: await mailgunAnswers(),
      store: first.store,
      transport: first.transport,
    });
    first.transport.actions.length = 0;
    await runSteps(second.ctx, INSTALL_STEPS);
    const writes = first.transport.actions.filter((a) =>
      /^(POST|PUT) api\.eu\.mailgun\.net\/(v4\/domains$|v3\/domains\/[^/]+\/webhooks)/.test(a),
    );
    expect(writes).toEqual([]);
  });

  it('uses the US API for a US account', async () => {
    const { ctx, transport } = await fakeRun({ answers: await mailgunAnswers('us') });
    await runSteps(ctx, INSTALL_STEPS);
    expect(transport.actions).toContain('GET api.mailgun.net/v5/accounts/http_signing_key');
    expect(transport.actions.some((a) => a.includes('api.eu.mailgun.net'))).toBe(false);
  });

  it('refuses a region Mailgun does not have, and a run with no key', async () => {
    const wrong = await fakeRun({ answers: await mailgunAnswers('us-east-1') });
    await expect(runSteps(wrong.ctx, INSTALL_STEPS)).rejects.toThrow(/no region "us-east-1"/);
    const noKey = await fakeRun({
      answers: await answers({ mail: { provider: 'mailgun', region: 'us' } }),
    });
    await expect(runSteps(noKey.ctx, INSTALL_STEPS)).rejects.toThrow(/No Mailgun API key/);
  });
});

describe('Mailgun settings per worker', () => {
  it('lists the key on sending workers and the signing key on events only', () => {
    const features = { customDomains: false, payments: false, google: false };
    const ctx = { provider: 'mailgun' as const, features, resendWebhookSecret: false };
    expect(secretNames('send', ctx)).toContain('MAILGUN_API_KEY');
    expect(secretNames('events', ctx)).toContain('MAILGUN_WEBHOOK_SIGNING_KEY');
    expect(secretNames('events', ctx)).not.toContain('MAILGUN_API_KEY');
    expect(secretNames('track', ctx)).not.toContain('MAILGUN_API_KEY');
  });

  it('renders the Mailgun region and a valid AWS_REGION, and no SES settings', async () => {
    const { ctx } = await fakeRun({ answers: await mailgunAnswers() });
    await runSteps(ctx, INSTALL_STEPS);
    const template = readFileSync(templatePath(REPO_ROOT, 'send'), 'utf8');
    const rendered = parse(renderWorkerConfig('send', template, renderInput(ctx.state))) as {
      env: Record<string, { vars: Record<string, string> }>;
    };
    const vars = rendered.env.production!.vars;
    expect(vars.MAIL_ADAPTER).toBe('mailgun');
    expect(vars.MAILGUN_REGION).toBe('eu');
    expect(vars.AWS_REGION).toBe('eu-west-1');
    expect(Object.keys(vars).filter((k) => k.startsWith('SES_'))).toEqual([]);
  });
});

describe('the Mailgun client', () => {
  it('writes multipart forms, with one part per value', () => {
    const body = multipartBody({
      id: 'delivered',
      url: ['https://a.example', 'https://b.example'],
    });
    expect(body.match(/name="url"/g)).toHaveLength(2);
    expect(body).toContain('name="id"\r\n\r\ndelivered\r\n');
    expect(body.endsWith('--\r\n')).toBe(true);
  });

  it('explains a refused key', async () => {
    const t = new FakeTransport({ zone: 'example.com', environment: 'production' });
    t.http = async () => ({ status: 401, text: 'Forbidden', headers: {} });
    await expect(
      mailgunSigningKey(new MailgunRest(t, 'bad-key-bad-key-bad', 'us')),
    ).rejects.toThrow('Mailgun did not accept the API key.');
  });

  it('adds the domain to relative names and unquotes TXT values', () => {
    expect(
      mailgunZoneRecords('mail.example.com', {
        sending_dns_records: [
          { record_type: 'TXT', name: 'k1._domainkey', value: '"k=rsa; p=A"' },
          { record_type: 'MX', name: 'mail.example.com', value: 'mxa.mailgun.org' },
        ],
      }),
    ).toEqual([
      {
        type: 'TXT',
        name: 'k1._domainkey.mail.example.com',
        content: 'k=rsa; p=A',
        proxied: false,
      },
    ]);
  });
});
