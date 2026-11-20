import { describe, expect, it } from 'vitest';
import {
  CidrSchema,
  CreateApiKeySchema,
  apiRatePolicy,
  ipInCidr,
  normalizeCidr,
  parseCidr,
  parseIp,
} from '../src/index';

describe('IP addresses and ranges', () => {
  it('parses IPv4, IPv6 (compressed, mapped) and rejects nonsense', () => {
    expect(parseIp('192.0.2.1')).toEqual({ version: 4, value: 0xc0000201n });
    expect(parseIp('::1')).toEqual({ version: 6, value: 1n });
    expect(parseIp('2001:db8::')?.version).toBe(6);
    expect(parseIp('::ffff:192.0.2.1')).toEqual({ version: 4, value: 0xc0000201n });
    for (const bad of [
      '',
      '256.0.0.1',
      '1.2.3',
      '1.2.3.4.5',
      '2001:db8:::1',
      '1::2::3',
      'g::1',
      '01234::',
    ]) {
      expect(parseIp(bad), bad).toBeNull();
    }
  });

  it('parses ranges, requires zero host bits and normalises the spelling', () => {
    expect(parseCidr('10.0.0.0/8')).toEqual({ version: 4, base: 0x0a000000n, bits: 8 });
    expect(parseCidr('10.0.0.1/8')).toBeNull();
    expect(parseCidr('10.0.0.0/33')).toBeNull();
    expect(parseCidr('2001:db8::/129')).toBeNull();
    expect(normalizeCidr('203.0.113.7')).toBe('203.0.113.7/32');
    expect(normalizeCidr('2001:0DB8:0000:0000:0000:0000:0000:0000/32')).toBe('2001:db8::/32');
    expect(normalizeCidr('::/0')).toBe('::/0');
    expect(normalizeCidr('2001:db8:0:1:0:0:0:1')).toBe('2001:db8:0:1::1/128');
    expect(CidrSchema.parse(' 192.0.2.0/24 ')).toBe('192.0.2.0/24');
    expect(CidrSchema.safeParse('nope').success).toBe(false);
  });

  it('matches addresses against ranges of the same family', () => {
    expect(ipInCidr('192.0.2.200', '192.0.2.0/24')).toBe(true);
    expect(ipInCidr('192.0.3.1', '192.0.2.0/24')).toBe(false);
    expect(ipInCidr('8.8.8.8', '0.0.0.0/0')).toBe(true);
    expect(ipInCidr('2001:db8:1::5', '2001:db8::/32')).toBe(true);
    expect(ipInCidr('2001:db9::1', '2001:db8::/32')).toBe(false);
    expect(ipInCidr('::ffff:192.0.2.9', '192.0.2.0/24')).toBe(true);
    expect(ipInCidr('192.0.2.9', '::/0')).toBe(false);
    expect(ipInCidr('garbage', '0.0.0.0/0')).toBe(false);
  });
});

describe('key and rate policies', () => {
  it('dedupes scopes and ranges on create', () => {
    const parsed = CreateApiKeySchema.parse({
      name: ' Sync ',
      scopes: ['members:read', 'members:read'],
      ipAllowlist: ['192.0.2.1', '192.0.2.1/32'],
    });
    expect(parsed).toMatchObject({
      name: 'Sync',
      scopes: ['members:read'],
      ipAllowlist: ['192.0.2.1/32'],
    });
  });

  it('takes the lower of plan rate and key cap and scales the burst', () => {
    expect(apiRatePolicy('free', null)).toEqual({ perMinute: 60, burst: 30, capacity: 90 });
    expect(apiRatePolicy('pro', 120)).toEqual({ perMinute: 120, burst: 60, capacity: 180 });
    // A cap above the plan's rate changes nothing.
    expect(apiRatePolicy('free', 1000)).toEqual({ perMinute: 60, burst: 30, capacity: 90 });
    expect(apiRatePolicy('enterprise', 2)).toEqual({ perMinute: 2, burst: 1, capacity: 3 });
  });
});
