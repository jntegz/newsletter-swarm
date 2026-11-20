import type { ReaderClass, SignupPath, SiteLayout, SiteTemplate } from '@swarm/domain';
import type { RuntimeVariables } from '@swarm/runtime';
import type { Context } from 'hono';
import type { SiteEnv } from './env';

/** The Channel this request is for, resolved from the Host header. */
export interface SiteChannel {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string | null;
  branding: { accentColor?: string | null; logoMediaId?: string | null };
  /** Canonical origin: the primary custom hostname when active, else the platform subdomain. */
  origin: string;
  /** The host this request arrived on. */
  host: string;
  settings: {
    signupPath: SignupPath;
    customCss: string;
    layout: SiteLayout;
    pinned: string[];
    aboutJson: string;
    nav: { label: string; href: string }[];
    seo: { ogMediaId?: string; verification?: Record<string, string>; sameAs?: string[] };
    theme: {
      template?: SiteTemplate;
      font?: 'geist' | 'inter' | 'grotesk' | 'archivo' | 'serif';
      headline?: string;
      pitch?: string;
      benefits?: string[];
      showSubscriberCount?: boolean;
      pageColor?: string;
      inkColor?: string;
      colorScheme?: 'light' | 'dark' | 'auto';
      dropCaps?: boolean;
    };
    aiBots: 'unset' | 'allow' | 'block' | 'custom';
    exposeGated: boolean;
    prevNextNav: boolean;
    cacheVersion: number;
    /** The published website design's version (site_designs); null before the first publish. */
    designVersion: number | null;
    /** Section ids of the published design's running A/B tests, sorted; empty without any. */
    designTests: string[];
  };
}

export interface Reader {
  class: ReaderClass;
  memberId: string | null;
  /**
   * The Membership level a paid reader holds (member_entitlements.level_id), so a Gate can admit
   * some levels and not others. Null for anonymous and member readers, and for paid entitlements
   * that name no level.
   */
  levelId: string | null;
}

type SiteVariables = RuntimeVariables & {
  env: SiteEnv;
  channel: SiteChannel;
  /** Anonymous by default; the reader middleware sets it from the session cookie. */
  reader: Reader;
  /** A verified search crawler on a Channel that exposes gated content to search engines. */
  crawlerFullAccess: boolean;
  /**
   * The variant each running A/B test shows this home page view, by section id: chosen at random
   * by the edge before the cache is looked up, and part of the cache key. Empty elsewhere.
   */
  variants: Record<string, 'a' | 'b'>;
  /** This page runs the owner's code, so it gets the wider CSP. */
  ownerCode?: boolean;
  /** Origins of the players this page can load, which its CSP then allows as frames. */
  players?: string[];
  /**
   * Per-response CSP nonce for inline script and style elements (`nonce="…"`). The site CSP
   * (edge/headers.ts) allows exactly this nonce; cached pages get it swapped on every hit.
   */
  nonce: string;
  /** Security headers the route set itself, restored after the shared runtime's defaults. */
  routeHeaders: Record<string, string>;
};

export type SiteBindings = { Variables: SiteVariables };
export type SiteContext = Context<SiteBindings>;
