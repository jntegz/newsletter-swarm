// The post's cover image in the editor: what is shown, what autosave sends, and how it reads in
// the inbox preview and the version compare. A cover whose media item was deleted has a null url.
import type { CoverImage, CoverImageRef, MediaAsset } from '@swarm/domain';

export const COVER_ALT_MAX = 300;

export function coverFromAsset(asset: MediaAsset): CoverImage {
  return {
    mediaId: asset.id,
    alt: asset.altText ?? '',
    url: asset.url,
    width: asset.width,
    height: asset.height,
  };
}

/** What a save sends. A deleted image stays referenced until the writer changes or removes it. */
export const coverPayload = (cover: CoverImageRef | null): CoverImageRef | null =>
  cover ? { mediaId: cover.mediaId, alt: cover.alt } : null;

/** What a copy of a post starts with: there's nothing to copy once the image is gone. */
export const coverForCopy = (cover: CoverImage | null): CoverImageRef | null =>
  cover?.url ? coverPayload(cover) : null;

/**
 * The first line an inbox shows when there is no preview text. Mail apps read the first text in
 * the email, and that includes the alt text of an image at the top.
 */
export const inboxFirstLine = (cover: CoverImage | null, firstLine: string): string =>
  (cover?.url && cover.alt.trim()) || firstLine;

/** A line in the version compare. The id's end tells two images with the same alt text apart. */
export function coverCompareLine(cover: CoverImageRef | null): string {
  if (!cover) return 'Cover image: none';
  const alt = cover.alt.trim() || 'no alt text';
  return `Cover image: ${alt} (image …${cover.mediaId.slice(-6)})`;
}
