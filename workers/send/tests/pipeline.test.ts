import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import {
  applySesEvent,
  cancelBroadcast,
  handleSendMessage,
  preflight,
  publishProgress,
  readBounceCode,
  readMemberSession,
  readTrackToken,
  readUnsubscribeCode,
  reap,
  RetryLater,
  startBroadcast,
  StartError,
  type SendMessage,
} from '@swarm/engine';
import { MailProviderError, ResendError, SesError } from '@swarm/mail';
import { describe, expect, it } from 'vitest';
import {
  addMembers,
  broadcastRow,
  CaptureMail,
  completeRamp,
  config,
  context,
  count,
  drain,
  seedChannel,
  seedDispatch,
  verifier,
} from './harness';

async function start(channelId: string, ctx: ReturnType<typeof context>) {
  const dispatch = await seedDispatch(channelId);
  const { broadcastId } = await startBroadcast(env.DB, ctx.queue, config, {
    dispatch,
    operatorId: null,
    allowHtmlBlocks: false,
  });
  return { dispatch, broadcastId };
}

describe('broadcast pipeline', () => {
  it('delivers to 2,500 Members exactly once, skipping suppressed and inactive ones', async () => {
    const { channelId, workspaceId } = await seedChannel({ members: 2500 });
    await completeRamp(channelId);
    // Two suppressed addresses and one unsubscribed Member are excluded from the snapshot.
    const someone = await env.DB.prepare(
      'SELECT email FROM members WHERE channel_id = ?1 ORDER BY id LIMIT 3',
    )
      .bind(channelId)
      .all<{ email: string }>();
    const [a, b, c] = someone.results.map((r) => r.email);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO suppressions (id, workspace_id, email, reason, created_at) VALUES (?1, ?2, ?3, 'hard_bounce', 0)`,
      ).bind(newId('suppression'), workspaceId, a!.toUpperCase()),
      env.DB.prepare(
        `INSERT INTO suppressions (id, workspace_id, email, reason, created_at) VALUES (?1, ?2, ?3, 'complaint', 0)`,
      ).bind(newId('suppression'), workspaceId, b),
      env.DB.prepare(`UPDATE members SET status = 'unsubscribed' WHERE email = ?1`).bind(c),
    ]);

    const run = context();
    const { dispatch, broadcastId } = await start(channelId, run);
    await drain(run.ctx, run.queue);

    const row = await broadcastRow(broadcastId);
    expect(row).toMatchObject({
      status: 'sent',
      recipient_count: 2497,
      sent_count: 2497,
      failed_count: 0,
    });
    expect(run.mail.sent).toHaveLength(2497);
    expect(new Set(run.mail.sent.map((m) => m.to)).size).toBe(2497);
    expect(run.mail.sent.map((m) => m.to)).not.toContain(a);
    expect(
      await count('SELECT count(*) AS n FROM deliveries WHERE broadcast_id = ?1', broadcastId),
    ).toBe(2497);
    const status = await env.DB.prepare('SELECT status FROM dispatches WHERE id = ?1')
      .bind(dispatch.id)
      .first<{ status: string }>();
    expect(status?.status).toBe('sent');
  });

  it('builds every message with unsubscribe headers, tracked links and personalisation', async () => {
    const { channelId } = await seedChannel({ members: 2 });
    const run = context();
    await start(channelId, run);
    await drain(run.ctx, run.queue);

    for (const mail of run.mail.sent) {
      const code = /\/u\/([0-9a-f-]+)>/.exec(mail.headers!['List-Unsubscribe']!)![1]!;
      expect(mail.headers!['List-Unsubscribe']).toBe(
        `<https://link.swarm.test/u/${code}>, <mailto:unsub+${code}@unsubscribe.swarm.test>`,
      );
      expect(mail.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
      expect(mail.headers!['Feedback-ID']).toMatch(
        /^bc_[0-9a-f]{32}:ch_[0-9a-f]{32}:broadcast:swarm$/,
      );
      const deliveryId = await readUnsubscribeCode(config.unsubscribeKeys, code);
      expect(mail.messageId).toBe(`${deliveryId}@mail.swarm.test`);
      // The return path has its own code, so the one in the links can't report a bounce.
      const bounce = /^bounce\+([0-9a-f-]+)@unsubscribe\.swarm\.test$/.exec(mail.returnPath!)![1]!;
      expect(bounce).not.toBe(code);
      // Signed with BOUNCE_KEYS, which only send and events hold: track and the api, which hold
      // UNSUBSCRIBE_KEYS, can't make one.
      expect(await readBounceCode(config.bounceKeys!, bounce)).toBe(deliveryId);
      expect(await readBounceCode(config.unsubscribeKeys, bounce)).toBeNull();
      expect(mail.from.address).toMatch(/@mail\.swarm\.test$/);
      expect(mail.text).toContain('Unsubscribe: https://link.swarm.test/u/');

      // The essay link is rewritten to a click token; the original URL is never in the body.
      expect(mail.html).not.toContain('essay.example');
      const click = /href="https:\/\/link\.swarm\.test\/c\/([^"]+)"/.exec(mail.html)![1]!;
      expect(await readTrackToken(config.trackKeys!, click)).toMatchObject({ d: deliveryId });
      expect(mail.html).toMatch(/<img src="https:\/\/link\.swarm\.test\/o\//);
    }
    const greetings = run.mail.sent.map((m) => /Hi ([^,]+),/.exec(m.html)![1]).sort();
    expect(greetings).toEqual(['Ada', 'there']);
  });

  it('links each recipient to their own Member Center in the footer', async () => {
    const { channelId } = await seedChannel({ members: 2 });
    const run = context();
    await start(channelId, run);
    await drain(run.ctx, run.queue);

    const seen = new Set<string>();
    for (const mail of run.mail.sent) {
      const token = /href="https:\/\/forms\.swarm\.test\/m\/([^"]+)"/.exec(mail.html)![1]!;
      expect(mail.text).toContain(`Manage your subscription: https://forms.swarm.test/m/${token}`);
      expect(mail.html).not.toContain('{{@');
      const session = await readMemberSession(verifier, token);
      // A per-family link naming the recipient's own Channel.
      expect(token.startsWith('v2.member.')).toBe(true);
      expect(session?.channelId).toBe(channelId);
      const memberId = session?.memberId;
      const recipient = await env.DB.prepare('SELECT email FROM members WHERE id = ?1')
        .bind(memberId)
        .first<{ email: string }>();
      expect(recipient?.email).toBe(mail.to);
      seen.add(memberId!);
    }
    expect(seen.size).toBe(2);
  });

  it('leaves the open pixel out when the Channel turns open tracking off', async () => {
    const { channelId } = await seedChannel({ members: 1, trackOpens: false });
    const run = context();
    await start(channelId, run);
    await drain(run.ctx, run.queue);
    expect(run.mail.sent[0]!.html).not.toContain('/o/');
  });

  it('regression: skips Members who left after the snapshot, and still finishes', async () => {
    const { channelId, workspaceId } = await seedChannel({ members: 6 });
    await completeRamp(channelId);
    const c = context();
    const { ctx, queue, mail } = c;
    const { broadcastId } = await start(channelId, c);
    // The snapshot and fan-out run; the batch message stays on the queue.
    const batches: SendMessage[] = [];
    await drain(ctx, queue, {
      filter: (message) => {
        if (message.type !== 'batch') return true;
        batches.push(message);
        return false;
      },
    });
    expect(batches).toHaveLength(1);
    expect(mail.sent).toHaveLength(0);

    const rows = await env.DB.prepare(
      'SELECT member_id, email FROM broadcast_recipients WHERE broadcast_id = ?1 ORDER BY member_id',
    )
      .bind(broadcastId)
      .all<{ member_id: string; email: string }>();
    const [unsubscribed, bounced, suppressedHere, deleted, stays, staysToo] = rows.results;
    await env.DB.batch([
      env.DB.prepare("UPDATE members SET status = 'unsubscribed' WHERE id = ?1").bind(
        unsubscribed!.member_id,
      ),
      env.DB.prepare("UPDATE members SET status = 'bounced' WHERE id = ?1").bind(
        bounced!.member_id,
      ),
      // Addresses match whatever their case.
      env.DB.prepare(
        `INSERT INTO suppressions (id, workspace_id, channel_id, email, reason, created_at)
         VALUES (?1, ?2, ?3, ?4, 'manual', 0)`,
      ).bind(newId('suppression'), workspaceId, channelId, suppressedHere!.email.toUpperCase()),
      env.DB.prepare('DELETE FROM members WHERE id = ?1').bind(deleted!.member_id),
    ]);
    await queue.send(batches[0]!);
    await drain(ctx, queue);

    expect(mail.sent.map((m) => m.to).sort()).toEqual([stays!.email, staysToo!.email].sort());
    expect(await broadcastRow(broadcastId)).toMatchObject({
      status: 'sent',
      sent_count: 2,
      recipient_count: 3,
    });
  });

  it('regression: a throttled retry does not mail a Member who complained meanwhile', async () => {
    const { channelId, workspaceId } = await seedChannel({ members: 1 });
    await completeRamp(channelId);
    const c = context();
    const { ctx, queue, mail } = c;
    mail.fail = () => new MailProviderError(429, 'throttled', 'Slow down', 30);
    const { broadcastId } = await start(channelId, c);
    const batches: SendMessage[] = [];
    await drain(ctx, queue, {
      filter: (message) => {
        if (message.type !== 'batch') return true;
        batches.push(message);
        return false;
      },
    });
    await expect(handleSendMessage(ctx, batches[0]!)).rejects.toBeInstanceOf(RetryLater);
    const recipient = await env.DB.prepare(
      'SELECT email FROM broadcast_recipients WHERE broadcast_id = ?1',
    )
      .bind(broadcastId)
      .first<{ email: string }>();
    await env.DB.prepare(
      `INSERT INTO suppressions (id, workspace_id, email, reason, created_at) VALUES (?1, ?2, ?3, 'complaint', 0)`,
    )
      .bind(newId('suppression'), workspaceId, recipient!.email)
      .run();
    mail.fail = null;
    await handleSendMessage(ctx, batches[0]!);
    expect(mail.sent).toEqual([]);
    // Nobody is left to send to, so the Broadcast finishes rather than waiting for the reaper.
    expect((await broadcastRow(broadcastId))?.status).not.toBe('sending');
  });

  it('never sends twice when the queue delivers a batch twice', async () => {
    const { channelId } = await seedChannel({ members: 260 });
    const run = context();
    await completeRamp(channelId);
    const { broadcastId } = await start(channelId, run);
    await drain(run.ctx, run.queue, { duplicateBatches: true });
    expect(run.mail.sent).toHaveLength(260);
    expect((await broadcastRow(broadcastId))?.sent_count).toBe(260);
  });

  it('retries throttled messages without duplicating the ones that went out', async () => {
    const { channelId } = await seedChannel({ members: 120 });
    await completeRamp(channelId);
    const mail = new CaptureMail();
    mail.fail = (_, call) =>
      call % 7 === 0 && call < 60
        ? new SesError(429, 'TooManyRequestsException', 'slow down')
        : null;
    const run = context(mail);
    const { broadcastId } = await start(channelId, run);
    const { retries } = await drain(run.ctx, run.queue);
    expect(retries).toBeGreaterThan(0);
    expect(mail.sent).toHaveLength(120);
    expect(new Set(mail.sent.map((m) => m.to)).size).toBe(120);
    expect(await broadcastRow(broadcastId)).toMatchObject({ status: 'sent', sent_count: 120 });
  });

  it('records rejected addresses as failed and finishes as partially failed', async () => {
    const { channelId } = await seedChannel({ members: 10 });
    const mail = new CaptureMail();
    mail.fail = (m) =>
      m.to.startsWith('m3-') ? new SesError(400, 'MessageRejected', 'bad address') : null;
    const run = context(mail);
    const { broadcastId } = await start(channelId, run);
    await drain(run.ctx, run.queue);
    expect(await broadcastRow(broadcastId)).toMatchObject({
      status: 'partially_failed',
      sent_count: 9,
      failed_count: 1,
    });
  });

  it('pauses the send when the provider suspends sending, with everyone still pending', async () => {
    const { channelId } = await seedChannel({ members: 5 });
    const mail = new CaptureMail();
    mail.fail = () => new SesError(400, 'AccountSuspendedException', 'suspended');
    const run = context(mail);
    const { broadcastId, dispatch } = await start(channelId, run);
    const before = Date.now();
    await drain(run.ctx, run.queue);
    const row = await env.DB.prepare(
      'SELECT status, failure_reason, waiting_for, wait_detail, resume_at FROM broadcasts WHERE id = ?1',
    )
      .bind(broadcastId)
      .first<Record<string, unknown>>();
    // It used to end as failed with the rest of the audience never mailed (limits.test.ts resumes
    // and tries again). Swarm tries the service again by itself in five minutes.
    expect(row).toMatchObject({
      status: 'sending',
      failure_reason: null,
      waiting_for: 'service_stopped',
    });
    expect(row?.resume_at).toBeGreaterThanOrEqual(before + 5 * 60_000);
    expect(row?.resume_at).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    expect(row?.wait_detail).toMatch(/AccountSuspendedException/);
    expect(
      await count(
        `SELECT count(*) AS n FROM broadcast_recipients WHERE broadcast_id = ?1 AND status = 'pending'`,
        broadcastId,
      ),
    ).toBe(5);
    const status = await env.DB.prepare('SELECT status FROM dispatches WHERE id = ?1')
      .bind(dispatch.id)
      .first<{ status: string }>();
    expect(status?.status).toBe('sending');
  });

  it('Resend: a used-up quota makes the send wait; a validation error fails one message', async () => {
    const quota = await seedChannel({ members: 3 });
    const halted = new CaptureMail();
    halted.fail = () => new ResendError(429, 'daily_quota_exceeded', 'quota reached');
    const run = context(halted);
    const { broadcastId } = await start(quota.channelId, run);
    const { delayed } = await drain(run.ctx, run.queue, { stopAtDelay: true });
    const waiting = await env.DB.prepare(
      'SELECT status, waiting_for, wait_detail FROM broadcasts WHERE id = ?1',
    )
      .bind(broadcastId)
      .first<{ status: string; waiting_for: string; wait_detail: string }>();
    expect(waiting).toMatchObject({ status: 'sending', waiting_for: 'service_day' });
    expect(waiting?.wait_detail).toMatch(/daily_quota_exceeded/);
    // Everyone comes back when the quota resets, on a new message, and the fan-out (still walking
    // warm-up's order) looks again then too.
    expect(delayed.map((item) => item.body.type).sort()).toEqual(['batch', 'fanout']);
    expect(delayed.find((item) => item.body.type === 'batch')?.body).toMatchObject({
      broadcastId,
      memberIds: expect.arrayContaining([]),
    });

    const invalid = await seedChannel({ members: 4 });
    const mail = new CaptureMail();
    mail.fail = (m) =>
      m.to.startsWith('m2-') ? new ResendError(422, 'validation_error', 'bad to') : null;
    const second = context(mail);
    const sent = await start(invalid.channelId, second);
    await drain(second.ctx, second.queue);
    expect(await broadcastRow(sent.broadcastId)).toMatchObject({
      status: 'partially_failed',
      sent_count: 3,
      failed_count: 1,
    });
  });

  it('stops midway when canceled', async () => {
    const { channelId } = await seedChannel({ members: 400 });
    await completeRamp(channelId);
    const run = context();
    const { broadcastId } = await start(channelId, run);
    let batches = 0;
    await drain(run.ctx, run.queue, {
      filter: (message) => {
        if (message.type === 'batch' && ++batches === 3) {
          // Cancel while the rest of the batches are still queued.
          void cancelBroadcast(env.DB, broadcastId);
        }
        return true;
      },
    });
    const row = await broadcastRow(broadcastId);
    expect(row?.status).toBe('canceled');
    expect(run.mail.sent.length).toBeLessThan(400);
    expect(run.mail.sent.length).toBeGreaterThanOrEqual(100);
    expect(
      await count(
        `SELECT count(*) AS n FROM broadcast_recipients WHERE broadcast_id = ?1 AND status = 'sent'`,
        broadcastId,
      ),
    ).toBe(run.mail.sent.length);
  });

  it('regression: queued batches of a deleted Channel send nothing, and the send is canceled', async () => {
    const { channelId } = await seedChannel({ members: 250 });
    await completeRamp(channelId);
    const run = context();
    const { dispatch, broadcastId } = await start(channelId, run);
    // The snapshot and fan-out run; the batches wait in the queue.
    const batches: SendMessage[] = [];
    await drain(run.ctx, run.queue, {
      filter: (message) => {
        if (message.type !== 'batch') return true;
        batches.push(message);
        return false;
      },
    });
    expect(batches.length).toBeGreaterThan(1);
    await env.DB.prepare('UPDATE channels SET deleted_at = ?1 WHERE id = ?2')
      .bind(Date.now(), channelId)
      .run();
    for (const batch of batches) await handleSendMessage(run.ctx, batch);
    expect(run.mail.sent).toEqual([]);
    expect(await broadcastRow(broadcastId)).toMatchObject({
      status: 'canceled',
      failure_reason: 'The publication was deleted, so the rest of this send was canceled.',
    });
    expect(
      await env.DB.prepare('SELECT status FROM dispatches WHERE id = ?1').bind(dispatch.id).first(),
    ).toEqual({ status: 'canceled' });
    expect(
      await count(
        `SELECT count(*) AS n FROM broadcast_recipients WHERE broadcast_id = ?1 AND status = 'skipped'`,
        broadcastId,
      ),
    ).toBe(250);
  });

  it('refuses a second live Broadcast for the same Dispatch', async () => {
    const { channelId } = await seedChannel({ members: 3 });
    const run = context();
    const dispatch = await seedDispatch(channelId);
    await startBroadcast(env.DB, run.queue, config, {
      dispatch,
      operatorId: null,
      allowHtmlBlocks: false,
    });
    await expect(
      startBroadcast(env.DB, run.queue, config, {
        dispatch,
        operatorId: null,
        allowHtmlBlocks: false,
      }),
    ).rejects.toMatchObject({ code: 'already_sending' });
    // A racing second call that read the Dispatch before the first one committed still loses.
    await env.DB.prepare(`UPDATE dispatches SET status = 'draft' WHERE id = ?1`)
      .bind(dispatch.id)
      .run();
    await expect(
      startBroadcast(env.DB, run.queue, config, {
        dispatch,
        operatorId: null,
        allowHtmlBlocks: false,
      }),
    ).rejects.toBeInstanceOf(StartError);
    expect(
      await count('SELECT count(*) AS n FROM broadcasts WHERE dispatch_id = ?1', dispatch.id),
    ).toBe(1);
  });

  it('resumes a stuck Broadcast whose batch message was lost', async () => {
    const { channelId } = await seedChannel({ members: 150 });
    await completeRamp(channelId);
    let clock = Date.now();
    const run = context(new CaptureMail(), () => clock);
    const { broadcastId } = await start(channelId, run);
    let dropped = false;
    await drain(run.ctx, run.queue, {
      filter: (message) => {
        if (message.type === 'batch' && !dropped) {
          dropped = true;
          return false;
        }
        return true;
      },
    });
    expect(run.mail.sent).toHaveLength(100);
    expect((await broadcastRow(broadcastId))?.status).toBe('sending');

    clock += 11 * 60 * 1000;
    expect(await reap(run.ctx)).toContain(broadcastId);
    await drain(run.ctx, run.queue);
    // The reaper also resumes other tests' unfinished Broadcasts in this shared database.
    const ours = run.mail.sent.filter((m) => m.tags?.broadcast === broadcastId);
    expect(ours).toHaveLength(150);
    expect(new Set(ours.map((m) => m.to)).size).toBe(150);
    expect((await broadcastRow(broadcastId))?.status).toBe('sent');
  });

  it('holds sends to the Reputation Ramp cap and continues the next day', async () => {
    const { channelId } = await seedChannel({ members: 180 });
    let clock = Date.parse('2026-10-27T09:00:00Z');
    const run = context(new CaptureMail(), () => clock);
    const dispatch = await seedDispatch(channelId);
    const { broadcastId } = await startBroadcast(env.DB, run.queue, config, {
      dispatch,
      operatorId: null,
      allowHtmlBlocks: false,
      now: clock,
    });
    const first = await drain(run.ctx, run.queue, { stopAtDelay: true });
    // The shared platform domain starts at 100 a day.
    expect(run.mail.sent).toHaveLength(100);
    expect(first.delayed).toHaveLength(1);
    expect((await broadcastRow(broadcastId))?.status).toBe('sending');
    // Waiting for the ramp is not "stuck".
    expect(await reap(run.ctx)).not.toContain(broadcastId);

    clock = Date.parse('2026-10-28T00:05:00Z');
    run.queue.items.push({ body: first.delayed[0]!.body, delaySeconds: 0 });
    await drain(run.ctx, run.queue, { stopAtDelay: true });
    expect(run.mail.sent).toHaveLength(180);
    expect((await broadcastRow(broadcastId))?.status).toBe('sent');
    const ramp = await env.DB.prepare(
      'SELECT cap_today, sent_today FROM reputation_ramps WHERE channel_id = ?1',
    )
      .bind(channelId)
      .first<{ cap_today: number; sent_today: number }>();
    // Day one used its whole cap and stayed healthy, so the cap grew by 1.3×.
    expect(ramp).toEqual({ cap_today: 130, sent_today: 80 });
    expect(
      await count(
        'SELECT count(*) AS n FROM reputation_ramp_days WHERE ramp_id = (SELECT id FROM reputation_ramps WHERE channel_id = ?1)',
        channelId,
      ),
    ).toBe(1);
  });

  it('regression: a ramp-held send of a deleted Channel does not continue the next day', async () => {
    const { channelId } = await seedChannel({ members: 180 });
    let clock = Date.parse('2026-10-27T09:00:00Z');
    const run = context(new CaptureMail(), () => clock);
    const dispatch = await seedDispatch(channelId);
    const { broadcastId } = await startBroadcast(env.DB, run.queue, config, {
      dispatch,
      operatorId: null,
      allowHtmlBlocks: false,
      now: clock,
    });
    const first = await drain(run.ctx, run.queue, { stopAtDelay: true });
    expect(run.mail.sent).toHaveLength(100);
    expect(first.delayed).toHaveLength(1);
    await env.DB.prepare('UPDATE channels SET deleted_at = ?1 WHERE id = ?2')
      .bind(clock, channelId)
      .run();

    clock = Date.parse('2026-10-28T00:05:00Z');
    run.queue.items.push({ body: first.delayed[0]!.body, delaySeconds: 0 });
    await drain(run.ctx, run.queue, { stopAtDelay: true });
    expect(run.mail.sent).toHaveLength(100);
    expect((await broadcastRow(broadcastId))?.status).toBe('canceled');
  });

  it('excludes an address from the next send once it hard-bounces', async () => {
    const { channelId } = await seedChannel({ members: 4 });
    const run = context();
    await start(channelId, run);
    await drain(run.ctx, run.queue);
    const victim = run.mail.sent[0]!;
    const deliveryId = victim.messageId!.split('@')[0]!;
    const result = await applySesEvent(env.DB, {
      eventType: 'Bounce',
      mail: { messageId: 'unknown', tags: { delivery: [deliveryId] } },
      bounce: {
        bounceType: 'Permanent',
        bounceSubType: 'General',
        bouncedRecipients: [{ emailAddress: victim.to }],
      },
    });
    expect(result).toMatchObject({ handled: true, kind: 'hard_bounce' });
    const member = await env.DB.prepare('SELECT status FROM members WHERE email = ?1')
      .bind(victim.to)
      .first<{ status: string }>();
    expect(member?.status).toBe('bounced');

    const again = context();
    await start(channelId, again);
    await drain(again.ctx, again.queue);
    expect(again.mail.sent.map((m) => m.to)).not.toContain(victim.to);
    expect(again.mail.sent).toHaveLength(3);
  });

  it('suppresses at the third email in a row to bounce softly, and marks complainers complained', async () => {
    const { channelId } = await seedChannel({ members: 2 });
    const run = context();
    await start(channelId, run);
    await drain(run.ctx, run.queue);
    const [soft, angry] = run.mail.sent;
    const tags = (m: typeof soft) => ({ delivery: [m!.messageId!.split('@')[0]!] });
    // Two earlier emails to this reader bounced softly; the default bounce rule stops at 3 in a
    // row (docs/deliverability.md "Bounces"). This email is reported three times and counts once.
    await env.DB.prepare(
      `INSERT INTO bounce_states (id, workspace_id, email, soft_streak, last_kind, last_cause, last_bounced_at, created_at, updated_at)
       SELECT ?1, workspace_id, ?2, 2, 'soft', 'mailbox_full', 0, 0, 0 FROM channels WHERE id = ?3`,
    )
      .bind(newId('bounceState'), soft!.to, channelId)
      .run();
    for (let i = 0; i < 3; i++) {
      await applySesEvent(env.DB, {
        eventType: 'Bounce',
        mail: { tags: tags(soft) },
        bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: soft!.to }] },
      });
    }
    expect(await count('SELECT count(*) AS n FROM suppressions WHERE email = ?1', soft!.to)).toBe(
      1,
    );

    await applySesEvent(env.DB, {
      notificationType: 'Complaint',
      mail: { tags: tags(angry) },
      complaint: { complainedRecipients: [{ emailAddress: angry!.to }] },
    });
    const member = await env.DB.prepare('SELECT status FROM members WHERE email = ?1')
      .bind(angry!.to)
      .first<{ status: string }>();
    expect(member?.status).toBe('complained');
    expect(
      await count(
        `SELECT count(*) AS n FROM suppressions WHERE email = ?1 AND reason = 'complaint'`,
        angry!.to,
      ),
    ).toBe(1);
    expect(
      await count(`SELECT count(*) AS n FROM audit_events WHERE action = 'member.complained'`),
    ).toBeGreaterThan(0);
  });
});

describe('send monitor', () => {
  it('publishes the Broadcast counters to its SendMonitor', async () => {
    const { channelId } = await seedChannel({ members: 3 });
    await completeRamp(channelId);
    const run = context();
    const { broadcastId } = await start(channelId, run);
    await drain(run.ctx, run.queue);

    await publishProgress(env.DB, env.SEND_MONITOR, [broadcastId, broadcastId]);
    const stub = env.SEND_MONITOR.get(env.SEND_MONITOR.idFromName(broadcastId)) as unknown as {
      latest(): Promise<unknown>;
    };
    expect(await stub.latest()).toMatchObject({
      broadcastId,
      status: 'sent',
      recipientCount: 3,
      sentCount: 3,
      failedCount: 0,
    });
  });

  it('does nothing without the binding', async () => {
    await expect(publishProgress(env.DB, undefined, ['br_missing'])).resolves.toBeUndefined();
  });
});

describe('preflight', () => {
  it('blocks a custom domain until it is verified and DMARC is enforced', async () => {
    const { channelId, workspaceId } = await seedChannel({ members: 5 });
    const domainId = newId('sendingDomain');
    const identityId = newId('senderIdentity');
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sending_domains (id, workspace_id, channel_id, domain, kind, status, dmarc_policy, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'email', 'verified', 'none', ?5, ?5)`,
      ).bind(
        domainId,
        workspaceId,
        channelId,
        `news-${crypto.randomUUID().slice(0, 6)}.example.com`,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO sender_identities (id, channel_id, sending_domain_id, from_name, from_local, is_default, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'Field Notes', 'hello', 1, ?4, ?4)`,
      ).bind(identityId, channelId, domainId, now),
    ]);
    const dispatch = await seedDispatch(channelId);
    const blocked = await preflight(env.DB, config, dispatch, { allowHtmlBlocks: false });
    expect(blocked.ready).toBe(false);
    expect(blocked.checks.find((c) => c.key === 'dmarc')).toMatchObject({ ok: false });
    expect(blocked.recipientCount).toBe(5);
    const run = context();
    await expect(
      startBroadcast(env.DB, run.queue, config, {
        dispatch,
        operatorId: null,
        allowHtmlBlocks: false,
      }),
    ).rejects.toMatchObject({ code: 'not_ready' });

    await env.DB.prepare(`UPDATE sending_domains SET dmarc_policy = 'quarantine' WHERE id = ?1`)
      .bind(domainId)
      .run();
    const ready = await preflight(env.DB, config, dispatch, { allowHtmlBlocks: false });
    expect(ready.ready).toBe(true);
    expect(ready.from?.address).toMatch(/^hello@news-/);
  });

  it('needs a subject, content and at least one Member', async () => {
    const { channelId } = await seedChannel();
    const dispatch = await seedDispatch(channelId, {
      subject: '',
      content_json: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] }),
    });
    const result = await preflight(env.DB, config, dispatch, { allowHtmlBlocks: false });
    expect(result.ready).toBe(false);
    expect(
      result.checks
        .filter((c) => !c.ok)
        .map((c) => c.key)
        .sort(),
    ).toEqual(['audience', 'content', 'subject']);
  });

  it('regression: refuses to start a send for a deleted Channel', async () => {
    const { channelId } = await seedChannel({ members: 1 });
    await completeRamp(channelId);
    const dispatch = await seedDispatch(channelId);
    await env.DB.prepare('UPDATE channels SET deleted_at = ?1 WHERE id = ?2')
      .bind(Date.now(), channelId)
      .run();
    const result = await preflight(env.DB, config, dispatch, { allowHtmlBlocks: false });
    expect(result.ready).toBe(false);
    expect(result.checks.filter((c) => !c.ok).map((c) => c.message)).toEqual([
      'This publication is deleted.',
    ]);
    const run = context();
    await expect(
      startBroadcast(env.DB, run.queue, config, {
        dispatch,
        operatorId: null,
        allowHtmlBlocks: false,
      }),
    ).rejects.toMatchObject({ code: 'not_ready' });
    expect(
      await count('SELECT COUNT(*) AS n FROM broadcasts WHERE dispatch_id = ?1', dispatch.id),
    ).toBe(0);
  });
});

describe('volume', () => {
  it('adds more Members than one snapshot chunk', async () => {
    const { channelId } = await seedChannel({ members: 1000 });
    await addMembers(channelId, 1, 'extra');
    await completeRamp(channelId);
    const run = context();
    const { broadcastId } = await start(channelId, run);
    await drain(run.ctx, run.queue);
    expect(await broadcastRow(broadcastId)).toMatchObject({
      status: 'sent',
      recipient_count: 1001,
    });
  });
});
