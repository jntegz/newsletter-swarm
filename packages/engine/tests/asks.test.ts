import { signToken } from '@swarm/tokens';
import { describe, expect, it } from 'vitest';
import {
  askOptionIds,
  askPageToken,
  askToken,
  collectAskBlocks,
  readAskPageToken,
  readAskToken,
} from '../src/asks';
import { leaveToken, memberToken, readMemberSession } from '../src/confirm';
import { pickJourneyVariant } from '../src/journeys';
import { memberKeys, workerLinks } from './link-keys';

const send = workerLinks('send');
const capture = workerLinks('capture');
const site = workerLinks('site');
const memberId = `mb_${'a'.repeat(32)}`;
const channelId = `ch_${'e'.repeat(32)}`;
const member = { memberId, channelId };
const optionId = `ao_${'b'.repeat(32)}`;
const askId = `ak_${'c'.repeat(32)}`;
const ask = { id: askId, channelId };

describe('Ask tokens', () => {
  it("round-trips a poll token from send to capture, with the Member's Channel", async () => {
    const token = await askToken(send, member, optionId);
    expect(token.startsWith('v2.ask.')).toBe(true);
    expect(await readAskToken(capture, token)).toEqual({ ok: true, memberId, optionId, channelId });
    // Capture holds only the public key: it can't make one.
    await expect(askToken(capture, member, optionId)).rejects.toThrow(/ASK_SIGNING_KEYS/);
  });

  it('refuses other purposes at the poll link, and poll tokens elsewhere', async () => {
    const center = await memberToken(send, member);
    const leave = await leaveToken(capture, member);
    const page = await askPageToken(capture, member, askId);
    expect((await readAskToken(capture, center)).ok).toBe(false);
    expect((await readAskToken(capture, leave)).ok).toBe(false);
    expect((await readAskToken(capture, page)).ok).toBe(false);
    const poll = await askToken(send, member, optionId);
    expect(await readMemberSession(capture, poll)).toBeNull();
    expect(await readAskPageToken(site, poll, ask)).toBeNull();
  });

  it('expires poll tokens after 90 days', async () => {
    const now = Date.now();
    const token = await askToken(send, member, optionId, now);
    expect((await readAskToken(capture, token, now + 89 * 86_400_000)).ok).toBe(true);
    expect(await readAskToken(capture, token, now + 91 * 86_400_000)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('refuses malformed payloads', async () => {
    const bad = await send.sign(
      'ask',
      { m: 'x', o: optionId, c: channelId },
      { expiresInSeconds: 60 },
    );
    expect((await readAskToken(capture, bad)).ok).toBe(false);
  });

  it('takes a one-tap link from before the cutover, which names no Channel', async () => {
    const old = await signToken(
      memberKeys,
      'ask',
      { m: memberId, o: optionId },
      { expiresInSeconds: 90 * 86_400, now: Date.now() - 2 * 86_400_000 },
    );
    expect(await readAskToken(capture, old)).toEqual({
      ok: true,
      memberId,
      optionId,
      channelId: null,
    });
  });

  it('scopes survey-page tokens to one Ask and its Channel', async () => {
    const token = await askPageToken(capture, member, askId);
    expect(await readAskPageToken(site, token, ask)).toBe(memberId);
    expect(await readAskPageToken(site, token, { ...ask, id: `ak_${'d'.repeat(32)}` })).toBeNull();
    // The same Ask id under another Channel's name is not this one.
    expect(
      await readAskPageToken(site, token, { ...ask, channelId: `ch_${'f'.repeat(32)}` }),
    ).toBeNull();
  });
});

describe('poll blocks', () => {
  it('collects top-level poll blocks and placeholder option ids', () => {
    const questionId = `aq_${'e'.repeat(32)}`;
    expect(
      collectAskBlocks({
        type: 'doc',
        content: [{ type: 'paragraph' }, { type: 'askPoll', attrs: { askId, questionId } }],
      }),
    ).toEqual([{ askId, questionId }]);
    expect(
      askOptionIds(`<a href="{{@ask:${optionId}}}">`, `x {{@ask:${optionId}}} {{@ask:nope}}`),
    ).toEqual([optionId]);
  });
});

describe('Signup Journey variants', () => {
  const journey = {
    id: `sj_${'f'.repeat(32)}`,
    winnerKey: null,
    variants: [
      { key: 'a', weight: 50, steps: [{ kind: 'recommendations' as const }] },
      { key: 'b', weight: 50, steps: [{ kind: 'recommendations' as const }] },
    ],
  };

  it('is deterministic per seed and uses every variant', async () => {
    const picks = await Promise.all(
      Array.from({ length: 200 }, (_, i) => pickJourneyVariant(journey, `seed-${i}`)),
    );
    const again = await Promise.all(
      Array.from({ length: 200 }, (_, i) => pickJourneyVariant(journey, `seed-${i}`)),
    );
    expect(picks.map((p) => p.key)).toEqual(again.map((p) => p.key));
    const a = picks.filter((p) => p.key === 'a').length;
    expect(a).toBeGreaterThan(60);
    expect(a).toBeLessThan(140);
  });

  it('respects weights and a promoted winner', async () => {
    const heavy = {
      ...journey,
      variants: [
        { ...journey.variants[0]!, weight: 1 },
        { ...journey.variants[1]!, weight: 100 },
      ],
    };
    const picks = await Promise.all(
      Array.from({ length: 100 }, (_, i) => pickJourneyVariant(heavy, `s${i}`)),
    );
    expect(picks.filter((p) => p.key === 'b').length).toBeGreaterThan(90);
    const won = await pickJourneyVariant({ ...journey, winnerKey: 'a' }, 'anything');
    expect(won.key).toBe('a');
  });
});
