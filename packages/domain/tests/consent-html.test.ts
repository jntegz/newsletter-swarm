import { describe, expect, it } from 'vitest';
import {
  CaptureFormConfigSchema,
  consentHtml,
  consentHtmlProblem,
  defaultCaptureFormConfig,
} from '../src';

const inner = (text: string) => consentHtml(text).replace(/^<span>|<\/span>$/g, '');

describe('consentHtml', () => {
  it('opens every link in a new window, whatever the writer typed', () => {
    expect(inner('Read the <a href="https://example.com/p?a=1&amp;b=2">policy</a>.')).toBe(
      'Read the <a href="https://example.com/p?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">policy</a>.',
    );
    expect(inner(`<a target="_self" onclick="x()" href='https://example.com'>x</a>`)).toBe(
      '<a href="https://example.com/" target="_blank" rel="noopener noreferrer">x</a>',
    );
  });

  it('keeps the allowed formatting', () => {
    expect(inner('<b>a</b><strong>b</strong><i>c</i><em>d</em><br><br/><br />')).toBe(
      '<b>a</b><strong>b</strong><i>c</i><em>d</em><br><br><br>',
    );
  });

  it.each([
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<b onclick="alert(1)">x</b>',
    '<a href="javascript:alert(1)">x</a>',
    '<a href=" JaVaScRiPt:alert(1)">x</a>',
    '<a href="java&#115;cript:alert(1)">x</a>',
    '<a href="data:text/html,<script>alert(1)</script>">x</a>',
    '<a href="https://example.com" <script>x</a>',
    '<svg/onload=alert(1)>',
    '<form action="https://evil.example"><input name="email"></form>',
    '<iframe src="https://evil.example"></iframe>',
    '<a href="https://example.com"><a href="https://evil.example">x</a></a>',
    '</span></label><script>alert(1)</script>',
  ])('makes %s harmless, and says it is wrong', (text) => {
    const html = inner(text);
    expect(html).not.toMatch(/<(?!\/?(?:a|b|strong|i|em|br)\b)[a-z/!]/i);
    expect(html).not.toMatch(/<(?:b|i|em|strong)\s/i);
    expect(html).not.toMatch(/href="(?!https:\/\/)/i);
    expect(consentHtmlProblem(text)).not.toBeNull();
  });

  it('never leaves a tag open or closes one it did not open', () => {
    expect(inner('<a href="https://example.com">open')).toBe(
      '<a href="https://example.com/" target="_blank" rel="noopener noreferrer">open</a>',
    );
    expect(inner('<b>one<i>two</b>')).toBe('<b>one<i>two&lt;/b&gt;</i></b>');
    expect(consentHtmlProblem('<b>open')).toMatch(/closing tag/);
  });

  it('leaves plain text as it always was', () => {
    for (const text of ['I agree to emails.', 'Fish & chips < 5 > 3', 'I <3 "this"']) {
      expect(consentHtmlProblem(text)).toBeNull();
    }
    expect(inner('Fish & chips <3')).toBe('Fish &amp; chips &lt;3');
  });
});

describe('a form saved before links were allowed', () => {
  it('still loads, so its stored text can only be shown as text', () => {
    const config = CaptureFormConfigSchema.parse({
      ...defaultCaptureFormConfig(),
      consent: { text: 'Old <script>text</script>', required: true },
    });
    expect(consentHtml(config.consent!.text)).toContain('&lt;script&gt;');
  });
});
