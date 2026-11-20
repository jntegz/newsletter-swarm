// Role matrix and tenancy for every Phase 3 Members route (members, profile fields, tags, bulk
// actions, imports, exports), in the pattern of tenancy.test.ts.
import { env } from 'cloudflare:test';
import type { SeatRole } from '@swarm/domain';
import { parseKeyring, signToken } from '@swarm/tokens';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addField,
  addMember,
  csvForm,
  data,
  finishedExport,
  markAnalyzed,
  upload,
} from './audience-helpers';
import { call, createChannel, seatAs, signIn, type Session } from './helpers';

const ROLES: SeatRole[] = ['viewer', 'author', 'editor', 'admin', 'owner'];
const rank = (role: SeatRole) => ROLES.indexOf(role);

let owner: Session;
let channelId: string;
let memberId: string;
let fieldId: string;
let tagId: string;
let importId: string;
let bulkId: string;
let exportId: string;
const sessions = {} as Record<SeatRole, Session>;
let outsider: Session;
const unique = () => crypto.randomUUID().slice(0, 8);

beforeAll(async () => {
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
  sessions.owner = owner;
  for (const role of ['viewer', 'author', 'editor', 'admin'] as const) {
    sessions[role] = await seatAs(owner.workspaceId, role);
  }
  outsider = await signIn();
  memberId = (await addMember(owner, channelId)).id;
  fieldId = (await addField(owner, channelId)).id;
  tagId = (
    await data<{ id: string }>(
      await call('POST', `/api/v1/channels/${channelId}/tags`, {
        cookie: owner.cookie,
        body: { name: `t-${unique()}` },
      }),
      201,
    )
  ).id;
  importId = (await upload(owner, channelId, 'email\na@example.com\n')).id;
  bulkId = (
    await data<{ id: string }>(
      await call('POST', `/api/v1/channels/${channelId}/bulk-jobs`, {
        cookie: owner.cookie,
        body: { selection: { memberIds: [memberId] }, action: 'tag', tag: 'x' },
      }),
      202,
    )
  ).id;
  exportId = await finishedExport(owner.workspaceId, channelId);
});

const freshMember = async () => (await addMember(owner, channelId)).id;
const freshImport = async () => (await upload(owner, channelId, 'email\nb@example.com\n')).id;

interface RouteCase {
  name: string;
  minimum: SeatRole;
  request: (session: Session) => Promise<Response>;
}

const ROUTES: RouteCase[] = [
  // Members
  {
    name: 'search members',
    minimum: 'viewer',
    request: (s) =>
      call('GET', `/api/v1/channels/${channelId}/members?q=a&status=active&tag=x`, {
        cookie: s.cookie,
      }),
  },
  {
    name: 'member counts',
    minimum: 'viewer',
    request: (s) =>
      call('GET', `/api/v1/channels/${channelId}/members/counts`, { cookie: s.cookie }),
  },
  {
    name: 'add member',
    minimum: 'editor',
    request: (s) =>
      call('POST', `/api/v1/channels/${channelId}/members`, {
        cookie: s.cookie,
        body: { email: `m-${unique()}@example.com` },
      }),
  },
  {
    name: 'read member',
    minimum: 'viewer',
    request: (s) => call('GET', `/api/v1/members/${memberId}`, { cookie: s.cookie }),
  },
  {
    name: 'member activity',
    minimum: 'viewer',
    request: (s) => call('GET', `/api/v1/members/${memberId}/activity`, { cookie: s.cookie }),
  },
  {
    name: 'edit member',
    minimum: 'editor',
    request: (s) =>
      call('PATCH', `/api/v1/members/${memberId}`, {
        cookie: s.cookie,
        body: { firstName: 'Ada' },
      }),
  },
  {
    name: 'delete member',
    minimum: 'editor',
    request: async (s) =>
      call('DELETE', `/api/v1/members/${await freshMember()}`, { cookie: s.cookie }),
  },
  // Profile fields
  {
    name: 'list profile fields',
    minimum: 'viewer',
    request: (s) =>
      call('GET', `/api/v1/channels/${channelId}/member-fields`, { cookie: s.cookie }),
  },
  {
    name: 'add profile field',
    minimum: 'editor',
    request: (s) =>
      call('POST', `/api/v1/channels/${channelId}/member-fields`, {
        cookie: s.cookie,
        body: { key: `k_${unique()}`, label: 'City', type: 'text' },
      }),
  },
  {
    name: 'edit profile field',
    minimum: 'editor',
    request: (s) =>
      call('PATCH', `/api/v1/member-fields/${fieldId}`, {
        cookie: s.cookie,
        body: { label: 'Town' },
      }),
  },
  {
    name: 'remove profile field',
    minimum: 'editor',
    request: async (s) =>
      call('DELETE', `/api/v1/member-fields/${(await addField(owner, channelId)).id}`, {
        cookie: s.cookie,
      }),
  },
  // Tags
  {
    name: 'list tags',
    minimum: 'viewer',
    request: (s) => call('GET', `/api/v1/channels/${channelId}/tags`, { cookie: s.cookie }),
  },
  {
    name: 'create tag',
    minimum: 'editor',
    request: (s) =>
      call('POST', `/api/v1/channels/${channelId}/tags`, {
        cookie: s.cookie,
        body: { name: `t-${unique()}` },
      }),
  },
  {
    name: 'rename tag',
    minimum: 'editor',
    request: (s) =>
      call('PATCH', `/api/v1/tags/${tagId}`, { cookie: s.cookie, body: { name: `t-${unique()}` } }),
  },
  {
    name: 'delete tag',
    minimum: 'editor',
    request: async (s) => {
      const tag = await data<{ id: string }>(
        await call('POST', `/api/v1/channels/${channelId}/tags`, {
          cookie: owner.cookie,
          body: { name: `t-${unique()}` },
        }),
        201,
      );
      return call('DELETE', `/api/v1/tags/${tag.id}`, { cookie: s.cookie });
    },
  },
  // Bulk actions
  {
    name: 'start bulk action',
    minimum: 'editor',
    request: (s) =>
      call('POST', `/api/v1/channels/${channelId}/bulk-jobs`, {
        cookie: s.cookie,
        body: { selection: { memberIds: [memberId] }, action: 'untag', tag: 'x' },
      }),
  },
  {
    name: 'bulk progress',
    minimum: 'viewer',
    request: (s) => call('GET', `/api/v1/bulk-jobs/${bulkId}`, { cookie: s.cookie }),
  },
  // Imports
  {
    name: 'upload import',
    minimum: 'editor',
    request: (s) =>
      call('POST', `/api/v1/channels/${channelId}/imports`, {
        cookie: s.cookie,
        form: csvForm('email\nc@example.com\n'),
      }),
  },
  {
    name: 'list imports',
    minimum: 'viewer',
    request: (s) => call('GET', `/api/v1/channels/${channelId}/imports`, { cookie: s.cookie }),
  },
  {
    name: 'read import',
    minimum: 'viewer',
    request: (s) => call('GET', `/api/v1/imports/${importId}`, { cookie: s.cookie }),
  },
  {
    name: 'map import',
    minimum: 'editor',
    request: (s) =>
      call('PUT', `/api/v1/imports/${importId}/mapping`, {
        cookie: s.cookie,
        body: { mapping: { email: 'email' }, consentAttested: true, updateExisting: false },
      }),
  },
  {
    name: 'analyze import',
    minimum: 'editor',
    request: async (s) =>
      call('POST', `/api/v1/imports/${await freshImport()}/analyze`, { cookie: s.cookie }),
  },
  {
    name: 'confirm import',
    minimum: 'editor',
    request: async (s) => {
      const id = await freshImport();
      await markAnalyzed(id);
      return call('POST', `/api/v1/imports/${id}/confirm`, { cookie: s.cookie });
    },
  },
  {
    name: 'cancel import',
    minimum: 'editor',
    request: async (s) =>
      call('POST', `/api/v1/imports/${await freshImport()}/cancel`, { cookie: s.cookie }),
  },
  // Exports: admins and owners only
  {
    name: 'create export',
    minimum: 'admin',
    request: (s) =>
      call('POST', `/api/v1/channels/${channelId}/exports`, {
        cookie: s.cookie,
        body: { format: 'csv' },
      }),
  },
  {
    name: 'list exports',
    minimum: 'admin',
    request: (s) => call('GET', `/api/v1/channels/${channelId}/exports`, { cookie: s.cookie }),
  },
  {
    name: 'read export',
    minimum: 'admin',
    request: (s) => call('GET', `/api/v1/exports/${exportId}`, { cookie: s.cookie }),
  },
  {
    name: 'download export',
    minimum: 'admin',
    request: async (s) => {
      const token = await signToken(
        parseKeyring(env.AUTH_KEYS),
        'export',
        { exportId },
        { expiresInSeconds: 600 },
      );
      return call('GET', `/api/v1/exports/${exportId}/download?token=${token}`, {
        cookie: s.cookie,
      });
    },
  },
];

describe('role matrix', () => {
  for (const route of ROUTES) {
    for (const role of ROLES) {
      const allowed = rank(role) >= rank(route.minimum);
      it(`${route.name}: ${role} is ${allowed ? 'allowed' : 'refused'}`, async () => {
        const res = await route.request(sessions[role]);
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
      expect(res.status, route.name).toBe(401);
    }
  });
});
