import { base64UrlEncode } from '@swarm/tokens';

export { ipPrefix, sha256Hex } from '@swarm/db';

/** A URL-safe random secret. 32 bytes = 256 bits. */
export function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base64UrlEncode(buffer);
}
