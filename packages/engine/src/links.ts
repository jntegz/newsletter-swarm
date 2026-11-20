/**
 * Signed links, one keyring per family (@swarm/tokens families.ts, docs/security.md "Keys").
 *
 * A worker's link keys come from its env:
 * - the keyrings it holds: `<NAME>` for an HMAC family and for an Ed25519 family it signs,
 *   `<NAME>_VERIFY_KEYS` (public keys) for an Ed25519 family it only verifies;
 * - LINK_SIGNING_MODE and LINK_LEGACY_CUTOFF (@swarm/tokens linkModeFromEnv): v1 until the
 *   installer's second pass, then v2 since the cutoff;
 * - MEMBER_KEYS while v1 links may still arrive: it signs every moved family in v1 mode, and
 *   verifies v1 links issued before the cutoff for their family's window.
 *
 * Every missing key fails closed: signing or verifying a family whose keyring this worker does not
 * hold throws, and the env schemas require the keyrings each worker uses (linkKeyField).
 *
 * Member and goods links go through the minters below (MemberLinkMinter, GoodsLinkMinter): send
 * and jobs sign locally, the api, capture and site ask the vault (which alone holds those keys).
 */
import {
  checkKeyringText,
  familyOf,
  KEYRING_ALGS,
  linkModeFromEnv,
  ownKey,
  parseKeyring,
  parseSigningKeyring,
  parseVerifyKeyring,
  signLink,
  signToken,
  verifyKeysName,
  verifyLink,
  type FamilySpec,
  type Keyring,
  type KeyringName,
  type LinkMode,
  type LinkResult,
  type SigningKeyring,
  type VerifyKeyring,
} from '@swarm/tokens';
import { z } from 'zod';

export type { LinkMode, LinkResult };

/** Signs links of the families this worker signs. */
export interface LinkSigner {
  sign(
    purpose: string,
    claims: Record<string, unknown>,
    options?: { now?: number; expiresInSeconds?: number },
  ): Promise<string>;
}

/** Verifies links of the families this worker verifies, and v1 links within their window. */
export interface LinkVerifier {
  verify<T = Record<string, unknown>>(
    purpose: string,
    token: string,
    options?: { now?: number },
  ): Promise<LinkResult<T>>;
}

export interface LinkKeys extends LinkSigner, LinkVerifier {
  readonly mode: LinkMode;
  /**
   * The raw HMAC secret of a keyring, for keyed values that are no tokens (the challenge's answer
   * key, the journey variant seed, the signup reference): the current one by default, else the
   * one `from` a verified token names (a legacy token's kid is a MEMBER_KEYS kid). In v1 mode the
   * current one is MEMBER_KEYS', as before the move. Undefined when the key isn't held.
   */
  secret(keyring: 'CAPTURE_KEYS', from?: { kid: string; legacy: boolean }): string | undefined;
}

/** Mints Member Center links. Send and jobs sign locally; the api and capture ask the vault. */
export interface MemberLinkMinter {
  memberToken(
    member: { memberId: string; channelId: string },
    options?: { emailed?: true; now?: number },
  ): Promise<string>;
}

/** A minter that won't make a link for this Member here (the vault refused the evidence). */
export class MemberLinkRefused extends Error {
  constructor() {
    super('No Member Center link for this Member.');
    this.name = 'MemberLinkRefused';
  }
}

/** Mints goods links (library and order). The vault signs them for site and api. */
export interface GoodsLinkMinter {
  libraryToken(input: { channelId: string; orderId: string; now?: number }): Promise<string>;
  orderToken(input: { channelId: string; orderId: string; now?: number }): Promise<string>;
}

/** The keyrings whose families signed with MEMBER_KEYS before the move: in v1 mode they still do. */
const MOVED: ReadonlySet<KeyringName> = new Set<KeyringName>([
  'CONFIRM_KEYS',
  'CAPTURE_KEYS',
  'FORM_STAMP_KEYS',
  'SIGNUP_KEYS',
  'MEMBER_SIGNING_KEYS',
  'ASK_SIGNING_KEYS',
  'ASK_PAGE_SIGNING_KEYS',
  'DSR_EXPORT_SIGNING_KEYS',
  'GOODS_SIGNING_KEYS',
  'CHECKOUT_SIGNING_KEYS',
  'SITE_LINK_SIGNING_KEYS',
  'SPONSOR_REPORT_SIGNING_KEYS',
]);

/** Every secret name a link keyring can arrive under. */
export const LINK_SECRET_NAMES: readonly string[] = [...MOVED].flatMap((name) =>
  KEYRING_ALGS[name] === 'ed25519' ? [name, verifyKeysName(name)] : [name],
);

function movedFamily(purpose: string): FamilySpec {
  const spec = familyOf(purpose);
  if (!MOVED.has(spec.keyring)) {
    throw new Error(`"${purpose}" links keep their own v1 keyring (${spec.keyring})`);
  }
  return spec;
}

const missing = (name: string, what: string) =>
  new Error(`${name} is not set, so this worker can't ${what}`);

export function createLinkKeys(input: {
  mode: LinkMode;
  /** MEMBER_KEYS: signs in v1 mode, verifies v1 links within their window. */
  memberKeys?: Keyring | undefined;
  /** Keyring texts by secret name; names this worker doesn't hold are absent. */
  rings: Readonly<Record<string, string | undefined>>;
}): LinkKeys {
  const { mode, memberKeys, rings } = input;
  const signing = new Map<string, Promise<SigningKeyring>>();
  const verifying = new Map<string, Promise<VerifyKeyring>>();
  const text = (name: string) => (Object.hasOwn(rings, name) ? rings[name] : undefined);

  const signingRing = (spec: FamilySpec) => {
    let ring = signing.get(spec.keyring);
    if (!ring) {
      const value = text(spec.keyring);
      if (!value) throw missing(spec.keyring, `sign "${spec.purpose}" links`);
      ring = parseSigningKeyring(spec.keyring, value);
      signing.set(spec.keyring, ring);
    }
    return ring;
  };
  const verifyRing = (spec: FamilySpec) => {
    let ring = verifying.get(spec.keyring);
    if (!ring) {
      const name = spec.alg === 'ed25519' ? verifyKeysName(spec.keyring) : spec.keyring;
      const value = text(name);
      if (!value) throw missing(name, `verify "${spec.purpose}" links`);
      ring = parseVerifyKeyring(spec.keyring, value);
      verifying.set(spec.keyring, ring);
    }
    return ring;
  };

  /** The family's former ring, when this worker holds its verify keys (else none). */
  const formerRing = async (spec: FamilySpec): Promise<VerifyKeyring | null> => {
    if (!spec.formerKeyring) return null;
    const former = spec.formerKeyring;
    const name = KEYRING_ALGS[former] === 'ed25519' ? verifyKeysName(former) : former;
    const value = text(name);
    if (!value) return null;
    let ring = verifying.get(former);
    if (!ring) {
      ring = parseVerifyKeyring(former, value);
      verifying.set(former, ring);
    }
    return ring;
  };

  return {
    mode,
    async sign(purpose, claims, options = {}) {
      const spec = movedFamily(purpose);
      if (mode.signing === 'v1') {
        // Before the cutover every verifier still reads MEMBER_KEYS: links stay v1 until then.
        if (!memberKeys) throw missing('MEMBER_KEYS', `sign "${purpose}" links before the cutover`);
        const lifetime =
          options.expiresInSeconds ?? spec.legacy?.lifetimeSeconds ?? spec.maxLifetimeSeconds;
        if (lifetime === null) throw new Error(`"${purpose}" links must expire`);
        return signToken(memberKeys, purpose, claims, {
          expiresInSeconds: lifetime,
          ...(options.now === undefined ? {} : { now: options.now }),
        });
      }
      return signLink(purpose, await signingRing(spec), claims, options);
    },
    async verify<T>(purpose: string, token: string, options: { now?: number } = {}) {
      const spec = movedFamily(purpose);
      const former = await formerRing(spec);
      return verifyLink<T>(purpose, await verifyRing(spec), token, {
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(former ? { former } : {}),
        ...(memberKeys ? { legacy: { keyring: memberKeys, cutoffMs: mode.legacyCutoffMs } } : {}),
      });
    },
    secret(keyring, from) {
      const legacy = from ? from.legacy : mode.signing === 'v1';
      if (legacy) {
        return memberKeys && ownKey(memberKeys.keys, from?.kid ?? memberKeys.current);
      }
      const value = text(keyring);
      if (!value) return undefined;
      const ring = parseKeyring(value);
      return ownKey(ring.keys, from?.kid ?? ring.current);
    },
  };
}

// ---- Env ------------------------------------------------------------------------------------

const keyringValue = z.string().transform((value, ctx): Keyring => {
  try {
    return parseKeyring(value);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: (error as Error).message });
    return z.NEVER;
  }
});

/** A link keyring secret, checked as it is parsed (the keys themselves are imported on first use). */
export const linkKeyField = (secret: string) =>
  z.string().superRefine((value, ctx) => {
    try {
      checkKeyringText(secret, value);
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: (error as Error).message });
    }
  });

/** Fields for the link keyrings a worker holds, each required: a worker without one won't start. */
export function linkKeyFields<const N extends string>(...secrets: N[]) {
  return Object.fromEntries(secrets.map((secret) => [secret, linkKeyField(secret)])) as {
    [K in N]: ReturnType<typeof linkKeyField>;
  };
}

/** The mode vars and MEMBER_KEYS, for every worker that holds a link keyring. */
export const LinkEnvFields = {
  LINK_SIGNING_MODE: z.string().optional(),
  LINK_LEGACY_CUTOFF: z.string().optional(),
  /**
   * Legacy: the keyring every link family signed with before the cutover. Needed to sign in v1
   * mode; after the cutover it only verifies older links, and the installer removes it once the
   * last window this worker checks has closed.
   */
  MEMBER_KEYS: keyringValue.optional(),
};

/**
 * Use inside a worker env schema's superRefine. The mode must be set (a worker refuses to start
 * rather than guess), and a worker that signs moved families needs MEMBER_KEYS in v1 mode.
 */
export function checkLinkEnv(
  env: {
    LINK_SIGNING_MODE?: string | undefined;
    LINK_LEGACY_CUTOFF?: string | undefined;
    MEMBER_KEYS?: Keyring | undefined;
  },
  ctx: z.RefinementCtx,
  options: { signs: boolean },
): void {
  let mode: LinkMode;
  try {
    mode = linkModeFromEnv(env);
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      path: ['LINK_SIGNING_MODE'],
      message: (error as Error).message,
    });
    return;
  }
  if (options.signs && mode.signing === 'v1' && !env.MEMBER_KEYS) {
    ctx.addIssue({
      code: 'custom',
      path: ['MEMBER_KEYS'],
      message: 'required while links are signed the old way (LINK_SIGNING_MODE=v1)',
    });
  }
}

type LinkEnv = {
  LINK_SIGNING_MODE?: string | undefined;
  LINK_LEGACY_CUTOFF?: string | undefined;
  MEMBER_KEYS?: Keyring | undefined;
};

const cache = new WeakMap<object, LinkKeys>();

/** The link keys of a parsed worker env, made once per env object (once per isolate). */
export function linksFor(env: LinkEnv): LinkKeys {
  let links = cache.get(env);
  if (!links) {
    const values = env as unknown as Record<string, unknown>;
    const rings: Record<string, string> = {};
    for (const name of LINK_SECRET_NAMES) {
      const value = values[name];
      if (typeof value === 'string' && value) rings[name] = value;
    }
    links = createLinkKeys({ mode: linkModeFromEnv(env), memberKeys: env.MEMBER_KEYS, rings });
    cache.set(env, links);
  }
  return links;
}

/**
 * Whether a verified link's tenant claim matches the row it names. A v1 link (from before the
 * cutover) carries none, so only the row decides; a v2 link always carries one (verifyLink).
 */
export const sameTenant = (claim: unknown, row: string): boolean =>
  claim === undefined || claim === row;
