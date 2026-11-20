// The Member drawer's Champion panel: their share links and how their referrals are doing.
import { ErrorNotice, LoadingRows } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { memberChampionQuery } from '../api/growth';
import { numberFormat } from '../pages/common';

export function MemberChampionPanel({
  channelId,
  memberId,
}: {
  channelId: string;
  memberId: string;
}) {
  const champion = useQuery(memberChampionQuery(channelId, memberId));
  const id = useId();
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (url: string) => {
    void navigator.clipboard
      ?.writeText(url)
      .then(() => setCopied(url))
      .catch(() => setCopied(null));
  };
  const data = champion.data;
  return (
    <section aria-labelledby={id} className="border-t border-line pt-4">
      <h3 id={id} className="mb-3 text-[14px] font-semibold">
        Referrals
      </h3>
      {champion.isPending && <LoadingRows label="Loading referrals" rows={1} />}
      {champion.error && <ErrorNotice message={champion.error.message} />}
      {data && (
        <div className="grid gap-3 text-[13.5px]">
          <dl className="grid grid-cols-4 gap-2 text-center">
            {(
              [
                ['Counted', data.counted],
                ['Waiting', data.pending],
                ['Held', data.held],
                ['Rejected', data.rejected],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="rounded-card-app bg-surface-alt px-2 py-2">
                <dt className="text-[11px] text-sub">{label}</dt>
                <dd className="tabular text-[17px] font-bold">{numberFormat.format(value)}</dd>
              </div>
            ))}
          </dl>
          <p>
            Code <span className="font-mono text-[12.5px]">{data.code}</span>
            {data.awards > 0 && (
              <span className="text-sub">
                {' '}
                · {data.awards} award{data.awards === 1 ? '' : 's'}
              </span>
            )}
          </p>
          {data.nextMilestone && (
            <p className="text-sub">
              {numberFormat.format(data.nextMilestone.remaining)} more to reach “
              {data.nextMilestone.name}”.
            </p>
          )}
          {(
            [
              ['Share link', data.shareUrl],
              ['Short link', data.shortUrl],
            ] as const
          ).map(([label, url]) => (
            <div key={label} className="flex items-center gap-2">
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] text-sub">{label}</span>
                <span className="block truncate font-mono text-[12.5px]">{url}</span>
              </span>
              <button type="button" onClick={() => copy(url)} className="btn-ghost btn-sm shrink-0">
                {copied === url ? 'Copied' : 'Copy'}
                <span className="sr-only"> {label.toLowerCase()}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
