import { env } from 'cloudflare:test';
import {
  configurationSetName,
  dedicatedPoolName,
  requestDedicatedIp,
  startBroadcast,
  sweepDedicatedIps,
} from '@swarm/engine';
import { DevDedicatedSending, devDedicatedCalls, type DedicatedSending } from '@swarm/mail';
import { describe, expect, it } from 'vitest';
import { config, context, drain, seedChannel, seedDispatch } from './harness';

async function send(channelId: string, dedicated?: DedicatedSending) {
  const run = context();
  if (dedicated) run.ctx.dedicated = dedicated;
  const dispatch = await seedDispatch(channelId);
  await startBroadcast(env.DB, run.queue, config, {
    dispatch,
    operatorId: null,
    allowHtmlBlocks: false,
  });
  await drain(run.ctx, run.queue);
  return run.mail.sent;
}

const setPlan = (workspaceId: string, plan: string) =>
  env.DB.prepare('UPDATE workspaces SET plan = ?1 WHERE id = ?2').bind(plan, workspaceId).run();

const channelColumns = (channelId: string) =>
  env.DB.prepare(
    'SELECT ses_configuration_set, dedicated_ip_pool, dedicated_ip_status, dedicated_ip_warmup_percent FROM channels WHERE id = ?1',
  )
    .bind(channelId)
    .first<{
      ses_configuration_set: string | null;
      dedicated_ip_pool: string | null;
      dedicated_ip_status: string;
      dedicated_ip_warmup_percent: number | null;
    }>();

describe('dedicated sending in the send path', () => {
  it('keeps free Channels on the shared configuration set', async () => {
    const { channelId } = await seedChannel({ members: 2 });
    const sent = await send(channelId, new DevDedicatedSending());
    expect(sent).toHaveLength(2);
    expect(sent.every((m) => m.configurationSet === undefined)).toBe(true);
    expect((await channelColumns(channelId))?.ses_configuration_set).toBeNull();
  });

  it('creates a paid Channel’s own configuration set on its first send and uses it', async () => {
    const { channelId, workspaceId } = await seedChannel({ members: 3 });
    await setPlan(workspaceId, 'pro');
    const before = devDedicatedCalls.length;
    const sent = await send(channelId, new DevDedicatedSending());
    const name = configurationSetName(channelId);
    expect(name).toMatch(/^swarm-ch-[0-9a-f]{32}$/);
    expect(sent.map((m) => m.configurationSet)).toEqual([name, name, name]);
    expect((await channelColumns(channelId))?.ses_configuration_set).toBe(name);
    // Created once, not once per batch or message.
    expect(
      devDedicatedCalls.slice(before).filter((c) => c.method === 'createConfigurationSet'),
    ).toEqual([{ method: 'createConfigurationSet', args: [name] }]);
  });

  it('falls back to the shared set when the provider fails, without blocking the send', async () => {
    const { channelId, workspaceId } = await seedChannel({ members: 2 });
    await setPlan(workspaceId, 'scale');
    const failing: DedicatedSending = {
      createConfigurationSet: async () => {
        throw new Error('throttled');
      },
      createDedicatedIpPool: async () => {},
      attachPool: async () => {},
      poolWarmup: async () => ({ state: 'done', percent: 100 }),
    };
    const sent = await send(channelId, failing);
    expect(sent).toHaveLength(2);
    expect(sent.every((m) => m.configurationSet === undefined)).toBe(true);
  });
});

describe('dedicated IP warm-up', () => {
  it('provisions requested pools and follows warm-up to active', async () => {
    const { channelId, workspaceId } = await seedChannel();
    await setPlan(workspaceId, 'pro');
    let warm = { state: 'in_progress' as 'in_progress' | 'done', percent: 30 };
    let failCreate = true;
    const provider: DedicatedSending = {
      createConfigurationSet: async () => {},
      createDedicatedIpPool: async () => {
        if (failCreate) throw new Error('LimitExceededException');
      },
      attachPool: async () => {},
      poolWarmup: async () => warm,
    };

    // The provider fails: the request stays "requested" and the sweep retries it.
    const first = await requestDedicatedIp(env.DB, provider, channelId);
    expect(first.error).toMatch(/LimitExceeded/);
    expect(first.row.dedicated_ip_status).toBe('requested');

    failCreate = false;
    await sweepDedicatedIps(env.DB, provider, Date.now());
    expect(await channelColumns(channelId)).toMatchObject({
      ses_configuration_set: configurationSetName(channelId),
      dedicated_ip_pool: dedicatedPoolName(channelId),
      dedicated_ip_status: 'warming',
      dedicated_ip_warmup_percent: 0,
    });

    // Checked at most hourly.
    const later = Date.now() + 2 * 60 * 60 * 1000;
    await sweepDedicatedIps(env.DB, provider, later);
    expect((await channelColumns(channelId))?.dedicated_ip_warmup_percent).toBe(30);
    warm = { state: 'done', percent: 100 };
    await sweepDedicatedIps(env.DB, provider, later + 1000);
    expect((await channelColumns(channelId))?.dedicated_ip_status).toBe('warming');
    await sweepDedicatedIps(env.DB, provider, later + 2 * 60 * 60 * 1000);
    expect(await channelColumns(channelId)).toMatchObject({
      dedicated_ip_status: 'active',
      dedicated_ip_warmup_percent: 100,
    });
  });
});
