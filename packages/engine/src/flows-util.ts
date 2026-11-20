/** Small helpers for the Flows engine. */
import { sha256Hex } from '@swarm/db';

export const hexEncode = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * The A/B arm of a run at an ab_split node: the first 32 bits of SHA-256("<runId>:<nodeId>")
 * mod 100, below percentA → 'a'. Deterministic per run (a retried step takes the same arm), and
 * independent between two split nodes of one run.
 */
export async function abArm(runId: string, nodeId: string, percentA: number): Promise<'a' | 'b'> {
  const hex = await sha256Hex(`${runId}:${nodeId}`);
  const bucket = parseInt(hex.slice(0, 8), 16) % 100;
  return bucket < percentA ? 'a' : 'b';
}

export function parseJson<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/** Error text that fits flow_run_steps.error. */
export const errorText = (error: unknown) =>
  (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 1000);
