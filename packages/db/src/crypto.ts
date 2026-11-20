export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Truncates an IP before it is stored: /24 for IPv4, /48 for IPv6 (the first three groups, with
 * `::` expanded, so `2001:db8::1` is `2001:db8:0::/48`). IPv4-mapped IPv6 counts as IPv4.
 */
export function ipPrefix(ip: string | undefined | null): string | null {
  if (!ip) return null;
  let value = ip.trim().toLowerCase();
  if (value.includes(':') && value.includes('.')) value = value.slice(value.lastIndexOf(':') + 1);
  if (value.includes('.')) {
    const parts = value.split('.');
    if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) {
      return null;
    }
    return `${parts.slice(0, 3).map(Number).join('.')}.0/24`;
  }
  if (value.includes(':')) {
    const [head = '', tail] = value.split('::', 2) as [string, string | undefined];
    const left = head ? head.split(':') : [];
    const right = tail ? tail.split(':') : [];
    const fill =
      tail === undefined
        ? []
        : Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0');
    const groups = [...left, ...fill, ...right];
    if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
    return `${groups
      .slice(0, 3)
      .map((g) => g.replace(/^0+(?=.)/, ''))
      .join(':')}::/48`;
  }
  return null;
}

/** Stable JSON with sorted keys, for hashing. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
