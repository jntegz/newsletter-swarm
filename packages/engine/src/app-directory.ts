// App Directory (Phase 8.12): the manifest checked against a registered OAuth app, and the
// community Flow Recipe sanitiser. Pure functions; the API worker reads and writes the rows.
// Contract: docs/app-directory.md.
import {
  FLOW_GRAPH_SCHEMA_VERSION,
  FlowNodeSchema,
  type AppManifest,
  type ApiScope,
  type CommunityRecipeGraph,
  type DispatchDocument,
  type FlowDraftPending,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
  type FlowReentry,
  type RecipeEmail,
  type RecipeNode,
  type RecipeRemoval,
} from '@swarm/domain';

// ---------------------------------------------------------------------------------------------
// The manifest

export interface RegisteredApp {
  clientType: 'public' | 'confidential';
  redirectUris: readonly string[];
  scopes: readonly ApiScope[];
}

/**
 * Where a manifest disagrees with the app's registration, as API error details. A manifest
 * describes an app; it never changes the registration.
 */
export function manifestProblems(
  manifest: AppManifest,
  app: RegisteredApp,
): { path: string; message: string }[] {
  const problems: { path: string; message: string }[] = [];
  if (manifest.oauth.clientType !== app.clientType) {
    problems.push({
      path: 'manifest.oauth.clientType',
      message: `The app is registered as ${app.clientType}.`,
    });
  }
  manifest.oauth.redirectUris.forEach((uri, i) => {
    if (!app.redirectUris.includes(uri)) {
      problems.push({
        path: `manifest.oauth.redirectUris.${i}`,
        message: 'This redirect URI is not registered for the app.',
      });
    }
  });
  manifest.oauth.scopes.forEach((scope, i) => {
    if (!app.scopes.includes(scope)) {
      problems.push({
        path: `manifest.oauth.scopes.${i}`,
        message: `The app is not registered for ${scope}.`,
      });
    }
  });
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Sanitising a Flow into a community recipe. An allowlist: whatever is not copied on purpose is
// left out. See the table in docs/app-directory.md.

const ADDRESS = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** Replaces anything shaped like an email address with [email]. Merge tags are left alone. */
export const redactAddresses = (text: string): string => text.replace(ADDRESS, '[email]');

/** An https link without its query string and fragment, or null. */
export function cleanLink(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  url.search = '';
  url.hash = '';
  return url.toString();
}

type Json = Record<string, unknown>;
const BLOCKS = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'horizontalRule',
]);
const STYLES = new Set(['bold', 'italic', 'underline', 'strike', 'code']);

class DocumentCleaner {
  readonly dropped = new Set<string>();

  blocks(nodes: unknown): Json[] {
    if (!Array.isArray(nodes)) return [];
    return nodes.flatMap((node) => this.block(node));
  }

  block(node: unknown): Json[] {
    if (typeof node !== 'object' || node === null) return [];
    const n = node as Json;
    const type = String(n.type);
    if (type === 'button') {
      const href = cleanLink((n.attrs as Json | undefined)?.href);
      const label = (n.attrs as Json | undefined)?.label;
      if (!href || typeof label !== 'string' || !label.trim()) {
        this.dropped.add('a button without an https address');
        return [];
      }
      return [{ type, attrs: { href, label: redactAddresses(label).slice(0, 80) } }];
    }
    if (!BLOCKS.has(type)) {
      // Own keys only: a recipe's "constructor" block is not Object.prototype's.
      this.dropped.add(
        (Object.hasOwn(DROPPED_LABEL, type) ? DROPPED_LABEL[type] : undefined) ?? `a ${type} block`,
      );
      return [];
    }
    const out: Json = { type };
    if (type === 'heading') {
      const level = Number((n.attrs as Json | undefined)?.level);
      out.attrs = { level: [1, 2, 3].includes(level) ? level : 2 };
    }
    if (type === 'paragraph' || type === 'heading') {
      const content = this.inline(n.content);
      if (content.length) out.content = content;
    } else if (type !== 'horizontalRule') {
      const content = this.blocks(n.content);
      if (type === 'listItem' && !content.length) content.push({ type: 'paragraph' });
      if (content.length) out.content = content;
      else if (type !== 'blockquote') return [];
    }
    return [out];
  }

  inline(nodes: unknown): Json[] {
    if (!Array.isArray(nodes)) return [];
    const out: Json[] = [];
    for (const node of nodes) {
      if (typeof node !== 'object' || node === null) continue;
      const n = node as Json;
      if (n.type === 'hardBreak') {
        out.push({ type: 'hardBreak' });
        continue;
      }
      if (n.type !== 'text' || typeof n.text !== 'string') {
        this.dropped.add(`an inline ${String(n.type)}`);
        continue;
      }
      const marks: Json[] = [];
      for (const mark of Array.isArray(n.marks) ? (n.marks as Json[]) : []) {
        if (STYLES.has(String(mark?.type))) marks.push({ type: mark.type });
        else if (mark?.type === 'link') {
          const href = cleanLink((mark.attrs as Json | undefined)?.href);
          if (href) marks.push({ type: 'link', attrs: { href } });
          else this.dropped.add('a link that is not https (mailto: included)');
        }
      }
      const text = redactAddresses(n.text);
      if (!text) continue;
      out.push(marks.length ? { type: 'text', text, marks } : { type: 'text', text });
    }
    return out;
  }
}

const DROPPED_LABEL: Record<string, string> = {
  image: 'images',
  linkCard: 'link cards',
  attachment: 'attachments',
  askPoll: 'polls',
  gate: 'the paywall break',
  smartBlock: 'Smart blocks',
  htmlBlock: 'raw HTML',
  codeBlock: 'code blocks',
};

/** The document with only the allowed blocks, marks and https links left; what was dropped. */
export function sanitizeDocument(doc: DispatchDocument): {
  content: DispatchDocument;
  dropped: string[];
} {
  const cleaner = new DocumentCleaner();
  const content = cleaner.blocks(doc.content);
  return {
    content: { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] },
    dropped: [...cleaner.dropped].sort(),
  };
}

/** Trigger settings that are not Channel-specific and are kept. */
const TRIGGER_KEEP = ['includeImports', 'days', 'name'] as const;
/** Trigger settings a trigger cannot work without; removed, so the step needs setting up. */
const TRIGGER_REQUIRED: Record<string, string> = {
  circle_entered: 'circleId',
  circle_exited: 'circleId',
  tag_added: 'tagId',
  tag_removed: 'tagId',
  field_changed: 'fieldId',
  ask_answered: 'askId',
  roster_joined: 'rosterId',
  roster_left: 'rosterId',
};
const TRIGGER_LABEL: Record<string, string> = {
  formId: 'the signup form',
  circleId: 'the segment',
  tagId: 'the tag',
  fieldId: 'the profile field',
  levelId: 'the paid plan',
  askId: 'the poll or survey',
  optionId: 'the answer',
  rosterId: 'the Roster',
  milestoneId: 'the milestone',
  dispatchId: 'the post',
  url: 'the link',
  filter: 'the enrolment condition',
  alsoStartOn: 'the other start events',
};

export interface FlowEmailSource {
  subject: string;
  preheader: string;
  content: DispatchDocument;
}

export interface SanitizedRecipe {
  recipe: CommunityRecipeGraph;
  removed: RecipeRemoval[];
}

/**
 * A community recipe from a Flow's draft graph and its emails (by Dispatch id). Ids, addresses,
 * URLs and conditions of the Channel are removed; the webhook secret is never an input.
 */
export function sanitizeFlowRecipe(input: {
  graph: FlowGraph;
  reentry: FlowReentry;
  emails: ReadonlyMap<string, FlowEmailSource>;
}): SanitizedRecipe {
  const removed: RecipeRemoval[] = [];
  const nodes: RecipeNode[] = [];
  const emails: RecipeEmail[] = [];
  const note = (nodeId: string | null, what: string, emailKey: string | null = null) =>
    removed.push({ nodeId, emailKey, what });

  for (const node of input.graph.nodes) {
    const out: RecipeNode = { id: node.id, type: node.type, config: {} };
    if (node.name) out.name = redactAddresses(node.name).slice(0, 80);
    if (node.position) out.position = { x: node.position.x, y: node.position.y };
    const needs: string[] = [];
    const drop = (key: string, label: string, required: boolean) => {
      note(node.id, `Removed ${label}.`);
      if (required) needs.push(key);
    };

    switch (node.type) {
      case 'trigger': {
        const c = node.config as Record<string, unknown>;
        out.config.event = c.event;
        for (const key of TRIGGER_KEEP) if (c[key] !== undefined) out.config[key] = c[key];
        for (const [key, label] of Object.entries(TRIGGER_LABEL)) {
          if (c[key] !== undefined) drop(key, label, TRIGGER_REQUIRED[String(c.event)] === key);
        }
        break;
      }
      case 'send_email': {
        const key = `email_${emails.length + 1}`;
        const source = input.emails.get(node.config.dispatchId);
        const clean = source ? sanitizeDocument(source.content) : null;
        emails.push({
          key,
          subject: redactAddresses(source?.subject ?? '').slice(0, 200),
          preheader: redactAddresses(source?.preheader ?? '').slice(0, 200),
          content: clean?.content ?? { type: 'doc', content: [{ type: 'paragraph' }] },
        });
        for (const what of clean?.dropped ?? []) note(node.id, `Removed ${what}.`, key);
        out.config = { emailKey: key, audience: node.config.audience };
        break;
      }
      case 'delay':
      case 'ab_split':
      case 'exit':
        out.config = structuredClone(node.config) as Record<string, unknown>;
        break;
      case 'wait_for_event': {
        const { url, ...rest } = node.config;
        out.config = { ...rest };
        if (url !== undefined) drop('url', 'the link', false);
        break;
      }
      case 'add_tag':
      case 'remove_tag':
        drop('tagId', 'the tag', true);
        break;
      case 'update_field':
        drop('fieldId', 'the profile field and its value', true);
        break;
      case 'change_level': {
        const c = node.config;
        out.config =
          c.action === 'grant' ? { action: c.action, days: c.days } : { action: c.action };
        drop('levelId', 'the paid plan', true);
        break;
      }
      case 'enrol_flow':
        drop('flowId', 'the automation', true);
        break;
      case 'branch':
        drop('condition', 'the condition', true);
        break;
      case 'webhook_call':
        out.config = { includeFields: node.config.includeFields };
        drop('url', 'the webhook address', true);
        break;
      case 'notify_author':
        out.config = { message: redactAddresses(node.config.message) };
        if (node.config.operatorIds?.length) drop('operatorIds', 'the teammates to notify', false);
        break;
    }
    if (needs.length) out.needsSetup = needs;
    nodes.push(out);
  }

  const trigger = input.graph.nodes.find((n) => n.type === 'trigger');
  return {
    recipe: {
      schema: 1,
      triggerType:
        (trigger?.config as { event: CommunityRecipeGraph['triggerType'] } | undefined)?.event ??
        'confirmed',
      reentry: input.reentry,
      nodes,
      edges: input.graph.edges.map((e) => ({ from: e.from, to: e.to, label: e.label })),
      emails,
    },
    removed,
  };
}

/** Steps of a recipe that need the Channel's own settings before the Flow can be published. */
export const recipeSetupSteps = (recipe: CommunityRecipeGraph) =>
  recipe.nodes.filter((n) => n.needsSetup?.length).length;

/**
 * The draft graph and pending steps of a new Flow made from a recipe, given the Dispatch id
 * created for each email key. Complete steps (they parse as FlowNodeSchema) go into the graph;
 * the rest are pending steps, which the builder asks the operator to finish.
 */
export function recipeToFlowDraft(
  recipe: CommunityRecipeGraph,
  dispatchIds: Record<string, string>,
): { graph: FlowGraph; pending: FlowDraftPending | null } {
  const complete: FlowNode[] = [];
  const pending: FlowDraftPending['nodes'] = [];
  for (const node of recipe.nodes) {
    const config: Record<string, unknown> = { ...node.config };
    if (node.type === 'send_email') {
      const dispatchId = dispatchIds[String(config.emailKey)];
      delete config.emailKey;
      if (dispatchId) config.dispatchId = dispatchId;
    }
    const candidate = {
      id: node.id,
      type: node.type,
      config,
      ...(node.position ? { position: node.position } : {}),
      ...(node.name ? { name: node.name } : {}),
    };
    const parsed = node.needsSetup?.length ? null : FlowNodeSchema.safeParse(candidate);
    if (parsed?.success) complete.push(parsed.data);
    else pending.push(candidate);
  }
  const kept = new Set(complete.map((n) => n.id));
  const inGraph = (e: FlowEdge) => kept.has(e.from) && kept.has(e.to);
  return {
    graph: {
      schema: FLOW_GRAPH_SCHEMA_VERSION,
      nodes: complete,
      edges: recipe.edges.filter(inGraph),
    },
    pending: pending.length
      ? { nodes: pending, edges: recipe.edges.filter((e) => !inGraph(e)) }
      : null,
  };
}
