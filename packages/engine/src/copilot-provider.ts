/**
 * Copilot model providers (Phase 8). One small interface, so the editor assistant and Copilot
 * actions (copilot_actions) call a model the same way whatever the provider:
 *
 *   stream()       yields text deltas, then one `done` with token counts and why it stopped;
 *   complete()     one non-streaming turn with tools: text, tool calls, tokens, why it stopped
 *                  (only on providers that support tool calling; `toolCalling` says which);
 *   validateKey()  asks the provider whether the key this provider was built with works.
 *
 * Implementations:
 * - WorkersAiCopilot: the `AI` binding (Workers AI), the platform default.
 * - AnthropicCopilot: the official SDK (@anthropic-ai/sdk), Messages API; the optional external
 *   provider on the platform, and the only provider a workspace can bring its own key for.
 * - DevCopilot: deterministic, no network; COPILOT_ADAPTER=dev, development and test only.
 *
 * With AI_GATEWAY_ID set, Workers AI and Anthropic calls go through Cloudflare AI Gateway, with
 * logging and caching turned off on every request (docs/copilot.md "Data handling").
 *
 * None logs or keeps request or response text. Errors come out as CopilotProviderError with a
 * kind and the provider's HTTP status, never the provider's message (it may quote input).
 */
import Anthropic from '@anthropic-ai/sdk';
import type { CopilotAdapter } from '@swarm/domain';
import { z } from 'zod';

export interface CopilotModelRequest {
  model: string;
  /** Instructions. */
  system: string;
  /** The user turn: instructions plus the delimited content. */
  prompt: string;
  maxTokens: number;
  signal?: AbortSignal;
}

export type CopilotStopReason = 'end' | 'max_tokens' | 'refusal';

export type CopilotStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; inputTokens: number; outputTokens: number; stop: CopilotStopReason };

export type CopilotKeyCheck = { ok: true } | { ok: false; reason: 'rejected' | 'unreachable' };

/** A tool the model may call: a JSON Schema for its arguments. */
export interface CopilotToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CopilotToolCall {
  /** The provider's id for the call, echoed with its result. */
  id: string;
  name: string;
  /** The parsed arguments; `{}` when the model sent none. */
  arguments: unknown;
  /** The model's arguments were not valid JSON. */
  invalid?: boolean;
}

export interface CopilotToolResult {
  callId: string;
  content: string;
  isError: boolean;
}

/** A provider-neutral conversation. `native` carries the provider's own assistant content. */
export type CopilotChatMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: CopilotToolCall[]; native?: unknown }
  | { role: 'tool'; results: CopilotToolResult[] };

export interface CopilotToolTurnRequest {
  model: string;
  system: string;
  messages: CopilotChatMessage[];
  tools: CopilotToolSpec[];
  maxTokens: number;
  signal?: AbortSignal;
}

export interface CopilotToolTurn {
  text: string;
  toolCalls: CopilotToolCall[];
  inputTokens: number;
  outputTokens: number;
  stop: CopilotStopReason | 'tool_use';
  /** Append back unchanged as the assistant message's `native` (Anthropic content blocks). */
  native?: unknown;
}

export interface CopilotProvider {
  readonly name: CopilotAdapter;
  /** complete() is available. */
  readonly toolCalling: boolean;
  stream(request: CopilotModelRequest): AsyncIterable<CopilotStreamEvent>;
  complete(request: CopilotToolTurnRequest): Promise<CopilotToolTurn>;
  validateKey(signal?: AbortSignal): Promise<CopilotKeyCheck>;
}

export type CopilotProviderErrorKind =
  /** The key was refused (401/403). */
  | 'auth'
  /** The provider's rate limit (429) after the SDK's retries. */
  | 'rate_limited'
  /** The provider refused the request as malformed (400/404/413/422), e.g. an unknown model. */
  | 'invalid'
  /** Network failure, timeout, 5xx or overloaded, after retries. */
  | 'unavailable'
  /** The caller aborted. */
  | 'aborted';

export class CopilotProviderError extends Error {
  constructor(
    readonly kind: CopilotProviderErrorKind,
    readonly status: number | null = null,
  ) {
    super(`copilot provider error: ${kind}${status ? ` (${status})` : ''}`);
    this.name = 'CopilotProviderError';
  }
}

// ---------------------------------------------------------------------------------------------
// Env

/**
 * What a worker needs of the `AI` binding: `run` with a model id that is a var, not a literal.
 * The workers-types `Ai` class fits this shape.
 */
export interface WorkersAiBinding {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options?: { gateway?: AiGatewayOptions; signal?: AbortSignal },
  ): Promise<unknown>;
}

/** The AI Gateway options Copilot sends with every Workers AI call. */
export interface AiGatewayOptions {
  id: string;
  skipCache: boolean;
  collectLog: boolean;
}

/** Env fields of a worker that runs Copilot (the api worker). */
export const CopilotEnvFields = {
  /**
   * The platform's provider: 'workers-ai' (the default in wrangler.jsonc), 'anthropic' (the
   * optional external provider), or 'dev' (the deterministic fake, development and test only).
   */
  COPILOT_ADAPTER: z.enum(['workers-ai', 'anthropic', 'dev']),
  /** The Anthropic model id (platform adapter 'anthropic' and every workspace key). A var. */
  COPILOT_MODEL: z.string().min(3).max(100),
  /** The Workers AI model id, e.g. @cf/moonshotai/kimi-k2.6. A var. */
  COPILOT_WORKERS_AI_MODEL: z
    .string()
    .regex(/^@[a-z0-9-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, 'a Workers AI model id'),
  /** The platform key. Optional: only COPILOT_ADAPTER=anthropic uses it. */
  ANTHROPIC_API_KEY: z.string().min(20).optional(),
  /** The Workers AI binding. Required with COPILOT_ADAPTER=workers-ai. */
  AI: z.custom<WorkersAiBinding>((value) => typeof value === 'object' && value !== null).optional(),
  /** Cloudflare AI Gateway for model calls. Optional; set it together with the account id. */
  AI_GATEWAY_ID: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
    .optional(),
  /** The Cloudflare account that owns the gateway (the Anthropic route's URL needs it). */
  AI_GATEWAY_ACCOUNT_ID: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .optional(),
};

export interface CopilotEnv {
  ENVIRONMENT: string;
  COPILOT_ADAPTER: CopilotAdapter;
  COPILOT_MODEL: string;
  COPILOT_WORKERS_AI_MODEL: string;
  ANTHROPIC_API_KEY?: string | undefined;
  AI?: WorkersAiBinding | undefined;
  AI_GATEWAY_ID?: string | undefined;
  AI_GATEWAY_ACCOUNT_ID?: string | undefined;
}

/** Use inside a worker env schema's superRefine. */
export function checkCopilotEnv(env: CopilotEnv, ctx: z.RefinementCtx): void {
  const local = env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test';
  if (env.COPILOT_ADAPTER === 'dev' && !local) {
    ctx.addIssue({
      code: 'custom',
      path: ['COPILOT_ADAPTER'],
      message: 'the dev Copilot adapter is only allowed in development and test',
    });
  }
  if (env.COPILOT_ADAPTER === 'workers-ai' && !env.AI) {
    ctx.addIssue({
      code: 'custom',
      path: ['AI'],
      message: 'the AI binding is required when COPILOT_ADAPTER is "workers-ai"',
    });
  }
  if (!!env.AI_GATEWAY_ID !== !!env.AI_GATEWAY_ACCOUNT_ID) {
    ctx.addIssue({
      code: 'custom',
      path: ['AI_GATEWAY_ACCOUNT_ID'],
      message: 'set AI_GATEWAY_ID and AI_GATEWAY_ACCOUNT_ID together, or neither',
    });
  }
}

/** The gateway in use, or null. */
export interface AiGateway {
  id: string;
  accountId: string;
}

export const aiGatewayOf = (
  env: Pick<CopilotEnv, 'AI_GATEWAY_ID' | 'AI_GATEWAY_ACCOUNT_ID'>,
): AiGateway | null =>
  env.AI_GATEWAY_ID && env.AI_GATEWAY_ACCOUNT_ID
    ? { id: env.AI_GATEWAY_ID, accountId: env.AI_GATEWAY_ACCOUNT_ID }
    : null;

/**
 * Sent on every gateway request: no log of the request and response bodies, no cache entry.
 * Gateway analytics (counts, tokens, latency, model, status) are still recorded.
 */
export const AI_GATEWAY_PRIVACY_HEADERS = {
  'cf-aig-collect-log': 'false',
  'cf-aig-skip-cache': 'true',
} as const;

export interface CopilotProviderOptions {
  /** The vault's provider proxy for a workspace's own key (which it attaches); tests inject one. */
  fetch?: typeof fetch;
  /** Route through Cloudflare AI Gateway. */
  gateway?: AiGateway | null;
}

/**
 * The provider for a workspace's own key (always Anthropic; the dev fake under
 * COPILOT_ADAPTER=dev), built with that key.
 */
export function createCopilotProvider(
  env: Pick<CopilotEnv, 'COPILOT_ADAPTER'>,
  apiKey: string,
  options: CopilotProviderOptions = {},
): CopilotProvider {
  return env.COPILOT_ADAPTER === 'dev'
    ? new DevCopilot(apiKey)
    : new AnthropicCopilot(apiKey, options);
}

/** The platform's provider and the model it runs, or null when it can't serve requests. */
export function platformCopilotProvider(
  env: CopilotEnv,
  options: Omit<CopilotProviderOptions, 'gateway'> = {},
): { provider: CopilotProvider; model: string } | null {
  const gateway = aiGatewayOf(env);
  switch (env.COPILOT_ADAPTER) {
    case 'workers-ai':
      return env.AI
        ? { provider: new WorkersAiCopilot(env.AI, gateway), model: env.COPILOT_WORKERS_AI_MODEL }
        : null;
    case 'anthropic':
      return env.ANTHROPIC_API_KEY
        ? {
            provider: new AnthropicCopilot(env.ANTHROPIC_API_KEY, { ...options, gateway }),
            model: env.COPILOT_MODEL,
          }
        : null;
    case 'dev':
      // The offline fake needs no key; the placeholder only satisfies the constructor.
      return { provider: new DevCopilot('dev-platform-key'), model: env.COPILOT_MODEL };
  }
}

/** The model of the platform adapter, for settings. */
export const platformCopilotModel = (env: CopilotEnv) =>
  env.COPILOT_ADAPTER === 'workers-ai' ? env.COPILOT_WORKERS_AI_MODEL : env.COPILOT_MODEL;

// ---------------------------------------------------------------------------------------------
// Anthropic

/**
 * Models that take server-side refusal fallback in its "default" form. Elsewhere the parameter is
 * left out, because some models answer it with a 400.
 */
const FALLBACK_MODELS = new Set([
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-fable-5-1',
  'claude-sonnet-5-5',
]);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Anthropic's base URL through a gateway (the gateway's `anthropic` provider route). */
export const anthropicGatewayUrl = (gateway: AiGateway) =>
  `https://gateway.ai.cloudflare.com/v1/${gateway.accountId}/${gateway.id}/anthropic`;

type AnthropicStop = Anthropic.Beta.Messages.BetaMessage['stop_reason'];

const anthropicStop = (reason: AnthropicStop): CopilotStopReason =>
  reason === 'refusal'
    ? 'refusal'
    : reason === 'max_tokens' || reason === 'model_context_window_exceeded'
      ? 'max_tokens'
      : 'end';

const anthropicInputTokens = (usage: Anthropic.Beta.Messages.BetaUsage) =>
  usage.input_tokens +
  (usage.cache_creation_input_tokens ?? 0) +
  (usage.cache_read_input_tokens ?? 0);

/**
 * Anthropic's Messages API through the official SDK. Notes on what it sends:
 * - Effort `low` for the editor's short, well-specified writing tasks, `medium` for tool use.
 *   Adaptive thinking stays at the model's default (it can't be turned off on current models),
 *   so `thinking` is not sent.
 * - No `metadata.user_id` and no other identifier of the operator or workspace.
 * - Training and retention can't be set per request on this API (no header or parameter
 *   exists): the commercial terms exclude training, and zero retention is an agreement on the
 *   organisation that owns the key (docs/copilot.md "Data handling").
 * - Through AI Gateway: the gateway's Anthropic URL, with logging and caching off per request.
 */
export class AnthropicCopilot implements CopilotProvider {
  readonly name = 'anthropic' as const;
  readonly toolCalling = true;
  private readonly client: Anthropic;

  constructor(apiKey: string, options: CopilotProviderOptions = {}) {
    // fetch is wrapped: calling the bare global as a method throws "Illegal invocation" in workerd.
    const fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.client = new Anthropic({
      apiKey,
      maxRetries: 2,
      timeout: 120_000,
      fetch: fetcher,
      ...(options.gateway
        ? {
            baseURL: anthropicGatewayUrl(options.gateway),
            defaultHeaders: { ...AI_GATEWAY_PRIVACY_HEADERS },
          }
        : {}),
    });
  }

  private fallbacks(model: string) {
    return FALLBACK_MODELS.has(model)
      ? { fallbacks: 'default' as const, betas: [FALLBACK_BETA] }
      : {};
  }

  async *stream(request: CopilotModelRequest): AsyncGenerator<CopilotStreamEvent> {
    try {
      const stream = this.client.beta.messages.stream(
        {
          model: request.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.prompt }],
          output_config: { effort: 'low' },
          ...this.fallbacks(request.model),
        },
        request.signal ? { signal: request.signal } : {},
      );
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'delta', text: event.delta.text };
        }
      }
      const message = await stream.finalMessage();
      yield {
        type: 'done',
        inputTokens: anthropicInputTokens(message.usage),
        outputTokens: message.usage.output_tokens,
        stop: anthropicStop(message.stop_reason),
      };
    } catch (error) {
      throw anthropicError(error);
    }
  }

  async complete(request: CopilotToolTurnRequest): Promise<CopilotToolTurn> {
    const messages: Anthropic.Beta.Messages.BetaMessageParam[] = request.messages.map(
      (message): Anthropic.Beta.Messages.BetaMessageParam => {
        if (message.role === 'user') return { role: 'user', content: message.text };
        if (message.role === 'tool') {
          return {
            role: 'user',
            content: message.results.map((result) => ({
              type: 'tool_result' as const,
              tool_use_id: result.callId,
              content: result.content,
              ...(result.isError ? { is_error: true } : {}),
            })),
          };
        }
        // The assistant's own content goes back unchanged (thinking blocks included).
        if (Array.isArray(message.native)) {
          return {
            role: 'assistant',
            content: message.native as Anthropic.Beta.Messages.BetaContentBlockParam[],
          };
        }
        return {
          role: 'assistant',
          content: [
            ...(message.text ? [{ type: 'text' as const, text: message.text }] : []),
            ...message.toolCalls.map((call) => ({
              type: 'tool_use' as const,
              id: call.id,
              name: call.name,
              input: call.arguments ?? {},
            })),
          ],
        };
      },
    );
    try {
      const message = await this.client.beta.messages.create(
        {
          model: request.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages,
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema as Anthropic.Beta.Messages.BetaTool['input_schema'],
          })),
          output_config: { effort: 'medium' },
          // The tools and system prompt repeat every turn: cache the prefix.
          cache_control: { type: 'ephemeral' },
          ...this.fallbacks(request.model),
        },
        request.signal ? { signal: request.signal } : {},
      );
      const text = message.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('');
      const toolCalls = message.content.flatMap((block) =>
        block.type === 'tool_use'
          ? [{ id: block.id, name: block.name, arguments: block.input ?? {} }]
          : [],
      );
      return {
        text,
        toolCalls,
        inputTokens: anthropicInputTokens(message.usage),
        outputTokens: message.usage.output_tokens,
        stop: message.stop_reason === 'tool_use' ? 'tool_use' : anthropicStop(message.stop_reason),
        native: message.content,
      };
    } catch (error) {
      throw anthropicError(error);
    }
  }

  async validateKey(signal?: AbortSignal): Promise<CopilotKeyCheck> {
    try {
      // Listing models needs a valid key and costs no tokens.
      await this.client.models.list({ limit: 1 }, signal ? { signal } : {});
      return { ok: true };
    } catch (error) {
      const mapped = anthropicError(error);
      return { ok: false, reason: mapped.kind === 'auth' ? 'rejected' : 'unreachable' };
    }
  }
}

/** Typed SDK errors, most specific first, to a provider-neutral kind. */
function anthropicError(error: unknown): CopilotProviderError {
  if (error instanceof CopilotProviderError) return error;
  if (error instanceof Anthropic.APIUserAbortError) return new CopilotProviderError('aborted');
  if (error instanceof Anthropic.AuthenticationError) return new CopilotProviderError('auth', 401);
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new CopilotProviderError('auth', 403);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new CopilotProviderError('rate_limited', 429);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new CopilotProviderError('unavailable');
  }
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === 'number' ? error.status : null;
    if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 409) {
      return new CopilotProviderError('invalid', status);
    }
    return new CopilotProviderError('unavailable', status);
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new CopilotProviderError('aborted');
  }
  return new CopilotProviderError('unavailable');
}

// ---------------------------------------------------------------------------------------------
// Workers AI

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Token counts from either response shape (OpenAI-style `usage`). */
function workersAiUsage(output: Json): { inputTokens: number; outputTokens: number } {
  const usage = isObject(output.usage) ? output.usage : {};
  const n = (value: unknown) => (typeof value === 'number' && value >= 0 ? value : 0);
  return { inputTokens: n(usage.prompt_tokens), outputTokens: n(usage.completion_tokens) };
}

const workersAiStop = (reason: unknown): CopilotStopReason | 'tool_use' =>
  reason === 'length'
    ? 'max_tokens'
    : reason === 'content_filter'
      ? 'refusal'
      : reason === 'tool_calls'
        ? 'tool_use'
        : 'end';

function parseArguments(raw: unknown): { value: unknown; invalid: boolean } {
  if (isObject(raw)) return { value: raw, invalid: false };
  if (typeof raw !== 'string' || raw.trim() === '') return { value: {}, invalid: false };
  try {
    return { value: JSON.parse(raw) as unknown, invalid: false };
  } catch {
    return { value: {}, invalid: true };
  }
}

/** Errors from the binding carry a message only; it can quote input, so only a kind leaves. */
function workersAiError(error: unknown): CopilotProviderError {
  if (error instanceof CopilotProviderError) return error;
  if (error instanceof Error && error.name === 'AbortError') {
    return new CopilotProviderError('aborted');
  }
  const message = error instanceof Error ? error.message : '';
  // Workers AI's documented error codes: 3036/3040 capacity and rate limits, 5007/5018 bad
  // input or unknown model, 1031/10000 authentication of the binding's account.
  if (/\b(429|3036|3040)\b/.test(message)) return new CopilotProviderError('rate_limited', 429);
  if (/\b(5007|5018|5004|400|404|413)\b/.test(message)) {
    return new CopilotProviderError('invalid', 400);
  }
  if (/\b(10000|1031|401|403)\b/.test(message)) return new CopilotProviderError('auth', 403);
  return new CopilotProviderError('unavailable');
}

/** Reads a Workers AI event stream (text/event-stream of JSON chunks, ending with [DONE]). */
async function* workersAiChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Json> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          const chunk = JSON.parse(data) as unknown;
          if (isObject(chunk)) yield chunk;
        } catch {
          // A malformed chunk is skipped rather than failing the whole answer.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Workers AI through the `AI` binding, in the OpenAI-compatible chat format the current text
 * models take (messages, tools, max_tokens, stream). Older models answer `{ response }` instead
 * of `choices`; both are read. Model-specific reasoning settings are not sent, so any chat model
 * of the catalogue can be configured in COPILOT_WORKERS_AI_MODEL; reasoning text is ignored.
 * There is no key: the binding is the account's. With a gateway, every call carries
 * `gateway: { id, skipCache: true, collectLog: false }`.
 */
export class WorkersAiCopilot implements CopilotProvider {
  readonly name = 'workers-ai' as const;
  readonly toolCalling = true;

  constructor(
    private readonly ai: WorkersAiBinding,
    private readonly gateway: AiGateway | null = null,
  ) {}

  private options(signal?: AbortSignal) {
    return {
      ...(this.gateway
        ? { gateway: { id: this.gateway.id, skipCache: true, collectLog: false } }
        : {}),
      ...(signal ? { signal } : {}),
    };
  }

  async *stream(request: CopilotModelRequest): AsyncGenerator<CopilotStreamEvent> {
    let output: unknown;
    try {
      output = await this.ai.run(
        request.model,
        {
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.prompt },
          ],
          max_tokens: request.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
        },
        this.options(request.signal),
      );
    } catch (error) {
      throw workersAiError(error);
    }
    if (!(output instanceof ReadableStream)) throw new CopilotProviderError('unavailable');
    let usage = { inputTokens: 0, outputTokens: 0 };
    let stop: CopilotStopReason = 'end';
    try {
      for await (const chunk of workersAiChunks(output as ReadableStream<Uint8Array>)) {
        if (request.signal?.aborted) throw new CopilotProviderError('aborted');
        const choice =
          Array.isArray(chunk.choices) && isObject(chunk.choices[0]) ? chunk.choices[0] : null;
        const delta = choice && isObject(choice.delta) ? choice.delta.content : chunk.response;
        if (typeof delta === 'string' && delta) yield { type: 'delta', text: delta };
        if (choice?.finish_reason) {
          const reason = workersAiStop(choice.finish_reason);
          stop = reason === 'tool_use' ? 'end' : reason;
        }
        if (isObject(chunk.usage)) usage = workersAiUsage(chunk);
      }
    } catch (error) {
      throw workersAiError(error);
    }
    yield { type: 'done', ...usage, stop };
  }

  async complete(request: CopilotToolTurnRequest): Promise<CopilotToolTurn> {
    const messages: Json[] = [{ role: 'system', content: request.system }];
    for (const message of request.messages) {
      if (message.role === 'user') messages.push({ role: 'user', content: message.text });
      else if (message.role === 'tool') {
        for (const result of message.results) {
          messages.push({ role: 'tool', tool_call_id: result.callId, content: result.content });
        }
      } else {
        messages.push({
          role: 'assistant',
          content: message.text,
          ...(message.toolCalls.length
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
                })),
              }
            : {}),
        });
      }
    }
    let output: unknown;
    try {
      output = await this.ai.run(
        request.model,
        {
          messages,
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
          max_tokens: request.maxTokens,
        },
        this.options(request.signal),
      );
    } catch (error) {
      throw workersAiError(error);
    }
    if (!isObject(output)) throw new CopilotProviderError('unavailable');
    const choice =
      Array.isArray(output.choices) && isObject(output.choices[0]) ? output.choices[0] : null;
    const message = choice && isObject(choice.message) ? choice.message : output;
    const text =
      typeof message.content === 'string'
        ? message.content
        : typeof output.response === 'string'
          ? output.response
          : '';
    const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const toolCalls: CopilotToolCall[] = rawCalls.flatMap((raw, index) => {
      if (!isObject(raw)) return [];
      // OpenAI shape { id, function: { name, arguments } }, or the older { name, arguments }.
      const fn = isObject(raw.function) ? raw.function : raw;
      if (typeof fn.name !== 'string') return [];
      const parsed = parseArguments(fn.arguments);
      return [
        {
          id: typeof raw.id === 'string' && raw.id ? raw.id : `call_${index}`,
          name: fn.name,
          arguments: parsed.value,
          ...(parsed.invalid ? { invalid: true } : {}),
        },
      ];
    });
    const stop = toolCalls.length ? 'tool_use' : workersAiStop(choice?.finish_reason);
    return { text, toolCalls, ...workersAiUsage(output), stop };
  }

  /** The binding has no key of its own to check. */
  async validateKey(): Promise<CopilotKeyCheck> {
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------------------------
// Dev fake

/**
 * Deterministic and offline. The result is a fixed transformation of the delimited content, so
 * tests can assert on it, streamed in small chunks like a real model. A key is accepted when it
 * is well formed and does not contain "invalid".
 *
 * complete() is a scripted, gullible model: it calls every tool named as
 * `dev:call <tool> <json arguments>` (one level of nesting) in the latest message (the
 * operator's request or a tool's answer), and otherwise ends with a short summary. Following lines found in tool answers is
 * what a model taken in by a prompt injection would do; tests use it to show that the loop, not
 * the model, keeps such calls from running.
 */
export class DevCopilot implements CopilotProvider {
  readonly name = 'dev' as const;
  readonly toolCalling = true;

  constructor(private readonly apiKey: string) {}

  async *stream(request: CopilotModelRequest): AsyncGenerator<CopilotStreamEvent> {
    if (this.apiKey.includes('invalid')) throw new CopilotProviderError('auth', 401);
    const output = devOutput(request);
    const words = output.match(/\S+\s*|\s+/g) ?? [];
    for (let i = 0; i < words.length; i += 3) {
      if (request.signal?.aborted) throw new CopilotProviderError('aborted');
      yield { type: 'delta', text: words.slice(i, i + 3).join('') };
    }
    yield {
      type: 'done',
      inputTokens: Math.ceil((request.system.length + request.prompt.length) / 4),
      outputTokens: Math.ceil(output.length / 4),
      stop: 'end',
    };
  }

  async complete(request: CopilotToolTurnRequest): Promise<CopilotToolTurn> {
    if (this.apiKey.includes('invalid')) throw new CopilotProviderError('auth', 401);
    const last = request.messages.at(-1);
    // A tool's answer is JSON: its strings are read as a model would read the text in them.
    const strings = (value: unknown): string[] =>
      typeof value === 'string'
        ? [value]
        : Array.isArray(value)
          ? value.flatMap(strings)
          : isObject(value)
            ? Object.values(value).flatMap(strings)
            : [];
    const source =
      last?.role === 'user'
        ? last.text
        : last?.role === 'tool'
          ? last.results
              .flatMap((result) => {
                try {
                  return strings(JSON.parse(result.content) as unknown);
                } catch {
                  // A cut answer is no longer JSON: read it raw, quotes unescaped.
                  return [result.content.replace(/\\"/g, '"')];
                }
              })
              .join('\n')
          : '';
    const calls: CopilotToolCall[] = [];
    for (const match of source.matchAll(/dev:call ([a-z_]+) (\{(?:[^{}]|\{[^{}]*\})*\})/g)) {
      const parsed = parseArguments(match[2]);
      calls.push({
        id: `dev_${request.messages.length}_${calls.length}`,
        name: match[1]!,
        arguments: parsed.value,
        ...(parsed.invalid ? { invalid: true } : {}),
      });
    }
    const inputTokens = Math.ceil(
      (request.system.length + JSON.stringify(request.messages).length) / 4,
    );
    const text = calls.length ? '' : `Done after ${request.messages.length} messages.`;
    return {
      text,
      toolCalls: calls,
      inputTokens,
      outputTokens: Math.ceil((text.length + JSON.stringify(calls).length) / 4),
      stop: calls.length ? 'tool_use' : 'end',
    };
  }

  async validateKey(): Promise<CopilotKeyCheck> {
    return this.apiKey.includes('invalid') ? { ok: false, reason: 'rejected' } : { ok: true };
  }
}

/** What the fake "writes": keyed off the task line the prompt builder puts first. */
function devOutput(request: CopilotModelRequest): string {
  const content = /<dispatch_content>\n?([\s\S]*?)\n?<\/dispatch_content>/.exec(
    request.prompt,
  )?.[1];
  const text = (content ?? '').trim();
  const words = text.split(/\s+/).filter(Boolean);
  const head = words.slice(0, 6).join(' ');
  const task = /^Task: (\S+)/m.exec(request.prompt)?.[1] ?? '';
  switch (task) {
    case 'subject_lines':
      return [1, 2, 3, 4, 5].map((n) => `${n}. Subject idea ${n}: ${head}`).join('\n');
    case 'preview_text':
      return [1, 2, 3, 4, 5].map((n) => `${n}. Preview ${n}: ${head}`).join('\n');
    case 'teaser':
      return `Teaser: ${head}.`;
    case 'social_posts':
      return [
        '=== short ===',
        `Short: ${head} [LINK]`,
        '=== long ===',
        `Long: ${text}`,
        '',
        'Read it here: [LINK]',
        '=== thread ===',
        `1/ ${head}`,
        '---',
        `2/ More in the post: [LINK]`,
      ].join('\n');
    case 'fix_grammar':
      return text.charAt(0).toUpperCase() + text.slice(1);
    case 'translate': {
      const language = /^Language: (.+)$/m.exec(request.prompt)?.[1] ?? '';
      return `[${language}] ${text}`;
    }
    case 'rewrite': {
      const style = /^Style: (\S+)$/m.exec(request.prompt)?.[1] ?? '';
      if (style === 'shorter')
        return words.slice(0, Math.max(1, Math.ceil(words.length / 2))).join(' ');
      if (style === 'longer') return `${text} ${text}`;
      return `(${style}) ${text}`;
    }
    default:
      return text;
  }
}
