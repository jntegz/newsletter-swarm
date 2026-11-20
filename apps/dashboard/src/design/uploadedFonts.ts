// Fonts uploaded to the media library, drawn in the dashboard from their media address under the
// same family the site uses for them (`Swarm Upload …`), so each name shows in its own face. They
// load in the dashboard only; the site loads them from its own /media/ (docs/site-themes.md,
// "Uploaded fonts"). Kept apart from fonts.ts, and from the theme engine (only a type is used), so
// the media library doesn't pull in the studio's code.
import type { MediaAsset } from '@swarm/domain';
import type { FontLookup } from '@swarm/site-themes';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { mediaQuery } from '../api/queries';

/** The family an uploaded font is drawn with in the dashboard: one per media id. */
export const uploadedFamily = (mediaId: string) => `Swarm Upload ${mediaId.slice(3, 15)}`;

/** The stack that draws a name in an uploaded font, with the dashboard's own text behind it. */
export const uploadedStack = (mediaId: string) =>
  `'${uploadedFamily(mediaId)}',system-ui,sans-serif`;

const uploaded = new Set<string>();

/** Adds an uploaded font's face to the dashboard, once per media id. */
export function addUploadedFont(asset: Pick<MediaAsset, 'id' | 'url' | 'contentType'>) {
  if (uploaded.has(asset.id) || typeof FontFace === 'undefined') return;
  uploaded.add(asset.id);
  const format = asset.contentType === 'font/woff' ? 'woff' : 'woff2';
  const face = new FontFace(
    uploadedFamily(asset.id),
    `url(${JSON.stringify(asset.url)}) format('${format}')`,
    { weight: '100 900', display: 'swap' },
  );
  document.fonts.add(face);
  // A file the browser can't read draws in the fallback; nothing else to do.
  face.load().catch(() => undefined);
}

/** This publication's uploaded fonts, newest first, each added to the dashboard as it arrives. */
export function useUploadedFonts(channelId: string) {
  const fonts = useQuery(mediaQuery(channelId, '', 'font'));
  useEffect(() => {
    for (const asset of fonts.data ?? []) addUploadedFont(asset);
  }, [fonts.data]);
  return fonts;
}

/**
 * The lookup designCss takes, for the studio's own copy of the design's CSS: each font at its
 * media path, which is where the site serves it.
 */
export function fontLookupOf(assets: readonly MediaAsset[] | undefined): FontLookup {
  const byId = new Map((assets ?? []).map((a) => [a.id, a]));
  return (id) => {
    const asset = byId.get(id);
    if (!asset || asset.kind !== 'font') return null;
    return { url: new URL(asset.url).pathname, family: asset.altText };
  };
}

/** A font's name for people: its alt text in the media library, else a plain description. */
export const uploadedFontName = (asset: Pick<MediaAsset, 'altText'>) =>
  asset.altText?.trim() || 'Untitled font';
