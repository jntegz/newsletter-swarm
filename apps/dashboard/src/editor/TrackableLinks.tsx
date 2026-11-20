// Shorthop in the editor (docs/applications.md): shorten one address from a link dialog, or every
// link in a post from the toolbar. Nothing shows unless Shorthop is connected.
import { Button, ErrorNotice } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import type { Editor } from '@tiptap/react';
import { createContext, useContext, useState } from 'react';
import { shorthopStatusQuery, useCreateShortLink } from '../api/applications';
import { linksIn, replaceLinks } from './linkRewrite';

/** The post being written, which names its links. Website pages have none. */
export const CurrentPost = createContext<string | null>(null);

/** Saves the post being written. Its short links are named from the saved subject. */
export const SavePost = createContext<(() => Promise<unknown>) | null>(null);

const useLinkMaker = (channelId: string) => {
  const dispatchId = useContext(CurrentPost);
  const create = useCreateShortLink(channelId);
  return {
    create,
    make: async (url: string) =>
      (await create.mutateAsync({ url, ...(dispatchId ? { dispatchId } : {}) })).shortUrl,
  };
};

export function ShortenLinkButton({
  channelId,
  href,
  onLink,
}: {
  channelId: string;
  href: string;
  onLink: (shortUrl: string) => void;
}) {
  const status = useQuery(shorthopStatusQuery(channelId));
  const { create, make } = useLinkMaker(channelId);
  const savePost = useContext(SavePost);
  const [saving, setSaving] = useState(false);
  const [made, setMade] = useState<{ from: string; to: string } | null>(null);
  if (!status.data?.connected) return null;

  const url = href.trim();
  const web = /^https?:\/\/\S+\.\S+/i.test(url);
  // Editing the address afterwards makes it a new link to shorten.
  const current = made?.to === url ? made : null;
  return (
    <div className="mt-3 grid justify-items-start gap-2 text-[13px]">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={!web || current !== null}
        loading={saving || create.isPending}
        onClick={() => {
          setSaving(true);
          // A failed save shows on the page, and only costs this link its subject in the name.
          void Promise.resolve(savePost?.())
            .catch(() => undefined)
            .then(() => {
              setSaving(false);
              return make(url);
            })
            .then((shortUrl) => {
              setMade({ from: url, to: shortUrl });
              onLink(shortUrl);
            })
            // Shown from the mutation's error below.
            .catch(() => undefined);
        }}
      >
        Shorten link
      </Button>
      {current && (
        <p className="break-all text-sub" role="status">
          {current.from === current.to
            ? 'This is already a short link.'
            : `Shorthop link, going to ${current.from}`}
        </p>
      )}
      {create.error && <ErrorNotice message={create.error.message} />}
    </div>
  );
}

const resultText = ({ made, failed, reason }: Result) => {
  if (made === 0 && !failed) return 'No links left to shorten.';
  const done = `${made} ${made === 1 ? 'link' : 'links'} shortened.`;
  if (!failed) return done;
  return `${done} ${failed} couldn’t be shortened${reason ? `: ${reason}` : '.'}`;
};

interface Result {
  made: number;
  failed: number;
  reason: string | null;
}

/** In a post's toolbar: every link in this body, in one go. Undo brings them all back. */
export function ShortenAllLinks({
  editor,
  channelId,
  flush,
}: {
  editor: Editor;
  channelId: string;
  /** Saves first, so slugs and titles use the current subject. */
  flush: () => Promise<unknown>;
}) {
  const status = useQuery(shorthopStatusQuery(channelId));
  const { make } = useLinkMaker(channelId);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  if (!status.data?.connected) return null;

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      await flush();
    } catch {
      // The page says the save failed. Shortening now would use the old subject.
      setBusy(false);
      return;
    }
    const replacements = new Map<string, string>();
    let failed = 0;
    let reason: string | null = null;
    // One at a time: a post's links are few, and Shorthop's limits are the owner's.
    for (const url of linksIn(editor.state.doc)) {
      try {
        const shortUrl = await make(url);
        if (shortUrl !== url) replacements.set(url, shortUrl);
      } catch (error) {
        failed += 1;
        reason ??= error instanceof Error ? error.message : null;
      }
    }
    replaceLinks(editor, replacements);
    setResult({ made: replacements.size, failed, reason });
    setBusy(false);
  };

  return (
    <div className="relative shrink-0">
      <Button variant="ghost" size="sm" loading={busy} onClick={() => void run()}>
        Shorten all links
      </Button>
      {result && (
        <div
          role="status"
          className="line-menu absolute top-[calc(100%+6px)] left-0 z-20 grid w-[min(280px,calc(100vw-32px))] justify-items-start gap-2 p-3 text-[13px] leading-[1.5]"
        >
          <p>{resultText(result)}</p>
          <Button variant="quiet" size="sm" onClick={() => setResult(null)}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}
