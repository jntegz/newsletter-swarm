import type { CoverImage, MediaAsset } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import {
  coverCompareLine,
  coverForCopy,
  coverFromAsset,
  coverPayload,
  inboxFirstLine,
} from './coverImage';

const cover: CoverImage = {
  mediaId: 'md_0123456789abcdef',
  alt: 'A fox at dawn',
  url: 'https://media.example/fox.png',
  width: 1600,
  height: 900,
};
const gone: CoverImage = { ...cover, url: null, width: null, height: null };

const asset: MediaAsset = {
  id: 'md_abc',
  channelId: 'ch_abc',
  contentType: 'image/png',
  kind: 'image',
  bytes: 10,
  width: 800,
  height: 600,
  altText: 'From the library',
  focalPoint: null,
  url: 'https://media.example/abc.png',
  createdAt: '2026-11-02T00:00:00.000Z',
};

describe('coverFromAsset', () => {
  it('starts from the library’s alt text and dimensions', () => {
    expect(coverFromAsset(asset)).toEqual({
      mediaId: 'md_abc',
      alt: 'From the library',
      url: asset.url,
      width: 800,
      height: 600,
    });
  });

  it('starts with empty alt text when the library has none', () => {
    expect(coverFromAsset({ ...asset, altText: null }).alt).toBe('');
  });
});

describe('coverPayload', () => {
  it('sends only the reference', () => {
    expect(coverPayload(cover)).toEqual({ mediaId: cover.mediaId, alt: cover.alt });
    expect(coverPayload(null)).toBeNull();
  });

  it('keeps a deleted image’s reference, so an autosave doesn’t quietly remove it', () => {
    expect(coverPayload(gone)).toEqual({ mediaId: cover.mediaId, alt: cover.alt });
  });
});

describe('coverForCopy', () => {
  it('copies a live cover and drops one whose image is gone', () => {
    expect(coverForCopy(cover)).toEqual({ mediaId: cover.mediaId, alt: cover.alt });
    expect(coverForCopy(gone)).toBeNull();
    expect(coverForCopy(null)).toBeNull();
  });
});

describe('inboxFirstLine', () => {
  it('is the alt text of the cover, the first text mail apps find', () => {
    expect(inboxFirstLine(cover, 'Dear reader')).toBe('A fox at dawn');
  });

  it('is the post’s first line without a cover, without alt text or once it is gone', () => {
    expect(inboxFirstLine(null, 'Dear reader')).toBe('Dear reader');
    expect(inboxFirstLine({ ...cover, alt: '  ' }, 'Dear reader')).toBe('Dear reader');
    expect(inboxFirstLine(gone, 'Dear reader')).toBe('Dear reader');
  });
});

describe('coverCompareLine', () => {
  it('shows a change of alt text or of image, and nothing when they are the same', () => {
    expect(coverCompareLine(null)).toBe('Cover image: none');
    expect(coverCompareLine(cover)).toBe('Cover image: A fox at dawn (image …abcdef)');
    expect(coverCompareLine({ ...cover, alt: '' })).toBe(
      'Cover image: no alt text (image …abcdef)',
    );
    expect(coverCompareLine({ ...cover, mediaId: 'md_0123456789fedcba' })).not.toBe(
      coverCompareLine(cover),
    );
  });
});
