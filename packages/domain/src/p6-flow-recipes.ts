// Flow Recipes (Phase 6): code-defined starting graphs with their Flow emails pre-written.
// `POST /channels/{channelId}/flows { recipe }` creates one Dispatch of kind 'flow' per email
// and then builds the graph with their ids. Every recipe graph passes FlowGraphSchema (the
// domain tests check each one), so a recipe Flow can be published as soon as its emails are
// reviewed. The 'welcome' recipe is the Welcome Dispatch: confirmed → A/B split → two variants,
// with auto-promotion of the winner (see ab_split.autoPromote in p6-flows.ts).
import type { DispatchDocument } from './send';
import { FLOW_GRAPH_SCHEMA_VERSION, type FlowGraph, type FlowReentry } from './p6-flows';
import type { FlowRecipe } from './p6-growth';

interface FlowRecipeEmail {
  /** Stable key inside the recipe; the graph refers to the email by it. */
  key: string;
  subject: string;
  preheader: string;
  content: DispatchDocument;
}

interface FlowRecipeDef {
  key: FlowRecipe;
  /** The Flow's default name. */
  name: string;
  description: string;
  reentry: FlowReentry;
  emails: FlowRecipeEmail[];
  /** The graph, given the Dispatch id created for each email key. */
  graph: (dispatchIds: Record<string, string>) => FlowGraph;
}

const doc = (...paragraphs: string[]): DispatchDocument => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});

const email = (key: string, subject: string, preheader: string, ...body: string[]) => ({
  key,
  subject,
  preheader,
  content: doc(...body),
});

const at = (x: number, y: number) => ({ x, y });
const days = (amount: number) => ({ mode: 'duration' as const, amount, unit: 'days' as const });

function need(ids: Record<string, string>, key: string): string {
  const id = ids[key];
  if (!id) throw new Error(`recipe email ${key} has no Dispatch`);
  return id;
}

export const FLOW_RECIPE_DEFS: Record<FlowRecipe, FlowRecipeDef> = {
  welcome: {
    key: 'welcome',
    name: 'Welcome email',
    description:
      'Greets every confirmed subscriber. Two versions are tested and the better one wins.',
    reentry: 'never',
    emails: [
      email(
        'welcome_a',
        'Welcome aboard',
        'Here is what to expect',
        'Thanks for subscribing. Here is what you will get and how often.',
        'Reply to this email any time: it reaches us directly.',
      ),
      email(
        'welcome_b',
        'You are in. Start here',
        'Three posts to read first',
        'Welcome! Before the next post arrives, here are three favourites from the archive.',
        'Reply and tell us what brought you here.',
      ),
    ],
    graph: (ids) => ({
      schema: FLOW_GRAPH_SCHEMA_VERSION,
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          name: 'Confirmed',
          config: { event: 'confirmed' },
          position: at(0, 0),
        },
        {
          id: 'split',
          type: 'ab_split',
          name: 'A/B test',
          config: {
            percentA: 50,
            autoPromote: { metric: 'opens', minPerVariant: 100, afterHours: 48 },
          },
          position: at(0, 120),
        },
        {
          id: 'welcome_a',
          type: 'send_email',
          name: 'Welcome A',
          config: { dispatchId: need(ids, 'welcome_a'), audience: 'any' },
          position: at(-160, 240),
        },
        {
          id: 'welcome_b',
          type: 'send_email',
          name: 'Welcome B',
          config: { dispatchId: need(ids, 'welcome_b'), audience: 'any' },
          position: at(160, 240),
        },
      ],
      edges: [
        { from: 'trigger', to: 'split', label: 'default' },
        { from: 'split', to: 'welcome_a', label: 'a' },
        { from: 'split', to: 'welcome_b', label: 'b' },
      ],
    }),
  },

  welcome_series: {
    key: 'welcome_series',
    name: 'Welcome series',
    description: 'Three emails over the first week after a subscriber confirms.',
    reentry: 'never',
    emails: [
      email(
        'day0',
        'Welcome',
        'Glad you are here',
        'Welcome! Here is what this publication is about.',
      ),
      email(
        'day2',
        'Our most-read posts',
        'A place to start',
        'Here are the posts readers come back to most.',
      ),
      email(
        'day5',
        'What would you like more of?',
        'Tell us in one reply',
        'You have been with us for a few days. Reply and tell us what you would like to read.',
      ),
    ],
    graph: (ids) => ({
      schema: FLOW_GRAPH_SCHEMA_VERSION,
      nodes: [
        { id: 'trigger', type: 'trigger', config: { event: 'confirmed' }, position: at(0, 0) },
        {
          id: 'day0',
          type: 'send_email',
          config: { dispatchId: need(ids, 'day0'), audience: 'any' },
          position: at(0, 120),
        },
        { id: 'wait2', type: 'delay', config: days(2), position: at(0, 240) },
        {
          id: 'day2',
          type: 'send_email',
          config: { dispatchId: need(ids, 'day2'), audience: 'any' },
          position: at(0, 360),
        },
        { id: 'wait3', type: 'delay', config: days(3), position: at(0, 480) },
        {
          id: 'day5',
          type: 'send_email',
          config: { dispatchId: need(ids, 'day5'), audience: 'any' },
          position: at(0, 600),
        },
      ],
      edges: [
        { from: 'trigger', to: 'day0', label: 'default' },
        { from: 'day0', to: 'wait2', label: 'default' },
        { from: 'wait2', to: 'day2', label: 'default' },
        { from: 'day2', to: 'wait3', label: 'default' },
        { from: 'wait3', to: 'day5', label: 'default' },
      ],
    }),
  },

  reengagement: {
    key: 'reengagement',
    name: 'Re-engagement',
    description: 'Checks in with subscribers who have not opened anything for 60 days.',
    reentry: 'after_exit',
    emails: [
      email(
        'checkin',
        'Still want these emails?',
        'One click keeps you on the list',
        'We have not seen you open a post in a while. If you still want them, open this one and you are all set.',
      ),
      email(
        'last_call',
        'Should we stop writing?',
        'Last check-in',
        'This is our last check-in. If these posts are not for you any more, the unsubscribe link is below.',
      ),
    ],
    graph: (ids) => ({
      schema: FLOW_GRAPH_SCHEMA_VERSION,
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          config: { event: 'unengaged', days: 60 },
          position: at(0, 0),
        },
        {
          id: 'checkin',
          type: 'send_email',
          config: { dispatchId: need(ids, 'checkin'), audience: 'any' },
          position: at(0, 120),
        },
        {
          id: 'wait_open',
          type: 'wait_for_event',
          config: { event: 'open', sendNodeId: 'checkin', timeoutHours: 168 },
          position: at(0, 240),
        },
        {
          id: 'last_call',
          type: 'send_email',
          config: { dispatchId: need(ids, 'last_call'), audience: 'any' },
          position: at(160, 360),
        },
      ],
      edges: [
        { from: 'trigger', to: 'checkin', label: 'default' },
        { from: 'checkin', to: 'wait_open', label: 'default' },
        { from: 'wait_open', to: 'last_call', label: 'timeout' },
      ],
    }),
  },

  paid_upsell: {
    key: 'paid_upsell',
    name: 'Paid upsell',
    description: 'Invites free subscribers to a paid plan a week after they confirm.',
    reentry: 'never',
    emails: [
      email(
        'invite',
        'Get every post in full',
        'Become a paid subscriber',
        'You have been reading for a week. Paid subscribers get every post in full and the whole archive.',
      ),
      email(
        'reminder',
        'A reminder about paid subscriptions',
        'Support the work',
        'Paid subscriptions keep this publication independent. Join whenever it suits you.',
      ),
    ],
    graph: (ids) => ({
      schema: FLOW_GRAPH_SCHEMA_VERSION,
      nodes: [
        { id: 'trigger', type: 'trigger', config: { event: 'confirmed' }, position: at(0, 0) },
        { id: 'wait7', type: 'delay', config: days(7), position: at(0, 120) },
        {
          id: 'invite',
          type: 'send_email',
          config: { dispatchId: need(ids, 'invite'), audience: 'free' },
          position: at(0, 240),
        },
        { id: 'wait4', type: 'delay', config: days(4), position: at(0, 360) },
        {
          id: 'reminder',
          type: 'send_email',
          config: { dispatchId: need(ids, 'reminder'), audience: 'free' },
          position: at(0, 480),
        },
      ],
      edges: [
        { from: 'trigger', to: 'wait7', label: 'default' },
        { from: 'wait7', to: 'invite', label: 'default' },
        { from: 'invite', to: 'wait4', label: 'default' },
        { from: 'wait4', to: 'reminder', label: 'default' },
      ],
    }),
  },

  trial_nurture: {
    key: 'trial_nurture',
    name: 'Trial nurture',
    description: 'Helps new paid subscribers get the most out of their first days.',
    reentry: 'after_exit',
    emails: [
      email(
        'start',
        'Your paid subscription has started',
        'What you can read now',
        'Thank you for joining. Everything in the archive is open to you now.',
      ),
      email(
        'tips',
        'Three things paid subscribers love',
        'Make the most of it',
        'Here are three things paid subscribers tell us they enjoy most.',
      ),
    ],
    graph: (ids) => ({
      schema: FLOW_GRAPH_SCHEMA_VERSION,
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          config: { event: 'level_purchased' },
          position: at(0, 0),
        },
        {
          id: 'start',
          type: 'send_email',
          config: { dispatchId: need(ids, 'start'), audience: 'paid' },
          position: at(0, 120),
        },
        { id: 'wait3', type: 'delay', config: days(3), position: at(0, 240) },
        {
          id: 'tips',
          type: 'send_email',
          config: { dispatchId: need(ids, 'tips'), audience: 'paid' },
          position: at(0, 360),
        },
      ],
      edges: [
        { from: 'trigger', to: 'start', label: 'default' },
        { from: 'start', to: 'wait3', label: 'default' },
        { from: 'wait3', to: 'tips', label: 'default' },
      ],
    }),
  },

  win_back: {
    key: 'win_back',
    name: 'Win back',
    description: 'Reaches out after a paid subscription ends.',
    reentry: 'after_exit',
    emails: [
      email(
        'sorry',
        'Sorry to see you go',
        'You are still on the free list',
        'Your paid subscription has ended. You will keep getting free posts.',
      ),
      email(
        'return',
        'Come back any time',
        'Your place is waiting',
        'A lot has happened since you left. A paid subscription is one click away whenever you want it.',
      ),
    ],
    graph: (ids) => ({
      schema: FLOW_GRAPH_SCHEMA_VERSION,
      nodes: [
        { id: 'trigger', type: 'trigger', config: { event: 'level_canceled' }, position: at(0, 0) },
        { id: 'wait1', type: 'delay', config: days(1), position: at(0, 120) },
        {
          id: 'sorry',
          type: 'send_email',
          config: { dispatchId: need(ids, 'sorry'), audience: 'free' },
          position: at(0, 240),
        },
        { id: 'wait14', type: 'delay', config: days(14), position: at(0, 360) },
        {
          id: 'return',
          type: 'send_email',
          config: { dispatchId: need(ids, 'return'), audience: 'free' },
          position: at(0, 480),
        },
      ],
      edges: [
        { from: 'trigger', to: 'wait1', label: 'default' },
        { from: 'wait1', to: 'sorry', label: 'default' },
        { from: 'sorry', to: 'wait14', label: 'default' },
        { from: 'wait14', to: 'return', label: 'default' },
      ],
    }),
  },
};
