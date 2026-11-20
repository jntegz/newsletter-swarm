import { InstallError } from '../ui';

interface ReleaseFile {
  path: string;
  size: number;
  sha256: string;
}

/** A release's files, each checked against the signed manifest as it is read. */
export interface Release {
  readonly version: string;
  readonly files: readonly ReleaseFile[];
  /**
   * How this release's workers sign links, from its signed manifest (`linkSigning`, written by
   * the release build from its own tree): v2 when they sign per family. A manifest without it is
   * v1. The setup never goes by its own build here: it installs whatever release it is given.
   */
  readonly linkSigning: 'v1' | 'v2';
  text(path: string): Promise<string>;
  bytes(path: string): Promise<Uint8Array>;
}

const fromBase64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

const sha256Hex = async (bytes: Uint8Array) =>
  hex(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));

async function signatureValid(text: string, signature: string, publicKeyPem: string) {
  const der = fromBase64(publicKeyPem.replace(/-----[^-]+-----|\s+/g, ''));
  const key = await crypto.subtle.importKey(
    'spki',
    der as Uint8Array<ArrayBuffer>,
    'Ed25519',
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    'Ed25519',
    key,
    fromBase64(signature.trim()) as Uint8Array<ArrayBuffer>,
    new TextEncoder().encode(text),
  );
}

/** A release as downloaded, with the sha256 of its manifest, which names it exactly. */
interface OpenedRelease extends Release {
  readonly digest: string;
  /** The id of the key that signed it, as the manifest names it and RELEASE_PUBLIC_KEY has it. */
  readonly keyId: string;
}

/** The manifest format release-bundle and release-sign write: it names its key and its build. */
const MANIFEST_FORMAT = 2;

/**
 * A public key's id: the sha256 of its SPKI bytes, in hex, as `pnpm release:sign` prints it. The
 * setup page shows it, so a key swapped in with its own RELEASE_URL doesn't look like the project's.
 */
export async function releaseKeyId(publicKeyPem: string): Promise<string> {
  const der = fromBase64(publicKeyPem.replace(/-----[^-]+-----|\s+/g, ''));
  return sha256Hex(der);
}

/** For a release, or the key that signed it, that has been withdrawn. */
function withdrawnRelease(release: { version: string }) {
  return new InstallError(
    `Release ${release.version}, or the key that signed it, has been withdrawn, so nothing more was installed.`,
    'See "If a release is withdrawn" in the setup guide: serve the replacement release at RELEASE_URL (with its public key, if the key changed), raise RELEASE_MIN_VERSION to it, and use the replacement on this page.',
  );
}

/** Splits RELEASE_WITHDRAWN-style text (commas, spaces or new lines) into entries. */
export function withdrawnList(...lists: (string | readonly string[] | undefined)[]): string[] {
  return lists
    .flatMap((list) => (typeof list === 'string' ? list.split(/[\s,]+/) : (list ?? [])))
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/** Plain http only from this computer, for a release served locally while developing. */
function insecureBase(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return true;
  }
  if (url.protocol === 'https:') return false;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return !(url.protocol === 'http:' && local);
}

/** A version as release-bundle makes them (`1.2.3` or `1.2.3-rc.1`), or null for anything else. */
function parseVersion(version: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/.exec(version);
  if (!match) return null;
  return { core: match.slice(1, 4).map(Number), pre: match[4]?.split('.') ?? [] };
}

/** Whether `version` comes before `minimum`, by semver's order. Anything unreadable does. */
function olderThan(version: string, minimum: NonNullable<ReturnType<typeof parseVersion>>) {
  const given = parseVersion(version);
  if (!given) return true;
  for (let i = 0; i < 3; i++) {
    const [a = 0, b = 0] = [given.core[i], minimum.core[i]];
    if (a !== b) return a < b;
  }
  // A pre-release comes before its release.
  if (!given.pre.length || !minimum.pre.length) return given.pre.length > minimum.pre.length;
  const numeric = (part: string) => /^\d+$/.test(part);
  for (let i = 0; i < Math.max(given.pre.length, minimum.pre.length); i++) {
    const [a, b] = [given.pre[i], minimum.pre[i]];
    if (a === b) continue;
    if (a === undefined || b === undefined) return a === undefined;
    if (numeric(a) && numeric(b)) return Number(a) < Number(b);
    if (numeric(a) !== numeric(b)) return numeric(a);
    return a < b;
  }
  return false;
}

/** For a release that isn't the one this install started with and keeps to. */
function differentRelease(served: { version: string }, expected: { version: string }) {
  return new InstallError(
    `RELEASE_URL now serves a different release (version ${served.version}) from the one this install started with (version ${expected.version}), so nothing more was installed.`,
    `Serve release ${expected.version} at RELEASE_URL again, then try this step again.`,
  );
}

/**
 * Reads a release over HTTP. Nothing is used until the manifest's signature has been checked.
 * Every release ever signed passes that check, so a caller that has already opened one passes
 * its digest and version as expected, and gets that release or an error, never an older or newer one.
 * The first open has nothing to expect, so a minimum version keeps it from older signed releases.
 * The manifest must name the configured key and be a clean build, and nothing withdrawn (by
 * version, manifest digest or key id) is opened, first time or later.
 */
export async function openRelease(options: {
  baseUrl: string;
  publicKeyPem: string;
  fetcher?: typeof fetch;
  expected?: { digest: string; version: string };
  minimumVersion?: string;
  /** Versions, manifest digests and key ids that must not be installed (see withdrawnList). */
  withdrawn?: readonly string[];
}): Promise<OpenedRelease> {
  const minimum =
    options.minimumVersion === undefined ? undefined : parseVersion(options.minimumVersion);
  if (minimum === null) {
    throw new InstallError(
      `RELEASE_MIN_VERSION is ${options.minimumVersion}, which is not a version, so nothing was installed.`,
      'Set RELEASE_MIN_VERSION to a release version such as 0.1.0, or leave it empty.',
    );
  }
  if (insecureBase(options.baseUrl)) {
    throw new InstallError(
      'The release address must start with https://, so nothing was installed.',
      'Set RELEASE_URL to the https:// address the release is served from.',
    );
  }
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const base = options.baseUrl.replace(/\/$/, '');
  const get = async (path: string) => {
    const response = await fetcher(`${base}/${path}`);
    if (!response.ok) {
      throw new InstallError(
        `Could not download ${path} of the release (${response.status}).`,
        'Try again in a few minutes.',
      );
    }
    return response;
  };
  const text = await (await get('manifest.json')).text();
  const signature = await (await get('manifest.sig')).text();
  let valid = false;
  try {
    valid = await signatureValid(text, signature, options.publicKeyPem);
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new InstallError(
      'The release failed its signature check, so nothing was installed.',
      'Someone may have changed the files. Report this to the Swarm project before trying again.',
    );
  }
  const manifest = JSON.parse(text) as {
    format?: number;
    version: string;
    commit?: string;
    build?: string;
    keyId?: string;
    linkSigning?: unknown;
    files: ReleaseFile[];
  };
  const digest = await sha256Hex(new TextEncoder().encode(text));
  const keyId = await releaseKeyId(options.publicKeyPem);
  const expected = options.expected;
  if (expected && digest !== expected.digest) throw differentRelease(manifest, expected);
  if (manifest.format !== MANIFEST_FORMAT || manifest.keyId !== keyId) {
    throw new InstallError(
      `The release does not name the key RELEASE_PUBLIC_KEY holds (manifest format ${manifest.format ?? 'none'}), so nothing was installed.`,
      'Serve a release signed with `pnpm release:sign`, and set RELEASE_PUBLIC_KEY to the key that signed it.',
    );
  }
  if (manifest.build !== 'clean' || !/^[0-9a-f]{40}$/.test(manifest.commit ?? '')) {
    throw new InstallError(
      'The release is not a clean build of a tagged commit, so nothing was installed.',
      'Serve a release built with `pnpm release:bundle` from its tag.',
    );
  }
  const withdrawn = new Set(options.withdrawn ?? []);
  if ([manifest.version, digest, keyId].some((entry) => withdrawn.has(entry.toLowerCase()))) {
    throw withdrawnRelease(manifest);
  }
  if (minimum && olderThan(manifest.version, minimum)) {
    throw new InstallError(
      `RELEASE_URL serves release ${manifest.version}, which is older than ${options.minimumVersion}, the oldest this setup page accepts, so nothing was installed.`,
      `Serve release ${options.minimumVersion} or newer at RELEASE_URL, then try again.`,
    );
  }
  const byPath = new Map(manifest.files.map((file) => [file.path, file]));
  const bytes = async (path: string) => {
    const file = byPath.get(path);
    if (!file) throw new InstallError(`The release has no file ${path}.`);
    const content = new Uint8Array(await (await get(path)).arrayBuffer());
    if ((await sha256Hex(content)) !== file.sha256) {
      throw new InstallError(
        `${path} does not match the signed release, so nothing more was installed.`,
        'Someone may have changed the files. Report this to the Swarm project before trying again.',
      );
    }
    return content;
  };
  return {
    digest,
    keyId,
    version: manifest.version,
    files: manifest.files,
    linkSigning: manifest.linkSigning === 'v2' ? 'v2' : 'v1',
    bytes,
    text: async (path) => new TextDecoder().decode(await bytes(path)),
  };
}
