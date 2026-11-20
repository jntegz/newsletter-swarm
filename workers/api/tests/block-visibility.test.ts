import { env } from 'cloudflare:test';
import type { Dispatch } from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createChannel, signIn, uniqueEmail, type Session } from './helpers';
import { data, enableFlag, errorCode } from './money-helpers';

const para = (text: string, showOn?: unknown) => ({
  type: 'paragraph',
  ...(showOn === undefined ? {} : { attrs: { showOn } }),
  content: [{ type: 'text', text }],
});
const doc = (...content: unknown[]) => ({ type: 'doc', content });

let owner: Session;

async function channel(): Promise<string> {
  return (await createChannel(owner)).id;
}
const create = (channelId: string, content: unknown) =>
  call('POST', `/api/v1/channels/${channelId}/dispatches`, {
    cookie: owner.cookie,
    body: { subject: 'Kept blocks', content },
  });

beforeAll(async () => {
  owner = await signIn(uniqueEmail());
});

describe('email or website blocks', () => {
  it('refuses a block kept to one surface while the flag is off', async () => {
    const id = await channel();
    const res = await create(id, doc(para('Inbox', 'email')));
    expect(await errorCode(res)).toBe('feature_disabled');

    // A plain document and an explicit default are fine, on create and on save.
    const plain = await data<Dispatch>(await create(id, doc(para('Both', null))), 201);
    const save = await call('PATCH', `/api/v1/dispatches/${plain.id}`, {
      cookie: owner.cookie,
      body: { content: doc(para('Web', 'web')) },
    });
    expect(await errorCode(save)).toBe('feature_disabled');
  });

  it('refuses saving one as a reusable block while the flag is off', async () => {
    const id = await channel();
    await enableFlag('snippets', owner.workspaceId, id);
    const res = await call('POST', `/api/v1/channels/${id}/snippets`, {
      cookie: owner.cookie,
      body: { name: 'Kept', content: doc(para('Inbox', 'email')) },
    });
    expect(await errorCode(res)).toBe('feature_disabled');
  });

  it('with the flag on, stores the setting and leaves the block out of the email', async () => {
    const id = await channel();
    await enableFlag('block_visibility', owner.workspaceId, id);
    const saved = await data<Dispatch>(
      await create(id, doc(para('Both'), para('Site only', 'web'), para('Inbox only', 'email'))),
      201,
    );
    expect(saved.html).toContain('Inbox only');
    expect(saved.html).not.toContain('Site only');
    expect(JSON.stringify(saved.content)).toContain('"showOn":"web"');
  });

  it('refuses an unknown value even with the flag on', async () => {
    const id = await channel();
    await enableFlag('block_visibility', owner.workspaceId, id);
    const res = await create(id, doc(para('Odd', 'sometimes')));
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('invalid_input');
  });

  it('keeps rendering a stored setting if the flag goes off, and refuses only a new save', async () => {
    const id = await channel();
    await enableFlag('block_visibility', owner.workspaceId, id);
    const saved = await data<Dispatch>(await create(id, doc(para('Site only', 'web'))), 201);
    expect(saved.html).not.toContain('Site only');

    await env.DB.prepare(
      `DELETE FROM feature_flags WHERE key = 'block_visibility' AND scope_id = ?1`,
    )
      .bind(id)
      .run();
    await env.CACHE.delete(`flags:v1:${owner.workspaceId}:${id}`);

    // Renaming the post renders it again: the stored setting still keeps the block out.
    const renamed = await data<Dispatch>(
      await call('PATCH', `/api/v1/dispatches/${saved.id}`, {
        cookie: owner.cookie,
        body: { subject: 'Renamed' },
      }),
    );
    expect(renamed.html).not.toContain('Site only');
    // Taking the setting away is always allowed.
    const cleared = await data<Dispatch>(
      await call('PATCH', `/api/v1/dispatches/${saved.id}`, {
        cookie: owner.cookie,
        body: { content: doc(para('Site only', null)) },
      }),
    );
    expect(cleared.html).toContain('Site only');
  });
});
