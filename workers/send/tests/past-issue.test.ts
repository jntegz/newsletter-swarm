import { env } from 'cloudflare:test';
import { StartError, startBroadcast } from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { config, context, count, seedChannel, seedDispatch } from './harness';

describe('a past issue', () => {
  it('never starts a send, whichever path asks', async () => {
    const { channelId } = await seedChannel({ members: 2 });
    const run = context();
    const dispatch = await seedDispatch(channelId, {
      status: 'scheduled',
      publish_at: Date.now() - 1000,
    });
    const start = startBroadcast(env.DB, run.queue, config, {
      dispatch: { ...dispatch, imported_at: Date.now() },
      operatorId: null,
      allowHtmlBlocks: false,
    });
    await expect(start).rejects.toBeInstanceOf(StartError);
    await expect(start).rejects.toThrow(/past issue/);
    expect(
      await count('SELECT count(*) AS n FROM broadcasts WHERE dispatch_id = ?1', dispatch.id),
    ).toBe(0);
  });
});
