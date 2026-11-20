// Smart Prompts (flag smart_prompts): Capture Forms of kind 'prompt' that the site shows by page
// context (capture_forms.placement_json, SmartPromptPlacement in @swarm/domain).
//
// - dispatch_end and gate_hit render server-side as a plain inline form (no script): after the
//   Dispatch body, or under the Gate panel when a reader is shown the Gate.
// - scroll, exit_intent and delay render server-side as a hidden panel that PROMPT_SCRIPT (inline,
//   nonce'd, first party, under 2 KB) reveals. Without JavaScript they simply never show.
// - The form posts to the capture worker exactly like the site form (render/subscribe.ts), so the
//   same checks and Signup Journeys apply.
// - "No thanks" posts to /_swarm/prompt/dismiss, which records the dismissal in a first-party
//   cookie (prompt ids and the end of each cooldown; nothing else, no identifier). A request
//   carrying that cookie skips the edge cache and its page is not stored (middleware/edge.ts),
//   since what it shows depends on the cookie.
// Matching is by reader class (anonymous, free = anonymous or Member, everyone) and path globs,
// so pages stay cacheable per reader class.
import {
  CaptureFormConfigSchema,
  SmartPromptPlacementSchema,
  type CaptureFormConfig,
  type ReaderClass,
  type SmartPromptPlacement,
} from '@swarm/domain';
import { all } from '@swarm/db';
import { formStamp, linksFor } from '@swarm/engine';
import { getCookie } from 'hono/cookie';
import type { SiteChannel, SiteContext } from '../context';
import type { SiteEnv } from '../env';
import { h } from './html';
import { subscribeForm } from './subscribe';

export interface SitePrompt {
  id: string;
  version: number;
  config: CaptureFormConfig;
  placement: SmartPromptPlacement;
  /** consents.ts formStamp for this version. */
  stamp: string;
}

const PROMPT_COOKIE_SECURE = '__Host-swarm_prompts';
const PROMPT_COOKIE_LOCAL = 'swarm_prompts';
/** At most this many dismissals are remembered (the oldest go first). */
const PROMPT_COOKIE_MAX = 10;
const ENTRY = /^(cf_[0-9a-f]{32})\.([0-9]{1,12})$/;

export const promptCookieName = (env: Pick<SiteEnv, 'SITE_SCHEME'>) =>
  env.SITE_SCHEME === 'https' ? PROMPT_COOKIE_SECURE : PROMPT_COOKIE_LOCAL;

/** Dismissals still cooling down, by prompt id → until (ms). */
export function readDismissals(c: SiteContext, now = Date.now()): Map<string, number> {
  const raw = getCookie(c, promptCookieName(c.get('env')));
  const out = new Map<string, number>();
  if (!raw || raw.length > 1024) return out;
  for (const part of raw.split('~')) {
    const match = ENTRY.exec(part);
    if (!match) continue;
    const until = Number(match[2]) * 1000;
    if (until > now) out.set(match[1]!, until);
  }
  return out;
}

/** The cookie value after dismissing `id` until `until` (ms). */
export function writeDismissals(
  dismissals: Map<string, number>,
  id: string,
  until: number,
): string {
  const entries = [...dismissals.entries()].filter(([key]) => key !== id);
  entries.push([id, until]);
  return entries
    .slice(-PROMPT_COOKIE_MAX)
    .map(([key, ms]) => `${key}.${Math.ceil(ms / 1000)}`)
    .join('~');
}

/** Whether the request carries a dismissal cookie at all (the edge cache bypass). */
export const hasPromptCookie = (c: SiteContext) => !!getCookie(c, promptCookieName(c.get('env')));

/** The Channel's published Smart Prompts that this site may use, newest first. */
export async function sitePrompts(env: SiteEnv, channel: SiteChannel): Promise<SitePrompt[]> {
  const rows = await all<{
    id: string;
    version: number;
    published_config_json: string;
    placement_json: string;
  }>(
    env.DB,
    `SELECT id, version, published_config_json, placement_json FROM capture_forms
      WHERE channel_id = ?1 AND kind = 'prompt' AND status = 'published' AND deleted_at IS NULL
        AND published_config_json IS NOT NULL AND placement_json IS NOT NULL
      ORDER BY published_at DESC LIMIT 20`,
    channel.id,
  );
  const prompts: SitePrompt[] = [];
  for (const row of rows) {
    try {
      const config = CaptureFormConfigSchema.safeParse(JSON.parse(row.published_config_json));
      const placement = SmartPromptPlacementSchema.safeParse(JSON.parse(row.placement_json));
      if (!config.success || !placement.success) continue;
      const allowed =
        config.data.allowedOrigins.length === 0 ||
        config.data.allowedOrigins.includes(channel.origin);
      // The plain form can't ask for required profile fields (only the embed frame can).
      const plain = !config.data.fields.some((f) => f.key.startsWith('field:') && f.required);
      if (allowed && plain)
        prompts.push({
          id: row.id,
          version: row.version,
          config: config.data,
          placement: placement.data,
          stamp: await formStamp(linksFor(env), row.id, row.version),
        });
    } catch {
      continue;
    }
  }
  return prompts;
}

function globMatches(glob: string, path: string): boolean {
  const pattern = glob
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${pattern}$`).test(path);
}

const readerMatches = (readers: SmartPromptPlacement['readers'], reader: ReaderClass) =>
  readers === 'everyone' || reader === 'anonymous' || (readers === 'free' && reader === 'member');

/** The first prompt for one of `triggers` that matches this page and reader, if any. */
export function pickPrompt(
  prompts: readonly SitePrompt[],
  input: {
    triggers: readonly SmartPromptPlacement['trigger'][];
    path: string;
    reader: ReaderClass;
    dismissed: Map<string, number>;
  },
): SitePrompt | null {
  return (
    prompts.find(
      (p) =>
        input.triggers.includes(p.placement.trigger) &&
        readerMatches(p.placement.readers, input.reader) &&
        (p.placement.paths.length === 0 ||
          p.placement.paths.some((g) => globMatches(g, input.path))) &&
        !input.dismissed.has(p.id),
    ) ?? null
  );
}

/** A prompt's markup. Floating prompts start hidden and need PROMPT_SCRIPT to appear. */
export function promptHtml(env: SiteEnv, prompt: SitePrompt, returnPath: string): string {
  const { config, placement } = prompt;
  const floating = ['scroll', 'exit_intent', 'delay'].includes(placement.trigger);
  const titleId = `sw-prompt-${prompt.id}`;
  const heading = config.copy.heading || 'Get new posts by email';
  const attrs = floating
    ? ` class="sw-prompt sw-prompt-float" data-sw-prompt="${placement.trigger}" data-sw-value="${placement.value ?? 0}" hidden`
    : ' class="sw-prompt"';
  return `<aside${attrs} aria-labelledby="${titleId}">
<h2 id="${titleId}">${h(heading)}</h2>
${config.copy.body ? `<p>${h(config.copy.body)}</p>` : ''}
${subscribeForm(env, { id: prompt.id, version: prompt.version, config, stamp: prompt.stamp })}
<form class="sw-prompt-dismiss" method="post" action="/_swarm/prompt/dismiss"><input type="hidden" name="id" value="${prompt.id}"><input type="hidden" name="return" value="${h(returnPath)}"><button type="submit">No thanks</button></form>
</aside>`;
}

/**
 * Reveals floating prompts: after `value` seconds (delay), at `value` percent of the page
 * (scroll), or when the pointer leaves through the top of the window (exit_intent). Kept under
 * 2 KB; no network, no storage.
 */
export const PROMPT_SCRIPT = `(function(){var d=document,w=window;d.querySelectorAll('[data-sw-prompt]').forEach(function(el){var t=el.getAttribute('data-sw-prompt'),v=Number(el.getAttribute('data-sw-value'))||0,done=false;function show(){if(done)return;done=true;el.hidden=false;}if(t==='delay'){setTimeout(show,v*1000);}else if(t==='scroll'){var f=function(){var e=d.documentElement;if((e.scrollTop+w.innerHeight)/e.scrollHeight*100>=v){show();w.removeEventListener('scroll',f);}};w.addEventListener('scroll',f,{passive:true});f();}else if(t==='exit_intent'){d.addEventListener('mouseout',function(e){if(!e.relatedTarget&&e.clientY<=0)show();});}});})();`;

/** The script element, with this response's nonce. */
export const promptScript = (nonce: string) =>
  `<script nonce="${h(nonce)}">${PROMPT_SCRIPT}</script>`;
