import type { CheckupFinding } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { checkedAgo, findingKey, groupFindings, verdictCopy } from './checkup-helpers';

const finding = (
  id: CheckupFinding['id'],
  severity: CheckupFinding['severity'],
  subject: string | null = null,
): CheckupFinding => ({
  id,
  subject,
  severity,
  title: id,
  meaning: '',
  fix: [],
  link: null,
  external: [],
});

describe('groupFindings', () => {
  it('groups by severity, most serious first, and drops empty groups', () => {
    const groups = groupFindings([
      finding('dns_dkim', 'problem', 'a.example'),
      finding('footer_address', 'warning'),
      finding('dns_dkim', 'problem', 'b.example'),
      finding('sender', 'good'),
    ]);
    expect(groups.map((g) => [g.severity, g.findings.length])).toEqual([
      ['problem', 2],
      ['warning', 1],
      ['good', 1],
    ]);
    expect(groups[0]!.findings.map((f) => f.subject)).toEqual(['a.example', 'b.example']);
  });

  it('keys findings apart when one check reports on two domains', () => {
    const keys = [
      finding('dns_dkim', 'problem', 'a.example'),
      finding('dns_dkim', 'problem', 'b.example'),
      finding('blocklist', 'unknown', 'a.example unchecked'),
      finding('blocklist', 'good', 'a.example clean'),
    ].map(findingKey);
    expect(new Set(keys).size).toBe(4);
  });
});

describe('verdictCopy', () => {
  const counts = { problem: 0, warning: 0, unknown: 0, good: 5 };

  it('counts problems and says where to start', () => {
    expect(verdictCopy({ verdict: 'problems', counts: { ...counts, problem: 1 } })).toMatchObject({
      tone: 'danger',
      headline: '1 problem to fix',
    });
    expect(verdictCopy({ verdict: 'problems', counts: { ...counts, problem: 3 } }).headline).toBe(
      '3 problems to fix',
    );
  });

  it('is calm about warnings', () => {
    expect(verdictCopy({ verdict: 'warnings', counts: { ...counts, warning: 2 } })).toMatchObject({
      tone: 'warn',
      headline: 'No problems, 2 things to improve',
    });
  });

  it('does not call it all clear while checks are still open', () => {
    expect(verdictCopy({ verdict: 'healthy', counts }).headline).toBe('Everything checks out');
    const open = verdictCopy({ verdict: 'healthy', counts: { ...counts, unknown: 2 } });
    expect(open.headline).toBe('No problems found');
    expect(open.detail).toContain('2 checks couldn’t run');
  });
});

describe('checkedAgo', () => {
  it('reads as a person would say it', () => {
    const now = Date.parse('2026-11-12T12:00:00Z');
    expect(checkedAgo('2026-11-12T11:59:40Z', now)).toBe('just now');
    expect(checkedAgo('2026-11-12T11:59:00Z', now)).toBe('1 minute ago');
    expect(checkedAgo('2026-11-12T11:15:00Z', now)).toBe('45 minutes ago');
    expect(checkedAgo('2026-11-12T09:00:00Z', now)).toBe('3 hours ago');
    expect(checkedAgo('nonsense', now)).toBe('just now');
  });
});
