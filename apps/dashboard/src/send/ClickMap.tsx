import type { ClickMapView } from '@swarm/domain';
import { CLICK_MAP_LEVELS, formatClickShare } from '@swarm/mail/click-map-scale';
import { ErrorNotice, LoadingRows, TabPanel, Tabs } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { broadcastClickMapQuery } from '../api/send';
import { Section, numberFormat } from '../pages/common';

const people = (n: number) => `${numberFormat.format(n)} ${n === 1 ? 'person' : 'people'}`;
const clicks = (n: number) => `${numberFormat.format(n)} ${n === 1 ? 'click' : 'clicks'}`;

/** The sent email with clicks marked on each link, and the same numbers as a list. */
export function ClickMap({ broadcastId, live }: { broadcastId: string; live: boolean }) {
  const map = useQuery(broadcastClickMapQuery(broadcastId, live));
  const [chosen, setChosen] = useState<string | null>(null);
  const views = map.data?.views ?? [];
  const view = views.find((v) => v.key === chosen) ?? views[0];
  const noLinks = !!map.data && views.every((v) => v.links.length === 0 && v.uncountedLinks === 0);

  return (
    <Section
      title="Click map"
      description="The email as it went out, with each link marked. It counts people’s clicks only, and shows how many, never who."
    >
      {map.isPending && <LoadingRows label="Loading click map" rows={3} />}
      {map.error && <ErrorNotice message={map.error.message} />}
      {noLinks && <p className="text-[13.5px] text-sub">This email had no links to map.</p>}
      {!noLinks && view && (
        <div className="grid gap-4">
          {live && (
            <p role="status" className="text-[13px] text-sub">
              Still sending, so these numbers keep changing. They update every 30 seconds.
            </p>
          )}
          {map.data && map.data.unplaced.clicks > 0 && (
            <p className="text-[13px] text-sub">
              {clicks(map.data.unplaced.clicks)} from {people(map.data.unplaced.people)} who have
              since left your list aren’t in any version below, because we no longer know which one
              they got. The Links table counts them.
            </p>
          )}
          {views.length > 1 && (
            <Tabs
              label="Version of the email"
              tabs={views.map((v) => ({ id: v.key, label: v.label }))}
              value={view.key}
              onChange={setChosen}
              idFor={(key) => `click-map-tab-${key}`}
              panelFor={(key) => `click-map-panel-${key}`}
              compact
            />
          )}
          <TabPanelFor view={view} several={views.length > 1} />
        </div>
      )}
    </Section>
  );
}

function TabPanelFor({ view, several }: { view: ClickMapView; several: boolean }) {
  const body = <ViewMap view={view} several={several} />;
  if (!several) return body;
  return (
    <TabPanel
      id={`click-map-panel-${view.key}`}
      labelledBy={`click-map-tab-${view.key}`}
      className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple"
    >
      {body}
    </TabPanel>
  );
}

function ViewMap({ view, several }: { view: ClickMapView; several: boolean }) {
  const shared = view.links.some((link) => link.occurrences > 1);
  const elsewhere = view.html !== null && view.links.some((link) => link.occurrences === 0);
  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5 text-[13px] text-sub">
        {several && <p className="font-semibold text-ink">Subject: {view.subject}</p>}
        {view.totalClicks === 0 ? (
          <p className="text-ink">No clicks yet. The numbers fill in here as people click.</p>
        ) : (
          <p className="tabular text-ink">
            {people(view.totalPeople)} clicked, {clicks(view.totalClicks)} in all.
          </p>
        )}
        {view.uncountedLinks > 0 && (
          <p>
            Links in raw HTML aren’t counted. This email has {view.uncountedLinks}, marked Not
            counted.
          </p>
        )}
        {shared && (
          <p>
            A link used in more than one place has one count, so each place shows the same number.
            We can’t tell which place people clicked.
          </p>
        )}
        {view.hasSmartBlocks && (
          <p>All Smart Blocks show here. Each reader saw only the ones meant for them.</p>
        )}
        {view.html !== null && (
          <p>
            Personal details show their fallback text. Links here don’t go anywhere, and viewing
            this doesn’t count as an open or a click. Footer links and poll buttons have no count.
          </p>
        )}
      </div>
      <Legend />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        {view.html === null ? (
          <p className="text-[13.5px] text-sub">
            A copy of this email is no longer stored, so only the list of links can show.
          </p>
        ) : (
          // No scripts or same-origin access: this is the owner's own HTML, with marks written in.
          <iframe
            title={`${view.label} with click counts. The list of links has the same numbers.`}
            sandbox=""
            srcDoc={view.html}
            className="h-[640px] w-full rounded-[10px] border border-line-app bg-white"
          />
        )}
        <div>
          <h3 className="text-[13.5px] font-semibold">Links in this email</h3>
          {view.links.length === 0 ? (
            <p className="mt-2 text-[13px] text-sub">No links here are counted.</p>
          ) : (
            <ol className="mt-1 grid">
              {view.links.map((link) => {
                const level = CLICK_MAP_LEVELS[link.level] ?? CLICK_MAP_LEVELS[0];
                return (
                  <li
                    key={link.position}
                    className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 border-b border-line py-2.5 last:border-b-0"
                  >
                    <span
                      className="tabular mt-0.5 min-w-7 self-start rounded-pill px-1.5 text-center text-[12px] leading-5 font-semibold"
                      style={{
                        background: level.background,
                        color: level.ink,
                        border: `1px ${level.style} ${level.outline}`,
                      }}
                    >
                      <span className="sr-only">Link </span>#{link.number}
                    </span>
                    <div className="min-w-0 text-[13px]">
                      <a
                        href={link.destination ?? link.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="font-medium break-words underline"
                      >
                        {link.destination ?? link.url}
                      </a>
                      <p className="tabular mt-0.5 text-sub">
                        {people(link.people)} · {clicks(link.clicks)} ·{' '}
                        {formatClickShare(link.share)} of clicks
                      </p>
                      {link.occurrences > 1 && (
                        <p className="mt-0.5 text-sub">
                          Used in {link.occurrences} places, with one count for all of them.
                        </p>
                      )}
                      {link.occurrences === 0 && elsewhere && (
                        <p className="mt-0.5 text-sub">Not on the map above: only in plain text.</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

/** The scale in words and in line thickness, so it reads without the colour. */
function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-sub">
      <span>Badges show the list number, people and share of clicks.</span>
      <span className="flex flex-wrap items-center gap-3">
        Fewer clicks
        {CLICK_MAP_LEVELS.map((level, index) => (
          <span
            key={level.background}
            aria-hidden="true"
            className="block h-3.5 w-6 rounded-[3px]"
            style={{
              background: level.background,
              outline: `${level.width}px ${level.style} ${level.outline}`,
            }}
            data-level={index}
          />
        ))}
        more clicks, with a darker, thicker outline
      </span>
    </div>
  );
}
