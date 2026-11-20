/** AWS Signature Version 4 for fetch requests, on Web Crypto. */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface SignInput {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /**
   * Hex sha256 of the body, when the signer does not hold the body itself (the vault signs an
   * export object it never sees). Ignored when `body` is given.
   */
  payloadHash?: string;
  service: string;
  region: string;
  credentials: AwsCredentials;
  /** Override the clock, for tests. */
  now?: Date;
}

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(data: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(data)));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey(
    'raw',
    key as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', imported, encoder.encode(data));
}

/** RFC 3986 encoding as AWS expects it (everything but unreserved characters). */
function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalPath(pathname: string, service: string): string {
  // The path from URL is already percent-encoded, so decode first. Every service but S3 encodes
  // each segment twice (SES suppression paths carry an address: a+b@x → a%252Bb%2540x).
  return pathname
    .split('/')
    .map((segment) => {
      const once = awsEncode(decodeURIComponent(segment));
      return service === 's3' ? once : awsEncode(once);
    })
    .join('/');
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params.entries()]
    .map(([k, v]) => [awsEncode(k), awsEncode(v)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** Returns the headers to send, including Authorization and X-Amz-Date. */
export async function signRequest(input: SignInput): Promise<Record<string, string>> {
  const url = new URL(input.url);
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash =
    input.body === undefined && input.payloadHash
      ? input.payloadHash
      : await sha256(input.body ?? '');

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    headers[name.toLowerCase()] = value.trim().replace(/\s+/g, ' ');
  }
  headers.host = url.host;
  headers['x-amz-date'] = amzDate;
  if (input.credentials.sessionToken)
    headers['x-amz-security-token'] = input.credentials.sessionToken;

  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map((name) => `${name}:${headers[name]}\n`).join('');
  const signedHeaders = signedNames.join(';');

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(url.pathname, input.service),
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256(canonicalRequest)].join(
    '\n',
  );

  const kDate = await hmac(encoder.encode(`AWS4${input.credentials.secretAccessKey}`), date);
  const kRegion = await hmac(kDate, input.region);
  const kService = await hmac(kRegion, input.service);
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = hex(await hmac(kSigning, stringToSign));

  const result: Record<string, string> = { ...headers };
  delete result.host;
  result.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return result;
}
