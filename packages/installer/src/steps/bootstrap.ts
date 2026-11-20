import { randomBytes } from 'node:crypto';
import { appendAudit, sha256Hex } from '@swarm/db';
import { NEW_CHANNEL_SETTINGS, newId } from '@swarm/domain';
import { applyInstallDefaults } from '@swarm/flags/platform';
import { base64UrlEncode } from '@swarm/tokens';
import { asD1Database, type D1Executor, type Row } from '../d1';
import { database, save, type Ctx } from '../context';
import { hostnamesFor } from '../hostnames';
import { InstallError } from '../ui';
import { requireChoices } from './postdeploy';
import type { Step } from './step';

const SIGNIN_TTL_MS = 60 * 60 * 1000;

async function one(db: D1Executor, sql: string, ...params: unknown[]): Promise<Row | null> {
  const [result] = await db.run([{ sql, params }]);
  return result?.results[0] ?? null;
}

interface BootstrapResult {
  operatorId: string;
  workspaceId: string;
  channelId?: string;
  createdOperator: boolean;
  createdWorkspace: boolean;
  createdChannel: boolean;
  inviteOnly: 'set' | 'kept' | 'unavailable';
}

/** Phase 2 tables (migrations/0032_instance.sql). Older checkouts do not have them yet. */
async function hasInstanceTables(db: D1Executor): Promise<boolean> {
  const [tables] = await db.run([
    {
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('instance_admins', 'instance_settings')",
      params: [],
    },
  ]);
  return (tables?.results.length ?? 0) === 2;
}

/**
 * Closes sign-up before any worker is deployed: no `signup` row means open, and the owner only
 * exists after the deploy. updated_by stays NULL until bootstrapOwner claims the row. ON CONFLICT
 * DO NOTHING keeps a mode already chosen, so an owner who opened sign-up stays open.
 */
export async function closeSignup(db: D1Executor, now = Date.now()): Promise<void> {
  if (!(await hasInstanceTables(db))) return;
  await db.run([
    {
      sql: "INSERT INTO instance_settings (key, value, updated_by, updated_at) VALUES ('signup', 'invite_only', NULL, ?1) ON CONFLICT DO NOTHING",
      params: [now],
    },
  ]);
}

/**
 * Writes the features a new install starts with, as platform-scope rows, here and not in a
 * migration: dev, tests and a manual deploy keep "off by default". Only missing rows are written,
 * so a choice stored earlier (off is a row with enabled = 0) always stands.
 */
export function applyFeatureDefaults(db: D1Executor, now = Date.now()) {
  return applyInstallDefaults(asD1Database(db), { newId: () => newId('featureFlag'), now });
}

/** Both `pnpm swarm` (from runBootstrap) and `pnpm swarm update` run this. */
export async function runFeatureDefaults(ctx: Ctx) {
  const { added } = await ctx.ui.task(
    'Setting which features start on',
    () => applyFeatureDefaults(database(ctx)),
    (r) => (r.added.length ? `${r.added.length} added` : 'already there'),
  );
  if (added.includes('copilot')) {
    ctx.ui.info('Copilot starts off because it uses a paid AI service.');
  }
  if (added.length) {
    ctx.ui.info(
      'Change any feature under Settings > Instance, or with `pnpm swarm feature <key> on|off`.',
    );
  }
}

/**
 * Creates the owner exactly as the api's findOrCreateOperator would (workers/api/src/lib/signin.ts:
 * operator, workspace, owner seat, audit), then makes them instance admin and sets sign-up to
 * invite-only (claiming the row closeSignup wrote), and creates the first publication like
 * POST /workspaces/{id}/channels. Every write checks first, so a re-run changes nothing; a sign-up
 * mode the owner changed later is kept.
 */
export async function bootstrapOwner(
  db: D1Executor,
  input: {
    email: string;
    name: string;
    workspaceName: string;
    publication: { name: string; slug: string };
    /** The domain itself, when the publication's website lives there. */
    rootHostname?: string;
  },
  now = Date.now(),
): Promise<BootstrapResult> {
  const d1 = asD1Database(db);
  let createdOperator = false;
  let operatorId = (await one(db, 'SELECT id FROM operators WHERE email = ?1', input.email))?.id as
    string | undefined;
  if (!operatorId) {
    operatorId = newId('operator');
    await db.run([
      {
        sql: 'INSERT INTO operators (id, email, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)',
        params: [operatorId, input.email, input.name, now],
      },
    ]);
    createdOperator = true;
  } else {
    await db.run([
      {
        sql: 'UPDATE operators SET name = ?2, updated_at = ?3 WHERE id = ?1 AND name IS NULL',
        params: [operatorId, input.name, now],
      },
    ]);
  }

  let createdWorkspace = false;
  let workspaceId = (
    await one(
      db,
      `SELECT w.id FROM seats s JOIN workspaces w ON w.id = s.workspace_id
        WHERE s.operator_id = ?1 AND s.role = 'owner' ORDER BY w.created_at LIMIT 1`,
      operatorId,
    )
  )?.id as string | undefined;
  if (!workspaceId) {
    workspaceId = newId('workspace');
    await db.run([
      {
        sql: "INSERT INTO workspaces (id, name, plan, created_at, updated_at) VALUES (?1, ?2, 'enterprise', ?3, ?3)",
        params: [workspaceId, input.workspaceName.slice(0, 80), now],
      },
      {
        sql: "INSERT INTO seats (id, workspace_id, operator_id, role, created_at, updated_at) VALUES (?1, ?2, ?3, 'owner', ?4, ?4)",
        params: [newId('seat'), workspaceId, operatorId, now],
      },
    ]);
    createdWorkspace = true;
    await appendAudit(d1, {
      workspaceId,
      actorId: operatorId,
      action: 'workspace.created',
      targetType: 'workspace',
      targetId: workspaceId,
      metadata: { source: 'installer' },
    });
  }

  let inviteOnly: BootstrapResult['inviteOnly'] = 'unavailable';
  if (await hasInstanceTables(db)) {
    // The owner's own workspace may run website code on the install's domain and use its DeBounce
    // credits. Only these explicit rows grant that, never an owner seat (any owner can make a
    // teammate an owner), so they are written when this workspace is made. A new instance admin
    // row also writes them for the workspaces its operator made (migrations/0069_review_fixes.sql).
    const grants = createdWorkspace
      ? (['site_code_workspaces', 'email_check_workspaces'] as const).map((table) => ({
          sql: `INSERT INTO ${table} (workspace_id, allowed_by, created_at) VALUES (?1, ?2, ?3) ON CONFLICT (workspace_id) DO NOTHING`,
          params: [workspaceId, operatorId, now],
        }))
      : [];
    const [, setting, claimed] = await db.run([
      {
        sql: 'INSERT INTO instance_admins (operator_id, created_at) VALUES (?1, ?2) ON CONFLICT DO NOTHING',
        params: [operatorId, now],
      },
      {
        sql: "INSERT INTO instance_settings (key, value, updated_by, updated_at) VALUES ('signup', 'invite_only', ?1, ?2) ON CONFLICT DO NOTHING",
        params: [operatorId, now],
      },
      {
        sql: "UPDATE instance_settings SET updated_by = ?1, updated_at = ?2 WHERE key = 'signup' AND value = 'invite_only' AND updated_by IS NULL",
        params: [operatorId, now],
      },
      ...grants,
    ]);
    inviteOnly = (setting?.changes ?? 0) + (claimed?.changes ?? 0) > 0 ? 'set' : 'kept';
  }

  let createdChannel = false;
  const channel = await one(
    db,
    'SELECT id, workspace_id FROM channels WHERE slug = ?1',
    input.publication.slug,
  );
  let channelId = channel?.id as string | undefined;
  if (channel && channel.workspace_id !== workspaceId) channelId = undefined;
  if (!channel) {
    channelId = newId('channel');
    await db.run([
      {
        sql: `INSERT INTO channels (id, workspace_id, slug, name, description, branding_json, settings_json,
                created_at, updated_at)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?8, ?7, ?7)`,
        params: [
          channelId,
          workspaceId,
          input.publication.slug,
          input.publication.name.slice(0, 80),
          null,
          JSON.stringify({ accentColor: null, logoMediaId: null }),
          now,
          // Per-person tracking starts off (docs/privacy-controls.md).
          JSON.stringify(NEW_CHANNEL_SETTINGS),
        ],
      },
    ]);
    createdChannel = true;
    await appendAudit(d1, {
      workspaceId,
      actorId: operatorId,
      action: 'channel.created',
      targetType: 'channel',
      targetId: channelId,
      metadata: { slug: input.publication.slug, name: input.publication.name },
    });
  }

  if (channelId && input.rootHostname) {
    // The site and every link in an email already follow a Channel's primary hostname.
    await db.run([
      {
        sql: `INSERT INTO custom_hostnames (id, workspace_id, channel_id, hostname, role, status, is_primary, created_by, created_at, updated_at)
              VALUES (?1, ?2, ?3, ?4, 'web', 'active', 1, ?5, ?6, ?6)
              ON CONFLICT (hostname) DO NOTHING`,
        params: [
          newId('customHostname'),
          workspaceId,
          channelId,
          input.rootHostname,
          operatorId,
          now,
        ],
      },
    ]);
  }

  return {
    operatorId,
    workspaceId,
    ...(channelId ? { channelId } : {}),
    createdOperator,
    createdWorkspace,
    createdChannel,
    inviteOnly,
  };
}

/**
 * A one-time sign-in link: a quickpass_tokens row hashed exactly like POST /api/v1/auth/quickpass
 * (workers/api/src/routes/auth.ts), valid for 60 minutes. The dashboard's /sign-in/continue reads
 * the token from the fragment, so it never reaches a server log.
 */
export async function mintSignInLink(
  db: D1Executor,
  email: string,
  appOrigin: string,
  now = Date.now(),
) {
  const token = base64UrlEncode(new Uint8Array(randomBytes(32)));
  await db.run([
    {
      sql: `INSERT INTO quickpass_tokens (id, token_hash, email, ip_prefix, created_at, expires_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      params: [newId('quickpass'), await sha256Hex(token), email, null, now, now + SIGNIN_TTL_MS],
    },
  ]);
  const link = new URL('/sign-in/continue', appOrigin);
  link.hash = `token=${token}`;
  return { link: link.toString(), expiresAt: now + SIGNIN_TTL_MS };
}

async function runBootstrap(ctx: Ctx) {
  const choices = requireChoices(ctx);
  const db = database(ctx);
  const result = await ctx.ui.task(
    `Creating the owner account for ${choices.owner.email}`,
    () =>
      bootstrapOwner(db, {
        ...(choices.addresses?.publicationAtRoot && ctx.state.zone
          ? { rootHostname: ctx.state.zone.name }
          : {}),
        email: choices.owner.email,
        name: choices.owner.name,
        workspaceName: choices.publication.name,
        publication: choices.publication,
      }),
    (r) => (r.createdOperator || r.createdWorkspace ? 'done' : 'already there'),
  );
  ctx.ui.info(
    result.createdChannel
      ? `Created the publication ${choices.publication.name} (${choices.publication.slug}).`
      : result.channelId
        ? `The publication ${choices.publication.slug} is already there.`
        : `The address ${choices.publication.slug} belongs to another workspace; no publication was created.`,
  );
  if (result.inviteOnly === 'set')
    ctx.ui.info('Sign-up is now invite-only. You can change this under Settings > Instance.');
  if (result.inviteOnly === 'kept') ctx.ui.info('Kept the sign-up setting the owner chose.');
  if (result.inviteOnly === 'unavailable') {
    ctx.ui.warn(
      'This version of Swarm has no invite-only setting yet, so anyone who reaches the dashboard can sign up. Run `pnpm swarm update` once it is available.',
    );
  }
  ctx.state.bootstrap = {
    operatorId: result.operatorId,
    workspaceId: result.workspaceId,
    ...(result.channelId ? { channelId: result.channelId } : {}),
  };
  await save(ctx);
  await runFeatureDefaults(ctx);
}

export async function signInLink(ctx: Ctx): Promise<string> {
  const choices = requireChoices(ctx);
  if (!ctx.state.zone) throw new InstallError('No zone is selected.', 'Run `pnpm swarm` first.');
  const h = hostnamesFor(ctx.state.zone.name, ctx.env, ctx.state.choices?.addresses);
  const { link } = await ctx.ui.task('Creating a one-time sign-in link', () =>
    mintSignInLink(database(ctx), choices.owner.email, `https://${h.app}`),
  );
  return link;
}

export const bootstrap: Step = { id: 'bootstrap', title: 'Owner account', run: runBootstrap };
