// Referral settings say what is wrong with a field only after it is left or a save is tried.
import type { ChampionSettings } from '@swarm/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SettingsForm } from './Champions';

vi.mock('./Layout', () => ({
  QueryState: ({ children }: { children: unknown }) => children,
  useGrowth: () => ({ channel: { id: 'ch_1' }, canAdmin: true }),
}));

describe('the referral settings form', () => {
  it('shows no errors on first render, even for values it would refuse', () => {
    const settings = {
      enabled: true,
      engagementDays: 0,
      clusterLimit: 0,
      clusterWindowHours: 0,
      blockDisposable: true,
      publicLeaderboard: false,
      shareText: null,
      updatedAt: null,
    } satisfies ChampionSettings;
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <SettingsForm settings={settings} />
      </QueryClientProvider>,
    );
    expect(html).not.toContain('Use a whole number');
    expect(html).not.toContain('role="alert"');
    // Nothing has changed, so there is no Save yet: the Unsaved changes bar brings it.
    expect(html).not.toContain('type="submit"');
    expect(html).not.toContain('Unsaved changes');
  });
});
