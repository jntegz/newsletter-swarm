import { describe, expect, it } from 'vitest';
import { canSubmit, canWithdraw, documentText, parseManifestText } from './app-directory-helpers';

describe('documentText', () => {
  it('reads every block a recipe email can hold, with link addresses', () => {
    expect(
      documentText({
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Hello' }] },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Read ' },
              {
                type: 'text',
                text: 'this',
                marks: [{ type: 'link', attrs: { href: 'https://a.example/p' } }],
              },
            ],
          },
          { type: 'paragraph' },
          { type: 'button', attrs: { label: 'Join', href: 'https://a.example/join' } },
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One' }] }],
              },
            ],
          },
          { type: 'horizontalRule' },
        ],
      }),
    ).toEqual([
      'Hello',
      'Read this [https://a.example/p]',
      '[Button: Join → https://a.example/join]',
      '• One',
      '---',
    ]);
  });
});

describe('parseManifestText', () => {
  it('reads an object and explains anything else', () => {
    expect(parseManifestText('{"manifestVersion":1}')).toEqual({
      manifest: { manifestVersion: 1 },
    });
    expect(parseManifestText('')).toHaveProperty('error');
    expect(parseManifestText('[1]')).toEqual({ error: 'A manifest is a JSON object.' });
    expect(parseManifestText('{nope')).toEqual({ error: 'This is not valid JSON.' });
  });
});

describe('status actions', () => {
  it('matches the server’s lifecycle', () => {
    expect(['draft', 'rejected', 'delisted'].every((s) => canSubmit(s as never))).toBe(true);
    expect(canSubmit('submitted')).toBe(false);
    expect(canWithdraw('approved')).toBe(true);
    expect(canWithdraw('draft')).toBe(false);
  });
});
