// Code embeds and custom email CSS: both flags enforced on the server, the CSS lint on save, and
// the stylesheet and highlighting in every render path (the Dispatch's stored render, test sends).
import type { Dispatch, EmailCss, SeatRole } from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createChannel, seatAs, signIn, type Session } from './helpers';
import { data, enableFlag, errorCode } from './money-helpers';

let owner: Session;
let channelId: string;

const code = {
  type: 'codeBlock',
  attrs: { language: 'js' },
  content: [{ type: 'text', text: 'const a = 1;' }],
};
const toc = { type: 'tableOfContents', attrs: {} };
const heading = {
  type: 'heading',
  attrs: { level: 2 },
  content: [{ type: 'text', text: 'Intro' }],
};
const para = { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] };

const getCss = (s: Session, id = channelId) =>
  call('GET', `/api/v1/channels/${id}/email-css`, { cookie: s.cookie });
const putCss = (s: Session, css: string, id = channelId) =>
  call('PUT', `/api/v1/channels/${id}/email-css`, { cookie: s.cookie, body: { css } });

async function newDispatch(s: Session, id: string, content: unknown[]) {
  return call('POST', `/api/v1/channels/${id}/dispatches`, {
    cookie: s.cookie,
    body: { subject: 'Issue 1', content: { type: 'doc', content } },
  });
}

beforeAll(async () => {
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
});

describe('custom email CSS', () => {
  it('is off until the flag is on', async () => {
    const res = await getCss(owner);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('feature_disabled');
    expect(await errorCode(await putCss(owner, 'p { color: red }'))).toBe('feature_disabled');
  });

  it('saves a clean stylesheet with its warnings, and removes it when empty', async () => {
    await enableFlag('custom_email_css', owner.workspaceId, channelId);
    expect(await data<EmailCss>(await getCss(owner))).toEqual({
      css: '',
      updatedAt: null,
      warnings: [],
    });
    const saved = await data<EmailCss>(
      await putCss(owner, 'p { color: #222; box-shadow: 0 0 1px #000 }'),
    );
    expect(saved.css).toContain('color: #222');
    expect(saved.updatedAt).not.toBeNull();
    expect(saved.warnings.map((w) => w.message).join(' ')).toMatch(/box-shadow/);
    expect((await data<EmailCss>(await getCss(owner))).css).toBe(saved.css);
    expect((await data<EmailCss>(await putCss(owner, ''))).css).toBe('');
    expect((await data<EmailCss>(await getCss(owner))).updatedAt).toBeNull();
  });

  it.each([
    '@import url(https://evil.example/x.css);',
    'p { background: url(https://t.example/p.gif) }',
    'div { position: fixed }',
    'p { width: expression(alert(1)) }',
    'p { color: red } </style>',
  ])('refuses %s with the line of the problem', async (css) => {
    const res = await putCss(owner, css);
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details: { path: string; message: string }[] };
    };
    expect(body.error.code).toBe('invalid_input');
    expect(body.error.details[0]?.message).toMatch(/^Line 1: /);
  });

  it('refuses a stylesheet over the size cap', async () => {
    expect((await putCss(owner, 'p{color:red}'.repeat(2000))).status).toBe(400);
  });

  it('lets every role read it and only admins change it', async () => {
    const roles: SeatRole[] = ['admin', 'editor', 'author', 'viewer'];
    for (const role of roles) {
      const seat = await seatAs(owner.workspaceId, role);
      expect((await getCss(seat)).status, role).toBe(200);
      expect((await putCss(seat, 'p { color: #333 }')).status, role).toBe(
        role === 'admin' ? 200 : 403,
      );
    }
  });

  it('is invisible to another workspace', async () => {
    const outsider = await signIn();
    expect((await getCss(outsider)).status).toBe(404);
    expect((await putCss(outsider, 'p { color: red }')).status).toBe(404);
  });

  it('is in the render and in test sends', async () => {
    const ch = (await createChannel(owner)).id;
    await enableFlag('custom_email_css', owner.workspaceId, ch);
    await data(
      await putCss(
        owner,
        'p { color: #123456 } @media (max-width: 600px) { p { font-size: 18px } }',
        ch,
      ),
    );
    const dispatch = await data<Dispatch>(await newDispatch(owner, ch, [para]), 201);
    expect(dispatch.html).toContain(';color:#123456">Hello</p>');
    expect(dispatch.html).toContain('<style>@media (max-width: 600px){p{font-size:18px}}</style>');

    await data(
      await call('POST', `/api/v1/dispatches/${dispatch.id}/test`, {
        cookie: owner.cookie,
        body: {},
      }),
      202,
    );
    const mail = await data<{ html: string }>(
      await call('GET', `/__dev/mail/latest.json?to=${encodeURIComponent(owner.email)}`),
    );
    expect(mail.html).toContain(';color:#123456">Hello</p>');
  });
});

describe('code embeds', () => {
  it('refuses a table of contents without the flag and highlights nothing', async () => {
    const ch = (await createChannel(owner)).id;
    const refused = await newDispatch(owner, ch, [toc, heading]);
    expect(refused.status).toBe(400);
    const plain = await data<Dispatch>(await newDispatch(owner, ch, [code]), 201);
    expect(plain.html).not.toContain('sw-tk-');
  });

  it('highlights code and lists headings with the flag', async () => {
    const ch = (await createChannel(owner)).id;
    await enableFlag('code_embeds', owner.workspaceId, ch);
    const dispatch = await data<Dispatch>(await newDispatch(owner, ch, [toc, heading, code]), 201);
    expect(dispatch.html).toContain('<span class="sw-tk-kw" style="color:#5636e8">const</span>');
    expect(dispatch.html).toContain('class="sw-toc sw-line"');
    expect(dispatch.html).toContain('>Intro</li>');
    expect(dispatch.html).not.toMatch(/<script/i);
  });
});
