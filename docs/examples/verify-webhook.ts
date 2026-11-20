// Verifies the Swarm-Signature header of an Event Webhook (docs/webhooks.md).
// Web Crypto only: runs on Node.js 20+, Deno, Bun and Cloudflare Workers.
const encoder = new TextEncoder();

export async function verifySwarmSignature(
  secret: string, // whsec_…, exactly as shown when the endpoint was created
  header: string, // the Swarm-Signature request header
  rawBody: string, // the request body as received, before any JSON parsing
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const pairs = header.split(',').map((part) => part.trim().split('='));
  const timestamp = Number(pairs.find(([key]) => key === 't')?.[1]);
  const candidates = pairs.filter(([key]) => key === 'v1').map(([, value]) => value ?? '');
  if (!Number.isInteger(timestamp) || Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return false; // missing or outside the replay window
  }
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  // During a secret rotation there are two v1= values; either one may match.
  return candidates.some((candidate) => constantTimeEqual(candidate, expected));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
