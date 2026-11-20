import type { MemberField } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { defaultConfig, type Config } from './config';
import { buildPreviewHtml, type PreviewInput } from './preview';

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

const html = (patch: Partial<Config>, input: Partial<PreviewInput> = {}) =>
  buildPreviewHtml({
    config: { ...defaultConfig(), ...patch },
    defs: [],
    accent: '#6c4cf1',
    state: 'form',
    ...input,
  });

describe('buildPreviewHtml', () => {
  it('never contains scripts and escapes every operator string', () => {
    const out = html({
      copy: { heading: '<script>alert(1)</script>', body: '"quoted" & <b>', button: '<img>' },
      fields: [
        { key: 'email', label: '<i>Email</i>', placeholder: '" onfocus="x', required: true },
      ],
    });
    expect(out).not.toMatch(/<script/i);
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).toContain('&quot;quoted&quot; &amp; &lt;b&gt;');
    expect(out).toContain('placeholder="&quot; onfocus=&quot;x"');
    expect(out).not.toContain('<i>Email</i>');
  });

  it('draws inline forms in the page and a placeholder before the trigger', () => {
    expect(html({})).toContain('max-width:480px');
    expect(html({ layout: 'slim' })).toContain('max-width:720px');
    expect(html({}, { state: 'hidden' })).toContain(
      'The form appears here when its trigger fires.',
    );
  });

  it('draws each overlay placement like the loader does', () => {
    expect(html({ placement: 'popup' })).toContain('class="wrap popup" role="dialog"');
    expect(html({ placement: 'slide_in_left' })).toContain('class="wrap slide" style="left:16px"');
    expect(html({ placement: 'slide_in_right' })).toContain('style="right:16px"');
    expect(html({ placement: 'sticky_top' })).toContain('class="wrap sticky" style="top:0"');
    expect(html({ placement: 'sticky_bottom' })).toContain('style="bottom:0"');
    expect(html({ placement: 'popup' }, { state: 'hidden' })).not.toContain('class="wrap');
  });

  it('renders profile fields by type: radios, checkboxes, dropdowns', () => {
    const out = html(
      {
        fields: [
          { key: 'email', label: 'Email', required: true },
          { key: 'field:plan', label: 'Plan', required: true, display: 'radio' },
          { key: 'field:topics', label: 'Topics', required: false },
          { key: 'field:size', label: 'Size', required: false, display: 'dropdown' },
        ],
      },
      {
        defs: [
          def('plan', 'select', ['Free', 'Team']),
          def('topics', 'multi_select', ['News', 'Essays']),
          def('size', 'select', ['S', 'M']),
        ],
      },
    );
    expect(out).toContain('<legend>Plan</legend>');
    expect(out).toContain('type="radio" name="f.plan" value="Team" required');
    expect(out).toContain('type="checkbox" name="f.topics" value="Essays"');
    expect(out).toContain('<select name="f.size"');
  });

  it('shows the success message, or where the visitor is sent, and hides the form', () => {
    const message = html({}, { state: 'success' });
    expect(message).toContain('Check your inbox to confirm.');
    expect(message).not.toContain('<form>');
    const redirect = html(
      { success: { type: 'redirect', url: 'https://example.com/thanks' } },
      { state: 'success' },
    );
    expect(redirect).toContain('Sends the visitor to https://example.com/thanks');
  });

  it('uses only a valid accent colour', () => {
    expect(html({}, { accent: '#123abc' })).toContain('--accent:#123abc');
    expect(html({}, { accent: 'red;}body{display:none' })).toContain('--accent:#6c4cf1');
  });

  it('leaves out the heading on slim forms and marks the bot check', () => {
    const slim = html({ layout: 'slim' });
    expect(slim).not.toContain('<h2>');
    expect(slim).toContain('Bot check');
    expect(slim).not.toMatch(/turnstile|challenges\.cloudflare/i);
  });
});
