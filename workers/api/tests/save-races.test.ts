import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import type { Dispatch, DispatchRevision } from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { ORIGIN, call, createChannel, json, signIn, type Session } from './helpers';

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

let owner: Session;
let channelId: string;

beforeAll(async () => {
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
});

async function newDraft(text: string): Promise<Dispatch> {
  const res = await call('POST', `/api/v1/channels/${channelId}/dispatches`, {
    cookie: owner.cookie,
    body: { subject: 'Old subject', preheader: 'Old preview', content: doc(text) },
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await json<{ data: Dispatch }>(res)).data;
}

const read = async (id: string) =>
  (
    await json<{ data: Dispatch }>(
      await call('GET', `/api/v1/dispatches/${id}`, { cookie: owner.cookie }),
    )
  ).data;

/**
 * Sends a PATCH through a database that lets `meanwhile` run just before the request's own write,
 * after it has read the Dispatch. That is the moment an autosave lands beside a sidebar change.
 */
async function patchWithSaveInBetween(
  id: string,
  body: unknown,
  meanwhile: () => Promise<unknown>,
) {
  let ran = false;
  const beforeWrite = async <T>(write: () => Promise<T>) => {
    if (!ran) {
      ran = true;
      await meanwhile();
    }
    return write();
  };
  // The save's write runs in a batch (with the statements that may unschedule it first).
  const saves = new Set<D1PreparedStatement>();
  const racing = {
    batch: (statements: D1PreparedStatement[]) =>
      statements.some((statement) => saves.has(statement))
        ? beforeWrite(() => env.DB.batch(statements))
        : env.DB.batch(statements),
    prepare: (sql: string) => {
      const statement = env.DB.prepare(sql);
      if (!/^UPDATE dispatches SET subject = /.test(sql)) return statement;
      return {
        bind: (...values: unknown[]) => {
          const bound = statement.bind(...values);
          saves.add(bound);
          return bound;
        },
      };
    },
  } as unknown as D1Database;
  const ctx = createExecutionContext();
  const res = await createApp().fetch(
    new Request(`http://localhost/api/v1/dispatches/${id}`, {
      method: 'PATCH',
      headers: { origin: ORIGIN, cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { ...env, DB: racing },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(ran, 'the save in between ran').toBe(true);
  expect(res.status, await res.clone().text()).toBe(200);
  return res;
}

const autosave = (id: string) => () =>
  call('PATCH', `/api/v1/dispatches/${id}`, {
    cookie: owner.cookie,
    body: { subject: 'New subject', preheader: 'New preview', content: doc('Newer words') },
  }).then((res) => expect(res.status).toBe(200));

describe('a sidebar change beside an autosave', () => {
  it('a visibility change keeps the newer text, subject and preview text', async () => {
    const draft = await newDraft('Older words');
    await patchWithSaveInBetween(draft.id, { webVisibility: 'paid' }, autosave(draft.id));

    const after = await read(draft.id);
    expect(JSON.stringify(after.content)).toContain('Newer words');
    expect(after.subject).toBe('New subject');
    expect(after.preheader).toBe('New preview');
    expect(after.webVisibility).toBe('paid');
    // The preview rendered from the older text doesn't replace the newer one.
    expect(after.html).toContain('Newer words');
    expect(after.html).not.toContain('Older words');
  });

  it('an audience change keeps the newer text, and its revision records that text', async () => {
    const draft = await newDraft('Older words');
    await patchWithSaveInBetween(
      draft.id,
      { audience: { include: [], exclude: [] } },
      autosave(draft.id),
    );

    const after = await read(draft.id);
    expect(JSON.stringify(after.content)).toContain('Newer words');
    expect(after.subject).toBe('New subject');
    const revisions = (
      await json<{ data: DispatchRevision[] }>(
        await call('GET', `/api/v1/dispatches/${draft.id}/revisions`, { cookie: owner.cookie }),
      )
    ).data;
    expect(revisions[0]?.subject).toBe('New subject');
  });

  it('with nothing in between, a visibility change still refreshes the stored preview', async () => {
    const res = await call('POST', `/api/v1/channels/${channelId}/dispatches`, {
      cookie: owner.cookie,
      body: {
        subject: 'Gated',
        content: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Free part' }] },
            { type: 'gate' },
            { type: 'paragraph', content: [{ type: 'text', text: 'Paid part' }] },
          ],
        },
      },
    });
    const { data: draft } = await json<{ data: Dispatch }>(res);
    const before = await read(draft.id);
    const patched = await call('PATCH', `/api/v1/dispatches/${draft.id}`, {
      cookie: owner.cookie,
      body: { webVisibility: 'paid' },
    });
    expect(patched.status).toBe(200);
    const after = await read(draft.id);
    expect(after.html).not.toBe(before.html);
  });

  it('a save with its own text still writes it', async () => {
    const draft = await newDraft('Older words');
    const patched = await call('PATCH', `/api/v1/dispatches/${draft.id}`, {
      cookie: owner.cookie,
      body: { content: doc('Fresh words'), subject: 'Fresh subject' },
    });
    expect(patched.status).toBe(200);
    const after = await read(draft.id);
    expect(after.html).toContain('Fresh words');
    expect(after.subject).toBe('Fresh subject');
    expect(after.preheader).toBe('Old preview');
  });
});
