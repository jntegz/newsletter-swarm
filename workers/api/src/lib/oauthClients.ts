// Client ID Metadata Documents (Phase 8, OAuth for MCP): fetching, checking and caching the JSON
// document a public client names with its https client_id. Fetched only on the consent step for a
// signed-in operator, through the outbound URL guard, with no redirects, a 5 KB and 5 second cap,
// and a per-operator limit. Contract: docs/oauth.md ("Client ID Metadata Documents").
import { all, first, run } from '@swarm/db';
import {
  CLIENT_METADATA_LIMITS,
  clientMetadataUrlProblem,
  parseClientMetadata,
  type ClientMetadata,
} from '@swarm/domain';
import { outboundUrlProblem } from '@swarm/engine';
import { env, type AppContext } from './context';

let injectedFetch: typeof fetch | undefined;

/** Tests answer document requests here. Pass undefined to go back to the real fetch. */
export function useClientDocumentFetchForTests(fetcher: typeof fetch | undefined): void {
  injectedFetch = fetcher;
}

type ClientDocumentResult = { ok: true; client: ClientMetadata } | { ok: false; error: string };

interface DocumentRow {
  url: string;
  status: 'ok' | 'error';
  name: string | null;
  client_uri: string | null;
  redirect_uris_json: string | null;
  error: string | null;
  expires_at: number;
}

const fromRow = (row: DocumentRow): ClientDocumentResult =>
  row.status === 'ok'
    ? {
        ok: true,
        client: {
          name: row.name ?? 'Unnamed app',
          clientUri: row.client_uri,
          redirectUris: JSON.parse(row.redirect_uris_json ?? '[]') as string[],
        },
      }
    : { ok: false, error: row.error ?? 'The client metadata document could not be read.' };

/** Cache lifetime from Cache-Control max-age, clamped; the default without one. */
function cacheSeconds(header: string | null): number {
  const { minCacheSeconds, defaultCacheSeconds, maxCacheSeconds } = CLIENT_METADATA_LIMITS;
  if (header && /no-store|no-cache/i.test(header)) return minCacheSeconds;
  const maxAge = /max-age=(\d+)/i.exec(header ?? '')?.[1];
  const seconds = maxAge === undefined ? defaultCacheSeconds : Number(maxAge);
  return Math.min(Math.max(seconds, minCacheSeconds), maxCacheSeconds);
}

class DocumentError extends Error {}

async function readLimited(response: Response): Promise<string> {
  const limit = CLIENT_METADATA_LIMITS.bytes;
  const tooLarge = () => new DocumentError('The client metadata document is larger than 5 KB.');
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
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function fetchDocument(url: string): Promise<{ client: ClientMetadata; ttl: number }> {
  const fetcher = injectedFetch ?? ((input, init) => fetch(input, init));
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      // A redirect is not followed: the document must be at the client_id URL itself.
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(CLIENT_METADATA_LIMITS.timeoutMs),
    });
  } catch {
    throw new DocumentError('The client metadata document could not be fetched.');
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new DocumentError(
      response.status >= 300 && response.status < 400
        ? 'The client metadata document redirects; it must be served at the client_id URL.'
        : `The client metadata document answered ${response.status}.`,
    );
  }
  const text = await readLimited(response);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new DocumentError('The client metadata document is not JSON.');
  }
  const parsed = parseClientMetadata(body, url);
  if (!parsed.ok) throw new DocumentError(parsed.error);
  return { client: parsed.client, ttl: cacheSeconds(response.headers.get('cache-control')) };
}

/**
 * The client a metadata document describes: the cached copy while it is fresh, else a fetch.
 * Failed fetches are cached briefly too. Each operator may cause a limited number of fetches an
 * hour, so the consent page can't be used to make Swarm fetch arbitrary URLs in bulk.
 */
export async function loadClientDocument(
  c: AppContext,
  url: string,
  operatorId: string,
): Promise<ClientDocumentResult> {
  const db = env(c).DB;
  const problem =
    clientMetadataUrlProblem(url) ??
    (outboundUrlProblem(url) ? 'The client_id URL is not on a public host.' : null);
  if (problem) return { ok: false, error: problem };
  const now = Date.now();
  const cached = await first<DocumentRow>(
    db,
    'SELECT * FROM oauth_client_documents WHERE url = ?1 AND expires_at > ?2',
    url,
    now,
  );
  if (cached) return fromRow(cached);
  const recent = await all<{ n: number }>(
    db,
    'SELECT count(*) AS n FROM oauth_client_documents WHERE fetched_by = ?1 AND fetched_at > ?2',
    operatorId,
    now - 3_600_000,
  );
  if ((recent[0]?.n ?? 0) >= CLIENT_METADATA_LIMITS.fetchesPerOperatorHour) {
    return {
      ok: false,
      error: 'Too many new apps were checked in the last hour. Try again later.',
    };
  }
  let result: ClientDocumentResult;
  let ttl: number;
  try {
    const fetched = await fetchDocument(url);
    result = { ok: true, client: fetched.client };
    ttl = fetched.ttl;
  } catch (error) {
    if (!(error instanceof DocumentError)) throw error;
    result = { ok: false, error: error.message };
    ttl = CLIENT_METADATA_LIMITS.errorCacheSeconds;
  }
  await run(
    db,
    `INSERT INTO oauth_client_documents (url, status, name, client_uri, redirect_uris_json, error,
       fetched_by, fetched_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT (url) DO UPDATE SET status = excluded.status, name = excluded.name,
       client_uri = excluded.client_uri, redirect_uris_json = excluded.redirect_uris_json,
       error = excluded.error, fetched_by = excluded.fetched_by, fetched_at = excluded.fetched_at,
       expires_at = excluded.expires_at`,
    url,
    result.ok ? 'ok' : 'error',
    result.ok ? result.client.name : null,
    result.ok ? result.client.clientUri : null,
    result.ok ? JSON.stringify(result.client.redirectUris) : null,
    result.ok ? null : result.error,
    operatorId,
    now,
    now + ttl * 1000,
  );
  return result;
}
