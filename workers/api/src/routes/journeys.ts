// Signup Journeys (flag signup_journeys): up to three steps shown after subscribing, with A/B
// variants. Viewers read journeys and stats; editors create, edit, go live, pause and promote a
// winning variant. The capture worker shows them (routes/journey.ts there).
//
// Steps: ask (a question from one of this Channel's Asks; flag reader_survey_on_subscribe),
// recommendations (flag partner_exchange; the publication's own Partner Picks),
// upsell (a paid Membership level of this Channel, or the plans page), welcome (flag
// welcome_page; a "No thanks" opt-out).
import { createRoute, z } from '@hono/zod-openapi';
import { all, first, isUniqueViolation, toIso } from '@swarm/db';
import {
  CreateSignupJourneySchema,
  PromoteSignupJourneySchema,
  SignupJourneySchema,
  SignupJourneyStatsSchema,
  SignupJourneyVariantsSchema,
  UpdateSignupJourneySchema,
  idPattern,
  newId,
  type SeatRole,
  type SignupJourney,
  type SignupJourneyStatus,
  type SignupJourneyVariants,
} from '@swarm/domain';
import type { ChannelAccess } from '@swarm/db';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { createRouter, env, type AppContext } from '../lib/context';
import { errors, idParam, jsonBody, noContent, ok } from '../lib/openapi';
import { audit, flagEnabled, requireFlag } from '../lib/site';

export const journeys = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const journeyParam = idParam('journeyId', idPattern('signupJourney'));
const DISABLED = 'Signup Journeys are not available.';
const MAX_JOURNEYS = 50;

interface JourneyRow {
  id: string;
  channel_id: string;
  name: string;
  status: SignupJourneyStatus;
  form_id: string | null;
  variants_json: string;
  winner_key: string | null;
  created_at: number;
  updated_at: number;
}

const COLUMNS =
  'id, channel_id, name, status, form_id, variants_json, winner_key, created_at, updated_at';

function toJourney(row: JourneyRow): SignupJourney {
  const parsed = SignupJourneyVariantsSchema.safeParse(JSON.parse(row.variants_json));
  return {
    id: row.id,
    channelId: row.channel_id,
    name: row.name,
    status: row.status,
    formId: row.form_id,
    variants: parsed.success ? parsed.data : [],
    winnerKey: row.winner_key,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

async function requireJourney(c: AppContext, journeyId: string, minimum: SeatRole) {
  const notFound = new ApiError('not_found', 'Signup Journey not found.');
  const row = await first<JourneyRow>(
    env(c).DB,
    `SELECT ${COLUMNS} FROM signup_journeys WHERE id = ?1 AND status <> 'archived'`,
    journeyId,
  );
  if (!row) throw notFound;
  let access;
  try {
    access = await requireChannel(c, row.channel_id, minimum);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'not_found') throw notFound;
    throw error;
  }
  await requireFlag(c, access, 'signup_journeys', DISABLED);
  return { row, access };
}

/**
 * Every id a journey refers to belongs to its Channel: the form, the Asks of ask steps (with at
 * least one choice or text question) and the levels of upsell steps. Step kinds behind a flag
 * need that flag.
 */
async function checkReferences(
  c: AppContext,
  access: Pick<ChannelAccess, 'workspaceId' | 'channelId'>,
  formId: string | null | undefined,
  variants: SignupJourneyVariants | undefined,
) {
  const db = env(c).DB;
  const channelId = access.channelId;
  if (formId) {
    const form = await first<{ id: string }>(
      db,
      'SELECT id FROM capture_forms WHERE id = ?1 AND channel_id = ?2 AND deleted_at IS NULL',
      formId,
      channelId,
    );
    if (!form) {
      throw new ApiError('invalid_input', 'That signup form is not in this publication.', [
        { path: 'formId', message: 'Unknown form' },
      ]);
    }
  }
  if (!variants) return;
  const steps = variants.flatMap((v) => v.steps);
  const kinds = new Set(steps.map((s) => s.kind));
  const gated = [
    ['ask', 'reader_survey_on_subscribe', 'Survey steps are not available.'],
    ['recommendations', 'partner_exchange', 'Recommendation steps are not available.'],
    ['welcome', 'welcome_page', 'Welcome pages are not available.'],
  ] as const;
  for (const [kind, flag, message] of gated) {
    if (kinds.has(kind) && !(await flagEnabled(c, access, flag))) {
      throw new ApiError('invalid_input', message, [{ path: 'variants', message }]);
    }
  }
  const askIds = steps.flatMap((s) => (s.kind === 'ask' ? [s.askId] : []));
  const levelIds = steps.flatMap((s) => (s.kind === 'upsell' && s.levelId ? [s.levelId] : []));
  if (askIds.length) {
    const found = await all<{ id: string }>(
      db,
      `SELECT id FROM asks WHERE channel_id = ?1 AND deleted_at IS NULL
          AND id IN (SELECT value FROM json_each(?2))`,
      channelId,
      JSON.stringify(askIds),
    );
    if (askIds.some((id) => !found.some((f) => f.id === id))) {
      throw new ApiError(
        'invalid_input',
        'A poll or survey step points at one that is not in this publication.',
        [{ path: 'variants', message: 'Unknown poll or survey' }],
      );
    }
  }
  if (levelIds.length) {
    const found = await all<{ id: string }>(
      db,
      `SELECT id FROM membership_levels WHERE channel_id = ?1
          AND id IN (SELECT value FROM json_each(?2))`,
      channelId,
      JSON.stringify(levelIds),
    );
    if (levelIds.some((id) => !found.some((f) => f.id === id))) {
      throw new ApiError(
        'invalid_input',
        'An upsell step points at a paid plan that is not in this publication.',
        [{ path: 'variants', message: 'Unknown paid plan' }],
      );
    }
  }
}

const liveConflict = () =>
  new ApiError(
    'conflict',
    'Another journey is already live for this form. Pause it first, then make this one live.',
  );

journeys.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/journeys',
    tags: ['Signup Journeys'],
    summary: 'Signup Journeys of a Channel',
    description: 'Needs the signup_journeys flag.',
    request: { params: channelParam },
    responses: {
      200: ok(z.array(SignupJourneySchema), 'Journeys'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const access = await requireChannel(c, channelId, 'viewer');
    await requireFlag(c, access, 'signup_journeys', DISABLED);
    const rows = await all<JourneyRow>(
      env(c).DB,
      `SELECT ${COLUMNS} FROM signup_journeys WHERE channel_id = ?1 AND status <> 'archived'
        ORDER BY created_at DESC`,
      channelId,
    );
    return c.json({ data: rows.map(toJourney) }, 200);
  },
);

journeys.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/channels/{channelId}/journeys',
    tags: ['Signup Journeys'],
    summary: 'Create a Signup Journey',
    description:
      'Editor role, signup_journeys flag. Starts as a draft. formId null covers every form without a journey of its own. Up to four variants with relative weights; up to three steps each.',
    request: { params: channelParam, body: jsonBody(CreateSignupJourneySchema) },
    responses: {
      201: ok(SignupJourneySchema, 'Created'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'editor');
    await requireFlag(c, access, 'signup_journeys', DISABLED);
    const db = env(c).DB;
    const count = await first<{ n: number }>(
      db,
      `SELECT count(*) AS n FROM signup_journeys WHERE channel_id = ?1 AND status <> 'archived'`,
      channelId,
    );
    if ((count?.n ?? 0) >= MAX_JOURNEYS) {
      throw new ApiError(
        'conflict',
        `A publication can have up to ${MAX_JOURNEYS} signup journeys.`,
      );
    }
    await checkReferences(c, access, input.formId, input.variants);
    const now = Date.now();
    const id = newId('signupJourney', now);
    const row = await first<JourneyRow>(
      db,
      `INSERT INTO signup_journeys (id, channel_id, name, form_id, variants_json, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7) RETURNING ${COLUMNS}`,
      id,
      channelId,
      input.name,
      input.formId ?? null,
      JSON.stringify(input.variants),
      access.auth.operatorId,
      now,
    );
    await audit(c, access, 'signup_journey.created', 'signup_journey', id);
    return c.json({ data: toJourney(row as JourneyRow) }, 201);
  },
);

journeys.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/journeys/{journeyId}',
    tags: ['Signup Journeys'],
    summary: 'One Signup Journey',
    request: { params: journeyParam },
    responses: { 200: ok(SignupJourneySchema, 'Journey'), ...errors('unauthorized', 'not_found') },
  }),
  async (c) => {
    const { row } = await requireJourney(c, c.req.valid('param').journeyId, 'viewer');
    return c.json({ data: toJourney(row) }, 200);
  },
);

journeys.openapi(
  createRoute({
    method: 'patch',
    path: '/api/v1/journeys/{journeyId}',
    tags: ['Signup Journeys'],
    summary: 'Edit, go live or pause a Signup Journey',
    description:
      'Editor role. One live journey per form (and one for all forms): going live while another is live answers 409. Changing the variants clears a promoted winner that no longer exists.',
    request: { params: journeyParam, body: jsonBody(UpdateSignupJourneySchema) },
    responses: {
      200: ok(SignupJourneySchema, 'Updated'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found', 'conflict'),
    },
  }),
  async (c) => {
    const { journeyId } = c.req.valid('param');
    const input = c.req.valid('json');
    const { row, access } = await requireJourney(c, journeyId, 'editor');
    await checkReferences(
      c,
      access,
      input.formId,
      // Going live re-checks the stored steps (flags may have changed since).
      input.variants ?? (input.status === 'live' ? toJourney(row).variants : undefined),
    );
    const variants = input.variants ? JSON.stringify(input.variants) : row.variants_json;
    const winner =
      row.winner_key && input.variants && !input.variants.some((v) => v.key === row.winner_key)
        ? null
        : row.winner_key;
    let updated: JourneyRow | null;
    try {
      updated = await first<JourneyRow>(
        env(c).DB,
        `UPDATE signup_journeys SET name = ?1, form_id = ?2, status = ?3, variants_json = ?4, winner_key = ?5, updated_at = ?6
          WHERE id = ?7 RETURNING ${COLUMNS}`,
        input.name ?? row.name,
        input.formId === undefined ? row.form_id : input.formId,
        input.status ?? row.status,
        variants,
        winner,
        Date.now(),
        journeyId,
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw liveConflict();
      throw error;
    }
    await audit(c, access, 'signup_journey.updated', 'signup_journey', journeyId, {
      fields: Object.keys(input),
      ...(input.status ? { status: input.status } : {}),
    });
    return c.json({ data: toJourney(updated as JourneyRow) }, 200);
  },
);

journeys.openapi(
  createRoute({
    method: 'delete',
    path: '/api/v1/journeys/{journeyId}',
    tags: ['Signup Journeys'],
    summary: 'Archive a Signup Journey',
    description: 'Editor role. It stops showing at once; its stats are kept.',
    request: { params: journeyParam },
    responses: { 204: noContent, ...errors('unauthorized', 'forbidden', 'not_found') },
  }),
  async (c) => {
    const { journeyId } = c.req.valid('param');
    const { access } = await requireJourney(c, journeyId, 'editor');
    await env(c)
      .DB.prepare(`UPDATE signup_journeys SET status = 'archived', updated_at = ?1 WHERE id = ?2`)
      .bind(Date.now(), journeyId)
      .run();
    await audit(c, access, 'signup_journey.archived', 'signup_journey', journeyId);
    return c.body(null, 204);
  },
);

journeys.openapi(
  createRoute({
    method: 'post',
    path: '/api/v1/journeys/{journeyId}/promote',
    tags: ['Signup Journeys'],
    summary: 'Promote the winning variant',
    description: 'Editor role. Every new Member gets this variant from now on; stats are kept.',
    request: { params: journeyParam, body: jsonBody(PromoteSignupJourneySchema) },
    responses: {
      200: ok(SignupJourneySchema, 'Promoted'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { journeyId } = c.req.valid('param');
    const { variant } = c.req.valid('json');
    const { row, access } = await requireJourney(c, journeyId, 'editor');
    if (!toJourney(row).variants.some((v) => v.key === variant)) {
      throw new ApiError('invalid_input', 'That variant is not in this journey.', [
        { path: 'variant', message: 'Unknown variant' },
      ]);
    }
    const updated = await first<JourneyRow>(
      env(c).DB,
      `UPDATE signup_journeys SET winner_key = ?1, updated_at = ?2 WHERE id = ?3 RETURNING ${COLUMNS}`,
      variant,
      Date.now(),
      journeyId,
    );
    await audit(c, access, 'signup_journey.promoted', 'signup_journey', journeyId, { variant });
    return c.json({ data: toJourney(updated as JourneyRow) }, 200);
  },
);

journeys.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/journeys/{journeyId}/stats',
    tags: ['Signup Journeys'],
    summary: 'Views, completions and skips per variant and step',
    request: {
      params: journeyParam,
      query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
    },
    responses: {
      200: ok(SignupJourneyStatsSchema, 'Stats'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { journeyId } = c.req.valid('param');
    const { days } = c.req.valid('query');
    const { row } = await requireJourney(c, journeyId, 'viewer');
    const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const rows = await all<{
      day: string;
      variant_key: string;
      step: number;
      views: number;
      completions: number;
      skips: number;
    }>(
      env(c).DB,
      `SELECT day, variant_key, step, views, completions, skips FROM signup_journey_daily
        WHERE journey_id = ?1 AND day >= ?2 ORDER BY day, variant_key, step`,
      journeyId,
      since,
    );
    const keys = [
      ...new Set([...toJourney(row).variants.map((v) => v.key), ...rows.map((r) => r.variant_key)]),
    ];
    const variants = keys.map((key) => {
      const mine = rows.filter((r) => r.variant_key === key);
      const steps = [0, 1, 2]
        .map((step) => {
          const at = mine.filter((r) => r.step === step);
          return {
            step,
            views: at.reduce((s, r) => s + r.views, 0),
            completions: at.reduce((s, r) => s + r.completions, 0),
            skips: at.reduce((s, r) => s + r.skips, 0),
          };
        })
        .filter((s) => s.views || s.completions || s.skips);
      const first = steps[0];
      const last = steps[steps.length - 1];
      return {
        key,
        steps,
        completionRate:
          first && last && first.views
            ? Math.round((last.completions / first.views) * 10_000) / 10_000
            : null,
      };
    });
    return c.json(
      {
        data: {
          journeyId,
          days,
          variants,
          daily: rows.map((r) => ({
            day: r.day,
            variant: r.variant_key,
            step: r.step,
            views: r.views,
            completions: r.completions,
            skips: r.skips,
          })),
        },
      },
      200,
    );
  },
);
