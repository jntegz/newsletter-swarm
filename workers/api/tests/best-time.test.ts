// The API side of sending at each reader's best time: the flag's gate, the choice on a send and a
// schedule, and the refusal alongside a test. The pipeline is tested in the send worker.
import { env } from 'cloudflare:test';
import type { Broadcast, Dispatch, Preflight } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { call, createChannel, signIn, trackReaders } from './helpers';
import { addMember, data, enableFlag, errorCode } from './money-helpers';

const doc = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
};
const later = () => new Date(Date.now() + 3_600_000).toISOString();

async function setup(flags: ('best_time_send' | 'split_tests')[] = ['best_time_send']) {
  const owner = await signIn();
  const { id: channelId } = await createChannel(owner);
  await trackReaders(owner, channelId);
  for (const flag of flags) await enableFlag(flag, owner.workspaceId, channelId);
  await addMember(owner, channelId);
  const dispatch = await data<Dispatch>(
    await call('POST', `/api/v1/channels/${channelId}/dispatches`, {
      cookie: owner.cookie,
      body: { subject: 'Issue', content: doc },
    }),
    201,
  );
  const base = `/api/v1/dispatches/${dispatch.id}`;
  return { owner, channelId, dispatch, base };
}

const storedChoice = (dispatchId: string) =>
  env.DB.prepare('SELECT best_time FROM dispatches WHERE id = ?1')
    .bind(dispatchId)
    .first<number>('best_time');

describe('with the flag off', () => {
  it('refuses the choice on a send and a schedule, and hides it from the checks', async () => {
    const { owner, base, dispatch } = await setup([]);
    const send = await call('POST', `${base}/send`, {
      cookie: owner.cookie,
      body: { bestTime: true },
    });
    expect(send.status).toBe(404);
    expect(await errorCode(send)).toBe('feature_disabled');
    const schedule = await call('POST', `${base}/schedule`, {
      cookie: owner.cookie,
      body: { publishAt: later(), bestTime: true },
    });
    expect(schedule.status).toBe(404);
    expect(await errorCode(schedule)).toBe('feature_disabled');
    const check = await data<Preflight>(
      await call('GET', `${base}/preflight`, { cookie: owner.cookie }),
    );
    expect(check.bestTime).toBeNull();
    expect(await storedChoice(dispatch.id)).toBe(0);
  });

  it('still sends as it always did, with no body', async () => {
    const { owner, base } = await setup([]);
    const { broadcastId } = await data<{ broadcastId: string }>(
      await call('POST', `${base}/send`, { cookie: owner.cookie }),
      202,
    );
    const broadcast = await data<Broadcast>(
      await call('GET', `/api/v1/broadcasts/${broadcastId}`, { cookie: owner.cookie }),
    );
    expect(broadcast.bestTime).toBeNull();
  });
});

describe('with the flag on', () => {
  it('offers the choice, and is off unless asked for', async () => {
    const { owner, base } = await setup();
    const check = await data<Preflight>(
      await call('GET', `${base}/preflight`, { cookie: owner.cookie }),
    );
    expect(check.bestTime).toEqual({ available: true, reason: null, note: null });
    const { broadcastId } = await data<{ broadcastId: string }>(
      await call('POST', `${base}/send`, { cookie: owner.cookie }),
      202,
    );
    const broadcast = await data<Broadcast>(
      await call('GET', `/api/v1/broadcasts/${broadcastId}`, { cookie: owner.cookie }),
    );
    expect(broadcast.bestTime).toBeNull();
  });

  it('starts a send with the choice, and reports it', async () => {
    const { owner, base } = await setup();
    const { broadcastId } = await data<{ broadcastId: string }>(
      await call('POST', `${base}/send`, { cookie: owner.cookie, body: { bestTime: true } }),
      202,
    );
    const broadcast = await data<Broadcast>(
      await call('GET', `/api/v1/broadcasts/${broadcastId}`, { cookie: owner.cookie }),
    );
    expect(broadcast.bestTime).toEqual({ personal: 0, chosenTime: 0, limitedByWarmUp: false });
  });

  it('keeps the choice on a schedule when it moves, and clears it when unscheduled', async () => {
    const { owner, base, dispatch } = await setup();
    const scheduled = await data<Dispatch>(
      await call('POST', `${base}/schedule`, {
        cookie: owner.cookie,
        body: { publishAt: later(), bestTime: true },
      }),
    );
    expect(scheduled.bestTime).toBe(true);
    // Moving it, as the calendar does, says nothing about the choice.
    const moved = await data<Dispatch>(
      await call('POST', `${base}/schedule`, {
        cookie: owner.cookie,
        body: { publishAt: later() },
      }),
    );
    expect(moved.bestTime).toBe(true);
    const off = await data<Dispatch>(
      await call('POST', `${base}/schedule`, {
        cookie: owner.cookie,
        body: { publishAt: later(), bestTime: false },
      }),
    );
    expect(off.bestTime).toBe(false);
    await data(
      await call('POST', `${base}/schedule`, {
        cookie: owner.cookie,
        body: { publishAt: later(), bestTime: true },
      }),
    );
    const back = await data<Dispatch>(
      await call('DELETE', `${base}/schedule`, { cookie: owner.cookie }),
    );
    expect(back.bestTime).toBe(false);
    expect(await storedChoice(dispatch.id)).toBe(0);
  });

  it('refuses to run alongside a split test, on a send and on a schedule, and says why', async () => {
    const { owner, base } = await setup(['best_time_send', 'split_tests']);
    await data(
      await call('PUT', `${base}/split-test`, {
        cookie: owner.cookie,
        body: {
          variable: 'subject',
          variants: [{}, { subject: 'B' }],
          testPercent: 50,
          metric: 'opens',
          windowMinutes: 60,
        },
      }),
    );
    const check = await data<Preflight>(
      await call('GET', `${base}/preflight`, { cookie: owner.cookie }),
    );
    expect(check.ready).toBe(true);
    expect(check.bestTime?.available).toBe(false);
    expect(check.bestTime?.reason).toContain('compare readers sent at the same time');
    for (const res of [
      await call('POST', `${base}/send`, { cookie: owner.cookie, body: { bestTime: true } }),
      await call('POST', `${base}/schedule`, {
        cookie: owner.cookie,
        body: { publishAt: later(), bestTime: true },
      }),
    ]) {
      expect(res.status).toBe(409);
      expect(JSON.stringify(await res.json())).toContain('compare readers sent at the same time');
    }
    // Without the choice the test still runs.
    await data(await call('POST', `${base}/send`, { cookie: owner.cookie }), 202);
  });
});
