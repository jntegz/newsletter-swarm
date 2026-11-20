import type { InstanceAudit as InstanceAuditData, Me } from '@swarm/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { instanceAuditQuery } from '../api/instance';
import { InstanceAudit } from './InstanceAudit';

const session = vi.hoisted(() => ({ instanceAdmin: true }));
vi.mock('../session', () => ({
  useSession: () => ({ me: { instanceAdmin: session.instanceAdmin } as Me }),
}));

function render(data: InstanceAuditData | undefined) {
  const client = new QueryClient();
  if (data) client.setQueryData(instanceAuditQuery(null).queryKey, data);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <InstanceAudit />
    </QueryClientProvider>,
  );
}

const base: InstanceAuditData = {
  items: [
    {
      seq: 42,
      action: 'instance.setting_changed',
      actorEmail: 'owner@example.org',
      metadata: {
        method: 'PUT',
        path: '/api/v1/instance/email-checks/workspaces/ws_harbour',
        request: { allowed: true, dailyChecks: 500, apiKey: '[not recorded]' },
      },
      ipPrefix: '203.0.113.0/24',
      at: '2026-11-18T09:30:00.000Z',
    },
    {
      seq: 41,
      action: 'instance.setting_changed',
      actorEmail: null,
      metadata: { method: 'PUT', path: '/api/v1/instance/settings', request: { signup: 'open' } },
      ipPrefix: null,
      at: '2026-11-17T08:00:00.000Z',
    },
  ],
  nextCursor: '41',
  verification: { ok: true, checked: 42, brokenAtSeq: null },
};

describe('Instance audit log (Settings > Instance)', () => {
  it('lists when, who, what, which setting and the changed fields, with the chain intact', () => {
    session.instanceAdmin = true;
    const html = render(base);
    expect(html).toContain('Instance audit log');
    expect(html).toContain('owner@example.org');
    expect(html).toContain('System');
    expect(html).toContain('Changed an install-wide setting');
    expect(html).toContain('DeBounce, ws_harbour');
    expect(html).toContain('Who can sign up');
    expect(html).toContain('dailyChecks: 500');
    expect(html).toContain('signup: open');
    expect(html).toContain('apiKey: [not recorded]');
    expect(html).toContain('18 Nov 2026');
    expect(html).toContain('Intact · 42 entries checked');
    // The newest page: older entries are a click away, there is nothing newer.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Newer/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Older/);
  });

  it('says when the chain no longer verifies, and where it breaks', () => {
    session.instanceAdmin = true;
    const html = render({ ...base, verification: { ok: false, checked: 9, brokenAtSeq: 10 } });
    expect(html).toContain('Altered entries found, from entry 10');
    expect(html).not.toContain('Intact');
  });

  it('shows an empty log, the last page, and nothing to someone who isn’t an instance admin', () => {
    session.instanceAdmin = true;
    const empty = render({ ...base, items: [], nextCursor: null });
    expect(empty).toContain('No changes yet.');
    expect(empty).toMatch(/<button[^>]*disabled=""[^>]*>Older/);
    session.instanceAdmin = false;
    expect(render(base)).toBe('');
  });
});
