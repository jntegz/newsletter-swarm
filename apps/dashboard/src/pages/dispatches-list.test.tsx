// The Posts list: before its query answers, and with posts, chips, authors and send rates.
import type { Channel, DispatchCounts, DispatchListItem } from '@swarm/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { postCountsQuery, postListQuery } from '../api/send';
import { ToastProvider } from '../shell/toast';
import { DispatchList } from './Dispatches';
import { listFilterFor, type PostsListSearch } from './posts-list';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  useNavigate: () => () => undefined,
}));

vi.mock('../home/NewPostMenu', () => ({ NewPostMenu: () => null }));

const CH = 'ch_1';
const hex = (n: number) => String(n).padStart(32, '0');

const post = (n: number, extra: Partial<DispatchListItem> = {}): DispatchListItem => ({
  id: `di_${hex(n)}`,
  channelId: CH,
  subject: `Post ${n}`,
  preheader: '',
  status: 'draft',
  senderIdentityId: null,
  publishAt: null,
  sentAt: null,
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt: '2026-11-02T09:00:00.000Z',
  latestBroadcastId: null,
  webVisibility: 'public',
  webPublishedAt: null,
  kind: 'broadcast',
  flowId: null,
  createdVia: null,
  archivedAt: null,
  plannedDate: null,
  importedAt: null,
  bestTime: false,
  author: null,
  latestSend: null,
  ...extra,
});

function render(
  options: {
    role?: Channel['role'];
    filters?: PostsListSearch;
    flags?: Record<string, boolean>;
    posts?: DispatchListItem[];
    counts?: DispatchCounts;
  } = {},
) {
  const client = new QueryClient();
  const filters = options.filters ?? {};
  if (options.flags) client.setQueryData(['channels', CH, 'flags'], { flags: options.flags });
  if (options.posts) {
    const archiveOn = options.flags?.post_archive === true;
    client.setQueryData(
      postListQuery(CH, listFilterFor(filters, archiveOn)).queryKey,
      options.posts,
    );
  }
  if (options.counts) {
    client.setQueryData(
      postCountsQuery(CH, { q: filters.q, startedBy: filters.by }).queryKey,
      options.counts,
    );
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <DispatchList
          channel={{ id: CH, name: 'Field Notes', role: options.role ?? 'owner' } as Channel}
          picker={null}
          filters={filters}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const sent = post(2, {
  subject: 'The slow web',
  status: 'sent',
  sentAt: '2026-11-01T09:00:00.000Z',
  latestBroadcastId: `bc_${hex(2)}`,
  author: { id: 'op_1', name: 'Mara Lind', email: 'mara@example.com' },
  latestSend: {
    broadcastId: `bc_${hex(2)}`,
    delivered: 1000,
    humanOpens: 482,
    humanClicks: 46,
    openRate: 0.482,
    clickRate: 0.046,
  },
});

describe('the Posts list', () => {
  it('says nothing about an empty filter while the posts are still loading', () => {
    const html = render();
    expect(html).toContain('Loading posts');
    expect(html).not.toContain('No posts match');
  });

  it('shows the author by name, the agent pill, and the latest send’s open and click rates', () => {
    const html = render({
      flags: {},
      posts: [
        sent,
        post(3, { subject: 'By an agent', createdVia: 'agent' }),
        post(4, {
          subject: 'No name',
          author: { id: 'op_2', name: null, email: 'jo@example.com' },
        }),
      ],
    });
    expect(html).toContain('Mara Lind');
    expect(html).toContain('>Agent<');
    expect(html).toContain('jo@example.com');
    expect(html).not.toContain('Teammate');
    expect(html).toContain('48.2%');
    expect(html).toContain('4.6%');
    expect(html).toContain('>Opens<');
    expect(html).toContain('>Clicks<');
  });

  it('counts each chip, and offers Archived only while the archive is on', () => {
    const counts = { all: 12, draft: 3, scheduled: 1, sent: 8, archived: 4 };
    const on = render({ flags: { post_archive: true }, posts: [sent], counts });
    expect(on).toMatch(/aria-pressed="true"[^>]*>All\s*<span[^>]*>12<\/span>/);
    expect(on).toMatch(/>Drafts\s*<span[^>]*>3<\/span>/);
    expect(on).toMatch(/>Archived\s*<span[^>]*>4<\/span>/);
    const off = render({ flags: {}, posts: [sent], counts: { ...counts, archived: null } });
    expect(off).not.toContain('>Archived<');
  });

  it('names the Started by filter on its button, and says when nothing matches', () => {
    const html = render({ flags: {}, filters: { by: 'agents', q: 'zebra' }, posts: [] });
    expect(html).toContain('Started by an agent or the API');
    expect(html).toContain('value="zebra"');
    expect(html).toContain('No posts match');
    expect(html).toContain('Clear filters');
  });

  it('lets only editors and up select posts to archive', () => {
    const editor = render({ flags: { post_archive: true }, posts: [sent] });
    expect(editor).toContain('Select The slow web');
    const author = render({ role: 'author', flags: { post_archive: true }, posts: [sent] });
    expect(author).not.toContain('Select The slow web');
    expect(author).toContain('c for a new post');
    expect(author).not.toContain('x to select');
  });
});
