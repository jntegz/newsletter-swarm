import { beforeAll, describe, expect, it } from 'vitest';
import { call, createChannel, json, signIn, type Session } from './helpers';
import { enableFlag } from './money-helpers';

let owner: Session;
let channelId: string;
const body = {
  name: 'Sign-off',
  content: {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bye' }] }],
  },
};

beforeAll(async () => {
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
});

describe('snippets', () => {
  const base = () => `/api/v1/channels/${channelId}/snippets`;

  it('is off without its flag', async () => {
    expect((await call('GET', base(), { cookie: owner.cookie })).status).toBe(404);
    await enableFlag('snippets', owner.workspaceId, channelId);
  });

  it('saves, lists and deletes', async () => {
    const created = await call('POST', base(), { cookie: owner.cookie, body });
    expect(created.status).toBe(201);
    const { id } = (await json<{ data: { id: string } }>(created)).data;
    const list = await json<{ data: { name: string }[] }>(
      await call('GET', base(), { cookie: owner.cookie }),
    );
    expect(list.data.map((s) => s.name)).toEqual(['Sign-off']);
    expect((await call('DELETE', `${base()}/${id}`, { cookie: owner.cookie })).status).toBe(204);
    expect((await call('DELETE', `${base()}/${id}`, { cookie: owner.cookie })).status).toBe(404);
  });

  it('can’t delete another publication’s', async () => {
    const created = await call('POST', base(), { cookie: owner.cookie, body });
    const { id } = (await json<{ data: { id: string } }>(created)).data;
    const other = await createChannel(owner);
    await enableFlag('snippets', owner.workspaceId, other.id);
    const res = await call('DELETE', `/api/v1/channels/${other.id}/snippets/${id}`, {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(404);
  });
});
