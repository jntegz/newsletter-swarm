import { readFileSync } from 'node:fs';
import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { renderInput, renderWorkerConfig } from '../src/config/render';
import { FakeTransport } from '../src/fake';
import { secretNames, secretValues } from '../src/keys';
import { REPO_ROOT, templatePath } from '../src/paths';
import { PostmarkRest, checkedPostmarkServer, postmarkZoneRecords } from '../src/postmark';
import { INSTALL_STEPS, runSteps } from '../src/steps';
import { answers, fakeRun } from './helpers';

const TOKEN = 'test-only-account-token';
const postmarkAnswers = () =>
  answers({ mail: { provider: 'postmark', postmarkAccountToken: TOKEN } });

describe('a dry-run install with Postmark', () => {
  it('sets up the server, stream, domain, records and webhooks', async () => {
    const { ctx, transport, output } = await fakeRun({ answers: await postmarkAnswers() });
    await runSteps(ctx, INSTALL_STEPS);

    expect(transport.postmarkServers.map((s) => s.Name)).toEqual(['swarm-production']);
    expect(transport.postmarkStreams).toEqual([{ ID: 'broadcasts', handling: 'Custom' }]);
    expect(transport.postmarkDomains[0]).toMatchObject({
      Name: 'mail.example.com',
      ReturnPathDomain: 'bounce.mail.example.com',
      DKIMVerified: true,
    });
    expect(ctx.state.postmark).toMatchObject({ dkimVerified: true, unsubscribeHandling: 'Custom' });
    expect(ctx.state.mailRecords).toEqual([
      expect.objectContaining({ type: 'TXT', name: 'dry._domainkey.mail.example.com' }),
      expect.objectContaining({ type: 'CNAME', name: 'bounce.mail.example.com' }),
    ]);

    const endpoint = 'https://events.example.com/postmark';
    expect(transport.postmarkWebhooks.map((w) => [w.MessageStream, w.Url])).toEqual([
      ['outbound', endpoint],
      ['broadcasts', endpoint],
    ]);
    // Only the bulk stream listens for subscription changes.
    expect(transport.postmarkWebhooks[0]!.Triggers.SubscriptionChange).toBeUndefined();
    expect(transport.postmarkWebhooks[1]!.Triggers.SubscriptionChange).toEqual({ Enabled: true });

    const printed = output.join('\n');
    expect(printed).toContain('Email: Postmark');
    expect(printed).not.toContain(TOKEN);
    expect(printed).not.toContain(ctx.secrets.postmarkWebhookSecret);
  });

  it('gives the workers their secrets on the first deploy', async () => {
    const { ctx } = await fakeRun({ answers: await postmarkAnswers() });
    await runSteps(ctx, INSTALL_STEPS);
    const send = await secretValues('send', ctx.state, ctx.secrets);
    expect(send.POSTMARK_SERVER_TOKEN).toBe('server-token-dryrun-0000000000');
    expect(send.POSTMARK_ACCOUNT_TOKEN).toBe(TOKEN);
    expect(send.RESEND_API_KEY).toBeUndefined();
    const secret = (await secretValues('events', ctx.state, ctx.secrets)).POSTMARK_WEBHOOK_SECRET;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('warns and carries on when the account may not use custom unsubscribes', async () => {
    const transport = new FakeTransport({ zone: 'example.com', environment: 'production' });
    transport.postmarkRefusesCustom = true;
    const { ctx, output } = await fakeRun({ answers: await postmarkAnswers(), transport });
    await runSteps(ctx, INSTALL_STEPS);
    expect(transport.postmarkStreams).toEqual([{ ID: 'broadcasts', handling: 'Postmark' }]);
    expect(ctx.state.postmark?.unsubscribeHandling).toBe('Postmark');
    expect(output.join('\n')).toContain('Postmark handles unsubscribes');
  });

  it('creates nothing new on a second run, and keeps the same webhook password', async () => {
    const first = await fakeRun({ answers: await postmarkAnswers() });
    await runSteps(first.ctx, INSTALL_STEPS);
    const secret = first.ctx.secrets.postmarkWebhookSecret;
    const second = await fakeRun({
      answers: await postmarkAnswers(),
      store: first.store,
      transport: first.transport,
    });
    await runSteps(second.ctx, INSTALL_STEPS);
    expect(first.transport.postmarkServers).toHaveLength(1);
    expect(first.transport.postmarkStreams).toHaveLength(1);
    expect(first.transport.postmarkDomains).toHaveLength(1);
    expect(first.transport.postmarkWebhooks).toHaveLength(2);
    expect(second.ctx.secrets.postmarkWebhookSecret).toBe(secret);
  });

  it('refuses a run with no token', async () => {
    const { ctx } = await fakeRun({ answers: await answers({ mail: { provider: 'postmark' } }) });
    await expect(runSteps(ctx, INSTALL_STEPS)).rejects.toThrow(/No Postmark account token/);
  });
});

describe('Postmark settings per worker', () => {
  it('lists the tokens on sending workers and the password on events only', () => {
    const features = { customDomains: false, payments: false, google: false };
    const ctx = { provider: 'postmark' as const, features, resendWebhookSecret: false };
    expect(secretNames('send', ctx)).toEqual(
      expect.arrayContaining(['POSTMARK_SERVER_TOKEN', 'POSTMARK_ACCOUNT_TOKEN']),
    );
    expect(secretNames('events', ctx)).toContain('POSTMARK_WEBHOOK_SECRET');
    expect(secretNames('events', ctx)).not.toContain('POSTMARK_SERVER_TOKEN');
    expect(secretNames('track', ctx)).not.toContain('POSTMARK_ACCOUNT_TOKEN');
  });

  it('renders a valid AWS_REGION and no SES settings', async () => {
    const { ctx } = await fakeRun({ answers: await postmarkAnswers() });
    await runSteps(ctx, INSTALL_STEPS);
    const template = readFileSync(templatePath(REPO_ROOT, 'send'), 'utf8');
    const rendered = parse(renderWorkerConfig('send', template, renderInput(ctx.state))) as {
      env: Record<string, { vars: Record<string, string> }>;
    };
    const vars = rendered.env.production!.vars;
    expect(vars.MAIL_ADAPTER).toBe('postmark');
    expect(vars.AWS_REGION).toMatch(/^[a-z]{2}-[a-z]+-\d$/);
    expect(vars.MAILGUN_REGION).toBeUndefined();
    expect(Object.keys(vars).filter((k) => k.startsWith('SES_'))).toEqual([]);
  });
});

describe('the Postmark client', () => {
  it('explains a refused account token', async () => {
    const t = new FakeTransport({ zone: 'example.com', environment: 'production' });
    t.http = async () => ({ status: 401, text: '{"ErrorCode":10,"Message":"Bad"}', headers: {} });
    await expect(
      checkedPostmarkServer(new PostmarkRest(t, { account: 'bad' }), 'swarm-production'),
    ).rejects.toThrow('Postmark did not accept the account token.');
  });

  it('prefers the pending DKIM record over the current one', () => {
    expect(
      postmarkZoneRecords({
        ID: 1,
        Name: 'mail.example.com',
        DKIMHost: 'old._domainkey.mail.example.com',
        DKIMTextValue: 'old',
        DKIMPendingHost: 'new._domainkey.mail.example.com',
        DKIMPendingTextValue: 'new',
      }),
    ).toEqual([
      { type: 'TXT', name: 'new._domainkey.mail.example.com', content: 'new', proxied: false },
    ]);
  });
});
