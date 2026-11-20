import { describe, expect, it } from 'vitest';
import {
  FlowGraphSchema,
  InboxRulesSchema,
  NO_INBOX_RULES,
  defaultSendRegardless,
  inboxRulesActive,
  inboxRulesFromSettings,
  isSendRegardless,
} from '../src';

const dispatch = (n: number) => `dp_${String(n).padStart(32, '0')}`;

describe('inbox rule settings', () => {
  it('are all off for a publication that never set them', () => {
    for (const settings of [
      {},
      null,
      undefined,
      { inboxRules: 'nonsense' },
      { doubleOptIn: true },
    ]) {
      const rules = inboxRulesFromSettings(settings);
      expect(rules).toEqual(NO_INBOX_RULES);
      expect(inboxRulesActive(rules)).toBe(false);
    }
  });

  it('default the wait to 14 days and fill in what is left out', () => {
    expect(InboxRulesSchema.parse({})).toEqual(NO_INBOX_RULES);
    expect(NO_INBOX_RULES.maxHoldDays).toBe(14);
  });

  it('count as on when any one rule is on', () => {
    for (const on of [
      { perDay: 1 },
      { perWeek: 1 },
      { quietHours: { start: '22:00', end: '08:00' } },
      { newsletterDay: { hoursAround: 0 } },
    ]) {
      expect(inboxRulesActive(InboxRulesSchema.parse(on))).toBe(true);
    }
  });

  it('refuse values that make no sense', () => {
    for (const bad of [
      { perDay: 0 },
      { perWeek: -1 },
      { quietHours: { start: '08:00', end: '08:00' } },
      { quietHours: { start: '25:00', end: '08:00' } },
      { newsletterDay: { hoursAround: 100 } },
      { maxHoldDays: 0 },
      { maxHoldDays: 91 },
    ]) {
      expect(InboxRulesSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('send regardless', () => {
  const graph = (event: string, extra: object = {}) =>
    FlowGraphSchema.parse({
      schema: 1,
      nodes: [
        { id: 'trigger', type: 'trigger', config: { event, ...extra } },
        { id: 'first', type: 'send_email', config: { dispatchId: dispatch(1) } },
        { id: 'wait', type: 'delay', config: { mode: 'duration', amount: 1, unit: 'days' } },
        { id: 'second', type: 'send_email', config: { dispatchId: dispatch(2) } },
      ],
      edges: [
        { from: 'trigger', to: 'first' },
        { from: 'first', to: 'wait' },
        { from: 'wait', to: 'second' },
      ],
    });

  it('starts on for the first email after someone confirms or joins, and only that one', () => {
    for (const g of [graph('confirmed'), graph('member_joined', { includeImports: false })]) {
      expect(defaultSendRegardless(g, 'first')).toBe(true);
      expect(defaultSendRegardless(g, 'second')).toBe(false);
    }
  });

  it('starts off for every other trigger', () => {
    const g = graph('api_event', { name: 'go' });
    expect(defaultSendRegardless(g, 'first')).toBe(false);
  });

  it('starts on for each arm of a welcome test', () => {
    const g = FlowGraphSchema.parse({
      schema: 1,
      nodes: [
        { id: 'trigger', type: 'trigger', config: { event: 'confirmed' } },
        { id: 'split', type: 'ab_split', config: { percentA: 50 } },
        { id: 'a', type: 'send_email', config: { dispatchId: dispatch(1) } },
        { id: 'b', type: 'send_email', config: { dispatchId: dispatch(2) } },
      ],
      edges: [
        { from: 'trigger', to: 'split' },
        { from: 'split', to: 'a', label: 'a' },
        { from: 'split', to: 'b', label: 'b' },
      ],
    });
    expect(defaultSendRegardless(g, 'a')).toBe(true);
    expect(defaultSendRegardless(g, 'b')).toBe(true);
  });

  it('needs every start event to be someone confirming or joining', () => {
    const withStarts = (config: Record<string, unknown>) => ({
      nodes: [
        { id: 'trigger', type: 'trigger', config },
        { id: 'first', type: 'send_email', config: { dispatchId: dispatch(1) } },
      ],
      edges: [{ from: 'trigger', to: 'first' }],
    });
    expect(
      defaultSendRegardless(
        withStarts({ event: 'confirmed', alsoStartOn: [{ event: 'member_joined' }] }),
        'first',
      ),
    ).toBe(true);
    expect(
      defaultSendRegardless(
        withStarts({ event: 'confirmed', alsoStartOn: [{ event: 'tag_added', tagId: 'x' }] }),
        'first',
      ),
    ).toBe(false);
    expect(
      defaultSendRegardless(
        withStarts({ event: 'tag_added', tagId: 'x', alsoStartOn: [{ event: 'confirmed' }] }),
        'first',
      ),
    ).toBe(false);
  });

  it('follows what the writer marked over the default', () => {
    const g = graph('confirmed');
    const first = { id: 'first', config: {} };
    expect(isSendRegardless(g, first)).toBe(true);
    expect(isSendRegardless(g, { ...first, config: { sendRegardless: false } })).toBe(false);
    expect(isSendRegardless(g, { id: 'second', config: { sendRegardless: true } })).toBe(true);
  });

  it('survives the graph schema', () => {
    const parsed = FlowGraphSchema.parse({
      schema: 1,
      nodes: [
        { id: 'trigger', type: 'trigger', config: { event: 'confirmed' } },
        {
          id: 'mail',
          type: 'send_email',
          config: { dispatchId: dispatch(1), sendRegardless: false },
        },
      ],
      edges: [{ from: 'trigger', to: 'mail' }],
    });
    const mail = parsed.nodes.find((n) => n.id === 'mail');
    expect(mail?.type === 'send_email' && mail.config.sendRegardless).toBe(false);
  });
});
