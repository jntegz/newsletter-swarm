// Where a reader goes after signing in or out: always a path on the same site, never a URL.

const MAX = 512;

/**
 * Returns `value` when it is a plain same-site path ("/p/hello?x=1#top"), else "/".
 * Refused: absolute URLs, protocol-relative ("//evil.example"), backslash tricks ("/\evil"),
 * control characters and whitespace, anything that resolves to another origin, and the sign-in
 * routes themselves.
 */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value || value.length > MAX) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s\\]/.test(value)) return '/';
  const base = 'https://site.invalid';
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return '/';
  }
  if (url.origin !== base) return '/';
  const path = `${url.pathname}${url.search}${url.hash}`;
  // Dot segments can collapse into a protocol-relative path: "/.//evil.example" parses to the
  // pathname "//evil.example", which a browser would follow off-site.
  if (path.startsWith('//')) return '/';
  if (path.startsWith('/_swarm/reader/')) return '/';
  return path.length <= MAX ? path : '/';
}
