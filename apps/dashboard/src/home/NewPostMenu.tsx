// "New post" with a Start from menu: a blank post, a template (the Templates page's "Use", for
// the starters that ship with Swarm and the ones the team saved), or a
// copy of the last post (created with the last post's subject, preview text, cover image and
// content).
import type { Channel, DispatchSummary } from '@swarm/domain';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { dispatchQuery, dispatchesQuery, useCreateDispatch } from '../api/send';
import { coverForCopy } from '../editor/coverImage';
import * as Icon from '../icons';
import { useDisclosure } from '../shell/useDisclosure';

/** The post to offer as "Duplicate": the latest one sent, else the latest edited. */
function lastPost(list: readonly DispatchSummary[]): DispatchSummary | undefined {
  const posts = list.filter((d) => d.kind === 'broadcast' && !d.archivedAt);
  const sent = posts
    .filter((d) => d.status === 'sent')
    .sort((a, b) => (b.sentAt ?? b.updatedAt).localeCompare(a.sentAt ?? a.updatedAt));
  return sent[0] ?? [...posts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

export function NewPostMenu({ channel }: { channel: Channel }) {
  const menu = useDisclosure();
  const navigate = useNavigate();
  const client = useQueryClient();
  const create = useCreateDispatch(channel.id);
  const posts = useQuery(dispatchesQuery(channel.id));
  const last = lastPost(posts.data ?? []);
  const [copying, setCopying] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (channel.role === 'viewer') return null;

  const open = (id: string) => {
    menu.close();
    void navigate({ to: '/dispatches/$dispatchId', params: { dispatchId: id } });
  };

  const blank = () =>
    create.mutate({}, { onSuccess: (d) => open(d.id), onError: (e) => setProblem(e.message) });

  const duplicate = async () => {
    if (!last) return;
    setCopying(true);
    setProblem(null);
    try {
      const source = await client.fetchQuery(dispatchQuery(last.id));
      const copy = await create.mutateAsync({
        subject: source.subject,
        preheader: source.preheader,
        content: source.content,
        coverImage: coverForCopy(source.coverImage),
      });
      open(copy.id);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The copy wasn’t made.');
    } finally {
      setCopying(false);
    }
  };

  const busy = create.isPending || copying;

  return (
    <div className="relative">
      <button
        type="button"
        {...menu.buttonProps}
        className="btn-primary"
        aria-busy={busy || undefined}
      >
        <Icon.Plus size={18} />
        New post
      </button>
      <div
        {...menu.panelProps}
        className="line-menu absolute top-[calc(100%+6px)] right-0 w-[min(320px,calc(100vw-32px))]"
      >
        <p className="px-2.5 pt-1.5 pb-1 text-[13px] text-sub">Start from</p>
        <button
          type="button"
          className="line-menu-item items-start"
          disabled={busy}
          onClick={blank}
        >
          <Icon.Doc className="mt-0.5 shrink-0 text-sub" />
          <span>
            Blank post
            <small className="block text-[13px] leading-snug text-sub">
              {create.isPending && !copying
                ? 'Creating…'
                : 'An empty page with your default footer'}
            </small>
          </span>
        </button>
        <Link
          to="/templates"
          search={{ channel: channel.id }}
          className="line-menu-item items-start"
          onClick={() => menu.close()}
        >
          <Icon.Layout className="mt-0.5 shrink-0 text-sub" />
          <span>
            From a template
            <small className="block text-[13px] leading-snug text-sub">
              Pick a starter or one you saved, and choose Use
            </small>
          </span>
        </Link>
        {last && (
          <button
            type="button"
            className="line-menu-item items-start"
            disabled={busy}
            onClick={() => void duplicate()}
          >
            <Icon.Duplicate className="mt-0.5 shrink-0 text-sub" />
            <span className="min-w-0">
              <span className="line-clamp-2">Duplicate {last.subject || 'the last post'}</span>
              <small className="block text-[13px] leading-snug text-sub">
                {copying
                  ? 'Copying…'
                  : 'Copies the subject, preview text and content, not the send'}
              </small>
            </span>
          </button>
        )}
        {problem && (
          <p role="alert" className="px-2.5 py-1.5 text-[13px] text-danger">
            {problem}
          </p>
        )}
      </div>
    </div>
  );
}
