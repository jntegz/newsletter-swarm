// What the Swarm project itself vouches for, shipped in the Setup Worker's source so an operator
// who deploys it from this repository inherits it, whatever RELEASE_URL serves. Both lists change
// only by a reviewed commit (docs/releasing.md).

/**
 * Key ids (sha256 of the SPKI public key, hex) of the project's release signing keys, as published
 * in SECURITY.md. The setup page says whether RELEASE_PUBLIC_KEY is one of them before anything is
 * installed. Empty until the first release is signed.
 */
export const PROJECT_RELEASE_KEYS: readonly string[] = [];

/**
 * Releases and keys the project has withdrawn: release versions (`0.1.0`), manifest digests or key
 * ids. The setup page refuses them, in addition to any the operator lists in RELEASE_WITHDRAWN.
 */
export const WITHDRAWN_RELEASES: readonly string[] = [];
