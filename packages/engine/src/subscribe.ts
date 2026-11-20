/**
 * Joining a Channel through a Capture Form (or the no-JS form post).
 *
 * The caller answers the visitor before this runs and the answer never depends on it, so the
 * response can't reveal whether an address is already on the list. What happens here does:
 *   new address        → a Member, pending with a confirmation (double opt-in) or active
 *   pending            → the confirmation is resent (rate limited)
 *   unsubscribed       → a "welcome back, confirm" email; only confirming brings them back
 *   active or paused   → nothing
 *   bounced, complained or suppressed → nothing
 *   erased (Privacy Center)  → nothing, ever: the address is kept only as a hash
 * Only a brand-new Member takes the submitted name, profile fields and referral, so a stranger
 * can't overwrite someone else's details by typing their address. Referrals are recorded by
 * champions.ts (pending, network prefix only, self-referrals refused). A form's Rosters are
 * joined by a new Member only, at single opt-in or at the confirm (docs/rosters.md).
 */
import type { AttributionInput, FieldValue, MemberStatus, StoredSource } from '@swarm/domain';
import { cleanRef, recordReferral, resolveReferrer } from './champions';
import { bumpFormDaily, sendConfirmation, type AudienceDeps } from './confirm';
import { consentForNewMemberStatement, recordConsent, type ConsentInput } from './consents';
import { first, newIdFor, run } from './db';
import { recordMemberEvent, recordMemberEvents } from './events';
import { storedValue, toStored, type FieldDef } from './fields';
import { isErasedAddress } from './privacy';
import { joinFormRosters } from './rosters';
import { isSuppressedFor } from './suppressions';
import { isPrivacyVault, type PrivacyKeys } from './vault-ports';

export interface SubmittedField {
  def: FieldDef & { id: string };
  /** Already normalised with normalizeFieldValue. */
  value: FieldValue;
}

export interface SubscribeInput {
  channelId: string;
  workspaceId: string;
  formId: string | null;
  /** Lowercased and validated. */
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  fields?: SubmittedField[];
  doubleOptIn: boolean;
  attribution?: AttributionInput;
  /** The referrer's champion_code (or, from older embeds, Member id). Validated here. */
  ref?: string | null;
  /** The visitor's address (cf-connecting-ip); only its /24 or /48 is stored, on a referral. */
  ip?: string | null;
  /** What the person was shown and agreed to; kept for a new, pending or returning Member. */
  consent?: Omit<ConsentInput, 'mustConfirm'>;
  /**
   * The id to give the Member if this sign-up creates one. The caller picks it before the
   * response so a Signup Journey token can name the row this sign-up adds, and nothing else.
   */
  memberId?: string;
}

export type SubscribeOutcome =
  'created_pending' | 'created_active' | 'resent' | 'returning' | 'rate_limited' | 'ignored';

const TOUCH = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;

const clip = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;

/**
 * Merges a sign-up's attribution into a Member's source: first-touch keys (UTMs, referrer,
 * first_url, ref) are kept once set; `current` and `current_url` always take the latest.
 */
export function mergeSource(
  existing: StoredSource,
  input: AttributionInput | undefined,
  extra: { formId: string | null; ref: string | null },
): StoredSource {
  const next: StoredSource = { ...existing };
  const first = input?.first ?? {};
  const current = input?.current ?? {};
  const keep = <K extends keyof StoredSource>(key: K, value: StoredSource[K] | undefined) => {
    if (next[key] === undefined && value !== undefined) next[key] = value;
  };
  for (const key of TOUCH) keep(key, clip(first[key], 200) ?? clip(current[key], 200));
  keep('referrer', clip(first.referrer, 2048) ?? clip(current.referrer, 2048));
  keep('first_url', clip(first.first_url, 2048) ?? clip(current.current_url, 2048));
  if (extra.ref) keep('ref', extra.ref);
  const latest: NonNullable<StoredSource['current']> = {};
  for (const key of TOUCH) {
    const value = clip(current[key], 200);
    if (value !== undefined) latest[key] = value;
  }
  const referrer = clip(current.referrer, 2048);
  if (referrer !== undefined) latest.referrer = referrer;
  if (Object.keys(latest).length) next.current = latest;
  const url = clip(current.current_url, 2048);
  if (url !== undefined) next.current_url = url;
  if (extra.formId) next.form_id = extra.formId;
  return next;
}

export interface SubscribeDeps extends AudienceDeps {
  /** Erasure markers: the vault (capture, site), or FIELD_KEYS in engine tests. */
  fieldKeys: PrivacyKeys;
  /**
   * Seals a sign-up's encrypted values for the Member it creates (@swarm/vault
   * sealSignupFields). Without it a form with an encrypted field can't be stored.
   */
  sealSignup?: (
    memberId: string,
    values: Record<string, FieldValue>,
  ) => Promise<Record<string, string>>;
}

export async function subscribe(
  deps: SubscribeDeps,
  input: SubscribeInput,
): Promise<{ outcome: SubscribeOutcome; memberId: string | null }> {
  const { db } = deps;
  const now = deps.now ? deps.now() : Date.now();
  const email = input.email.trim().toLowerCase();
  if (input.formId) await bumpFormDaily(db, input.formId, 'submissions', now);

  const suppressed = await isSuppressedFor(db, input.workspaceId, input.channelId, email);
  if (suppressed || (await isErasedAddress(db, input.workspaceId, email, deps.fieldKeys))) {
    return { outcome: 'ignored', memberId: null };
  }

  const ref = cleanRef(input.ref);
  const id = input.memberId ?? newIdFor('member', now);
  const status: MemberStatus = input.doubleOptIn ? 'pending' : 'active';
  const source = mergeSource({}, input.attribution, { formId: input.formId, ref });
  // ON CONFLICT keeps an existing Member untouched; two racing sign-ups create one row. The consent
  // record goes in the same batch, so a Member is never saved without it.
  const [inserted] = await db.batch<{ id: string }>([
    db
      .prepare(
        `INSERT INTO members (id, channel_id, email, first_name, last_name, status, source_json, form_id,
                          consent_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
     ON CONFLICT (channel_id, email) DO NOTHING RETURNING id`,
      )
      .bind(
        id,
        input.channelId,
        email,
        input.firstName?.trim().slice(0, 80) || null,
        input.lastName?.trim().slice(0, 80) || null,
        status,
        JSON.stringify(source),
        input.formId,
        // Single opt-in records consent at the form submission; double opt-in at the confirm.
        status === 'active' ? now : null,
        now,
      ),
    ...(input.consent
      ? [
          consentForNewMemberStatement(
            db,
            id,
            { ...input.consent, mustConfirm: input.doubleOptIn },
            now,
          ),
        ]
      : []),
  ]);
  const created = inserted?.results[0];

  if (created) {
    const statements: D1PreparedStatement[] = [];
    const fields = input.fields ?? [];
    const encrypted = fields.filter((f) => f.def.encrypted && f.value !== null);
    let sealed: Record<string, string> = {};
    if (encrypted.length) {
      if (deps.sealSignup) {
        sealed = await deps.sealSignup(
          id,
          Object.fromEntries(encrypted.map((f) => [f.def.key, f.value])),
        );
      } else if (!isPrivacyVault(deps.fieldKeys) && deps.fieldKeys) {
        for (const f of encrypted) {
          sealed[f.def.key] = (await toStored(f.def, f.value, deps.fieldKeys))?.value_enc as string;
        }
      } else {
        throw new Error('Encrypted profile fields need the vault');
      }
    }
    for (const field of fields) {
      const stored = storedValue(field.def, field.value, sealed[field.def.key]);
      if (!stored) continue;
      statements.push(
        db
          .prepare(
            `INSERT INTO member_field_values (member_id, field_id, value_text, value_num, value_enc, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
          )
          .bind(id, field.def.id, stored.value_text, stored.value_num, stored.value_enc, now),
      );
    }
    if (statements.length) await db.batch(statements);
    // Flow triggers (Phase 6): the join, the form submission and, for single opt-in, consent.
    await recordMemberEvents(
      db,
      [
        {
          type: 'member_joined',
          memberId: id,
          payload: { source: 'form', status, ...(input.formId ? { formId: input.formId } : {}) },
        },
        ...(input.formId
          ? [
              {
                type: 'form_submitted' as const,
                memberId: id,
                payload: { formId: input.formId, created: true },
              },
            ]
          : []),
        ...(status === 'active'
          ? [
              {
                type: 'confirmed' as const,
                memberId: id,
                payload: {
                  method: 'single_opt_in' as const,
                  ...(input.formId ? { formId: input.formId } : {}),
                },
              },
            ]
          : []),
      ],
      now,
    );
    const referrerId = await resolveReferrer(db, input.channelId, ref);
    if (referrerId) {
      await recordReferral(
        db,
        {
          channelId: input.channelId,
          referrerId,
          referredId: id,
          referredEmail: email,
          ip: input.ip ?? null,
        },
        now,
      );
    }
    if (status === 'active') {
      if (input.formId) {
        await bumpFormDaily(db, input.formId, 'confirmed', now);
        // Rosters (Phase 8): single opt-in joins the form's Rosters now; double opt-in on confirm.
        await joinFormRosters(db, id, input.formId, now);
      }
      return { outcome: 'created_active', memberId: id };
    }
    const sent = await sendConfirmation(deps, {
      memberId: id,
      kind: 'subscribe',
      formId: input.formId,
    });
    return { outcome: sent === 'rate_limited' ? 'rate_limited' : 'created_pending', memberId: id };
  }

  const existing = await first<{ id: string; status: MemberStatus; source_json: string }>(
    db,
    'SELECT id, status, source_json FROM members WHERE channel_id = ?1 AND email = ?2',
    input.channelId,
    email,
  );
  if (!existing) return { outcome: 'ignored', memberId: null };
  if (input.formId) {
    await recordMemberEvent(
      db,
      {
        type: 'form_submitted',
        memberId: existing.id,
        payload: { formId: input.formId, created: false },
      },
      now,
    );
  }

  switch (existing.status) {
    case 'pending': {
      // The same person trying again: refresh the latest touch, then resend.
      const merged = mergeSource(
        JSON.parse(existing.source_json) as StoredSource,
        input.attribution,
        { formId: input.formId, ref: null },
      );
      await run(
        db,
        'UPDATE members SET source_json = ?1, updated_at = ?2 WHERE id = ?3',
        JSON.stringify(merged),
        now,
        existing.id,
      );
      const sent = await sendConfirmation(deps, {
        memberId: existing.id,
        kind: 'subscribe',
        formId: input.formId,
      });
      // Only when a mail went out, so repeated posts for one address can't grow the record.
      if (sent === 'sent' && input.consent) {
        await recordConsent(db, existing.id, { ...input.consent, mustConfirm: true }, now);
      }
      return { outcome: sent === 'sent' ? 'resent' : 'rate_limited', memberId: existing.id };
    }
    case 'unsubscribed': {
      // Coming back needs the Member's own confirm, whatever the form's opt-in setting.
      const sent = await sendConfirmation(deps, {
        memberId: existing.id,
        kind: 'return',
        formId: input.formId,
      });
      if (sent === 'sent' && input.consent) {
        await recordConsent(db, existing.id, { ...input.consent, mustConfirm: true }, now);
      }
      return { outcome: sent === 'sent' ? 'returning' : 'rate_limited', memberId: existing.id };
    }
    default:
      return { outcome: 'ignored', memberId: existing.id };
  }
}
