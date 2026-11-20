// The embed: /v1/<formId>.js (the loader), /v1/<formId>/frame (the form) and /v1/attr.js.
import {
  ATTRIBUTION_SCRIPT,
  bumpFormDaily,
  buildEmbedScript,
  formStamp,
  linksFor,
  loaderConfig,
} from '@swarm/engine';
import type { Hono } from 'hono';
import { env, later, type AppContext, type AppEnv } from '../context';
import { originOf } from '../env';
import { formFieldDefs, loadPublishedForm } from '../forms';
import { framePage } from '../frame';
import { originAllowed, originFrom } from '../guard';
import { page } from '../pages';

/** A pinned version is immutable, so a year; the unpinned script follows republishes. */
const PINNED = 'public, max-age=31536000, immutable';
const LATEST = 'public, max-age=300';

function javascript(c: AppContext, body: string, status: 200 | 404, cache: string): Response {
  // Scripts load cross-origin with crossorigin="anonymous" (needed for SRI): readable by any
  // site, never with credentials.
  c.set('headerOverrides', { 'cross-origin-resource-policy': 'cross-origin' });
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': cache,
      'access-control-allow-origin': '*',
    },
  });
}

/** `?v=` as a version number; undefined when absent, null when malformed. */
function versionParam(c: AppContext): number | undefined | null {
  const v = c.req.query('v');
  if (v === undefined) return undefined;
  return /^[1-9][0-9]{0,8}$/.test(v) ? Number(v) : null;
}

export function embedRoutes(app: Hono<AppEnv>): void {
  app.get('/v1/attr.js', (c) => javascript(c, ATTRIBUTION_SCRIPT, 200, 'public, max-age=86400'));

  app.get('/v1/:file{cf_[0-9a-f]{32}\\.js}', async (c) => {
    const e = env(c);
    const formId = c.req.param('file').slice(0, -3);
    const version = versionParam(c);
    const form = version === null ? null : await loadPublishedForm(e.DB, formId, version);
    if (!form) {
      return javascript(c, '/* This form is not available. */\n', 404, 'public, max-age=60');
    }
    const script = buildEmbedScript(loaderConfig(originOf(e), form.id, form.version, form.config));
    return javascript(c, script, 200, version ? PINNED : LATEST);
  });

  app.get('/v1/:formId/frame', async (c) => {
    const e = env(c);
    const version = versionParam(c);
    const form =
      version === null ? null : await loadPublishedForm(e.DB, c.req.param('formId'), version);
    c.set('headerOverrides', { 'x-frame-options': null });
    if (!form) {
      return page(
        'Form not available',
        '<h1>This form is not available</h1><p>It may have been taken down.</p>',
        { status: 404 },
      );
    }
    // The loader asks for the frame with a strict-origin referrer: a foreign host is turned away
    // here as well as by frame-ancestors.
    const host = originFrom(c.req.header('referer'));
    if (host && host !== originOf(e) && !originAllowed(form.config.allowedOrigins, host)) {
      return page(
        'Form not available here',
        '<h1>This form is not available here</h1><p>It can only be used on the site it belongs to.</p>',
        { status: 403 },
      );
    }
    later(c, bumpFormDaily(e.DB, form.id, 'views'));
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    return framePage({
      form,
      defs: await formFieldDefs(e.DB, form),
      siteKey: e.TURNSTILE_SITE_KEY,
      nonce,
      // Proves on submit that this version was rendered here (consents.ts).
      stamp: await formStamp(linksFor(e), form.id, form.version),
    });
  });
}
