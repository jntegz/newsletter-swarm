// Site Studio → Import past issues (flag archive_import). The export is read here in the browser; the
// person sees what was found before anything is saved. Posts go on the website only and are never
// emailed.
import { Button, ErrorNotice } from '@swarm/ui/components';
import { generateJSON, type JSONContent } from '@tiptap/core';
import { useRef, useState } from 'react';
import { api } from '../api/client';
import { dispatchExtensions, GATE_NODE } from '../editor/extensions';
import {
  readArchiveCsv,
  readExportZip,
  readZip,
  type ArchiveItem,
  type ArchiveRead,
} from '../imports/archive';
import { prepareExportHtml } from '../imports/exportHtml';
import { Section } from '../pages/common';

const BATCH = 10;

interface Result {
  slug: string;
  outcome: 'ready' | 'imported' | 'exists' | 'failed';
  message: string | null;
}

interface Prepared {
  slug: string;
  subject: string;
  lost: string[];
  payload: {
    subject: string;
    preheader: string;
    slug: string;
    publishedAt: string;
    visibility: ArchiveItem['visibility'];
    content: JSONContent;
  };
}

/** The post as the api takes it. A post for subscribers without a paywall break gets one first. */
function prepare(item: ArchiveItem): Prepared {
  const { html, lost } = prepareExportHtml(item.html);
  const content = generateJSON(html, dispatchExtensions({ gate: true }));
  const nodes = content.content ?? [];
  if (item.visibility !== 'public' && !nodes.some((node: JSONContent) => node.type === GATE_NODE)) {
    // Without a break, the website shows the whole post to everyone.
    content.content = [{ type: GATE_NODE }, ...nodes];
  }
  return {
    slug: item.slug,
    subject: item.subject,
    lost,
    payload: {
      subject: item.subject.slice(0, 200),
      preheader: item.preheader.slice(0, 200),
      slug: item.slug,
      publishedAt: item.publishedAt,
      visibility: item.visibility,
      content,
    },
  };
}

async function send(
  channelId: string,
  items: Prepared[],
  dryRun: boolean,
  step: (n: number) => void,
) {
  const results: Result[] = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const { results: done } = await api.post<{ results: Result[] }>(
      `/api/v1/channels/${channelId}/archive-import`,
      { dryRun, items: batch.map((item) => item.payload) },
    );
    results.push(...done);
    step(Math.min(i + BATCH, items.length));
  }
  return results;
}

export function ImportArchive({ channelId, admin }: { channelId: string; admin: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [read, setRead] = useState<ArchiveRead | null>(null);
  const [prepared, setPrepared] = useState<Prepared[]>([]);
  const [checked, setChecked] = useState<Result[] | null>(null);
  const [imported, setImported] = useState<Result[] | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const reset = () => {
    setRead(null);
    setPrepared([]);
    setChecked(null);
    setImported(null);
    setProblem(null);
  };

  const choose = async (file: File | undefined) => {
    reset();
    if (!file) return;
    try {
      const found = file.name.toLowerCase().endsWith('.zip')
        ? readExportZip(await readZip(await file.arrayBuffer()))
        : readArchiveCsv(await file.text());
      if (!found.items.length && !found.skipped.length) {
        throw new Error('No posts found in this file.');
      }
      const posts = found.items.map(prepare);
      setRead(found);
      setPrepared(posts);
      setProgress('Checking addresses');
      setChecked(posts.length ? await send(channelId, posts, true, () => {}) : []);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'That file could not be read.');
    } finally {
      setProgress(null);
      // So choosing the same file again, to import it again, is noticed.
      if (input.current) input.current.value = '';
    }
  };

  const start = async () => {
    if (!read) return;
    setProblem(null);
    try {
      const fresh = prepared.filter((item) =>
        checked?.some((r) => r.slug === item.slug && r.outcome === 'ready'),
      );
      const done = await send(channelId, fresh, false, (n) =>
        setProgress(`Imported ${n} of ${fresh.length}`),
      );
      setImported(done);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The import stopped.');
    } finally {
      setProgress(null);
    }
  };

  const count = (list: Result[] | null, outcome: Result['outcome']) =>
    list?.filter((r) => r.outcome === outcome).length ?? 0;
  const ready = count(checked, 'ready');
  const lost = prepared.flatMap((post) => post.lost.map((what) => `${post.subject}: ${what}`));

  if (!admin) return null;
  return (
    <div className="grid max-w-[820px] gap-5">
      <Section
        title="Import past issues"
        description="Bring your archive from another platform. Posts go on your website with their original dates, and nothing is emailed to anyone. Running an import twice is safe: an address already in use is left alone."
      >
        <div className="grid gap-4 text-[13.5px]">
          <p className="text-sub">
            Choose the .zip export from your old platform’s settings, if it holds a posts.csv and a
            folder of posts, or a .csv from any platform with a title, a date and the post’s HTML.
            Images stay on the old platform until you replace them, so keep that account until you
            have. Posts for subscribers only stay that way: if a post has no paywall break, readers
            without access see only its title.
          </p>
          <div>
            <label htmlFor="archive-file" className="mb-1.5 block font-semibold">
              Export file
            </label>
            <input
              ref={input}
              id="archive-file"
              type="file"
              accept=".zip,.csv"
              onChange={(event) => void choose(event.target.files?.[0])}
            />
          </div>
          {problem && <ErrorNotice message={problem} />}
          {progress && <p role="status">{progress}…</p>}
          {read && checked && !imported && (
            <div className="grid gap-2">
              <p>
                <strong>{ready}</strong> ready to import
                {count(checked, 'exists') > 0 && `, ${count(checked, 'exists')} already here`}
                {read.skipped.length > 0 && `, ${read.skipped.length} left out`}.
              </p>
              {read.skipped.length > 0 && (
                <details>
                  <summary className="cursor-pointer">What was left out</summary>
                  <ul className="mt-1 list-disc pl-5 text-sub">
                    {read.skipped.slice(0, 50).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </details>
              )}
              {lost.length > 0 && (
                <details>
                  <summary className="cursor-pointer">What won’t come across</summary>
                  <ul className="mt-1 list-disc pl-5 text-sub">
                    {lost.slice(0, 50).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </details>
              )}
              {ready > 0 && (
                <div>
                  <Button disabled={progress !== null} onClick={() => void start()}>
                    {ready === 1 ? 'Import 1 post' : `Import ${ready} posts`}
                  </Button>
                </div>
              )}
            </div>
          )}
          {imported && (
            <div role="status" className="grid gap-1">
              <p>
                <strong>{count(imported, 'imported')}</strong>{' '}
                {count(imported, 'imported') === 1 ? 'post' : 'posts'} imported. Nothing was
                emailed.
              </p>
              {count(imported, 'failed') > 0 && (
                <ul className="list-disc pl-5 text-sub">
                  {imported
                    .filter((r) => r.outcome === 'failed')
                    .slice(0, 20)
                    .map((r) => (
                      <li key={r.slug}>
                        {r.slug}: {r.message}
                      </li>
                    ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </Section>
    </div>
  );
}
