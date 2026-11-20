/**
 * DeBounce, the email verification service (docs/email-verification.md). Every call Swarm makes
 * to it goes through this file. The install owner's key is the worker secret DEBOUNCE_API_KEY;
 * DeBounce wants it in the `api` query parameter, so a URL built here is never logged.
 *
 * Answers are parsed defensively: DeBounce's examples send numbers and flags as strings ("5",
 * "true"), its schema as numbers and booleans. Only the plain single check is used, never the
 * `append` or `photo` options, which cost extra credits.
 *
 * In development and tests the key `dev` selects `fakeDebounceFetch` instead of the network.
 */
import {
  EMAIL_CHECK_CODES,
  isEmailCheckCode,
  type EmailCheckCode,
  type EmailCheckColour,
} from '@swarm/domain';
import { z } from 'zod';
import { outboundUrlProblem } from './outbound-url';

const API = 'https://api.debounce.io/v1/';
const BULK = 'https://bulk.debounce.io/v1/';
const TIMEOUT_MS = 15_000;

/** The worker secret, declared by every worker that calls DeBounce (api, capture, jobs). */
export const DebounceEnvFields = {
  /** The install's DeBounce API key. Without it, nothing is ever checked. */
  DEBOUNCE_API_KEY: z.string().trim().min(1).optional(),
};

export interface DebounceEnv {
  ENVIRONMENT: string;
  DEBOUNCE_API_KEY?: string | undefined;
}

/** The fake key, for development and tests only. */
export const DEBOUNCE_DEV_KEY = 'dev';

const isLocal = (env: DebounceEnv) =>
  env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test';

/** The fake key outside development is a mistake worth refusing at startup. */
export function checkDebounceEnv(env: DebounceEnv, ctx: z.RefinementCtx): void {
  if (env.DEBOUNCE_API_KEY === DEBOUNCE_DEV_KEY && !isLocal(env)) {
    ctx.addIssue({
      code: 'custom',
      path: ['DEBOUNCE_API_KEY'],
      message: 'the key "dev" only works in development',
    });
  }
}

export type DebounceErrorKind =
  /** 401: the key is wrong. */
  | 'key'
  /** 402: the account is out of credits. */
  | 'credits'
  /** 403: the account may not do this. */
  | 'forbidden'
  /** 429, or a bulk list already running: try again shortly. */
  | 'busy'
  /** Timeout, network error, 5xx. */
  | 'unavailable'
  /** An answer that makes no sense. */
  | 'invalid';

export class DebounceError extends Error {
  constructor(
    readonly kind: DebounceErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'DebounceError';
  }
}

export interface DebounceResult {
  email: string;
  code: EmailCheckCode;
  /** DeBounce's words for the result ("Deliverable", "Invalid", ...). */
  reason: string | null;
  didYouMean: string | null;
  /** DeBounce thinks the address is fine for a signup confirmation. */
  sendTransactional: boolean | null;
}

export interface BulkStatus {
  status: 'processing' | 'completed';
  percent: number;
  downloadLink: string | null;
}

export interface DebounceClient {
  verify(email: string, options?: { timeoutMs?: number }): Promise<DebounceResult>;
  balance(): Promise<number>;
  /** Starts a bulk check of the list at `url` (public https, ending .csv). Returns its list id. */
  upload(url: string): Promise<string>;
  status(listId: string): Promise<BulkStatus>;
  /**
   * The results file of a finished list, read to at most `maxBytes` (DEBOUNCE_RESULTS_MAX_BYTES
   * when not given). Every address it goes to, redirects included, passes the outbound guard.
   */
  download(link: string, options?: { maxBytes?: number }): Promise<string>;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;

const flag = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') return value;
  const t = text(value)?.trim().toLowerCase();
  if (t === '1' || t === 'true') return true;
  if (t === '0' || t === 'false') return false;
  return null;
};

const int = (value: unknown): number | null => {
  const t = text(value)?.trim();
  if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Math.floor(Number(t));
};

/** A result code from DeBounce's `code`, or failing that its `result` words. */
export function parseCode(code: unknown, result?: unknown): EmailCheckCode | null {
  const n = int(code);
  if (n !== null && isEmailCheckCode(n)) return n;
  const words = text(result)?.trim().toLowerCase();
  if (!words) return null;
  if (words === 'safe to send' || words === 'deliverable') return 5;
  if (words === 'invalid') return 6;
  if (words.startsWith('accept')) return 4;
  if (words === 'unknown') return 7;
  if (words === 'risky') return 4;
  if (words.includes('disposable')) return 3;
  if (words.includes('role')) return 8;
  if (words.includes('spam')) return 2;
  if (words.includes('syntax')) return 1;
  return null;
}

/** DeBounce's message from an error body, or null. */
function errorText(body: unknown): string | null {
  const b = body as { debounce?: { error?: unknown }; error?: unknown; message?: unknown } | null;
  return text(b?.debounce?.error) ?? text(b?.error) ?? text(b?.message);
}

function failure(status: number, body: unknown): DebounceError {
  const said = errorText(body);
  if (status === 401) return new DebounceError('key', 'DeBounce didn’t accept the API key.');
  if (status === 402)
    return new DebounceError('credits', 'The DeBounce account is out of credits.');
  if (status === 403) return new DebounceError('forbidden', 'DeBounce refused this request.');
  if (status === 429) return new DebounceError('busy', 'DeBounce is busy. Try again shortly.');
  if (status >= 500) return new DebounceError('unavailable', 'DeBounce had a problem.');
  // 200 with success "0": the bulk API says so when a list is already running.
  if (said && /maximum number of api bulk/i.test(said)) {
    return new DebounceError('busy', 'DeBounce is still checking another list.');
  }
  if (said && /wrong api/i.test(said)) {
    return new DebounceError('key', 'DeBounce didn’t accept the API key.');
  }
  if (said && /credit/i.test(said)) {
    return new DebounceError('credits', 'The DeBounce account is out of credits.');
  }
  return new DebounceError(
    'invalid',
    said ? `DeBounce: ${said.slice(0, 200)}` : 'DeBounce sent an answer Swarm can’t read.',
  );
}

export function debounceClient(apiKey: string, fetcher: typeof fetch = fetch): DebounceClient {
  async function call(url: URL, timeoutMs = TIMEOUT_MS): Promise<Record<string, unknown>> {
    url.searchParams.set('api', apiKey);
    let response: Response;
    try {
      response = await fetcher(url.href, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new DebounceError('unavailable', 'DeBounce can’t be reached right now.');
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !body) throw failure(response.status, body);
    if (body.success !== undefined && flag(body.success) === false)
      throw failure(response.status, body);
    return body;
  }

  return {
    async verify(email, options = {}) {
      const url = new URL(API);
      url.searchParams.set('email', email);
      const body = await call(url, options.timeoutMs);
      const d = (body.debounce ?? {}) as Record<string, unknown>;
      const code = parseCode(d.code, d.result);
      if (code === null)
        throw new DebounceError('invalid', 'DeBounce sent a result Swarm can’t read.');
      const suggestion = text(d.did_you_mean)?.trim().toLowerCase() ?? '';
      return {
        email,
        code,
        reason: text(d.reason)?.slice(0, 80) ?? null,
        didYouMean:
          suggestion && suggestion !== email.toLowerCase() ? suggestion.slice(0, 254) : null,
        sendTransactional: flag(d.send_transactional),
      };
    },
    async balance() {
      const body = await call(new URL(`${API}balance/`));
      const n = int(
        body.balance ?? (body.debounce as Record<string, unknown> | undefined)?.balance,
      );
      if (n === null)
        throw new DebounceError('invalid', 'DeBounce didn’t say how many credits are left.');
      return n;
    },
    async upload(listUrl) {
      const url = new URL(`${BULK}upload/`);
      url.searchParams.set('url', listUrl);
      const body = await call(url);
      const listId = text((body.debounce as Record<string, unknown> | undefined)?.list_id);
      if (!listId) throw failure(200, body);
      return listId;
    },
    async status(listId) {
      const url = new URL(`${BULK}status/`);
      url.searchParams.set('list_id', listId);
      const body = await call(url);
      const d = (body.debounce ?? {}) as Record<string, unknown>;
      const status = text(d.status)?.toLowerCase();
      const link = text(d.download_link)?.trim() || null;
      const percent = Math.max(0, Math.min(100, int(d.percentage) ?? 0));
      if (status === 'completed' && link)
        return { status: 'completed', percent: 100, downloadLink: link };
      return {
        status: 'processing',
        percent: status === 'completed' ? 99 : percent,
        downloadLink: null,
      };
    },
    async download(link, options = {}) {
      const limit = Math.max(
        1,
        Math.min(options.maxBytes ?? DEBOUNCE_RESULTS_MAX_BYTES, DEBOUNCE_RESULTS_MAX_BYTES),
      );
      const deadline = Date.now() + DEBOUNCE_DOWNLOAD_TIMEOUT_MS;
      let current = link;
      for (let hop = 0; ; hop++) {
        // The link comes from DeBounce's answer, and so does any redirect: each still has to be a
        // public https address, checked before it is contacted.
        if (outboundUrlProblem(current)) {
          throw new DebounceError('invalid', 'DeBounce gave a results address Swarm won’t open.');
        }
        let response: Response;
        try {
          response = await fetcher(current, {
            redirect: 'manual',
            signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
          });
        } catch {
          throw new DebounceError(
            'unavailable',
            'DeBounce’s results file can’t be fetched right now.',
          );
        }
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          const location = response.headers.get('location');
          if (!location || hop >= DEBOUNCE_DOWNLOAD_REDIRECTS) {
            throw new DebounceError('invalid', 'DeBounce’s results address redirected too far.');
          }
          try {
            current = new URL(location, current).href;
          } catch {
            throw new DebounceError('invalid', 'DeBounce gave a results address Swarm won’t open.');
          }
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw failure(response.status, null);
        }
        return readResults(response, limit);
      }
    },
  };
}

/** Results files larger than this are never read, whatever the part's size. */
export const DEBOUNCE_RESULTS_MAX_BYTES = 32 * 1024 * 1024;
/** Bytes a results file may use per address sent, plus a header allowance. */
export const DEBOUNCE_RESULT_BYTES_PER_ADDRESS = 1024;
export const DEBOUNCE_RESULT_HEADER_BYTES = 64 * 1024;
const DEBOUNCE_DOWNLOAD_TIMEOUT_MS = 60_000;
const DEBOUNCE_DOWNLOAD_REDIRECTS = 3;

/** The bound for the results of a part of `addresses` addresses. */
export const debounceResultsLimit = (addresses: number) =>
  Math.min(
    DEBOUNCE_RESULTS_MAX_BYTES,
    DEBOUNCE_RESULT_HEADER_BYTES + Math.max(0, addresses) * DEBOUNCE_RESULT_BYTES_PER_ADDRESS,
  );

/** The body as text, refused (nothing kept) once it passes `limit` bytes, counted as it streams. */
async function readResults(response: Response, limit: number): Promise<string> {
  const tooLarge = () =>
    new DebounceError('invalid', 'DeBounce’s results file is larger than this part allows.');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let read: ReadableStreamReadResult<Uint8Array>;
    try {
      read = await reader.read();
    } catch {
      throw new DebounceError('unavailable', 'DeBounce’s results file stopped arriving.');
    }
    if (read.done) break;
    total += read.value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(read.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// ---- Results files --------------------------------------------------------------------------

export interface BulkRow {
  email: string;
  code: EmailCheckCode;
  reason: string | null;
  didYouMean: string | null;
}

/** Splits one CSV line (quotes, doubled quotes, commas or semicolons). */
function cells(line: string, separator: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === separator) {
      out.push(cell);
      cell = '';
    } else cell += ch;
  }
  out.push(cell);
  return out.map((c) => c.trim());
}

const squash = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Reads DeBounce's results file. Its exact columns are not documented, so columns are found by
 * their header: the address (`email`, not `free_email`), the code (`code`, `debounce_code`, ...),
 * the result words and the reason, and `did_you_mean`. A row without an address or a readable
 * result is left out; it stays "not checked".
 */
export function parseBulkResults(csv: string): BulkRow[] {
  const lines = csv
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
  const head = lines[0];
  if (!head) return [];
  const separator = head.includes(';') && !head.includes(',') ? ';' : ',';
  const headers = cells(head, separator).map(squash);
  const find = (...tests: ((h: string) => boolean)[]) => {
    for (const test of tests) {
      const index = headers.findIndex(test);
      if (index >= 0) return index;
    }
    return -1;
  };
  const email = find(
    (h) => h === 'email' || h === 'emailaddress',
    (h) => h.includes('email') && !h.includes('free') && !h.includes('code'),
  );
  const code = find(
    (h) => h === 'code' || h === 'debouncecode' || h === 'resultcode',
    (h) => h.endsWith('code') && !h.includes('zip') && !h.includes('postal'),
  );
  const result = find(
    (h) => h === 'result' || h === 'debounceresult',
    (h) => h.endsWith('result'),
  );
  const reason = find(
    (h) => h === 'reason' || h === 'debouncereason',
    (h) => h.endsWith('reason'),
  );
  const suggestion = find((h) => h.includes('didyoumean'));
  if (email < 0 || (code < 0 && result < 0 && reason < 0)) return [];
  const rows: BulkRow[] = [];
  for (const line of lines.slice(1)) {
    const row = cells(line, separator);
    const address = (row[email] ?? '').trim().toLowerCase();
    if (!address.includes('@')) continue;
    const parsed =
      parseCode(code >= 0 ? row[code] : null, result >= 0 ? row[result] : null) ??
      parseCode(null, reason >= 0 ? row[reason] : null);
    if (parsed === null) continue;
    const didYouMean = suggestion >= 0 ? (row[suggestion] ?? '').trim().toLowerCase() : '';
    rows.push({
      email: address,
      code: parsed,
      reason: reason >= 0 ? (row[reason] ?? '').slice(0, 80) || null : null,
      didYouMean: didYouMean && didYouMean !== address ? didYouMean.slice(0, 254) : null,
    });
  }
  return rows;
}

// ---- The fake ---------------------------------------------------------------------------------

/**
 * What the fake answers for an address, by its local part or domain: bad… or invalid… will bounce,
 * trap… is a spam trap, temp… temporary, catchall… or @catchall.example accept-all, unknown…
 * unknown, info@ and support@ team addresses, anything at gmial.com or exmaple.com bounces with a
 * suggestion.
 */
export function fakeCode(email: string): { code: EmailCheckCode; didYouMean: string | null } {
  const [local = '', domain = ''] = email.toLowerCase().split('@');
  if (domain === 'gmial.com') return { code: 6, didYouMean: `${local}@gmail.com` };
  if (domain === 'exmaple.com') return { code: 6, didYouMean: `${local}@example.com` };
  if (!domain) return { code: 1, didYouMean: null };
  if (/^(bad|invalid)/.test(local)) return { code: 6, didYouMean: null };
  if (local.startsWith('trap')) return { code: 2, didYouMean: null };
  if (local.startsWith('temp')) return { code: 3, didYouMean: null };
  if (local.startsWith('catchall') || domain === 'catchall.example')
    return { code: 4, didYouMean: null };
  if (local.startsWith('unknown')) return { code: 7, didYouMean: null };
  if (local === 'info' || local === 'support') return { code: 8, didYouMean: null };
  return { code: 5, didYouMean: null };
}

const FAKE_REASON: Record<EmailCheckColour, string> = {
  green: 'Deliverable',
  orange: 'Risky',
  red: 'Invalid',
};

export interface FakeDebounceOptions {
  /** Credits left; each check takes one, each bulk address one. Unlimited when omitted. */
  credits?: { left: number };
  /** Answers 401 to everything. */
  wrongKey?: boolean;
  /** Every check waits this long first (to try timeouts). */
  delayMs?: number;
  /** Reads a list Swarm serves, for the fake bulk API. */
  readList?: (url: string) => Promise<string | null>;
  /** Bulk lists stay "processing" for this many status calls. */
  processingPolls?: number;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Lists the fake bulk API was given, shared by every fake so a later call finds them. */
const fakeLists = new Map<string, { url: string; polls: number }>();
let fakeNext = 8620;

/** A stand-in for DeBounce's three hosts. Bulk results come back as a CSV with DeBounce-like headers. */
export function fakeDebounceFetch(options: FakeDebounceOptions = {}): typeof fetch {
  const lists = fakeLists;
  const spend = (n: number) => {
    if (!options.credits) return true;
    if (options.credits.left < n) return false;
    options.credits.left -= n;
    return true;
  };
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (options.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, options.delayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('The operation was aborted.', 'TimeoutError'));
        });
      });
    }
    if (options.wrongKey)
      return json(401, { debounce: { error: 'Wrong API', code: '0' }, success: '0' });
    const credits = String(options.credits?.left ?? 1_000_000);
    if (url.host === 'api.debounce.io' && url.pathname === '/v1/balance/') {
      return json(200, { balance: credits });
    }
    if (url.host === 'api.debounce.io' && url.pathname === '/v1/') {
      if (!spend(1)) return json(402, { debounce: { error: 'Credits Low' }, success: '0' });
      const email = url.searchParams.get('email') ?? '';
      const { code, didYouMean } = fakeCode(email);
      const colour = EMAIL_CHECK_CODES[code].colour;
      return json(200, {
        debounce: {
          email,
          code: String(code),
          role: String(code === 8),
          free_email: 'true',
          result: colour === 'green' ? 'Safe to Send' : FAKE_REASON[colour],
          reason: EMAIL_CHECK_CODES[code].label,
          send_transactional: colour === 'red' ? '0' : '1',
          did_you_mean: didYouMean ?? '',
        },
        success: '1',
        balance: String(options.credits?.left ?? 1_000_000),
      });
    }
    if (url.host === 'bulk.debounce.io' && url.pathname === '/v1/upload/') {
      const listUrl = url.searchParams.get('url') ?? '';
      if (!/^https?:\/\/.+\.(csv|txt)$/.test(listUrl)) {
        return json(400, { debounce: { error: 'URL parameter is not valid.' }, success: '0' });
      }
      const id = String(fakeNext++);
      lists.set(id, { url: listUrl, polls: 0 });
      return json(200, { debounce: { list_id: id, list_name: 'swarm' }, success: '1' });
    }
    if (url.host === 'bulk.debounce.io' && url.pathname === '/v1/status/') {
      const id = url.searchParams.get('list_id') ?? '';
      const list = lists.get(id);
      if (!list) return json(200, { debounce: { error: 'List ID is not valid.' }, success: '0' });
      list.polls++;
      const done = list.polls > (options.processingPolls ?? 0);
      return json(200, {
        debounce: {
          list_id: id,
          status: done ? 'completed' : 'processing',
          percentage: done ? 100 : 40,
          download_link: done ? `https://cdn.debounce.io/get/report/${id}-fake.csv` : '',
        },
        success: '1',
      });
    }
    const report = /^\/get\/report\/(\d+)-fake\.csv$/.exec(url.pathname);
    if (url.host === 'cdn.debounce.io' && report) {
      const list = lists.get(report[1] as string);
      const source = list && options.readList ? await options.readList(list.url) : null;
      if (source === null) return new Response('Not found', { status: 404 });
      const emails = source
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.includes('@'));
      if (!spend(emails.length))
        return json(402, { debounce: { error: 'Credits Low' }, success: '0' });
      const lines = [
        'email,debounce_code,debounce_role,debounce_free_email,debounce_result,debounce_reason,debounce_send_transactional,debounce_did_you_mean',
      ];
      for (const email of emails) {
        const { code, didYouMean } = fakeCode(email);
        const colour = EMAIL_CHECK_CODES[code].colour;
        lines.push(
          [
            email,
            code,
            code === 8,
            'true',
            colour === 'green' ? 'Safe to Send' : FAKE_REASON[colour],
            EMAIL_CHECK_CODES[code].label,
            colour === 'red' ? 0 : 1,
            didYouMean ?? '',
          ]
            .map((v) => `"${String(v).replace(/"/g, '""')}"`)
            .join(','),
        );
      }
      return new Response(lines.join('\n'), {
        status: 200,
        headers: { 'content-type': 'text/csv' },
      });
    }
    return new Response('Not found', { status: 404 });
  }) as typeof fetch;
}

let injected: typeof fetch | undefined;

/** Tests swap in a fake with their own options (credits, timeouts). */
export function useDebounceFetchForTests(fetcher: typeof fetch | undefined): void {
  injected = fetcher;
}

/**
 * What answers DeBounce in tests: the fake a test swapped in, else the default fake. A caller's
 * in-process vault (whose proxy sends the sign-up check) routes api.debounce.io here.
 */
export const debounceTestFetch = (): typeof fetch => injected ?? fakeDebounceFetch();

/**
 * The install's DeBounce, or null without a key. `dev` (development and tests only) is the fake;
 * `readList` lets the fake bulk API read the lists Swarm serves.
 */
export function debounceFor(
  env: DebounceEnv,
  options: { readList?: (url: string) => Promise<string | null> } = {},
): DebounceClient | null {
  const key = env.DEBOUNCE_API_KEY;
  if (!key) return null;
  if (injected) return debounceClient(key, injected);
  if (key === DEBOUNCE_DEV_KEY && isLocal(env)) {
    return debounceClient(
      key,
      fakeDebounceFetch(options.readList ? { readList: options.readList } : {}),
    );
  }
  return debounceClient(key, (input, init) => fetch(input, init));
}
