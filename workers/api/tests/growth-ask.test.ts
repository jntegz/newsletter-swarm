import { env } from 'cloudflare:test';
import type {
  Ask,
  AskResults,
  AskTextAnswers,
  CaptureForm,
  CirclePreview,
  SignupJourney,
  SignupJourneyStats,
} from '@swarm/domain';
import { loadAsk, recordAskAnswers } from '@swarm/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { addField, addMember, data } from './audience-helpers';
import { call, createChannel, json, seatAs, signIn, type Session } from './helpers';
import { enableFlag } from './money-helpers';

const errorCode = async (res: Response) =>
  (await json<{ error: { code: string } }>(res)).error.code;

const pollBody = (overrides: Record<string, unknown> = {}) => ({
  kind: 'poll',
  title: 'Reader poll',
  description: 'Quick one',
  questions: [
    {
      prompt: 'More fox stories?',
      kind: 'choice',
      options: [{ label: 'Yes' }, { label: 'No' }],
    },
  ],
  ...overrides,
});

describe('Ask API', () => {
  let owner: Session;
  let channelId: string;

  beforeAll(async () => {
    owner = await signIn();
    channelId = (await createChannel(owner)).id;
  });

  const create = (body: unknown, s: Session = owner, channel = channelId) =>
    call('POST', `/api/v1/channels/${channel}/asks`, { cookie: s.cookie, body });

  it('creates, lists, reads and edits a poll', async () => {
    const ask = await data<Ask>(await create(pollBody()), 201);
    expect(ask.status).toBe('draft');
    expect(ask.questions[0]!.options.map((o) => o.label)).toEqual(['Yes', 'No']);
    expect(ask.surveyPath).toBe(`/_swarm/ask/${ask.id}`);
    const list = await data<Ask[]>(
      await call('GET', `/api/v1/channels/${channelId}/asks`, { cookie: owner.cookie }),
    );
    expect(list.some((a) => a.id === ask.id)).toBe(true);
    const q = ask.questions[0]!;
    const updated = await data<Ask>(
      await call('PATCH', `/api/v1/asks/${ask.id}`, {
        cookie: owner.cookie,
        body: {
          status: 'open',
          questions: [
            {
              id: q.id,
              prompt: 'Even more fox stories?',
              kind: 'choice',
              options: [
                { id: q.options[1]!.id, label: 'No' },
                { id: q.options[0]!.id, label: 'Yes!' },
                { label: 'Maybe' },
              ],
            },
          ],
        },
      }),
    );
    expect(updated.status).toBe('open');
    expect(updated.questions[0]!.options.map((o) => o.label)).toEqual(['No', 'Yes!', 'Maybe']);
    expect(updated.questions[0]!.options[0]!.id).toBe(q.options[1]!.id);
  });

  it('refuses polls that are not one choice question', async () => {
    const res = await create(
      pollBody({
        questions: [{ prompt: 'Why?', kind: 'text' }],
      }),
    );
    expect(res.status).toBe(400);
  });

  it('checks the profile field a question copies into', async () => {
    const text = await addField(owner, channelId, { type: 'text' });
    const secret = await addField(owner, channelId, { type: 'text', encrypted: true });
    const select = await addField(owner, channelId, { type: 'select', options: ['Yes'] });
    const other = await createChannel(owner);
    const foreign = await addField(owner, other.id, { type: 'select', options: ['Yes', 'No'] });
    const withField = (fieldId: string) =>
      pollBody({
        questions: [
          { prompt: 'Q', kind: 'choice', fieldId, options: [{ label: 'Yes' }, { label: 'No' }] },
        ],
      });
    for (const fieldId of [text.id, select.id, foreign.id]) {
      expect((await create(withField(fieldId))).status).toBe(400);
    }
    const survey = await create({
      kind: 'survey',
      title: 'S',
      questions: [{ prompt: 'Why?', kind: 'text', fieldId: secret.id }],
    });
    expect(survey.status).toBe(400);
    expect(
      (
        await create({
          kind: 'survey',
          title: 'S',
          questions: [{ prompt: 'Why?', kind: 'text', fieldId: text.id }],
        })
      ).status,
    ).toBe(201);
  });

  it('copies answers into the field, emits ask_answered and the answer works in a Circle', async () => {
    const field = await addField(owner, channelId, {
      type: 'select',
      options: ['Yes', 'No'],
    });
    const ask = await data<Ask>(
      await create(
        pollBody({
          questions: [
            {
              prompt: 'Fox?',
              kind: 'choice',
              fieldId: field.id,
              options: [{ label: 'yes' }, { label: 'No' }],
            },
          ],
        }),
      ),
      201,
    );
    await call('PATCH', `/api/v1/asks/${ask.id}`, {
      cookie: owner.cookie,
      body: { status: 'open' },
    });
    const member = await addMember(owner, channelId);
    const loaded = (await loadAsk(env.DB, ask.id))!;
    const question = loaded.questions[0]!;
    const yes = question.options[0]!.id;
    const first = await recordAskAnswers(env.DB, {
      ask: loaded,
      memberId: member.id,
      surface: 'email',
      answers: [{ questionId: question.id, optionId: yes }],
    });
    expect(first).toEqual({ outcome: 'recorded', changed: 1 });
    // The same answer again changes nothing and emits nothing.
    const again = await recordAskAnswers(env.DB, {
      ask: loaded,
      memberId: member.id,
      surface: 'email',
      answers: [{ questionId: question.id, optionId: yes }],
    });
    expect(again).toEqual({ outcome: 'recorded', changed: 0 });
    const events = await env.DB.prepare(
      `SELECT payload_json FROM member_events WHERE member_id = ?1 AND type = 'ask_answered'`,
    )
      .bind(member.id)
      .all<{ payload_json: string }>();
    expect(events.results.map((r) => JSON.parse(r.payload_json))).toEqual([
      { askId: ask.id, questionId: question.id, optionId: yes },
    ]);
    const preview = await data<CirclePreview>(
      await call('POST', `/api/v1/channels/${channelId}/circles/preview`, {
        cookie: owner.cookie,
        body: { rule: { field: `field:${field.key}`, cmp: 'eq', value: 'Yes' } },
      }),
    );
    expect(preview.count).toBe(1);
    expect(preview.sample[0]!.id).toBe(member.id);

    const results = await data<AskResults>(
      await call('GET', `/api/v1/asks/${ask.id}/results`, { cookie: owner.cookie }),
    );
    expect(results.respondents).toBe(1);
    expect(results.questions[0]!.options.map((o) => o.count)).toEqual([1, 0]);

    // A question with answers can't be removed, and the Ask can't go back to draft.
    const removed = await call('PATCH', `/api/v1/asks/${ask.id}`, {
      cookie: owner.cookie,
      body: {
        questions: [{ prompt: 'New', kind: 'choice', options: [{ label: 'A' }, { label: 'B' }] }],
      },
    });
    expect(removed.status).toBe(409);
    const draft = await call('PATCH', `/api/v1/asks/${ask.id}`, {
      cookie: owner.cookie,
      body: { status: 'draft' },
    });
    expect(draft.status).toBe(409);

    // Closed Asks refuse answers.
    await call('PATCH', `/api/v1/asks/${ask.id}`, {
      cookie: owner.cookie,
      body: { status: 'closed' },
    });
    const closed = await recordAskAnswers(env.DB, {
      ask: (await loadAsk(env.DB, ask.id))!,
      memberId: member.id,
      surface: 'email',
      answers: [{ questionId: question.id, optionId: question.options[1]!.id }],
    });
    expect(closed.outcome).toBe('closed');

    // The export is for admins and escapes formulas.
    const csv = await call('GET', `/api/v1/asks/${ask.id}/export`, { cookie: owner.cookie });
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    const body = await csv.text();
    expect(body.split('\r\n')[0]).toBe('email,question,answer,surface,answered_at');
    expect(body).toContain(',Fox?,yes,email,');
  });

  it('pages text answers and escapes formula cells in the export', async () => {
    const ask = await data<Ask>(
      await create({
        kind: 'survey',
        title: 'Open',
        questions: [{ prompt: 'Why?', kind: 'text' }],
      }),
      201,
    );
    await call('PATCH', `/api/v1/asks/${ask.id}`, {
      cookie: owner.cookie,
      body: { status: 'open' },
    });
    const loaded = (await loadAsk(env.DB, ask.id))!;
    for (const text of ['=SUM(A1)', 'two', 'three']) {
      const member = await addMember(owner, channelId);
      await recordAskAnswers(env.DB, {
        ask: loaded,
        memberId: member.id,
        surface: 'page',
        answers: [{ questionId: loaded.questions[0]!.id, text }],
      });
    }
    const path = `/api/v1/asks/${ask.id}/questions/${loaded.questions[0]!.id}/answers`;
    const page1 = await data<AskTextAnswers>(
      await call('GET', `${path}?limit=2`, { cookie: owner.cookie }),
    );
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await data<AskTextAnswers>(
      await call('GET', `${path}?limit=2&cursor=${page1.nextCursor}`, { cookie: owner.cookie }),
    );
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    const csv = await (
      await call('GET', `/api/v1/asks/${ask.id}/export`, { cookie: owner.cookie })
    ).text();
    expect(csv).toContain(`'=SUM(A1)`);
  });

  it('enforces roles and tenancy on every route', async () => {
    const ask = await data<Ask>(await create(pollBody()), 201);
    const viewer = await seatAs(owner.workspaceId, 'viewer');
    const author = await seatAs(owner.workspaceId, 'author');
    const editor = await seatAs(owner.workspaceId, 'editor');
    const stranger = await signIn();

    expect((await call('GET', `/api/v1/asks/${ask.id}`, { cookie: viewer.cookie })).status).toBe(
      200,
    );
    expect((await create(pollBody(), viewer)).status).toBe(403);
    expect((await create(pollBody(), author)).status).toBe(403);
    expect((await create(pollBody(), editor)).status).toBe(201);
    expect(
      (
        await call('PATCH', `/api/v1/asks/${ask.id}`, {
          cookie: viewer.cookie,
          body: { title: 'x' },
        })
      ).status,
    ).toBe(403);
    expect(
      (await call('GET', `/api/v1/asks/${ask.id}/export`, { cookie: editor.cookie })).status,
    ).toBe(403);

    const paths: [string, string, unknown?][] = [
      ['GET', `/api/v1/channels/${channelId}/asks`],
      ['POST', `/api/v1/channels/${channelId}/asks`, pollBody()],
      ['GET', `/api/v1/asks/${ask.id}`],
      ['PATCH', `/api/v1/asks/${ask.id}`, { title: 'Mine now' }],
      ['GET', `/api/v1/asks/${ask.id}/results`],
      ['GET', `/api/v1/asks/${ask.id}/questions/${ask.questions[0]!.id}/answers`],
      ['GET', `/api/v1/asks/${ask.id}/export`],
      ['DELETE', `/api/v1/asks/${ask.id}`],
    ];
    for (const [method, path, body] of paths) {
      const res = await call(method, path, { cookie: stranger.cookie, ...(body ? { body } : {}) });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect((await call('DELETE', `/api/v1/asks/${ask.id}`, { cookie: editor.cookie })).status).toBe(
      204,
    );
    expect((await call('GET', `/api/v1/asks/${ask.id}`, { cookie: owner.cookie })).status).toBe(
      404,
    );
  });
});

describe('Signup Journeys API', () => {
  let owner: Session;
  let channelId: string;
  let formId: string;

  beforeAll(async () => {
    owner = await signIn();
    channelId = (await createChannel(owner)).id;
    formId = (
      await data<CaptureForm>(
        await call('POST', `/api/v1/channels/${channelId}/capture-forms`, {
          cookie: owner.cookie,
          body: { name: 'Footer' },
        }),
        201,
      )
    ).id;
  });

  const body = (overrides: Record<string, unknown> = {}) => ({
    name: 'Welcome',
    formId,
    variants: [
      { key: 'a', weight: 50, steps: [{ kind: 'upsell' }] },
      {
        key: 'b',
        weight: 50,
        steps: [{ kind: 'welcome', headline: 'Hi', optOutText: 'No thanks' }],
      },
    ],
    ...overrides,
  });

  it('is off without the signup_journeys flag', async () => {
    const res = await call('GET', `/api/v1/channels/${channelId}/journeys`, {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('feature_disabled');
  });

  it('creates journeys, keeps one live per form, promotes and reports stats', async () => {
    await enableFlag('signup_journeys', owner.workspaceId, channelId);
    // Welcome steps need welcome_page.
    const refused = await call('POST', `/api/v1/channels/${channelId}/journeys`, {
      cookie: owner.cookie,
      body: body(),
    });
    expect(refused.status).toBe(400);
    await enableFlag('welcome_page', owner.workspaceId, channelId);
    const journey = await data<SignupJourney>(
      await call('POST', `/api/v1/channels/${channelId}/journeys`, {
        cookie: owner.cookie,
        body: body(),
      }),
      201,
    );
    const second = await data<SignupJourney>(
      await call('POST', `/api/v1/channels/${channelId}/journeys`, {
        cookie: owner.cookie,
        body: body(),
      }),
      201,
    );
    const live = await call('PATCH', `/api/v1/journeys/${journey.id}`, {
      cookie: owner.cookie,
      body: { status: 'live' },
    });
    expect(live.status).toBe(200);
    const clash = await call('PATCH', `/api/v1/journeys/${second.id}`, {
      cookie: owner.cookie,
      body: { status: 'live' },
    });
    expect(clash.status).toBe(409);

    expect(
      (
        await call('POST', `/api/v1/journeys/${journey.id}/promote`, {
          cookie: owner.cookie,
          body: { variant: 'z' },
        })
      ).status,
    ).toBe(400);
    const promoted = await data<SignupJourney>(
      await call('POST', `/api/v1/journeys/${journey.id}/promote`, {
        cookie: owner.cookie,
        body: { variant: 'b' },
      }),
    );
    expect(promoted.winnerKey).toBe('b');

    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      `INSERT INTO signup_journey_daily (journey_id, variant_key, step, day, views, completions, skips)
       VALUES (?1, 'a', 0, ?2, 10, 4, 6), (?1, 'b', 0, ?2, 10, 7, 3)`,
    )
      .bind(journey.id, day)
      .run();
    const stats = await data<SignupJourneyStats>(
      await call('GET', `/api/v1/journeys/${journey.id}/stats`, { cookie: owner.cookie }),
    );
    expect(stats.variants.find((v) => v.key === 'b')!.completionRate).toBe(0.7);
    expect(stats.daily).toHaveLength(2);
  });

  it('refuses references to another Channel', async () => {
    const other = await createChannel(owner);
    const foreignAsk = await data<Ask>(
      await call('POST', `/api/v1/channels/${other.id}/asks`, {
        cookie: owner.cookie,
        body: pollBody(),
      }),
      201,
    );
    await enableFlag('reader_survey_on_subscribe', owner.workspaceId, channelId);
    const res = await call('POST', `/api/v1/channels/${channelId}/journeys`, {
      cookie: owner.cookie,
      body: body({
        formId: null,
        variants: [{ key: 'a', weight: 1, steps: [{ kind: 'ask', askId: foreignAsk.id }] }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it('enforces roles and tenancy', async () => {
    const journey = await data<SignupJourney>(
      await call('POST', `/api/v1/channels/${channelId}/journeys`, {
        cookie: owner.cookie,
        body: body({ formId: null }),
      }),
      201,
    );
    const viewer = await seatAs(owner.workspaceId, 'viewer');
    const stranger = await signIn();
    expect(
      (await call('GET', `/api/v1/journeys/${journey.id}`, { cookie: viewer.cookie })).status,
    ).toBe(200);
    expect(
      (
        await call('PATCH', `/api/v1/journeys/${journey.id}`, {
          cookie: viewer.cookie,
          body: { name: 'x' },
        })
      ).status,
    ).toBe(403);
    const paths: [string, string, unknown?][] = [
      ['GET', `/api/v1/channels/${channelId}/journeys`],
      ['POST', `/api/v1/channels/${channelId}/journeys`, body()],
      ['GET', `/api/v1/journeys/${journey.id}`],
      ['PATCH', `/api/v1/journeys/${journey.id}`, { name: 'x' }],
      ['POST', `/api/v1/journeys/${journey.id}/promote`, { variant: 'a' }],
      ['GET', `/api/v1/journeys/${journey.id}/stats`],
      ['DELETE', `/api/v1/journeys/${journey.id}`],
    ];
    for (const [method, path, b] of paths) {
      const res = await call(method, path, { cookie: stranger.cookie, ...(b ? { body: b } : {}) });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });
});

describe('Smart Prompts API', () => {
  let owner: Session;
  let channelId: string;

  beforeAll(async () => {
    owner = await signIn();
    channelId = (await createChannel(owner)).id;
  });

  const prompt = (placement: unknown) =>
    call('POST', `/api/v1/channels/${channelId}/capture-forms`, {
      cookie: owner.cookie,
      body: { name: 'Prompt', kind: 'prompt', placement },
    });

  it('needs the smart_prompts flag', async () => {
    const res = await prompt({ trigger: 'dispatch_end' });
    expect(res.status).toBe(404);
  });

  it('validates placements and keeps the kind fixed', async () => {
    await enableFlag('smart_prompts', owner.workspaceId, channelId);
    for (const placement of [
      undefined,
      { trigger: 'scroll' },
      { trigger: 'scroll', value: 150 },
      { trigger: 'delay' },
      { trigger: 'dispatch_end', paths: ['p/*'] },
      { trigger: 'dispatch_end', paths: ['//evil'] },
      { trigger: 'gate_hit', readers: 'everyone' },
    ]) {
      expect((await prompt(placement)).status, JSON.stringify(placement)).toBe(400);
    }
    const created = await data<CaptureForm>(
      await prompt({ trigger: 'scroll', value: 50, paths: ['/p/*'], cooldownDays: 3 }),
      201,
    );
    expect(created.kind).toBe('prompt');
    expect(created.placement).toMatchObject({ trigger: 'scroll', value: 50, readers: 'anonymous' });

    const changed = await call('PATCH', `/api/v1/capture-forms/${created.id}`, {
      cookie: owner.cookie,
      body: { kind: 'form' },
    });
    expect(changed.status).toBe(400);
    const moved = await data<CaptureForm>(
      await call('PATCH', `/api/v1/capture-forms/${created.id}`, {
        cookie: owner.cookie,
        body: { placement: { trigger: 'gate_hit', readers: 'free' } },
      }),
    );
    expect(moved.placement?.trigger).toBe('gate_hit');

    const form = await data<CaptureForm>(
      await call('POST', `/api/v1/channels/${channelId}/capture-forms`, {
        cookie: owner.cookie,
        body: { name: 'Plain' },
      }),
      201,
    );
    expect(form.kind).toBe('form');
    const placed = await call('PATCH', `/api/v1/capture-forms/${form.id}`, {
      cookie: owner.cookie,
      body: { placement: { trigger: 'dispatch_end' } },
    });
    expect(placed.status).toBe(400);
    const prompts = await data<CaptureForm[]>(
      await call('GET', `/api/v1/channels/${channelId}/capture-forms?kind=prompt`, {
        cookie: owner.cookie,
      }),
    );
    expect(prompts.map((p) => p.id)).toEqual([created.id]);
  });
});
