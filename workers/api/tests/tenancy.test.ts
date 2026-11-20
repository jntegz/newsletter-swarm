import { env } from 'cloudflare:test';
import type { SeatRole } from '@swarm/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  call,
  createChannel,
  json,
  latestToken,
  pngBytes,
  seatAs,
  sessionCookie,
  signIn,
  uniqueEmail,
  uploadForm,
  type Session,
} from './helpers';

const ROLES: SeatRole[] = ['viewer', 'author', 'editor', 'admin', 'owner'];
const rank = (role: SeatRole) => ROLES.indexOf(role);

let owner: Session;
let channelId: string;
let mediaId: string;
const members = {} as Record<SeatRole, Session>;
let outsider: Session;

beforeAll(async () => {
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
  members.owner = owner;
  for (const role of ['viewer', 'author', 'editor', 'admin'] as const) {
    members[role] = await seatAs(owner.workspaceId, role);
  }
  outsider = await signIn();
  const upload = await call('POST', `/api/v1/channels/${channelId}/media`, {
    cookie: owner.cookie,
    form: uploadForm(pngBytes()),
  });
  mediaId = (await json<{ data: { id: string } }>(upload)).data.id;
});

interface RouteCase {
  name: string;
  minimum: SeatRole;
  request: (session: Session) => Promise<Response>;
}

/**
 * Phase 1 routes with real bodies, so the allowed side is checked too. The negative cases for
 * every route (401, 404, 403) are generated in v1-matrix.test.ts from the route policy.
 */
const ROUTES: RouteCase[] = [
  {
    name: 'list seats',
    minimum: 'viewer',
    request: (s) =>
      call('GET', `/api/v1/workspaces/${owner.workspaceId}/seats`, { cookie: s.cookie }),
  },
  {
    name: 'rename workspace',
    minimum: 'admin',
    request: (s) =>
      call('PATCH', `/api/v1/workspaces/${owner.workspaceId}`, {
        cookie: s.cookie,
        body: { name: 'Field Notes Ltd' },
      }),
  },
  {
    name: 'list invites',
    minimum: 'admin',
    request: (s) =>
      call('GET', `/api/v1/workspaces/${owner.workspaceId}/invites`, { cookie: s.cookie }),
  },
  {
    name: 'read audit log',
    minimum: 'admin',
    request: (s) =>
      call('GET', `/api/v1/workspaces/${owner.workspaceId}/audit`, { cookie: s.cookie }),
  },
  {
    name: 'list channels',
    minimum: 'viewer',
    request: (s) =>
      call('GET', `/api/v1/workspaces/${owner.workspaceId}/channels`, { cookie: s.cookie }),
  },
  {
    name: 'create channel',
    minimum: 'admin',
    request: (s) =>
      call('POST', `/api/v1/workspaces/${owner.workspaceId}/channels`, {
        cookie: s.cookie,
        body: { name: 'New', slug: `new-${crypto.randomUUID().slice(0, 8)}` },
      }),
  },
  {
    name: 'read channel',
    minimum: 'viewer',
    request: (s) => call('GET', `/api/v1/channels/${channelId}`, { cookie: s.cookie }),
  },
  {
    name: 'edit channel',
    minimum: 'editor',
    request: (s) =>
      call('PATCH', `/api/v1/channels/${channelId}`, {
        cookie: s.cookie,
        body: { description: 'Weekly' },
      }),
  },
  {
    name: 'pause channel',
    minimum: 'admin',
    request: (s) =>
      call('PATCH', `/api/v1/channels/${channelId}`, {
        cookie: s.cookie,
        body: { status: 'active' },
      }),
  },
  {
    name: 'upload media',
    minimum: 'author',
    request: (s) =>
      call('POST', `/api/v1/channels/${channelId}/media`, {
        cookie: s.cookie,
        form: uploadForm(pngBytes()),
      }),
  },
  {
    name: 'list media',
    minimum: 'viewer',
    request: (s) => call('GET', `/api/v1/channels/${channelId}/media`, { cookie: s.cookie }),
  },
  {
    name: 'edit media',
    minimum: 'author',
    request: (s) =>
      call('PATCH', `/api/v1/media/${mediaId}`, {
        cookie: s.cookie,
        body: { altText: 'A chart', focalPoint: { x: 0.25, y: 0.75 } },
      }),
  },
];

describe('role matrix', () => {
  for (const route of ROUTES) {
    for (const role of ROLES) {
      const allowed = rank(role) >= rank(route.minimum);
      it(`${route.name}: ${role} is ${allowed ? 'allowed' : 'refused'}`, async () => {
        const res = await route.request(members[role]);
        if (allowed) expect(res.status, await res.clone().text()).toBeLessThan(300);
        else expect(res.status).toBe(403);
      });
    }
  }
});

describe('tenancy', () => {
  for (const route of ROUTES) {
    it(`${route.name}: another workspace's operator gets 404`, async () => {
      const res = await route.request(outsider);
      expect(res.status).toBe(404);
    });
  }

  it('signed-out requests get 401', async () => {
    for (const route of ROUTES) {
      const res = await route.request({ ...owner, cookie: '' });
      expect(res.status).toBe(401);
    }
  });
});

describe('team', () => {
  it('invites a teammate, who accepts after signing in with that address', async () => {
    const email = uniqueEmail('invitee');
    const sent = await call('POST', `/api/v1/workspaces/${owner.workspaceId}/invites`, {
      cookie: owner.cookie,
      body: { email, role: 'editor' },
    });
    expect(sent.status).toBe(201);
    // The audit chain is kept for years: the invitation entry holds no readable address.
    const audit = await env.DB.prepare(
      "SELECT metadata_json FROM audit_events WHERE workspace_id = ?1 AND action = 'invite.sent'",
    )
      .bind(owner.workspaceId)
      .all<{ metadata_json: string }>();
    expect(audit.results.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit.results)).not.toContain(email.split('@')[0]);
    const inviteToken = await latestToken(email, 'invite');

    const invitee = await signIn(email);
    const accepted = await call('POST', '/api/v1/invites/accept', {
      cookie: invitee.cookie,
      body: { token: inviteToken },
    });
    expect(accepted.status).toBe(200);
    expect((await json<{ data: { role: string } }>(accepted)).data.role).toBe('editor');

    const again = await call('POST', '/api/v1/invites/accept', {
      cookie: invitee.cookie,
      body: { token: inviteToken },
    });
    expect(again.status).toBe(404);
  });

  it('refuses an invite accepted by a different address', async () => {
    const email = uniqueEmail('intended');
    await call('POST', `/api/v1/workspaces/${owner.workspaceId}/invites`, {
      cookie: owner.cookie,
      body: { email, role: 'viewer' },
    });
    const token = await latestToken(email, 'invite');
    const res = await call('POST', '/api/v1/invites/accept', {
      cookie: outsider.cookie,
      body: { token },
    });
    expect(res.status).toBe(403);
  });

  it('lets only owners invite admins or change ownership', async () => {
    const admin = members.admin;
    const invite = await call('POST', `/api/v1/workspaces/${owner.workspaceId}/invites`, {
      cookie: admin.cookie,
      body: { email: uniqueEmail(), role: 'admin' },
    });
    expect(invite.status).toBe(403);

    const seats = await json<{ data: { id: string; role: string; operator: { id: string } }[] }>(
      await call('GET', `/api/v1/workspaces/${owner.workspaceId}/seats`, { cookie: admin.cookie }),
    );
    const editorSeat = seats.data.find((s) => s.operator.id === members.editor.me.operator.id)!;
    const promote = await call(
      'PATCH',
      `/api/v1/workspaces/${owner.workspaceId}/seats/${editorSeat.id}`,
      {
        cookie: admin.cookie,
        body: { role: 'owner' },
      },
    );
    expect(promote.status).toBe(403);
  });

  it("rotates a teammate's sessions when their role changes", async () => {
    const solo = await signIn();
    const teammate = await seatAs(solo.workspaceId, 'viewer');
    const seats = await json<{ data: { id: string; operator: { id: string } }[] }>(
      await call('GET', `/api/v1/workspaces/${solo.workspaceId}/seats`, { cookie: solo.cookie }),
    );
    const seatOf = (operatorId: string) => seats.data.find((s) => s.operator.id === operatorId)!.id;
    const me = (cookie: string) => call('GET', '/api/v1/auth/session', { cookie });

    // Someone else's role: their sessions end (their cookie can't be swapped from here).
    const promote = await call(
      'PATCH',
      `/api/v1/workspaces/${solo.workspaceId}/seats/${seatOf(teammate.me.operator.id)}`,
      { cookie: solo.cookie, body: { role: 'owner' } },
    );
    expect(promote.status).toBe(200);
    expect((await me(teammate.cookie)).status).toBe(401);
    expect((await me(solo.cookie)).status).toBe(200);

    // Your own role: this session gets a new token in place; the old one stops working.
    const demote = await call(
      'PATCH',
      `/api/v1/workspaces/${solo.workspaceId}/seats/${seatOf(solo.me.operator.id)}`,
      { cookie: solo.cookie, body: { role: 'admin' } },
    );
    expect(demote.status).toBe(200);
    const rotated = sessionCookie(demote);
    expect(rotated).not.toBe(solo.cookie);
    expect((await me(solo.cookie)).status).toBe(401);
    expect((await me(rotated)).status).toBe(200);
  });

  it('never leaves a workspace without an owner', async () => {
    const solo = await signIn();
    const seats = await json<{ data: { id: string }[] }>(
      await call('GET', `/api/v1/workspaces/${solo.workspaceId}/seats`, { cookie: solo.cookie }),
    );
    const seatId = seats.data[0]!.id;
    const demote = await call('PATCH', `/api/v1/workspaces/${solo.workspaceId}/seats/${seatId}`, {
      cookie: solo.cookie,
      body: { role: 'admin' },
    });
    expect(demote.status).toBe(409);
    const leave = await call('DELETE', `/api/v1/workspaces/${solo.workspaceId}/seats/${seatId}`, {
      cookie: solo.cookie,
    });
    expect(leave.status).toBe(409);
  });
});
