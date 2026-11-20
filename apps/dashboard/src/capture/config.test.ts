import type { MemberField } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import {
  addableProfileFields,
  defaultConfig,
  describeChanges,
  effectiveAccent,
  issueAt,
  moveField,
  normaliseOrigin,
  triggerOfType,
  validateConfig,
  type Config,
} from './config';

const def = (key: string, type: MemberField['type'], options: string[] = []): MemberField => ({
  id: `mf_${'0'.repeat(32)}`,
  channelId: `ch_${'0'.repeat(32)}`,
  key,
  label: key,
  type,
  options,
  encrypted: false,
  position: 0,
  createdAt: '2026-10-27T12:00:00.000Z',
});

const withConfig = (patch: Partial<Config>): Config => ({ ...defaultConfig(), ...patch });

describe('validateConfig', () => {
  it('accepts the default form', () => {
    expect(validateConfig(defaultConfig())).toEqual([]);
  });

  it('requires the email field exactly once, and required', () => {
    const noEmail = withConfig({ fields: [{ key: 'first_name', label: 'Name', required: false }] });
    expect(issueAt(validateConfig(noEmail), 'fields')).toBe('Include the email field once.');
    const optional = withConfig({ fields: [{ key: 'email', label: 'Email', required: false }] });
    expect(issueAt(validateConfig(optional), 'fields')).toBe('The email field is required.');
  });

  it('rejects duplicate fields and empty labels', () => {
    const config = withConfig({
      fields: [
        { key: 'email', label: 'Email', required: true },
        { key: 'first_name', label: ' ', required: false },
        { key: 'first_name', label: 'Name', required: false },
      ],
    });
    const issues = validateConfig(config);
    expect(issueAt(issues, 'fields')).toBe('Use each field once.');
    expect(issueAt(issues, 'fields.1.label')).toBe('Label the field.');
  });

  it('limits the success message to 80 characters and needs https redirects', () => {
    const long = withConfig({ success: { type: 'message', message: 'x'.repeat(81) } });
    expect(issueAt(validateConfig(long), 'success.message')).toMatch(/80 characters/);
    const exact = withConfig({ success: { type: 'message', message: 'x'.repeat(80) } });
    expect(validateConfig(exact)).toEqual([]);
    const http = withConfig({ success: { type: 'redirect', url: 'http://example.com/thanks' } });
    expect(issueAt(validateConfig(http), 'success.url')).toBe('Use a full https:// address.');
    const https = withConfig({ success: { type: 'redirect', url: 'https://example.com/thanks' } });
    expect(validateConfig(https)).toEqual([]);
  });

  it('checks trigger parameters', () => {
    const cases: [Config['trigger'], string][] = [
      [{ type: 'delay', seconds: 0 }, 'trigger.seconds'],
      [{ type: 'delay', seconds: 1.5 }, 'trigger.seconds'],
      [{ type: 'scroll', percent: 101 }, 'trigger.percent'],
      [{ type: 'click', selector: '  ' }, 'trigger.selector'],
      [{ type: 'element_visible', selector: 'x'.repeat(201) }, 'trigger.selector'],
      [{ type: 'event', name: 'has space' }, 'trigger.name'],
    ];
    for (const [trigger, path] of cases) {
      expect(issueAt(validateConfig(withConfig({ trigger })), path)).toBeDefined();
    }
    expect(validateConfig(withConfig({ trigger: { type: 'event', name: 'swarm:open' } }))).toEqual(
      [],
    );
  });

  it('checks frequency days, accent colour, origins and copy', () => {
    const issues = validateConfig(
      withConfig({
        frequency: { type: 'once_per_days', days: 366 },
        theme: { accentColor: 'purple', mode: 'auto' },
        allowedOrigins: ['ftp://example.com'],
        copy: { heading: '', body: '', button: ' ' },
      }),
    );
    expect(issues.map((i) => i.path).sort()).toEqual([
      'allowedOrigins.0',
      'copy.button',
      'frequency.days',
      'theme.accentColor',
    ]);
  });
});

describe('normaliseOrigin', () => {
  it('keeps https origins and local development only', () => {
    expect(normaliseOrigin('https://example.com/path?q=1')).toBe('https://example.com');
    expect(normaliseOrigin(' https://Example.com:8443 ')).toBe('https://example.com:8443');
    expect(normaliseOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(normaliseOrigin('http://example.com')).toBeNull();
    expect(normaliseOrigin('example.com')).toBeNull();
    expect(normaliseOrigin('')).toBeNull();
  });
});

describe('fields', () => {
  it('lists profile fields not yet on the form', () => {
    const defs = [def('company', 'text'), def('topics', 'multi_select', ['a'])];
    const config = withConfig({
      fields: [
        { key: 'email', label: 'Email', required: true },
        { key: 'field:company', label: 'Company', required: false },
      ],
    });
    expect(addableProfileFields(config, defs).map((d) => d.key)).toEqual(['topics']);
  });

  it('moves fields within bounds', () => {
    const fields = defaultConfig().fields.concat({
      key: 'first_name',
      label: 'N',
      required: false,
    });
    expect(moveField(fields, 1, -1).map((f) => f.key)).toEqual(['first_name', 'email']);
    expect(moveField(fields, 1, 1)).toBe(fields);
  });
});

describe('triggerOfType', () => {
  it('starts with sensible parameters and keeps a selector across selector triggers', () => {
    expect(triggerOfType('delay')).toEqual({ type: 'delay', seconds: 5 });
    expect(triggerOfType('click', { type: 'element_visible', selector: '#end' })).toEqual({
      type: 'click',
      selector: '#end',
    });
    expect(triggerOfType('exit_intent', { type: 'delay', seconds: 3 })).toEqual({
      type: 'exit_intent',
    });
  });
});

describe('describeChanges', () => {
  it('describes the whole form before the first publish', () => {
    expect(describeChanges(null, defaultConfig())[0]).toBe('Fields: Email (required)');
  });

  it('lists only what differs from the live version', () => {
    const live = defaultConfig();
    const next = withConfig({
      placement: 'popup',
      trigger: { type: 'scroll', percent: 60 },
      allowedOrigins: ['https://example.com'],
    });
    expect(describeChanges(live, next)).toEqual([
      'Placement: Inline → Popup',
      'Trigger: As soon as the page loads → After scrolling 60% of the page',
      'Allowed sites: Any site → https://example.com',
    ]);
    expect(describeChanges(live, defaultConfig())).toEqual([]);
  });
});

describe('effectiveAccent', () => {
  it('falls back from the form to the Channel to indigo', () => {
    const own = withConfig({ theme: { accentColor: '#112233', mode: 'auto' } });
    expect(effectiveAccent(own, '#445566')).toBe('#112233');
    expect(effectiveAccent(defaultConfig(), '#445566')).toBe('#445566');
    expect(effectiveAccent(defaultConfig(), null)).toBe('#6c4cf1');
  });
});
