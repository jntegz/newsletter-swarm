import { env } from 'cloudflare:test';
import { preflight, renderForWorkspace, resolveSnippets, type DispatchRow } from '@swarm/engine';
import type { Dispatch, Member, Preflight } from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createChannel, seatAs, signIn, uniqueEmail, type Session } from './helpers';
import { data, enableFlag, errorCode } from './money-helpers';

const para = (text: string, showOn?: unknown) => ({
  type: 'paragraph',
  ...(showOn === undefined ? {} : { attrs: { showOn } }),
  content: [{ type: 'text', text }],
});
const doc = (...content: unknown[]) => ({ type: 'doc', content });
const link = (snippetId: string, showOn?: unknown) => ({
  type: 'snippet',
  attrs: { snippetId, ...(showOn === undefined ? {} : { showOn }) },
});

interface Snippet {
  id: string;
  name: string;
  content: unknown;
}
interface SnippetDetail extends Snippet {
  usage: { posts: number; sentPosts: number; flowEmails: number; pages: number; templates: number };
}

let owner: Session;

beforeAll(async () => {
  owner = await signIn(uniqueEmail());
});

async function channel(...flags: Parameters<typeof enableFlag>[0][]): Promise<string> {
  const { id } = await createChannel(owner);
  await enableFlag('snippets', owner.workspaceId, id);
  for (const flag of flags) await enableFlag(flag, owner.workspaceId, id);
  return id;
}
const newSnippet = (channelId: string, content: unknown, name = 'Sign-off') =>
  call('POST', `/api/v1/channels/${channelId}/snippets`, {
    cookie: owner.cookie,
    body: { name, content },
  });
const snippet = async (channelId: string, content: unknown) =>
  data<Snippet>(await newSnippet(channelId, content), 201);
const change = (channelId: string, id: string, content: unknown, name = 'Sign-off') =>
  call('PUT', `/api/v1/channels/${channelId}/snippets/${id}`, {
    cookie: owner.cookie,
    body: { name, content },
  });
const newPost = (channelId: string, content: unknown) =>
  call('POST', `/api/v1/channels/${channelId}/dispatches`, {
    cookie: owner.cookie,
    body: { subject: 'Linked', content },
  });
const post = async (channelId: string, content: unknown) =>
  data<Dispatch>(await newPost(channelId, content), 201);
const getPost = async (id: string) =>
  data<Dispatch>(await call('GET', `/api/v1/dispatches/${id}`, { cookie: owner.cookie }));
const detail = async (channelId: string, id: string) =>
  data<SnippetDetail>(
    await call('GET', `/api/v1/channels/${channelId}/snippets/${id}`, { cookie: owner.cookie }),
  );
const check = async (id: string) =>
  data<Preflight>(
    await call('GET', `/api/v1/dispatches/${id}/preflight`, { cookie: owner.cookie }),
  );
async function addMember(channelId: string) {
  await data<Member>(
    await call('POST', `/api/v1/channels/${channelId}/members`, {
      cookie: owner.cookie,
      body: { email: uniqueEmail('member'), consent: true },
    }),
    201,
  );
}
const searchBody = async (dispatchId: string) =>
  (
    await env.DB.prepare('SELECT body FROM dispatch_search WHERE dispatch_id = ?1')
      .bind(dispatchId)
      .first<{ body: string }>()
  )?.body;
const cacheVersion = async (channelId: string) =>
  (
    await env.DB.prepare('SELECT cache_version FROM site_settings WHERE channel_id = ?1')
      .bind(channelId)
      .first<{ cache_version: number }>()
  )?.cache_version ?? 0;

describe('linked snippets in a post', () => {
  it('renders the snippet’s current content, and a post without one is unaffected', async () => {
    const id = await channel();
    const saved = await snippet(id, doc(para('Yours, Jan')));
    const linked = await post(id, doc(para('Hello'), link(saved.id)));
    expect(linked.html).toContain('Yours, Jan');
    expect(linked.warnings).not.toContain(expect.stringContaining('snippet'));

    const res = await change(id, saved.id, doc(para('Warmly, Jan')));
    expect(res.status).toBe(200);
    // A draft shows what a send would do now.
    const again = await getPost(linked.id);
    expect(again.html).toContain('Warmly, Jan');
    expect(again.html).not.toContain('Yours, Jan');
    expect(again.content).toEqual(doc(para('Hello'), link(saved.id)));
  });

  it('never reads a snippet of another publication', async () => {
    const mine = await channel();
    const other = await channel();
    const foreign = await snippet(other, doc(para('Their secret')));
    const linked = await post(mine, doc(para('Hello'), link(foreign.id)));
    expect(linked.html).not.toContain('Their secret');
    expect(linked.warnings.join(' ')).toContain('snippet');

    const read = await call('GET', `/api/v1/channels/${mine}/snippets/${foreign.id}`, {
      cookie: owner.cookie,
    });
    expect(read.status).toBe(404);
    expect((await change(mine, foreign.id, doc(para('Taken')))).status).toBe(404);
    const removed = await call('DELETE', `/api/v1/channels/${mine}/snippets/${foreign.id}`, {
      cookie: owner.cookie,
    });
    expect(removed.status).toBe(404);
    expect((await detail(other, foreign.id)).content).toEqual(doc(para('Their secret')));
  });

  it('refuses a snippet block inside another block', async () => {
    const id = await channel();
    const saved = await snippet(id, doc(para('Saved')));
    const res = await newPost(id, doc({ type: 'blockquote', content: [link(saved.id)] }));
    expect(await errorCode(res)).toBe('invalid_input');
  });

  it('refuses a linked block while the flag is off, but can still show it to detach', async () => {
    const id = await channel();
    const saved = await snippet(id, doc(para('Saved')));
    const linked = await post(id, doc(para('Hello'), link(saved.id)));
    await env.DB.prepare(`DELETE FROM feature_flags WHERE key = 'snippets' AND scope_id = ?1`)
      .bind(id)
      .run();
    await env.CACHE.delete(`flags:v1:${owner.workspaceId}:${id}`);

    expect(await errorCode(await newPost(id, doc(link(saved.id))))).toBe('feature_disabled');
    expect(await errorCode(await change(id, saved.id, doc(para('New'))))).toBe('feature_disabled');
    // The post keeps its content, and the snippet can be read to make a copy of it.
    expect((await getPost(linked.id)).html).toContain('Saved');
    expect((await detail(id, saved.id)).name).toBe('Sign-off');
  });
});

describe('what a snippet may hold', () => {
  it('refuses nesting, a paywall break and a Smart Block, on save and on change', async () => {
    const id = await channel();
    const saved = await snippet(id, doc(para('Saved')));
    for (const content of [
      doc(link(saved.id)),
      doc({ type: 'blockquote', content: [link(saved.id)] }),
      doc({ type: 'gate' }),
      doc({ type: 'smartBlock', attrs: { condition: {} }, content: [para('x')] }),
    ]) {
      expect(await errorCode(await newSnippet(id, content))).toBe('invalid_input');
      expect(await errorCode(await change(id, saved.id, content))).toBe('invalid_input');
    }
  });

  it('applies the document rules: unknown blocks and bad settings are refused', async () => {
    const id = await channel();
    expect(await errorCode(await newSnippet(id, doc({ type: 'script' })))).toBe('invalid_input');
    const saved = await snippet(id, doc(para('Saved')));
    expect(await errorCode(await change(id, saved.id, doc({ type: 'script' })))).toBe(
      'invalid_input',
    );
    expect((await detail(id, saved.id)).content).toEqual(doc(para('Saved')));
  });

  it('keeps to raw_html_mode', async () => {
    const raw = doc({ type: 'htmlBlock', attrs: { html: '<b>Raw</b>' } });
    const off = await channel();
    expect(await errorCode(await newSnippet(off, raw))).toBe('invalid_input');
    const saved = await snippet(off, doc(para('Saved')));
    expect(await errorCode(await change(off, saved.id, raw))).toBe('invalid_input');

    const on = await channel('raw_html_mode');
    const allowed = await snippet(on, raw);
    const linked = await post(on, doc(para('Hello'), link(allowed.id)));
    expect(linked.html).toContain('<b>Raw</b>');
    // Off again: a post using it can't be sent, as with raw HTML in the post itself.
    await env.DB.prepare(`DELETE FROM feature_flags WHERE key = 'raw_html_mode' AND scope_id = ?1`)
      .bind(on)
      .run();
    await env.CACHE.delete(`flags:v1:${owner.workspaceId}:${on}`);
    const result = await check(linked.id);
    expect(result.checks.find((c) => c.key === 'content')?.ok).toBe(false);
  });

  it('refuses showOn while block_visibility is off, also through a link', async () => {
    const id = await channel('block_visibility');
    const saved = await snippet(id, doc(para('Both'), para('Inbox', 'email')));
    await env.DB.prepare(
      `DELETE FROM feature_flags WHERE key = 'block_visibility' AND scope_id = ?1`,
    )
      .bind(id)
      .run();
    await env.CACHE.delete(`flags:v1:${owner.workspaceId}:${id}`);

    expect(await errorCode(await newSnippet(id, doc(para('Inbox', 'email'))))).toBe(
      'feature_disabled',
    );
    expect(await errorCode(await change(id, saved.id, doc(para('Web', 'web'))))).toBe(
      'feature_disabled',
    );
    // The snippet block's own setting, and one held by the snippet the post links to.
    const plain = await snippet(id, doc(para('Plain')));
    expect(await errorCode(await newPost(id, doc(link(plain.id, 'email'))))).toBe(
      'feature_disabled',
    );
    expect(await errorCode(await newPost(id, doc(link(saved.id))))).toBe('feature_disabled');
    expect((await newPost(id, doc(link(plain.id)))).status).toBe(201);
  });
});

describe('usage', () => {
  it('counts the posts that link to a snippet, and copies don’t count', async () => {
    const id = await channel();
    const saved = await snippet(id, doc(para('Saved')));
    const other = await snippet(id, doc(para('Other')));
    await post(id, doc(link(saved.id)));
    await post(id, doc(para('One'), link(saved.id), link(other.id)));
    await post(id, doc(para('Saved')));
    const { usage } = await detail(id, saved.id);
    expect(usage).toEqual({ posts: 2, sentPosts: 0, flowEmails: 0, pages: 0, templates: 0 });
    expect((await detail(id, other.id)).usage.posts).toBe(1);
  });

  it('lets an editor change a snippet, and not an author', async () => {
    const id = await channel();
    const saved = await snippet(id, doc(para('Saved')));
    const author = await seatAs(owner.workspaceId, 'author');
    const res = await call('PUT', `/api/v1/channels/${id}/snippets/${saved.id}`, {
      cookie: author.cookie,
      body: { name: 'Mine', content: doc(para('Changed')) },
    });
    expect(res.status).toBe(403);
    const removed = await call('DELETE', `/api/v1/channels/${id}/snippets/${saved.id}`, {
      cookie: author.cookie,
    });
    expect(removed.status).toBe(403);
  });
});

describe('sent emails and the website', () => {
  it('freezes the email at the start of a send; the website copy follows', async () => {
    const id = await channel();
    await addMember(id);
    const saved = await snippet(id, doc(para('First version')));
    const linked = await post(id, doc(para('Hello'), link(saved.id)));
    const sent = await call('POST', `/api/v1/dispatches/${linked.id}/send`, {
      cookie: owner.cookie,
    });
    expect(sent.status).toBe(202);
    const frozen = await env.DB.prepare('SELECT html, text FROM broadcasts WHERE dispatch_id = ?1')
      .bind(linked.id)
      .first<{ html: string; text: string }>();
    expect(frozen?.html).toContain('First version');
    expect(await searchBody(linked.id)).toContain('First version');
    expect((await detail(id, saved.id)).usage.sentPosts).toBe(1);

    const before = await cacheVersion(id);
    expect((await change(id, saved.id, doc(para('Second version')))).status).toBe(200);

    const after = await env.DB.prepare('SELECT html, text FROM broadcasts WHERE dispatch_id = ?1')
      .bind(linked.id)
      .first<{ html: string; text: string }>();
    expect(after).toEqual(frozen);
    expect((await getPost(linked.id)).html).toContain('First version');
    // The website copy: its cache refreshes and search holds the new text.
    expect(await cacheVersion(id)).toBeGreaterThan(before);
    const body = await searchBody(linked.id);
    expect(body).toContain('Second version');
    expect(body).not.toContain('First version');
  });

  it('uses one version for every part of a send, read once', async () => {
    const id = await channel();
    const saved = await snippet(id, doc(para('Old')));
    const row = await env.DB.prepare('SELECT * FROM channels WHERE id = ?1')
      .bind(id)
      .first<{ workspace_id: string; name: string }>();
    const snippets = new Map<string, unknown>();
    const input = {
      db: env.DB,
      workspaceId: row!.workspace_id,
      channelId: id,
      channelName: row!.name,
      accentColor: null,
      preheader: '',
      content: doc(para('Hello'), link(saved.id)),
      mediaOrigin: 'http://localhost:8792',
      allowHtmlBlocks: false,
      snippets,
    };
    expect((await renderForWorkspace(input)).html).toContain('Old');
    await change(id, saved.id, doc(para('New')));
    // A later render of the same send, such as a Split Test variant, sees the same version.
    const variant = await renderForWorkspace({ ...input, preheader: 'Other' });
    expect(variant.html).toContain('Old');
    // '>New<': the snippet's paragraph, not the 'Courier New' in the email's Outlook stylesheet.
    expect(variant.html).not.toContain('>New<');
    // Another render reads the current one.
    const { snippets: _used, ...fresh } = input;
    expect((await renderForWorkspace(fresh)).html).toContain('>New<');
  });

  it('keeps gated text out of search when the snippet sits behind the paywall', async () => {
    const id = await channel();
    await addMember(id);
    const open = await snippet(id, doc(para('Open words')));
    const closed = await snippet(id, doc(para('Closed words')));
    const linked = await post(id, doc(link(open.id), { type: 'gate' }, link(closed.id)));
    await call('PATCH', `/api/v1/dispatches/${linked.id}`, {
      cookie: owner.cookie,
      body: { webVisibility: 'members' },
    });
    const published = await call('POST', `/api/v1/dispatches/${linked.id}/publish-web`, {
      cookie: owner.cookie,
    });
    expect(published.status).toBeLessThan(300);
    await change(id, closed.id, doc(para('Closed words again')));
    await change(id, open.id, doc(para('Open words again')));
    const body = await searchBody(linked.id);
    expect(body).toContain('Open words again');
    expect(body).not.toContain('Closed');
  });

  it('holds a website-only block in search, and not an email-only one', async () => {
    const id = await channel('block_visibility');
    const saved = await snippet(id, doc(para('Inbox words', 'email'), para('Site words', 'web')));
    const linked = await post(id, doc(para('Hello'), link(saved.id)));
    await call('POST', `/api/v1/dispatches/${linked.id}/publish-web`, { cookie: owner.cookie });
    const body = await searchBody(linked.id);
    expect(body).toContain('Site words');
    expect(body).not.toContain('Inbox words');
    const email = await getPost(linked.id);
    expect(email.html).toContain('Inbox words');
    expect(email.html).not.toContain('Site words');
  });
});

describe('a deleted snippet', () => {
  it('leaves the post working: nothing renders, and the checks warn', async () => {
    const id = await channel();
    await addMember(id);
    const saved = await snippet(id, doc(para('Going soon')));
    const linked = await post(id, doc(para('Hello'), link(saved.id)));
    await call('POST', `/api/v1/dispatches/${linked.id}/publish-web`, { cookie: owner.cookie });
    expect(await searchBody(linked.id)).toContain('Going soon');
    const before = await cacheVersion(id);

    const removed = await call('DELETE', `/api/v1/channels/${id}/snippets/${saved.id}`, {
      cookie: owner.cookie,
    });
    expect(removed.status).toBe(204);
    expect(await cacheVersion(id)).toBeGreaterThan(before);
    expect(await searchBody(linked.id)).not.toContain('Going soon');

    const after = await getPost(linked.id);
    expect(after.html).not.toContain('Going soon');
    expect(after.warnings.join(' ')).toContain('snippet');
    const result = await check(linked.id);
    expect(result.warnings.join(' ')).toContain('snippet');
    expect(result.checks.find((c) => c.key === 'content')?.ok).toBe(true);
    // The block stays in the document, and the post can still be saved.
    expect(after.content).toEqual(doc(para('Hello'), link(saved.id)));
    const saves = await call('PATCH', `/api/v1/dispatches/${linked.id}`, {
      cookie: owner.cookie,
      body: { subject: 'Still fine' },
    });
    expect(saves.status).toBe(200);
  });

  it('counts as empty when it is all the post has', async () => {
    const id = await channel();
    const saved = await snippet(id, doc(para('Everything')));
    const linked = await post(id, doc(link(saved.id)));
    await call('DELETE', `/api/v1/channels/${id}/snippets/${saved.id}`, { cookie: owner.cookie });
    const result = await check(linked.id);
    expect(result.checks.find((c) => c.key === 'content')?.ok).toBe(false);
  });
});

describe('resolving for the engine', () => {
  it('does nothing to a document with no snippet blocks', async () => {
    const plain = doc(para('Hello'));
    expect(await resolveSnippets(env.DB, 'ch_none', plain)).toBe(plain);
  });

  it('runs through the whole pre-send check for a Flow email’s preflight row', async () => {
    const id = await channel();
    const saved = await snippet(id, doc(para('Flow words')));
    const linked = await post(id, doc(link(saved.id)));
    const row = (await env.DB.prepare('SELECT * FROM dispatches WHERE id = ?1')
      .bind(linked.id)
      .first()) as unknown as DispatchRow;
    const result = await preflight(
      env.DB,
      { mediaOrigin: 'http://localhost:8792', platformMailDomain: 'mail.test' } as never,
      row,
      { allowHtmlBlocks: false, webUrl: null },
    );
    expect(result.template?.html).toContain('Flow words');
    expect(result.renderInput?.snippets?.size).toBe(1);
  });
});
