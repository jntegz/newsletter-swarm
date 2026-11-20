import { describe, expect, it } from 'vitest';
import {
  ChannelSlugSchema,
  CircleRuleSchema,
  CursorQuerySchema,
  DispatchAudienceSchema,
  EVERYONE,
  MEMBER_STATUSES,
  canTransition,
  idPattern,
  newId,
  uuidv7Hex,
  customCssProblem,
  MESSAGE_KEYS,
  MESSAGES,
  messageProblem,
  siteCodeHtml,
  siteCodeProblem,
  type SiteCodeEntry,
} from '../src/index';

describe('ids', () => {
  it('prefixes ids and matches their own pattern', () => {
    const id = newId('channel');
    expect(id).toMatch(/^ch_/);
    expect(idPattern('channel').test(id)).toBe(true);
    expect(idPattern('workspace').test(id)).toBe(false);
  });

  it('produces RFC 9562 version 7 UUIDs that sort by time', () => {
    const early = uuidv7Hex(1_000);
    const late = uuidv7Hex(2_000);
    expect(early[12]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(early[16]);
    expect(early < late).toBe(true);
  });
});

describe('ChannelSlugSchema', () => {
  it.each(['abc', 'my-channel', 'a1b2'])('accepts %s', (slug) => {
    expect(ChannelSlugSchema.safeParse(slug).success).toBe(true);
  });

  it.each(['ab', '-abc', 'abc-', 'ABC', 'a_b', 'x'.repeat(49)])('rejects %s', (slug) => {
    expect(ChannelSlugSchema.safeParse(slug).success).toBe(false);
  });

  it.each(['events', 'sites', 'unsubscribe', 'dmarc', 'staging-events'])(
    'reserves the installer hostname %s',
    (slug) => {
      expect(ChannelSlugSchema.safeParse(slug).error?.issues[0]?.message).toBe(
        'This address is reserved.',
      );
    },
  );
});

describe('CursorQuerySchema', () => {
  it('defaults and bounds the limit', () => {
    expect(CursorQuerySchema.parse({}).limit).toBe(25);
    expect(CursorQuerySchema.parse({ limit: '100' }).limit).toBe(100);
    expect(CursorQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });
});

describe('member state machine', () => {
  const statuses = MEMBER_STATUSES;
  it('never lets anyone leave bounced or complained, except bounced → complained by the system', () => {
    for (const actor of ['operator', 'member', 'system'] as const) {
      for (const to of statuses) {
        expect(canTransition('complained', to, actor)).toBe(false);
        expect(canTransition('bounced', to, actor)).toBe(actor === 'system' && to === 'complained');
      }
    }
  });

  it('only lets the Member bring themselves back from unsubscribed', () => {
    expect(canTransition('unsubscribed', 'active', 'member')).toBe(true);
    expect(canTransition('unsubscribed', 'active', 'operator')).toBe(false);
    expect(canTransition('unsubscribed', 'active', 'system')).toBe(false);
  });

  it('never lets an operator confirm on a Member’s behalf', () => {
    expect(canTransition('pending', 'active', 'operator')).toBe(false);
    expect(canTransition('pending', 'active', 'member')).toBe(true);
  });

  it('treats staying put as no transition', () => {
    for (const s of statuses) expect(canTransition(s, s, 'system')).toBe(false);
  });
});

describe('Circle rules', () => {
  const leaf = { field: 'status', cmp: 'eq', value: 'active' } as const;
  const nest = (depth: number): unknown =>
    depth === 1 ? leaf : { op: 'and', children: [nest(depth - 1)] };

  it('accepts nesting up to 20 levels and refuses deeper', () => {
    expect(CircleRuleSchema.safeParse(nest(20)).success).toBe(true);
    expect(CircleRuleSchema.safeParse(nest(21)).success).toBe(false);
  });

  it('refuses a "not" group with anything but one child, at any depth', () => {
    const bad = { op: 'and', children: [{ op: 'not', children: [leaf, leaf] }] };
    expect(CircleRuleSchema.safeParse(bad).success).toBe(false);
    expect(
      CircleRuleSchema.safeParse({ op: 'and', children: [{ op: 'not', children: [leaf] }] })
        .success,
    ).toBe(true);
  });

  it('caps the number of conditions', () => {
    const wide = {
      op: 'or',
      children: Array.from({ length: 2 }, () => ({
        op: 'or',
        children: Array.from({ length: 50 }, () => leaf),
      })),
    };
    expect(CircleRuleSchema.safeParse(wide).success).toBe(true);
    wide.children.push({ op: 'or', children: [leaf] });
    expect(CircleRuleSchema.safeParse(wide).success).toBe(false);
  });
});

describe('Dispatch audience', () => {
  it('refuses a Circle in both lists', () => {
    const circle = `cl_${'a'.repeat(32)}`;
    expect(DispatchAudienceSchema.safeParse({ include: [circle], exclude: [circle] }).success).toBe(
      false,
    );
    expect(DispatchAudienceSchema.safeParse(EVERYONE).success).toBe(true);
  });
});

describe('customCssProblem', () => {
  it('allows ordinary CSS and data images', () => {
    expect(customCssProblem('body{color:red}')).toBeNull();
    expect(customCssProblem('a{background:url("data:image/png;base64,AAAA")}')).toBeNull();
  });

  it.each([
    '@import "https://evil.example/a.css";',
    '@IMPORT url(x.css);',
    'a{background:url(https://evil.example/x.png)}',
    'a{background:url( "//evil.example/x.png")}',
    '</style><script>alert(1)</script>',
    'a{background:u\\72l(https://evil.example/x)}',
    'a{width:expression(alert(1))}',
    '@font-face{src:url(x.woff)}',
    'x'.repeat(20_001),
  ])('refuses %s', (css) => {
    expect(customCssProblem(css)).not.toBeNull();
  });
});

describe('messageProblem', () => {
  const base = {
    subject: 'Confirm for {{channel_name}}',
    mode: 'text' as const,
    heading: 'Confirm',
    body: 'Please confirm.',
    buttonLabel: 'Confirm',
  };
  const html = (body: string) => ({ ...base, mode: 'html' as const, body });

  it('accepts the built-in wording of every email', () => {
    for (const key of MESSAGE_KEYS) {
      const def = MESSAGES[key];
      expect(
        messageProblem(key, {
          subject: def.subject,
          mode: 'text',
          heading: def.heading,
          body: def.body,
          buttonLabel: def.button,
        }),
      ).toBeNull();
    }
  });

  it('refuses a value the email does not have', () => {
    // A stranger can type any address, so their name must never reach confirmation mail.
    expect(messageProblem('confirm', { ...base, body: 'Hi {{first_name}}' })?.path).toBe('body');
    expect(messageProblem('rejoin', { ...base, subject: 'Hi {{first_name}}' })?.path).toBe(
      'subject',
    );
    expect(messageProblem('confirm', { ...base, body: '{{@unsubscribe}}' })?.path).toBe('body');
    expect(messageProblem('trial_ending', { ...base, body: 'Hi {{first_name}}' })).toBeNull();
  });

  it('does not offer a name in mail sent to an address someone merely typed', () => {
    for (const key of ['confirm', 'confirm_reminder', 'rejoin', 'member_center'] as const) {
      expect(Object.keys(MESSAGES[key].variables)).not.toContain('first_name');
    }
  });

  it('requires the link in HTML, and refuses what can run code', () => {
    expect(messageProblem('confirm', html('<p>No link</p>'))?.message).toContain('confirm_url');
    const link = '<a href="{{confirm_url}}">Confirm</a>';
    expect(messageProblem('confirm', html(link))).toBeNull();
    for (const bad of [
      `${link}<script>alert(1)</script>`,
      `${link}<SCRIPT src=x></SCRIPT>`,
      `${link}<iframe src=x></iframe>`,
      `${link}<form action=x></form>`,
      `${link}<img src=x onerror=alert(1)>`,
      `${link}<a href="javascript:alert(1)">x</a>`,
      `${link}<a href=" JavaScript:alert(1)">x</a>`,
    ]) {
      expect(messageProblem('confirm', html(bad)), bad).not.toBeNull();
    }
  });

  it('keeps security emails to text', () => {
    const link = '<a href="{{signin_url}}">Sign in</a>';
    expect(messageProblem('reader_signin', html(link))?.path).toBe('mode');
    expect(messageProblem('confirm', { ...base, buttonLabel: ' ' })?.path).toBe('buttonLabel');
  });
});

describe('site code', () => {
  const entry = (preset: SiteCodeEntry['preset'], value: string): SiteCodeEntry => ({
    name: 'Tool',
    preset,
    category: 'analytics',
    value,
  });

  it('checks each tool’s id, so a preset can’t carry code', () => {
    expect(siteCodeProblem(entry('google_analytics', 'G-ABC123DEF4'))).toBeNull();
    expect(siteCodeProblem(entry('google_tag_manager', 'GTM-ABC123'))).toBeNull();
    expect(siteCodeProblem(entry('plausible', 'news.example.com'))).toBeNull();
    expect(siteCodeProblem(entry('fathom', 'ABCDEFG'))).toBeNull();
    expect(siteCodeProblem(entry('meta_pixel', '123456789'))).toBeNull();
    for (const [preset, bad] of [
      ['google_analytics', "G-ABC');alert(1);//"],
      ['google_tag_manager', 'GTM-"><script>'],
      ['plausible', 'x"><script>alert(1)</script>'],
      ['fathom', 'ABC"'],
      ['meta_pixel', "1');alert(1);//"],
      ['verification', '<script>alert(1)</script>'],
      ['verification', '<meta name="x" content="y" onload="alert(1)">'],
    ] as const) {
      expect(siteCodeProblem(entry(preset, bad)), bad).not.toBeNull();
    }
  });

  it('builds the code with the id in place', () => {
    const html = siteCodeHtml(entry('google_analytics', 'G-ABC123DEF4'));
    expect(html).toContain('gtag/js?id=G-ABC123DEF4');
    expect(html).toContain("gtag('config','G-ABC123DEF4')");
  });
});
