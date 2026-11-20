/**
 * Signup Journeys (Phase 6, flag signup_journeys): up to three steps shown after a successful
 * subscribe. The capture worker serves them; the api edits journeys and reads their stats.
 *
 * - One live journey per (Channel, form); a journey with form_id NULL covers every form of the
 *   Channel without a live journey of its own.
 * - The variant is deterministic per Member: a hash of the journey and a keyed HMAC of the
 *   address (the same for a known and an unknown address, so it reveals nothing), weighted by the
 *   variants' weights. A promoted winner (winner_key) is shown to everyone.
 * - Daily counts per (journey, variant, step): views, completions, skips (signup_journey_daily).
 */
import {
  SignupJourneyVariantsSchema,
  type SignupJourneyStep,
  type SignupJourneyVariants,
} from '@swarm/domain';
import { first, run } from './db';
import { utcDay } from './ramp';

export interface LiveJourney {
  id: string;
  channelId: string;
  formId: string | null;
  variants: SignupJourneyVariants;
  winnerKey: string | null;
}

/** The live journey for a form: its own, else the Channel-wide one. */
export async function liveJourneyFor(
  db: D1Database,
  channelId: string,
  formId: string,
): Promise<LiveJourney | null> {
  const row = await first<{
    id: string;
    channel_id: string;
    form_id: string | null;
    variants_json: string;
    winner_key: string | null;
  }>(
    db,
    `SELECT id, channel_id, form_id, variants_json, winner_key FROM signup_journeys
      WHERE channel_id = ?1 AND status = 'live' AND (form_id = ?2 OR form_id IS NULL)
      ORDER BY form_id IS NULL LIMIT 1`,
    channelId,
    formId,
  );
  return row ? toLiveJourney(row) : null;
}

export async function loadJourney(db: D1Database, journeyId: string): Promise<LiveJourney | null> {
  const row = await first<{
    id: string;
    channel_id: string;
    form_id: string | null;
    variants_json: string;
    winner_key: string | null;
  }>(
    db,
    `SELECT id, channel_id, form_id, variants_json, winner_key FROM signup_journeys
      WHERE id = ?1 AND status = 'live'`,
    journeyId,
  );
  return row ? toLiveJourney(row) : null;
}

function toLiveJourney(row: {
  id: string;
  channel_id: string;
  form_id: string | null;
  variants_json: string;
  winner_key: string | null;
}): LiveJourney | null {
  const parsed = SignupJourneyVariantsSchema.safeParse(JSON.parse(row.variants_json));
  if (!parsed.success) return null;
  return {
    id: row.id,
    channelId: row.channel_id,
    formId: row.form_id,
    variants: parsed.data,
    winnerKey: row.winner_key,
  };
}

/**
 * The variant for a seed (an opaque per-Member string): the winner when there is one, else a
 * weighted pick from the first four bytes of SHA-256(journeyId:seed). Deterministic.
 */
export async function pickJourneyVariant(
  journey: Pick<LiveJourney, 'id' | 'variants' | 'winnerKey'>,
  seed: string,
): Promise<{ key: string; steps: SignupJourneyStep[] }> {
  const winner = journey.winnerKey
    ? journey.variants.find((v) => v.key === journey.winnerKey)
    : undefined;
  if (winner) return winner;
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${journey.id}:${seed}`)),
  );
  const n = ((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0;
  const total = journey.variants.reduce((sum, v) => sum + v.weight, 0);
  let point = n % total;
  for (const variant of journey.variants) {
    if (point < variant.weight) return variant;
    point -= variant.weight;
  }
  return journey.variants[0]!;
}

export type JourneyCounter = 'views' | 'completions' | 'skips';
const COUNTERS = new Set<JourneyCounter>(['views', 'completions', 'skips']);

export async function bumpJourneyDaily(
  db: D1Database,
  input: { journeyId: string; variant: string; step: number; counter: JourneyCounter },
  now = Date.now(),
): Promise<void> {
  if (!COUNTERS.has(input.counter)) throw new Error(`unknown counter ${input.counter}`);
  const column = input.counter;
  await run(
    db,
    `INSERT INTO signup_journey_daily (journey_id, variant_key, step, day, ${column}) VALUES (?1, ?2, ?3, ?4, 1)
     ON CONFLICT (journey_id, variant_key, step, day) DO UPDATE SET ${column} = ${column} + 1`,
    input.journeyId,
    input.variant,
    input.step,
    utcDay(now),
  );
}
