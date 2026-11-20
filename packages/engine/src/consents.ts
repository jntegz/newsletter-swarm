/**
 * The consent record: what a person was shown and agreed to when they joined. It is kept beside
 * `members.consent_at` and `confirmed_at`, which only say when. Rows cascade with the Member, so
 * erasure removes them, and the Member's data export includes them.
 */
import { all, run } from './db';
import type { LinkSigner, LinkVerifier } from './links';

/**
 * The form stamp: a value the server signs into each form it renders (the capture frame, the
 * site's own forms), naming the form, its version and when it was rendered. A submission that
 * carries a valid stamp for its form records that version as presented (version_claimed 0,
 * stamped_at set), even when it is older than the one served now (a cached page). Without one,
 * as from an embed copied before stamps existed, the version stays a claim (0109). FORM_STAMP_KEYS
 * (HMAC), held by the capture and site workers, which both render forms, signs it.
 */
export const FORM_STAMP_PURPOSE = 'form-stamp';
/** A stamp outlives cached pages this long, then the version is a claim again. */
export const FORM_STAMP_DAYS = 90;

export const formStamp = (links: LinkSigner, formId: string, version: number, now = Date.now()) =>
  links.sign(
    FORM_STAMP_PURPOSE,
    { f: formId, v: version },
    { expiresInSeconds: FORM_STAMP_DAYS * 86_400, now },
  );

/** The version and issue time a valid stamp for `formId` names; null for anything else. */
export async function readFormStamp(
  links: LinkVerifier,
  stamp: string | null | undefined,
  formId: string,
  now = Date.now(),
): Promise<{ version: number; issuedAt: number } | null> {
  if (!stamp || stamp.length > 1024) return null;
  const read = await links.verify<{ f?: unknown; v?: unknown }>(FORM_STAMP_PURPOSE, stamp, { now });
  if (!read.ok) return null;
  const { f, v, iat } = read.payload;
  if (f !== formId || typeof v !== 'number' || !Number.isInteger(v) || v < 1) return null;
  return { version: v, issuedAt: iat * 1000 };
}

/** 'checkout': the address was given when paying; it says nothing was agreed beyond the purchase. */
export type ConsentSource = 'form' | 'operator' | 'api' | 'import' | 'checkout';

export interface ConsentInput {
  source: ConsentSource;
  formId?: string | null;
  formVersion?: number | null;
  /** The consent text as the person saw it; null when the form showed none. */
  wording?: string | null;
  /** Whether the box was ticked; null when there was no box. */
  ticked?: boolean | null;
  /** Whether this signup had to confirm by email. */
  mustConfirm: boolean;
  /** Imports: who attested (an operator id, or `key:<id>` / `oauth:<id>`). */
  attestedBy?: string | null;
  /**
   * The form version is only what the submission named (older than the one served now), so the
   * record can't show that wording was presented: a claim, not proof (0109).
   */
  versionClaimed?: boolean;
  /**
   * Form signups: the host the server verified (Turnstile's hostname for a pass solved for this
   * form, or the capture origin for Swarm's own question), and, apart from it, the site the
   * submission said it was on. The claimed one is never proof of where the form was (0116).
   */
  verifiedHost?: string | null;
  claimedOrigin?: string | null;
  /** When the server rendered the form, from a valid form stamp: the version is proven. */
  stampedAt?: number | null;
}

const consentValues = (memberId: string, input: ConsentInput, now: number) => [
  memberId,
  input.source,
  input.formId ?? null,
  input.formVersion ?? null,
  input.wording ?? null,
  input.ticked === null || input.ticked === undefined ? null : input.ticked ? 1 : 0,
  input.mustConfirm ? 1 : 0,
  input.attestedBy?.slice(0, 80) ?? null,
  now,
  input.versionClaimed ? 1 : 0,
  input.verifiedHost?.slice(0, 255) ?? null,
  input.claimedOrigin?.slice(0, 255) ?? null,
  input.stampedAt ?? null,
];

export const recordConsent = (db: D1Database, memberId: string, input: ConsentInput, now: number) =>
  run(
    db,
    `INSERT INTO member_consents (member_id, source, form_id, form_version, wording, ticked, must_confirm,
       attested_by, created_at, version_claimed, verified_host, claimed_origin, stamped_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    ...consentValues(memberId, input, now),
  );

/**
 * The record for a Member being inserted in the same batch. If that insert found the address taken,
 * no Member has this id and nothing is written. A retried sign-up reuses its Member id, so a Member
 * that already has a record (an earlier attempt that went through) gets no second one.
 */
export const consentForNewMemberStatement = (
  db: D1Database,
  memberId: string,
  input: ConsentInput,
  now: number,
) =>
  db
    .prepare(
      `INSERT INTO member_consents (member_id, source, form_id, form_version, wording, ticked, must_confirm,
         attested_by, created_at, version_claimed, verified_host, claimed_origin, stamped_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13 WHERE EXISTS (SELECT 1 FROM members WHERE id = ?1)
          AND NOT EXISTS (SELECT 1 FROM member_consents WHERE member_id = ?1)`,
    )
    .bind(...consentValues(memberId, input, now));

export interface ConsentRow {
  source: ConsentSource;
  form_id: string | null;
  form_version: number | null;
  wording: string | null;
  ticked: number | null;
  must_confirm: number;
  attested_by: string | null;
  created_at: number;
  version_claimed: number;
  verified_host: string | null;
  claimed_origin: string | null;
}

/** A Member's consent records, oldest first. */
export const memberConsents = (db: D1Database, memberId: string) =>
  all<ConsentRow>(
    db,
    `SELECT source, form_id, form_version, wording, ticked, must_confirm, attested_by, created_at,
            version_claimed, verified_host, claimed_origin
       FROM member_consents WHERE member_id = ?1 ORDER BY created_at, id`,
    memberId,
  );
