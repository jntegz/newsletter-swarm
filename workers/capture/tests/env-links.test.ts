// The link keys in capture's env fail closed: no mode, no keyring it uses, or a private key where
// only a public one belongs, and the worker refuses to start.
import { env } from 'cloudflare:test';
import { EnvError } from '@swarm/runtime';
import { describe, expect, it } from 'vitest';
import { parseCaptureEnv } from '../src/env';

const raw = env as unknown as Record<string, unknown>;
const parse = (changes: Record<string, unknown>) => () => {
  const copy: Record<string, unknown> = { ...raw, ...changes };
  for (const [key, value] of Object.entries(changes)) if (value === undefined) delete copy[key];
  return parseCaptureEnv(copy);
};

describe('capture link keys', () => {
  it('needs the signing mode, and MEMBER_KEYS only while links are signed the old way', () => {
    expect(parse({ LINK_SIGNING_MODE: undefined })).toThrow(EnvError);
    expect(parse({ LINK_SIGNING_MODE: 'v2', LINK_LEGACY_CUTOFF: undefined })).toThrow(
      /LINK_LEGACY_CUTOFF/,
    );
    expect(parse({ LINK_SIGNING_MODE: 'v1', MEMBER_KEYS: undefined })).toThrow(/MEMBER_KEYS/);
    // After the cutover the installer removes it once its windows close; the worker still runs.
    expect(parse({ MEMBER_KEYS: undefined })).not.toThrow();
  });

  it('needs every keyring it signs or checks with, and only public keys for what others sign', () => {
    for (const name of ['CONFIRM_KEYS', 'CAPTURE_KEYS', 'MEMBER_VERIFY_KEYS', 'ASK_VERIFY_KEYS']) {
      expect(parse({ [name]: undefined }), name).toThrow(EnvError);
    }
    // The private ask key where its public half belongs is refused, not used.
    const asks = JSON.parse(raw.TEST_LINK_KEYS as string) as Record<string, string>;
    expect(parse({ ASK_VERIFY_KEYS: asks.ASK_SIGNING_KEYS })).toThrow(/public key/);
  });
});
