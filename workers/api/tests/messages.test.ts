import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createChannel, json, signIn, type Session } from './helpers';
import { enableFlag } from './money-helpers';

let owner: Session;
let channelId: string;
const base = () => `/api/v1/channels/${channelId}/messages`;
const WORDING = {
  subject: 'Please confirm {{channel_name}}',
  mode: 'text',
  heading: 'One click',
  body: 'Hello.\n\nConfirm below.',
  buttonLabel: 'Confirm',
};

beforeAll(async () => {
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
  await enableFlag('message_templates', owner.workspaceId, channelId);
});

describe('system emails', () => {
  it('is hidden with the flag off', async () => {
    const other = await createChannel(owner);
    const res = await call('GET', `/api/v1/channels/${other.id}/messages`, {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(404);
  });

  it('lists every email with its built-in wording, then saves, previews and resets', async () => {
    const list = await json<{ data: { key: string; customized: boolean; subject: string }[] }>(
      await call('GET', base(), { cookie: owner.cookie }),
    );
    const confirm = list.data.find((m) => m.key === 'confirm')!;
    expect(confirm).toMatchObject({ customized: false });
    expect(confirm.subject).toContain('Confirm your email');

    const saved = await call('PUT', `${base()}/confirm`, { cookie: owner.cookie, body: WORDING });
    expect(saved.status).toBe(200);
    expect((await json<{ data: { customized: boolean } }>(saved)).data.customized).toBe(true);

    const preview = await json<{ data: { subject: string; html: string } }>(
      await call('POST', `${base()}/confirm/preview`, { cookie: owner.cookie, body: WORDING }),
    );
    expect(preview.data.html).toContain('One click');
    expect(preview.data.html).toContain('https://example.com/confirm');

    const reset = await call('DELETE', `${base()}/confirm`, { cookie: owner.cookie });
    expect(reset.status).toBe(204);
    const row = await env.DB.prepare('SELECT 1 FROM channel_messages WHERE channel_id = ?1')
      .bind(channelId)
      .first();
    expect(row).toBeNull();
  });

  it('refuses wording that breaks the email, and unknown emails', async () => {
    const put = (key: string, body: Record<string, string>) =>
      call('PUT', `${base()}/${key}`, { cookie: owner.cookie, body: { ...WORDING, ...body } });
    expect((await put('confirm', { body: 'Hi {{first_name}}' })).status).toBe(400);
    expect((await put('confirm', { mode: 'html', body: '<p>no link</p>' })).status).toBe(400);
    expect((await put('reader_signin', { mode: 'html', body: '{{signin_url}}' })).status).toBe(400);
    expect((await put('nonsense', {})).status).toBe(404);
  });

  it('knows no email or variable by an Object.prototype name', async () => {
    for (const key of ['constructor', 'toString', '__proto__']) {
      const res = await call('GET', `${base()}/${key}`, { cookie: owner.cookie });
      expect(res.status, key).toBe(404);
      const put = await call('PUT', `${base()}/${key}`, { cookie: owner.cookie, body: WORDING });
      expect(put.status, key).toBe(404);
    }
    // {{constructor}} is no variable of this email, so it is refused rather than sent.
    const res = await call('PUT', `${base()}/confirm`, {
      cookie: owner.cookie,
      body: { ...WORDING, body: 'Hello {{constructor}}.' },
    });
    expect(res.status).toBe(400);
  });

  it('sends a test to the person asking, marked as a test', async () => {
    const res = await call('POST', `${base()}/confirm/test`, {
      cookie: owner.cookie,
      body: WORDING,
    });
    expect(res.status).toBe(202);
    const { data } = await json<{ data: { sentTo: string } }>(res);
    const mail = await json<{ data: { subject: string } }>(
      await call('GET', `/__dev/mail/latest.json?to=${encodeURIComponent(data.sentTo)}`),
    );
    expect(mail.data.subject).toMatch(/^\[Test\] Please confirm/);
  });

  it('leaves editing to admins', async () => {
    const row = await env.DB.prepare(
      `SELECT operator_id FROM seats WHERE workspace_id =
         (SELECT workspace_id FROM channels WHERE id = ?1) LIMIT 1`,
    )
      .bind(channelId)
      .first<{ operator_id: string }>();
    await env.DB.prepare('UPDATE seats SET role = ?1 WHERE operator_id = ?2')
      .bind('editor', row!.operator_id)
      .run();
    try {
      const res = await call('PUT', `${base()}/confirm`, { cookie: owner.cookie, body: WORDING });
      expect(res.status).toBe(403);
    } finally {
      await env.DB.prepare('UPDATE seats SET role = ?1 WHERE operator_id = ?2')
        .bind('owner', row!.operator_id)
        .run();
    }
  });
});
