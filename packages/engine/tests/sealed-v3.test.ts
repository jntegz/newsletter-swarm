// The row-bound sealed format the vault writes (fields.ts sealV3/openV3): a value opens only for
// its purpose and the row it was sealed for, under any key of the ring.
import { parseKeyring } from '@swarm/tokens';
import { describe, expect, it } from 'vitest';
import {
  encrypt,
  isSealedV3,
  openV3,
  resealWithCurrentKey,
  sealV3,
  sealedBinding,
  sealedKeyId,
  sealedPurposeV3,
} from '../src/fields';

const keys = parseKeyring(`k2:${'b'.repeat(40)},k1:${'a'.repeat(40)}`);
const old = parseKeyring(`k1:${'a'.repeat(40)}`);
const binding = sealedBinding({ w: 'ws_a', c: 'ch_a', m: 'mb_a', f: 'fd_a' });

describe('row-bound sealing (v3)', () => {
  it('round-trips, and names its purpose and key', async () => {
    const sealed = await sealV3(keys, 'member-field', binding, '"secret"');
    expect(sealed).toMatch(/^fv3\.member-field\.k2\.[\w-]+\.[\w-]+$/);
    expect(isSealedV3(sealed)).toBe(true);
    expect(sealedPurposeV3(sealed)).toBe('member-field');
    expect(sealedKeyId(sealed)).toBe('k2');
    expect(await openV3(keys, 'member-field', binding, sealed)).toBe('"secret"');
  });

  it('does not open for another row, purpose or tenant', async () => {
    const sealed = await sealV3(keys, 'member-field', binding, 'x');
    const otherMember = sealedBinding({ w: 'ws_a', c: 'ch_a', m: 'mb_b', f: 'fd_a' });
    const otherTenant = sealedBinding({ w: 'ws_b', c: 'ch_a', m: 'mb_a', f: 'fd_a' });
    expect(await openV3(keys, 'member-field', otherMember, sealed)).toBeNull();
    expect(await openV3(keys, 'member-field', otherTenant, sealed)).toBeNull();
    expect(await openV3(keys, 'dsr-address', binding, sealed)).toBeNull();
    // Renaming the purpose in the value does not help: it is in the key and the additional data.
    expect(
      await openV3(keys, 'dsr-address', binding, sealed.replace('member-field', 'dsr-address')),
    ).toBeNull();
  });

  it('opens with an older key of the ring, and not without the key', async () => {
    const sealed = await sealV3(old, 'totp', 'o:op_1', 'JBSWY3DP');
    expect(await openV3(keys, 'totp', 'o:op_1', sealed)).toBe('JBSWY3DP');
    expect(await openV3(parseKeyring(`k9:${'c'.repeat(40)}`), 'totp', 'o:op_1', sealed)).toBeNull();
  });

  it('refuses tampering and other formats', async () => {
    const sealed = await sealV3(keys, 'totp', 'o:op_1', 'JBSWY3DP');
    const parts = sealed.split('.');
    parts[4] = `${parts[4]?.slice(0, -2)}AA`;
    expect(await openV3(keys, 'totp', 'o:op_1', parts.join('.'))).toBeNull();
    expect(await openV3(keys, 'totp', 'o:op_1', await encrypt(keys, 'JBSWY3DP'))).toBeNull();
    expect(await openV3(keys, 'totp', 'o:op_1', 'fv3.totp.k2.x')).toBeNull();
  });

  it('refuses a bad purpose or an empty binding, and binding parts with separators', async () => {
    await expect(sealV3(keys, 'Bad Purpose', 'o:x', 'v')).rejects.toThrow(/purpose/);
    await expect(sealV3(keys, 'totp', '', 'v')).rejects.toThrow(/binding/);
    expect(() => sealedBinding({ w: 'a|c:b' })).toThrow(/binding part/);
    expect(() => sealedBinding({})).toThrow(/empty/);
    expect(sealedBinding({ kind: 'paypal', c: 'ch', w: 'ws' })).toBe('w:ws|c:ch|kind:paypal');
  });

  it('is left alone by the rotation re-seal, which cannot rebuild its binding', async () => {
    const sealed = await sealV3(old, 'totp', 'o:op_1', 'JBSWY3DP');
    expect(await resealWithCurrentKey(keys, sealed)).toBe('current');
  });
});
