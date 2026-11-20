// Deliverability: one sending domain's records, warm-up, rates and DMARC together.
import { env } from 'cloudflare:test';
import type { DomainHealth } from '@swarm/domain';
import { newId } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { call, createChannel, json, signIn, type Session } from './helpers';

describe('a sending domain’s health', () => {
  async function domainOf(owner: Session) {
    const { id: channelId } = await createChannel(owner);
    const name = `news-${crypto.randomUUID().slice(0, 8)}.example.com`;
    const { data } = await json<{ data: { id: string } }>(
      await call('POST', `/api/v1/channels/${channelId}/sending-domains`, {
        cookie: owner.cookie,
        body: { domain: name, kind: 'email' },
      }),
    );
    return { id: data.id, name, channelId };
  }
  const read = (id: string, cookie: string) =>
    call('GET', `/api/v1/sending-domains/${id}/health`, { cookie });

  it('has no rates at all before anything is sent, rather than a flattering 0%', async () => {
    const owner = await signIn();
    const domain = await domainOf(owner);
    const res = await read(domain.id, owner.cookie);
    expect(res.status).toBe(200);
    const { data } = await json<{ data: DomainHealth }>(res);
    expect(data.domain).toBe(domain.name);
    expect(data.ramp).toBeNull();
    expect(data.sending).toEqual({
      sent: 0,
      bounces: 0,
      complaints: 0,
      bounceRate: null,
      complaintRate: null,
    });
    expect(data.dmarc.alignmentRate).toBeNull();
    expect(data.records.find((r) => r.purpose === 'dmarc')?.state).toBe('ok');
    expect(data.records.find((r) => r.type === 'MX')?.state).toBe('missing');
  });

  it('adds up the domain’s own warm-up days, and only those in range', async () => {
    const owner = await signIn();
    const domain = await domainOf(owner);
    const other = await domainOf(owner);
    const today = new Date().toISOString().slice(0, 10);
    const ramp = async (domainId: string, channelId: string, sent: number) => {
      const id = newId('reputationRamp');
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO reputation_ramps (id, channel_id, sending_domain_id, status, day, cap_today, start_cap, growth, max_cap,
             bounce_threshold, complaint_threshold, created_at, updated_at)
           VALUES (?1, ?2, ?3, 'warming', ?4, 300, 200, 1.5, 1000, 0.02, 0.0008, 1, 1)`,
        ).bind(id, channelId, domainId, today),
        env.DB.prepare(
          `INSERT INTO reputation_ramp_days (ramp_id, day, cap, sent, bounces, complaints) VALUES (?1, ?2, 200, ?3, 4, 1)`,
        ).bind(id, today, sent),
        // Long before any range the page asks for.
        env.DB.prepare(
          `INSERT INTO reputation_ramp_days (ramp_id, day, cap, sent, bounces, complaints) VALUES (?1, '2001-01-01', 200, 9999, 999, 999)`,
        ).bind(id),
      ]);
    };
    await ramp(domain.id, domain.channelId, 200);
    await ramp(other.id, other.channelId, 7);
    const { data } = await json<{ data: DomainHealth }>(await read(domain.id, owner.cookie));
    expect(data.ramp).toEqual({ status: 'warming', pausedReason: null, capToday: 300 });
    expect(data.sending).toEqual({
      sent: 200,
      bounces: 4,
      complaints: 1,
      bounceRate: 0.02,
      complaintRate: 0.005,
    });
  });

  it('is only for people with access to the publication', async () => {
    const owner = await signIn();
    const domain = await domainOf(owner);
    expect((await call('GET', `/api/v1/sending-domains/${domain.id}/health`)).status).toBe(401);
    const stranger = await signIn();
    expect((await read(domain.id, stranger.cookie)).status).toBe(404);
  });

  it('has no health for a branded link domain', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    const created = await call('POST', `/api/v1/channels/${channelId}/sending-domains`, {
      cookie: owner.cookie,
      body: { domain: `links-${crypto.randomUUID().slice(0, 8)}.example.com`, kind: 'link' },
    });
    if (created.status !== 201) return; // Link domains are off in this environment.
    const { data } = await json<{ data: { id: string } }>(created);
    expect((await read(data.id, owner.cookie)).status).toBe(404);
  });
});
