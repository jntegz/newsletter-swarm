import { describe, expect, it } from 'vitest';
import { authenticatedDomains, isPlainEnvelopeSender } from '../src/auth-results';

/** Headers as an Email Worker gets them: repeated headers come back joined with ", ". */
const headers = (...values: string[]) => {
  const h = new Headers();
  for (const value of values) h.append('Authentication-Results', value);
  return h;
};

const CLOUDFLARE =
  'mx.cloudflare.net; dkim=pass header.d=google.com header.s=20230601 header.b=abc; ' +
  'dmarc=pass header.from=google.com policy.dmarc=reject; ' +
  'spf=pass (mx.cloudflare.net: domain of x@google.com designates 1.2.3.4 as permitted sender) ' +
  'smtp.mailfrom=x@google.com';

describe('authenticatedDomains', () => {
  it('reads the DKIM and SPF passes of the header Email Routing adds', () => {
    expect(authenticatedDomains(headers(CLOUDFLARE))).toEqual({
      spf: 'google.com',
      dkim: ['google.com'],
    });
  });

  it('authenticates nothing without the header, or when someone else wrote it', () => {
    expect(authenticatedDomains(new Headers())).toEqual({ dkim: [] });
    expect(authenticatedDomains(null)).toEqual({ dkim: [] });
    expect(
      authenticatedDomains(headers(CLOUDFLARE.replace('mx.cloudflare.net;', 'mx.google.com;'))),
    ).toEqual({ dkim: [] });
    expect(
      authenticatedDomains(
        headers(CLOUDFLARE.replace('mx.cloudflare.net;', 'mx.cloudflare.net.evil;')),
      ),
    ).toEqual({ dkim: [] });
  });

  it('reads only the first header: the sender can add any others', () => {
    const forged =
      'mx.cloudflare.net; dkim=pass header.d=google.com; spf=pass smtp.mailfrom=google.com';
    const real =
      'mx.cloudflare.net; dkim=fail header.d=google.com; spf=pass smtp.mailfrom=a@evil.test';
    expect(authenticatedDomains(headers(real, forged))).toEqual({ spf: 'evil.test', dkim: [] });
    // An unclosed comment or quote can't swallow the join into the next header.
    for (const mailfrom of ['(x@evil.test', '"x@evil.test', '"x@evil.test\\', '(x@evil.test\\']) {
      const tricked = `mx.cloudflare.net; spf=fail smtp.mailfrom=${mailfrom}`;
      expect(authenticatedDomains(headers(tricked, `) "; ${forged}`))).toEqual({ dkim: [] });
    }
  });

  it('counts only passes, each with its own domain', () => {
    const value =
      'mx.cloudflare.net; dkim=fail header.d=google.com; dkim=pass header.d=Mail.Example.COM.; ' +
      'dkim=neutral header.d=other.test; spf=softfail smtp.mailfrom=a@google.com; dmarc=fail';
    expect(authenticatedDomains(headers(value))).toEqual({ dkim: ['mail.example.com'] });
  });

  it('follows RFC 8601: case, comments, quoted strings, versions and spaces around =', () => {
    const value =
      'MX.Cloudflare.NET 1; DKIM/1 = PASS (good sig; really) header.d = "yahoo.com" ; ' +
      'spf=pass (sender (nested) ok) smtp.mailfrom=(quoted below)"odd.local"@BOUNCE.yahoo.com';
    expect(authenticatedDomains(headers(value))).toEqual({
      spf: 'bounce.yahoo.com',
      dkim: ['yahoo.com'],
    });
  });

  it('takes the HELO domain for SPF when there is no MAIL FROM, as for a bounce', () => {
    const value = 'mx.cloudflare.net; dkim=none; spf=pass smtp.helo=mx1.example.org';
    expect(authenticatedDomains(headers(value))).toEqual({ spf: 'mx1.example.org', dkim: [] });
  });

  it('authenticates nothing on a header without results, or a malformed one', () => {
    expect(authenticatedDomains(headers('mx.cloudflare.net; none'))).toEqual({ dkim: [] });
    expect(
      authenticatedDomains(headers('mx.cloudflare.net; dkim=pass (unclosed header.d=google.com')),
    ).toEqual({ dkim: [] });
    expect(
      authenticatedDomains(headers('mx.cloudflare.net; dkim=pass header.d=not_a_domain')),
    ).toEqual({ dkim: [] });
  });

  it('does not let a MAIL FROM echoed in a comment end it and add results of its own', () => {
    // Email Routing echoes the envelope sender, which the sender chooses, in the SPF comment
    // and in smtp.mailfrom. A ')' in a quoted local part must not close the comment.
    const echoed = (mailfrom: string) =>
      `mx.cloudflare.net; spf=pass (mx.cloudflare.net: domain of ${mailfrom} designates ` +
      `1.2.3.4 as permitted sender) smtp.mailfrom=${mailfrom}`;
    const reviewer =
      'mx.cloudflare.net; spf=pass (mx.cloudflare.net: domain of "a);dkim=pass header.d=google.com (b"@attacker.com designates 1.2.3.4 as permitted sender) smtp.mailfrom="a);dkim=pass header.d=google.com (b"@attacker.com';
    expect(authenticatedDomains(headers(reviewer))).toEqual({ dkim: [] });
    for (const mailfrom of [
      // The DMARC result's header.from, which the bounce rule and reporters care about.
      '"a);dmarc=pass header.from=google.com;dkim=pass header.d=google.com (b"@attacker.com',
      // Nested parentheses, and quoted-pairs around the closing quote.
      '"a)) (x);dkim=pass header.d=google.com ((b"@attacker.com',
      '"a\\");dkim=pass header.d=google.com (b"@attacker.com',
      '"a\\\\");dkim=pass header.d=google.com (b"@attacker.com',
      // Without quotes, if Email Routing accepts that.
      'a);dkim=pass header.d=google.com;x=(b)@attacker.com',
      'a)@attacker.com; dkim=pass header.d=google.com',
    ]) {
      expect(authenticatedDomains(headers(echoed(mailfrom))), mailfrom).toEqual({ dkim: [] });
    }
  });

  it('trusts nothing when the results are not in the shape Email Routing writes them', () => {
    // Email Routing writes its DKIM results first: one after its DMARC or SPF result was added.
    for (const value of [
      'mx.cloudflare.net; spf=pass smtp.mailfrom=a@evil.test; dkim=pass header.d=google.com',
      'mx.cloudflare.net; dmarc=fail header.from=evil.test; dkim=pass header.d=google.com',
      // A stray word outside a comment, a property given twice, an odd character in a value.
      'mx.cloudflare.net; dkim=pass header.d=google.com; spf=pass sender smtp.mailfrom=a@evil.test',
      'mx.cloudflare.net; dkim=pass header.d=evil.test header.d=google.com',
      'mx.cloudflare.net; dkim=pass header.d=google.com; spf=pass smtp.mailfrom="a b"@evil.test',
      'mx.cloudflare.net; dkim=pass header.d=google.com; spf=pass smtp.mailfrom=a<b@evil.test',
      'mx.cloudflare.net; spf=pass smtp.mailfrom=a@evil.test; spf=pass smtp.mailfrom=a@google.com',
      // header.d is a domain, not an address; header.i must be under it.
      'mx.cloudflare.net; dkim=pass header.d=x@google.com',
      'mx.cloudflare.net; dkim=pass header.d=evil.test header.i=@google.com',
    ]) {
      expect(authenticatedDomains(headers(value)), value).toEqual({ dkim: [] });
    }
    expect(
      authenticatedDomains(
        headers('mx.cloudflare.net; dkim=pass header.d=google.com header.i=@mail.google.com'),
      ),
    ).toEqual({ dkim: ['google.com'] });
  });
});

describe('isPlainEnvelopeSender', () => {
  it('accepts an ordinary or empty envelope sender, and nothing that could shape the header', () => {
    for (const from of ['', '<>', 'noreply-dmarc-support@google.com', 'bounces+a=b@x.example']) {
      expect(isPlainEnvelopeSender(from), from).toBe(true);
    }
    for (const from of [
      '"a"@x.test',
      'a(b@x.test',
      'a)b@x.test',
      'a;b@x.test',
      'a\\b@x.test',
      'a,b@x.test',
      'a b@x.test',
      'a\tb@x.test',
      'a\u0000b@x.test',
      'a\u007fb@x.test',
    ]) {
      expect(isPlainEnvelopeSender(from), JSON.stringify(from)).toBe(false);
    }
  });
});
