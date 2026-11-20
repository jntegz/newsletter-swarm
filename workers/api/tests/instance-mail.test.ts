// Settings → Instance: the email service, its records, and whether reports are coming back.
import { env } from 'cloudflare:test';
import type { CheckedSendingDomain, InstanceMail } from '@swarm/domain';
import { newId } from '@swarm/domain';
import { feedbackHealth, mailServiceStatus } from '@swarm/engine';
import {
  DevDomainIdentities,
  HOLD_UNREGISTERED_SQL,
  REWARM_SQL,
  SWAP_DOMAINS_SQL,
  rewarmDays,
  type DnsLookup,
  type DomainIdentities,
} from '@swarm/mail';
import { describe, expect, it } from 'vitest';
import { call, createChannel, freshFactor, json, signIn, type Session } from './helpers';

const URL_MAIL = '/api/v1/instance/mail';
const HOUR = 3_600_000;

async function makeAdmin(session: Session) {
  await env.DB.prepare('INSERT INTO instance_admins (operator_id, created_at) VALUES (?1, ?2)')
    .bind(session.me.operator.id, Date.now())
    .run();
  // Instance settings need a factor of the admin's own, freshly proved for a change.
  await freshFactor(session);
}

/** A finished Broadcast with one delivery per status. `when` keeps tests apart in time. */
async function seedBroadcast(session: Session, statuses: string[], completedAt: number) {
  const { id: channelId } = await createChannel(session);
  const dispatch = newId('dispatch');
  const broadcast = newId('broadcast');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at)
       VALUES (?1, ?2, 'S', '{"type":"doc","content":[]}', 'sent', ?3, ?3)`,
    ).bind(dispatch, channelId, completedAt),
    env.DB.prepare(
      `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text,
         from_name, from_address, track_opens, created_at, last_progress_at, completed_at, sent_count)
       VALUES (?1, ?2, ?3, ?4, 'sent', 'S', '', '', '', 'F', 'f@mail.swarm.test', 1, ?5, ?5, ?5, ?6)`,
    ).bind(broadcast, dispatch, channelId, session.workspaceId, completedAt, statuses.length),
    ...statuses.map((status, i) =>
      env.DB.prepare(
        `INSERT INTO deliveries (id, broadcast_id, channel_id, email, status, sent_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      ).bind(newId('delivery'), broadcast, channelId, `r${i}@example.com`, status, completedAt),
    ),
  ]);
}

describe('who can see the email service', () => {
  it('is for instance admins only', async () => {
    expect((await call('GET', URL_MAIL)).status).toBe(401);
    const someone = await signIn();
    expect((await call('GET', URL_MAIL, { cookie: someone.cookie })).status).toBe(403);
  });

  it('shows the service and its records, with what DNS has for each', async () => {
    const admin = await signIn();
    await makeAdmin(admin);
    const res = await call('GET', URL_MAIL, { cookie: admin.cookie });
    expect(res.status).toBe(200);
    const { data } = await json<{ data: InstanceMail }>(res);
    expect(data.service).toBe('dev');
    expect(data.domain).toBe('swarm.localhost');
    expect(data.recordsComplete).toBe(true);
    expect(data.ses).toBeNull();
    expect(data.feedback.state).toBe('not_reported');
    const dmarc = data.records.find((record) => record.purpose === 'dmarc');
    expect(dmarc).toMatchObject({ name: '_dmarc.swarm.localhost', state: 'ok' });
    const dkim = data.records.filter((record) => record.purpose === 'dkim');
    expect(dkim).toHaveLength(3);
    expect(dkim.every((record) => record.state === 'missing')).toBe(true);
  });

  it('never returns a key', async () => {
    const admin = await signIn();
    await makeAdmin(admin);
    const text = await (await call('GET', URL_MAIL, { cookie: admin.cookie })).text();
    expect(text).not.toMatch(/AKIA|secret|apiKey|password/i);
  });
});

describe('the status', () => {
  const nothing: DnsLookup = { lookup: async () => [] };
  const base = {
    db: env.DB,
    service: 'ses' as const,
    region: 'eu-west-1',
    domain: 'mail.example.com',
    dns: nothing,
    ses: null,
  };

  it('still checks DMARC, and says so, when the service cannot be asked', async () => {
    const identities = {
      records: async () => {
        throw new Error('401');
      },
    } as unknown as DomainIdentities;
    const status = await mailServiceStatus({ ...base, identities });
    expect(status.recordsComplete).toBe(false);
    expect(status.records.map((record) => record.purpose)).toEqual(['dmarc']);
  });

  it('calls a failed DNS lookup unknown, for every record', async () => {
    const status = await mailServiceStatus({
      ...base,
      identities: new DevDomainIdentities(),
      dns: {
        lookup: async () => {
          throw new Error('resolver down');
        },
      },
    });
    expect(new Set(status.records.map((record) => record.state))).toEqual(new Set(['unknown']));
  });

  it('leaves the SES account out when it cannot be read', async () => {
    const status = await mailServiceStatus({
      ...base,
      identities: new DevDomainIdentities(),
      ses: {
        account: async () => {
          throw new Error('AccessDenied');
        },
      },
    });
    expect(status.ses).toBeNull();
  });

  it('only reads from the service, never creating anything to look at it', async () => {
    const identities = new DevDomainIdentities();
    let created = 0;
    const create = identities.create.bind(identities);
    identities.create = async (...args) => {
      created++;
      return create(...args);
    };
    const reading: DomainIdentities = {
      create: identities.create,
      status: identities.status.bind(identities),
      remove: identities.remove.bind(identities),
      records: async () => [],
    };
    await mailServiceStatus({ ...base, identities: reading });
    expect(created).toBe(0);
  });
});

describe('whether reports are coming back', () => {
  // Each test looks from its own far-off moment, so the others' Broadcasts are out of range.
  const moment = (n: number) => Date.UTC(2040 + n, 0, 1);

  it('has nothing to say before anything has been sent', async () => {
    expect(await feedbackHealth(env.DB, moment(0))).toEqual({
      state: 'no_data',
      sent: 0,
      reported: 0,
    });
  });

  it('is fine when any delivery has been reported on', async () => {
    const now = moment(1);
    await seedBroadcast(await signIn(), ['sent', 'sent', 'delivered', 'bounced'], now - 2 * HOUR);
    expect(await feedbackHealth(env.DB, now)).toEqual({ state: 'ok', sent: 4, reported: 2 });
  });

  it('notices when a finished Broadcast has had no reports at all', async () => {
    const now = moment(2);
    await seedBroadcast(await signIn(), ['sent', 'sent', 'sent'], now - 2 * HOUR);
    expect(await feedbackHealth(env.DB, now)).toEqual({ state: 'silent', sent: 3, reported: 0 });
  });

  it('gives a Broadcast an hour before expecting reports', async () => {
    const now = moment(3);
    await seedBroadcast(await signIn(), ['sent', 'sent'], now - HOUR / 2);
    expect((await feedbackHealth(env.DB, now)).state).toBe('no_data');
  });
});

describe('checking a sending domain now', () => {
  it('says what DNS has for each record', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    const name = `news-${crypto.randomUUID().slice(0, 8)}.example.com`;
    const created = await json<{ data: { id: string } }>(
      await call('POST', `/api/v1/channels/${channelId}/sending-domains`, {
        cookie: owner.cookie,
        body: { domain: name, kind: 'email' },
      }),
    );
    const res = await call('POST', `/api/v1/sending-domains/${created.data.id}/verify`, {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    const { data } = await json<{ data: CheckedSendingDomain }>(res);
    expect(data.recordChecks).toHaveLength(data.records.length);
    expect(data.recordChecks.find((c) => c.name === `_dmarc.${name}`)?.state).toBe('ok');
    expect(data.recordChecks.find((c) => c.type === 'MX')?.state).toBe('missing');
  });
});

describe('what a publication sees of a change', () => {
  it('shows the new records to publish, and checks them', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    const name = `pending-${crypto.randomUUID().slice(0, 8)}.example.com`;
    const { data } = await json<{ data: { id: string } }>(
      await call('POST', `/api/v1/channels/${channelId}/sending-domains`, {
        cookie: owner.cookie,
        body: { domain: name, kind: 'email' },
      }),
    );
    await env.DB.prepare(
      `UPDATE sending_domains SET pending_provider = 'resend', pending_records_json = ?1 WHERE id = ?2`,
    )
      .bind(
        JSON.stringify([
          { purpose: 'dkim', type: 'TXT', name: `resend._domainkey.${name}`, value: 'p=abc' },
          { purpose: 'dmarc', type: 'TXT', name: `_dmarc.${name}`, value: 'old' },
        ]),
        data.id,
      )
      .run();
    const res = await call('POST', `/api/v1/sending-domains/${data.id}/verify`, {
      cookie: owner.cookie,
    });
    const checked = (await json<{ data: CheckedSendingDomain }>(res)).data;
    expect(checked.pendingChange?.service).toBe('resend');
    // The DMARC record shown is today's recommendation, as for the domain's current records.
    expect(checked.pendingChange?.records.at(-1)?.value).toContain('rua=mailto:dmarc+');
    expect(
      checked.pendingChecks.find((c) => c.type === 'TXT' && c.name.startsWith('resend'))?.state,
    ).toBe('missing');
  });

  it('shows nothing when no change is under way', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    const created = await json<{ data: { pendingChange: unknown } }>(
      await call('POST', `/api/v1/channels/${channelId}/sending-domains`, {
        cookie: owner.cookie,
        body: { domain: `plain-${crypto.randomUUID().slice(0, 8)}.example.com`, kind: 'email' },
      }),
    );
    expect(created.data.pendingChange).toBeNull();
  });
});

describe('what the owner sees of a change', () => {
  it('reports one under way, and stops once it’s over', async () => {
    const admin = await signIn();
    await makeAdmin(admin);
    const read = async () =>
      (await json<{ data: InstanceMail }>(await call('GET', URL_MAIL, { cookie: admin.cookie })))
        .data.change;
    expect(await read()).toBeNull();
    await env.DB.prepare(
      `INSERT INTO mail_service_changes (id, from_provider, to_provider, state, started_at, drain_until)
       VALUES ('owner-view', 'resend', 'ses', 'cut_over', 1000, 2000)`,
    ).run();
    expect(await read()).toMatchObject({ from: 'resend', to: 'ses', state: 'cut_over' });
    await env.DB.prepare(`DELETE FROM mail_service_changes WHERE id = 'owner-view'`).run();
  });
});

describe('the database side of changing service', () => {
  const NOW = Date.UTC(2041, 5, 15, 12);
  const swap = () => env.DB.prepare(SWAP_DOMAINS_SQL).bind(NOW).run();
  const hold = () => env.DB.prepare(HOLD_UNREGISTERED_SQL).bind(NOW).run();
  const rewarm = () => env.DB.prepare(REWARM_SQL).bind(NOW).run();

  async function verifiedDomain(owner: Session, pending = true) {
    const { id: channelId } = await createChannel(owner);
    const name = `move-${crypto.randomUUID().slice(0, 8)}.example.com`;
    const { data } = await json<{ data: { id: string } }>(
      await call('POST', `/api/v1/channels/${channelId}/sending-domains`, {
        cookie: owner.cookie,
        body: { domain: name, kind: 'email' },
      }),
    );
    await env.DB.prepare(
      `UPDATE sending_domains SET status = 'verified', dkim_status = 'success', verified_at = 5,
         provider = 'resend', provider_ref = 'old-ref', records_json = '[{"old":1}]',
         pending_provider = ?2, pending_provider_ref = ?3, pending_records_json = ?4 WHERE id = ?1`,
    )
      .bind(
        data.id,
        pending ? 'ses' : null,
        pending ? 'new-ref' : null,
        pending ? '[{"new":1}]' : null,
      )
      .run();
    return { id: data.id, channelId };
  }
  const row = (id: string) =>
    env.DB.prepare('SELECT * FROM sending_domains WHERE id = ?1').bind(id).first<{
      status: string;
      verified_at: number | null;
      provider: string | null;
      provider_ref: string | null;
      records_json: string;
      pending_provider: string | null;
      pending_provider_ref: string | null;
      pending_records_json: string | null;
      provider_changed_at: number | null;
    }>();

  it('swaps a domain to the new service, holding it until that service confirms', async () => {
    const domain = await verifiedDomain(await signIn());
    await swap();
    expect(await row(domain.id)).toMatchObject({
      status: 'pending',
      verified_at: null,
      provider: 'ses',
      provider_ref: 'new-ref',
      records_json: '[{"new":1}]',
      pending_provider: 'resend',
      pending_provider_ref: 'old-ref',
      pending_records_json: '[{"old":1}]',
      provider_changed_at: NOW,
    });
  });

  it('rolls back by swapping again', async () => {
    const domain = await verifiedDomain(await signIn());
    await swap();
    await swap();
    expect(await row(domain.id)).toMatchObject({
      provider: 'resend',
      provider_ref: 'old-ref',
      records_json: '[{"old":1}]',
      pending_provider: 'ses',
      status: 'pending',
    });
  });

  it('stops a domain the new service doesn’t have from looking ready to send', async () => {
    const domain = await verifiedDomain(await signIn(), false);
    await hold();
    await swap();
    expect(await row(domain.id)).toMatchObject({
      status: 'pending',
      verified_at: null,
      provider: 'resend',
      records_json: '[{"old":1}]',
      provider_changed_at: NOW,
    });
  });

  it('leaves branded link domains alone', async () => {
    const owner = await signIn();
    const domain = await verifiedDomain(owner);
    await env.DB.prepare(`UPDATE sending_domains SET kind = 'link' WHERE id = ?1`)
      .bind(domain.id)
      .run();
    await hold();
    await swap();
    expect(await row(domain.id)).toMatchObject({ status: 'verified', provider: 'resend' });
  });

  describe('warming up again', () => {
    async function ramp(owner: Session, status: string, members: number) {
      const { id: channelId } = await createChannel(owner);
      const id = newId('reputationRamp');
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO reputation_ramps (id, channel_id, sending_domain_id, status, day, cap_today, sent_today, start_cap, growth, max_cap,
             bounce_threshold, complaint_threshold, paused_reason, created_at, updated_at)
           VALUES (?1, ?2, NULL, ?3, '2041-01-01', 90000, 500, 200, 1.5, 100000, 0.02, 0.0008, ?4, 1, 1)`,
        ).bind(id, channelId, status, status === 'paused' ? 'Too many bounces' : null),
        ...Array.from({ length: members }, (_, i) =>
          env.DB.prepare(
            `INSERT INTO members (id, channel_id, email, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'active', 1, 1)`,
          ).bind(newId('member'), channelId, `r${i}-${id}@example.org`),
        ),
      ]);
      return id;
    }
    const rampRow = (id: string) =>
      env.DB.prepare(
        'SELECT status, day, cap_today, sent_today, max_cap, paused_reason FROM reputation_ramps WHERE id = ?1',
      )
        .bind(id)
        .first();

    it('starts a finished ramp over, really throttling this time', async () => {
      const id = await ramp(await signIn(), 'complete', 3);
      await rewarm();
      expect(await rampRow(id)).toEqual({
        status: 'warming',
        day: '2041-06-15',
        cap_today: 200,
        sent_today: 0,
        // There are only 3 readers, so it can't end below the first day's cap.
        max_cap: 201,
        paused_reason: null,
      });
    });

    it('leaves a paused ramp paused, with its reason', async () => {
      const id = await ramp(await signIn(), 'paused', 1);
      await rewarm();
      expect(await rampRow(id)).toMatchObject({
        status: 'paused',
        cap_today: 90000,
        paused_reason: 'Too many bounces',
      });
    });
  });

  it('estimates how long warming takes', () => {
    expect(rewarmDays(100, 200, 1.5)).toBe(1);
    expect(rewarmDays(300, 200, 1.5)).toBe(2);
    expect(rewarmDays(50_000, 200, 1.5)).toBe(15);
  });

  it('allows one open change at a time', async () => {
    const open = (id: string) =>
      env.DB.prepare(
        `INSERT INTO mail_service_changes (id, from_provider, to_provider, state, started_at) VALUES (?1, 'resend', 'ses', 'prepared', 1)`,
      )
        .bind(id)
        .run();
    await open('change-a');
    await expect(open('change-b')).rejects.toThrow(/UNIQUE/);
    await env.DB.prepare(
      `UPDATE mail_service_changes SET state = 'finished' WHERE id = 'change-a'`,
    ).run();
    await open('change-c');
    await env.DB.prepare(`DELETE FROM mail_service_changes`).run();
  });
});
