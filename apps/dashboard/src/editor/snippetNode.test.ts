import { getSchema } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { canChooseShowOn } from './blockCommands';
import { dispatchExtensions } from './extensions';
import { SNIPPET, usageSentence } from './snippetNode';

const usage = { posts: 0, sentPosts: 0, flowEmails: 0, pages: 0, templates: 0 };

describe('usageSentence', () => {
  it('says how many posts use it, in words', () => {
    expect(usageSentence(usage)).toBe('Used in 0 posts.');
    expect(usageSentence({ ...usage, posts: 1 })).toBe('Used in 1 post.');
    expect(usageSentence({ ...usage, posts: 3, sentPosts: 2 })).toBe(
      'Used in 3 posts (2 already sent).',
    );
    expect(usageSentence({ posts: 3, sentPosts: 0, flowEmails: 1, pages: 2, templates: 1 })).toBe(
      'Used in 3 posts, 1 automation email, 2 website pages and 1 template.',
    );
  });
});

describe('the snippet block in the editor', () => {
  const nested = (schema: ReturnType<typeof getSchema>) =>
    schema.nodes.blockquote!.contentMatch.matchType(schema.nodes[SNIPPET]!);

  it('sits between the blocks of a post and of a website page, never inside one', () => {
    for (const schema of [
      getSchema(dispatchExtensions()),
      getSchema(dispatchExtensions({ gate: false })),
    ]) {
      expect(schema.topNodeType.contentMatch.matchType(schema.nodes[SNIPPET]!)).toBeTruthy();
      expect(nested(schema)).toBeFalsy();
    }
  });

  it('opens a stored document that links to a snippet, and can be set to one surface', () => {
    const schema = getSchema(dispatchExtensions());
    const node = schema.nodeFromJSON({
      type: 'doc',
      content: [{ type: 'snippet', attrs: { snippetId: 'sn_a', showOn: 'web' } }],
    });
    expect(node.child(0).attrs.snippetId).toBe('sn_a');
    expect(node.child(0).attrs.showOn).toBe('web');
    expect(canChooseShowOn(node.child(0))).toBe(true);
    expect(node.toJSON()).toEqual({
      type: 'doc',
      content: [{ type: 'snippet', attrs: { snippetId: 'sn_a', showOn: 'web' } }],
    });
  });
});
