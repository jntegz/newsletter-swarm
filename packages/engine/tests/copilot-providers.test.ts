// Copilot providers beyond the editor stream: Workers AI through a fake `AI` binding, AI Gateway
// routing for Workers AI and Anthropic (logging and caching off per request), tool calling on
// both, the platform adapter choice, the env checks, and the Share Kit parser. No test calls a
// real model.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AnthropicCopilot,
  CopilotEnvFields,
  CopilotProviderError,
  DevCopilot,
  WorkersAiCopilot,
  checkCopilotEnv,
  parseSocialPosts,
  platformCopilotProvider,
  type CopilotEnv,
  type CopilotStreamEvent,
  type WorkersAiBinding,
} from '../src/index';

async function collect(stream: AsyncIterable<CopilotStreamEvent>) {
  const events: CopilotStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

interface RunCall {
  model: string;
  inputs: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
}

function fakeAi(answer: (call: RunCall) => unknown) {
  const calls: RunCall[] = [];
  const ai: WorkersAiBinding = {
    run: async (model, inputs, options) => {
      const call = { model, inputs, options: options as Record<string, unknown> | undefined };
      calls.push(call);
      const result = answer(call);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { ai, calls };
}

const sse = (chunks: unknown[]) =>
  new Response(
    [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'].join(''),
  ).body!;

const request = {
  model: '@cf/moonshotai/kimi-k2.6',
  system: 'SYSTEM',
  prompt: 'PROMPT',
  maxTokens: 4000,
};
const gateway = { id: 'swarm-copilot', accountId: 'a'.repeat(32) };

describe('WorkersAiCopilot', () => {
  it('streams OpenAI-style chunks and the usage record', async () => {
    const { ai, calls } = fakeAi(() =>
      sse([
        { choices: [{ delta: { content: 'Hello ' } }] },
        { choices: [{ delta: { reasoning_content: 'thinking…' } }] },
        { choices: [{ delta: { content: 'there' }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 50, completion_tokens: 7 } },
      ]),
    );
    const events = await collect(new WorkersAiCopilot(ai).stream(request));
    expect(events).toEqual([
      { type: 'delta', text: 'Hello ' },
      { type: 'delta', text: 'there' },
      { type: 'done', inputTokens: 50, outputTokens: 7, stop: 'end' },
    ]);
    expect(calls[0]).toMatchObject({
      model: '@cf/moonshotai/kimi-k2.6',
      inputs: {
        messages: [
          { role: 'system', content: 'SYSTEM' },
          { role: 'user', content: 'PROMPT' },
        ],
        max_tokens: 4000,
        stream: true,
      },
    });
    // Without a gateway nothing is routed through one; nothing identifies the operator.
    expect(calls[0]!.options).not.toHaveProperty('gateway');
    expect(calls[0]!.inputs).not.toHaveProperty('user');
    expect(calls[0]!.inputs).not.toHaveProperty('metadata');
  });

  it('reads the older { response } chunks and reports truncation', async () => {
    const { ai } = fakeAi(() =>
      sse([{ response: 'Hi' }, { choices: [{ delta: {}, finish_reason: 'length' }] }]),
    );
    const events = await collect(new WorkersAiCopilot(ai).stream(request));
    expect(events).toEqual([
      { type: 'delta', text: 'Hi' },
      { type: 'done', inputTokens: 0, outputTokens: 0, stop: 'max_tokens' },
    ]);
  });

  it('goes through AI Gateway with logging and caching off when one is set', async () => {
    const { ai, calls } = fakeAi(() => sse([{ response: 'x' }]));
    await collect(new WorkersAiCopilot(ai, gateway).stream(request));
    expect(calls[0]!.options).toMatchObject({
      gateway: { id: 'swarm-copilot', skipCache: true, collectLog: false },
    });
  });

  it('maps binding errors to kinds without the message', async () => {
    for (const [message, kind] of [
      ['3040: Capacity temporarily exceeded, please try again.', 'rate_limited'],
      ['5007: No such model @cf/x/y', 'invalid'],
      ['socket hang up while reading "secret prompt"', 'unavailable'],
    ] as const) {
      const { ai } = fakeAi(() => new Error(message));
      const error = await collect(new WorkersAiCopilot(ai).stream(request)).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(CopilotProviderError);
      expect((error as CopilotProviderError).kind).toBe(kind);
      expect((error as Error).message).not.toContain('prompt');
    }
  });

  it('calls tools in the OpenAI format and reads the tool calls back', async () => {
    const { ai, calls } = fakeAi(() => ({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'list_members', arguments: '{"channelId":"ch_1"}' },
              },
              { id: 'call_2', type: 'function', function: { name: 'get_member', arguments: '{' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 900, completion_tokens: 30 },
    }));
    const turn = await new WorkersAiCopilot(ai, gateway).complete({
      model: '@cf/moonshotai/kimi-k2.6',
      system: 'SYS',
      messages: [
        { role: 'user', text: 'Do it' },
        {
          role: 'assistant',
          text: '',
          toolCalls: [{ id: 'call_0', name: 'list_channels', arguments: {} }],
        },
        {
          role: 'tool',
          results: [{ callId: 'call_0', content: '{"status":200}', isError: false }],
        },
      ],
      tools: [{ name: 'list_members', description: 'Members', inputSchema: { type: 'object' } }],
      maxTokens: 4000,
    });
    expect(turn).toMatchObject({
      text: '',
      stop: 'tool_use',
      inputTokens: 900,
      outputTokens: 30,
      toolCalls: [
        { id: 'call_1', name: 'list_members', arguments: { channelId: 'ch_1' } },
        { id: 'call_2', name: 'get_member', arguments: {}, invalid: true },
      ],
    });
    expect(calls[0]!.inputs).toMatchObject({
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'Do it' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_0',
              type: 'function',
              function: { name: 'list_channels', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_0', content: '{"status":200}' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'list_members',
            description: 'Members',
            parameters: { type: 'object' },
          },
        },
      ],
    });
    expect(calls[0]!.options).toMatchObject({ gateway: { collectLog: false, skipCache: true } });
  });
});

// ---------------------------------------------------------------------------------------------

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown> | null;
}

function fakeFetch(respond: () => Response) {
  const calls: Captured[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const raw = await req.text();
    calls.push({
      url: req.url,
      headers: req.headers,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
    });
    return respond();
  }) as typeof fetch;
  return { calls, fetcher };
}

const message = (content: unknown[], stop: string) =>
  Response.json({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 },
  });

describe('AnthropicCopilot', () => {
  it('goes through the AI Gateway URL with logging and caching off', async () => {
    const { calls, fetcher } = fakeFetch(() => Response.json({ data: [], has_more: false }));
    const provider = new AnthropicCopilot('sk-ant-test-key-0000000000', {
      fetch: fetcher,
      gateway,
    });
    expect(await provider.validateKey()).toEqual({ ok: true });
    const url = new URL(calls[0]!.url);
    expect(url.origin).toBe('https://gateway.ai.cloudflare.com');
    expect(url.pathname).toBe(`/v1/${'a'.repeat(32)}/swarm-copilot/anthropic/v1/models`);
    expect(calls[0]!.headers.get('cf-aig-collect-log')).toBe('false');
    expect(calls[0]!.headers.get('cf-aig-skip-cache')).toBe('true');
  });

  it('runs a tool turn and replays its own content unchanged', async () => {
    const content = [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: 'Looking.' },
      { type: 'tool_use', id: 'toolu_1', name: 'list_members', input: { channelId: 'ch_1' } },
    ];
    const { calls, fetcher } = fakeFetch(() => message(content, 'tool_use'));
    const provider = new AnthropicCopilot('sk-ant-test-key-0000000000', { fetch: fetcher });
    const turn = await provider.complete({
      model: 'claude-opus-5-5',
      system: 'SYS',
      messages: [{ role: 'user', text: 'List them' }],
      tools: [{ name: 'list_members', description: 'Members', inputSchema: { type: 'object' } }],
      maxTokens: 4000,
    });
    expect(turn).toMatchObject({
      text: 'Looking.',
      stop: 'tool_use',
      inputTokens: 150,
      outputTokens: 20,
      toolCalls: [{ id: 'toolu_1', name: 'list_members', arguments: { channelId: 'ch_1' } }],
    });
    expect(calls[0]!.body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 4000,
      system: 'SYS',
      tools: [{ name: 'list_members', description: 'Members', input_schema: { type: 'object' } }],
      output_config: { effort: 'medium' },
      fallbacks: 'default',
      cache_control: { type: 'ephemeral' },
    });
    expect(calls[0]!.body).not.toHaveProperty('tool_choice');

    await provider.complete({
      model: 'claude-opus-5-5',
      system: 'SYS',
      messages: [
        { role: 'user', text: 'List them' },
        { role: 'assistant', text: turn.text, toolCalls: turn.toolCalls, native: turn.native },
        {
          role: 'tool',
          results: [{ callId: 'toolu_1', content: '{"status":403}', isError: true }],
        },
      ],
      tools: [],
      maxTokens: 4000,
    });
    expect((calls[1]!.body as { messages: unknown[] }).messages).toEqual([
      { role: 'user', content: 'List them' },
      { role: 'assistant', content },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: '{"status":403}',
            is_error: true,
          },
        ],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------

const env = (over: Partial<CopilotEnv>): CopilotEnv => ({
  ENVIRONMENT: 'production',
  COPILOT_ADAPTER: 'workers-ai',
  COPILOT_MODEL: 'claude-opus-5-5',
  COPILOT_WORKERS_AI_MODEL: '@cf/moonshotai/kimi-k2.6',
  ...over,
});

function issues(value: CopilotEnv): string[] {
  const schema = z.object(CopilotEnvFields).extend({ ENVIRONMENT: z.string() });
  const result = schema
    .superRefine((parsed, ctx) => checkCopilotEnv(parsed as CopilotEnv, ctx))
    .safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('the platform adapter', () => {
  const { ai } = fakeAi(() => ({}));

  it('defaults to Workers AI with its model, Anthropic only with a platform key', () => {
    const workers = platformCopilotProvider(env({ AI: ai }));
    expect(workers?.provider).toBeInstanceOf(WorkersAiCopilot);
    expect(workers?.model).toBe('@cf/moonshotai/kimi-k2.6');
    expect(platformCopilotProvider(env({}))).toBeNull();
    expect(platformCopilotProvider(env({ COPILOT_ADAPTER: 'anthropic' }))).toBeNull();
    const anthropic = platformCopilotProvider(
      env({ COPILOT_ADAPTER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test-key-0000000000' }),
    );
    expect(anthropic?.provider).toBeInstanceOf(AnthropicCopilot);
    expect(anthropic?.model).toBe('claude-opus-5-5');
    expect(platformCopilotProvider(env({ COPILOT_ADAPTER: 'dev' }))?.provider).toBeInstanceOf(
      DevCopilot,
    );
  });

  it('checks the binding, the gateway pair and the dev adapter', () => {
    expect(issues(env({ AI: ai }))).toEqual([]);
    expect(issues(env({}))).toEqual(['AI']);
    expect(issues(env({ AI: ai, AI_GATEWAY_ID: 'swarm-copilot' }))).toEqual([
      'AI_GATEWAY_ACCOUNT_ID',
    ]);
    expect(
      issues(
        env({ AI: ai, AI_GATEWAY_ID: 'swarm-copilot', AI_GATEWAY_ACCOUNT_ID: 'a'.repeat(32) }),
      ),
    ).toEqual([]);
    expect(issues(env({ COPILOT_ADAPTER: 'dev' }))).toEqual(['COPILOT_ADAPTER']);
    expect(issues(env({ AI: ai, COPILOT_WORKERS_AI_MODEL: 'kimi' }))).toEqual([
      'COPILOT_WORKERS_AI_MODEL',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------

describe('Share Kit posts', () => {
  const answer = [
    '=== short ===',
    'New issue: spring in the garden [LINK]',
    '=== long ===',
    'Spring is here.',
    '',
    'Read the whole Dispatch: [LINK]',
    '=== thread ===',
    '1/ Spring is here.',
    '---',
    '2/ The bees are back. Visit https://evil.example',
  ].join('\n');

  it('puts the web link only where the token is, and appends it where it is missing', () => {
    const link = 'https://notes.swarm.page/p/spring';
    expect(parseSocialPosts(answer, link)).toEqual({
      short: `New issue: spring in the garden ${link}`,
      long: `Spring is here.\n\nRead the whole Dispatch: ${link}`,
      thread: ['1/ Spring is here.', `2/ The bees are back. Visit https://evil.example\n\n${link}`],
      link,
    });
  });

  it('drops the token without a website, caps lengths, and needs the layout', () => {
    const posts = parseSocialPosts(answer, null);
    expect(posts?.short).toBe('New issue: spring in the garden');
    expect(JSON.stringify(posts)).not.toContain('[LINK]');
    const long = parseSocialPosts(
      `=== short ===\n${'x'.repeat(400)}\n=== long ===\nok\n=== thread ===\na`,
      'https://l.example/p/x',
    );
    expect(long?.short.startsWith('x'.repeat(279) + '…')).toBe(true);
    expect(long?.short.endsWith('https://l.example/p/x')).toBe(true);
    expect(parseSocialPosts('Here are some posts!', 'https://l.example')).toBeNull();
  });
});
