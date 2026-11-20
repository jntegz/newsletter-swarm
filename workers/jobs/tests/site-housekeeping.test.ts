import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DAILY_CRON } from '../src/crons';
import { runScheduled } from '../src/index';
import { addMember, jobsEnv, seedChannel } from './helpers';

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 9, 27, 3, 30);

async function count(sql: string, ...values: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql)
    .bind(...values)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe('site edge housekeeping (daily cron)', () => {
  it('prunes old visitor hashes, spent reader tokens and expired reader sessions', async () => {
    const { channelId } = await seedChannel();
    const memberId = await addMember(channelId, `reader-${crypto.randomUUID()}@example.com`);
    const hash = () => crypto.randomUUID().replace(/-/g, '');
    const insertVisitor = (day: string) =>
      env.DB.prepare(
        'INSERT INTO site_visitors (channel_id, day, visitor_hash) VALUES (?1, ?2, ?3)',
      )
        .bind(channelId, day, hash())
        .run();
    await insertVisitor('2026-10-27');
    await insertVisitor('2026-10-26');
    await insertVisitor('2026-10-25');

    const insertToken = (expiresAt: number) =>
      env.DB.prepare(
        `INSERT INTO reader_tokens (token_hash, channel_id, member_id, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
        .bind(hash(), channelId, memberId, expiresAt - 1, expiresAt)
        .run();
    await insertToken(NOW - 2 * DAY_MS); // a day past expiry: deleted
    await insertToken(NOW - 60_000); // recently expired: kept for a day

    const insertSession = (expiresAt: number) =>
      env.DB.prepare(
        `INSERT INTO reader_sessions (id_hash, channel_id, member_id, created_at, last_seen_at, expires_at)
         VALUES (?1, ?2, ?3, 0, 0, ?4)`,
      )
        .bind(hash(), channelId, memberId, expiresAt)
        .run();
    await insertSession(NOW - 1);
    await insertSession(NOW + DAY_MS);

    const { env: jobs } = jobsEnv();
    // The five-minute cron leaves the site tables alone.
    await runScheduled(jobs, '*/5 * * * *', NOW);
    expect(
      await count('SELECT COUNT(*) AS n FROM site_visitors WHERE channel_id = ?1', channelId),
    ).toBe(3);

    await runScheduled(jobs, DAILY_CRON, NOW);
    const days = await env.DB.prepare(
      'SELECT day FROM site_visitors WHERE channel_id = ?1 ORDER BY day',
    )
      .bind(channelId)
      .all<{ day: string }>();
    expect(days.results.map((row) => row.day)).toEqual(['2026-10-26', '2026-10-27']);
    expect(
      await count('SELECT COUNT(*) AS n FROM reader_tokens WHERE member_id = ?1', memberId),
    ).toBe(1);
    expect(
      await count('SELECT COUNT(*) AS n FROM reader_sessions WHERE member_id = ?1', memberId),
    ).toBe(1);
  });
});
