import { describe, expect, it } from 'vitest';
import { isDisposableAddress, isRoleAddress } from '../src/addresses';

describe('address checks', () => {
  it('flags disposable providers, including their subdomains, and nothing else', () => {
    expect(isDisposableAddress('a@mailinator.com')).toBe(true);
    expect(isDisposableAddress('a@x.MAILINATOR.com')).toBe(true);
    expect(isDisposableAddress('a@notmailinator.com')).toBe(false);
    expect(isDisposableAddress('a@example.org')).toBe(false);
  });

  it('flags role accounts, ignoring plus tags', () => {
    expect(isRoleAddress('info@example.org')).toBe(true);
    expect(isRoleAddress('Support+eu@example.org')).toBe(true);
    expect(isRoleAddress('ada@example.org')).toBe(false);
  });
});
