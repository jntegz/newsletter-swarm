import { env } from 'cloudflare:test';
import { newId } from '@swarm/domain';
import { askToken } from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { askTokenFor, memberTokenFor, testLinks } from './links';
import {
  addMember,
  call,
  member,
  nextIp,
  seedChannel,
  seedForm,
  submitForm,
  submitJson,
  uniqueEmail,
} from './helpers';

async function enableFlag(channelId: string, key: string) {
  await env.DB.prepare(
    `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at) VALUES (?1, ?2, 'channel', ?3, 1, 0)`,
  )
    .bind(newId('featureFlag'), key, channelId)
    .run();
}

/** A select field and an open poll whose question copies into it. */
async function seedPoll(
  channelId: string,
  options: { status?: string; kind?: 'poll' | 'survey'; resultsPublic?: boolean } = {},
) {
  const now = Date.now();
  const fieldId = newId('memberField');
  const key = `topic_${crypto.randomUUID().slice(0, 6)}`;
  const askId = newId('ask');
  const questionId = newId('askQuestion');
  const textId = newId('askQuestion');
  const yes = newId('askOption');
  const no = newId('askOption');
  const statements = [
    env.DB.prepare(
      `INSERT INTO member_fields (id, channel_id, key, label, type, options_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Topic', 'select', '["Yes","No"]', ?4, ?4)`,
    ).bind(fieldId, channelId, key, now),
    env.DB.prepare(
      `INSERT INTO asks (id, channel_id, kind, title, description, status, results_public, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Reader poll', 'A quick one', ?4, ?5, ?6, ?6)`,
    ).bind(
      askId,
      channelId,
      options.kind ?? 'poll',
      options.status ?? 'open',
      options.resultsPublic === false ? 0 : 1,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO ask_questions (id, ask_id, position, prompt, kind, field_id) VALUES (?1, ?2, 0, 'More foxes?', 'choice', ?3)`,
    ).bind(questionId, askId, fieldId),
    env.DB.prepare(
      `INSERT INTO ask_options (id, ask_id, question_id, label, position) VALUES (?1, ?2, ?3, 'Yes', 0), (?4, ?2, ?3, 'No', 1)`,
    ).bind(yes, askId, questionId, no),
  ];
  if (options.kind === 'survey') {
    statements.push(
      env.DB.prepare(
        `INSERT INTO ask_questions (id, ask_id, position, prompt, kind) VALUES (?1, ?2, 1, 'Why?', 'text')`,
      ).bind(textId, askId),
    );
  }
  await env.DB.batch(statements);
  return { askId, questionId, textId, yes, no, fieldId, key };
}

const responses = (askId: string) =>
  env.DB.prepare('SELECT member_id, option_id, text, surface FROM ask_responses WHERE ask_id = ?1')
    .bind(askId)
    .all<{ member_id: string; option_id: string | null; text: string | null; surface: string }>()
    .then((r) => r.results);

const post = (path: string, body: Record<string, string> = {}) =>
  call(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cf-connecting-ip': nextIp(),
    },
    body: new URLSearchParams(body).toString(),
  });

describe('one-tap poll links', () => {
  it('shows a confirm page on GET and records nothing', async () => {
    const channel = await seedChannel();
    const poll = await seedPoll(channel.channelId);
    const memberId = await addMember(channel.channelId, uniqueEmail(), 'active');
    const token = await askTokenFor(memberId, poll.yes);
    const res = await call(`/a/${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Confirm answer');
    expect(html).toContain('<form method="post">');
    expect(html).toContain('A quick one');
    expect(await responses(poll.askId)).toEqual([]);
  });

  it('refuses a one-tap link that names another Channel than its Ask’s', async () => {
    const channel = await seedChannel();
    const other = await seedChannel();
    const poll = await seedPoll(channel.channelId);
    const memberId = await addMember(channel.channelId, uniqueEmail(), 'active');
    const token = await askToken(testLinks(), { memberId, channelId: other.channelId }, poll.yes);
    expect((await call(`/a/${token}`)).status).toBe(404);
    expect((await post(`/a/${token}`)).status).toBe(404);
    expect(await responses(poll.askId)).toEqual([]);
  });

  it('records one answer per subscriber on POST, copies it into the field and emits ask_answered', async () => {
    const channel = await seedChannel();
    const poll = await seedPoll(channel.channelId);
    const memberId = await addMember(channel.channelId, uniqueEmail(), 'active');
    const res = await post(`/a/${await askTokenFor(memberId, poll.yes)}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Results so far');
    expect(html).toContain('(your answer)');
    expect(await responses(poll.askId)).toEqual([
      { member_id: memberId, option_id: poll.yes, text: null, surface: 'email' },
    ]);
    // Changing the answer replaces it.
    expect((await post(`/a/${await askTokenFor(memberId, poll.no)}`)).status).toBe(200);
    expect((await responses(poll.askId)).map((r) => r.option_id)).toEqual([poll.no]);
    const value = await env.DB.prepare(
      'SELECT value_text FROM member_field_values WHERE member_id = ?1 AND field_id = ?2',
    )
      .bind(memberId, poll.fieldId)
      .first<{ value_text: string }>();
    expect(value?.value_text).toBe('No');
    const events = await env.DB.prepare(
      `SELECT payload_json FROM member_events WHERE member_id = ?1 AND type = 'ask_answered' ORDER BY seq`,
    )
      .bind(memberId)
      .all<{ payload_json: string }>();
    expect(events.results.map((e) => JSON.parse(e.payload_json).optionId)).toEqual([
      poll.yes,
      poll.no,
    ]);
  });

  it('refuses tokens of other purposes, and poll tokens elsewhere', async () => {
    const channel = await seedChannel();
    const poll = await seedPoll(channel.channelId);
    const memberId = await addMember(channel.channelId, uniqueEmail(), 'active');
    const center = await memberTokenFor(memberId);
    expect((await call(`/a/${center}`)).status).toBe(404);
    expect((await post(`/a/${center}`)).status).toBe(404);
    const poll1 = await askTokenFor(memberId, poll.yes);
    expect((await call(`/m/${poll1}`)).status).not.toBe(200);
    expect((await call(`/v1/confirm/${poll1}`)).status).not.toBe(200);
    expect(await responses(poll.askId)).toEqual([]);
  });

  it('refuses answers to closed and draft Asks', async () => {
    const channel = await seedChannel();
    const closed = await seedPoll(channel.channelId, { status: 'closed' });
    const draft = await seedPoll(channel.channelId, { status: 'draft' });
    const memberId = await addMember(channel.channelId, uniqueEmail(), 'active');
    const res = await post(`/a/${await askTokenFor(memberId, closed.yes)}`);
    expect(await res.text()).toContain('This poll is closed');
    await post(`/a/${await askTokenFor(memberId, draft.yes)}`);
    expect(await responses(closed.askId)).toEqual([]);
    expect(await responses(draft.askId)).toEqual([]);
    expect(await (await call(`/a/${await askTokenFor(memberId, draft.yes)}`)).text()).toContain(
      'not open yet',
    );
  });

  it('links a survey to the rest of its questions on the site', async () => {
    const channel = await seedChannel();
    const survey = await seedPoll(channel.channelId, { kind: 'survey', resultsPublic: false });
    const memberId = await addMember(channel.channelId, uniqueEmail(), 'active');
    const html = await (await post(`/a/${await askTokenFor(memberId, survey.yes)}`)).text();
    expect(html).not.toContain('Results so far');
    expect(html).toContain(`http://${channel.slug}.swarm.test/_swarm/ask/${survey.askId}?t=`);
  });
});

async function seedJourney(
  channel: { channelId: string },
  formId: string | null,
  variants: unknown,
  status = 'live',
) {
  const id = newId('signupJourney');
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO signup_journeys (id, channel_id, name, status, form_id, variants_json, created_at, updated_at)
     VALUES (?1, ?2, 'Welcome', ?3, ?4, ?5, ?6, ?6)`,
  )
    .bind(id, channel.channelId, status, formId, JSON.stringify(variants), now)
    .run();
  return id;
}

const claimsOf = (url: string) => {
  const token = /\/v1\/j\/([^/]+)\//.exec(url)![1]!;
  const payload = token.split('.')[3]!;
  return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { v: string };
};

const daily = (journeyId: string) =>
  env.DB.prepare(
    'SELECT variant_key, step, views, completions, skips FROM signup_journey_daily WHERE journey_id = ?1 ORDER BY step',
  )
    .bind(journeyId)
    .all<{ variant_key: string; step: number; views: number; completions: number; skips: number }>()
    .then((r) => r.results);

describe('Signup Journeys', () => {
  it('shows nothing while the flag is off', async () => {
    const channel = await seedChannel();
    const form = await seedForm(channel);
    await seedJourney(channel, form.id, [
      { key: 'a', weight: 1, steps: [{ kind: 'welcome', headline: 'Hi' }] },
    ]);
    const res = await submitJson(form.id, { email: uniqueEmail() });
    expect((await res.json<{ data: { journey: string | null } }>()).data.journey).toBeNull();
  });

  it('walks the steps after a no-JS sign-up, records the answer and counts each step', async () => {
    const channel = await seedChannel();
    const form = await seedForm(channel);
    const poll = await seedPoll(channel.channelId);
    for (const key of ['signup_journeys', 'reader_survey_on_subscribe', 'welcome_page']) {
      await enableFlag(channel.channelId, key);
    }
    const journeyId = await seedJourney(channel, form.id, [
      {
        key: 'a',
        weight: 1,
        steps: [
          { kind: 'recommendations' },
          { kind: 'ask', askId: poll.askId },
          { kind: 'welcome', headline: 'Welcome aboard', optOutText: 'No thanks, skip this' },
        ],
      },
    ]);
    const email = uniqueEmail();
    const res = await submitForm(form.id, { email, 'cf-turnstile-response': 'ok' });
    expect(res.status).toBe(303);
    const start = res.headers.get('location')!;
    expect(start).toMatch(/^\/v1\/j\/[^/]+\/0$/);

    // Step 0 (recommendations) shows nothing until Phase 8, so it moves on to step 1.
    const zero = await call(start);
    expect(zero.status).toBe(303);
    const stepOne = zero.headers.get('location')!;
    expect(stepOne).toMatch(/\/1$/);
    const page = await call(stepOne);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('More foxes?');
    expect(html).toContain('Check your inbox to confirm.');
    expect(page.headers.get('content-security-policy')).toContain('frame-ancestors *');

    const answered = await post(stepOne, { action: 'done', [`q.${poll.questionId}`]: poll.yes });
    expect(answered.status).toBe(303);
    expect(answered.headers.get('location')).toMatch(/\/2$/);
    const created = await member(channel.channelId, email);
    expect(await responses(poll.askId)).toEqual([
      { member_id: created!.id, option_id: poll.yes, text: null, surface: 'journey' },
    ]);

    const welcome = await (await call(answered.headers.get('location')!)).text();
    expect(welcome).toContain('Welcome aboard');
    expect(welcome).toContain('No thanks, skip this');
    const skipped = await post(answered.headers.get('location')!, { action: 'skip' });
    expect(await skipped.text()).toContain('You are all set');

    expect(await daily(journeyId)).toEqual([
      { variant_key: 'a', step: 1, views: 1, completions: 1, skips: 0 },
      { variant_key: 'a', step: 2, views: 1, completions: 0, skips: 1 },
    ]);
  });

  it('assigns variants deterministically per address, from the JSON path too', async () => {
    const channel = await seedChannel();
    const form = await seedForm(channel);
    await enableFlag(channel.channelId, 'signup_journeys');
    await enableFlag(channel.channelId, 'welcome_page');
    await seedJourney(channel, null, [
      { key: 'a', weight: 50, steps: [{ kind: 'welcome', headline: 'A' }] },
      { key: 'b', weight: 50, steps: [{ kind: 'welcome', headline: 'B' }] },
    ]);
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const email = uniqueEmail();
      const first = await submitJson(form.id, { email });
      const again = await submitJson(form.id, { email });
      const a = (await first.json<{ data: { journey: string } }>()).data.journey;
      const b = (await again.json<{ data: { journey: string } }>()).data.journey;
      expect(claimsOf(a).v).toBe(claimsOf(b).v);
      seen.add(claimsOf(a).v);
    }
    expect(seen.size).toBe(2);
  });

  it('starts no journey for a filled honeypot', async () => {
    const channel = await seedChannel();
    const form = await seedForm(channel);
    await enableFlag(channel.channelId, 'signup_journeys');
    await seedJourney(channel, form.id, [
      { key: 'a', weight: 1, steps: [{ kind: 'welcome', headline: 'Hi' }] },
    ]);
    const res = await submitJson(form.id, {
      email: 'anything at all',
      website: 'https://spam.example',
    });
    expect(await res.json()).toEqual({
      data: { ok: true, message: 'Check your inbox to confirm.', redirect: null, journey: null },
    });
  });

  it('never writes answers into a subscriber who existed before the sign-up', async () => {
    const channel = await seedChannel();
    const form = await seedForm(channel);
    const poll = await seedPoll(channel.channelId);
    await enableFlag(channel.channelId, 'signup_journeys');
    await enableFlag(channel.channelId, 'reader_survey_on_subscribe');
    await seedJourney(channel, form.id, [
      { key: 'a', weight: 1, steps: [{ kind: 'ask', askId: poll.askId }] },
    ]);
    const email = uniqueEmail();
    const memberId = await addMember(channel.channelId, email, 'active');
    await env.DB.prepare('UPDATE members SET created_at = 0 WHERE id = ?1').bind(memberId).run();
    const res = await submitJson(form.id, { email });
    const start = (await res.json<{ data: { journey: string } }>()).data.journey;
    expect((await call(start)).status).toBe(200);
    expect(
      (await post(start, { action: 'done', [`q.${poll.questionId}`]: poll.yes })).status,
    ).toBeLessThan(400);
    expect(await responses(poll.askId)).toEqual([]);
  });

  it('never writes answers into a Member another path created minutes before the sign-up', async () => {
    const channel = await seedChannel();
    const form = await seedForm(channel);
    const poll = await seedPoll(channel.channelId);
    await enableFlag(channel.channelId, 'signup_journeys');
    await enableFlag(channel.channelId, 'reader_survey_on_subscribe');
    await seedJourney(channel, form.id, [
      { key: 'a', weight: 1, steps: [{ kind: 'ask', askId: poll.askId }] },
    ]);
    // A real sign-up, an import or an API create, three minutes before a stranger types the
    // address into the public form.
    const email = uniqueEmail();
    const memberId = await addMember(channel.channelId, email, 'active');
    await env.DB.prepare('UPDATE members SET created_at = ?1 WHERE id = ?2')
      .bind(Date.now() - 3 * 60 * 1000, memberId)
      .run();
    const res = await submitJson(form.id, { email });
    const start = (await res.json<{ data: { journey: string } }>()).data.journey;
    expect(start).toMatch(/^\/v1\/j\/[^/]+\/0$/);
    expect((await call(start)).status).toBe(200);
    const answered = await post(start, { action: 'done', [`q.${poll.questionId}`]: poll.yes });
    expect(answered.status).toBeLessThan(400);
    expect(await responses(poll.askId)).toEqual([]);
    const value = await env.DB.prepare(
      'SELECT value_text FROM member_field_values WHERE member_id = ?1 AND field_id = ?2',
    )
      .bind(memberId, poll.fieldId)
      .first();
    expect(value).toBeNull();
  });

  it('never writes answers into a Member created with the address after the token', async () => {
    const channel = await seedChannel();
    const form = await seedForm(channel);
    const poll = await seedPoll(channel.channelId);
    await enableFlag(channel.channelId, 'signup_journeys');
    await enableFlag(channel.channelId, 'reader_survey_on_subscribe');
    await seedJourney(channel, form.id, [
      { key: 'a', weight: 1, steps: [{ kind: 'ask', askId: poll.askId }] },
    ]);
    const email = uniqueEmail();
    const res = await submitJson(form.id, { email });
    const start = (await res.json<{ data: { journey: string } }>()).data.journey;
    // The sign-up runs after the response; once it has, its row goes and another path adds the
    // address again.
    for (let i = 0; i < 50 && !(await member(channel.channelId, email)); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await env.DB.prepare('DELETE FROM members WHERE channel_id = ?1 AND email = ?2')
      .bind(channel.channelId, email)
      .run();
    await addMember(channel.channelId, email, 'active');
    expect((await call(start)).status).toBe(200);
    await post(start, { action: 'done', [`q.${poll.questionId}`]: poll.yes });
    expect(await responses(poll.askId)).toEqual([]);
  });
});
