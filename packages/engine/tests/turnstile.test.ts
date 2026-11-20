import { describe, expect, it } from 'vitest';
import { verifyTurnstileToken } from '../src/turnstile';

const answering = (body: Record<string, unknown>) =>
  (async () => Response.json(body)) as unknown as typeof fetch;

const check = (body: Record<string, unknown>, hostname: string | null = 'forms.example') =>
  verifyTurnstileToken({
    secret: 's',
    token: 't',
    action: 'subscribe',
    hostname,
    fetcher: answering(body),
  });

describe('verifyTurnstileToken', () => {
  it('accepts a passed challenge for the same action and hostname', async () => {
    expect(await check({ success: true, action: 'subscribe', hostname: 'forms.example' })).toBe(
      true,
    );
  });

  it('refuses another action, and a missing one outside development', async () => {
    expect(await check({ success: true, action: 'checkout', hostname: 'forms.example' })).toBe(
      false,
    );
    expect(await check({ success: true, hostname: 'forms.example' })).toBe(false);
    expect(await check({ success: true, action: '', hostname: 'forms.example' })).toBe(false);
  });

  it('accepts a missing action only in development (test keys), never another one', async () => {
    expect(await check({ success: true, hostname: 'example.com' }, null)).toBe(true);
    expect(await check({ success: true, action: 'checkout' }, null)).toBe(false);
  });
});

describe('a pass solved for one thing', () => {
  const forForm = (body: Record<string, unknown>, hostname: string | null = 'forms.example') =>
    verifyTurnstileToken({
      secret: 's',
      token: 't',
      action: 'subscribe',
      hostname,
      cdata: 'cf_form_a',
      fetcher: answering({
        success: true,
        action: 'subscribe',
        hostname: 'forms.example',
        ...body,
      }),
    });

  it('counts only for what it was solved for', async () => {
    expect(await forForm({ cdata: 'cf_form_a' })).toBe(true);
    expect(await forForm({ cdata: 'cf_form_b' })).toBe(false);
    expect(await forForm({})).toBe(false);
  });

  it('is not checked in development, like the hostname', async () => {
    expect(await forForm({}, null)).toBe(true);
  });
});
