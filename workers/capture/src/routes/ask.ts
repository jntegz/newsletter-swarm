// One-tap email polls (Ask).
//
// - /a/<token>  GET shows the chosen answer and a "Confirm answer" button and records nothing
//               (mail scanners and link checkers prefetch links); POST records it and shows the
//               results when the Ask makes them public. Only an 'ask' token works here.
//
// A token names one Member and one option. Answering again (another option's link) replaces the
// answer while the Ask is open. For a survey, the page after answering links to the rest of the
// survey on the Channel website with a signed survey-page link.
import {
  askOpen,
  askPageToken,
  linksFor,
  askResults,
  channelSiteOrigin,
  loadAskByOption,
  readAskToken,
  recordAskAnswers,
  type LoadedAsk,
} from '@swarm/engine';
import { first } from '@swarm/db';
import type { Hono } from 'hono';
import { clientIp, env, type AppEnv } from '../context';
import { siteOriginConfig, type CaptureEnv } from '../env';
import { rateLimit } from '../guard';
import { brokenLink, expiredLink, h, page, slowDown } from '../pages';

const EXPIRED = 'Poll links work for 90 days. Use a link from a newer email.';

async function channelOf(db: D1Database, channelId: string) {
  const row = await first<{ name: string; branding_json: string; status: string }>(
    db,
    'SELECT name, branding_json, status FROM channels WHERE id = ?1 AND deleted_at IS NULL',
    channelId,
  );
  if (!row || row.status !== 'active') return null;
  const branding = JSON.parse(row.branding_json) as { accentColor?: string | null };
  return { name: row.name, accent: branding.accentColor ?? null };
}

/** The results list: one row per option with a bar, the Member's own answer marked. */
async function resultsHtml(
  db: D1Database,
  ask: LoadedAsk,
  questionId: string,
  mine: string | null,
): Promise<string> {
  const results = await askResults(db, ask);
  const question = results.questions.find((q) => q.questionId === questionId);
  if (!question) return '';
  const total = question.answers || 1;
  const rows = question.options
    .map((o) => {
      const pct = Math.round((o.count / total) * 100);
      const label =
        o.optionId === mine ? `${h(o.label)} <strong>(your answer)</strong>` : h(o.label);
      return `<li>${label}<span class="count">${pct}% · ${o.count}</span><span class="bar"><span style="width:${pct}%"></span></span></li>`;
    })
    .join('');
  return `<h2>Results so far</h2><ul class="results">${rows}</ul><p class="muted">${question.answers} answer${question.answers === 1 ? '' : 's'}.</p>`;
}

const head = (channelName: string, ask: LoadedAsk) =>
  `<p class="channel">${h(channelName)}</p><h1>${h(ask.title)}</h1>${ask.description ? `<p>${h(ask.description)}</p>` : ''}`;

async function surveyLink(e: CaptureEnv, ask: LoadedAsk, memberId: string) {
  const site = siteOriginConfig(e);
  if (!site || ask.kind !== 'survey' || ask.questions.length < 2) return '';
  const { origin } = await channelSiteOrigin(e.DB, site, ask.channelId);
  const token = await askPageToken(linksFor(e), { memberId, channelId: ask.channelId }, ask.id);
  const url = `${origin}/_swarm/ask/${ask.id}?t=${encodeURIComponent(token)}`;
  return `<p><a href="${h(url)}">Answer the other questions</a></p>`;
}

export function askRoutes(app: Hono<AppEnv>): void {
  const load = async (e: CaptureEnv, token: string) => {
    const read = await readAskToken(linksFor(e), token);
    if (!read.ok) return { error: read.reason === 'expired' ? expiredLink(EXPIRED) : brokenLink() };
    const found = await loadAskByOption(e.DB, read.optionId);
    // A link names its Member's Channel: one for another Channel's Ask is not this Ask's.
    if (found && read.channelId !== null && read.channelId !== found.ask.channelId) {
      return { error: brokenLink() };
    }
    const channel = found ? await channelOf(e.DB, found.ask.channelId) : null;
    if (!found || !channel) return { error: brokenLink() };
    return { ...found, channel, memberId: read.memberId };
  };

  const closed = async (
    e: CaptureEnv,
    found: Exclude<Awaited<ReturnType<typeof load>>, { error: Response }>,
  ) => {
    const results = found.ask.resultsPublic
      ? await resultsHtml(e.DB, found.ask, found.question.id, null)
      : '';
    return page(
      'This poll is closed',
      `${head(found.channel.name, found.ask)}<p class="notice">This poll is closed, so answers are no longer taken.</p>${results}`,
      { accent: found.channel.accent },
    );
  };

  app.get('/a/:token', async (c) => {
    const e = env(c);
    const found = await load(e, c.req.param('token'));
    if ('error' in found) return found.error;
    if (!askOpen(found.ask) || found.ask.status === 'draft') {
      if (found.ask.status === 'draft') {
        return page(
          'This poll is not open yet',
          `${head(found.channel.name, found.ask)}<p>This poll is not open yet. Try the link again later.</p>`,
          { accent: found.channel.accent },
        );
      }
      return closed(e, found);
    }
    return page(
      found.ask.title,
      `${head(found.channel.name, found.ask)}<h2>${h(found.question.prompt)}</h2>
<p>Your answer: <strong>${h(found.option.label)}</strong></p>
<form method="post"><button type="submit">Confirm answer</button></form>
<p class="muted">Picked the wrong one? Use another option’s link in the email.</p>`,
      { accent: found.channel.accent },
    );
  });

  app.post('/a/:token', async (c) => {
    const e = env(c);
    const found = await load(e, c.req.param('token'));
    if ('error' in found) return found.error;
    const wait = await rateLimit(e, [[clientIp(c), 'actionIp']]);
    if (wait) return slowDown(wait);
    const result = await recordAskAnswers(e.DB, {
      ask: found.ask,
      memberId: found.memberId,
      surface: 'email',
      answers: [{ questionId: found.question.id, optionId: found.option.id }],
    });
    if (result.outcome === 'closed') return closed(e, found);
    if (result.outcome !== 'recorded') return brokenLink();
    const results = found.ask.resultsPublic
      ? await resultsHtml(e.DB, found.ask, found.question.id, found.option.id)
      : '';
    return page(
      'Thanks for answering',
      `${head(found.channel.name, found.ask)}<p class="notice">Thanks. Your answer “${h(found.option.label)}” is saved.</p>${results}${await surveyLink(e, found.ask, found.memberId)}`,
      { accent: found.channel.accent },
    );
  });
}
