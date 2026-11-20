// Bot Rules: which AI crawlers a Channel blocks, from its policy and per-crawler overrides.
//
// - 'unset' (the operator has not answered yet) and 'allow': nothing is blocked and robots.txt
//   gets no AI lines.
// - 'block': every known AI crawler is blocked, by User-Agent and by Cloudflare's verified-bot
//   category when that says AI.
// - 'custom': crawlers with a 'block' row in bot_rules are blocked by User-Agent; the rest are
//   allowed. (A verified-bot category can't be mapped to one crawler, so it isn't used here.)
import { all } from '@swarm/db';
import { KNOWN_AI_BOTS, type AiBotKey } from '@swarm/domain';
import type { SiteChannel } from '../context';
import type { SiteEnv } from '../env';

type KnownBot = (typeof KNOWN_AI_BOTS)[number];

/** cf.verifiedBotCategory values that mean an AI crawler or AI fetcher. */
const AI_BOT_CATEGORIES = new Set(['AI Crawler', 'AI Assistant', 'AI Search']);

interface BotPolicy {
  /** Crawlers to block (and to disallow in robots.txt). */
  blocked: KnownBot[];
  /** Also block anything Cloudflare verifies as an AI crawler. */
  blockAiCategory: boolean;
}

export async function botPolicy(env: SiteEnv, channel: SiteChannel): Promise<BotPolicy> {
  switch (channel.settings.aiBots) {
    case 'block':
      return { blocked: [...KNOWN_AI_BOTS], blockAiCategory: true };
    case 'custom': {
      const rows = await all<{ agent: string }>(
        env.DB,
        "SELECT agent FROM bot_rules WHERE channel_id = ?1 AND action = 'block'",
        channel.id,
      );
      const keys = new Set(rows.map((row) => row.agent));
      return { blocked: KNOWN_AI_BOTS.filter((bot) => keys.has(bot.key)), blockAiCategory: false };
    }
    default:
      return { blocked: [], blockAiCategory: false };
  }
}

/** The known AI crawler a User-Agent claims to be, if any. */
export function matchAiBot(userAgent: string | undefined): KnownBot | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  return KNOWN_AI_BOTS.find((bot) => ua.includes(bot.ua.toLowerCase())) ?? null;
}

/** Whether this request is from a crawler the policy blocks. */
export function isBlocked(
  policy: BotPolicy,
  userAgent: string | undefined,
  verifiedBotCategory: string | undefined,
): boolean {
  if (policy.blockAiCategory && verifiedBotCategory && AI_BOT_CATEGORIES.has(verifiedBotCategory)) {
    return true;
  }
  if (policy.blocked.length === 0) return false;
  const bot = matchAiBot(userAgent);
  return !!bot && policy.blocked.some((blocked) => blocked.key === (bot.key as AiBotKey));
}
