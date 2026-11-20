// The parts of a release that need no build: the manifest of every file, the checks a build must
// pass before it may be signed, and the signature the Setup Worker checks before it installs
// anything. Building (release-bundle.mjs) and signing (release-sign.mjs) are separate commands, so
// no build tool ever runs in a process that holds the signing key.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';

export const sha256 = (content) => createHash('sha256').update(content).digest('hex');

/** Manifest format 2 adds the signing key's id, how the bundle was built, and its SBOMs. */
export const MANIFEST_FORMAT = 2;

/** Shortest passphrase the signing key may be encrypted under. */
export const MIN_PASSPHRASE = 16;

/** The SBOMs a release build writes into the bundle, so the signed manifest covers them. */
export const SBOM_FILES = {
  runtime: 'sbom.cdx.json',
  withBuildTools: 'sbom-build-tools.cdx.json',
};

/**
 * Stable text for a manifest: files sorted by path, so the signature doesn't depend on order.
 * `build` is "clean" for a release build (a fresh clone of a tagged commit and a frozen install)
 * and "trial" for anything else; only a clean build can be signed. `linkSigning` is "v2" when the
 * release's workers sign links with the per-link keyrings (linkSigningOf): the Setup Worker reads
 * it from the signed manifest, never from its own build. A manifest without it means v1.
 */
export function buildManifest({
  version,
  commit,
  files,
  build = 'trial',
  keyId,
  sbom,
  linkSigning,
}) {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : 1));
  return `${JSON.stringify(
    {
      format: MANIFEST_FORMAT,
      version,
      commit,
      build,
      ...(linkSigning === 'v2' ? { linkSigning } : {}),
      ...(keyId ? { keyId } : {}),
      ...(sbom ? { sbom } : {}),
      files: sorted,
    },
    null,
    2,
  )}\n`;
}

/**
 * Whether the source tree at `root` signs v2 links: LINK_V2_SIGNING_READY in @swarm/tokens. Read
 * from the text, so a build needs no TypeScript; anything but the plain declaration is an error.
 */
export function linkSigningOf(readFile) {
  const text = readFile('packages/tokens/src/links.ts');
  const match = /^export const LINK_V2_SIGNING_READY = (true|false);$/m.exec(text);
  if (!match)
    throw new Error('packages/tokens/src/links.ts has no LINK_V2_SIGNING_READY = true|false');
  return match[1] === 'true' ? 'v2' : 'v1';
}

/**
 * A public key's id: the sha256 of its SPKI (DER) bytes, in hex. The Setup Worker computes the
 * same value from RELEASE_PUBLIC_KEY, shows it before anything is installed, and refuses a
 * manifest that names another key.
 */
export function keyId(publicKey) {
  const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
  return sha256(key.export({ type: 'spki', format: 'der' }));
}

/** A new Ed25519 signing key, encrypted under `passphrase`, and its public half. */
export function newSigningKey(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
    throw new Error(`The passphrase must be at least ${MIN_PASSPHRASE} characters.`);
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { privateKey, publicKey, keyId: keyId(publicKey) };
}

const ENCRYPTED = /-----BEGIN ENCRYPTED PRIVATE KEY-----/;

/** Opens an encrypted signing key. A plain key file is refused: anyone who copies it can sign. */
function openSigningKey(privateKeyPem, passphrase) {
  if (!ENCRYPTED.test(privateKeyPem)) {
    throw new Error(
      'The signing key is not encrypted. Make a new one with `pnpm release:sign -- --new-key <path>`, which encrypts it under a passphrase.',
    );
  }
  try {
    return createPrivateKey({ key: privateKeyPem, format: 'pem', passphrase });
  } catch {
    throw new Error('The passphrase does not open this signing key.');
  }
}

/** Signs manifest text with an encrypted key. */
export function signManifest(text, privateKeyPem, passphrase) {
  return sign(null, Buffer.from(text), openSigningKey(privateKeyPem, passphrase)).toString(
    'base64',
  );
}

/** The id of the public half of an encrypted private key. */
export function keyIdOfPrivate(privateKeyPem, passphrase) {
  return keyId(createPublicKey(openSigningKey(privateKeyPem, passphrase)));
}

export function verifyManifest(text, signatureBase64, publicKeyPem) {
  return verify(
    null,
    Buffer.from(text),
    createPublicKey(publicKeyPem),
    Buffer.from(signatureBase64, 'base64'),
  );
}

/** A file's bytes against the manifest. Returns the paths that are missing, changed or extra. */
export function checkFiles(manifestText, readFile, listed) {
  const { files } = JSON.parse(manifestText);
  const known = new Set(files.map((f) => f.path));
  const problems = [];
  for (const file of files) {
    const content = readFile(file.path);
    if (content === null) problems.push(`missing: ${file.path}`);
    else if (sha256(content) !== file.sha256) problems.push(`changed: ${file.path}`);
  }
  for (const path of listed) if (!known.has(path)) problems.push(`extra: ${path}`);
  return problems;
}

/** The files a bundle directory may hold besides the ones its manifest lists. */
const MANIFEST_FILES = new Set(['manifest.json', 'manifest.sig']);

/**
 * Why a built bundle may not be signed, or an empty list. `tagCommit(version)` returns the commit
 * the tag v<version> points at in the repository, or null. A bundle may be signed only when it is
 * a clean build of exactly that commit, every file still matches, and both SBOMs are inside it.
 */
export function signingProblems({ manifestText, readFile, listed, tagCommit }) {
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return ['manifest.json is not JSON.'];
  }
  const problems = [];
  if (manifest.format !== MANIFEST_FORMAT) {
    problems.push(
      `The manifest is format ${manifest.format}, not ${MANIFEST_FORMAT}. Build again.`,
    );
  }
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(String(manifest.version))) {
    problems.push(`The manifest's version ${manifest.version} is not a release version.`);
  }
  if (manifest.build !== 'clean') {
    problems.push(
      'This is a trial build. Only a release build (a fresh clone of the tagged commit and a frozen install) can be signed.',
    );
  }
  if (!/^[0-9a-f]{40}$/.test(String(manifest.commit))) {
    problems.push(`The manifest's commit ${manifest.commit} is not a clean commit.`);
  } else {
    const tagged = tagCommit(manifest.version);
    if (tagged !== manifest.commit) {
      problems.push(
        tagged
          ? `Tag v${manifest.version} points at ${tagged}, not at the built commit ${manifest.commit}.`
          : `There is no tag v${manifest.version} in this repository.`,
      );
    }
  }
  if (manifest.keyId) problems.push('The manifest is already signed. Build again.');
  const paths = new Set((manifest.files ?? []).map((f) => f.path));
  for (const file of Object.values(SBOM_FILES)) {
    if (!paths.has(file)) problems.push(`The bundle has no ${file}.`);
  }
  if (problems.length) return problems;
  return checkFiles(
    manifestText,
    readFile,
    listed.filter((path) => !MANIFEST_FILES.has(path)),
  );
}

/** The manifest as signed: the build's own, with the signing key's id added. */
export function signedManifest(manifestText, id) {
  const manifest = JSON.parse(manifestText);
  return buildManifest({ ...manifest, keyId: id });
}

/** One line of the signing log: what was signed, when, with which key. No secret in it. */
export function signingRecord({ manifestText, id, signedAt = new Date(), signer }) {
  const { version, commit } = JSON.parse(manifestText);
  return `${JSON.stringify({
    signedAt: signedAt.toISOString(),
    version,
    commit,
    keyId: id,
    manifestSha256: sha256(manifestText),
    signer,
  })}\n`;
}
