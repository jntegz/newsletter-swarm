/** The click map's scale, shared by the marks in the email and the dashboard's list and legend. */

/**
 * One hue, light to dark, on steps that each pass 4.5:1 with their text. The outline also thickens
 * step by step, and the badge prints its numbers, so nothing depends on seeing the colour.
 */
export const CLICK_MAP_LEVELS = [
  { background: '#ffffff', ink: '#4b5568', outline: '#8a94a6', width: 1, style: 'dashed' },
  { background: '#eef1f6', ink: '#111827', outline: '#aeb8cb', width: 1, style: 'solid' },
  { background: '#c9d2e3', ink: '#111827', outline: '#8595b5', width: 2, style: 'solid' },
  { background: '#5c6f97', ink: '#ffffff', outline: '#5c6f97', width: 3, style: 'solid' },
  { background: '#14203a', ink: '#ffffff', outline: '#14203a', width: 4, style: 'solid' },
] as const;

/** A link's share of the clicks, in words: a small share never rounds to a misleading 0%. */
export function formatClickShare(share: number): string {
  if (share <= 0) return '0%';
  const percent = Math.round(share * 100);
  return percent === 0 ? 'under 1%' : `${percent}%`;
}
