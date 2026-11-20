// The transport under the generated client: Bearer auth, JSON bodies, the { data } envelope,
// Idempotency-Key, the rate-limit headers and typed errors. Hand-written; generated.ts calls it.

export interface ClientOptions {
  /** The API origin, e.g. https://app.swarm.example (no trailing /v2). */
  baseUrl: string;
  /** A scoped API key (sk_live_…) or an OAuth access token (oat_…). */
  token: string;
  /** Defaults to globalThis.fetch. */
  fetch?: (input: Request) => Promise<Response>;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
}

export interface RequestOptions {
  /** Sent as Idempotency-Key on writes: a retry with the same key replays the first response. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface RateLimit {
  limit: number;
  remaining: number;
  /** Seconds until the bucket is full again. */
  reset: number;
}

export interface ErrorDetail {
  path: string;
  message: string;
}

/** A non-2xx answer: the API's error envelope, plus the HTTP status and rate-limit state. */
export class SwarmApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
    readonly details: ErrorDetail[] = [],
    /** Seconds to wait, on a 429. */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = 'SwarmApiError';
  }
}

export interface Operation {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  pathParams?: Record<string, string>;
  query?: Record<string, unknown> | undefined;
  body?: unknown;
}

const numberHeader = (headers: Headers, name: string) => {
  const value = headers.get(name);
  return value === null ? null : Number(value);
};

export class Transport {
  /** The rate-limit headers of the latest response. */
  rateLimit: RateLimit | null = null;
  readonly #options: ClientOptions;

  constructor(options: ClientOptions) {
    if (!options.baseUrl) throw new Error('baseUrl is required');
    if (!options.token) throw new Error('token is required');
    this.#options = options;
  }

  async request<T>(operation: Operation, options: RequestOptions = {}): Promise<T> {
    let path = operation.path;
    for (const [name, value] of Object.entries(operation.pathParams ?? {})) {
      path = path.replace(`{${name}}`, encodeURIComponent(value));
    }
    const url = new URL(path, this.#options.baseUrl);
    for (const [name, value] of Object.entries(operation.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
    }
    const headers = new Headers({
      accept: 'application/json',
      ...this.#options.headers,
      authorization: `Bearer ${this.#options.token}`,
    });
    if (options.idempotencyKey) headers.set('idempotency-key', options.idempotencyKey);
    const hasBody = operation.body !== undefined;
    if (hasBody) headers.set('content-type', 'application/json');
    const request = new Request(url, {
      method: operation.method,
      headers,
      ...(hasBody ? { body: JSON.stringify(operation.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const response = await (this.#options.fetch ?? globalThis.fetch)(request);
    const limit = numberHeader(response.headers, 'ratelimit-limit');
    if (limit !== null) {
      this.rateLimit = {
        limit,
        remaining: numberHeader(response.headers, 'ratelimit-remaining') ?? 0,
        reset: numberHeader(response.headers, 'ratelimit-reset') ?? 0,
      };
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: reported below as an error without an envelope.
    }
    if (!response.ok) {
      const error = (json as { error?: Record<string, unknown> } | null)?.error;
      throw new SwarmApiError(
        response.status,
        typeof error?.code === 'string' ? error.code : 'unknown',
        typeof error?.message === 'string' ? error.message : `HTTP ${response.status}`,
        typeof error?.requestId === 'string'
          ? error.requestId
          : response.headers.get('x-request-id'),
        Array.isArray(error?.details) ? (error.details as ErrorDetail[]) : [],
        numberHeader(response.headers, 'retry-after'),
      );
    }
    return (json as { data: T }).data;
  }
}
