/**
 * Postmark webhooks. Postmark doesn't sign them, so Swarm gives it a long random password when it
 * creates the webhooks, and Postmark sends it back with HTTP Basic auth on every request.
 */

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/**
 * How long a Postmark event is remembered. Its requests carry no timestamp, so this outlasts
 * Postmark's retries and the 7-day soft bounce window: one event can never count three times.
 */
export const POSTMARK_EVENT_ID_LIFETIME_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * The key a Postmark event is applied once under: its bounce or complaint ID, or a digest of the
 * raw body for a record without one (so an identical request still counts as the same event).
 */
export async function postmarkEventKey(payload: unknown, raw: string): Promise<string> {
  const body = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const id = body.ID;
  if ((typeof id === 'number' && Number.isSafeInteger(id)) || (typeof id === 'string' && id)) {
    const type = typeof body.RecordType === 'string' ? body.RecordType : '';
    return `postmark:${type.slice(0, 40)}:${String(id).slice(0, 100)}`;
  }
  const hash = Array.from(await digest(raw), (b) => b.toString(16).padStart(2, '0')).join('');
  return `postmark:body:${hash}`;
}

/** Whether an Authorization header carries the password. The comparison takes constant time. */
export async function verifyPostmarkAuth(
  header: string | null | undefined,
  secret: string,
): Promise<boolean> {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header?.trim() ?? '');
  if (!match?.[1]) return false;
  let decoded: string;
  try {
    decoded = atob(match[1]);
  } catch {
    return false;
  }
  const colon = decoded.indexOf(':');
  if (colon === -1) return false;
  // Hashing first makes the lengths equal, so the loop says nothing about the secret.
  const [given, expected] = await Promise.all([digest(decoded.slice(colon + 1)), digest(secret)]);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= (given[i] ?? 0) ^ (expected[i] ?? 0);
  return diff === 0;
}
