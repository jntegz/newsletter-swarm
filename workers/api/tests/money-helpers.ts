import { env } from 'cloudflare:test';
import type { Member } from '@swarm/domain';
import { DevStripe } from '@swarm/engine';
import type { FlagKey } from '@swarm/flags';
import { expect } from 'vitest';
import { useStripeForTests } from '../src/lib/levels';
import { call, json, uniqueEmail, type Session } from './helpers';

export async function data<T>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await json<{ data: T }>(res)).data;
}

export async function errorCode(res: Response): Promise<string> {
  return (await json<{ error: { code: string } }>(res)).error.code;
}

/** A fresh Stripe fake for the worker; returns it so a test can read its calls. */
export function freshStripe(): DevStripe {
  const stripe = new DevStripe();
  useStripeForTests(stripe);
  return stripe;
}

export async function enableFlag(key: FlagKey, workspaceId: string, channelId: string) {
  await env.DB.prepare(
    `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at) VALUES (?1, ?2, 'channel', ?3, 1, 0)`,
  )
    .bind(`ff_${crypto.randomUUID().replace(/-/g, '')}`, key, channelId)
    .run();
  await env.CACHE.delete(`flags:v1:${workspaceId}:${channelId}`);
}

/** A connected Stripe account for the Channel, as the Connect flow would leave it. */
export async function connectAccount(
  session: Session,
  channelId: string,
  options: { chargesEnabled?: boolean; currency?: string | null } = {},
): Promise<string> {
  const accountId = `acct_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO stripe_accounts (channel_id, workspace_id, stripe_account_id, charges_enabled,
       default_currency, connected_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
  )
    .bind(
      channelId,
      session.workspaceId,
      accountId,
      options.chargesEnabled === false ? 0 : 1,
      options.currency === undefined ? 'usd' : options.currency,
      now,
    )
    .run();
  return accountId;
}

export async function addMember(s: Session, channelId: string, email = uniqueEmail('member')) {
  return data<Member>(
    await call('POST', `/api/v1/channels/${channelId}/members`, {
      cookie: s.cookie,
      body: { email, consent: true },
    }),
    201,
  );
}

export const levelBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'Supporter',
  description: 'Every Dispatch in full',
  benefits: ['Every Dispatch in full', 'The archive'],
  prices: [
    { interval: 'month', amount: 800 },
    { interval: 'year', amount: 8000 },
  ],
  ...overrides,
});
