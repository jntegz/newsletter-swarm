import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { BroadcastProgress } from '@swarm/domain';

const progress = (over: Partial<BroadcastProgress> = {}): BroadcastProgress => ({
  broadcastId: `br_${'1'.repeat(32)}`,
  status: 'sending',
  recipientCount: 100,
  sentCount: 50,
  failedCount: 0,
  completedAt: null,
  at: 1,
  ...over,
});

async function connect(name: string) {
  const stub = env.SEND_MONITOR.get(env.SEND_MONITOR.idFromName(name));
  const res = await stub.fetch('http://monitor/socket', { headers: { Upgrade: 'websocket' } });
  expect(res.status).toBe(101);
  const socket = res.webSocket!;
  const messages: BroadcastProgress[] = [];
  socket.addEventListener('message', (event) => {
    messages.push(JSON.parse(event.data as string) as BroadcastProgress);
  });
  socket.accept();
  return { stub, socket, messages };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('SendMonitor', () => {
  it('refuses plain requests', async () => {
    const stub = env.SEND_MONITOR.get(env.SEND_MONITOR.idFromName('plain'));
    expect((await stub.fetch('http://monitor/socket')).status).toBe(426);
  });

  it('pushes each update to connected sockets and replays the latest to new ones', async () => {
    const { stub, messages } = await connect('live');
    await stub.publish(progress({ sentCount: 50, at: 1 }));
    await stub.publish(progress({ sentCount: 100, status: 'sent', at: 2 }));
    await settle();
    expect(messages.map((m) => m.sentCount)).toEqual([50, 100]);

    const late = await connect('live');
    await settle();
    expect(late.messages).toEqual([expect.objectContaining({ sentCount: 100, status: 'sent' })]);
  });

  it('ignores updates that arrive out of order', async () => {
    const { stub, messages } = await connect('ordered');
    await stub.publish(progress({ sentCount: 80, at: 5 }));
    await stub.publish(progress({ sentCount: 30, at: 3 }));
    await settle();
    expect(messages.map((m) => m.sentCount)).toEqual([80]);
  });

  it('answers a dropped socket with a normal closure, because close() throws on those codes', async () => {
    const stub = env.SEND_MONITOR.get(env.SEND_MONITOR.idFromName('dropped-socket'));
    const closed: [number, string][] = [];
    const socket = {
      close: (code: number, reason: string) => closed.push([code, reason]),
    } as unknown as WebSocket;
    await runInDurableObject(stub, (monitor: { webSocketClose(s: WebSocket, c: number): void }) => {
      for (const code of [1005, 1006, 1015, 1001, 4000]) monitor.webSocketClose(socket, code);
    });
    expect(closed.map(([code]) => code)).toEqual([1000, 1000, 1000, 1001, 4000]);
  });
});

describe('SendMonitor: how long a socket holds its authority (S04-P1-V-socket-after-access-loss)', () => {
  const MAX_AGE_MS = 5 * 60_000;

  /** Makes every socket of the monitor look opened `ago` ms back, then runs its alarm. */
  async function age(name: string, ago: number) {
    const stub = env.SEND_MONITOR.get(env.SEND_MONITOR.idFromName(name));
    await runInDurableObject(stub, async (instance, state) => {
      for (const socket of state.getWebSockets()) {
        socket.serializeAttachment({ openedAt: Date.now() - ago });
      }
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
    });
  }

  it('closes a socket past its bound for a fresh check, even while the Broadcast is still sending', async () => {
    const { stub, socket, messages } = await connect('bounded');
    const closed: number[] = [];
    socket.addEventListener('close', (event) => closed.push(event.code));
    await stub.publish(progress({ sentCount: 10, at: 1 }));
    await settle();
    expect(messages.map((m) => m.sentCount)).toEqual([10]);

    await age('bounded', MAX_AGE_MS + 1);
    await settle();
    expect(closed).toEqual([4001]);
    await stub.publish(progress({ sentCount: 20, at: 2 }));
    await settle();
    expect(messages.map((m) => m.sentCount)).toEqual([10]);
  });

  it('keeps a socket inside its bound, and sets an alarm for a Broadcast that never finishes', async () => {
    const { stub, messages } = await connect('inside-bound');
    await age('inside-bound', MAX_AGE_MS - 60_000);
    await stub.publish(progress({ sentCount: 30, at: 3 }));
    await settle();
    expect(messages.map((m) => m.sentCount)).toEqual([30]);
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
  });
});
