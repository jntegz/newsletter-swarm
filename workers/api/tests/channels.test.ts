import { SELF, env } from 'cloudflare:test';
import { newId, type Channel, type MediaAsset } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { call, createChannel, json, pngBytes, signIn, uploadForm } from './helpers';

describe('channels', () => {
  it('creates a Channel with a unique, unreserved address', async () => {
    const owner = await signIn();
    const slug = `notes-${crypto.randomUUID().slice(0, 8)}`;
    const created = await createChannel(owner, slug);
    expect(created.slug).toBe(slug);

    const dup = await call('POST', `/api/v1/workspaces/${owner.workspaceId}/channels`, {
      cookie: owner.cookie,
      body: { name: 'Again', slug },
    });
    expect(dup.status).toBe(409);

    for (const bad of ['api', 'a', 'Bad Slug', '-lead', 'double--dash']) {
      const res = await call('POST', `/api/v1/workspaces/${owner.workspaceId}/channels`, {
        cookie: owner.cookie,
        body: { name: 'X', slug: bad },
      });
      expect(res.status, bad).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'invalid_input' } });
    }
  });

  it('soft-deletes and restores a Channel', async () => {
    const owner = await signIn();
    const { id } = await createChannel(owner);
    expect((await call('DELETE', `/api/v1/channels/${id}`, { cookie: owner.cookie })).status).toBe(
      200,
    );
    expect((await call('GET', `/api/v1/channels/${id}`, { cookie: owner.cookie })).status).toBe(
      404,
    );

    const deleted = await json<{ data: Channel[] }>(
      await call('GET', `/api/v1/workspaces/${owner.workspaceId}/channels?deleted=true`, {
        cookie: owner.cookie,
      }),
    );
    expect(deleted.data.map((c) => c.id)).toContain(id);

    expect(
      (await call('POST', `/api/v1/channels/${id}/restore`, { cookie: owner.cookie })).status,
    ).toBe(200);
    expect((await call('GET', `/api/v1/channels/${id}`, { cookie: owner.cookie })).status).toBe(
      200,
    );
  });

  it('regression: a restore does not fire posts that came due while the Channel was deleted', async () => {
    const owner = await signIn();
    const { id } = await createChannel(owner);
    const now = Date.now();
    const overdue = newId('dispatch');
    const later = newId('dispatch');
    const insert = (dispatchId: string, publishAt: number) =>
      env.DB.prepare(
        `INSERT INTO dispatches (id, channel_id, subject, content_json, status, publish_at, created_at, updated_at)
         VALUES (?1, ?2, 'Issue', '{"type":"doc","content":[]}', 'scheduled', ?3, ?4, ?4)`,
      ).bind(dispatchId, id, publishAt, now);
    await env.DB.batch([insert(overdue, now + 60_000), insert(later, now + 86_400_000)]);
    expect((await call('DELETE', `/api/v1/channels/${id}`, { cookie: owner.cookie })).status).toBe(
      200,
    );
    // The first post came due while the Channel was deleted.
    await env.DB.prepare('UPDATE dispatches SET publish_at = ?1 WHERE id = ?2')
      .bind(now - 60_000, overdue)
      .run();
    expect(
      (await call('POST', `/api/v1/channels/${id}/restore`, { cookie: owner.cookie })).status,
    ).toBe(200);

    const status = (dispatchId: string) =>
      env.DB.prepare('SELECT status, publish_at FROM dispatches WHERE id = ?1')
        .bind(dispatchId)
        .first();
    expect(await status(overdue)).toEqual({ status: 'draft', publish_at: null });
    expect(await status(later)).toEqual({ status: 'scheduled', publish_at: now + 86_400_000 });
    expect(
      await env.DB.prepare(
        `SELECT action FROM audit_events WHERE target_type = 'dispatch' AND target_id = ?1`,
      )
        .bind(overdue)
        .first(),
    ).toEqual({ action: 'dispatch.unscheduled' });
  });

  it('regression: deleting a Channel cancels the sends it still has going', async () => {
    const owner = await signIn();
    const { id } = await createChannel(owner);
    const member = await call('POST', `/api/v1/channels/${id}/members`, {
      cookie: owner.cookie,
      body: { email: `m-${crypto.randomUUID().slice(0, 8)}@example.com`, consent: true },
    });
    expect(member.status).toBe(201);
    const dispatch = await json<{ data: { id: string } }>(
      await call('POST', `/api/v1/channels/${id}/dispatches`, {
        cookie: owner.cookie,
        body: {
          subject: 'Issue 1',
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
          },
        },
      }),
    );
    const sent = await call('POST', `/api/v1/dispatches/${dispatch.data.id}/send`, {
      cookie: owner.cookie,
    });
    expect(sent.status).toBe(202);
    const { broadcastId } = (await json<{ data: { broadcastId: string } }>(sent)).data;

    expect((await call('DELETE', `/api/v1/channels/${id}`, { cookie: owner.cookie })).status).toBe(
      200,
    );
    expect(
      await env.DB.prepare('SELECT status, failure_reason FROM broadcasts WHERE id = ?1')
        .bind(broadcastId)
        .first(),
    ).toEqual({
      status: 'canceled',
      failure_reason: 'The publication was deleted, so the rest of this send was canceled.',
    });
    expect(
      await env.DB.prepare('SELECT status FROM dispatches WHERE id = ?1')
        .bind(dispatch.data.id)
        .first(),
    ).toEqual({ status: 'canceled' });
    const audit = await env.DB.prepare(
      `SELECT metadata_json FROM audit_events WHERE action = 'channel.deleted' AND target_id = ?1`,
    )
      .bind(id)
      .first<{ metadata_json: string }>();
    expect(JSON.parse(audit!.metadata_json)).toMatchObject({ canceledBroadcasts: [broadcastId] });
  });

  it('cannot restore after 30 days', async () => {
    const owner = await signIn();
    const { id } = await createChannel(owner);
    await env.DB.prepare('UPDATE channels SET deleted_at = ?1 WHERE id = ?2')
      .bind(Date.now() - 31 * 24 * 60 * 60 * 1000, id)
      .run();
    expect(
      (await call('POST', `/api/v1/channels/${id}/restore`, { cookie: owner.cookie })).status,
    ).toBe(404);
  });

  it('only accepts a logo from the same workspace', async () => {
    const a = await signIn();
    const b = await signIn();
    const channelA = await createChannel(a);
    const channelB = await createChannel(b);
    const upload = await call('POST', `/api/v1/channels/${channelB.id}/media`, {
      cookie: b.cookie,
      form: uploadForm(pngBytes()),
    });
    const foreignLogo = (await json<{ data: MediaAsset }>(upload)).data.id;

    const res = await call('PATCH', `/api/v1/channels/${channelA.id}`, {
      cookie: a.cookie,
      body: { branding: { logoMediaId: foreignLogo } },
    });
    expect(res.status).toBe(400);
  });

  it('moves site pages to a new cache version when the name changes', async () => {
    const owner = await signIn();
    const { id } = await createChannel(owner);
    const version = async () =>
      (
        await env.DB.prepare('SELECT cache_version AS v FROM site_settings WHERE channel_id = ?1')
          .bind(id)
          .first<{ v: number }>()
      )?.v ?? 1;
    const before = await version();
    const rename = (body: Record<string, unknown>) =>
      call('PATCH', `/api/v1/channels/${id}`, { cookie: owner.cookie, body });
    expect((await rename({ name: 'New name' })).status).toBe(200);
    expect(await version()).toBe(before + 1);
    expect((await rename({ name: 'Newer name' })).status).toBe(200);
    expect(await version()).toBe(before + 2);
    expect((await rename({ doubleOptIn: true })).status).toBe(200);
    expect(await version()).toBe(before + 2);
  });

  it('validates branding colours', async () => {
    const owner = await signIn();
    const { id } = await createChannel(owner);
    const bad = await call('PATCH', `/api/v1/channels/${id}`, {
      cookie: owner.cookie,
      body: { branding: { accentColor: 'red' } },
    });
    expect(bad.status).toBe(400);
    const good = await call('PATCH', `/api/v1/channels/${id}`, {
      cookie: owner.cookie,
      body: { branding: { accentColor: '#1f7a4d' } },
    });
    expect((await json<{ data: Channel }>(good)).data.branding.accentColor).toBe('#1f7a4d');
  });
});

describe('media', () => {
  it('identifies uploads by their bytes and serves them from the media origin', async () => {
    const owner = await signIn();
    const { id } = await createChannel(owner);
    const res = await call('POST', `/api/v1/channels/${id}/media`, {
      cookie: owner.cookie,
      form: uploadForm(pngBytes(), 'logo.jpg', 'image/jpeg'),
    });
    expect(res.status).toBe(201);
    const { data } = await json<{ data: MediaAsset }>(res);
    expect(data.contentType).toBe('image/png');
    expect([data.width, data.height]).toEqual([2, 3]);
    expect(data.url).toMatch(
      /^http:\/\/localhost:8792\/media\/ws\/ws_[0-9a-f]{32}\/ch\/ch_[0-9a-f]{32}\/md_[0-9a-f]{32}\.png$/,
    );

    const stored = await env.MEDIA.head(data.url.split('/media/')[1]!);
    expect(stored?.customMetadata?.visibility).toBe('public');
  });

  it('refuses SVG and HTML whatever they claim to be', async () => {
    const owner = await signIn();
    const { id } = await createChannel(owner);
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
    for (const [bytes, name, type] of [
      [svg, 'logo.svg', 'image/svg+xml'],
      [html, 'logo.png', 'image/png'],
      [html, 'list.csv', 'text/csv'],
    ] as const) {
      const res = await call('POST', `/api/v1/channels/${id}/media`, {
        cookie: owner.cookie,
        form: uploadForm(bytes, name, type),
      });
      expect(res.status, name).toBe(415);
    }
  });

  it('refuses uploads over 10 MB', async () => {
    const owner = await signIn();
    const { id } = await createChannel(owner);
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(pngBytes());
    const res = await call('POST', `/api/v1/channels/${id}/media`, {
      cookie: owner.cookie,
      form: uploadForm(big),
    });
    expect(res.status).toBe(400);
  });

  it('edits alt text and the focal point, and searches alt text literally', async () => {
    const owner = await signIn();
    const { id } = await createChannel(owner);
    const upload = async (alt: string) =>
      (
        await json<{ data: MediaAsset }>(
          await call('POST', `/api/v1/channels/${id}/media`, {
            cookie: owner.cookie,
            form: (() => {
              const form = uploadForm(pngBytes());
              form.set('alt', alt);
              return form;
            })(),
          }),
        )
      ).data;
    const chart = await upload('Growth chart');
    await upload('100% of readers');
    await upload('Team photo');

    const edited = await call('PATCH', `/api/v1/media/${chart.id}`, {
      cookie: owner.cookie,
      body: { altText: 'Growth chart for May', focalPoint: { x: 0.2, y: 0.8 } },
    });
    expect(edited.status).toBe(200);
    expect((await json<{ data: MediaAsset }>(edited)).data).toMatchObject({
      altText: 'Growth chart for May',
      focalPoint: { x: 0.2, y: 0.8 },
    });

    const outOfRange = await call('PATCH', `/api/v1/media/${chart.id}`, {
      cookie: owner.cookie,
      body: { focalPoint: { x: 1.5, y: 0 } },
    });
    expect(outOfRange.status).toBe(400);

    const search = async (q: string) =>
      (
        await json<{ data: MediaAsset[] }>(
          await call('GET', `/api/v1/channels/${id}/media?q=${encodeURIComponent(q)}`, {
            cookie: owner.cookie,
          }),
        )
      ).data.map((m) => m.altText);
    expect(await search('chart')).toEqual(['Growth chart for May']);
    // % and _ are matched literally, not as wildcards.
    expect(await search('%')).toEqual(['100% of readers']);
    expect(await search('_')).toEqual([]);
  });
});

describe('audit log', () => {
  it('records actions in a verifiable chain that detects tampering', async () => {
    const owner = await signIn();
    await createChannel(owner);
    await call('PATCH', `/api/v1/workspaces/${owner.workspaceId}`, {
      cookie: owner.cookie,
      body: { name: 'Renamed' },
    });

    const log = await json<{ data: { items: { action: string; seq: number }[] } }>(
      await call('GET', `/api/v1/workspaces/${owner.workspaceId}/audit`, { cookie: owner.cookie }),
    );
    expect(log.data.items.map((i) => i.action)).toEqual(
      expect.arrayContaining([
        'workspace.created',
        'operator.signed_in',
        'channel.created',
        'workspace.renamed',
      ]),
    );

    const verify = () =>
      call('GET', `/api/v1/workspaces/${owner.workspaceId}/audit/verify`, { cookie: owner.cookie });
    expect(await (await verify()).json()).toMatchObject({ data: { ok: true, brokenAtSeq: null } });

    await env.DB.prepare(
      'UPDATE audit_events SET metadata_json = \'{"name":"Forged"}\' WHERE workspace_id = ?1 AND action = \'workspace.renamed\'',
    )
      .bind(owner.workspaceId)
      .run();
    expect(await (await verify()).json()).toMatchObject({ data: { ok: false } });
  });
});

describe('dev mailbox', () => {
  it('exists in test and development only', async () => {
    const res = await SELF.fetch('http://localhost/__dev/mail');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('is not served on a host a deployed Worker could have, even in development or test', async () => {
    for (const host of ['app.example.com', 'swarm-api-local.someone.workers.dev']) {
      expect((await SELF.fetch(`https://${host}/__dev/mail`)).status, host).toBe(404);
      expect((await SELF.fetch(`https://${host}/__dev/mail/latest.json?to=a@b.c`)).status).toBe(
        404,
      );
    }
  });
});
