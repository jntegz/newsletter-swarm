import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import { readAskToken, startBroadcast } from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { config, context, drain, seedChannel, seedDispatch, verifier } from './harness';

async function seedPoll(channelId: string) {
  const askId = newId('ask');
  const questionId = newId('askQuestion');
  const yes = newId('askOption');
  const no = newId('askOption');
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO asks (id, channel_id, kind, title, status, created_at, updated_at)
       VALUES (?1, ?2, 'poll', 'Reader poll', 'open', ?3, ?3)`,
    ).bind(askId, channelId, now),
    env.DB.prepare(
      `INSERT INTO ask_questions (id, ask_id, position, prompt, kind) VALUES (?1, ?2, 0, 'More foxes?', 'choice')`,
    ).bind(questionId, askId),
    env.DB.prepare(
      `INSERT INTO ask_options (id, ask_id, question_id, label, position) VALUES (?1, ?2, ?3, 'Yes', 0), (?4, ?2, ?3, 'No', 1)`,
    ).bind(yes, askId, questionId, no),
  ]);
  return { askId, questionId, yes, no };
}

const pollDoc = (askId: string, questionId: string) =>
  JSON.stringify({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Quick question.' }] },
      { type: 'askPoll', attrs: { askId, questionId } },
    ],
  });

describe('one-tap polls in a send', () => {
  it('gives every recipient their own signed poll links', async () => {
    const { channelId } = await seedChannel({ members: 2 });
    const poll = await seedPoll(channelId);
    const run = context();
    const dispatch = await seedDispatch(channelId, {
      content_json: pollDoc(poll.askId, poll.questionId),
    });
    await startBroadcast(env.DB, run.queue, config, {
      dispatch,
      operatorId: null,
      allowHtmlBlocks: false,
    });
    await drain(run.ctx, run.queue);
    expect(run.mail.sent).toHaveLength(2);
    const members = new Set<string>();
    for (const mail of run.mail.sent) {
      expect(mail.html).not.toContain('{{@ask:');
      expect(mail.text).not.toContain('{{@ask:');
      const tokens = [
        ...mail.html.matchAll(/href="https:\/\/forms\.swarm\.test\/a\/([^"]+)"/g),
      ].map((m) => m[1]!);
      expect(tokens).toHaveLength(2);
      const reads = await Promise.all(tokens.map((t) => readAskToken(verifier, t)));
      const options = reads.map((r) => (r.ok ? r.optionId : null));
      expect(options).toEqual([poll.yes, poll.no]);
      const memberIds = new Set(reads.map((r) => (r.ok ? r.memberId : null)));
      expect(memberIds.size).toBe(1);
      const [memberId] = [...memberIds];
      const row = await env.DB.prepare('SELECT email FROM members WHERE id = ?1')
        .bind(memberId)
        .first<{ email: string }>();
      expect(row?.email).toBe(mail.to);
      members.add(memberId!);
    }
    expect(members.size).toBe(2);
  });

  it('refuses a poll from another Channel', async () => {
    const { channelId } = await seedChannel({ members: 1 });
    const other = await seedChannel();
    const poll = await seedPoll(other.channelId);
    const run = context();
    const dispatch = await seedDispatch(channelId, {
      content_json: pollDoc(poll.askId, poll.questionId),
    });
    await expect(
      startBroadcast(env.DB, run.queue, config, {
        dispatch,
        operatorId: null,
        allowHtmlBlocks: false,
      }),
    ).rejects.toThrow();
  });
});
