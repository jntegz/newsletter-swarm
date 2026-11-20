import type { ErrorCode } from '@swarm/domain';

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode | 'network',
    message: string,
    readonly status: number,
    readonly details: { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The first validation message for a field, for inline form errors. */
  field(path: string): string | undefined {
    return this.details.find((d) => d.path === path)?.message;
  }
}

type Listener = (code: ErrorCode) => void;
const unauthorizedListeners = new Set<Listener>();

/** Called when any request answers 401 (unauthorized, or mfa_required), so the app can send the
 * operator to sign in or to the second-factor step. */
export function onUnauthorized(listener: Listener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

interface RequestOptions {
  /** Plain data. Encoded as JSON exactly once, here. */
  json?: unknown;
  form?: FormData;
  signal?: AbortSignal;
  /** Lets the request finish after the page closes. The browser limits the body to about 64 KB. */
  keepalive?: boolean;
}

const FALLBACK: Partial<Record<ErrorCode | 'network', string>> = {
  network: 'Swarm could not be reached. Check your connection and try again.',
  internal: 'Something went wrong on our side. Try again in a moment.',
  unavailable: 'Swarm is not available right now. Try again in a moment.',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
};

export async function request<T>(
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: BodyInit | undefined;
  if (options.form) {
    body = options.form;
  } else if (options.json !== undefined) {
    if (typeof options.json === 'string') {
      throw new TypeError('request(): pass data, not a JSON string. The client encodes it.');
    }
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.json);
  }

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body !== undefined ? { body } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.keepalive ? { keepalive: true } : {}),
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError('network', FALLBACK.network ?? '', 0);
  }

  if (res.status === 204) return undefined as T;

  const payload = (await res.json().catch(() => null)) as
    | { data: T }
    | { error: { code: ErrorCode; message: string; details?: { path: string; message: string }[] } }
    | null;

  if (!res.ok || !payload || 'error' in payload) {
    const error = payload && 'error' in payload ? payload.error : null;
    const code = error?.code ?? 'internal';
    if (res.status === 401) unauthorizedListeners.forEach((listener) => listener(code));
    throw new ApiError(
      code,
      error?.message ?? FALLBACK[code] ?? FALLBACK.internal ?? '',
      res.status,
      error?.details ?? [],
    );
  }
  return payload.data;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, signal ? { signal } : {}),
  post: <T>(path: string, json?: unknown) =>
    request<T>('POST', path, json === undefined ? {} : { json }),
  patch: <T>(path: string, json: unknown) => request<T>('PATCH', path, { json }),
  put: <T>(path: string, json: unknown) => request<T>('PUT', path, { json }),
  delete: <T = void>(path: string) => request<T>('DELETE', path),
  upload: <T>(path: string, form: FormData) => request<T>('POST', path, { form }),
};
