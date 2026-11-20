// Privacy Center and export destinations (Phase 7): the data-request queue (create, list, SLA,
// approve with confirmation, reject, retry), export destinations (plan limits, sealed
// credentials that are never returned, test connection against a fake S3), the erased-address
// refusal on operator create, and the role matrix and tenancy on every route.
import { env } from 'cloudflare:test';
import type { DsrRequest, ExportDestination, SeatRole } from '@swarm/domain';
import { emailHash, eraseAddress, openCredentials, requestFromMemberCenter } from '@swarm/engine';
import { parseKeyring } from '@swarm/tokens';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '@swarm/vault/testing';
import { addMember, data } from './audience-helpers';
import {
  call,
  createChannel,
  freshFactor,
  seatAs,
  signIn,
  uniqueEmail,
  type Session,
} from './helpers';

const ROLES: SeatRole[] = ['viewer', 'author', 'editor', 'admin', 'owner'];
const rank = (role: SeatRole) => ROLES.indexOf(role);
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const KEY_ID = 'AKIDEXAMPLE1234';

let owner: Session;
let outsider: Session;
let channelId: string;
const sessions = {} as Record<SeatRole, Session>;

/** What the fake S3 at https://acct.r2.cloudflarestorage.com saw, and how it answers. */
const s3 = {
  calls: [] as { method: string; url: string; authorization: string }[],
  status: 200,
};

beforeEach(() => {
  s3.calls = [];
  s3.status = 200;
  const fallback = vi.mocked(globalThis.fetch).getMockImplementation();
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://acct.r2.cloudflarestorage.com/')) {
      s3.calls.push({
        method: init?.method ?? 'GET',
        url,
        authorization: new Headers(init?.headers).get('authorization') ?? '',
      });
      return s3.status === 200
        ? new Response(null, { status: 200 })
        : new Response('<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>', {
            status: s3.status,
          });
    }
    return fallback!(input, init);
  });
});

beforeAll(async () => {
  // Adding or repointing an export destination needs a fresh factor of the operator's own.
  owner = await freshFactor(await signIn());
  sessions.owner = owner;
  for (const role of ['viewer', 'author', 'editor', 'admin'] as const) {
    sessions[role] = await freshFactor(await seatAs(owner.workspaceId, role));
  }
  outsider = await freshFactor(await signIn());
  channelId = (await createChannel(owner)).id;
  await env.DB.prepare("UPDATE workspaces SET plan = 'enterprise' WHERE id = ?1")
    .bind(owner.workspaceId)
    .run();
});

const requestsPath = () => `/api/v1/workspaces/${owner.workspaceId}/privacy/requests`;

async function fileRequest(kind: 'export' | 'erase', email?: string): Promise<DsrRequest> {
  const address = email ?? (await addMember(owner, channelId)).email;
  return data<DsrRequest>(
    await call('POST', requestsPath(), { cookie: owner.cookie, body: { email: address, kind } }),
    201,
  );
}

/** An export the jobs worker finished: its file in EXPORTS, its link still working. */
async function finishedExport(): Promise<DsrRequest> {
  const request = await fileRequest('export');
  const key = `dsr/${owner.workspaceId}/${request.id}.json`;
  await env.EXPORTS.put(key, JSON.stringify({ format: 'swarm-member-data/1', email: 'x' }));
  await env.DB.prepare(
    `UPDATE dsr_requests SET status = 'completed', export_key = ?1, export_expires_at = ?2,
        completed_at = ?3 WHERE id = ?4`,
  )
    .bind(key, Date.now() + 86_400_000, Date.now(), request.id)
    .run();
  return request;
}

const destinationBody = () => ({
  kind: 'r2',
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'warehouse',
  prefix: 'swarm/',
  schedule: 'hourly',
  accessKeyId: KEY_ID,
  secretAccessKey: SECRET,
});

async function addDestination(): Promise<ExportDestination> {
  return data<ExportDestination>(
    await call('POST', `/api/v1/channels/${channelId}/export-destinations`, {
      cookie: owner.cookie,
      body: destinationBody(),
    }),
    201,
  );
}

describe('the data-request queue', () => {
  it('files a request on behalf of a person, with its SLA, and never logs the address', async () => {
    const member = await addMember(owner, channelId, { email: uniqueEmail('Person') });
    const before = Date.now();
    const request = await data<DsrRequest>(
      await call('POST', requestsPath(), {
        cookie: owner.cookie,
        body: { email: member.email.toUpperCase(), kind: 'erase', note: 'Asked by email' },
      }),
      201,
    );
    expect(request).toMatchObject({
      kind: 'erase',
      source: 'operator',
      status: 'pending',
      overdue: false,
      note: 'Asked by email',
      member: { id: member.id, email: member.email, channelId },
      handledBy: { id: owner.me.operator.id },
    });
    const due = Date.parse(request.dueAt) - Date.parse(request.createdAt);
    expect(due).toBe(30 * 24 * 3_600_000);
    expect(Date.parse(request.createdAt)).toBeGreaterThanOrEqual(before - 1000);

    // The same open kind for the same address is refused; another kind is fine.
    const twice = await call('POST', requestsPath(), {
      cookie: owner.cookie,
      body: { email: member.email, kind: 'erase' },
    });
    expect(twice.status).toBe(409);
    await fileRequest('export', member.email);

    const audit = await env.DB.prepare(
      "SELECT metadata_json FROM audit_events WHERE workspace_id = ?1 AND action = 'privacy.request_created'",
    )
      .bind(owner.workspaceId)
      .all<{ metadata_json: string }>();
    expect(audit.results.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit.results)).not.toContain(member.email);
  });

  it('files a request for an address with no Member, without creating one', async () => {
    const email = `buyer-only-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const res = await call('POST', requestsPath(), {
      cookie: owner.cookie,
      body: { email, kind: 'erase', note: 'Bought a gift, never subscribed' },
    });
    const request = await data<DsrRequest>(res, 201);
    expect(request).toMatchObject({ kind: 'erase', status: 'pending', member: null });
    // A short workspace-keyed label, never the full marker or the bare digest of the address.
    expect(request.emailHash).toMatch(/^[0-9a-f]{12}$/);
    expect((await emailHash(email)).startsWith(request.emailHash)).toBe(false);
    expect(
      await env.DB.prepare('SELECT count(*) AS n FROM members WHERE email = ?1')
        .bind(email)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });

  it('lists with filters and marks overdue requests', async () => {
    const late = await fileRequest('export');
    await env.DB.prepare('UPDATE dsr_requests SET due_at = ?1 WHERE id = ?2')
      .bind(Date.now() - 60_000, late.id)
      .run();
    const page = await data<{ items: DsrRequest[]; nextCursor: string | null }>(
      await call('GET', `${requestsPath()}?kind=export&status=pending&limit=100`, {
        cookie: owner.cookie,
      }),
    );
    expect(page.items.every((r) => r.kind === 'export' && r.status === 'pending')).toBe(true);
    expect(page.items.find((r) => r.id === late.id)?.overdue).toBe(true);

    const first = await data<{ items: DsrRequest[]; nextCursor: string | null }>(
      await call('GET', `${requestsPath()}?limit=1`, { cookie: owner.cookie }),
    );
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBe(first.items[0]!.id);
    const one = await data<DsrRequest>(
      await call('GET', `${requestsPath()}/${late.id}`, { cookie: owner.cookie }),
    );
    expect(one.id).toBe(late.id);
  });

  it('approving an erasure needs the confirmation; rejecting needs a reason', async () => {
    const erase = await fileRequest('erase');
    const unconfirmed = await call('POST', `${requestsPath()}/${erase.id}/approve`, {
      cookie: owner.cookie,
      body: {},
    });
    expect(unconfirmed.status).toBe(400);
    const approved = await data<DsrRequest>(
      await call('POST', `${requestsPath()}/${erase.id}/approve`, {
        cookie: owner.cookie,
        body: { confirm: 'erase', note: 'Identity checked' },
      }),
    );
    expect(approved).toMatchObject({ status: 'processing', note: 'Identity checked' });
    // Approved is no longer pending.
    expect(
      (
        await call('POST', `${requestsPath()}/${erase.id}/reject`, {
          cookie: owner.cookie,
          body: { note: 'x' },
        })
      ).status,
    ).toBe(409);

    const exportRequest = await fileRequest('export');
    expect(
      (
        await call('POST', `${requestsPath()}/${exportRequest.id}/reject`, {
          cookie: owner.cookie,
          body: {},
        })
      ).status,
    ).toBe(400);
    const rejected = await data<DsrRequest>(
      await call('POST', `${requestsPath()}/${exportRequest.id}/reject`, {
        cookie: owner.cookie,
        body: { note: 'Not the address owner' },
      }),
    );
    expect(rejected).toMatchObject({ status: 'rejected', note: 'Not the address owner' });
    // The sealed address waits for the jobs worker to tell the person, which then clears it
    // (sendRequestOutcomeNotices).
    const sealed = await env.DB.prepare(
      'SELECT email_enc, outcome_noticed_at FROM dsr_requests WHERE id = ?1',
    )
      .bind(exportRequest.id)
      .first<{ email_enc: string | null; outcome_noticed_at: number | null }>();
    expect(sealed?.email_enc).not.toBeNull();
    expect(sealed?.outcome_noticed_at).toBeNull();
  });

  it('marks an erasure from a link that proves nothing as unverified, and a verified one not', async () => {
    const keys = parseKeyring((env as unknown as { TEST_FIELD_KEYS: string }).TEST_FIELD_KEYS);
    const unproven = await addMember(owner, channelId);
    // A bounced address's footer link, which may have been forwarded: it waits for review.
    const review = await requestFromMemberCenter(
      env.DB,
      keys,
      unproven.id,
      'erase',
      Date.now(),
      true,
    );
    const queued = await data<DsrRequest>(
      await call('GET', `${requestsPath()}/${review.requestId}`, { cookie: owner.cookie }),
    );
    expect(queued).toMatchObject({ status: 'pending', source: 'member_center_unverified' });

    const verified = await addMember(owner, channelId);
    const own = await requestFromMemberCenter(env.DB, keys, verified.id, 'erase');
    const running = await data<DsrRequest>(
      await call('GET', `${requestsPath()}/${own.requestId}`, { cookie: owner.cookie }),
    );
    expect(running).toMatchObject({ status: 'processing', source: 'member_center' });

    // The person's own verified request runs the unverified one, which is then verified.
    await requestFromMemberCenter(env.DB, keys, unproven.id, 'erase');
    const promoted = await data<DsrRequest>(
      await call('GET', `${requestsPath()}/${review.requestId}`, { cookie: owner.cookie }),
    );
    expect(promoted).toMatchObject({ status: 'processing', source: 'member_center' });
  });

  it('leaves a request an admin filed and left pending for the admin to approve', async () => {
    const keys = parseKeyring((env as unknown as { TEST_FIELD_KEYS: string }).TEST_FIELD_KEYS);
    for (const kind of ['export', 'erase'] as const) {
      const member = await addMember(owner, channelId);
      const filed = await fileRequest(kind, member.email);
      expect(filed).toMatchObject({ status: 'pending', source: 'operator' });
      // The Member's own verified click answers with that request; it does not run it.
      const result = await requestFromMemberCenter(env.DB, keys, member.id, kind);
      expect(result).toEqual({ outcome: 'open', requestId: filed.id, status: 'pending' });
      const after = await data<DsrRequest>(
        await call('GET', `${requestsPath()}/${filed.id}`, { cookie: owner.cookie }),
      );
      expect(after).toMatchObject({ status: 'pending', source: 'operator' });
    }
  });

  it('retries only a failed request', async () => {
    const request = await fileRequest('export');
    expect(
      (await call('POST', `${requestsPath()}/${request.id}/retry`, { cookie: owner.cookie }))
        .status,
    ).toBe(409);
    await env.DB.prepare(
      "UPDATE dsr_requests SET status = 'failed', attempts = 3, error = 'boom' WHERE id = ?1",
    )
      .bind(request.id)
      .run();
    const retried = await data<DsrRequest>(
      await call('POST', `${requestsPath()}/${request.id}/retry`, { cookie: owner.cookie }),
    );
    expect(retried).toMatchObject({ status: 'processing', attempts: 0 });
  });

  it('downloads a finished export for the admin, audited, while its link works', async () => {
    const request = await finishedExport();
    const path = `${requestsPath()}/${request.id}/download`;
    const res = await call('POST', path, { cookie: owner.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="data-request-/);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toMatchObject({ format: 'swarm-member-data/1' });
    const audit = await env.DB.prepare(
      "SELECT count(*) AS n FROM audit_events WHERE action = 'privacy.export_downloaded' AND target_id = ?1",
    )
      .bind(request.id)
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
    // Past the link's expiry, an erasure, or an export still running: nothing to download.
    await env.DB.prepare('UPDATE dsr_requests SET export_expires_at = 1 WHERE id = ?1')
      .bind(request.id)
      .run();
    expect((await call('POST', path, { cookie: owner.cookie })).status).toBe(404);
    const erase = await fileRequest('erase');
    expect(
      (await call('POST', `${requestsPath()}/${erase.id}/download`, { cookie: owner.cookie }))
        .status,
    ).toBe(404);
    const running = await fileRequest('export');
    expect(
      (await call('POST', `${requestsPath()}/${running.id}/download`, { cookie: owner.cookie }))
        .status,
    ).toBe(404);
  });

  it('refuses to approve an erasure while a Stripe subscription renews', async () => {
    const member = await addMember(owner, channelId);
    await env.DB.prepare(
      `INSERT INTO member_subscriptions (id, channel_id, member_id, source, status, stripe_subscription_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'stripe', 'active', ?4, ?5, ?5)`,
    )
      .bind(
        `ms_${crypto.randomUUID().replace(/-/g, '')}`,
        channelId,
        member.id,
        `sub_${crypto.randomUUID().slice(0, 8)}`,
        Date.now(),
      )
      .run();
    const request = await fileRequest('erase', member.email);
    const res = await call('POST', `${requestsPath()}/${request.id}/approve`, {
      cookie: owner.cookie,
      body: { confirm: 'erase' },
    });
    expect(res.status).toBe(409);
  });
});

describe('erased addresses', () => {
  it('cannot be added again by an operator', async () => {
    const member = await addMember(owner, channelId);
    await eraseAddress(env.DB, {
      workspaceId: owner.workspaceId,
      email: member.email,
      keys: parseKeyring((env as unknown as { TEST_FIELD_KEYS: string }).TEST_FIELD_KEYS),
    });
    const res = await call('POST', `/api/v1/channels/${channelId}/members`, {
      cookie: owner.cookie,
      body: { email: member.email.toUpperCase(), consent: true },
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('erased');
  });
});

describe('export destinations', () => {
  it('stores the keys sealed and never returns them', async () => {
    const res = await call('POST', `/api/v1/channels/${channelId}/export-destinations`, {
      cookie: owner.cookie,
      body: destinationBody(),
    });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(KEY_ID);
    const { data: created } = JSON.parse(text) as { data: ExportDestination };
    expect(created).toMatchObject({
      kind: 'r2',
      bucket: 'warehouse',
      prefix: 'swarm/',
      status: 'active',
    });
    const row = await env.DB.prepare(
      'SELECT credentials_enc FROM export_destinations WHERE id = ?1',
    )
      .bind(created.id)
      .first<{ credentials_enc: string }>();
    expect(row!.credentials_enc).not.toContain(SECRET);
    expect(row!.credentials_enc).not.toContain(KEY_ID);

    const list = await call('GET', `/api/v1/channels/${channelId}/export-destinations`, {
      cookie: owner.cookie,
    });
    const listed = await list.text();
    expect(listed).not.toContain(SECRET);
    expect(listed).not.toContain(KEY_ID);

    const patched = await call('PATCH', `/api/v1/export-destinations/${created.id}`, {
      cookie: owner.cookie,
      body: { status: 'paused', accessKeyId: 'AKIDOTHER99999', secretAccessKey: `${SECRET}2` },
    });
    expect(patched.status).toBe(200);
    expect(await patched.text()).not.toContain('AKIDOTHER99999');
    const audit = await env.DB.prepare(
      'SELECT metadata_json FROM audit_events WHERE target_id = ?1',
    )
      .bind(created.id)
      .all<{ metadata_json: string }>();
    expect(JSON.stringify(audit.results)).not.toContain(SECRET);
  });

  it('binds the sealed keys to the destination, and leaves older keys to the vault re-seal', async () => {
    const fieldKeys = parseKeyring((env as unknown as { TEST_FIELD_KEYS: string }).TEST_FIELD_KEYS);
    const created = await addDestination();
    const sealed = async () =>
      (await env.DB.prepare('SELECT credentials_enc FROM export_destinations WHERE id = ?1')
        .bind(created.id)
        .first<{ credentials_enc: string }>())!.credentials_enc;
    const dest = { workspaceId: owner.workspaceId, destinationId: created.id };
    expect(await openCredentials(fieldKeys, dest, await sealed())).toMatchObject({
      accessKeyId: KEY_ID,
      legacy: false,
    });
    expect(
      await openCredentials(fieldKeys, { ...dest, destinationId: 'ed_other' }, await sealed()),
    ).toBeNull();
    // A value sealed before binding: still readable; a save doesn't touch it (the api never
    // opens keys), the vault's re-seal cron moves it onto the current format.
    await env.DB.prepare('UPDATE export_destinations SET credentials_enc = ?1 WHERE id = ?2')
      .bind(
        await encrypt(fieldKeys, JSON.stringify({ accessKeyId: KEY_ID, secretAccessKey: SECRET })),
        created.id,
      )
      .run();
    expect((await openCredentials(fieldKeys, dest, await sealed()))?.legacy).toBe(true);
    const saved = await call('PATCH', `/api/v1/export-destinations/${created.id}`, {
      cookie: owner.cookie,
      body: { schedule: 'daily' },
    });
    expect(saved.status).toBe(200);
    expect((await openCredentials(fieldKeys, dest, await sealed()))?.legacy).toBe(true);
  });

  it('validates input: R2 needs an endpoint, private hosts are refused, keys go together', async () => {
    const path = `/api/v1/channels/${channelId}/export-destinations`;
    const { endpoint: _drop, ...noEndpoint } = destinationBody();
    expect((await call('POST', path, { cookie: owner.cookie, body: noEndpoint })).status).toBe(400);
    expect(
      (
        await call('POST', path, {
          cookie: owner.cookie,
          body: { ...destinationBody(), endpoint: 'https://10.0.0.1' },
        })
      ).status,
    ).toBe(400);
    const created = await addDestination();
    expect(
      (
        await call('PATCH', `/api/v1/export-destinations/${created.id}`, {
          cookie: owner.cookie,
          body: { accessKeyId: 'AKIDONLYONE1234' },
        })
      ).status,
    ).toBe(400);
  });

  it('tests the connection: a signed PUT then DELETE, and reports a refusal', async () => {
    const created = await addDestination();
    const ok = await data<{ ok: boolean; status: number | null; message: string }>(
      await call('POST', `/api/v1/export-destinations/${created.id}/test`, {
        cookie: owner.cookie,
      }),
    );
    expect(ok.ok).toBe(true);
    expect(s3.calls.map((c) => c.method)).toEqual(['PUT', 'DELETE']);
    expect(new URL(s3.calls[0]!.url).pathname).toMatch(
      /^\/warehouse\/swarm\/swarm-connection-test-\d+\.txt$/,
    );
    expect(s3.calls[0]!.authorization).toContain(`Credential=${KEY_ID}/`);

    s3.status = 403;
    const refused = await data<{ ok: boolean; status: number | null; message: string }>(
      await call('POST', `/api/v1/export-destinations/${created.id}/test`, {
        cookie: owner.cookie,
      }),
    );
    expect(refused).toMatchObject({ ok: false, status: 403 });
    expect(refused.message).toContain('AccessDenied');
  });

  it('is a paid feature with a per-plan limit', async () => {
    const free = await freshFactor(await signIn());
    const freeChannel = (await createChannel(free)).id;
    const res = await call('POST', `/api/v1/channels/${freeChannel}/export-destinations`, {
      cookie: free.cookie,
      body: destinationBody(),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('plan_required');

    await env.DB.prepare("UPDATE workspaces SET plan = 'pro' WHERE id = ?1")
      .bind(free.workspaceId)
      .run();
    for (let i = 0; i < 3; i++) {
      expect(
        (
          await call('POST', `/api/v1/channels/${freeChannel}/export-destinations`, {
            cookie: free.cookie,
            body: destinationBody(),
          })
        ).status,
      ).toBe(201);
    }
    const over = await call('POST', `/api/v1/channels/${freeChannel}/export-destinations`, {
      cookie: free.cookie,
      body: destinationBody(),
    });
    expect(over.status).toBe(409);
  });

  it('keeps to the plan limit when many destinations are added at once', async () => {
    const s = await freshFactor(await signIn());
    const channel = (await createChannel(s)).id;
    await env.DB.prepare("UPDATE workspaces SET plan = 'pro' WHERE id = ?1")
      .bind(s.workspaceId)
      .run();
    const path = `/api/v1/channels/${channel}/export-destinations`;
    // The test runtime runs the first request of a burst on its own, so a read goes first and
    // the creates start together.
    const [, ...results] = await Promise.all([
      call('GET', path, { cookie: s.cookie }),
      ...Array.from({ length: 12 }, () =>
        call('POST', path, { cookie: s.cookie, body: destinationBody() }),
      ),
    ]);
    const rows = await env.DB.prepare(
      'SELECT count(*) AS n FROM export_destinations WHERE workspace_id = ?1',
    )
      .bind(s.workspaceId)
      .first<{ n: number }>();
    expect({
      added: results.filter((res) => res.status === 201).length,
      refused: results.filter((res) => res.status === 409).length,
      rows: rows?.n,
    }).toEqual({ added: 3, refused: 9, rows: 3 });
  });

  it('removes a destination', async () => {
    const created = await addDestination();
    expect(
      (await call('DELETE', `/api/v1/export-destinations/${created.id}`, { cookie: owner.cookie }))
        .status,
    ).toBe(204);
    expect(
      (
        await call('POST', `/api/v1/export-destinations/${created.id}/test`, {
          cookie: owner.cookie,
        })
      ).status,
    ).toBe(404);
  });
});

// ---- Role matrix and tenancy ----------------------------------------------------------------

interface RouteCase {
  name: string;
  minimum: SeatRole;
  request: (session: Session) => Promise<Response>;
}

const ROUTES: RouteCase[] = [
  {
    name: 'list requests',
    minimum: 'admin',
    request: (s) => call('GET', requestsPath(), { cookie: s.cookie }),
  },
  {
    name: 'read a request',
    minimum: 'admin',
    request: async (s) =>
      call('GET', `${requestsPath()}/${(await fileRequest('export')).id}`, { cookie: s.cookie }),
  },
  {
    name: 'file a request',
    minimum: 'admin',
    request: async (s) =>
      call('POST', requestsPath(), {
        cookie: s.cookie,
        body: { email: (await addMember(owner, channelId)).email, kind: 'export' },
      }),
  },
  {
    name: 'approve a request',
    minimum: 'admin',
    request: async (s) =>
      call('POST', `${requestsPath()}/${(await fileRequest('erase')).id}/approve`, {
        cookie: s.cookie,
        body: { confirm: 'erase' },
      }),
  },
  {
    name: 'reject a request',
    minimum: 'admin',
    request: async (s) =>
      call('POST', `${requestsPath()}/${(await fileRequest('export')).id}/reject`, {
        cookie: s.cookie,
        body: { note: 'No' },
      }),
  },
  {
    name: 'retry a request',
    minimum: 'admin',
    request: async (s) => {
      const request = await fileRequest('export');
      await env.DB.prepare("UPDATE dsr_requests SET status = 'failed' WHERE id = ?1")
        .bind(request.id)
        .run();
      return call('POST', `${requestsPath()}/${request.id}/retry`, { cookie: s.cookie });
    },
  },
  {
    name: 'download a finished export',
    minimum: 'admin',
    request: async (s) =>
      call('POST', `${requestsPath()}/${(await finishedExport()).id}/download`, {
        cookie: s.cookie,
      }),
  },
  {
    name: 'list export destinations',
    minimum: 'admin',
    request: (s) =>
      call('GET', `/api/v1/channels/${channelId}/export-destinations`, { cookie: s.cookie }),
  },
  {
    name: 'add an export destination',
    minimum: 'admin',
    request: (s) =>
      call('POST', `/api/v1/channels/${channelId}/export-destinations`, {
        cookie: s.cookie,
        body: destinationBody(),
      }),
  },
  {
    name: 'change an export destination',
    minimum: 'admin',
    request: async (s) =>
      call('PATCH', `/api/v1/export-destinations/${(await addDestination()).id}`, {
        cookie: s.cookie,
        body: { schedule: 'daily' },
      }),
  },
  {
    name: 'test an export destination',
    minimum: 'admin',
    request: async (s) =>
      call('POST', `/api/v1/export-destinations/${(await addDestination()).id}/test`, {
        cookie: s.cookie,
      }),
  },
  {
    name: 'remove an export destination',
    minimum: 'admin',
    request: async (s) =>
      call('DELETE', `/api/v1/export-destinations/${(await addDestination()).id}`, {
        cookie: s.cookie,
      }),
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

  it('a request id from another workspace is not found under this one', async () => {
    const theirs = await signIn();
    const theirChannel = (await createChannel(theirs)).id;
    const member = await addMember(theirs, theirChannel);
    const request = await data<DsrRequest>(
      await call('POST', `/api/v1/workspaces/${theirs.workspaceId}/privacy/requests`, {
        cookie: theirs.cookie,
        body: { email: member.email, kind: 'export' },
      }),
      201,
    );
    expect(
      (await call('GET', `${requestsPath()}/${request.id}`, { cookie: owner.cookie })).status,
    ).toBe(404);
    // A Channel from another workspace can't be named either.
    const res = await call('POST', requestsPath(), {
      cookie: owner.cookie,
      body: { email: member.email, kind: 'export', channelId: theirChannel },
    });
    expect(res.status).toBe(404);
  });

  it('signed-out requests get 401', async () => {
    for (const route of ROUTES) {
      const res = await route.request({ ...owner, cookie: '' });
      expect(res.status, route.name).toBe(401);
    }
  });
});
