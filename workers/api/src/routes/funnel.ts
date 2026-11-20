// Funnel Explorer (Phase 6): stage totals, conversion, a breakdown by one cut and a by-day series
// from funnel_daily. The rollups that fill it are in @swarm/engine (funnel.ts).
import { createRoute } from '@hono/zod-openapi';
import { all } from '@swarm/db';
import {
  FUNNEL_CUT_COLUMNS,
  FUNNEL_FREE_LOOKBACK_DAYS,
  FUNNEL_MAX_RANGE_DAYS,
  FUNNEL_STAGES,
  FUNNEL_STAGE_KEYS,
  FunnelQuerySchema,
  FunnelSchema,
  funnelLookbackDays,
  funnelRate,
  funnelRates,
  idPattern,
  type Funnel,
  type FunnelCounts,
} from '@swarm/domain';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { createRouter, env } from '../lib/context';
import { errors, idParam, ok } from '../lib/openapi';
import { planOf } from '../lib/site';

export const funnel = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));
const DAY_MS = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const SUMS = `coalesce(sum(visits), 0) AS visits, coalesce(sum(form_views), 0) AS form_views,
  coalesce(sum(subscribes), 0) AS subscribes, coalesce(sum(confirms), 0) AS confirms,
  coalesce(sum(first_opens), 0) AS first_opens, coalesce(sum(paid), 0) AS paid`;

interface SumRow {
  visits: number;
  form_views: number;
  subscribes: number;
  confirms: number;
  first_opens: number;
  paid: number;
}

const counts = (row: SumRow | undefined): FunnelCounts => ({
  visits: row?.visits ?? 0,
  formViews: row?.form_views ?? 0,
  subscribes: row?.subscribes ?? 0,
  confirms: row?.confirms ?? 0,
  firstOpens: row?.first_opens ?? 0,
  paid: row?.paid ?? 0,
});

const add = (a: FunnelCounts, b: FunnelCounts): FunnelCounts => ({
  visits: a.visits + b.visits,
  formViews: a.formViews + b.formViews,
  subscribes: a.subscribes + b.subscribes,
  confirms: a.confirms + b.confirms,
  firstOpens: a.firstOpens + b.firstOpens,
  paid: a.paid + b.paid,
});

const ZERO = counts(undefined);

funnel.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/analytics/funnel',
    tags: ['Funnel Explorer'],
    summary: 'Funnel Explorer',
    description: `First-party funnel by UTC day: visits → form views → subscribes → confirms → first opens → paid. Visits (unique visitors per day on the site) and form views (Capture Form loads) are anonymous counts; visits carry source and UTM tags, form views only the form. Subscribes, confirms, first opens (first human open of any Broadcast) and paid (first paid entitlement) count once per Member, on the day they happen, attributed to the Member's first touch (source, UTM), sign-up form and referring Champion; imported and operator-added Members are not funnel traffic. Rates are each stage over the previous one. \`cut\` picks the breakdown (top \`top\` values by subscribes, the rest summed as "other"); the filters are exact matches, '' = none. Defaults to the last 30 days. Lookback: ${FUNNEL_FREE_LOOKBACK_DAYS} days back from today on the free plan (an earlier \`from\` is moved forward and \`clamped\` is true; a range that ends before the lookback is 400), unlimited on paid plans; at most ${FUNNEL_MAX_RANGE_DAYS} days per request.`,
    request: { params: channelParam, query: FunnelQuerySchema },
    responses: {
      200: ok(FunnelSchema, 'Funnel'),
      ...errors('invalid_input', 'unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const query = c.req.valid('query');
    await requireChannel(c, channelId, 'viewer');
    const db = env(c).DB;
    const now = Date.now();
    const today = dayOf(now);
    const to = query.to ?? today;
    let from = query.from ?? dayOf(Date.parse(`${to}T00:00:00Z`) - 29 * DAY_MS);
    const valid = (day: string) => {
      const ms = Date.parse(`${day}T00:00:00Z`);
      return !Number.isNaN(ms) && dayOf(ms) === day;
    };
    if (!valid(from) || !valid(to)) {
      throw new ApiError('invalid_input', 'Use real dates such as 2026-10-27.');
    }
    if (from > to) {
      const message = 'The start day comes before the end day.';
      throw new ApiError('invalid_input', message, [{ path: 'from', message }]);
    }

    const lookbackDays = funnelLookbackDays(await planOf(db, channelId));
    let clamped = false;
    if (lookbackDays !== null) {
      const earliest = dayOf(Date.parse(`${today}T00:00:00Z`) - (lookbackDays - 1) * DAY_MS);
      if (to < earliest) {
        const message = `The free plan shows the last ${lookbackDays} days; upgrade for the full history.`;
        throw new ApiError('invalid_input', message, [{ path: 'to', message }]);
      }
      if (from < earliest) {
        from = earliest;
        clamped = true;
      }
    }
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);
    if ((end - start) / DAY_MS + 1 > FUNNEL_MAX_RANGE_DAYS) {
      const message = `Choose a range of up to ${FUNNEL_MAX_RANGE_DAYS} days.`;
      throw new ApiError('invalid_input', message, [{ path: 'from', message }]);
    }

    // ?1 channel, ?2 from, ?3 to, ?4–?9 filters (null = any).
    const where = `channel_id = ?1 AND day BETWEEN ?2 AND ?3
      AND (?4 IS NULL OR source = ?4) AND (?5 IS NULL OR utm_source = ?5)
      AND (?6 IS NULL OR utm_medium = ?6) AND (?7 IS NULL OR utm_campaign = ?7)
      AND (?8 IS NULL OR form_id = ?8) AND (?9 IS NULL OR champion_id = ?9)`;
    const params = [
      channelId,
      from,
      to,
      query.source ?? null,
      query.utmSource ?? null,
      query.utmMedium ?? null,
      query.utmCampaign ?? null,
      query.formId ?? null,
      query.championId ?? null,
    ];
    const column = FUNNEL_CUT_COLUMNS[query.cut];
    const [days, groups] = await Promise.all([
      all<SumRow & { day: string }>(
        db,
        `SELECT day, ${SUMS} FROM funnel_daily WHERE ${where} GROUP BY day ORDER BY day`,
        ...params,
      ),
      all<SumRow & { value: string }>(
        db,
        `SELECT ${column} AS value, ${SUMS} FROM funnel_daily WHERE ${where}
          GROUP BY ${column} ORDER BY subscribes DESC, visits DESC, form_views DESC, ${column}`,
        ...params,
      ),
    ]);

    const byDayMap = new Map(days.map((row) => [row.day, counts(row)]));
    const byDay: Funnel['byDay'] = [];
    let totals = ZERO;
    for (let ms = start; ms <= end; ms += DAY_MS) {
      const day = dayOf(ms);
      const row = byDayMap.get(day) ?? ZERO;
      totals = add(totals, row);
      byDay.push({ day, ...row });
    }

    const top = groups.slice(0, query.top);
    const rest = groups.slice(query.top);
    const labels = await labelsFor(
      db,
      channelId,
      query.cut,
      top.map((row) => row.value),
    );
    const breakdown: Funnel['breakdown'] = top.map((row) => {
      const rowCounts = counts(row);
      return {
        value: row.value,
        label: labels.get(row.value) ?? null,
        other: false,
        counts: rowCounts,
        rates: funnelRates(rowCounts),
      };
    });
    if (rest.length) {
      const other = rest.reduce((sum, row) => add(sum, counts(row)), ZERO);
      breakdown.push({
        value: null,
        label: null,
        other: true,
        counts: other,
        rates: funnelRates(other),
      });
    }

    const data: Funnel = {
      from,
      to,
      cut: query.cut,
      lookbackDays,
      clamped,
      stages: FUNNEL_STAGES.map((stage, i) => {
        const count = totals[FUNNEL_STAGE_KEYS[stage]];
        const previous = i > 0 ? totals[FUNNEL_STAGE_KEYS[FUNNEL_STAGES[i - 1]!]] : null;
        return {
          stage,
          count,
          fromPrevious: previous === null ? null : funnelRate(count, previous),
          fromVisits: funnelRate(count, totals.visits),
        };
      }),
      totals,
      rates: funnelRates(totals),
      breakdown,
      byDay,
    };
    return c.json({ data }, 200);
  },
);

/** Names for form and Champion ids, limited to this Channel. */
async function labelsFor(
  db: D1Database,
  channelId: string,
  cut: Funnel['cut'],
  values: string[],
): Promise<Map<string, string>> {
  const ids = values.filter(Boolean);
  if (!ids.length || (cut !== 'form' && cut !== 'champion')) return new Map();
  const rows = await all<{ id: string; label: string }>(
    db,
    cut === 'form'
      ? `SELECT id, name AS label FROM capture_forms
          WHERE channel_id = ?1 AND id IN (SELECT value FROM json_each(?2))`
      : `SELECT id, coalesce(nullif(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), ''), email) AS label
           FROM members WHERE channel_id = ?1 AND id IN (SELECT value FROM json_each(?2))`,
    channelId,
    JSON.stringify(ids),
  );
  return new Map(rows.map((row) => [row.id, row.label]));
}
