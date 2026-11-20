// A/B tests on home page sections (docs/site-themes.md): which variant each running test shows a
// view. Chosen at random per request at the edge, before the cache is looked up, so the cached
// copy is kept per set of variants (edge/cache.ts). There is no cookie: a reader who comes back
// may see the other variant, and results count views, not people.

/** A number in [0, 1); tests pass their own. */
export type Random = () => number;

const cryptoRandom: Random = () => {
  const [n] = crypto.getRandomValues(new Uint32Array(1));
  return (n ?? 0) / 2 ** 32;
};

/** The paths whose page draws the design's sections: the home page only. */
export const isTestedPath = (path: string) => path === '/';

/** A or B for each running test, half and half. */
export function assignVariants(
  tests: readonly string[],
  random: Random = cryptoRandom,
): Record<string, 'a' | 'b'> {
  const out: Record<string, 'a' | 'b'> = {};
  for (const id of tests) out[id] = random() < 0.5 ? 'a' : 'b';
  return out;
}
