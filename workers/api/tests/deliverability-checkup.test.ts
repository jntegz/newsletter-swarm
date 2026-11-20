// The deliverability check-up and the content advice in the pre-send checklist.
import { env } from 'cloudflare:test';
import {
  newId,
  type CheckupFinding,
  type DeliverabilityCheckup,
  type Dispatch,
  type Preflight,
  type SeatRole,
  type SendingDomain,
} from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { call, createChannel, json, seatAs, signIn, type Session } from './helpers';
import { enableFlag } from './money-helpers';

const DAY = 86_400_000;

async function data<T>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await json<{ data: T }>(res)).data;
}

const checkup = async (session: Session, channelId: string) =>
  data<DeliverabilityCheckup>(
    await call('GET', `/api/v1/channels/${channelId}/deliverability/checkup`, {
      cookie: session.cookie,
    }),
  );

const one = (result: DeliverabilityCheckup, id: string, subject?: string) =>
  result.findings.find((f) => f.id === id && (subject === undefined || f.subject === subject));

async function addDomain(session: Session, channelId: string) {
  const name = `news-${crypto.randomUUID().slice(0, 8)}.example.com`;
  return data<SendingDomain>(
    await call('POST', `/api/v1/channels/${channelId}/sending-domains`, {
      cookie: session.cookie,
      body: { domain: name, kind: 'email' },
    }),
    201,
  );
}

const addSender = async (
  session: Session,
  channelId: string,
  sendingDomainId: string | null,
  fromLocal = 'mara',
) =>
  data(
    await call('POST', `/api/v1/channels/${channelId}/sender-identities`, {
      cookie: session.cookie,
      body: { fromName: 'Mara', fromLocal, sendingDomainId, isDefault: true },
    }),
    201,
  );

/** One send's deliveries: [address, status, humanOpened]. */
async function seedDeliveries(
  workspaceId: string,
  channelId: string,
  rows: [string, 'delivered' | 'bounced' | 'complained', boolean][],
) {
  const sentAt = Date.now() - DAY;
  const dispatch = newId('dispatch');
  const broadcast = newId('broadcast');
  const statements = [
    env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at) VALUES (?1, ?2, 'S', '{"type":"doc","content":[]}', 'sent', ?3, ?3)`,
    ).bind(dispatch, channelId, sentAt),
    env.DB.prepare(
      `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text, from_name, from_address, track_opens, created_at, last_progress_at)
       VALUES (?1, ?2, ?3, ?4, 'sent', 'S', '', '', '', 'F', 'f@mail.swarm.test', 1, ?5, ?5)`,
    ).bind(broadcast, dispatch, channelId, workspaceId, sentAt),
    ...rows.map(([email, status, opened], i) =>
      env.DB.prepare(
        `INSERT INTO deliveries (id, broadcast_id, channel_id, email, status, sent_at, delivered_at, human_opened_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      ).bind(
        newId('delivery'),
        broadcast,
        channelId,
        email.replace('@', `+${i}@`),
        status,
        sentAt,
        status === 'bounced' ? null : sentAt,
        opened ? sentAt : null,
      ),
    ),
  ];
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
}

const devDns = (name: string, answers: string[]) =>
  env.CACHE.put(`dev:dns:A:${name}`, JSON.stringify(answers));

describe('deliverability check-up', () => {
  it('for a new publication: no problems, honest about what it cannot know yet', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    const result = await checkup(owner, channelId);

    expect(result.counts.problem).toBe(0);
    expect(result.verdict).toBe('warnings');
    expect(result.score).toBe(100 - 5 * result.counts.warning);
    expect(result.from?.address).toMatch(/@/);
    expect(Date.parse(result.checkedAt)).toBeGreaterThan(Date.now() - 60_000);

    expect(one(result, 'sender')).toMatchObject({ severity: 'warning', link: { to: 'sending' } });
    expect(one(result, 'sending_volume')?.severity).toBe('unknown');
    expect(one(result, 'bounce_rate')).toBeUndefined();
    // Per-person tracking starts off, so nobody can be judged inactive yet.
    expect(one(result, 'inactive_cleanup')?.severity).toBe('unknown');
    expect(one(result, 'footer_address')?.severity).toBe('warning');
    expect(one(result, 'confirm_opt_in')?.severity).toBe('good');
    // No network in tests: the lists did not answer, which is never "clean" and never "listed".
    const blocklist = result.findings.filter((f) => f.id === 'blocklist');
    expect(blocklist).toHaveLength(1);
    expect(blocklist[0]).toMatchObject({ severity: 'unknown' });
    expect(blocklist[0]!.external.map((link) => link.url)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^https:\/\/check\.spamhaus\.org\//)]),
    );

    // Ordered: problems, warnings, unknown, good.
    const order = ['problem', 'warning', 'unknown', 'good'];
    const ranks = result.findings.map((f) => order.indexOf(f.severity));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('checks the sending domain a sender uses: records, DMARC and the sender itself', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    const domain = await addDomain(owner, channelId);

    // A domain nobody sends from yet is left to the Sending page.
    let result = await checkup(owner, channelId);
    expect(one(result, 'sending_domain')).toBeUndefined();

    await addSender(owner, channelId, domain.id, 'no-reply');
    result = await checkup(owner, channelId);
    expect(result.from?.address).toBe(`no-reply@${domain.domain}`);
    expect(result.verdict).toBe('problems');
    expect(one(result, 'sending_domain', domain.domain)).toMatchObject({
      severity: 'problem',
      title: `${domain.domain} is not verified`,
    });
    // The dev resolver publishes only a DMARC record: DKIM and the return path are missing.
    const dkim = one(result, 'dns_dkim', domain.domain)!;
    expect(dkim.severity).toBe('problem');
    expect(dkim.fix.join(' ')).toContain(domain.records.find((r) => r.purpose === 'dkim')!.name);
    expect(one(result, 'dns_return_path_mx', domain.domain)?.severity).toBe('problem');
    expect(one(result, 'dns_return_path_spf', domain.domain)?.severity).toBe('problem');
    expect(one(result, 'dmarc_policy', domain.domain)).toMatchObject({ severity: 'good' });
    expect(one(result, 'sender_no_reply')?.severity).toBe('warning');
    expect(result.findings[0]!.id).toBe('sending_domain');
    expect(result.score).toBe(
      Math.max(0, 100 - 20 * result.counts.problem - 5 * result.counts.warning),
    );

    await env.DB.prepare(
      `UPDATE sending_domains SET status = 'verified', verified_at = ?2 WHERE id = ?1`,
    )
      .bind(domain.id, Date.now() - 30 * DAY)
      .run();
    result = await checkup(owner, channelId);
    expect(one(result, 'sending_domain', domain.domain)?.severity).toBe('good');
  });

  it('judges bounces, complaints and a provider that opens far less', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    const rows: [string, 'delivered' | 'bounced' | 'complained', boolean][] = [];
    for (let i = 0; i < 396; i++) rows.push(['a@gmail.com', 'delivered', i < 180]);
    for (let i = 0; i < 4; i++) rows.push(['a@gmail.com', 'complained', false]);
    for (let i = 0; i < 250; i++) rows.push(['a@hotmail.com', 'delivered', i < 10]);
    for (let i = 0; i < 30; i++) rows.push(['a@yahoo.com', 'bounced', false]);
    await seedDeliveries(owner.workspaceId, channelId, rows);

    const result = await checkup(owner, channelId);
    expect(one(result, 'sending_volume')).toBeUndefined();
    // 30 of 680 bounced (4.4%); 4 complaints of 650 delivered (0.62%).
    expect(one(result, 'bounce_rate')).toMatchObject({
      severity: 'problem',
      title: '4.4% of your emails bounced',
    });
    expect(one(result, 'complaint_rate')).toMatchObject({
      severity: 'problem',
      title: '0.62% of readers marked your email as spam',
    });
    expect(one(result, 'provider_gap', 'Outlook')).toMatchObject({ severity: 'warning' });
    expect(one(result, 'provider_gap', 'Gmail')).toBeUndefined();
    const ids = result.findings.filter((f) => f.severity === 'problem').map((f) => f.id);
    expect(ids).toEqual(['complaint_rate', 'bounce_rate']);
  });

  it('reads warm-up, list settings, forms, imports and the footer', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    await data(
      await call('PATCH', `/api/v1/channels/${channelId}`, {
        cookie: owner.cookie,
        body: { doubleOptIn: false, sunsetDays: 180, trackOpens: true, profileReaders: true },
      }),
    );
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO reputation_ramps (id, channel_id, sending_domain_id, status, day, cap_today, start_cap, growth, max_cap,
           bounce_threshold, complaint_threshold, paused_reason, created_at, updated_at)
         VALUES (?1, ?2, NULL, 'paused', '2026-11-01', 300, 100, 1.3, 5000, 0.02, 0.0008, 'Bounce rate 4.0% is over the 2.0% limit.', 1, 1)`,
      ).bind(newId('reputationRamp'), channelId),
      env.DB.prepare(
        `INSERT INTO import_jobs (id, workspace_id, channel_id, status, file_name, r2_key, bytes, total_rows, processed_rows, created_at, updated_at, completed_at)
         VALUES (?1, ?2, ?3, 'done', 'old-list.csv', ?4, 10, 4200, 4200, ?5, ?5, ?5)`,
      ).bind(newId('importJob'), owner.workspaceId, channelId, crypto.randomUUID(), now - 2 * DAY),
    ]);

    const result = await checkup(owner, channelId);
    expect(result.findings[0]).toMatchObject({ id: 'warmup', severity: 'problem' });
    expect(result.findings[0]!.meaning).toContain('Bounce rate 4.0%');
    expect(one(result, 'confirm_opt_in')).toMatchObject({
      severity: 'warning',
      title: 'Double opt-in is off',
      link: { to: 'publication' },
    });
    expect(one(result, 'recent_import')).toMatchObject({
      severity: 'warning',
      title: 'You imported 4,200 addresses 2 days ago',
    });
    expect(one(result, 'inactive_cleanup')?.severity).toBe('good');
    expect(one(result, 'footer_address')?.severity).toBe('warning');

    // With the email design feature on and a footer line written, the footer finding clears.
    await enableFlag('email_design', owner.workspaceId, channelId);
    await data(
      await call('PATCH', `/api/v1/channels/${channelId}`, {
        cookie: owner.cookie,
        body: { emailDesign: { footer: 'Field Notes, 12 Harbour Road, Bristol' } },
      }),
    );
    expect(one(await checkup(owner, channelId), 'footer_address')?.severity).toBe('good');

    await env.DB.prepare(`UPDATE channels SET status = 'paused' WHERE id = ?1`)
      .bind(channelId)
      .run();
    const paused = await checkup(owner, channelId);
    expect(paused.findings[0]).toMatchObject({ id: 'publication_paused', severity: 'problem' });
  });

  it('reads blocklist answers honestly and caches them', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    const domain = await addDomain(owner, channelId);
    await addSender(owner, channelId, domain.id);
    const name = domain.domain;

    // Spamhaus lists it; SURBL proves it answers and has no entry; URIBL refuses the resolver.
    await devDns(`${name}.dbl.spamhaus.org`, ['127.0.1.2']);
    await devDns('surbl-org-permanent-test-point.com.multi.surbl.org', ['127.0.0.126']);
    await devDns(`example.com.multi.uribl.com`, ['127.0.0.1']);

    const result = await checkup(owner, channelId);
    const found = result.findings.filter(
      (f) => f.id === 'blocklist' && f.subject?.startsWith(name),
    );
    const by = (severity: CheckupFinding['severity']) =>
      found.filter((f) => f.severity === severity);
    expect(by('problem').map((f) => f.title)).toEqual([`${name} is listed on Spamhaus DBL`]);
    expect(by('problem')[0]!.external[0]!.url).toBe(
      'https://check.spamhaus.org/results?query=example.com',
    );
    expect(by('unknown').map((f) => f.title)).toEqual([`Could not check ${name} on URIBL`]);
    expect(by('unknown')[0]!.external[0]!.url).toContain('uribl.com');
    // Listed somewhere, so the clean list is not shown as an all-clear.
    expect(by('good')).toEqual([]);

    // Within the cache time the lists are not asked again.
    await devDns(`${name}.dbl.spamhaus.org`, []);
    const again = await checkup(owner, channelId);
    expect(again.findings.some((f) => f.id === 'blocklist' && f.severity === 'problem')).toBe(true);
    await env.CACHE.delete(`dev:dns:A:example.com.multi.uribl.com`);
  });

  it('never fails because one check failed', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    const domain = await addDomain(owner, channelId);
    await addSender(owner, channelId, domain.id);
    // Records that cannot be parsed, and settings of the wrong shape.
    await env.DB.prepare(
      `UPDATE sending_domains SET records_json = '{"not":"a list"}' WHERE id = ?1`,
    )
      .bind(domain.id)
      .run();
    await env.DB.prepare(
      `UPDATE channels SET settings_json = '{"emailDesign":"nope","sunsetDays":"soon"}' WHERE id = ?1`,
    )
      .bind(channelId)
      .run();
    const result = await checkup(owner, channelId);
    expect(one(result, 'dns_dkim', domain.domain)?.severity).toBe('unknown');
    expect(one(result, 'dmarc_policy', domain.domain)?.severity).toBe('good');
    expect(one(result, 'inactive_cleanup')?.severity).toBe('warning');
  });
});

describe('check-up access', () => {
  const ROLES: SeatRole[] = ['viewer', 'author', 'editor', 'admin', 'owner'];

  it('lets every role read, including viewers', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    for (const role of ROLES) {
      const session = role === 'owner' ? owner : await seatAs(owner.workspaceId, role);
      const res = await call('GET', `/api/v1/channels/${channelId}/deliverability/checkup`, {
        cookie: session.cookie,
      });
      expect(res.status, role).toBe(200);
    }
  });

  it('answers 404 to another workspace, 401 without a session, and shows nothing of the other side', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    const domain = await addDomain(owner, channelId);
    await addSender(owner, channelId, domain.id);
    const path = `/api/v1/channels/${channelId}/deliverability/checkup`;

    const outsider = await signIn();
    const refused = await call('GET', path, { cookie: outsider.cookie });
    expect(refused.status).toBe(404);
    expect(await refused.text()).not.toContain(domain.domain);
    expect((await call('GET', path)).status).toBe(401);
    expect(
      (
        await call(
          'GET',
          '/api/v1/channels/ch_00000000000000000000000000000000/deliverability/checkup',
          {
            cookie: owner.cookie,
          },
        )
      ).status,
    ).toBe(404);

    // The outsider's own check-up never mentions the first workspace's domain.
    const { id: theirs } = await createChannel(outsider);
    const own = await checkup(outsider, theirs);
    expect(JSON.stringify(own)).not.toContain(domain.domain);
  });
});

describe('content advice in the pre-send checklist', () => {
  const para = (...content: unknown[]) => ({ type: 'paragraph', content });
  const text = (value: string, href?: string) => ({
    type: 'text',
    text: value,
    ...(href ? { marks: [{ type: 'link', attrs: { href } }] } : {}),
  });
  const LONG =
    'We spent most of the spring walking the estuary with a recorder and a flask of tea, and came back with more questions than tape. Here is what the first season taught us.';

  async function preflight(owner: Session, channelId: string, body: Record<string, unknown>) {
    const dispatch = await data<Dispatch>(
      await call('POST', `/api/v1/channels/${channelId}/dispatches`, {
        cookie: owner.cookie,
        body,
      }),
      201,
    );
    return data<Preflight>(
      await call('GET', `/api/v1/dispatches/${dispatch.id}/preflight`, { cookie: owner.cookie }),
    );
  }

  it('says nothing about an ordinary post', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    const check = await preflight(owner, channelId, {
      subject: 'What a year of field recordings taught us',
      preheader: 'Three places worth the walk.',
      content: {
        type: 'doc',
        content: [
          para(text(LONG)),
          para(text('More on '), text('our site', 'https://example.com/notes')),
        ],
      },
    });
    expect(check.advice).toEqual([]);
  });

  it('gives advice that never blocks the send', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    const body = {
      subject: 'HUGE NEWS FOR EVERY READER!!!',
      content: {
        type: 'doc',
        content: [
          para(text(LONG)),
          para(
            text('https://mybank.com', 'http://203.0.113.9/login'),
            text(' and '),
            text('this', 'https://bit.ly/x'),
          ),
        ],
      },
    };
    const check = await preflight(owner, channelId, body);
    expect(check.advice.map((a) => a.id)).toEqual([
      'subject_caps',
      'subject_punctuation',
      'preview_text',
      'link_shortener',
      'ip_link',
      'insecure_link',
      'link_text_mismatch',
    ]);
    // Advice is not a check: the only thing in the way is that nobody is subscribed yet.
    expect(check.checks.filter((c) => !c.ok).map((c) => c.key)).toEqual(['audience']);

    await call('POST', `/api/v1/channels/${channelId}/members`, {
      cookie: owner.cookie,
      body: { email: `reader-${crypto.randomUUID().slice(0, 8)}@example.com`, consent: true },
    });
    const ready = await preflight(owner, channelId, body);
    expect(ready.advice.length).toBeGreaterThan(0);
    expect(ready.ready).toBe(true);
  });

  it('does not call the workspace’s own short-link domain a public shortener', async () => {
    const owner = await signIn();
    const { id: channelId } = await createChannel(owner);
    const body = {
      subject: 'What a year of field recordings taught us',
      preheader: 'Three places worth the walk.',
      content: {
        type: 'doc',
        content: [para(text(LONG)), para(text('Read it', 'https://t.ly/abc'))],
      },
    };
    expect((await preflight(owner, channelId, body)).advice.map((a) => a.id)).toEqual([
      'link_shortener',
    ]);
    await env.DB.prepare(
      `INSERT INTO app_connections (id, workspace_id, app, base_url, key_enc, last4, slug_format, domain, created_at, updated_at)
       VALUES (?1, ?2, 'shorthop', 'https://hop.example.com', 'x', 'abcd', '{slug}', 't.ly', 1, 1)`,
    )
      .bind(`app_${crypto.randomUUID().replace(/-/g, '')}`, owner.workspaceId)
      .run();
    expect((await preflight(owner, channelId, body)).advice).toEqual([]);
  });
});
