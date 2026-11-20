import { accountId, oauthApi, save, type Ctx } from '../context';
import type { EnvName, Worker } from '../paths';
import type { Step } from './step';

export const resourceNames = (env: EnvName) => ({
  d1: `swarm-${env}`,
  kv: `swarm-${env}-cache`,
  r2: ['media', 'imports', 'exports', 'reports'].map((b) => `swarm-${env}-${b}`),
  // The public queue is the only one capture and events can write to (docs/security.md). An
  // install from before it gains it, and nothing else, on its next update.
  queues: [
    'send',
    'send-dlq',
    'jobs',
    'jobs-dlq',
    'webhooks',
    'webhooks-dlq',
    'public',
    'public-dlq',
  ].map((q) => `swarm-${env}-${q}`),
});

/** The internet-facing Workers that produce on a queue: the public queue, and no other. */
export const PUBLIC_QUEUE_PRODUCERS: readonly Worker[] = ['capture', 'events'];

const found = (created: boolean) => (created ? 'done' : 'already there');

/** D1, KV, R2 and Queues: list first, create only what is missing, save after each. */
export async function provisionResources(ctx: Ctx): Promise<void> {
  const cf = oauthApi(ctx);
  const account = `/accounts/${accountId(ctx)}`;
  const names = resourceNames(ctx.env);
  const r = ctx.state.resources;

  let created = false;
  const d1 = await ctx.ui.task(
    `Creating database ${names.d1}`,
    async () => {
      const list = await cf.get<{ uuid: string; name: string }[]>(`${account}/d1/database`, {
        name: names.d1,
      });
      const existing = list.find((db) => db.name === names.d1);
      created = !existing;
      return (
        existing ??
        (await cf.post<{ uuid: string; name: string }>(`${account}/d1/database`, {
          name: names.d1,
        }))
      );
    },
    () => found(created),
  );
  r.d1 = { id: d1.uuid, name: names.d1 };
  await save(ctx);

  const kv = await ctx.ui.task(
    `Creating KV namespace ${names.kv}`,
    async () => {
      const list = await cf.list<{ id: string; title: string }>(`${account}/storage/kv/namespaces`);
      const existing = list.find((ns) => ns.title === names.kv);
      created = !existing;
      return (
        existing ??
        (await cf.post<{ id: string; title: string }>(`${account}/storage/kv/namespaces`, {
          title: names.kv,
        }))
      );
    },
    () => found(created),
  );
  r.kv = { id: kv.id, title: names.kv };
  await save(ctx);

  const buckets = new Set(
    ((await cf.get<{ buckets?: { name: string }[] }>(`${account}/r2/buckets`)).buckets ?? []).map(
      (b) => b.name,
    ),
  );
  for (const bucket of names.r2) {
    await ctx.ui.task(
      `Creating storage bucket ${bucket}`,
      async () => {
        created = !buckets.has(bucket);
        if (created) await cf.post(`${account}/r2/buckets`, { name: bucket });
      },
      () => found(created),
    );
    if (!r.r2.includes(bucket)) r.r2.push(bucket);
    await save(ctx);
  }

  const queues = new Set(
    (await cf.list<{ queue_name: string }>(`${account}/queues`)).map((q) => q.queue_name),
  );
  for (const queue of names.queues) {
    await ctx.ui.task(
      `Creating queue ${queue}`,
      async () => {
        created = !queues.has(queue);
        if (created) await cf.post(`${account}/queues`, { queue_name: queue });
      },
      () => found(created),
    );
    if (!r.queues.includes(queue)) r.queues.push(queue);
    await save(ctx);
  }
}

export const resources: Step = {
  id: 'resources',
  title: 'Cloudflare resources',
  run: provisionResources,
};
