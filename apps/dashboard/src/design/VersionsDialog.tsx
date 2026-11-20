// Versions: the last published designs, newest first. Restore puts one into the draft (the live
// site doesn't change until Publish), says so in a toast, and Undo brings the draft back.
import type { Design } from '@swarm/site-themes';
import { Button, Dialog, ErrorNotice, LoadingRows } from '@swarm/ui/components';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { designApi, designQuery, designVersionsQuery, type DesignVersion } from '../api/design';
import { formatDateTime } from '../pages/common';
import { useToast } from '../shell/toast';
import { personName } from './draft';
import { useStudio } from './studio';

export function VersionsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { channelId, draft, themes, canEdit } = useStudio();
  const client = useQueryClient();
  const toast = useToast();
  const versions = useQuery({ ...designVersionsQuery(channelId), enabled: open });
  const [restoring, setRestoring] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const themeName = (id: string) => themes.find((t) => t.id === id)?.name ?? id;

  const restore = async (version: DesignVersion, latest: boolean) => {
    setRestoring(version.id);
    setProblem(null);
    const before: Design = draft.design;
    try {
      await draft.flush();
      await designApi.restore(channelId, version.id);
      const fresh = await client.fetchQuery({ ...designQuery(channelId), staleTime: 0 });
      draft.adopt(fresh.draft, fresh.problems);
      onClose();
      toast.show({
        message: latest
          ? 'The draft is back to what’s live.'
          : `The version from ${formatDateTime(version.publishedAt)} is in the draft. Publish to make it live.`,
        action: { label: 'Undo', onAction: () => draft.change(() => before) },
      });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The version wasn’t restored.');
    } finally {
      setRestoring(null);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Versions"
      description="Every publish is kept. Restoring one puts it into the draft; the live site changes when you publish."
      actions={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      {versions.isPending && <LoadingRows label="Loading versions" rows={3} />}
      {versions.error && (
        <ErrorNotice
          title="Versions didn’t load"
          message={versions.error.message}
          action={
            <Button variant="ghost" size="sm" onClick={() => void versions.refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {problem && <ErrorNotice title="Not restored" message={problem} />}
      {versions.data && versions.data.length === 0 && (
        <p className="text-[13.5px] text-sub">
          Nothing published yet. Each time you publish, the design is kept here.
        </p>
      )}
      {versions.data && versions.data.length > 0 && (
        <ol className="divide-y divide-line border-y border-line">
          {versions.data.map((version, index) => {
            const by = personName(version.publishedBy);
            return (
              <li key={version.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0 text-[13.5px]">
                  <p className="font-semibold">
                    {formatDateTime(version.publishedAt)}
                    {index === 0 && <span className="font-normal text-route"> · Live now</span>}
                  </p>
                  <p className="truncate text-[13px] text-sub">
                    {themeName(version.theme)}
                    {by ? ` · by ${by}` : ''}
                  </p>
                </div>
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={restoring === version.id}
                    disabled={!!restoring}
                    onClick={() => void restore(version, index === 0)}
                    aria-label={`Restore the version from ${formatDateTime(version.publishedAt)}`}
                  >
                    Restore
                  </Button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Dialog>
  );
}
