/**
 * A website signup in steps. The address is saved at the first step, by the capture worker, as any
 * signup is. The reader then goes on to the site for their name and plan, carrying this token, so
 * the address never appears in a URL and someone who leaves early is still on the list.
 *
 * Token (purpose 'join', SIGNUP_KEYS, one day): the Channel, the form, the address and the id the
 * signup gives a Member it creates (both sealed), and the path of any Signup Journey to run
 * afterwards. The vault alone holds SIGNUP_KEYS and FIELD_KEYS: it mints the token for capture
 * (@swarm/vault mintJoinToken) and opens it for the site (openJoinToken). signJoinToken below is
 * the format from before the vault, which the vault still opens while legacy opening is on. Every address gets one, known or not. The name is written only to the Member
 * with that id, which exists only if this signup added the address, and only where none is set. A
 * known address keeps its own id and a Member added any other way gets another, so the token can't
 * be used to change someone else's details by typing their address into a form, however soon after
 * they joined.
 */
import type { Keyring } from '@swarm/tokens';
import { first } from './db';
import { encrypt } from './fields';
import type { LinkSigner } from './links';

const PURPOSE = 'join';
const LIFETIME_SECONDS = 24 * 60 * 60;
/** The signup finishes after its response, so the name can arrive first. */
const NAME_ATTEMPTS = 4;
const NAME_RETRY_MS = 500;

/** What a join token says (@swarm/vault openJoinToken). */
export interface JoinClaims {
  formId: string;
  email: string;
  /** The id of the Member this signup creates; null in a token from before it was carried. */
  memberId: string | null;
  /** The path of a Signup Journey on the capture origin, to run after the last step. */
  journey: string | null;
  issuedAt: number;
}

/**
 * A join token in the format from before the vault (claims sealed with FIELD_KEYS, signed with
 * the caller's links). Only tokens already in readers' hands are like this; tests build them.
 */
export async function signJoinToken(
  links: LinkSigner,
  fieldKeys: Keyring,
  input: {
    channelId: string;
    formId: string;
    email: string;
    memberId: string;
    journey: string | null;
  },
): Promise<string> {
  const [sealed, member] = await Promise.all([
    encrypt(fieldKeys, input.email.trim().toLowerCase()),
    encrypt(fieldKeys, input.memberId),
  ]);
  return links.sign(
    PURPOSE,
    {
      c: input.channelId,
      f: input.formId,
      x: sealed,
      m: member,
      ...(input.journey ? { j: input.journey } : {}),
    },
    { expiresInSeconds: LIFETIME_SECONDS },
  );
}

/**
 * Adds the name to the Member this signup created. Runs after the response, so neither the answer
 * nor its timing says whether the address was already on the list.
 */
export async function addJoinName(
  db: D1Database,
  input: {
    channelId: string;
    email: string;
    /** From the token; null (a token from before it was carried) writes nothing. */
    memberId: string | null;
    firstName: string | null;
    lastName: string | null;
  },
  options: { retryMs?: number } = {},
): Promise<boolean> {
  const firstName = input.firstName?.trim().slice(0, 80) || null;
  const lastName = input.lastName?.trim().slice(0, 80) || null;
  if (!input.memberId || (!firstName && !lastName)) return false;
  const retryMs = options.retryMs ?? NAME_RETRY_MS;
  for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryMs));
    const row = await first<{ id: string }>(
      db,
      `UPDATE members SET first_name = coalesce(first_name, ?1), last_name = coalesce(last_name, ?2),
              updated_at = ?3
        WHERE id = ?4 AND channel_id = ?5 AND email = ?6 RETURNING id`,
      firstName,
      lastName,
      Date.now(),
      input.memberId,
      input.channelId,
      input.email,
    );
    if (row) return true;
  }
  return false;
}
