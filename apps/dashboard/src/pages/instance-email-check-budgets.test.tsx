import type { InstanceEmailChecks, Me } from '@swarm/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { instanceEmailChecksQuery } from '../api/emailChecks';
import { InstanceEmailCheckBudgets } from './InstanceEmailCheckBudgets';

vi.mock('../session', () => ({
  useSession: () => ({ me: { instanceAdmin: true } as Me }),
}));

const workspace = (over: Partial<InstanceEmailChecks['workspaces'][number]>) => ({
  id: 'ws_1',
  name: 'Field Notes Studio',
  allowed: true,
  dailyChecks: 200,
  usedToday: 12,
  listChecks: 25_000,
  listUsedThisMonth: 4_200,
  customDailyChecks: false,
  customListChecks: false,
  ownedByInstanceAdmin: false,
  ...over,
});

function render(data: InstanceEmailChecks) {
  const client = new QueryClient();
  client.setQueryData(instanceEmailChecksQuery(true).queryKey, data);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <InstanceEmailCheckBudgets />
    </QueryClientProvider>,
  );
}

const base: InstanceEmailChecks = {
  keySet: true,
  balance: 1000,
  keyRejected: false,
  everyWorkspace: false,
  defaults: { dailyChecks: 200, listChecks: 25_000 },
  workspaces: [
    workspace({}),
    workspace({ id: 'ws_2', name: 'Harbour Books', listChecks: 500, customListChecks: true }),
    workspace({ id: 'ws_3', name: 'Not allowed', allowed: false }),
  ],
};

describe('DeBounce credits per workspace (Settings > Instance)', () => {
  it('lets an instance admin set both numbers for each workspace that may use DeBounce', () => {
    const html = render(base);
    expect(html).toContain('DeBounce credits per workspace');
    expect(html).toContain('Field Notes Studio');
    expect(html).toContain('Harbour Books');
    expect(html).not.toContain('Not allowed');
    expect(html.match(/Single checks a day/g)).toHaveLength(2);
    expect(html.match(/List checks a month/g)).toHaveLength(2);
    // A workspace's own number fills its field; the default shows as the placeholder.
    expect(html).toContain('value="500"');
    expect(html).toContain('placeholder="Default (25,000)"');
    expect(html).toContain('4,200 used this month (UTC).');
  });

  it('lists every workspace when every workspace may use DeBounce, and hides without a key', () => {
    expect(render({ ...base, everyWorkspace: true })).toContain('Not allowed');
    expect(render({ ...base, keySet: false })).toBe('');
  });
});
