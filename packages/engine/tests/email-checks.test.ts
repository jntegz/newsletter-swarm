// Email checks (docs/email-verification.md): the DeBounce client against its fake, the results
// file parser, Swarm's free checks and the check-up finding. D1-backed parts are tested in the jobs
// and capture workers.
import {
  DEBOUNCE_SIGNUP_URL,
  EMAIL_CHECK_CODES,
  EMAIL_CHECK_DEFAULTS,
  colourOfCode,
  emailCheckSettings,
} from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { buildCheckup, type CheckupFacts } from '../src/checkup';
import {
  type DebounceError,
  debounceClient,
  debounceFor,
  debounceResultsLimit,
  fakeCode,
  fakeDebounceFetch,
  parseBulkResults,
  parseCode,
} from '../src/debounce';
import { localCheck, validForMs, type EmailCheckFacts } from '../src/email-checks';

describe('colours', () => {
  it('follows the owner’s mapping: disposable is orange, syntax and traps are red', () => {
    expect(colourOfCode(5)).toBe('green');
    for (const code of [3, 4, 7, 8] as const) expect(colourOfCode(code)).toBe('orange');
    for (const code of [1, 2, 6] as const) expect(colourOfCode(code)).toBe('red');
    expect(Object.keys(EMAIL_CHECK_CODES)).toHaveLength(8);
  });

  it('keeps the referral link in one place', () => {
    expect(DEBOUNCE_SIGNUP_URL).toBe('https://tegze.link/debounce');
  });
});

describe('settings', () => {
  it('fills missing keys with defaults and refuses what a background check can’t do', () => {
    expect(emailCheckSettings(null)).toEqual(EMAIL_CHECK_DEFAULTS);
    expect(emailCheckSettings({ signup: { red: 'confirm' } }).signup).toEqual({
      green: 'accept',
      orange: 'accept',
      red: 'confirm',
    });
    // "refuse" can't apply to someone already added by hand: the whole value falls back.
    expect(emailCheckSettings({ manual: { red: 'refuse' } })).toEqual(EMAIL_CHECK_DEFAULTS);
    expect(emailCheckSettings({ validMonths: 99 })).toEqual(EMAIL_CHECK_DEFAULTS);
    expect(validForMs(6)).toBe(180 * 86_400_000);
  });

  it('follows DeBounce’s advice for forms by default: only red is refused', () => {
    expect(EMAIL_CHECK_DEFAULTS.signup).toEqual({
      green: 'accept',
      orange: 'accept',
      red: 'refuse',
    });
  });
});

describe('Swarm’s free checks', () => {
  it('settles bad syntax, its disposable list and role addresses without DeBounce', () => {
    expect(localCheck('not an address')).toBe(1);
    expect(localCheck('someone@mailinator.com')).toBe(3);
    expect(localCheck('info@example.com')).toBe(8);
    expect(localCheck('jan@example.com')).toBeNull();
  });
});

describe('the DeBounce client', () => {
  it('reads a single result whose values are strings, as DeBounce’s examples send them', async () => {
    const client = debounceClient('k', fakeDebounceFetch());
    expect(await client.verify('jan@example.com')).toEqual({
      email: 'jan@example.com',
      code: 5,
      reason: 'Deliverable',
      didYouMean: null,
      sendTransactional: true,
    });
    const typo = await client.verify('jan@gmial.com');
    expect(typo).toMatchObject({ code: 6, didYouMean: 'jan@gmail.com', sendTransactional: false });
  });

  it('reads numbers and booleans too, as DeBounce’s schema has them', async () => {
    const fetcher = (async () =>
      new Response(
        JSON.stringify({
          debounce: { code: 4, result: 'Risky', reason: 'Accept-All', send_transactional: true },
          success: 1,
        }),
      )) as unknown as typeof fetch;
    expect(await debounceClient('k', fetcher).verify('a@b.example')).toMatchObject({
      code: 4,
      sendTransactional: true,
    });
  });

  it('turns DeBounce’s refusals into kinds a caller can act on', async () => {
    const answer = (status: number, body: unknown) =>
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const kind = async (fetcher: typeof fetch) =>
      debounceClient('k', fetcher)
        .verify('a@b.example')
        .then(
          () => null,
          (error: DebounceError) => error.kind,
        );
    expect(await kind(answer(401, { debounce: { error: 'Wrong API' }, success: '0' }))).toBe('key');
    expect(await kind(answer(402, { debounce: { error: 'Credits Low' }, success: '0' }))).toBe(
      'credits',
    );
    expect(await kind(answer(429, {}))).toBe('busy');
    expect(await kind(answer(503, {}))).toBe('unavailable');
    expect(
      await kind(
        answer(200, {
          debounce: { error: 'You have reached the maximum number of API bulk verify requests.' },
          success: '0',
        }),
      ),
    ).toBe('busy');
    const offline = (async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    expect(await kind(offline)).toBe('unavailable');
  });

  it('gives up within the time it was given', async () => {
    const client = debounceClient('k', fakeDebounceFetch({ delayMs: 2000 }));
    const started = Date.now();
    await expect(client.verify('a@b.example', { timeoutMs: 100 })).rejects.toMatchObject({
      kind: 'unavailable',
    });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('never asks for the extra-credit options and sends the key as DeBounce asks', async () => {
    const urls: string[] = [];
    const fetcher = fakeDebounceFetch();
    const spy = ((input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      return fetcher(input, init);
    }) as typeof fetch;
    await debounceClient('secret13chars', spy).verify('jan@example.com');
    const url = new URL(urls[0] as string);
    expect(url.origin + url.pathname).toBe('https://api.debounce.io/v1/');
    expect(url.searchParams.get('api')).toBe('secret13chars');
    expect(url.searchParams.has('append')).toBe(false);
    expect(url.searchParams.has('photo')).toBe(false);
  });

  it('runs a bulk list through the fake and reads its results file', async () => {
    const lists = new Map([
      ['https://app.example.com/list.csv', 'jan@example.com\nbad@example.com\ninfo@example.com\n'],
    ]);
    const credits = { left: 10 };
    const client = debounceClient(
      'k',
      fakeDebounceFetch({
        credits,
        readList: async (url) => lists.get(url) ?? null,
        processingPolls: 1,
      }),
    );
    const listId = await client.upload('https://app.example.com/list.csv');
    expect((await client.status(listId)).status).toBe('processing');
    const done = await client.status(listId);
    expect(done.status).toBe('completed');
    const rows = parseBulkResults(await client.download(done.downloadLink as string));
    expect(rows.map((r) => [r.email, r.code])).toEqual([
      ['jan@example.com', 5],
      ['bad@example.com', 6],
      ['info@example.com', 8],
    ]);
    expect(credits.left).toBe(7);
    expect(await client.balance()).toBe(7);
  });

  it('won’t open a results link that is not public https', async () => {
    const client = debounceClient('k', fakeDebounceFetch());
    await expect(client.download('http://127.0.0.1/x.csv')).rejects.toMatchObject({
      kind: 'invalid',
    });
  });

  it('re-checks every redirect of a results link and never contacts a refused host', async () => {
    const requests: { url: string; redirect: string | undefined }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), redirect: init?.redirect });
      const url = new URL(String(input));
      if (url.hostname === 'cdn.debounce.io') {
        return new Response(null, {
          status: 302,
          headers: {
            location: url.pathname === '/hop' ? '/final.csv' : 'http://169.254.169.254/x',
          },
        });
      }
      return new Response('Email,Debounce Code\njan@example.com,5\n');
    };
    const client = debounceClient('k', fetcher);
    await expect(client.download('https://cdn.debounce.io/get/x.csv')).rejects.toMatchObject({
      kind: 'invalid',
    });
    expect(requests).toEqual([{ url: 'https://cdn.debounce.io/get/x.csv', redirect: 'manual' }]);
    // A redirect to an allowed host is followed, and re-checked.
    requests.length = 0;
    const hop: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), redirect: init?.redirect });
      return String(input).endsWith('/hop')
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://files.example.com/r.csv' },
          })
        : new Response('Email,Debounce Code\njan@example.com,5\n');
    };
    const csv = await debounceClient('k', hop).download('https://cdn.debounce.io/hop');
    expect(parseBulkResults(csv)).toHaveLength(1);
    expect(requests.map((r) => r.url)).toEqual([
      'https://cdn.debounce.io/hop',
      'https://files.example.com/r.csv',
    ]);
  });

  it('stops reading a results file at the bound for its part', async () => {
    let pulled = 0;
    const big: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            const chunk = new Uint8Array(64 * 1024).fill(65);
            pulled += chunk.byteLength;
            controller.enqueue(chunk);
            if (pulled > 64 * 1024 * 1024) controller.close();
          },
        }),
      );
    const limit = debounceResultsLimit(10);
    await expect(
      debounceClient('k', big).download('https://cdn.debounce.io/big.csv', { maxBytes: limit }),
    ).rejects.toMatchObject({ kind: 'invalid' });
    expect(pulled).toBeLessThanOrEqual(limit + 2 * 64 * 1024);
    // A declared length over the bound is refused before reading.
    const declared: typeof fetch = async () =>
      new Response('x', { headers: { 'content-length': String(limit + 1) } });
    await expect(
      debounceClient('k', declared).download('https://cdn.debounce.io/d.csv', { maxBytes: limit }),
    ).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('uses the fake only for the dev key in development and tests', () => {
    expect(debounceFor({ ENVIRONMENT: 'test' })).toBeNull();
    expect(debounceFor({ ENVIRONMENT: 'test', DEBOUNCE_API_KEY: 'dev' })).not.toBeNull();
  });
});

describe('results files', () => {
  it('finds the columns by their names, in any order, with quotes and a BOM', () => {
    const csv = [
      '﻿"Debounce Reason","Free Email","Email","Debounce Code","Did You Mean"',
      '"Deliverable","true","Jan@Example.com","5",""',
      '"Invalid","false","bad@example.com","6","bad@example.org"',
      '"","","not-an-address","1",""',
    ].join('\r\n');
    expect(parseBulkResults(csv)).toEqual([
      { email: 'jan@example.com', code: 5, reason: 'Deliverable', didYouMean: null },
      { email: 'bad@example.com', code: 6, reason: 'Invalid', didYouMean: 'bad@example.org' },
    ]);
  });

  it('falls back to the result words when there is no code column', () => {
    const csv =
      'email;result\njan@example.com;Safe to Send\nx@example.com;Risky\ny@example.com;??\n';
    expect(parseBulkResults(csv).map((r) => r.code)).toEqual([5, 4]);
  });

  it('reads nothing from a file without an address column', () => {
    expect(parseBulkResults('code,reason\n5,Deliverable\n')).toEqual([]);
    expect(parseBulkResults('')).toEqual([]);
  });

  it('parses codes defensively', () => {
    expect(parseCode('5')).toBe(5);
    expect(parseCode(7)).toBe(7);
    expect(parseCode('9')).toBeNull();
    expect(parseCode(null, 'Invalid')).toBe(6);
    expect(fakeCode('temp-1@example.com').code).toBe(3);
  });
});

describe('the check-up', () => {
  const facts = (value: Partial<EmailCheckFacts>): CheckupFacts => ({
    now: Date.parse('2026-11-16T12:00:00Z'),
    sharedDomain: 'mail.example.com',
    channel: { ok: false },
    sender: { ok: false },
    domains: { ok: false },
    providers: { ok: false },
    ramps: { ok: false },
    list: { ok: false },
    blocklists: { ok: false },
    emailChecks: {
      ok: true,
      value: {
        enabled: true,
        keySet: true,
        access: 'allowed',
        available: true,
        subscribers: 1000,
        unchecked: 100,
        checked: 900,
        red: 5,
        ...value,
      },
    },
  });
  const finding = (f: CheckupFacts) => buildCheckup(f).findings.find((x) => x.id === 'email_check');

  it('says nothing while email checks are off, or for a small list', () => {
    expect(finding(facts({ enabled: false }))).toBeUndefined();
    expect(finding(facts({ subscribers: 50 }))).toBeUndefined();
  });

  it('suggests DeBounce with the referral link when it isn’t set up, without lowering the score', () => {
    const f = finding(facts({ available: false, keySet: false }));
    expect(f).toMatchObject({ severity: 'unknown', link: { to: 'email_check' } });
    expect(f?.external).toEqual([{ label: 'Create a DeBounce account', url: DEBOUNCE_SIGNUP_URL }]);
  });

  it('warns about red addresses and about a list mostly never checked', () => {
    expect(finding(facts({ red: 90 }))).toMatchObject({
      severity: 'warning',
      link: { to: 'subscribers' },
    });
    expect(finding(facts({ unchecked: 800, checked: 200, red: 1 }))?.title).toContain(
      'never been checked',
    );
    expect(finding(facts({}))?.severity).toBe('good');
  });
});
