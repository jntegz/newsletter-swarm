// App Directory: the manifest check and the community recipe sanitiser (docs/app-directory.md).
import {
  AppManifestSchema,
  FlowGraphDraftSchema,
  FlowGraphSchema,
  newId,
  type DispatchDocument,
  type FlowGraph,
} from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import {
  cleanLink,
  manifestProblems,
  recipeSetupSteps,
  recipeToFlowDraft,
  redactAddresses,
  sanitizeDocument,
  sanitizeFlowRecipe,
} from '../src/index';

const ids = {
  form: newId('captureForm'),
  circle: newId('circle'),
  tag: newId('tag'),
  field: newId('memberField'),
  level: newId('membershipLevel'),
  flow: newId('flow'),
  operator: newId('operator'),
  d1: newId('dispatch'),
  d2: newId('dispatch'),
};

const at = (y: number) => ({ x: 0, y });

/** One of every step, each carrying what must not leave the Channel. */
const graph: FlowGraph = FlowGraphSchema.parse({
  schema: 1,
  nodes: [
    {
      id: 'trigger',
      type: 'trigger',
      config: {
        event: 'tag_added',
        tagId: ids.tag,
        filter: { field: 'email', cmp: 'eq', value: 'vip@private.example' },
      },
      position: at(0),
    },
    { id: 'hello', type: 'send_email', config: { dispatchId: ids.d1, audience: 'any' } },
    { id: 'wait', type: 'delay', config: { mode: 'duration', amount: 2, unit: 'days' } },
    { id: 'tag', type: 'add_tag', config: { tagId: ids.tag } },
    { id: 'untag', type: 'remove_tag', config: { tagId: ids.tag } },
    { id: 'field', type: 'update_field', config: { fieldId: ids.field, value: 'Jane Doe' } },
    {
      id: 'level',
      type: 'change_level',
      config: { action: 'grant', levelId: ids.level, days: 30 },
    },
    { id: 'enrol', type: 'enrol_flow', config: { flowId: ids.flow } },
    {
      id: 'branch',
      type: 'branch',
      name: 'Is it ana@private.example?',
      config: {
        condition: { field: 'email', cmp: 'eq', value: 'ana@private.example' },
      },
    },
    { id: 'split', type: 'ab_split', config: { percentA: 50 } },
    {
      id: 'watch',
      type: 'wait_for_event',
      config: {
        event: 'click',
        sendNodeId: 'hello',
        url: 'https://private.example/offer?token=secret',
        timeoutHours: 48,
      },
    },
    {
      id: 'hook',
      type: 'webhook_call',
      config: { url: 'https://hooks.private.example/x?key=sk_secret', includeFields: true },
    },
    {
      id: 'notify',
      type: 'notify_author',
      config: { message: 'Call bob@private.example now', operatorIds: [ids.operator] },
    },
    { id: 'again', type: 'send_email', config: { dispatchId: ids.d2, audience: 'paid' } },
    { id: 'done', type: 'exit', config: {} },
  ],
  edges: [
    { from: 'trigger', to: 'hello' },
    { from: 'hello', to: 'wait' },
    { from: 'wait', to: 'tag' },
    { from: 'tag', to: 'untag' },
    { from: 'untag', to: 'field' },
    { from: 'field', to: 'level' },
    { from: 'level', to: 'enrol' },
    { from: 'enrol', to: 'branch' },
    { from: 'branch', to: 'split', label: 'true' },
    { from: 'branch', to: 'done', label: 'false' },
    { from: 'split', to: 'watch', label: 'a' },
    { from: 'split', to: 'again', label: 'b' },
    { from: 'watch', to: 'hook' },
    { from: 'hook', to: 'notify' },
  ],
});

const body: DispatchDocument = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Hi {{member.first_name}}' }],
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Write to me at jane.doe@private.example or ' },
        {
          type: 'text',
          text: 'read this',
          marks: [
            { type: 'bold' },
            { type: 'link', attrs: { href: 'https://private.example/post?ref=abc&m=mb_1#top' } },
          ],
        },
        {
          type: 'text',
          text: ' or ',
          marks: [{ type: 'link', attrs: { href: 'mailto:jane@private.example' } }],
        },
      ],
    },
    { type: 'image', attrs: { src: 'https://media.example/ws/x.png' } },
    { type: 'askPoll', attrs: { askId: newId('ask'), questionId: newId('askQuestion') } },
    { type: 'htmlBlock', attrs: { html: '<p>raw</p>' } },
    { type: 'smartBlock', attrs: { condition: { field: 'email' } }, content: [] },
    { type: 'button', attrs: { href: 'https://private.example/join?u=42', label: 'Join' } },
    { type: 'button', attrs: { href: 'http://insecure.example', label: 'Old' } },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One' }] }],
        },
      ],
    },
  ],
};

const emails = new Map([
  [ids.d1, { subject: 'Hello from jane@private.example', preheader: 'Welcome', content: body }],
  [ids.d2, { subject: 'Members only', preheader: '', content: body }],
]);

describe('sanitizeFlowRecipe', () => {
  const { recipe, removed } = sanitizeFlowRecipe({ graph, reentry: 'never', emails });
  const text = JSON.stringify(recipe);

  it('leaves no id, address, private URL or secret', () => {
    expect(text).not.toMatch(/[a-z]{2}_[0-9a-f]{32}/);
    expect(text).not.toMatch(/private\.example\/(?:x|offer)|hooks\.|sk_secret|token=|ref=|mailto/);
    expect(text).not.toMatch(/@private\.example/);
    expect(text).not.toContain('Jane Doe');
    expect(text).not.toContain('media.example');
    expect(text).not.toContain('<p>raw</p>');
  });

  it('keeps the structure, settings that are not Channel-specific, and merge tags', () => {
    expect(recipe.triggerType).toBe('tag_added');
    expect(recipe.nodes.map((n) => n.id)).toEqual(graph.nodes.map((n) => n.id));
    expect(recipe.edges).toEqual(graph.edges);
    const byId = new Map(recipe.nodes.map((n) => [n.id, n]));
    expect(byId.get('wait')!.config).toEqual({ mode: 'duration', amount: 2, unit: 'days' });
    expect(byId.get('split')!.config).toEqual({ percentA: 50 });
    expect(byId.get('watch')!.config).toEqual({
      event: 'click',
      sendNodeId: 'hello',
      timeoutHours: 48,
    });
    expect(byId.get('level')!.config).toEqual({ action: 'grant', days: 30 });
    expect(byId.get('hook')!.config).toEqual({ includeFields: true });
    expect(byId.get('notify')!.config).toEqual({ message: 'Call [email] now' });
    expect(byId.get('branch')!.name).toBe('Is it [email]?');
    expect(byId.get('hello')!.config).toEqual({ emailKey: 'email_1', audience: 'any' });
    expect(text).toContain('{{member.first_name}}');
    expect(text).toContain('https://private.example/post');
    expect(text).toContain('https://private.example/join');
  });

  it('marks the steps that need the Channel’s own settings', () => {
    const needs = Object.fromEntries(
      recipe.nodes.filter((n) => n.needsSetup).map((n) => [n.id, n.needsSetup]),
    );
    expect(needs).toEqual({
      trigger: ['tagId'],
      tag: ['tagId'],
      untag: ['tagId'],
      field: ['fieldId'],
      level: ['levelId'],
      enrol: ['flowId'],
      branch: ['condition'],
      hook: ['url'],
    });
    expect(recipeSetupSteps(recipe)).toBe(8);
    expect(removed.some((r) => r.nodeId === 'trigger' && /enrolment condition/.test(r.what))).toBe(
      true,
    );
    expect(removed.some((r) => r.emailKey === 'email_1' && /images/.test(r.what))).toBe(true);
  });

  it('copies each email once, sanitised', () => {
    expect(recipe.emails.map((e) => e.key)).toEqual(['email_1', 'email_2']);
    expect(recipe.emails[0]!.subject).toBe('Hello from [email]');
    const types = recipe.emails[0]!.content.content.map((n) => n.type);
    expect(types).toEqual(['heading', 'paragraph', 'button', 'bulletList']);
  });

  it('becomes a draft Flow: complete steps in the graph, the rest pending', () => {
    const { graph: draft, pending } = recipeToFlowDraft(recipe, {
      email_1: ids.d1,
      email_2: ids.d2,
    });
    expect(FlowGraphDraftSchema.safeParse(draft).success).toBe(true);
    expect(draft.nodes.map((n) => n.id).sort()).toEqual(
      ['again', 'done', 'hello', 'notify', 'split', 'wait', 'watch'].sort(),
    );
    expect(pending!.nodes.map((n) => n.id).sort()).toEqual(
      ['branch', 'enrol', 'field', 'hook', 'level', 'tag', 'trigger', 'untag'].sort(),
    );
    // Every edge lands in exactly one of the two.
    expect(draft.edges.length + pending!.edges.length).toBe(graph.edges.length);
  });
});

describe('sanitizeDocument and helpers', () => {
  it('names a dropped block whose type Object.prototype has like any other', () => {
    // A shared email's block types are just text to the reviewer.
    expect(
      sanitizeDocument({ type: 'doc', content: [{ type: 'constructor' }, { type: 'toString' }] })
        .dropped,
    ).toEqual(['a constructor block', 'a toString block']);
  });

  it('keeps an empty document valid', () => {
    expect(sanitizeDocument({ type: 'doc', content: [{ type: 'image' }] }).content).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph' }],
    });
  });

  it('cleans links and addresses', () => {
    expect(cleanLink('https://a.example/p?x=1#y')).toBe('https://a.example/p');
    expect(cleanLink('http://a.example')).toBeNull();
    expect(cleanLink('https://u:p@a.example')).toBeNull();
    expect(cleanLink('javascript:alert(1)')).toBeNull();
    expect(redactAddresses('a.b+c@d.co and {{member.email}}')).toBe('[email] and {{member.email}}');
  });
});

describe('manifestProblems', () => {
  const manifest = AppManifestSchema.parse({
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
    oauth: {
      clientType: 'public',
      redirectUris: ['https://s.example/cb', 'https://s.example/other'],
      scopes: ['members:read', 'members:write'],
    },
  });

  it('accepts a manifest that matches the registration', () => {
    expect(
      manifestProblems(manifest, {
        clientType: 'public',
        redirectUris: ['https://s.example/cb', 'https://s.example/other'],
        scopes: ['members:read', 'members:write', 'channels:read'],
      }),
    ).toEqual([]);
  });

  it('names each mismatch', () => {
    const problems = manifestProblems(manifest, {
      clientType: 'confidential',
      redirectUris: ['https://s.example/cb'],
      scopes: ['members:read'],
    });
    expect(problems.map((p) => p.path)).toEqual([
      'manifest.oauth.clientType',
      'manifest.oauth.redirectUris.1',
      'manifest.oauth.scopes.1',
    ]);
  });
});
