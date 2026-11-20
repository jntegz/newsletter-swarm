// Home, in the order it answers: what needs me, what's next, how the last send did, then growth
// and money, then sending health. First run shows the four-station setup route instead.
// Live data by default; ?preview=first-run | ready | established shows the sample states.
import type { Channel } from '@swarm/domain';
import { EmptyState, ErrorNotice, LoadingRows } from '@swarm/ui/components';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type MouseEvent, type ReactNode } from 'react';
import { useCreateDispatch, useVerifyDomain } from './api/send';
import { useCurrentChannel } from './channel';
import { AutomationList, FlowsMeter } from './flows/FlowsMeter';
import { LineChart, chartScale } from './home/LineChart';
import { formatDelta, formatPercentDelta } from './home/helpers';
import type { HomeModel, RateTrends, SetupStation } from './home/model';
import { NewPostMenu } from './home/NewPostMenu';
import { useLiveHome } from './home/useLiveHome';
import * as Icon from './icons';
import { PREVIEW_STATES, sampleHome, type PreviewState } from './preview';
import { WarmupCallout } from './send/WarmupCallout';
import { useSession } from './session';

const number = new Intl.NumberFormat('en-US');
/** Development builds always offer the sample states; production only with ?preview=. */
const SHOW_SAMPLES = import.meta.env.DEV;
const pct = (n: number, digits = 1) => `${(n * 100).toFixed(digits)}%`;

/** Same-app links from the model are plain addresses; this keeps them in the router. */
function useGo() {
  const navigate = useNavigate();
  return (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    void navigate({ href });
  };
}

function AppLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const go = useGo();
  return (
    <a href={href} className={className} onClick={go(href)}>
      {children}
    </a>
  );
}

function More({ href, children }: { href: string; children: ReactNode }) {
  return (
    <AppLink
      href={href}
      className="inline-flex items-center gap-0.5 text-[15px] font-semibold whitespace-nowrap text-purple no-underline hover:underline"
    >
      {children}
      <Icon.ChevronRight size={16} />
    </AppLink>
  );
}

function SampleTag() {
  return (
    <span className="rounded-pill border border-line px-2 py-0.5 text-[13px] whitespace-nowrap text-sub">
      Sample data
    </span>
  );
}

function H2({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2
      id={id}
      className="flex items-center gap-2.5 text-[17px] leading-[1.3] font-[650] tracking-[-0.005em]"
    >
      {children}
    </h2>
  );
}

function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <p className="max-w-[52ch] text-sub">
      <b className="mb-0.5 block font-semibold text-ink">{title}</b>
      {children}
    </p>
  );
}

// ---- Page --------------------------------------------------------------------------------------

export function OverviewPage({
  preview,
  onPreview,
}: {
  preview: PreviewState | undefined;
  onPreview: (state: PreviewState | undefined) => void;
}) {
  const { workspace, can } = useSession();
  const current = useCurrentChannel();

  if (current.isPending) return <LoadingRows label="Loading Home" rows={4} />;
  if (current.error) return <ErrorNotice message={current.error.message} />;
  if (!current.channel) {
    return (
      <div className="mx-auto max-w-[1184px]">
        <div className="pt-1 pb-6">
          <h1 className="page-title">Home</h1>
          <p className="mt-1.5 text-sub">Welcome to {workspace.name}.</p>
        </div>
        <EmptyState
          title="Create your first publication"
          action={
            can('admin') ? (
              <Link to="/channels/new" className="btn-primary btn-sm">
                Create publication
              </Link>
            ) : undefined
          }
        >
          {can('admin')
            ? 'A publication is one newsletter. After that: connect a sending domain, bring your subscribers and write your first post.'
            : 'An admin needs to create a publication before there is anything to work on.'}
        </EmptyState>
      </div>
    );
  }
  return preview ? (
    <Home
      model={sampleHome(preview)}
      channel={current.channel}
      preview={preview}
      onPreview={onPreview}
    />
  ) : (
    <LiveHome channel={current.channel} onPreview={onPreview} />
  );
}

function LiveHome({
  channel,
  onPreview,
}: {
  channel: Channel;
  onPreview: (state: PreviewState | undefined) => void;
}) {
  const live = useLiveHome(channel);
  if (live.error) return <ErrorNotice message={live.error.message} />;
  if (!live.model) return <LoadingRows label="Loading Home" rows={5} />;
  return <Home model={live.model} channel={channel} preview={undefined} onPreview={onPreview} />;
}

function Home({
  model,
  channel,
  preview,
  onPreview,
}: {
  model: HomeModel;
  channel: Channel;
  preview: PreviewState | undefined;
  onPreview: (state: PreviewState | undefined) => void;
}) {
  const setup = model.mode === 'setup';
  return (
    <div className="mx-auto max-w-[1184px] [container-type:inline-size]">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 pt-1 pb-6">
        <div>
          <h1 className="page-title">Home</h1>
          <p className="mt-1.5 text-sub">{model.subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {preview && <SampleTag />}
          {/* The sample states are for development and reviews, never shown to real users. */}
          {(SHOW_SAMPLES || preview) && <ShowSwitch value={preview} onChange={onPreview} />}
          <NewPostMenu channel={channel} />
        </div>
      </div>

      {/* A paused warm-up stops every send, so it comes before everything else. */}
      {model.warmup?.tone === 'paused' && (
        <WarmupCallout note={model.warmup} channelId={channel.id} className="mb-6" />
      )}

      {setup && <SetupBand model={model} channel={channel} sample={!!preview} />}

      {model.warmup?.tone === 'info' && (
        <WarmupCallout
          note={model.warmup}
          channelId={channel.id}
          className={setup ? 'mt-6' : 'mb-6'}
        />
      )}

      <div
        className={`grid gap-x-14 gap-y-8 pb-8 @min-[620px]:grid-cols-2 ${setup ? 'pt-7' : 'border-t border-line pt-6'}`}
      >
        <NeedsYou model={model} />
        <UpNext model={model} />
      </div>

      {!setup && <LastSendBand model={model} />}
      <LastSends model={model} />
      <GrowRow model={model} />
      <Health model={model} />
    </div>
  );
}

/**
 * A development tool, never shown to real users: Home with the reader's data or a sample state.
 * Drawn dashed and small, as a tool, so it can't be mistaken for part of the page.
 */
function ShowSwitch({
  value,
  onChange,
}: {
  value: PreviewState | undefined;
  onChange: (state: PreviewState | undefined) => void;
}) {
  const options: { id: PreviewState | undefined; label: string }[] = [
    { id: undefined, label: 'Your data' },
    ...PREVIEW_STATES,
  ];
  return (
    <label className="inline-flex min-h-9 items-center gap-2 rounded-control border border-dashed border-line-control py-1 pr-1 pl-2.5 text-[13px] text-sub">
      <span className="whitespace-nowrap">Development preview</span>
      <select
        name="home-show"
        value={value ?? ''}
        onChange={(event) =>
          onChange((event.target.value || undefined) as PreviewState | undefined)
        }
        className="h-7 rounded-[6px] border border-line bg-surface pl-2 text-[13px] font-semibold text-ink"
      >
        {options.map((option) => (
          <option key={option.label} value={option.id ?? ''}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// ---- Setup route -------------------------------------------------------------------------------

function SetupBand({
  model,
  channel,
  sample,
}: {
  model: HomeModel;
  channel: Channel;
  sample: boolean;
}) {
  const { stations, dmarc } = model.setup;
  const current = stations.findIndex((s) => !s.done);
  const done = stations.filter((s) => s.done).length;
  return (
    <section
      aria-labelledby="setup-title"
      className="line-band border-y border-line pt-[22px] pb-6"
    >
      <div className="mb-[22px] flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <H2 id="setup-title">Four steps to your first send. About ten minutes.</H2>
        <p className="text-[13px] text-sub">
          {done} of {stations.length} done
        </p>
      </div>
      <ol className="line-route line-route-setup">
        {stations.map((station, i) => {
          const state = station.done ? 'is-done' : i === current ? 'is-now' : 'is-future';
          return (
            <li
              key={station.id}
              className={`${state} ${i >= current && current !== -1 ? 'is-ahead' : ''}`}
              aria-current={i === current ? 'step' : undefined}
            >
              <span className="line-mk" aria-hidden="true">
                {station.done && <Icon.Check size={13} strokeWidth={3} />}
              </span>
              <h3
                className={`text-[15px] leading-[1.35] font-[650] ${state === 'is-future' ? 'text-sub' : ''}`}
              >
                {station.title}
                <span className="sr-only">
                  {station.done ? ' (done)' : i === current ? ' (current step)' : ' (to do)'}
                </span>
              </h3>
              {station.done && (
                <span className="mt-0.5 block text-[13px] font-semibold text-success">Done</span>
              )}
              {i === current ? (
                <CurrentStation
                  station={station}
                  dmarc={dmarc}
                  model={model}
                  channel={channel}
                  sample={sample}
                />
              ) : (
                <p className="mt-1 text-[13px] text-sub">{station.summary}</p>
              )}
              {/* DNS can take a while: subscribers and the first post don't have to wait for it. */}
              {station.id === 'subscribers' && !station.done && i !== current && (
                <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
                  <AppLink href={model.links.import} className="font-semibold text-purple">
                    Import subscribers
                  </AppLink>
                  <AppLink href={model.links.forms} className="font-semibold text-purple">
                    Add a signup form
                  </AppLink>
                </p>
              )}
              {station.id === 'post' && !station.done && i !== current && (
                <WriteFirstPost channel={channel} small />
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function CurrentStation({
  station,
  dmarc,
  model,
  channel,
  sample,
}: {
  station: SetupStation;
  dmarc: HomeModel['setup']['dmarc'];
  model: HomeModel;
  channel: Channel;
  sample: boolean;
}) {
  if (station.id === 'dmarc' && dmarc) {
    return (
      <DmarcAction dmarc={dmarc} summary={station.summary} channel={channel} sample={sample} />
    );
  }
  return (
    <div className="mt-2.5 rounded-card bg-surface-alt p-4">
      <p className="mb-3 text-[15px]">{station.summary}</p>
      {station.id === 'domain' && (
        <AppLink href={model.links.sending} className="btn-ghost btn-sm">
          Add a sending domain
        </AppLink>
      )}
      {station.id === 'dmarc' && (
        <AppLink href={model.links.sending} className="btn-ghost btn-sm">
          Open Sending &amp; delivery
        </AppLink>
      )}
      {station.id === 'subscribers' && (
        <div className="flex flex-wrap gap-2">
          <AppLink href={model.links.import} className="btn-ghost btn-sm">
            Import subscribers
          </AppLink>
          <AppLink href={model.links.forms} className="btn-ghost btn-sm">
            Add a signup form
          </AppLink>
        </div>
      )}
      {station.id === 'post' && <WriteFirstPost channel={channel} />}
    </div>
  );
}

function WriteFirstPost({ channel, small }: { channel: Channel; small?: boolean }) {
  const create = useCreateDispatch(channel.id);
  const navigate = useNavigate();
  return (
    <>
      <button
        type="button"
        className={`${small ? 'btn-ghost mt-3' : 'btn-primary'} btn-sm`}
        aria-busy={create.isPending || undefined}
        onClick={() =>
          create.mutate(
            {},
            {
              onSuccess: (d) =>
                void navigate({ to: '/dispatches/$dispatchId', params: { dispatchId: d.id } }),
            },
          )
        }
      >
        {create.isPending ? 'Creating…' : 'Write your first post'}
      </button>
      {create.error && (
        <p role="alert" className="mt-2 text-[13px] text-danger">
          {create.error.message}
        </p>
      )}
    </>
  );
}

function DmarcAction({
  dmarc,
  summary,
  channel,
  sample,
}: {
  dmarc: NonNullable<HomeModel['setup']['dmarc']>;
  summary: string;
  channel: Channel;
  sample: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState('DNS changes can take up to an hour to appear.');
  const verify = useVerifyDomain(channel.id);
  const now = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(dmarc.value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setNote('Copying isn’t allowed here. Select the value and copy it by hand.');
    }
  };

  const check = () => {
    if (sample || !dmarc.domainId) {
      setNote(`Checked at ${now()}: still p=none. DNS changes can take up to an hour to appear.`);
      return;
    }
    verify.mutate(dmarc.domainId, {
      onSuccess: (domain) =>
        setNote(
          domain.dmarcPolicy === 'quarantine' || domain.dmarcPolicy === 'reject'
            ? `Checked at ${now()}: p=${domain.dmarcPolicy} found.`
            : `Checked at ${now()}: still ${domain.dmarcPolicy ? `p=${domain.dmarcPolicy}` : 'no record'}. DNS changes can take up to an hour to appear.`,
        ),
      onError: (error) => setNote(`The check didn’t run: ${error.message}`),
    });
  };

  return (
    <div className="mt-2.5 rounded-card bg-surface-alt p-4">
      <p className="mb-3 text-[15px]">{summary}</p>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3.5 gap-y-1.5 text-[13px]">
        <dt className="pt-[5px] text-sub">Host</dt>
        <dd className="rounded-[6px] border border-line bg-surface px-2 py-1 font-mono [overflow-wrap:anywhere]">
          {dmarc.host}
        </dd>
        <dt className="pt-[5px] text-sub">Value</dt>
        <dd className="rounded-[6px] border border-line bg-surface px-2 py-1 font-mono [overflow-wrap:anywhere]">
          {dmarc.value}
        </dd>
      </dl>
      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <button type="button" className="btn-ghost btn-sm" onClick={() => void copy()}>
          {copied ? <Icon.Check size={16} /> : <Icon.Copy size={16} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          className="btn-ghost btn-sm"
          aria-busy={verify.isPending || undefined}
          onClick={check}
        >
          <Icon.Refresh size={16} />
          {verify.isPending ? 'Checking…' : 'Check again'}
        </button>
        <p role="status" className="mt-1 basis-full text-[13px] text-sub">
          {note}
        </p>
      </div>
    </div>
  );
}

// ---- Needs you / Up next -----------------------------------------------------------------------

function NeedsYou({ model }: { model: HomeModel }) {
  const setup = model.mode === 'setup';
  const first = model.needs[0];
  return (
    <section aria-labelledby="needs-title">
      <H2 id="needs-title">
        {model.needs.length > 0 && (
          <span
            aria-hidden="true"
            className="relative size-4 shrink-0 rounded-full bg-signal after:absolute after:inset-[5px] after:rounded-full after:bg-rail"
          />
        )}
        Needs you
      </H2>
      {first ? (
        <ul className="mt-3.5 grid gap-5">
          {model.needs.slice(0, 3).map((need) => (
            <li key={need.id}>
              <b className="font-[650]">{need.title}</b>
              <p className="mt-0.5 text-sub">{need.detail}</p>
              {need.action && (
                <AppLink href={need.action.href} className="btn-ghost mt-3.5">
                  {need.action.label}
                </AppLink>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-3.5">
          <Empty title={setup ? 'Only the setup step above.' : 'Nothing right now.'}>
            Problems with a send, a form or your domain will show here, one line each, with the fix
            next to them.
          </Empty>
        </div>
      )}
    </section>
  );
}

function UpNext({ model }: { model: HomeModel }) {
  return (
    <section aria-labelledby="next-title">
      <div className="mb-3.5 flex items-baseline justify-between gap-3">
        <H2 id="next-title">Up next</H2>
        <More href={model.links.posts}>All posts</More>
      </div>
      {model.upNext.length ? (
        <ol>
          {model.upNext.map((item) => (
            <li
              key={item.id}
              className="grid grid-cols-[124px_minmax(0,1fr)] gap-4 border-t border-line py-3 last:border-b"
            >
              {item.when.kind === 'scheduled' ? (
                <time
                  dateTime={item.when.iso}
                  className="pt-0.5 text-[13px] leading-[1.4] text-sub"
                >
                  <b className="block text-[15px] font-semibold text-ink">{item.when.day}</b>
                  {item.when.time}
                </time>
              ) : (
                <span className="pt-0.5 text-[13px] leading-[1.4] text-sub">
                  <b className="block text-[15px] font-semibold text-ink">Draft</b>
                  {item.when.edited}
                </span>
              )}
              <div className="min-w-0">
                {item.href ? (
                  <AppLink
                    href={item.href}
                    className="font-semibold text-ink no-underline hover:underline"
                  >
                    {item.title}
                  </AppLink>
                ) : (
                  <span className="font-semibold">{item.title}</span>
                )}
                <p className="mt-0.5 text-[13px] text-sub">{item.meta}</p>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <Empty title="Nothing scheduled yet.">
          Scheduled posts and drafts in progress show here with their send time.
        </Empty>
      )}
    </section>
  );
}

// ---- Last send ---------------------------------------------------------------------------------

function LastSendBand({ model }: { model: HomeModel }) {
  const send = model.lastSend;
  if (!send) {
    return (
      <section aria-labelledby="last-title" className="border-y border-line pt-[22px] pb-6">
        <H2 id="last-title">Last send</H2>
        <p className="mt-2 text-sub">Loading the results of your last send…</p>
      </section>
    );
  }
  const stations = [
    { label: 'Queued', value: send.queued, rate: null, note: 'recipients' },
    {
      label: 'Delivered',
      value: send.delivered,
      rate: send.delivered / Math.max(1, send.queued),
      note: 'of queued',
    },
    {
      label: 'Opened',
      value: send.opened,
      rate: send.opened / Math.max(1, send.delivered),
      note: 'unique',
    },
    {
      label: 'Clicked',
      value: send.clicked,
      rate: send.clicked / Math.max(1, send.delivered),
      note: 'of delivered',
    },
  ];
  return (
    <section aria-labelledby="last-title" className="line-band border-y border-line pt-[22px] pb-6">
      <div className="mb-[22px] flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <H2 id="last-title">Last send</H2>
          <p className="text-sub">
            {send.href ? (
              <AppLink
                href={send.href}
                className="font-semibold text-ink no-underline hover:underline"
              >
                {send.title}
              </AppLink>
            ) : (
              <b className="font-semibold text-ink">{send.title}</b>
            )}
            {send.sentAt && ` · ${send.sentAt}`}
          </p>
        </div>
        <More href={send.reportHref ?? model.links.reports}>Send report</More>
      </div>
      <ol className="line-route line-route-est" aria-label="From queued to clicked">
        {stations.map((s) => (
          <li key={s.label}>
            <span className="line-mk" aria-hidden="true" />
            <span className="line-fig block text-[28px] leading-[1.1] font-semibold tracking-[-0.01em]">
              {number.format(s.value)}
            </span>
            <span className="mt-1.5 block text-sub @max-[560px]:mt-0 @max-[560px]:font-semibold @max-[560px]:text-ink">
              {s.label}
            </span>
            <span className="block text-[13px] font-semibold">
              {s.rate !== null && `${pct(s.rate)} `}
              <span className="font-normal text-sub">{s.note}</span>
            </span>
          </li>
        ))}
      </ol>
      <dl className="mt-[26px] grid gap-x-6 gap-y-2.5 border-t border-line pt-4 text-[13px] @min-[560px]:grid-cols-[max-content_1fr]">
        {model.placement && (
          <>
            <dt className="text-sub">{model.placement.note}</dt>
            <dd className="mb-2 flex flex-wrap gap-x-6 gap-y-1 @min-[560px]:mb-0">
              {model.placement.items.map((p) => (
                <span key={p.label}>
                  {p.label} <b className="font-semibold">{pct(p.rate)}</b>
                </span>
              ))}
            </dd>
          </>
        )}
        <dt className="text-sub">Lost from this send</dt>
        <dd className="flex flex-wrap gap-x-6 gap-y-1">
          {[
            ['Bounced', send.bounced, send.bounced / Math.max(1, send.queued)],
            ['Unsubscribed', send.unsubscribed, null],
            ['Spam complaints', send.complained, null],
          ].map(([label, value, rate]) => (
            <span key={label as string} className="inline-flex items-center gap-2">
              <span
                aria-hidden="true"
                className="size-[9px] rounded-full border-2 border-line-control"
              />
              {label as string} <b className="font-semibold">{number.format(value as number)}</b>
              {typeof rate === 'number' && ` (${pct(rate)})`}
            </span>
          ))}
        </dd>
      </dl>
    </section>
  );
}

const deltaTone = (delta: number) =>
  delta > 0 ? 'text-success' : delta < 0 ? 'text-danger' : 'text-sub';

/** Opens and clicks over the latest sends; the change appears once there are sends before them. */
function RateSummary({ rates }: { rates: RateTrends }) {
  const compared = rates.opens.delta !== null || rates.clicks.delta !== null;
  const facts = [
    ['Opens', rates.opens],
    ['Clicks', rates.clicks],
  ] as const;
  return (
    <p className="mb-3.5 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-sub">
      <span>
        {rates.sends === 1 ? 'Last send' : `Last ${rates.sends} sends`}
        {compared && ', against the sends before'}
      </span>
      {facts.map(([label, trend]) => (
        <span key={label}>
          {label} <b className="font-semibold text-ink">{pct(trend.value)}</b>
          {trend.delta !== null && (
            <>
              {' '}
              <span className={`font-semibold ${deltaTone(trend.delta)}`}>
                {formatDelta(trend.delta, 'points')}
              </span>
            </>
          )}
        </span>
      ))}
    </p>
  );
}

function LastSends({ model }: { model: HomeModel }) {
  const sends = model.sends;
  const established = model.mode === 'established';
  const open = sends.map((s) => s.open);
  const click = sends.map((s) => s.click);
  const openScale = sends.length ? chartScale(open, 4) : null;
  const clickScale = sends.length ? chartScale(click, 1) : null;
  const first = sends[0];
  const last = sends[sends.length - 1];
  return (
    <section
      aria-labelledby="sends-title"
      className={`py-6 pb-8 ${established ? '' : 'border-t border-line'}`}
    >
      <div className="mb-3.5 flex items-baseline justify-between gap-3">
        <H2 id="sends-title">{sends.length > 1 ? `Last ${sends.length} sends` : 'Recent sends'}</H2>
        {established && <More href={model.links.reports}>All posts</More>}
      </div>
      {model.rates && sends.length > 0 && <RateSummary rates={model.rates} />}
      {sends.length === 0 ? (
        <Empty title="Results appear after your first send.">
          Each send adds a stop here: delivered, opened and clicked, so you can see a trend after a
          few issues.
        </Empty>
      ) : (
        <div className="grid gap-x-12 gap-y-6 @min-[820px]:grid-cols-[minmax(0,1fr)_300px]">
          {sends.length > 1 && openScale && clickScale && first && last ? (
            <figure className="m-0">
              <div className="mb-0.5 flex justify-between text-[13px] text-sub">
                <b className="font-semibold text-ink">Unique open rate</b>
                <span>
                  scale {openScale.min}–{openScale.max}%
                </span>
              </div>
              <LineChart
                values={open}
                {...openScale}
                format={(t) => `${t}%`}
                lastLabel={`${last.open.toFixed(1)}%`}
                label={`Unique open rate over the last ${sends.length} sends, from ${first.open.toFixed(1)}% to ${last.open.toFixed(1)}%`}
              />
              <div className="mt-2.5 mb-0.5 flex justify-between text-[13px] text-sub">
                <b className="font-semibold text-ink">Click rate</b>
                <span>
                  scale {clickScale.min}–{clickScale.max}%
                </span>
              </div>
              <LineChart
                values={click}
                {...clickScale}
                format={(t) => `${t}%`}
                lastLabel={`${last.click.toFixed(1)}%`}
                xLabels={sends.map((s) => s.label)}
                label={`Click rate over the last ${sends.length} sends, from ${first.click.toFixed(1)}% to ${last.click.toFixed(1)}%`}
              />
              <figcaption className="mt-3 text-[13px] text-sub">
                Oldest on the left. Each chart has its own scale so both trends stay readable;
                machine opens from privacy proxies are left out.
              </figcaption>
            </figure>
          ) : (
            <p className="text-sub">The trend draws from your second send on.</p>
          )}
          <table className="w-full border-collapse text-[13px]">
            <caption className="sr-only">Open and click rate per send</caption>
            <thead>
              <tr>
                <th scope="col" className="pb-1.5 text-left font-semibold text-sub">
                  Send
                </th>
                <th scope="col" className="pb-1.5 text-right font-semibold text-sub">
                  Opens
                </th>
                <th scope="col" className="pb-1.5 text-right font-semibold text-sub">
                  Clicks
                </th>
              </tr>
            </thead>
            <tbody>
              {sends.map((s, i) => (
                <tr key={`${s.name}-${i}`} className={i === sends.length - 1 ? 'font-bold' : ''}>
                  <td className="border-t border-line py-[5px] pr-2 text-left leading-[1.35]">
                    {s.name !== s.label && (
                      <span className="block font-normal text-sub">{s.label}</span>
                    )}
                    <span className="line-clamp-2 [overflow-wrap:anywhere]" title={s.name}>
                      {s.name}
                    </span>
                  </td>
                  <td className="border-t border-line py-[5px] text-right align-top tabular-nums">
                    {s.open.toFixed(1)}%
                  </td>
                  <td className="border-t border-line py-[5px] pl-3 text-right align-top tabular-nums">
                    {s.click.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---- Growth and money --------------------------------------------------------------------------

function GrowRow({ model }: { model: HomeModel }) {
  const subs = model.subscribers;
  const setup = model.mode === 'setup';
  const cell = 'min-w-0 py-6 @min-[620px]:px-7';
  return (
    <div className="grid border-t border-line @min-[620px]:grid-cols-2 @min-[820px]:grid-cols-[6fr_3fr_3fr]">
      <section
        aria-labelledby="subs-title"
        className={`${cell} @min-[620px]:col-span-2 @min-[620px]:pl-0 @min-[820px]:col-span-1`}
      >
        <div className="mb-3.5 flex items-baseline justify-between gap-3">
          <H2 id="subs-title">Subscribers</H2>
          <More href={model.links.subscribers}>All subscribers</More>
        </div>
        {subs ? (
          <>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-[28px] leading-[1.1] font-semibold tracking-[-0.01em]">
                {number.format(subs.total)}
              </span>
              {subs.delta ? (
                <span className={`text-[13px] font-semibold ${deltaTone(subs.delta.count)}`}>
                  {formatDelta(subs.delta.count, 'count')}
                  {subs.delta.pct !== null && ` · ${formatPercentDelta(subs.delta.pct)}`}{' '}
                  <span className="font-normal text-sub">vs 30 days ago</span>
                </span>
              ) : (
                <span className="text-[13px] text-sub">active now</span>
              )}
            </div>
            {subs.trend && subs.trend.length > 1 && (
              <div className="mt-3 mb-1">
                <LineChart
                  values={subs.trend}
                  {...chartScale(subs.trend, 150)}
                  format={(t) => number.format(t)}
                  dots={false}
                  height={120}
                  lastLabel={number.format(subs.trend[subs.trend.length - 1] ?? 0)}
                  xLabels={subs.trend.map((_, i, all) =>
                    i === 0 ? '30 days ago' : i === all.length - 1 ? 'Today' : '',
                  )}
                  label={`Subscribers over the last 30 days, from ${number.format(subs.trend[0] ?? 0)} to ${number.format(subs.trend[subs.trend.length - 1] ?? 0)}`}
                />
              </div>
            )}
            {subs.note && <p className="mt-2.5 max-w-[52ch] text-sub">{subs.note}</p>}
            {subs.facts.length > 0 && (
              <dl className="mt-3.5 grid grid-cols-2 gap-x-5 gap-y-3 border-t border-line pt-3.5 @min-[620px]:grid-cols-3">
                {subs.facts.map((fact) => (
                  <div key={fact.label}>
                    <dt className="text-[13px] text-sub">{fact.label}</dt>
                    <dd className="mt-0.5 font-semibold">
                      {fact.value}
                      {fact.note && (
                        <span className="block text-[13px] font-normal text-sub">{fact.note}</span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {setup && (
              <AppLink href={model.links.forms} className="btn-ghost btn-sm mt-3.5">
                Add a signup form
              </AppLink>
            )}
          </>
        ) : (
          <p className="text-sub">Subscriber counts aren’t available right now.</p>
        )}
      </section>

      <section
        aria-labelledby="auto-title"
        className={`${cell} border-t border-line @min-[620px]:pl-0 @min-[820px]:border-t-0 @min-[820px]:border-l @min-[820px]:pl-7`}
      >
        <div className="mb-3.5">
          <H2 id="auto-title">Automations</H2>
        </div>
        {model.automations === 'live' ? (
          <FlowsMeter />
        ) : model.automations.length ? (
          <AutomationList rows={model.automations} />
        ) : (
          <Empty title="None running yet.">
            A welcome series is the usual first one. It greets each new subscriber over their first
            week.
          </Empty>
        )}
      </section>

      <div className="min-w-0 border-t border-line @min-[620px]:border-l @min-[620px]:pl-7 @min-[820px]:border-t-0 @min-[820px]:pr-0">
        {/* Once a publication has sent, referrals show only with real figures. */}
        {(setup || model.referrals) && (
          <section aria-labelledby="ref-title" className="border-b border-line py-6">
            <H2 id="ref-title">Referrals</H2>
            {model.referrals && !setup ? (
              <>
                <div className="mt-2.5">
                  <span className="text-[22px] font-semibold">
                    {number.format(model.referrals.came)}
                  </span>
                  <p className="text-[13px] text-sub">new subscribers came from referrals</p>
                </div>
                <div className="mt-3">
                  <span className="text-[22px] font-semibold">
                    {number.format(model.referrals.referred)}
                  </span>
                  <p className="text-[13px] text-sub">subscribers referred someone this month</p>
                </div>
              </>
            ) : (
              <p className="mt-2 text-[13px] text-sub">
                Referral links go out with your first send.
              </p>
            )}
          </section>
        )}
        <section aria-labelledby="paid-title" className="py-6">
          <H2 id="paid-title">Paid subscriptions</H2>
          {model.paid === null ? (
            <p className="mt-2 text-[13px] text-sub">Loading…</p>
          ) : model.paid === 'error' ? (
            <p className="mt-2 text-[13px] text-sub">
              Revenue could not be loaded. Refresh the page to try again.
            </p>
          ) : model.paid === 'off' ? (
            <p className="mt-2 text-[13px] text-sub">
              Off for now. Connect Stripe when you want paid plans; Swarm takes no fee.{' '}
              <AppLink href={model.links.paid} className="font-semibold text-purple">
                Set up paid subscriptions
              </AppLink>
            </p>
          ) : (
            <>
              <div className="mt-2.5">
                <span className="text-[22px] font-semibold">{model.paid.mrr}</span>
                <span className="text-[13px] text-sub"> /mo</span>
                <p className="text-[13px] text-sub">
                  {number.format(model.paid.paid)} paid subscriber{model.paid.paid === 1 ? '' : 's'}
                  {model.paid.delta ? (
                    <>
                      ,{' '}
                      <span className="font-semibold text-success">
                        +{number.format(model.paid.delta)}
                      </span>{' '}
                      in the last 30 days
                    </>
                  ) : null}
                </p>
              </div>
              <p className="mt-2 text-[13px] text-sub">{model.paid.note}</p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function Health({ model }: { model: HomeModel }) {
  return (
    <section
      aria-labelledby="health-title"
      className="flex flex-col items-start gap-x-7 gap-y-2.5 border-y border-line py-[18px] @min-[620px]:flex-row @min-[620px]:flex-wrap @min-[620px]:items-center"
    >
      <H2 id="health-title">Sending health</H2>
      <ul className="flex flex-1 flex-col gap-x-6 gap-y-2 @min-[620px]:flex-row @min-[620px]:flex-wrap">
        {model.health.map((item) => (
          <li
            key={item.text}
            className={`inline-flex items-center gap-[7px] text-[13px] ${
              item.tone === 'warn' ? 'rounded-[6px] bg-warn-soft px-2 py-0.5 text-warn' : ''
            }`}
          >
            {item.tone === 'ok' && (
              <Icon.Check size={16} strokeWidth={2.5} className="text-success" />
            )}
            {item.tone === 'warn' && <Icon.Alert size={16} />}
            {item.tone === 'wait' && <Icon.Clock size={16} className="text-sub" />}
            <span className="sr-only">
              {item.tone === 'ok'
                ? 'OK: '
                : item.tone === 'warn'
                  ? 'Needs attention: '
                  : 'Not yet: '}
            </span>
            {item.text}
          </li>
        ))}
      </ul>
      <More href={model.links.sending}>Sending &amp; delivery</More>
    </section>
  );
}
