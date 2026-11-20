// What remains of the fixed website templates now that the home page is drawn from a design
// (render/design.ts): the subscriber count floor and the archive grouped by month, which a site
// with a design shows instead of the plain list.
import { card, row, type Preview } from './components';
import { h } from './html';

/** A count this small says little, so it isn't shown. */
export const SUBSCRIBER_COUNT_FLOOR = 100;

const monthFormat = new Intl.DateTimeFormat('en', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Newest first: the latest issue featured on the first page, then the rest by month. */
export function archiveByMonth(items: Preview[], featured: boolean): string {
  const [lead, ...others] = featured ? items : [undefined, ...items];
  const months = new Map<string, Preview[]>();
  for (const item of others) {
    if (!item) continue;
    const when = item.dispatch.publishedAt;
    const month = when ? monthFormat.format(new Date(when)) : 'Undated';
    months.set(month, [...(months.get(month) ?? []), item]);
  }
  const sections = [...months].map(
    ([month, list]) =>
      `<section class="sw-t-month"><h2>${h(month)}</h2><ul class="sw-list">${list.map((p) => row(p, 3)).join('')}</ul></section>`,
  );
  return `${lead ? `<div class="sw-t-featured">${card(lead, 2, true)}</div>` : ''}${sections.join('')}`;
}

/** The archive's rules for archiveByMonth. */
export const ARCHIVE_CSS = `.sw-t-featured{margin:0 0 16px}
.sw-t-featured .sw-card{border:0;background:none}
.sw-t-featured .sw-card:not(:has(img)){grid-template-columns:minmax(0,1fr)}
.sw-t-featured .sw-card-body{padding-left:0;padding-right:0}
.sw-t-featured h2{font-size:clamp(26px,3.6vw,38px);line-height:1.1;margin-top:0}
.sw-t-month h2{font-size:18px;margin:40px 0 4px}
`;
