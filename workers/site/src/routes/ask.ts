// The survey page of an Ask (polls and surveys), on the Channel website.
//
//   GET  /_swarm/ask/<askId>   the questions (with the Member's earlier answers), or a sign-in
//                              prompt; results when the Ask makes them public
//   POST /_swarm/ask/<askId>   records the answers (one per question, replacing earlier ones)
//
// Answering needs to know who is answering: a signed-in reader of this Channel, or a signed
// survey-page link (`?t=`, purpose 'ask-page', for this Ask only) from a one-tap email poll.
// Anonymous visitors are asked to sign in; nothing is ever recorded for them. Pages are never
// cached, carry no script, and send no referrer (the link may carry a token). Posts must come
// from this site and are rate limited per IP.
import {
  askOpen,
  askResults,
  loadAsk,
  memberAnswers,
  linksFor,
  readAskPageToken,
  recordAskAnswers,
  type AskAnswer,
  type LoadedAsk,
} from '@swarm/engine';
import { first } from '@swarm/db';
import { Hono } from 'hono';
import type { SiteBindings, SiteContext } from '../context';
import { underPaymentLimit } from '../money/guard';
import { h, readerPage } from '../readers/pages';
import { crossSite } from './reader';

export const askPages = new Hono<SiteBindings>();

const ASK_ID = /^ak_[0-9a-f]{32}$/;
const OPTION_ID = /^ao_[0-9a-f]{32}$/;

const STYLE = `<style>fieldset{border:0;padding:0;margin:0 0 18px}legend{font-size:15px;font-weight:600;margin-bottom:8px}
.choice{display:flex;gap:8px;align-items:center;font-weight:400;margin:0 0 8px}
textarea{min-height:96px}.notice{padding:10px 14px;border-radius:10px;background:#e9f5ee;color:#1f7a4d;font-size:14px}
.error{padding:10px 14px;border-radius:10px;background:#ffe9e2;color:#b5401f;font-size:14px}
ul.results{list-style:none;padding:0;margin:0 0 16px}ul.results li{padding:8px 0;border-top:1px solid #efedf6;font-size:14px}
.count{float:right;color:#6b6b76}</style>`;

/** Who is answering: the signed-in reader, else a valid survey-page link for this Ask. */
async function identify(c: SiteContext, ask: LoadedAsk, token: string | null) {
  const reader = c.get('reader');
  if (reader.memberId) return { memberId: reader.memberId, token: null };
  if (!token) return null;
  const env = c.get('env');
  const memberId = await readAskPageToken(linksFor(env), token, ask);
  if (!memberId) return null;
  const member = await first<{ id: string }>(
    env.DB,
    'SELECT id FROM members WHERE id = ?1 AND channel_id = ?2',
    memberId,
    ask.channelId,
  );
  return member ? { memberId, token } : null;
}

async function results(c: SiteContext, ask: LoadedAsk): Promise<string> {
  if (!ask.resultsPublic) return '';
  const counts = await askResults(c.get('env').DB, ask);
  const sections = counts.questions
    .filter((q) => q.kind === 'choice')
    .map((q) => {
      const total = q.answers || 1;
      const rows = q.options
        .map(
          (o) =>
            `<li>${h(o.label)}<span class="count">${Math.round((o.count / total) * 100)}% · ${o.count}</span></li>`,
        )
        .join('');
      return `<h2>${h(q.prompt)}</h2><ul class="results">${rows}</ul>`;
    })
    .join('');
  return sections ? `<section aria-label="Results">${sections}</section>` : '';
}

function questionsForm(
  ask: LoadedAsk,
  answers: Map<string, { optionId: string | null; text: string | null }>,
  preselect: string | null,
  token: string | null,
): string {
  const fields = ask.questions
    .map((q) => {
      const name = `q.${q.id}`;
      const req = q.required ? ' required' : '';
      const description = q.description ? `<p class="small">${h(q.description)}</p>` : '';
      const mine = answers.get(q.id);
      if (q.kind === 'text') {
        return `<label>${h(q.prompt)}${description}<textarea name="${name}" maxlength="2000"${req}>${h(mine?.text ?? '')}</textarea></label>`;
      }
      const chosen = q.options.some((o) => o.id === preselect)
        ? preselect
        : (mine?.optionId ?? null);
      return `<fieldset><legend>${h(q.prompt)}</legend>${description}${q.options
        .map(
          (o) =>
            `<label class="choice"><input type="radio" name="${name}" value="${o.id}"${o.id === chosen ? ' checked' : ''}${req}> ${h(o.label)}</label>`,
        )
        .join('')}</fieldset>`;
    })
    .join('');
  const hidden = token ? `<input type="hidden" name="t" value="${h(token)}">` : '';
  return `<form method="post" action="/_swarm/ask/${ask.id}">${hidden}${fields}<p><button type="submit">Send answers</button></p></form>`;
}

const head = (ask: LoadedAsk) =>
  `<h1>${h(ask.title)}</h1>${ask.description ? `<p>${h(ask.description)}</p>` : ''}`;

async function loadPublic(c: SiteContext): Promise<LoadedAsk | null> {
  const id = c.req.param('askId') ?? '';
  if (!ASK_ID.test(id)) return null;
  const ask = await loadAsk(c.get('env').DB, id, c.get('channel').id);
  return ask && ask.status !== 'draft' ? ask : null;
}

const missing = (c: SiteContext) =>
  readerPage(c, 'Not found', '<h1>This survey is not available</h1>', 404);

askPages.get('/_swarm/ask/:askId', async (c) => {
  const ask = await loadPublic(c);
  if (!ask) return missing(c);
  if (!askOpen(ask)) {
    return readerPage(
      c,
      ask.title,
      `${head(ask)}<p class="notice">This survey is closed.</p>${await results(c, ask)}`,
      200,
      { head: STYLE },
    );
  }
  const option = c.req.query('o');
  const who = await identify(c, ask, c.req.query('t') ?? null);
  if (!who) {
    const back = `/_swarm/ask/${ask.id}${option && OPTION_ID.test(option) ? `?o=${option}` : ''}`;
    return readerPage(
      c,
      ask.title,
      `${head(ask)}<p>Sign in with the email address you subscribed with to answer.</p>
<p><a href="/_swarm/reader/signin?return=${encodeURIComponent(back)}">Sign in to answer</a></p>${await results(c, ask)}`,
      200,
      { head: STYLE },
    );
  }
  const answers = await memberAnswers(c.get('env').DB, ask.id, who.memberId);
  return readerPage(
    c,
    ask.title,
    `${head(ask)}${questionsForm(ask, answers, option && OPTION_ID.test(option) ? option : null, who.token)}`,
    200,
    { head: STYLE },
  );
});

askPages.post('/_swarm/ask/:askId', async (c) => {
  if (crossSite(c)) {
    return readerPage(c, 'Not sent', '<h1>This form must be sent from this site</h1>', 403);
  }
  const ask = await loadPublic(c);
  if (!ask) return missing(c);
  if (!(await underPaymentLimit(c, 'ask'))) {
    c.header('retry-after', '60');
    return readerPage(
      c,
      'Too many attempts',
      '<h1>Too many attempts</h1><p>Wait a minute, then try again.</p>',
      429,
    );
  }
  const body = await c.req.parseBody();
  const token = typeof body.t === 'string' ? body.t : null;
  const who = await identify(c, ask, token);
  if (!who) {
    return readerPage(
      c,
      'Sign in to answer',
      `<h1>Sign in to answer</h1><p><a href="/_swarm/reader/signin?return=${encodeURIComponent(`/_swarm/ask/${ask.id}`)}">Sign in</a> with the email address you subscribed with.</p>`,
      403,
    );
  }
  const answers: AskAnswer[] = ask.questions.map((q) => {
    const value = body[`q.${q.id}`];
    const text = typeof value === 'string' ? value.slice(0, 4000) : null;
    return q.kind === 'choice' ? { questionId: q.id, optionId: text } : { questionId: q.id, text };
  });
  const result = await recordAskAnswers(c.get('env').DB, {
    ask,
    memberId: who.memberId,
    surface: 'page',
    answers: answers.filter((a) => a.optionId || a.text),
    requireAll: true,
  });
  if (result.outcome === 'closed') {
    return readerPage(
      c,
      ask.title,
      `${head(ask)}<p class="notice">This survey is closed.</p>`,
      409,
      {
        head: STYLE,
      },
    );
  }
  if (result.outcome !== 'recorded') {
    const message = result.outcome === 'invalid' ? result.message : 'That did not work.';
    const current = await memberAnswers(c.get('env').DB, ask.id, who.memberId);
    return readerPage(
      c,
      ask.title,
      `${head(ask)}<p class="error">${h(message)}</p>${questionsForm(ask, current, null, who.token)}`,
      400,
      { head: STYLE },
    );
  }
  return readerPage(
    c,
    ask.title,
    `${head(ask)}<p class="notice">Thanks, your answers are saved.</p>${await results(c, ask)}<p><a href="/">Back to the site</a></p>`,
    200,
    { head: STYLE },
  );
});
