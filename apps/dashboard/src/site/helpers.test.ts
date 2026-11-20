import { KNOWN_AI_BOTS } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import {
  botAction,
  hasGate,
  lastDays,
  moveItem,
  navLinkProblem,
  niceMax,
  planDomain,
  rangeProblem,
  robotsLines,
  tickIndexes,
} from './helpers';

describe('moveItem', () => {
  it('moves an item up and down without touching the original', () => {
    const list = ['a', 'b', 'c'];
    expect(moveItem(list, 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveItem(list, 0, 1)).toEqual(['b', 'a', 'c']);
    expect(list).toEqual(['a', 'b', 'c']);
  });

  it('clamps the target and ignores an index outside the list', () => {
    expect(moveItem(['a', 'b'], 0, 9)).toEqual(['b', 'a']);
    expect(moveItem(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
  });
});

describe('navLinkProblem', () => {
  it('accepts site paths and https addresses', () => {
    expect(navLinkProblem({ label: 'About', href: '/about' })).toBeNull();
    expect(navLinkProblem({ label: 'Shop', href: 'https://shop.example.com' })).toBeNull();
  });

  it('names what is missing or unsafe', () => {
    expect(navLinkProblem({ label: ' ', href: '/about' })).toBe('Add a label.');
    expect(navLinkProblem({ label: 'X', href: '' })).toBe('Add an address.');
    expect(navLinkProblem({ label: 'X', href: 'http://plain.example' })).toMatch(/https/);
    expect(navLinkProblem({ label: 'X', href: '//evil.example' })).toMatch(/path/);
    expect(navLinkProblem({ label: 'X', href: 'javascript:alert(1)' })).toMatch(/path/);
  });
});

describe('planDomain', () => {
  it('sets up www with a bare-domain redirect for a bare domain', () => {
    expect(planDomain('Example.com')).toEqual({
      hostname: 'example.com',
      web: 'www.example.com',
      apex: 'example.com',
    });
  });

  it('strips a scheme, path and trailing dot', () => {
    expect(planDomain('https://www.example.com/blog?x=1')?.hostname).toBe('www.example.com');
    expect(planDomain('example.org.')?.hostname).toBe('example.org');
  });

  it('redirects the bare domain to www only when asked', () => {
    expect(planDomain('www.example.com')?.apex).toBe('example.com');
    expect(planDomain('www.example.com', false)?.apex).toBeNull();
    expect(planDomain('news.example.com')).toEqual({
      hostname: 'news.example.com',
      web: 'news.example.com',
      apex: null,
    });
  });

  it('returns null for anything that is not a hostname yet', () => {
    expect(planDomain('')).toBeNull();
    expect(planDomain('example')).toBeNull();
    expect(planDomain('exa mple.com')).toBeNull();
  });
});

describe('analytics ranges', () => {
  it('counts the last days including today', () => {
    expect(lastDays(7, '2026-10-27')).toEqual({ from: '2026-10-21', to: '2026-10-27' });
    expect(lastDays(1, '2026-03-01')).toEqual({ from: '2026-03-01', to: '2026-03-01' });
  });

  it('checks a custom range like the API does', () => {
    expect(rangeProblem('2026-10-01', '2026-10-27')).toBeNull();
    expect(rangeProblem('2026-10-28', '2026-10-27')).toMatch(/after/);
    expect(rangeProblem('2024-01-01', '2026-10-27')).toMatch(/366/);
    expect(rangeProblem('', '2026-10-27')).toMatch(/Choose/);
  });

  it('spaces ticks and always labels the last point', () => {
    expect(tickIndexes(0)).toEqual([]);
    expect(tickIndexes(3)).toEqual([0, 1, 2]);
    const ticks = tickIndexes(30);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBe(29);
    expect(ticks.length).toBeLessThanOrEqual(7);
  });

  it('rounds the axis maximum up to a readable value', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(13)).toBe(20);
    expect(niceMax(420)).toBe(500);
    expect(niceMax(1000)).toBe(1000);
  });
});

describe('Bot Rules', () => {
  it('blocks per policy and per override', () => {
    expect(botAction('unset', { gptbot: 'block' }, 'gptbot')).toBe('allow');
    expect(botAction('allow', {}, 'gptbot')).toBe('allow');
    expect(botAction('block', { gptbot: 'allow' }, 'gptbot')).toBe('block');
    expect(botAction('custom', { gptbot: 'block' }, 'gptbot')).toBe('block');
    expect(botAction('custom', { gptbot: 'block' }, 'ccbot')).toBe('allow');
  });

  it('writes a Disallow group for each blocked crawler', () => {
    expect(robotsLines('allow', {})).toEqual([]);
    expect(robotsLines('custom', { ccbot: 'block' })).toEqual([
      'User-agent: CCBot',
      'Disallow: /',
      '',
    ]);
    expect(robotsLines('block', {})).toHaveLength(KNOWN_AI_BOTS.length * 3);
  });
});

describe('hasGate', () => {
  it('finds a top-level gate divider only', () => {
    expect(hasGate({ type: 'doc', content: [{ type: 'paragraph' }, { type: 'gate' }] })).toBe(true);
    expect(hasGate({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe(false);
    expect(hasGate(null)).toBe(false);
  });
});
