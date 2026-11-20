// The note under the publication's accent colour, kept apart so its wording can be tested.
import { colorLuminance, readableColor, textOn } from '@swarm/domain';

// ---- Accent colour ---------------------------------------------------------------------------

/**
 * What the website does with an accent colour that would be hard to read as it is, or null when
 * it needs no adjusting. The same helpers the site uses (workers/site/src/render/theme.ts).
 */
export function accentNote(hex: string): string | null {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return null;
  const darkText = textOn(hex) !== '#ffffff';
  const lightLink = readableColor(hex, '#f8f7fc', 4.6) !== hex.toLowerCase();
  const darkLink = readableColor(hex, '#1d1d24', 4.6) !== hex.toLowerCase();
  if (darkText && lightLink) {
    return 'This is a light colour. Buttons use dark text on it, and links are darkened on light pages so they stay readable.';
  }
  if (darkText) return 'Buttons use dark text on this colour, because it reads better than white.';
  if (darkLink && colorLuminance(hex) < 0.05) {
    return 'This is a very dark colour. Links are lightened on dark pages so they stay readable.';
  }
  return null;
}
