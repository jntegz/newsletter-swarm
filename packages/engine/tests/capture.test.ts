import { defaultCaptureFormConfig } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION_SCRIPT,
  buildEmbedScript,
  confirmToken,
  integrityOf,
  leaveToken,
  loaderConfig,
  memberReference,
  memberToken,
  mergeSource,
  readConfirmToken,
  readLeaveToken,
  readMemberSession,
  scriptJson,
} from '../src/index';
import { workerLinks } from './link-keys';

const capture = workerLinks('capture');
// Member Center links come from send (or the vault); capture only verifies them.
const send = workerLinks('send');
const memberId = `mb_${'1'.repeat(32)}`;
const channelId = `ch_${'3'.repeat(32)}`;
const member = { memberId, channelId };
const requestId = `cq_${'2'.repeat(32)}`;
const request = { requestId, channelId };
const centerOf = async (token: string) => (await readMemberSession(capture, token))?.memberId;

describe('Member tokens', () => {
  it('are purpose-scoped: none stands in for another', async () => {
    const confirm = await confirmToken(capture, request, 3600, Date.now());
    const center = await memberToken(send, member);
    const leave = await leaveToken(capture, member);
    expect(await readConfirmToken(capture, confirm)).toEqual({ ok: true, value: request });
    expect(await centerOf(center)).toBe(memberId);
    expect(await readLeaveToken(capture, leave)).toEqual(member);

    expect((await readConfirmToken(capture, center)).ok).toBe(false);
    expect((await readConfirmToken(capture, leave)).ok).toBe(false);
    expect(await centerOf(confirm)).toBeUndefined();
    expect(await centerOf(leave)).toBeUndefined();
    expect(await readLeaveToken(capture, center)).toBeNull();
  });

  it('expire: confirm links after 7 days, Member Center links after 30', async () => {
    const day = 86_400_000;
    const now = Date.now();
    const confirm = await confirmToken(capture, request, 7 * 86_400, now - 8 * day);
    expect(await readConfirmToken(capture, confirm)).toEqual({ ok: false, reason: 'expired' });
    expect(await centerOf(await memberToken(send, member, now - 29 * day))).toBe(memberId);
    expect(await centerOf(await memberToken(send, member, now - 31 * day))).toBeUndefined();
  });

  it('give a redirect reference that hides the address but is stable per Member', async () => {
    const a = await memberReference(capture, 'ch_x', 'Ada@Example.org');
    const b = await memberReference(capture, 'ch_x', 'ada@example.org');
    const other = await memberReference(capture, 'ch_y', 'ada@example.org');
    expect(a.toLowerCase()).not.toContain('ada');
    expect(a.startsWith('v2.member-ref.')).toBe(true);
    const claim = async (t: string) => {
      const read = await capture.verify<{ r: string }>('member-ref', t);
      return read.ok ? read.payload.r : null;
    };
    expect(await claim(a)).toBe(await claim(b));
    expect(await claim(a)).not.toBe(await claim(other));
  });
});

describe('mergeSource', () => {
  it('keeps the first touch and moves the current one', () => {
    const first = mergeSource(
      {},
      {
        first: {
          utm_source: 'search',
          referrer: 'https://search.example/',
          first_url: 'https://a.example/1',
        },
        current: { utm_source: 'footer', current_url: 'https://a.example/2' },
      },
      { formId: 'cf_1', ref: 'mb_1' },
    );
    expect(first).toEqual({
      utm_source: 'search',
      referrer: 'https://search.example/',
      first_url: 'https://a.example/1',
      ref: 'mb_1',
      current: { utm_source: 'footer' },
      current_url: 'https://a.example/2',
      form_id: 'cf_1',
    });
    const later = mergeSource(
      first,
      {
        first: { utm_source: 'other' },
        current: { utm_medium: 'social', current_url: 'https://a.example/3' },
      },
      { formId: 'cf_2', ref: 'mb_2' },
    );
    expect(later).toMatchObject({
      utm_source: 'search',
      ref: 'mb_1',
      current: { utm_medium: 'social' },
      current_url: 'https://a.example/3',
      form_id: 'cf_2',
    });
  });

  it('falls back to the current page when there is no first touch, and clips long values', () => {
    const source = mergeSource(
      {},
      { current: { utm_campaign: 'x'.repeat(500), current_url: 'https://a.example/p' } },
      { formId: null, ref: null },
    );
    expect(source.first_url).toBe('https://a.example/p');
    expect(source.utm_campaign).toHaveLength(200);
  });
});

describe('embed loader', () => {
  const config = { ...defaultCaptureFormConfig(), placement: 'popup' as const };
  const loader = loaderConfig('https://forms.example/', `cf_${'3'.repeat(32)}`, 4, config);

  it('is byte-stable for a version, so its SRI hash is too', async () => {
    const again = loaderConfig('https://forms.example', `cf_${'3'.repeat(32)}`, 4, {
      ...config,
      // Key order and draft-only details don't change the served bytes.
      copy: { button: 'Join', body: '', heading: 'Join the list' },
    });
    expect(buildEmbedScript(again)).toBe(buildEmbedScript(loader));
    expect(await integrityOf(buildEmbedScript(loader))).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
  });

  it('is valid JavaScript, like the attribution script', () => {
    expect(() => new Function(buildEmbedScript(loader))).not.toThrow();
    expect(() => new Function(ATTRIBUTION_SCRIPT)).not.toThrow();
  });

  it('escapes data for a script context', () => {
    expect(scriptJson({ a: '</script>\u2028&' })).toBe(
      '{"a":"\\u003c/script\\u003e\\u2028\\u0026"}',
    );
  });
});
