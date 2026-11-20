// Inactive-reader cleanup (membercenter.ts sunsetInactiveMembers): only on evidence that covers
// the whole chosen period, never for readers whose opens can't be seen, and only after a notice
// that lets them stay with one click.
import { env } from 'cloudflare:test';
import {
  keepAfterSunsetNotice,
  localMemberLinks,
  scoreEngagementBatch,
  sunsetInactiveMembers,
  SUNSET_MIN_SENT,
  SUNSET_NOTICE_DAYS,
  SUNSET_REASON_PREFIX,
  type AudienceDeps,
} from '@swarm/engine';
import type { OutgoingMail } from '@swarm/mail';
import { newId } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { one, seedChannel } from './helpers';
import { testLinks } from './links';

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 4, 12);

/** A mail adapter that keeps what it was asked to send. */
function recordingDeps(): AudienceDeps & { sent: OutgoingMail[] } {
  const sent: OutgoingMail[] = [];
  return {
    sent,
    db: env.DB,
    mail: {
      async send(mail: OutgoingMail) {
        sent.push(mail);
        return { messageId: `test-${sent.length}` };
      },
    },
    links: testLinks(),
    memberLinks: localMemberLinks(testLinks()),
    captureOrigin: 'https://capture.example.test',
    platformMailDomain: 'mail.example.test',
  };
}

type World = { workspaceId: string; channelId: string };

async function world(settings: Record<string, unknown>, retentionMonths = 13): Promise<World> {
  const seeded = await seedChannel();
  await env.DB.batch([
    env.DB.prepare('UPDATE channels SET settings_json = ?1 WHERE id = ?2').bind(
      JSON.stringify(settings),
      seeded.channelId,
    ),
    env.DB.prepare('UPDATE workspaces SET engagement_retention_months = ?1 WHERE id = ?2').bind(
      retentionMonths,
      seeded.workspaceId,
    ),
  ]);
  return seeded;
}

async function reader(w: World, createdDaysAgo = 500): Promise<string> {
  const id = newId('member');
  const created = now - createdDaysAgo * DAY;
  await env.DB.prepare(
    `INSERT INTO members (id, channel_id, email, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'active', ?4, ?4)`,
  )
    .bind(id, w.channelId, `${id}@example.org`, created)
    .run();
  return id;
}

async function post(w: World, at: number): Promise<string> {
  const dispatchId = newId('dispatch');
  const id = newId('broadcast');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, content_json, status, created_at, updated_at)
       VALUES (?1, ?2, 'Post', '{}', 'sent', ?3, ?3)`,
    ).bind(dispatchId, w.channelId, at),
    env.DB.prepare(
      `INSERT INTO broadcasts (id, dispatch_id, channel_id, workspace_id, status, subject, preheader, html, text,
         from_name, from_address, track_opens, kind, created_at, last_progress_at, completed_at)
       VALUES (?1, ?2, ?3, ?4, 'sent', 'Post', '', '', '', 'A', 'a@example.com', 1, 'broadcast', ?5, ?5, ?5)`,
    ).bind(id, dispatchId, w.channelId, w.workspaceId, at),
  ]);
  return id;
}

/** One delivery `daysAgo`; `seen` is what opened it: nothing, a machine only, or a person. */
async function deliver(
  w: World,
  memberId: string,
  daysAgo: number,
  seen: 'none' | 'machine' | 'human_open' | 'human_click' = 'none',
) {
  const at = now - daysAgo * DAY;
  const broadcastId = await post(w, at);
  const opened = seen === 'none' ? null : at + 60_000;
  const human = seen === 'human_open' || seen === 'human_click' ? at + 60_000 : null;
  await env.DB.prepare(
    `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, status, sent_at,
       opened_at, human_opened_at, clicked_at, human_clicked_at)
     VALUES (?1, ?2, ?3, ?4, ?4 || '@example.org', 'delivered', ?5, ?6, ?7, ?8, ?8)`,
  )
    .bind(
      newId('delivery'),
      broadcastId,
      w.channelId,
      memberId,
      at,
      opened,
      seen === 'human_open' ? human : null,
      seen === 'human_click' ? human : null,
    )
    .run();
}

/** `count` quiet deliveries spread over the last 80 days. */
async function quietMail(w: World, memberId: string, count = SUNSET_MIN_SENT + 1) {
  for (let i = 0; i < count; i++) await deliver(w, memberId, 10 + i * 12);
}

/** The engagement rollup (today's pass for the Channel), then the cleanup, at `at`. */
async function runAt(w: World, deps: AudienceDeps, at: number) {
  let cursor: string | null = null;
  do cursor = await scoreEngagementBatch(env.DB, w.channelId, cursor, at);
  while (cursor);
  return sunsetInactiveMembers({ ...deps, now: () => at }, at);
}

const member = (id: string) =>
  one<{
    status: string;
    unsubscribe_reason: string | null;
    sunset_notice_at: number | null;
    sunset_kept_at: number | null;
  }>(
    'SELECT status, unsubscribe_reason, sunset_notice_at, sunset_kept_at FROM members WHERE id = ?1',
    id,
  );

describe('unsubscribing inactive readers', () => {
  it('does nothing unless the owner chose a time', async () => {
    const w = await world({});
    const id = await reader(w);
    await quietMail(w, id);
    const deps = recordingDeps();
    await runAt(w, deps, now);
    expect(await member(id)).toMatchObject({ status: 'active', sunset_notice_at: null });
    expect(deps.sent).toHaveLength(0);
  });

  it('never treats a reader whose opens are hidden as inactive', async () => {
    const w = await world({ sunsetDays: 180 });
    const hidden = await reader(w);
    const silent = await reader(w);
    for (let i = 0; i < SUNSET_MIN_SENT + 1; i++) {
      await deliver(w, hidden, 10 + i * 12, 'machine');
      await deliver(w, silent, 10 + i * 12);
    }
    const deps = recordingDeps();
    await runAt(w, deps, now);
    // The rollup itself says the hidden reader can't be measured.
    expect(
      await one('SELECT band, last_engaged_at FROM member_engagement WHERE member_id = ?1', hidden),
    ).toEqual({ band: 'opens_hidden', last_engaged_at: null });
    await runAt(w, deps, now + (SUNSET_NOTICE_DAYS + 1) * DAY);
    expect(await member(hidden)).toMatchObject({ status: 'active', sunset_notice_at: null });
    expect(deps.sent.map((m) => m.to)).not.toContain(`${hidden}@example.org`);
    // Positive control: the reader with no opens at all is handled by the rule.
    expect((await member(silent))!.status).toBe('unsubscribed');
  });

  it('measures the whole chosen period, not just the 90 days the score looks at', async () => {
    const w = await world({ sunsetDays: 365 });
    const engaged120 = await reader(w);
    const engaged30 = await reader(w);
    const engaged400 = await reader(w);
    await deliver(w, engaged120, 120, 'human_click');
    await deliver(w, engaged30, 30, 'human_open');
    await deliver(w, engaged400, 400, 'human_click');
    for (const id of [engaged120, engaged30, engaged400]) await quietMail(w, id);
    const deps = recordingDeps();
    await runAt(w, deps, now);
    // The 90-day score no longer sees the click 120 days ago; the cleanup still does.
    expect(
      await one('SELECT last_engaged_at FROM member_engagement WHERE member_id = ?1', engaged120),
    ).toEqual({ last_engaged_at: null });
    expect(await member(engaged120)).toMatchObject({ status: 'active', sunset_notice_at: null });
    expect(await member(engaged30)).toMatchObject({ status: 'active', sunset_notice_at: null });
    // Really inactive for the whole year: told first.
    expect((await member(engaged400))!.sunset_notice_at).toBe(now);
    await runAt(w, deps, now + (SUNSET_NOTICE_DAYS + 1) * DAY);
    expect((await member(engaged120))!.status).toBe('active');
    expect((await member(engaged400))!.status).toBe('unsubscribed');
  });

  it('waits when the workspace keeps less history than the chosen period', async () => {
    const w = await world({ sunsetDays: 365 }, 6);
    const silent = await reader(w);
    await quietMail(w, silent);
    const deps = recordingDeps();
    const result = await runAt(w, deps, now);
    expect(result).toMatchObject({ unmeasurable: 1, noticed: 0, unsubscribed: 0 });
    expect(await member(silent)).toMatchObject({ status: 'active', sunset_notice_at: null });
  });

  it('reads nothing sent before the history limit, even before retention has cleared it', async () => {
    // 13 months of history, a one-year period: the reader reopened an email sent 420 days ago
    // (past the limit, still tied to them because the retention job hasn't reached it).
    const w = await world({ sunsetDays: 365 }, 13);
    const silent = await reader(w);
    const at = now - 420 * DAY;
    const broadcastId = await post(w, at);
    await env.DB.prepare(
      `INSERT INTO deliveries (id, broadcast_id, channel_id, member_id, email, status, sent_at,
         opened_at, human_opened_at)
       VALUES (?1, ?2, ?3, ?4, ?4 || '@example.org', 'delivered', ?5, ?6, ?6)`,
    )
      .bind(newId('delivery'), broadcastId, w.channelId, silent, at, now - 20 * DAY)
      .run();
    await quietMail(w, silent);
    const deps = recordingDeps();
    await runAt(w, deps, now);
    expect((await member(silent))!.sunset_notice_at).toBe(now);
  });

  it('skips newcomers, rarely mailed readers and people who pay', async () => {
    const w = await world({ sunsetDays: 180 });
    const newcomer = await reader(w, 30);
    const fewEmails = await reader(w);
    const payer = await reader(w);
    await quietMail(w, newcomer);
    await quietMail(w, fewEmails, SUNSET_MIN_SENT - 1);
    await quietMail(w, payer);
    await env.DB.prepare(
      `INSERT INTO member_entitlements (member_id, channel_id, kind, source, starts_at)
       VALUES (?1, ?2, 'paid', 'comp', 0)`,
    )
      .bind(payer, w.channelId)
      .run();
    const deps = recordingDeps();
    await runAt(w, deps, now);
    expect(deps.sent).toHaveLength(0);
    for (const id of [newcomer, fewEmails, payer]) {
      expect(await member(id)).toMatchObject({ status: 'active', sunset_notice_at: null });
    }
  });

  it('tells the reader first, waits, then records why it unsubscribed them', async () => {
    const w = await world({ sunsetDays: 180 });
    const silent = await reader(w);
    await quietMail(w, silent);
    const deps = recordingDeps();
    expect(await runAt(w, deps, now)).toMatchObject({ noticed: 1, unsubscribed: 0 });
    expect(await member(silent)).toMatchObject({ status: 'active', sunset_notice_at: now });
    expect(deps.sent).toHaveLength(1);
    const notice = deps.sent[0]!;
    expect(notice.to).toBe(`${silent}@example.org`);
    expect(notice.text).toContain('Keep me subscribed');
    expect(notice.text).toContain('https://capture.example.test/m/');

    // Inside the grace period nothing changes and no second notice goes out.
    await runAt(w, deps, now + 7 * DAY);
    expect((await member(silent))!.status).toBe('active');
    expect(deps.sent).toHaveLength(1);

    const later = now + (SUNSET_NOTICE_DAYS + 1) * DAY;
    expect(await runAt(w, deps, later)).toMatchObject({ unsubscribed: 1 });
    const after = (await member(silent))!;
    expect(after.status).toBe('unsubscribed');
    expect(after.unsubscribe_reason).toMatch(new RegExp(`^${SUNSET_REASON_PREFIX} \\(180 days\\)`));
    expect(after.unsubscribe_reason).toContain('no opens or clicks');
  });

  it('keeps a reader who chose to stay, for a whole new period', async () => {
    const w = await world({ sunsetDays: 180 });
    const stays = await reader(w);
    await quietMail(w, stays);
    const deps = recordingDeps();
    await runAt(w, deps, now);
    expect(await keepAfterSunsetNotice(env.DB, stays, now + DAY)).toBe(true);
    await runAt(w, deps, now + (SUNSET_NOTICE_DAYS + 1) * DAY);
    expect(await member(stays)).toMatchObject({
      status: 'active',
      sunset_notice_at: null,
      sunset_kept_at: now + DAY,
    });
    expect(deps.sent).toHaveLength(1);
    // Staying is only for someone who was told.
    expect(await keepAfterSunsetNotice(env.DB, stays, now + 2 * DAY)).toBe(false);
  });

  it('sends a fresh notice rather than acting on an old one', async () => {
    const w = await world({ sunsetDays: 180 });
    const silent = await reader(w);
    await quietMail(w, silent);
    await env.DB.prepare('UPDATE members SET sunset_notice_at = ?1 WHERE id = ?2')
      .bind(now - 70 * DAY, silent)
      .run();
    const deps = recordingDeps();
    expect(await runAt(w, deps, now)).toMatchObject({ noticed: 1, unsubscribed: 0 });
    expect(await member(silent)).toMatchObject({ status: 'active', sunset_notice_at: now });
  });
});
