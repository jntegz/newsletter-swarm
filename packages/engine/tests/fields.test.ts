import { parseKeyring } from '@swarm/tokens';
import { describe, expect, it } from 'vitest';
import {
  FieldValueError,
  decrypt,
  encrypt,
  fromStored,
  normalizeFieldValue,
  toStored,
  type FieldDef,
} from '../src/fields';

const def = (type: FieldDef['type'], options: string[] = [], encrypted = false): FieldDef => ({
  key: 'f',
  type,
  options,
  encrypted,
});
const keys = parseKeyring(`k2:${'b'.repeat(40)},k1:${'a'.repeat(40)}`);

describe('normalizeFieldValue', () => {
  it('validates each type and normalises input', () => {
    expect(normalizeFieldValue(def('text'), '  hi  ')).toBe('hi');
    expect(normalizeFieldValue(def('number'), '42.5')).toBe(42.5);
    expect(normalizeFieldValue(def('boolean'), 'Yes')).toBe(true);
    expect(normalizeFieldValue(def('date'), '2026-02-28')).toBe('2026-02-28');
    expect(normalizeFieldValue(def('select', ['Weekly', 'Monthly']), 'weekly')).toBe('Weekly');
    expect(normalizeFieldValue(def('multi_select', ['A', 'B', 'C']), 'c, a')).toEqual(['A', 'C']);
    expect(normalizeFieldValue(def('text'), '')).toBeNull();
    expect(normalizeFieldValue(def('multi_select', ['A']), [])).toBeNull();
  });

  it('refuses values that do not fit the type', () => {
    for (const [field, value] of [
      [def('number'), 'abc'],
      [def('boolean'), 'maybe'],
      [def('date'), '2026-02-30'],
      [def('date'), '27/10/2026'],
      [def('select', ['A']), 'B'],
      [def('multi_select', ['A']), ['A', 'Z']],
      [def('text'), 42],
    ] as const) {
      expect(() => normalizeFieldValue(field, value), JSON.stringify(value)).toThrow(
        FieldValueError,
      );
    }
  });
});

describe('storage', () => {
  it('round-trips every type through its columns', async () => {
    const cases: [FieldDef, unknown][] = [
      [def('text'), 'hello'],
      [def('number'), 3],
      [def('boolean'), false],
      [def('date'), '2026-10-27'],
      [def('select', ['X']), 'X'],
      [def('multi_select', ['X', 'Y']), ['X', 'Y']],
    ];
    for (const [field, value] of cases) {
      const stored = await toStored(field, normalizeFieldValue(field, value));
      expect(await fromStored(field, stored!)).toEqual(value);
    }
  });

  it('refuses a sealed value whose key id is an inherited name', async () => {
    // Sealed under the source text of the function a plain object would return for that kid:
    // anyone can make one, so it must never decrypt.
    for (const kid of ['constructor', 'toString', 'valueOf']) {
      const known = String((Object.prototype as Record<string, unknown>)[kid]);
      const forged = await encrypt({ current: kid, keys: { [kid]: known } }, 'chosen');
      expect(await decrypt(keys, forged), kid).toBeNull();
    }
  });

  it('encrypts sensitive fields, never storing the value in clear', async () => {
    const field = def('text', [], true);
    const stored = await toStored(field, 'secret note', keys);
    expect(stored).toMatchObject({ value_text: null, value_num: null });
    expect(stored!.value_enc).toMatch(/^k2\./);
    expect(stored!.value_enc).not.toContain('secret');
    expect(await fromStored(field, stored!, keys)).toBe('secret note');
    await expect(toStored(field, 'x')).rejects.toThrow(/FIELD_KEYS/);
  });

  it('decrypts with an older key after rotation and rejects tampering', async () => {
    const old = parseKeyring(`k1:${'a'.repeat(40)}`);
    const sealed = await encrypt(old, 'hello');
    expect(await decrypt(keys, sealed)).toBe('hello');
    const [kid, iv, body] = sealed.split('.');
    expect(await decrypt(keys, `k2.${iv}.${body}`)).toBeNull();
    expect(await decrypt(keys, `${kid}.${iv}.${body!.slice(0, -2)}AA`)).toBeNull();
    expect(await decrypt(parseKeyring(`k9:${'c'.repeat(40)}`), sealed)).toBeNull();
  });
});
