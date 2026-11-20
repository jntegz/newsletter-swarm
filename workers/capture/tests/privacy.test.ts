// Privacy Center from the Member side (Phase 7): "Email me a copy of my data" and "Delete my
// data" in the Member Center, the download page, and what link scanners can't do.
import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import {
  addressMarker,
  emailHash,
  eraseConfirmationToken,
  newConfirmationNonce,
  runPrivacyRequests,
} from '@swarm/engine';
import { parseKeyring } from '@swarm/tokens';
import { describe, expect, it } from 'vitest';
import { jobsPrivacyVault } from './vault-fetch';
import { memberTokenFor, testLinks } from './links';
import { audienceDeps } from '../src/context';
import { parseCaptureEnv } from '../src/env';
import { addMember, call, mailTo, nextIp, ORIGIN, seedChannel, uniqueEmail } from './helpers';

const keys = testLinks();
const markerKeys = parseKeyring(env.TEST_FIELD_KEYS);

async function activeMember() {
  const channel = await seedChannel();
  const email = uniqueEmail();
  const id = await addMember(channel.channelId, email, 'active');
  // A link the Member asked for at /m: erasing needs one opened soon after it was emailed.
  const token = await memberTokenFor(id, undefined, { emailed: true });
  return { channel, email, id, path: `/m/${token}` };
}

function post(path: string, fields: Record<string, string>, origin: string | null = ORIGIN) {
  return call(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cf-connecting-ip': nextIp(),
      ...(origin ? { origin } : {}),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

/** What the jobs worker does every minute, with this worker's bindings. */
async function runJobs(now = Date.now()) {
  const e = parseCaptureEnv(env);
  // As the jobs worker runs them: it signs the data download links (capture only checks them).
  return runPrivacyRequests(
    {
      ...audienceDeps(e),
      fieldKeys: await jobsPrivacyVault(),
      links: testLinks(),
      exports: e.EXPORTS,
    },
    now,
  );
}

const confirmationMails = async (to: string) =>
  (await mailTo(to)).filter((m) => m.category === 'privacy_confirm');

const confirmLink = (text: string) =>
  /https:\/\/forms\.swarm\.test(\/m\/erase\/[A-Za-z0-9._-]+)/.exec(text)?.[1];

/** Every form the address's marker takes in the workspaces that have requests (0107). */
async function markersOf(email: string): Promise<string[]> {
  const workspaces = await env.DB.prepare('SELECT DISTINCT workspace_id FROM dsr_requests').all<{
    workspace_id: string;
  }>();
  return [
    await emailHash(email),
    ...(await Promise.all(
      workspaces.results.map((w) => addressMarker(env.DB, w.workspace_id, email, markerKeys)),
    )),
  ];
}

const requests = (memberEmail: string) =>
  markersOf(memberEmail).then((hashes) =>
    env.DB.prepare(
      'SELECT id, kind, source, status, due_at, created_at, member_id FROM dsr_requests WHERE email_hash IN (SELECT value FROM json_each(?1)) ORDER BY created_at',
    )
      .bind(JSON.stringify(hashes))
      .all<{
        id: string;
        kind: string;
        source: string;
        status: string;
        due_at: number;
        created_at: number;
        member_id: string | null;
      }>(),
  );

describe('Subscriber settings: your data', () => {
  it('shows both actions, and nothing changes on GET', async () => {
    const { email, path } = await activeMember();
    const html = await (await call(path)).text();
    expect(html).toContain('<h2>Your data</h2>');
    expect(html).toContain('value="export_data"');
    expect(html).toContain('value="erase_confirm"');
    expect((await requests(email)).results).toHaveLength(0);
  });

  it('exports: a request due in 24 hours, a mailed link to a page, the file only on POST', async () => {
    const { email, path, id } = await activeMember();
    const res = await post(path, { action: 'export_data' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${path}?saved=export_data`);
    const [request] = (await requests(email)).results;
    expect(request).toMatchObject({
      kind: 'export',
      source: 'member_center',
      status: 'processing',
      member_id: id,
    });
    expect(request!.due_at - request!.created_at).toBe(24 * 3_600_000);
    // A second click doesn't file another.
    await post(path, { action: 'export_data' });
    expect((await requests(email)).results).toHaveLength(1);

    const notice = await (await call(`${path}?saved=export_data`)).text();
    expect(notice).toContain('A download link will arrive by email within 24 hours.');

    await runJobs();
    const [mail] = (await mailTo(email)).filter((m) => m.category === 'privacy_export');
    expect(mail?.subject).toBe('Your data from Field Notes');
    const link = /https:\/\/forms\.swarm\.test(\/m\/data\/[A-Za-z0-9._-]+)/.exec(mail!.text)?.[1];
    expect(link).toBeDefined();

    // The page (what a scanner fetches) never sends the file.
    const pageRes = await call(link!);
    expect(pageRes.status).toBe(200);
    expect(pageRes.headers.get('content-type')).toContain('text/html');
    const pageHtml = await pageRes.text();
    expect(pageHtml).toContain('Your data is ready');
    expect(pageHtml).toContain('<form method="post">');

    // A cross-site POST is refused; the page's own POST downloads.
    expect((await post(link!, {}, 'https://evil.example')).status).toBe(404);
    const file = await post(link!, {});
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toMatch(
      /^attachment; filename="my-data-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(file.headers.get('cache-control')).toBe('private, no-store');
    const data = (await file.json()) as { email: string; channels: { member: { id: string } }[] };
    expect(data.email).toBe(email);
    expect(data.channels[0]?.member.id).toBe(id);
    // The link names its workspace; one naming another opens nothing, even signed by jobs' key.
    const signed = await testLinks().verify<{ r: string; w: string }>(
      'dsr-export',
      link!.split('/m/data/')[1]!,
    );
    expect(signed.ok && signed.payload.w).toMatch(/^ws_/);
    const elsewhere = await testLinks().sign('dsr-export', {
      r: request!.id,
      w: `ws_${'0'.repeat(32)}`,
    });
    expect((await call(`/m/data/${elsewhere}`)).status).toBe(404);
    expect((await post(`/m/data/${elsewhere}`, {})).status).toBe(404);

    // A tampered or expired link shows the same page and no file.
    expect((await call(`${link!}x`)).status).toBe(404);
    const expired = await env.DB.prepare(
      'UPDATE dsr_requests SET export_expires_at = ?1 WHERE id = ?2 RETURNING id',
    )
      .bind(Date.now() - 1, request!.id)
      .first();
    expect(expired).not.toBeNull();
    expect((await post(link!, {})).status).toBe(404);
  });

  it('leaves an export an admin filed for the admin to approve, and says so', async () => {
    const { channel, email, path, id } = await activeMember();
    const now = Date.now();
    const filed = newId('dsrRequest', now);
    await env.DB.prepare(
      `INSERT INTO dsr_requests (id, workspace_id, channel_id, member_id, email_hash, kind, source,
         status, due_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'export', 'operator', 'pending', ?6, ?7, ?7)`,
    )
      .bind(
        filed,
        channel.workspaceId,
        channel.channelId,
        id,
        await addressMarker(env.DB, channel.workspaceId, email, markerKeys),
        now + 86_400_000,
        now,
      )
      .run();

    const res = await post(path, { action: 'export_data' });
    expect(res.headers.get('location')).toBe(`${path}?saved=export_review`);
    expect((await requests(email)).results).toEqual([
      expect.objectContaining({ id: filed, source: 'operator', status: 'pending' }),
    ]);
    const notice = await (await call(`${path}?saved=export_review`)).text();
    expect(notice).toContain('Your request is waiting for review.');
  });

  it('erases only after the subscriber confirms from their inbox, then the subscriber is gone', async () => {
    const { channel, email, path, id } = await activeMember();
    const confirm = await post(path, { action: 'erase_confirm' });
    expect(confirm.status).toBe(200);
    const confirmHtml = await confirm.text();
    expect(confirmHtml).toContain('It can’t be undone.');
    expect(confirmHtml).toContain('value="erase"');
    expect(confirmHtml).toContain('we will email');
    expect((await requests(email)).results).toHaveLength(0);

    // Without ticking the box nothing is sent or filed.
    const unticked = await post(path, { action: 'erase' });
    expect(unticked.status).toBe(400);
    expect(await confirmationMails(email)).toHaveLength(0);

    // Ticked: an email to the address, and still nothing filed. Whoever holds a forwarded email
    // gets this far and no further.
    const asked = await post(path, { action: 'erase', confirm: 'yes' });
    expect(asked.status).toBe(200);
    expect(await asked.text()).toContain('Check your inbox');
    expect((await requests(email)).results).toHaveLength(0);
    const [mail] = await confirmationMails(email);
    expect(mail?.subject).toBe('Confirm that you want your data deleted from Field Notes');
    const link = confirmLink(mail!.text);
    expect(link).toBeDefined();
    // Asking again straight away sends nothing more.
    await post(path, { action: 'erase', confirm: 'yes' });
    expect(await confirmationMails(email)).toHaveLength(1);

    // The link's page (what a scanner fetches) changes nothing.
    const pageRes = await call(link!);
    expect(pageRes.status).toBe(200);
    const pageHtml = await pageRes.text();
    expect(pageHtml).toContain('<form method="post">');
    expect(pageHtml).toContain('Delete my data');
    expect((await requests(email)).results).toHaveLength(0);

    // A cross-site POST is refused; the page's own POST queues the erasure.
    expect((await post(link!, {}, 'https://evil.example')).status).toBe(404);
    expect((await requests(email)).results).toHaveLength(0);
    const done = await post(link!, {});
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('Your data is being deleted');
    const [request] = (await requests(email)).results;
    expect(request).toMatchObject({ kind: 'erase', source: 'member_center', status: 'processing' });
    expect(request!.due_at - request!.created_at).toBe(30 * 24 * 3_600_000);
    // The link works once.
    expect((await post(link!, {})).status).toBe(404);
    expect((await call(link!)).status).toBe(404);
    expect((await requests(email)).results).toHaveLength(1);

    const result = await runJobs();
    expect(result.completed).toContain(request!.id);
    expect(result.channelIds).toEqual([channel.channelId]);
    expect(
      await env.DB.prepare('SELECT count(*) AS n FROM members WHERE id = ?1').bind(id).first('n'),
    ).toBe(0);
    // The Member Center link no longer opens anything; the address can't sign up again.
    expect((await call(path)).status).toBe(404);
    const suppression = await env.DB.prepare(
      'SELECT email FROM suppressions WHERE workspace_id = ?1 AND email_hash = ?2',
    )
      .bind(
        channel.workspaceId,
        await addressMarker(env.DB, channel.workspaceId, email, markerKeys),
      )
      .first<{ email: string }>();
    expect(suppression?.email).toMatch(/^erased\+sp_[0-9a-f]{32}@invalid$/);
  });

  it('names its confirmation by an id nobody can predict, so the signing key alone can’t confirm', async () => {
    const { email, id, path } = await activeMember();
    await post(path, { action: 'erase', confirm: 'yes' });
    const row = await env.DB.prepare('SELECT id FROM dsr_confirmations WHERE member_id = ?1')
      .bind(id)
      .first<{ id: number }>();
    expect(row!.id).toBeGreaterThanOrEqual(2 ** 52);
    // A link forged with the key for a guessed id (the next row number) opens nothing.
    for (const guess of [1, row!.id + 1, row!.id - 1]) {
      const nonce = newConfirmationNonce();
      const forged = await eraseConfirmationToken(keys, {
        confirmationId: guess,
        memberId: id,
        nonce,
      });
      expect((await call(`/m/erase/${forged}`)).status).toBe(404);
      expect((await post(`/m/erase/${forged}`, {})).status).toBe(404);
    }
    expect((await requests(email)).results).toHaveLength(0);
  });

  it('needs the nonce only the email carries, even with the signing key and the row id', async () => {
    const { email, id, path } = await activeMember();
    await post(path, { action: 'erase', confirm: 'yes' });
    const row = await env.DB.prepare(
      'SELECT id, nonce_hash FROM dsr_confirmations WHERE member_id = ?1',
    )
      .bind(id)
      .first<{ id: number; nonce_hash: string }>();
    // The row holds a hash, never the nonce itself.
    expect(row!.nonce_hash).toMatch(/^[0-9a-f]{64}$/);
    const link = confirmLink((await confirmationMails(email))[0]!.text)!;
    const mailed = await keys.verify<{ n: string }>('dsr-confirm', link.split('/m/erase/')[1]!);
    expect(mailed.ok && mailed.payload.n).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(row!.nonce_hash).not.toContain(mailed.ok ? mailed.payload.n : '');
    // The key holder knows the row id (a database read) but not the nonce: nothing opens.
    const guessed = { confirmationId: row!.id, memberId: id };
    for (const nonce of [newConfirmationNonce(), row!.nonce_hash.slice(0, 22)]) {
      const forged = await eraseConfirmationToken(keys, { ...guessed, nonce });
      expect((await call(`/m/erase/${forged}`)).status).toBe(404);
      expect((await post(`/m/erase/${forged}`, {})).status).toBe(404);
    }
    // Nor does a link with no nonce at all, as links from before nonces were.
    const bare = await keys.sign('dsr-confirm', { c: String(row!.id), m: id });
    expect((await post(`/m/erase/${bare}`, {})).status).toBe(404);
    expect((await requests(email)).results).toHaveLength(0);
    // The mailed link does.
    expect((await post(link, {})).status).toBe(200);
    expect((await requests(email)).results).toHaveLength(1);
  });

  it('keeps a confirmation made before nonces working with its link from then', async () => {
    const { email, id } = await activeMember();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO dsr_confirmations (id, member_id, kind, created_at, expires_at)
       VALUES (?1, ?2, 'erase', ?3, ?4)`,
    )
      .bind(2 ** 52 + 7, id, now, now + 3_600_000)
      .run();
    const old = await keys.sign('dsr-confirm', { c: String(2 ** 52 + 7), m: id });
    expect((await post(`/m/erase/${old}`, {})).status).toBe(200);
    expect((await requests(email)).results).toHaveLength(1);
  });

  it('a confirmation link stops working after its hours, or when tampered with', async () => {
    const { email, path } = await activeMember();
    await post(path, { action: 'erase', confirm: 'yes' });
    const link = confirmLink((await confirmationMails(email))[0]!.text)!;
    expect((await call(`${link}x`)).status).toBe(404);
    // Another subscriber's token purpose can't stand in for it.
    expect((await call(link.replace('/m/erase/', '/m/data/'))).status).toBe(404);
    await env.DB.prepare(
      'UPDATE dsr_confirmations SET expires_at = ?1 WHERE member_id = (SELECT id FROM members WHERE email = ?2)',
    )
      .bind(Date.now() - 1, email)
      .run();
    expect((await call(link)).status).toBe(404);
    expect((await post(link, {})).status).toBe(404);
    expect((await requests(email)).results).toHaveLength(0);
  });

  it('an address that bounced is passed to the publisher to review, not erased', async () => {
    const channel = await seedChannel();
    const email = uniqueEmail();
    const id = await addMember(channel.channelId, email, 'bounced');
    const path = `/m/${await memberTokenFor(id)}`;
    const html = await (await call(path)).text();
    expect(html).not.toContain('value="export_data"');
    expect(html).toContain('ask Field Notes directly');
    const res = await post(path, { action: 'erase', confirm: 'yes' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('will check the request before anything is deleted');
    expect(await confirmationMails(email)).toHaveLength(0);
    const [request] = (await requests(email)).results;
    expect(request).toMatchObject({
      kind: 'erase',
      source: 'member_center_unverified',
      status: 'pending',
    });
    // Nothing runs it until an admin approves.
    await runJobs();
    expect((await requests(email)).results[0]?.status).toBe('pending');
  });

  it('asks the inbox to confirm an erasure, whichever link it comes from', async () => {
    const { email, id, path } = await activeMember();
    const footer = `/m/${await memberTokenFor(id)}`;
    const stale = await memberTokenFor(id, Date.now() - 2 * 3_600_000, { emailed: true });
    for (const from of [footer, `/m/${stale}`, path]) {
      const res = await post(from, { action: 'erase', confirm: 'yes' });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Check your inbox');
    }
    expect((await requests(email)).results).toHaveLength(0);
    // Asking again within minutes sends nothing more.
    expect(await confirmationMails(email)).toHaveLength(1);
  });

  it('runs an erasure a forwarded link filed once the person confirms from their inbox', async () => {
    const { email, id, path } = await activeMember();
    await env.DB.prepare("UPDATE members SET status = 'bounced' WHERE id = ?1").bind(id).run();
    await post(`/m/${await memberTokenFor(id)}`, { action: 'erase', confirm: 'yes' });
    const [pending] = (await requests(email)).results;
    expect(pending).toMatchObject({ source: 'member_center_unverified', status: 'pending' });
    // The address works again, so the person can prove it is theirs.
    await env.DB.prepare("UPDATE members SET status = 'active' WHERE id = ?1").bind(id).run();
    expect(await (await post(path, { action: 'erase', confirm: 'yes' })).text()).toContain(
      'Check your inbox',
    );
    const link = confirmLink((await confirmationMails(email))[0]!.text)!;
    expect(await (await post(link, {})).text()).toContain('Your data is being deleted');
    expect((await requests(email)).results).toMatchObject([
      { id: pending!.id, source: 'member_center', status: 'processing' },
    ]);
  });

  it('sends an erasure by a bounced or complained Member from a footer link to the publisher for review', async () => {
    for (const status of ['bounced', 'complained']) {
      const { email, id } = await activeMember();
      await env.DB.prepare('UPDATE members SET status = ?1 WHERE id = ?2').bind(status, id).run();
      // No email reaches the address, so the footer link is all it has. It may be a forwarded one.
      const footer = `/m/${await memberTokenFor(id)}`;
      const confirm = await post(footer, { action: 'erase_confirm' });
      expect(confirm.status).toBe(200);
      const confirmHtml = await confirm.text();
      // Whatever the page shows is no proof: the holder of the link sees it too.
      const shown = /This deletes ([^ ]+) and/.exec(confirmHtml)?.[1] ?? '';
      const done = await post(footer, { action: 'erase', confirm: 'yes', confirm_email: shown });
      const [request] = (await requests(email)).results;
      expect(request).toMatchObject({
        kind: 'erase',
        source: 'member_center_unverified',
        status: 'pending',
      });
      expect(confirmHtml).toContain('checks this request');
      expect(done.status).toBe(200);
      expect(await done.text()).toContain('Your request is waiting for review');
      // The jobs worker leaves it alone until an admin approves it.
      expect((await runJobs()).completed).not.toContain(request!.id);
      expect(
        await env.DB.prepare('SELECT count(*) AS n FROM members WHERE id = ?1').bind(id).first('n'),
      ).toBe(1);
      // Asking again files nothing new.
      await post(footer, { action: 'erase', confirm: 'yes' });
      expect((await requests(email)).results).toHaveLength(1);
      expect(await mailTo(email)).toHaveLength(0);
    }
  });

  it('sends an unmailable address to review even from a freshly emailed link', async () => {
    // Nothing a link carries proves who holds it: one emailed a moment ago can be forged by
    // whoever holds the member signing key, so it counts for no more than a footer link.
    const { email, id, path } = await activeMember();
    await env.DB.prepare("UPDATE members SET status = 'bounced' WHERE id = ?1").bind(id).run();
    const done = await post(path, { action: 'erase', confirm: 'yes' });
    expect(await done.text()).toContain('Your request is waiting for review');
    const [request] = (await requests(email)).results;
    expect(request).toMatchObject({
      kind: 'erase',
      source: 'member_center_unverified',
      status: 'pending',
    });
    expect((await runJobs()).completed).not.toContain(request!.id);
    expect(
      await env.DB.prepare('SELECT count(*) AS n FROM members WHERE id = ?1').bind(id).first('n'),
    ).toBe(1);
  });

  it('keeps one waiting for review when a fresh link asks again for an unmailable address', async () => {
    const { email, id, path } = await activeMember();
    await env.DB.prepare("UPDATE members SET status = 'bounced' WHERE id = ?1").bind(id).run();
    const footer = `/m/${await memberTokenFor(id)}`;
    await post(footer, { action: 'erase', confirm: 'yes' });
    const [pending] = (await requests(email)).results;
    expect(pending).toMatchObject({ kind: 'erase', status: 'pending' });
    // A freshly emailed link changes nothing: the admin still decides.
    const done = await post(path, { action: 'erase', confirm: 'yes' });
    expect(await done.text()).toContain('Your request is waiting for review');
    const rows = (await requests(email)).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: pending!.id,
      source: 'member_center_unverified',
      status: 'pending',
    });
    expect((await runJobs()).completed).not.toContain(pending!.id);
  });
  it('never says the data is being deleted while the open erasure still waits for review', async () => {
    const { channel, email, id, path } = await activeMember();
    await env.DB.prepare("UPDATE members SET status = 'bounced' WHERE id = ?1").bind(id).run();
    await post(`/m/${await memberTokenFor(id)}`, { action: 'erase', confirm: 'yes' });
    // A renewing membership keeps the pending one from running, whoever asks.
    await env.DB.prepare(
      `INSERT INTO member_subscriptions (id, channel_id, member_id, source, status, stripe_subscription_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'stripe', 'active', ?4, ?5, ?5)`,
    )
      .bind(
        newId('memberSubscription'),
        channel.channelId,
        id,
        `sub_${crypto.randomUUID().slice(0, 8)}`,
        Date.now(),
      )
      .run();
    const res = await post(path, { action: 'erase', confirm: 'yes' });
    expect(await res.text()).not.toContain('Your data is being deleted');
    expect((await requests(email)).results).toMatchObject([{ status: 'pending' }]);
  });

  it('asks a paying subscriber to end the membership before erasing', async () => {
    const { channel, email, path, id } = await activeMember();
    // The link was asked for before the subscription started.
    await post(path, { action: 'erase', confirm: 'yes' });
    const link = confirmLink((await confirmationMails(email))[0]!.text)!;
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO member_subscriptions (id, channel_id, member_id, source, status, stripe_subscription_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'stripe', 'active', ?4, ?5, ?5)`,
    )
      .bind(
        newId('memberSubscription'),
        channel.channelId,
        id,
        `sub_${crypto.randomUUID().slice(0, 8)}`,
        now,
      )
      .run();
    const res = await post(path, { action: 'erase', confirm: 'yes' });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('Cancel your paid subscription first');
    // The emailed link refuses too, without being used up.
    const fromLink = await post(link, {});
    expect(fromLink.status).toBe(409);
    expect((await call(link)).status).toBe(200);
    expect((await requests(email)).results).toHaveLength(0);
  });

  it('refuses requests without the page’s origin or with a bad token', async () => {
    const { email, path } = await activeMember();
    expect((await post(path, { action: 'export_data' }, 'https://evil.example')).status).toBe(404);
    expect((await post('/m/v1.member.m1.bad.mac', { action: 'export_data' })).status).toBe(404);
    expect((await requests(email)).results).toHaveLength(0);
  });
});
