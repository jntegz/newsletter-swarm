import { describe, expect, it } from 'vitest';
import {
  DispatchDocumentSchema,
  STARTER_TEMPLATES,
  STARTER_TEMPLATE_KEYS,
  StarterTemplateSummarySchema,
  starterTemplate,
  starterTemplateSummaries,
} from '../src/index';

/** Blocks every install can send: nothing behind a flag, no raw HTML, nothing from the library. */
const BLOCKS = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'horizontalRule',
  'button',
  'linkCard',
  'callout',
  'columns',
  'column',
  'text',
  'hardBreak',
]);

interface Node {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: Node[];
}

function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  for (const child of node.content ?? []) walk(child, visit);
}

const words = (starter: (typeof STARTER_TEMPLATES)[number]) => {
  const parts = [starter.name, starter.description, starter.subject, starter.preheader];
  walk(starter.content as unknown as Node, (node) => {
    if (node.text) parts.push(node.text);
    for (const key of ['label', 'title', 'description']) {
      if (typeof node.attrs?.[key] === 'string') parts.push(node.attrs[key]);
    }
  });
  return parts.join('\n');
};

describe('starter templates', () => {
  it('ships six to eight, each under its own key, in the listed order', () => {
    expect(STARTER_TEMPLATES.length).toBeGreaterThanOrEqual(6);
    expect(STARTER_TEMPLATES.length).toBeLessThanOrEqual(8);
    expect(STARTER_TEMPLATES.map((s) => s.key)).toEqual([...STARTER_TEMPLATE_KEYS]);
    expect(new Set(STARTER_TEMPLATES.map((s) => s.name)).size).toBe(STARTER_TEMPLATES.length);
  });

  it('gives each a name, a one-line description, a subject and preview text that fit a draft', () => {
    for (const summary of starterTemplateSummaries()) {
      expect(StarterTemplateSummarySchema.safeParse(summary).success, summary.key).toBe(true);
      expect(summary.name.length, summary.key).toBeLessThanOrEqual(40);
      expect(summary.description.length, summary.key).toBeGreaterThan(40);
      expect(summary.description.length, summary.key).toBeLessThanOrEqual(160);
      // An inbox shows about 60 characters of a subject and 100 of the preview text.
      expect(summary.subject.length, summary.key).toBeLessThanOrEqual(60);
      expect(summary.preheader.length, summary.key).toBeGreaterThan(30);
      expect(summary.preheader.length, summary.key).toBeLessThanOrEqual(100);
      expect(summary).not.toHaveProperty('content');
    }
  });

  it('writes real documents from blocks every install can send', () => {
    for (const starter of STARTER_TEMPLATES) {
      expect(DispatchDocumentSchema.safeParse(starter.content).success, starter.key).toBe(true);
      expect(starter.content.content.length, starter.key).toBeGreaterThanOrEqual(8);
      walk(starter.content as unknown as Node, (node) => {
        if (node.type !== 'doc')
          expect(BLOCKS.has(node.type), `${starter.key}: ${node.type}`).toBe(true);
        expect(node.attrs?.showOn, starter.key).toBeUndefined();
        if (node.type === 'paragraph' || node.type === 'heading') {
          expect(node.content?.length, `${starter.key}: an empty ${node.type}`).toBeGreaterThan(0);
        }
        if (node.type === 'columns') expect(node.content?.length).toBe(2);
      });
    }
  });

  it('links only to example.com, over https', () => {
    for (const starter of STARTER_TEMPLATES) {
      walk(starter.content as unknown as Node, (node) => {
        const hrefs = [
          node.attrs?.href,
          ...(node.marks ?? []).filter((m) => m.type === 'link').map((m) => m.attrs?.href),
        ].filter((href) => href !== undefined);
        for (const href of hrefs) {
          expect(String(href), starter.key).toMatch(/^https:\/\/example\.com\/[a-z0-9-]+$/);
        }
        if (node.type === 'button') expect(String(node.attrs?.label).trim()).not.toBe('');
      });
    }
  });

  it('is written copy: no filler text, no em dashes, no internal words, merge tags with fallbacks', () => {
    for (const starter of STARTER_TEMPLATES) {
      const copy = words(starter);
      expect(copy.split(/\s+/).length, starter.key).toBeGreaterThan(150);
      expect(copy, starter.key).not.toMatch(/lorem|ipsum|dolor sit/i);
      expect(copy, starter.key).not.toMatch(/[—–]/);
      expect(copy, starter.key).not.toMatch(
        /\b(Dispatch(es)?|Broadcasts?|Members?|Channels?|Capture Forms?|Flows?|Member Center)\b/,
      );
      for (const tag of copy.match(/\{\{[^}]*\}\}/g) ?? []) {
        expect(tag, starter.key).toMatch(/^\{\{ first_name \| \S[^}]* \}\}$/);
      }
    }
  });

  it('looks a starter up by key, and nothing else', () => {
    expect(starterTemplate('welcome')?.name).toBe('Welcome issue');
    expect(starterTemplate('nope')).toBeNull();
    expect(starterTemplate('constructor')).toBeNull();
  });
});
