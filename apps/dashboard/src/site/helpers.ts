// Pure helpers for Site Studio: list reordering, domain input, analytics ranges, Bot Rules and
// the gate divider. Kept free of React so they can be unit tested.
import {
  KNOWN_AI_BOTS,
  isHttpsUrl,
  isSitePath,
  type AiBotsPolicy,
  type DispatchDocument,
  type DomainRoles,
} from '@swarm/domain';

// ---- Lists ---------------------------------------------------------------------------------

/** A copy of `list` with the item at `from` moved to `to` (clamped to the list). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length) return next;
  const target = Math.max(0, Math.min(next.length - 1, to));
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item as T);
  return next;
}

/** The problem with a navigation link, or null when it can be saved. */
export function navLinkProblem(link: { label: string; href: string }): string | null {
  if (!link.label.trim()) return 'Add a label.';
  if (link.label.trim().length > 40) return 'Keep the label under 40 characters.';
  const href = link.href.trim();
  if (!href) return 'Add an address.';
  if (!isSitePath(href) && !isHttpsUrl(href)) {
    return 'Use a path on the site (starting with /) or an https address.';
  }
  return null;
}

// ---- Domains -------------------------------------------------------------------------------

interface DomainPlan {
  /** The hostname to send to the API. */
  hostname: string;
  /** The hostname that serves the site. */
  web: string;
  /** The bare domain that redirects to it, when there is one. */
  apex: string | null;
}

/**
 * Turns what an operator typed ("https://Example.com/", "www.example.com") into what will be set
 * up: a bare domain becomes its www hostname with the bare domain redirecting to it. Null while
 * the input isn't a hostname yet.
 */
export function planDomain(input: string, redirectApex = true): DomainPlan | null {
  const hostname = input
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '');
  if (!/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) {
    return null;
  }
  const labels = hostname.split('.');
  if (labels.length === 2) return { hostname, web: `www.${hostname}`, apex: hostname };
  if (labels[0] === 'www' && labels.length === 3 && redirectApex) {
    return { hostname, web: hostname, apex: labels.slice(1).join('.') };
  }
  return { hostname, web: hostname, apex: null };
}

export type RoleStatus = DomainRoles['web']['status'];

export const ROLE_STATUS: Record<
  RoleStatus,
  { label: string; tone: 'success' | 'scheduled' | 'danger' | 'neutral' }
> = {
  active: { label: 'Active', tone: 'success' },
  pending: { label: 'Waiting for DNS', tone: 'scheduled' },
  failed: { label: 'Failed', tone: 'danger' },
  not_set_up: { label: 'Not set up', tone: 'neutral' },
};

/** Step-by-step CNAME help for common DNS providers. Plain text, no links. */
export const DNS_PROVIDERS: { name: string; steps: string[] }[] = [
  {
    name: 'Cloudflare',
    steps: [
      'Open your domain in the Cloudflare dashboard and go to DNS, then Records.',
      'Choose Add record and pick CNAME as the type.',
      'Paste the name and the target from the table above. For the bare domain use @ as the name; Cloudflare flattens it automatically.',
      'Set the proxy status to DNS only (grey cloud) so the certificate can be issued, then save.',
    ],
  },
  {
    name: 'Namecheap',
    steps: [
      'In Domain List, choose Manage next to the domain, then open Advanced DNS.',
      'Under Host Records choose Add new record and pick CNAME Record.',
      'Enter the name without your domain (www, not www.example.com) as the Host, and the target as the Value.',
      'For the bare domain add an ALIAS Record with @ as the Host and the same target, then save each row with the tick.',
    ],
  },
  {
    name: 'GoDaddy',
    steps: [
      'Open My Products, choose the domain and select DNS, then Manage DNS.',
      'Choose Add New Record and pick CNAME.',
      'Enter www as the Name and the target as the Value, keep the default TTL and save.',
      'GoDaddy does not allow a CNAME on the bare domain. Use its Forwarding section to forward the bare domain to your www address, or move DNS to a provider that supports ALIAS records.',
    ],
  },
  {
    name: 'Google Domains / Squarespace',
    steps: [
      'Open the domain in Squarespace Domains and go to DNS, then DNS Settings.',
      'Under Custom records choose Add record and pick CNAME.',
      'Enter www as the Host and the target as the Data, then save.',
      'For the bare domain use Domain forwarding to send it to your www address, since a CNAME is not allowed there.',
    ],
  },
  {
    name: 'Amazon Route 53',
    steps: [
      'In the Route 53 console open Hosted zones and choose the zone for your domain.',
      'Choose Create record, enter www as the record name and pick CNAME as the record type.',
      'Paste the target as the value, keep the routing policy Simple and create the record.',
      'Route 53 cannot point the bare domain at another hostname with a CNAME. Redirect the bare domain to your www address instead, for example with an S3 website redirect bucket.',
    ],
  },
];

// ---- Analytics -----------------------------------------------------------------------------

const DAY_MS = 86_400_000;
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The last `days` UTC days up to and including `today` (a YYYY-MM-DD string). */
export function lastDays(days: number, today: string): { from: string; to: string } {
  const end = Date.parse(`${today}T00:00:00Z`);
  return { from: dayOf(end - (days - 1) * DAY_MS), to: today };
}

/** The problem with a custom date range, or null. Mirrors the API's limits. */
export function rangeProblem(from: string, to: string): string | null {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 'Choose a start and an end date.';
  if (start > end) return 'The start date is after the end date.';
  if ((end - start) / DAY_MS + 1 > 366) return 'Choose a range of up to 366 days.';
  return null;
}

/** Evenly spaced tick indexes for `count` points, always including the last one. */
export function tickIndexes(count: number, ticks = 6): number[] {
  if (count <= 0) return [];
  const step = Math.max(1, Math.ceil(count / ticks));
  const indexes: number[] = [];
  for (let i = 0; i < count; i += step) indexes.push(i);
  if (indexes[indexes.length - 1] !== count - 1) {
    // Drop a tick that would crowd the last one.
    if (count - 1 - (indexes[indexes.length - 1] ?? 0) < step / 2) indexes.pop();
    indexes.push(count - 1);
  }
  return indexes;
}

/** A rounded-up axis maximum (1, 2, 5 × 10ⁿ) so gridlines land on readable values. */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) {
    if (step * power >= value) return step * power;
  }
  return 10 * power;
}

// ---- Bot Rules -----------------------------------------------------------------------------

export type BotAction = 'allow' | 'block';

/** What the site does with one crawler; matches the site worker and the API. */
export function botAction(
  policy: AiBotsPolicy,
  overrides: Partial<Record<string, BotAction>>,
  key: string,
): BotAction {
  if (policy === 'block') return 'block';
  if (policy === 'custom' && overrides[key] === 'block') return 'block';
  return 'allow';
}

/** The robots.txt lines the policy produces for AI crawlers. */
export function robotsLines(
  policy: AiBotsPolicy,
  overrides: Partial<Record<string, BotAction>>,
): string[] {
  const blocked = KNOWN_AI_BOTS.filter((bot) => botAction(policy, overrides, bot.key) === 'block');
  return blocked.flatMap((bot) => [`User-agent: ${bot.robots}`, 'Disallow: /', '']);
}

// ---- Gate ----------------------------------------------------------------------------------

/** Whether a document has a gate divider at the top level. */
export const hasGate = (doc: DispatchDocument | null | undefined): boolean =>
  !!doc?.content.some((node) => node.type === 'gate');

export const GATE_HELP: Record<'public' | 'members' | 'paid' | 'hidden', string> = {
  public: 'Everyone can read the whole post on the website, so a paywall break has no effect.',
  members: 'Readers who aren’t signed-in subscribers stop at the paywall break.',
  paid: 'Readers without a paid plan stop at the paywall break. The email stops there too.',
  hidden: 'The post is not on the website.',
};
