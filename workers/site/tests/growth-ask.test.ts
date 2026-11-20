import { SELF, env } from 'cloudflare:test';
import { defaultCaptureFormConfig, newId } from '@swarm/domain';
import { askPageToken, askToken } from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { testLinks } from './links';
import { PROMPT_SCRIPT } from '../src/render/prompts';
import { addMember, seedChannel, sessionCookie, uniqueEmail, type SeededChannel } from './helpers';

const keys = () => testLinks();
const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

async function enableFlag(ch: SeededChannel, key: string) {
  await env.DB.prepare(
    `INSERT INTO feature_flags (id, key, scope, scope_id, enabled, updated_at) VALUES (?1, ?2, 'channel', ?3, 1, 0)`,
  )
    .bind(newId('featureFlag'), key, ch.channelId)
    .run();
  await env.CACHE.delete(`flags:v1:${ch.workspaceId}:${ch.channelId}`);
}

async function seedDispatch(
  ch: SeededChannel,
  slug: string,
  content: unknown[],
  visibility = 'public',
) {
  const id = newId('dispatch');
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dispatches (id, channel_id, subject, preheader, content_json, status, created_at, updated_at, web_visibility, web_published_at)
       VALUES (?1, ?2, ?3, '', ?4, 'sent', 0, ?5, ?6, ?5)`,
    ).bind(
      id,
      ch.channelId,
      `Dispatch ${slug}`,
      JSON.stringify({ type: 'doc', content }),
      now,
      visibility,
    ),
    env.DB.prepare(
      'INSERT INTO dispatch_slugs (channel_id, slug, dispatch_id, is_current, created_at) VALUES (?1, ?2, ?3, 1, 0)',
    ).bind(ch.channelId, slug, id),
  ]);
  return id;
}

async function seedAsk(ch: SeededChannel, status = 'open') {
  const askId = newId('ask');
  const questionId = newId('askQuestion');
  const textId = newId('askQuestion');
  const yes = newId('askOption');
  const no = newId('askOption');
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO asks (id, channel_id, kind, title, status, created_at, updated_at)
       VALUES (?1, ?2, 'survey', 'Reader survey', ?3, ?4, ?4)`,
    ).bind(askId, ch.channelId, status, now),
    env.DB.prepare(
      `INSERT INTO ask_questions (id, ask_id, position, prompt, kind, required) VALUES (?1, ?2, 0, 'More foxes?', 'choice', 1), (?3, ?2, 1, 'Why?', 'text', 0)`,
    ).bind(questionId, askId, textId),
    env.DB.prepare(
      `INSERT INTO ask_options (id, ask_id, question_id, label, position) VALUES (?1, ?2, ?3, 'Yes', 0), (?4, ?2, ?3, 'No', 1)`,
    ).bind(yes, askId, questionId, no),
  ]);
  return { askId, questionId, textId, yes, no };
}

async function seedPrompt(ch: SeededChannel, placement: Record<string, unknown>, heading: string) {
  const id = newId('captureForm');
  const config = {
    ...defaultCaptureFormConfig(),
    copy: { heading, body: 'Join us.', button: 'Join' },
  };
  const json = JSON.stringify(config);
  await env.DB.prepare(
    `INSERT INTO capture_forms (id, workspace_id, channel_id, name, kind, placement_json, status, draft_config_json,
       published_config_json, version, published_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'Prompt', 'prompt', ?4, 'published', ?5, ?5, 1, ?6, 0, 0)`,
  )
    .bind(id, ch.workspaceId, ch.channelId, JSON.stringify(placement), json, Date.now())
    .run();
  return id;
}

const get = (url: string, init: RequestInit = {}) =>
  SELF.fetch(url, { redirect: 'manual', ...init });

const postForm = (url: string, origin: string, body: Record<string, string>, cookie?: string) =>
  SELF.fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin,
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(body).toString(),
  });

const answers = (askId: string) =>
  env.DB.prepare(
    'SELECT member_id, option_id, text, surface FROM ask_responses WHERE ask_id = ?1 ORDER BY question_id',
  )
    .bind(askId)
    .all<{ member_id: string; option_id: string | null; text: string | null; surface: string }>()
    .then((r) => r.results);

describe('survey page', () => {
  it('asks anonymous readers to sign in and records nothing for them', async () => {
    const ch = await seedChannel();
    const ask = await seedAsk(ch);
    const res = await get(`${ch.origin}/_swarm/ask/${ask.askId}?o=${ask.yes}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Sign in to answer');
    expect(html).not.toContain('<form method="post"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const post = await postForm(`${ch.origin}/_swarm/ask/${ask.askId}`, ch.origin, {
      [`q.${ask.questionId}`]: ask.yes,
    });
    expect(post.status).toBe(403);
    // A one-tap poll token is not a survey-page token.
    const memberId = await addMember(ch.channelId, uniqueEmail());
    const pollToken = await askToken(keys(), { memberId, channelId: ch.channelId }, ask.yes);
    const withPoll = await postForm(`${ch.origin}/_swarm/ask/${ask.askId}`, ch.origin, {
      t: pollToken,
      [`q.${ask.questionId}`]: ask.yes,
    });
    expect(withPoll.status).toBe(403);
    expect(await answers(ask.askId)).toEqual([]);
  });

  it('records a signed-in reader’s answers, requiring the required ones', async () => {
    const ch = await seedChannel();
    const ask = await seedAsk(ch);
    const memberId = await addMember(ch.channelId, uniqueEmail());
    const cookie = await sessionCookie(ch.channelId, memberId);
    const page = await (
      await get(`${ch.origin}/_swarm/ask/${ask.askId}?o=${ask.no}`, { headers: { cookie } })
    ).text();
    expect(page).toContain(`value="${ask.no}" checked`);
    const missing = await postForm(
      `${ch.origin}/_swarm/ask/${ask.askId}`,
      ch.origin,
      { [`q.${ask.textId}`]: 'Because' },
      cookie,
    );
    expect(missing.status).toBe(400);
    const ok = await postForm(
      `${ch.origin}/_swarm/ask/${ask.askId}`,
      ch.origin,
      { [`q.${ask.questionId}`]: ask.yes, [`q.${ask.textId}`]: 'Because' },
      cookie,
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('your answers are saved');
    const rows = await answers(ask.askId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.member_id === memberId && r.surface === 'page')).toBe(true);
    // Cross-site posts are refused.
    const cross = await postForm(
      `${ch.origin}/_swarm/ask/${ask.askId}`,
      'https://evil.example',
      { [`q.${ask.questionId}`]: ask.no },
      cookie,
    );
    expect(cross.status).toBe(403);
  });

  it('accepts a survey-page link for its own Ask only, and hides other publications’ Asks', async () => {
    const ch = await seedChannel();
    const ask = await seedAsk(ch);
    const other = await seedAsk(ch);
    const memberId = await addMember(ch.channelId, uniqueEmail());
    const token = await askPageToken(keys(), { memberId, channelId: ch.channelId }, ask.askId);
    const ok = await postForm(`${ch.origin}/_swarm/ask/${ask.askId}`, ch.origin, {
      t: token,
      [`q.${ask.questionId}`]: ask.yes,
    });
    expect(ok.status).toBe(200);
    const wrong = await postForm(`${ch.origin}/_swarm/ask/${other.askId}`, ch.origin, {
      t: token,
      [`q.${other.questionId}`]: other.yes,
    });
    expect(wrong.status).toBe(403);
    const elsewhere = await seedChannel();
    expect((await get(`${elsewhere.origin}/_swarm/ask/${ask.askId}`)).status).toBe(404);
    const draft = await seedAsk(ch, 'draft');
    expect((await get(`${ch.origin}/_swarm/ask/${draft.askId}`)).status).toBe(404);
  });
});

describe('poll blocks on post pages', () => {
  it('link each option to the survey page', async () => {
    const ch = await seedChannel();
    const ask = await seedAsk(ch);
    await seedDispatch(ch, 'polled', [
      p('Intro'),
      { type: 'askPoll', attrs: { askId: ask.askId, questionId: ask.questionId } },
    ]);
    const html = await (await get(`${ch.origin}/p/polled`)).text();
    expect(html).toContain(`href="/_swarm/ask/${ask.askId}?o=${ask.yes}"`);
    expect(html).toContain('More foxes?');
  });
});

describe('Smart Prompts on the site', () => {
  it('render at dispatch_end and gate_hit without script, only with the flag', async () => {
    const ch = await seedChannel();
    await seedDispatch(ch, 'off-one', [p('Body text')]);
    await seedDispatch(ch, 'open-one', [p('Body text')]);
    await seedDispatch(ch, 'members-one', [p('Free'), { type: 'gate' }, p('Secret')], 'members');
    await seedPrompt(ch, { trigger: 'dispatch_end', paths: ['/p/*'] }, 'End prompt');
    await seedPrompt(ch, { trigger: 'gate_hit' }, 'Gate prompt');

    let html = await (await get(`${ch.origin}/p/off-one`)).text();
    expect(html).not.toContain('End prompt');

    await enableFlag(ch, 'smart_prompts');
    html = await (await get(`${ch.origin}/p/open-one`)).text();
    expect(html).toContain('End prompt');
    expect(html).not.toContain('Gate prompt');
    expect(html).not.toContain('data-sw-prompt');
    expect(html).not.toContain(PROMPT_SCRIPT.slice(0, 40));
    expect(html).toContain('action="/_swarm/prompt/dismiss"');

    html = await (await get(`${ch.origin}/p/members-one`)).text();
    expect(html).toContain('Gate prompt');
    expect(html).not.toContain('End prompt');

    // A signed-in Member sees no anonymous-only prompt.
    const memberId = await addMember(ch.channelId, uniqueEmail());
    const cookie = await sessionCookie(ch.channelId, memberId);
    html = await (await get(`${ch.origin}/p/open-one`, { headers: { cookie } })).text();
    expect(html).not.toContain('End prompt');
  });

  it('reveals floating prompts with a small nonce’d script and respects dismissals', async () => {
    expect(new TextEncoder().encode(PROMPT_SCRIPT).length).toBeLessThan(2048);
    const ch = await seedChannel();
    await enableFlag(ch, 'smart_prompts');
    await seedDispatch(ch, 'float', [p('Body')]);
    const id = await seedPrompt(
      ch,
      { trigger: 'scroll', value: 50, readers: 'everyone', cooldownDays: 7 },
      'Scroll prompt',
    );
    const res = await get(`${ch.origin}/p/float`);
    const html = await res.text();
    expect(html).toContain('data-sw-prompt="scroll" data-sw-value="50" hidden');
    const csp = res.headers.get('content-security-policy')!;
    const nonce = /'nonce-([^']+)'/.exec(csp)![1]!;
    const scripts = [...html.matchAll(/<script([^>]*)>/g)].map((m) => m[1]!);
    expect(scripts.length).toBeGreaterThan(0);
    for (const attrs of scripts) {
      if (attrs.includes('application/ld+json')) continue;
      expect(attrs).toContain(`nonce="${nonce}"`);
      expect(attrs).not.toContain('src=');
    }

    const dismiss = await postForm(`${ch.origin}/_swarm/prompt/dismiss`, ch.origin, {
      id,
      return: '/p/float',
    });
    expect(dismiss.status).toBe(303);
    expect(dismiss.headers.get('location')).toBe('/p/float');
    const cookie = /(swarm_prompts=[^;]+)/.exec(dismiss.headers.get('set-cookie') ?? '')![1]!;
    expect(cookie).toContain(id);
    const after = await get(`${ch.origin}/p/float`, { headers: { cookie } });
    expect(after.headers.get('x-swarm-cache')).toBeNull();
    expect(await after.text()).not.toContain('Scroll prompt');

    // Cross-site dismissals and unknown ids set nothing; off-site returns go home.
    const cross = await postForm(`${ch.origin}/_swarm/prompt/dismiss`, 'https://evil.example', {
      id,
      return: 'https://evil.example/',
    });
    expect(cross.headers.get('set-cookie')).toBeNull();
    expect(cross.headers.get('location')).toBe('/');
  });
});
