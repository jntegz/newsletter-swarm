import { env } from 'cloudflare:test';
import type {
  CoverImage,
  Dispatch,
  DispatchRevision,
  DispatchRevisionDetail,
  Member,
  Preflight,
  Template,
} from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { data, enableFlag, errorCode } from './money-helpers';
import {
  call,
  createChannel,
  json,
  pngBytes,
  seatAs,
  signIn,
  uniqueEmail,
  uploadForm,
  type Session,
} from './helpers';
import { createKey, setPlan, v2, v2Data } from './v2-helpers';

const doc = (...paragraphs: string[]) => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});

let owner: Session;
let viewer: Session;
let outsider: Session;
let channelId: string;
let mediaId: string;
let otherMediaId: string;
let foreignMediaId: string;

async function upload(s: Session, channel: string): Promise<string> {
  const res = await call('POST', `/api/v1/channels/${channel}/media`, {
    cookie: s.cookie,
    form: uploadForm(pngBytes()),
  });
  return (await json<{ data: { id: string } }>(res)).data.id;
}

const create = async (body: Record<string, unknown> = {}, ch = channelId) =>
  data<Dispatch>(
    await call('POST', `/api/v1/channels/${ch}/dispatches`, {
      cookie: owner.cookie,
      body: { subject: 'Issue', content: doc('Hello'), ...body },
    }),
    201,
  );
const patch = (id: string, body: Record<string, unknown>, s: Session = owner) =>
  call('PATCH', `/api/v1/dispatches/${id}`, { cookie: s.cookie, body });
const read = async (id: string) =>
  data<Dispatch>(await call('GET', `/api/v1/dispatches/${id}`, { cookie: owner.cookie }));

const coverUrl = (dispatch: { coverImage: CoverImage | null }) => dispatch.coverImage?.url;

beforeAll(async () => {
  owner = await signIn();
  viewer = await seatAs(owner.workspaceId, 'viewer');
  channelId = (await createChannel(owner)).id;
  mediaId = await upload(owner, channelId);
  otherMediaId = await upload(owner, channelId);
  outsider = await signIn();
  foreignMediaId = await upload(outsider, (await createChannel(outsider)).id);
});

describe('saving a cover image', () => {
  it('round-trips through create, save and read, and renders into the email', async () => {
    const created = await create({ coverImage: { mediaId, alt: '  A fox at dawn ' } });
    // The test PNG is 2×3.
    expect(created.coverImage).toMatchObject({
      mediaId,
      alt: 'A fox at dawn',
      width: 2,
      height: 3,
    });
    expect(created.coverImage?.url).toContain(`${mediaId}.png`);
    expect(created.html).toContain(`src="${created.coverImage?.url}"`);
    expect(created.html).toContain('alt="A fox at dawn"');
    expect(created.warnings).toEqual([]);

    const changed = await data<Dispatch>(
      await patch(created.id, { coverImage: { mediaId: otherMediaId, alt: 'Another' } }),
    );
    expect(changed.coverImage).toMatchObject({ mediaId: otherMediaId, alt: 'Another' });
    expect(changed.html).toContain(`${otherMediaId}.png`);
    expect(changed.html).not.toContain(`${mediaId}.png`);
    expect((await read(created.id)).coverImage).toEqual(changed.coverImage);

    // Another field's save leaves it alone.
    const kept = await data<Dispatch>(await patch(created.id, { subject: 'Renamed' }));
    expect(kept.coverImage).toEqual(changed.coverImage);
    expect(kept.html).toContain(`${otherMediaId}.png`);

    const removed = await data<Dispatch>(await patch(created.id, { coverImage: null }));
    expect(removed.coverImage).toBeNull();
    expect(removed.html).not.toContain('<img');
  });

  it('is null on a post without one and warns about missing alt text', async () => {
    expect((await create()).coverImage).toBeNull();
    const bare = await create({ coverImage: { mediaId } });
    expect(bare.coverImage?.alt).toBe('');
    expect(bare.warnings).toContain('The cover image has no alt text.');
    const dressed = await call('PATCH', `/api/v1/media/${mediaId}`, {
      cookie: owner.cookie,
      body: { altText: 'From the library' },
    });
    expect(dressed.status).toBe(200);
    const fallback = await read(bare.id);
    expect(fallback.warnings).not.toContain('The cover image has no alt text.');
    await call('PATCH', `/api/v1/media/${mediaId}`, {
      cookie: owner.cookie,
      body: { altText: null },
    });
  });

  it('validates the input', async () => {
    const { id } = await create();
    for (const coverImage of [
      { mediaId: 'md_nope', alt: 'x' },
      { alt: 'no id' },
      { mediaId, alt: 'x'.repeat(301) },
      'a string',
    ]) {
      const res = await patch(id, { coverImage });
      expect(res.status, JSON.stringify(coverImage)).toBe(400);
    }
    expect(await errorCode(await patch(id, { coverImage: { mediaId: 'md_nope' } }))).toBe(
      'invalid_input',
    );
  });

  it('refuses another workspace’s media, and says nothing about it', async () => {
    const { id } = await create();
    const refused = await patch(id, { coverImage: { mediaId: foreignMediaId, alt: 'x' } });
    expect(refused.status).toBe(400);
    const missing = await patch(id, {
      coverImage: { mediaId: 'md_' + '0'.repeat(32), alt: 'x' },
    });
    const failure = async (res: Response) => {
      const { error } = await json<{ error: { requestId: string } }>(res);
      return { ...error, requestId: null };
    };
    expect(await failure(refused)).toEqual(await failure(missing));
    const onCreate = await call('POST', `/api/v1/channels/${channelId}/dispatches`, {
      cookie: owner.cookie,
      body: { coverImage: { mediaId: foreignMediaId, alt: 'x' } },
    });
    expect(onCreate.status).toBe(400);
    expect((await read(id)).coverImage).toBeNull();
  });

  it('accepts media from another publication of the workspace, not a PDF', async () => {
    const sibling = (await createChannel(owner)).id;
    const theirs = await upload(owner, sibling);
    const { id } = await create();
    expect((await patch(id, { coverImage: { mediaId: theirs, alt: 'x' } })).status).toBe(200);

    const pdf = 'md_' + crypto.randomUUID().replace(/-/g, '');
    await env.DB.prepare(
      `INSERT INTO media (id, workspace_id, channel_id, r2_key, content_type, bytes, created_at)
       VALUES (?1, ?2, ?3, ?4, 'application/pdf', 10, 0)`,
    )
      .bind(pdf, owner.workspaceId, channelId, `${pdf}.pdf`)
      .run();
    expect((await patch(id, { coverImage: { mediaId: pdf, alt: 'x' } })).status).toBe(400);
  });

  it('follows the roles and the send lock of the rest of the post', async () => {
    const { id } = await create();
    expect((await patch(id, { coverImage: { mediaId, alt: 'x' } }, viewer)).status).toBe(403);
    const { id: ch } = await createChannel(owner);
    await data<Member>(
      await call('POST', `/api/v1/channels/${ch}/members`, {
        cookie: owner.cookie,
        body: { email: uniqueEmail('member'), consent: true },
      }),
      201,
    );
    const sent = await create({ coverImage: { mediaId, alt: 'Frozen' } }, ch);
    const { broadcastId } = await data<{ broadcastId: string }>(
      await call('POST', `/api/v1/dispatches/${sent.id}/send`, { cookie: owner.cookie }),
      202,
    );
    expect((await patch(sent.id, { coverImage: null })).status).toBe(409);
    // The sent email keeps it.
    const frozen = await env.DB.prepare('SELECT html, text FROM broadcasts WHERE id = ?1')
      .bind(broadcastId)
      .first<{ html: string; text: string }>();
    expect(frozen?.html).toContain(`${mediaId}.png`);
    expect(frozen?.text).toContain('[Frozen]');
  });
});

describe('a cover image whose media item was deleted', () => {
  it('warns, never stops the send, and survives autosave until changed', async () => {
    const { id: ch } = await createChannel(owner);
    await data<Member>(
      await call('POST', `/api/v1/channels/${ch}/members`, {
        cookie: owner.cookie,
        body: { email: uniqueEmail('member'), consent: true },
      }),
      201,
    );
    const media = await upload(owner, ch);
    const dispatch = await create({ coverImage: { mediaId: media, alt: 'Soon gone' } }, ch);
    const deleted = await call('DELETE', `/api/v1/media/${media}`, { cookie: owner.cookie });
    expect(deleted.status).toBe(204);

    const stored = await read(dispatch.id);
    expect(stored.coverImage).toEqual({
      mediaId: media,
      alt: 'Soon gone',
      url: null,
      width: null,
      height: null,
    });
    const warning = 'The cover image is no longer in the media library and was left out.';
    expect(stored.warnings).toContain(warning);
    // The preview shows what the send would do, not the saved render with a broken image.
    expect(stored.html).not.toContain('<img');

    // Autosave sends the same reference: not a new one to refuse.
    const autosaved = await patch(dispatch.id, {
      subject: 'Still saving',
      coverImage: { mediaId: media, alt: 'Soon gone' },
    });
    expect(autosaved.status).toBe(200);
    // Choosing it again from elsewhere is a new reference.
    const fresh = await create({}, ch);
    expect((await patch(fresh.id, { coverImage: { mediaId: media, alt: 'x' } })).status).toBe(400);

    const check = await data<Preflight>(
      await call('GET', `/api/v1/dispatches/${dispatch.id}/preflight`, { cookie: owner.cookie }),
    );
    expect(check.warnings).toContain(warning);
    expect(check.checks.find((c) => c.key === 'content')?.ok).toBe(true);
    expect(check.ready).toBe(true);

    const sent = await call('POST', `/api/v1/dispatches/${dispatch.id}/send`, {
      cookie: owner.cookie,
    });
    expect(sent.status).toBe(202);
    const { broadcastId } = await data<{ broadcastId: string }>(sent, 202);
    const frozen = await env.DB.prepare('SELECT html, text FROM broadcasts WHERE id = ?1')
      .bind(broadcastId)
      .first<{ html: string; text: string }>();
    expect(frozen?.html).not.toContain('<img');
    expect(frozen?.text).not.toContain('Soon gone');
  });
});

describe('previews and tests', () => {
  it('sends the cover in a test and shows it in the full paid preview', async () => {
    const dispatch = await create({
      coverImage: { mediaId, alt: 'In the test' },
      content: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Free part' }] },
          { type: 'gate' },
          { type: 'paragraph', content: [{ type: 'text', text: 'Paid part' }] },
        ],
      },
    });
    const sent = await call('POST', `/api/v1/dispatches/${dispatch.id}/test`, {
      cookie: owner.cookie,
      body: {},
    });
    expect(sent.status).toBe(202);
    const mail = await data<{ html: string; text: string }>(
      await call('GET', `/__dev/mail/latest.json?to=${encodeURIComponent(owner.email)}`),
    );
    expect(mail.html).toContain(`${mediaId}.png`);
    expect(mail.html).toContain('alt="In the test"');
    expect(mail.text).toContain('[In the test]');

    // A paid post with a paywall break: free subscribers' stored email, and the full one.
    const saved = await data<Dispatch>(await patch(dispatch.id, { webVisibility: 'paid' }));
    expect(saved.html).toContain(`${mediaId}.png`);
    expect(saved.html).not.toContain('Paid part');
    await enableFlag('smart_blocks', owner.workspaceId, channelId);
    const full = await data<{ html: string }>(
      await call('GET', `/api/v1/dispatches/${dispatch.id}/preview`, { cookie: owner.cookie }),
    );
    expect(full.html).toContain(`${mediaId}.png`);
    expect(full.html).toContain('Paid part');
  });
});

describe('revisions', () => {
  it('keeps the cover in every version and restores it', async () => {
    const dispatch = await create({ coverImage: { mediaId, alt: 'First' } });
    const snapshot = await data<DispatchRevision>(
      await call('POST', `/api/v1/dispatches/${dispatch.id}/revisions`, {
        cookie: owner.cookie,
        body: { name: 'With the first cover' },
      }),
      201,
    );
    const detail = await data<DispatchRevisionDetail>(
      await call('GET', `/api/v1/dispatches/${dispatch.id}/revisions/${snapshot.id}`, {
        cookie: owner.cookie,
      }),
    );
    expect(detail.coverImage).toEqual({ mediaId, alt: 'First' });

    await data<Dispatch>(
      await patch(dispatch.id, { coverImage: { mediaId: otherMediaId, alt: 'Second' } }),
    );
    expect(coverUrl(await read(dispatch.id))).toContain(otherMediaId);

    const restored = await data<Dispatch>(
      await call('POST', `/api/v1/dispatches/${dispatch.id}/revisions/${snapshot.id}/restore`, {
        cookie: owner.cookie,
      }),
    );
    expect(restored.coverImage).toMatchObject({ mediaId, alt: 'First' });
    expect(restored.html).toContain(`${mediaId}.png`);
    expect(restored.html).not.toContain(`${otherMediaId}.png`);
  });

  it('restores a version without a cover to no cover', async () => {
    const dispatch = await create();
    const snapshot = await data<DispatchRevision>(
      await call('POST', `/api/v1/dispatches/${dispatch.id}/revisions`, {
        cookie: owner.cookie,
        body: { name: 'Before the cover' },
      }),
      201,
    );
    await data<Dispatch>(await patch(dispatch.id, { coverImage: { mediaId, alt: 'Later' } }));
    const restored = await data<Dispatch>(
      await call('POST', `/api/v1/dispatches/${dispatch.id}/revisions/${snapshot.id}/restore`, {
        cookie: owner.cookie,
      }),
    );
    expect(restored.coverImage).toBeNull();
    expect(restored.html).not.toContain('<img');
  });

  it('restores a version whose image has since been deleted, with the warning', async () => {
    const media = await upload(owner, channelId);
    const dispatch = await create({ coverImage: { mediaId: media, alt: 'Gone later' } });
    const snapshot = await data<DispatchRevision>(
      await call('POST', `/api/v1/dispatches/${dispatch.id}/revisions`, {
        cookie: owner.cookie,
        body: { name: 'Keeps it' },
      }),
      201,
    );
    await data<Dispatch>(await patch(dispatch.id, { coverImage: null }));
    await call('DELETE', `/api/v1/media/${media}`, { cookie: owner.cookie });
    const restored = await data<Dispatch>(
      await call('POST', `/api/v1/dispatches/${dispatch.id}/revisions/${snapshot.id}/restore`, {
        cookie: owner.cookie,
      }),
    );
    expect(restored.coverImage).toMatchObject({ mediaId: media, url: null });
    expect(restored.warnings).toContain(
      'The cover image is no longer in the media library and was left out.',
    );
  });
});

describe('copies and templates', () => {
  const templatesPath = () => `/api/v1/workspaces/${owner.workspaceId}/templates`;

  it('duplicates a post with its cover, the way the New post menu copies one', async () => {
    const source = await create({ coverImage: { mediaId, alt: 'Copied' } });
    const copy = await create({
      subject: source.subject,
      preheader: source.preheader,
      content: source.content,
      coverImage: { mediaId: source.coverImage!.mediaId, alt: source.coverImage!.alt },
    });
    expect(copy.id).not.toBe(source.id);
    expect(copy.coverImage).toEqual(source.coverImage);
  });

  it('saves a post as a template and starts a post from it, also in another publication', async () => {
    const source = await create({ coverImage: { mediaId, alt: 'In a template' } });
    const template = await data<Template>(
      await call('POST', `/api/v1/dispatches/${source.id}/save-as-template`, {
        cookie: owner.cookie,
        body: { name: 'With a cover', shared: true },
      }),
      201,
    );
    expect(template.coverImage).toEqual({ mediaId, alt: 'In a template' });
    expect(
      (
        await data<Template>(
          await call('GET', `/api/v1/templates/${template.id}`, { cookie: owner.cookie }),
        )
      ).coverImage,
    ).toEqual({ mediaId, alt: 'In a template' });

    const sibling = (await createChannel(owner)).id;
    const started = await data<Dispatch>(
      await call('POST', `/api/v1/templates/${template.id}/use`, {
        cookie: owner.cookie,
        body: { channelId: sibling },
      }),
      201,
    );
    expect(started.coverImage).toMatchObject({ mediaId, alt: 'In a template' });
    expect(started.html).toContain(`${mediaId}.png`);

    const exported = await call('GET', `/api/v1/templates/${template.id}/export`, {
      cookie: owner.cookie,
    });
    expect(await exported.text()).toContain(`${mediaId}.png`);
  });

  it('starts a post from a template whose image has been deleted', async () => {
    const media = await upload(owner, channelId);
    const template = await data<Template>(
      await call('POST', templatesPath(), {
        cookie: owner.cookie,
        body: {
          channelId,
          name: 'Its image goes',
          content: doc('Hello'),
          coverImage: { mediaId: media, alt: 'Gone' },
        },
      }),
      201,
    );
    await call('DELETE', `/api/v1/media/${media}`, { cookie: owner.cookie });
    const started = await data<Dispatch>(
      await call('POST', `/api/v1/templates/${template.id}/use`, {
        cookie: owner.cookie,
        body: { channelId },
      }),
      201,
    );
    expect(started.coverImage).toMatchObject({ mediaId: media, url: null });
    expect(started.warnings).toContain(
      'The cover image is no longer in the media library and was left out.',
    );
  });

  it('checks a template’s cover like a post’s', async () => {
    const refused = await call('POST', templatesPath(), {
      cookie: owner.cookie,
      body: {
        channelId,
        name: 'Foreign',
        content: doc('Hello'),
        coverImage: { mediaId: foreignMediaId, alt: 'x' },
      },
    });
    expect(refused.status).toBe(400);
    const template = await data<Template>(
      await call('POST', templatesPath(), {
        cookie: owner.cookie,
        body: { channelId, name: 'No cover', content: doc('Hello') },
      }),
      201,
    );
    expect(template.coverImage).toBeNull();
    const path = `/api/v1/templates/${template.id}`;
    const foreign = await call('PATCH', path, {
      cookie: owner.cookie,
      body: { coverImage: { mediaId: foreignMediaId, alt: 'x' } },
    });
    expect(foreign.status).toBe(400);
    const set = await data<Template>(
      await call('PATCH', path, {
        cookie: owner.cookie,
        body: { coverImage: { mediaId, alt: 'Set' } },
      }),
    );
    expect(set.coverImage).toEqual({ mediaId, alt: 'Set' });
    const renamed = await data<Template>(
      await call('PATCH', path, { cookie: owner.cookie, body: { name: 'Renamed' } }),
    );
    expect(renamed.coverImage).toEqual({ mediaId, alt: 'Set' });
    const cleared = await data<Template>(
      await call('PATCH', path, { cookie: owner.cookie, body: { coverImage: null } }),
    );
    expect(cleared.coverImage).toBeNull();
  });
});

describe('automation emails', () => {
  it('save a cover through the same route', async () => {
    const flow = await data<{ id: string }>(
      await call('POST', `/api/v1/channels/${channelId}/flows`, {
        cookie: owner.cookie,
        body: { name: 'Welcome', trigger: { event: 'confirmed' }, reentry: 'never' },
      }),
      201,
    );
    const email = await data<Dispatch>(
      await call('POST', `/api/v1/flows/${flow.id}/emails`, {
        cookie: owner.cookie,
        body: { subject: 'Welcome' },
      }),
      201,
    );
    expect(email.kind).toBe('flow');
    const saved = await data<Dispatch>(
      await patch(email.id, { coverImage: { mediaId, alt: 'Hello' } }),
    );
    expect(saved.html).toContain(`${mediaId}.png`);
  });
});

describe('/v2', () => {
  let token: string;
  beforeAll(async () => {
    await setPlan(owner.workspaceId, 'pro');
    token = (await createKey(owner, { scopes: ['dispatches:write'] })).secret;
  });
  const base = () => `/v2/channels/${channelId}/dispatches`;

  it('round-trips a cover image and refuses another workspace’s media', async () => {
    const created = await v2Data<Dispatch>(
      await v2('POST', base(), token, {
        body: { subject: 'Via API', coverImage: { mediaId, alt: 'From v2' } },
      }),
      201,
    );
    expect(created.coverImage).toMatchObject({ mediaId, alt: 'From v2' });
    const path = `${base()}/${created.id}`;
    const read2 = await v2Data<Dispatch>(await v2('GET', path, token));
    expect(read2.coverImage).toEqual(created.coverImage);
    expect(
      (
        await v2('POST', base(), token, {
          body: { coverImage: { mediaId: foreignMediaId, alt: 'x' } },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await v2('PATCH', path, token, {
          body: { coverImage: { mediaId: foreignMediaId, alt: 'x' } },
        })
      ).status,
    ).toBe(400);
    const preview = await v2Data<{ html: string }>(
      await v2('POST', `${path}/preview`, token, { body: {} }),
    );
    expect(preview.html).toContain(`${mediaId}.png`);
    const cleared = await v2Data<Dispatch>(
      await v2('PATCH', path, token, { body: { coverImage: null } }),
    );
    expect(cleared.coverImage).toBeNull();
  });
});
