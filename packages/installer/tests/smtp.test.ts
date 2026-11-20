import { readFileSync } from 'node:fs';
import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { renderInput, renderWorkerConfig } from '../src/config/render';
import { secretNames, secretValues } from '../src/keys';
import { REPO_ROOT, templatePath } from '../src/paths';
import { INSTALL_STEPS, runSteps } from '../src/steps';
import { answers, fakeRun } from './helpers';

const PASSWORD = 'test-only-smtp-password';
const smtp = {
  host: 'mail.example.net',
  port: '587',
  username: 'swarm',
  password: PASSWORD,
  dkimSelector: 'sel1',
};
const smtpAnswers = (over: Partial<typeof smtp> = {}) =>
  answers({ mail: { provider: 'smtp', smtp: { ...smtp, ...over } } });

describe('a dry-run install with your own mail server', () => {
  it('says what the server needs, and creates no provider records', async () => {
    const { ctx, output, transport } = await fakeRun({ answers: await smtpAnswers() });
    await runSteps(ctx, INSTALL_STEPS);
    expect(ctx.state.choices?.mail.smtp).toEqual({
      host: 'mail.example.net',
      port: '587',
      dkimSelector: 'sel1',
    });
    expect(ctx.state.mailRecords).toEqual([]);
    const printed = output.join('\n');
    expect(printed).toContain('sel1._domainkey.mail.example.com');
    expect(printed).toContain('Spam complaints: plain SMTP does not report them');
    expect(printed).toContain('Email: your own server mail.example.net');
    expect(printed).not.toContain(PASSWORD);
    expect(printed).not.toContain(ctx.secrets.smtpFeedbackSecret);
    // Bounces come back through Email Routing.
    expect(transport.actions.join('\n')).toContain('/email/routing/rules');
  });

  it('gives the workers the login, and events the signing secret', async () => {
    const { ctx } = await fakeRun({ answers: await smtpAnswers() });
    await runSteps(ctx, INSTALL_STEPS);
    expect(await secretValues('send', ctx.state, ctx.secrets)).toMatchObject({
      SMTP_USERNAME: 'swarm',
      SMTP_PASSWORD: PASSWORD,
    });
    const secret = (await secretValues('events', ctx.state, ctx.secrets)).SMTP_FEEDBACK_SECRET;
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/=]+$/);
  });

  it('keeps the same signing secret on a second run', async () => {
    const first = await fakeRun({ answers: await smtpAnswers() });
    await runSteps(first.ctx, INSTALL_STEPS);
    const secret = first.ctx.secrets.smtpFeedbackSecret;
    const second = await fakeRun({
      answers: await smtpAnswers(),
      store: first.store,
      transport: first.transport,
    });
    await runSteps(second.ctx, INSTALL_STEPS);
    expect(second.ctx.secrets.smtpFeedbackSecret).toBe(secret);
  });

  it('refuses port 25, and a run with no server', async () => {
    const blocked = await fakeRun({ answers: await smtpAnswers({ port: '25' }) });
    await expect(runSteps(blocked.ctx, INSTALL_STEPS)).rejects.toThrow(/port 25/);
    const none = await fakeRun({ answers: await answers({ mail: { provider: 'smtp' } }) });
    await expect(runSteps(none.ctx, INSTALL_STEPS)).rejects.toThrow(/No mail server/);
  });
});

describe('SMTP settings per worker', () => {
  it('lists the login on sending workers and the secret on events only', () => {
    const features = { customDomains: false, payments: false, google: false };
    const ctx = { provider: 'smtp' as const, features, resendWebhookSecret: false };
    expect(secretNames('send', ctx)).toEqual(
      expect.arrayContaining(['SMTP_USERNAME', 'SMTP_PASSWORD']),
    );
    expect(secretNames('events', ctx)).toContain('SMTP_FEEDBACK_SECRET');
    expect(secretNames('events', ctx)).not.toContain('SMTP_PASSWORD');
    expect(secretNames('track', ctx)).not.toContain('SMTP_PASSWORD');
  });

  it('renders the server and a valid AWS_REGION, and no SES settings', async () => {
    const { ctx } = await fakeRun({ answers: await smtpAnswers() });
    await runSteps(ctx, INSTALL_STEPS);
    const template = readFileSync(templatePath(REPO_ROOT, 'send'), 'utf8');
    const rendered = parse(renderWorkerConfig('send', template, renderInput(ctx.state))) as {
      env: Record<string, { vars: Record<string, string> }>;
    };
    const vars = rendered.env.production!.vars;
    expect(vars).toMatchObject({
      MAIL_ADAPTER: 'smtp',
      SMTP_HOST: 'mail.example.net',
      SMTP_PORT: '587',
      SMTP_DKIM_SELECTOR: 'sel1',
    });
    expect(vars.AWS_REGION).toMatch(/^[a-z]{2}-[a-z]+-\d$/);
    expect(vars.SMTP_PASSWORD).toBeUndefined();
    expect(Object.keys(vars).filter((k) => k.startsWith('SES_'))).toEqual([]);
  });

  it('tells the events worker the relay, whose signed bounces count as hard', async () => {
    const { ctx } = await fakeRun({ answers: await smtpAnswers() });
    await runSteps(ctx, INSTALL_STEPS);
    const template = readFileSync(templatePath(REPO_ROOT, 'events'), 'utf8');
    const rendered = parse(renderWorkerConfig('events', template, renderInput(ctx.state))) as {
      env: Record<string, { vars: Record<string, string> }>;
    };
    expect(rendered.env.production!.vars.SMTP_HOST).toBe('mail.example.net');
    expect(rendered.env.production!.vars.SMTP_BOUNCE_DOMAINS).toBeUndefined();
  });

  it('tells the events worker the domains the relay signs its bounces as, when given', async () => {
    const { ctx } = await fakeRun({
      answers: await answers({
        mail: { provider: 'smtp', smtp: { ...smtp, bounceDomains: 'messagingengine.com' } },
      }),
    });
    await runSteps(ctx, INSTALL_STEPS);
    expect(ctx.state.choices?.mail.smtp?.bounceDomains).toBe('messagingengine.com');
    const template = readFileSync(templatePath(REPO_ROOT, 'events'), 'utf8');
    const rendered = parse(renderWorkerConfig('events', template, renderInput(ctx.state))) as {
      env: Record<string, { vars: Record<string, string> }>;
    };
    expect(rendered.env.production!.vars.SMTP_BOUNCE_DOMAINS).toBe('messagingengine.com');
    const bad = await fakeRun({
      answers: await answers({
        mail: { provider: 'smtp', smtp: { ...smtp, bounceDomains: 'not a domain' } },
      }),
    });
    await expect(runSteps(bad.ctx, INSTALL_STEPS)).rejects.toThrow(/isn't a list of domains/);
  });
});
