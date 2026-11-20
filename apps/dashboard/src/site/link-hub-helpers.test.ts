import { describe, expect, it } from 'vitest';
import {
  clickThrough,
  hubLinkProblem,
  hubLinkStatus,
  isoFromLocalInput,
  localInputValue,
  onAccent,
  siteAccent,
} from './link-hub-helpers';

const draft = (overrides: Partial<Parameters<typeof hubLinkProblem>[0]> = {}) => ({
  title: 'Shop',
  url: 'https://shop.example',
  startsAt: '',
  endsAt: '',
  ...overrides,
});

describe('hubLinkProblem', () => {
  it('accepts http and https targets with a title', () => {
    expect(hubLinkProblem(draft())).toBeNull();
    expect(hubLinkProblem(draft({ url: 'http://old.example/path?q=1' }))).toBeNull();
  });

  it('refuses other schemes, relative targets and credentials', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', '/about', 'mailto:a@b.example']) {
      expect(hubLinkProblem(draft({ url }))?.field, url).toBe('url');
    }
    expect(hubLinkProblem(draft({ url: 'https://a:b@x.example' }))?.message).toMatch(/password/);
    expect(hubLinkProblem(draft({ title: '  ' }))?.field).toBe('title');
  });

  it('wants the end after the start', () => {
    expect(
      hubLinkProblem(draft({ startsAt: '2026-11-02T10:00', endsAt: '2026-11-01T10:00' }))?.field,
    ).toBe('endsAt');
    expect(
      hubLinkProblem(draft({ startsAt: '2026-11-01T10:00', endsAt: '2026-11-02T10:00' })),
    ).toBe(null);
  });
});

describe('schedule inputs', () => {
  it('round-trips through datetime-local values', () => {
    const iso = isoFromLocalInput('2026-11-01T09:30');
    expect(iso).not.toBeNull();
    expect(localInputValue(iso)).toBe('2026-11-01T09:30');
    expect(isoFromLocalInput('')).toBeNull();
    expect(localInputValue(null)).toBe('');
  });

  it('names a link live, scheduled or ended', () => {
    const now = Date.parse('2026-11-01T12:00:00Z');
    expect(hubLinkStatus({ startsAt: null, endsAt: null }, now)).toBe('live');
    expect(hubLinkStatus({ startsAt: '2026-11-02T00:00:00Z', endsAt: null }, now)).toBe(
      'scheduled',
    );
    expect(hubLinkStatus({ startsAt: null, endsAt: '2026-11-01T12:00:00Z' }, now)).toBe('ended');
  });
});

describe('report and preview helpers', () => {
  it('computes click-through', () => {
    expect(clickThrough(5, 0)).toBe('—');
    expect(clickThrough(1, 40)).toBe('2.5%');
    expect(clickThrough(30, 40)).toBe('75%');
  });

  it('falls back to the default accent', () => {
    expect(siteAccent('#0A7D5A')).toBe('#0a7d5a');
    expect(siteAccent('red')).toBe('#6c4cf1');
    expect(siteAccent(null)).toBe('#6c4cf1');
    expect(onAccent('#6c4cf1')).toBe('#ffffff');
    expect(onAccent('#f4e04d')).toBe('#0f0f12');
  });
});
