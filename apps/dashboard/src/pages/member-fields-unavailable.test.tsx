// The subscriber drawer's profile fields when the API flags `encryptedUnavailable` (the vault did
// not answer): a short note in place of the encrypted fields, which are not shown empty.
import type { Channel, MemberDetail, MemberField } from '@swarm/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { memberFieldsQuery } from '../api/members';
import { FieldsPanel } from './MemberDrawer';
import { FIELDS_UNAVAILABLE } from './members-helpers';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  useNavigate: () => () => undefined,
}));

const CH = 'ch_1';

const field = (key: string, label: string, encrypted: boolean): MemberField => ({
  id: `mf_${key}`,
  channelId: CH,
  key,
  label,
  type: 'text',
  options: [],
  encrypted,
  position: 0,
  createdAt: '2026-11-01T09:00:00.000Z',
});

function render(member: Partial<MemberDetail>): string {
  const client = new QueryClient();
  client.setQueryData(memberFieldsQuery(CH).queryKey, [
    field('city', 'City', false),
    field('passport', 'Passport number', true),
  ]);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <FieldsPanel
        channel={{ id: CH, name: 'Field Notes', role: 'owner' } as Channel}
        member={{ id: 'me_1', fields: { city: 'Oslo', passport: null }, ...member } as MemberDetail}
        canEdit
      />
    </QueryClientProvider>,
  );
}

describe('profile fields while encrypted ones are unavailable', () => {
  it('shows the note instead of the encrypted fields', () => {
    const html = render({ encryptedUnavailable: true });
    expect(html).toContain('Profile fields are temporarily unavailable');
    expect(html).toContain(FIELDS_UNAVAILABLE);
    expect(html).not.toContain('Passport number');
    expect(html).toContain('City');
  });

  it('shows every field and no note otherwise', () => {
    const html = render({});
    expect(html).not.toContain('temporarily unavailable');
    expect(html).toContain('Passport number');
  });
});
