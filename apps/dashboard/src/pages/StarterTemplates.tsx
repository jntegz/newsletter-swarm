// Starters: the templates that ship with Swarm, shown on the Templates page above the ones a
// team saved itself. Each has a preview in the publication's own email design; "Use" makes an
// ordinary draft post from it, which the writer then owns and edits like any other.
import type { Channel, StarterTemplateKey, StarterTemplateSummary } from '@swarm/domain';
import { Button, ErrorNotice, LoadingRows } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { starterTemplateQuery, starterTemplatesQuery, useUseStarterTemplate } from '../api/flows';

export function StarterTemplates({ channel, canWrite }: { channel: Channel; canWrite: boolean }) {
  const starters = useQuery(starterTemplatesQuery(channel.id));
  const use = useUseStarterTemplate();
  const navigate = useNavigate();
  const [previewing, setPreviewing] = useState<StarterTemplateKey | null>(null);
  const shown = starters.data?.find((s) => s.key === previewing) ?? null;

  const start = (key: StarterTemplateKey) =>
    use.mutate(
      { key, channelId: channel.id },
      {
        onSuccess: (d) =>
          void navigate({ to: '/dispatches/$dispatchId', params: { dispatchId: d.id } }),
      },
    );
  const starting = (key: StarterTemplateKey) => use.isPending && use.variables?.key === key;

  return (
    <section aria-labelledby="starters-heading" className="mb-8">
      <h2 id="starters-heading" className="text-[15px] font-semibold">
        Starters
      </h2>
      <p className="mt-0.5 mb-3 max-w-[64ch] text-[13px] text-sub">
        Ready-made posts that come with Swarm. Each one is written as a guide to itself: use it,
        then replace the words with your own.
      </p>
      {use.error && (
        <div className="mb-3">
          <ErrorNotice title="The draft wasn’t created" message={use.error.message} />
        </div>
      )}
      {starters.isPending && <LoadingRows label="Loading starters" />}
      {starters.error && (
        <ErrorNotice
          message={starters.error.message}
          action={
            <Button variant="ghost" onClick={() => void starters.refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {starters.data && (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {starters.data.map((starter) => (
            <li key={starter.key} className="card-app flex flex-col p-4">
              <h3 className="text-[14px] font-semibold">{starter.name}</h3>
              <p className="mt-1 flex-1 text-[13px] leading-snug text-sub">{starter.description}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {canWrite && (
                  <Button
                    size="sm"
                    loading={starting(starter.key)}
                    disabled={use.isPending}
                    onClick={() => start(starter.key)}
                  >
                    Use<span className="sr-only"> {starter.name}</span>
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={previewing === starter.key}
                  aria-controls="starter-preview"
                  onClick={() => setPreviewing(previewing === starter.key ? null : starter.key)}
                >
                  {previewing === starter.key ? 'Hide preview' : 'Preview'}
                  <span className="sr-only"> of {starter.name}</span>
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div id="starter-preview">
        {shown && (
          <StarterPreview
            channel={channel}
            starter={shown}
            action={
              <>
                {canWrite && (
                  <Button
                    size="sm"
                    loading={starting(shown.key)}
                    disabled={use.isPending}
                    onClick={() => start(shown.key)}
                  >
                    Use this starter
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => setPreviewing(null)}>
                  Close preview
                </Button>
              </>
            }
          />
        )}
      </div>
    </section>
  );
}

/** A starter's suggested subject and preview text, and the email as this publication sends it. */
export function StarterPreview({
  channel,
  starter,
  action,
}: {
  channel: Channel;
  starter: StarterTemplateSummary;
  action?: ReactNode;
}) {
  const full = useQuery(starterTemplateQuery(channel.id, starter.key));
  return (
    <div className="card-app mt-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold">{starter.name}: preview</h3>
          <dl className="mt-1 grid gap-0.5 text-[13px] text-sub">
            <div className="flex gap-1.5">
              <dt className="shrink-0 font-semibold">Suggested subject</dt>
              <dd className="min-w-0">{starter.subject}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="shrink-0 font-semibold">Preview text</dt>
              <dd className="min-w-0">{starter.preheader}</dd>
            </div>
          </dl>
        </div>
        <div className="flex flex-wrap gap-1.5">{action}</div>
      </div>
      <div className="mt-3 overflow-hidden rounded-control border border-line">
        {full.isPending && (
          <div className="p-4">
            <LoadingRows label="Loading the preview" />
          </div>
        )}
        {full.error && (
          <div className="p-4">
            <ErrorNotice
              message={full.error.message}
              action={
                <Button variant="ghost" onClick={() => void full.refetch()}>
                  Try again
                </Button>
              }
            />
          </div>
        )}
        {full.data && (
          // No scripts, forms or same-origin access: the preview can never act on the dashboard.
          <iframe
            title={`Email preview of ${starter.name}`}
            sandbox=""
            srcDoc={full.data.html}
            className="block h-[min(640px,70vh)] w-full bg-white"
          />
        )}
      </div>
      <p className="mt-2 text-[12.5px] text-sub">
        Shown in the email design of {channel.name}. Links in a starter point at example.com until
        you change them.
      </p>
    </div>
  );
}
