/**
 * Shorthop over its MCP server (POST <address>/api/mcp, Bearer key, stateless JSON-RPC). Calls
 * create_link with a slug made from the workspace's format. docs/applications.md.
 */
import { SHORT_SLUG_MAX } from '@swarm/domain';
import { decrypt, encrypt } from './fields';
import { outboundUrlProblem } from './outbound-url';

type Keyring = Parameters<typeof encrypt>[0];

const TIMEOUT_MS = 10_000;
const COLLISION_RETRIES = 3;

export class ShorthopError extends Error {
  constructor(
    /** rejected: the address or key is wrong. unavailable: try again later. */
    readonly kind: 'rejected' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'ShorthopError';
  }
}

export interface ShorthopTarget {
  fetch: typeof fetch;
  baseUrl: string;
  apiKey: string;
}

/** Sealed together with its workspace, so a copied value doesn't open elsewhere. */
export const sealAppKey = (keys: Keyring, workspaceId: string, apiKey: string) =>
  encrypt(keys, JSON.stringify({ w: workspaceId, k: apiKey }));

export async function openAppKey(
  keys: Keyring,
  workspaceId: string,
  sealed: string,
): Promise<string | null> {
  const plain = await decrypt(keys, sealed);
  if (!plain) return null;
  try {
    const value = JSON.parse(plain) as { w?: unknown; k?: unknown };
    return value.w === workspaceId && typeof value.k === 'string' ? value.k : null;
  } catch {
    return null;
  }
}

/** Why a Shorthop address can't be used, or null. Development may use a local one. */
export function shorthopUrlProblem(raw: string, environment: string): string | null {
  if (environment === 'development') return null;
  return outboundUrlProblem(raw) ? 'Use the https:// address of your Shorthop.' : null;
}

export const normalizeBaseUrl = (raw: string) => new URL(raw).origin;

export const randomSlugPart = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  return [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('');
};

async function rpc(
  target: ShorthopTarget,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  let response: Response;
  try {
    response = await target.fetch(`${target.baseUrl}/api/mcp`, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${target.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  } catch {
    throw new ShorthopError('unavailable', 'Shorthop can’t be reached right now. Try again.');
  }
  if (response.status === 401 || response.status === 403) {
    throw new ShorthopError('rejected', 'Shorthop didn’t accept this API key.');
  }
  if (response.status >= 500) {
    throw new ShorthopError('unavailable', 'Shorthop had a problem. Try again.');
  }
  const body = (await response.json().catch(() => null)) as {
    result?: unknown;
    error?: { message?: unknown };
  } | null;
  if (!response.ok || !body || (body.result === undefined && !body.error)) {
    throw new ShorthopError('rejected', 'That address doesn’t look like a Shorthop.');
  }
  if (body.error) {
    throw new ShorthopError('rejected', 'That address doesn’t look like a Shorthop.');
  }
  return body.result;
}

interface ToolResult {
  isError?: boolean;
  content?: { text?: unknown }[];
  structuredContent?: unknown;
}

const errorText = (result: ToolResult) =>
  typeof result.content?.[0]?.text === 'string' ? result.content[0].text : 'Shorthop refused this.';

/** Checks the address and the key, by asking for what connecting relies on. */
export async function checkShorthop(target: ShorthopTarget): Promise<void> {
  const listed = (await rpc(target, 'tools/list', {})) as { tools?: { name?: unknown }[] };
  if (!listed.tools?.some((tool) => tool.name === 'create_link')) {
    throw new ShorthopError('rejected', 'That address doesn’t look like a Shorthop.');
  }
  // tools/list needs no key on its own. Listing links does, and creating nothing is the point.
  const result = (await rpc(target, 'tools/call', {
    name: 'list_links',
    arguments: { limit: 1 },
  })) as ToolResult;
  if (result.isError) {
    throw new ShorthopError('rejected', `Shorthop refused this key: ${errorText(result)}`);
  }
}

/** Makes a short link, trying another slug if this one is taken. */
export async function createShorthopLink(
  target: ShorthopTarget,
  input: {
    url: string;
    slug: string;
    domain: string | null;
    title: string;
    tags: string[];
    /** A fresh random part for another try. */
    random?: () => string;
  },
): Promise<string> {
  const random = input.random ?? randomSlugPart;
  let slug = input.slug;
  for (let attempt = 0; attempt <= COLLISION_RETRIES; attempt++) {
    const result = (await rpc(target, 'tools/call', {
      name: 'create_link',
      arguments: {
        url: input.url,
        slug,
        ...(input.domain ? { domain: input.domain } : {}),
        ...(input.title ? { title: input.title.slice(0, 200) } : {}),
        tags: input.tags,
      },
    })) as ToolResult;
    if (!result.isError) {
      const link = (result.structuredContent as { link?: { shortUrl?: unknown } } | undefined)
        ?.link;
      if (typeof link?.shortUrl === 'string') return link.shortUrl;
      throw new ShorthopError('unavailable', 'Shorthop didn’t send a link back. Try again.');
    }
    const text = errorText(result);
    if (!/already taken|in use/i.test(text)) throw new ShorthopError('rejected', text);
    slug = `${input.slug.slice(0, SHORT_SLUG_MAX - 7)}-${random()}`;
  }
  throw new ShorthopError('unavailable', 'Every slug tried was taken. Change the format.');
}
