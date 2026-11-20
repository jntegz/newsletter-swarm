// App Directory contracts: the review lifecycle, slugs, listing URLs and the published manifest
// JSON Schema (docs/app-manifest.schema.json, written by `pnpm openapi`).
import { describe, expect, it } from 'vitest';
import {
  AppManifestSchema,
  ReviewDecisionSchema,
  appManifestJsonSchema,
  listingUrlProblem,
  reviewOutcome,
  slugifyAppName,
} from '../src/index';
import committed from '../../../docs/app-manifest.schema.json';

const manifest = {
  manifestVersion: 1,
  listing: {
    name: 'Sheet Sync',
    tagline: 'Rows for Members',
    categories: ['productivity'],
    websiteUrl: 'https://s.example',
    supportUrl: 'mailto:help@s.example',
    privacyUrl: 'https://s.example/privacy',
    installUrl: 'https://s.example/install',
  },
  oauth: { clientType: 'public', redirectUris: ['https://s.example/cb'], scopes: ['members:read'] },
};

describe('app manifest', () => {
  it('matches the committed JSON Schema (run pnpm openapi when this fails)', () => {
    expect(committed).toEqual(appManifestJsonSchema());
  });

  it('accepts the documented example and fills defaults', () => {
    const parsed = AppManifestSchema.parse({ $schema: 'https://x.example/s.json', ...manifest });
    expect(parsed.webhooks).toEqual({ events: [] });
    expect(parsed.listing.description).toBe('');
  });

  it('refuses unknown keys and versions', () => {
    expect(AppManifestSchema.safeParse({ ...manifest, extra: 1 }).success).toBe(false);
    expect(
      AppManifestSchema.safeParse({ ...manifest, listing: { ...manifest.listing, icon: 'x' } })
        .success,
    ).toBe(false);
    expect(AppManifestSchema.safeParse({ ...manifest, manifestVersion: 2 }).success).toBe(false);
  });
});

describe('review lifecycle', () => {
  it('allows approve and reject from submitted, delist from approved', () => {
    expect(reviewOutcome('submitted', 'approve')).toBe('approved');
    expect(reviewOutcome('submitted', 'reject')).toBe('rejected');
    expect(reviewOutcome('approved', 'delist')).toBe('delisted');
    expect(reviewOutcome('draft', 'approve')).toBeNull();
    expect(reviewOutcome('approved', 'approve')).toBeNull();
    expect(reviewOutcome('submitted', 'delist')).toBeNull();
    expect(reviewOutcome('rejected', 'reject')).toBeNull();
  });

  it('needs a note to reject or delist', () => {
    expect(ReviewDecisionSchema.safeParse({ decision: 'approve' }).success).toBe(true);
    expect(ReviewDecisionSchema.safeParse({ decision: 'reject' }).success).toBe(false);
    expect(ReviewDecisionSchema.safeParse({ decision: 'delist', note: '  ' }).success).toBe(false);
    expect(
      ReviewDecisionSchema.safeParse({ decision: 'reject', note: 'No privacy policy' }).success,
    ).toBe(true);
  });
});

describe('slugs and URLs', () => {
  it('derives slugs', () => {
    expect(slugifyAppName('Sheet Sync!')).toBe('sheet-sync');
    expect(slugifyAppName('Café  Über')).toBe('cafe-uber');
    expect(slugifyAppName('X')).toBe('app-x');
    expect(slugifyAppName('***')).toBe('app-listing');
  });

  it('checks listing URLs', () => {
    const opts = { allowHttp: false };
    expect(listingUrlProblem('https://a.example/p', opts)).toBeNull();
    expect(listingUrlProblem('http://a.example', opts)).not.toBeNull();
    expect(listingUrlProblem('mailto:a@b.example', opts)).not.toBeNull();
    expect(listingUrlProblem('mailto:a@b.example', { ...opts, allowMailto: true })).toBeNull();
    expect(
      listingUrlProblem('mailto:a@b.example?cc=x', { ...opts, allowMailto: true }),
    ).not.toBeNull();
  });
});
