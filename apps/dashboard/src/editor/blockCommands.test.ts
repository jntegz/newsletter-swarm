import { getSchema } from '@tiptap/core';
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';
import {
  SHOW_ON_BLOCKS,
  cursorAfterInsertedBlock,
  dropGap,
  liftNestedShowOn,
  moveBlockBy,
  moveBlockTo,
  readShowOn,
  setBlockShowOn,
  showOnDecorations,
  typeAfterSelectedBlock,
} from './blockCommands';
import { dispatchExtensions } from './extensions';

const schema = getSchema(dispatchExtensions());
const para = (value: string, showOn?: string) => ({
  type: 'paragraph',
  ...(showOn ? { attrs: { showOn } } : {}),
  content: [{ type: 'text', text: value }],
});
const stateOf = (...content: unknown[]) =>
  EditorState.create({ schema, doc: schema.nodeFromJSON({ type: 'doc', content }) });
const texts = (state: EditorState) => {
  const out: string[] = [];
  state.doc.forEach((node) => out.push(node.textContent || node.type.name));
  return out;
};

describe('moving a top-level block', () => {
  const abc = () => stateOf(para('a'), para('b'), para('c'));

  it('moves a block up and down one place', () => {
    const state = abc();
    expect(texts(state.apply(moveBlockBy(state, 1, -1)!))).toEqual(['b', 'a', 'c']);
    expect(texts(state.apply(moveBlockBy(state, 1, 1)!))).toEqual(['a', 'c', 'b']);
  });

  it('does nothing at the ends, or into its own place', () => {
    const state = abc();
    expect(moveBlockBy(state, 0, -1)).toBeNull();
    expect(moveBlockBy(state, 2, 1)).toBeNull();
    expect(moveBlockTo(state, 1, 1)).toBeNull();
    expect(moveBlockTo(state, 1, 2)).toBeNull();
    expect(moveBlockTo(stateOf(para('only')), 0, 1)).toBeNull();
  });

  it('moves a block to any gap', () => {
    const state = abc();
    expect(texts(state.apply(moveBlockTo(state, 0, 3)!))).toEqual(['b', 'c', 'a']);
    expect(texts(state.apply(moveBlockTo(state, 2, 0)!))).toEqual(['c', 'a', 'b']);
  });

  it('moves any kind of block, the paywall break included, and keeps its setting', () => {
    const state = stateOf(
      para('a'),
      { type: 'gate' },
      { type: 'horizontalRule', attrs: { showOn: 'web' } },
      { type: 'blockquote', content: [para('q')] },
    );
    const gate = state.apply(moveBlockBy(state, 1, -1)!);
    expect(gate.doc.child(0).type.name).toBe('gate');
    const rule = state.apply(moveBlockTo(state, 2, 0)!);
    expect(rule.doc.child(0).type.name).toBe('horizontalRule');
    expect(rule.doc.child(0).attrs.showOn).toBe('web');
  });

  it('takes the cursor along inside the block', () => {
    const state = abc();
    // Inside "b": after the block "a" (3) and the opening of "b" (1).
    const at = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 4)));
    const moved = at.apply(moveBlockBy(at, 1, -1)!);
    expect(moved.selection.$from.parent.textContent).toBe('b');
    expect(moved.selection.$from.parentOffset).toBe(0);
  });

  it('keeps a selected atom selected', () => {
    const state = stateOf(para('a'), { type: 'horizontalRule' });
    const picked = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, 3)));
    const moved = picked.apply(moveBlockBy(picked, 1, -1)!);
    expect(moved.selection).toBeInstanceOf(NodeSelection);
    expect(moved.selection.from).toBe(0);
  });
});

describe('dropGap', () => {
  it('picks the gap from the middles of the blocks', () => {
    expect(dropGap([10, 30, 50], 5)).toBe(0);
    expect(dropGap([10, 30, 50], 20)).toBe(1);
    expect(dropGap([10, 30, 50], 45)).toBe(2);
    expect(dropGap([10, 30, 50], 90)).toBe(3);
  });
});

describe('where a block shows', () => {
  it('leaves documents without the setting at the default', () => {
    const state = stateOf(para('a'));
    expect(state.doc.child(0).attrs.showOn).toBeNull();
    expect(showOnDecorations(state.doc).find()).toEqual([]);
  });

  it('is an attribute of every top-level kind of block that exists', () => {
    for (const name of SHOW_ON_BLOCKS) {
      expect(schema.nodes[name]).toBeDefined();
      expect(Object.keys(schema.nodes[name]?.spec.attrs ?? {})).toContain('showOn');
    }
    expect(Object.keys(schema.nodes.gate?.spec.attrs ?? {})).not.toContain('showOn');
    expect(Object.keys(schema.nodes.listItem?.spec.attrs ?? {})).not.toContain('showOn');
    expect(Object.keys(schema.nodes.column?.spec.attrs ?? {})).not.toContain('showOn');
  });

  it('reads anything unknown as the default', () => {
    expect(readShowOn('email')).toBe('email');
    expect(readShowOn('web')).toBe('web');
    expect(readShowOn('both')).toBeNull();
    expect(readShowOn(null)).toBeNull();
    expect(readShowOn(1)).toBeNull();
  });

  it('sets and clears it, and labels the block', () => {
    const state = stateOf(para('a'), para('b'));
    const set = state.apply(setBlockShowOn(state, 1, 'email')!);
    expect(set.doc.child(1).attrs.showOn).toBe('email');
    expect(set.doc.toJSON().content[1].attrs.showOn).toBe('email');
    expect(
      showOnDecorations(set.doc)
        .find()
        .map((d) => d.from),
    ).toEqual([3]);
    const cleared = set.apply(setBlockShowOn(set, 1, null)!);
    expect(cleared.doc.child(1).attrs.showOn).toBeNull();
  });

  it('refuses it on the paywall break', () => {
    expect(setBlockShowOn(stateOf(para('a'), { type: 'gate' }), 1, 'web')).toBeNull();
  });

  it('hands a nested setting to the top-level block, so a wrapped block stays kept', () => {
    const state = stateOf({
      type: 'blockquote',
      content: [para('kept', 'email'), para('other')],
    });
    const lifted = state.apply(liftNestedShowOn(state)!);
    const quote = lifted.doc.child(0);
    expect(quote.attrs.showOn).toBe('email');
    expect(quote.child(0).attrs.showOn).toBeNull();
    expect(liftNestedShowOn(lifted)).toBeNull();
  });

  it('keeps the outer setting if the outer block already has one', () => {
    const state = stateOf({
      type: 'blockquote',
      attrs: { showOn: 'web' },
      content: [para('kept', 'email')],
    });
    const lifted = state.apply(liftNestedShowOn(state)!);
    expect(lifted.doc.child(0).attrs.showOn).toBe('web');
    expect(lifted.doc.child(0).child(0).attrs.showOn).toBeNull();
  });
});

describe('typing while a whole block is selected', () => {
  const select = (state: EditorState, pos: number) =>
    state.apply(state.tr.setSelection(NodeSelection.create(state.doc, pos)));

  it('writes into the empty line after the block and keeps the block', () => {
    // "a" takes 3 positions, so the paywall break sits at 3.
    const state = select(stateOf(para('a'), { type: 'gate' }, { type: 'paragraph' }), 3);
    const typed = state.apply(typeAfterSelectedBlock(state, 'x')!);
    expect(texts(typed)).toEqual(['a', 'gate', 'x']);
    expect(typed.selection.$from.parent.textContent).toBe('x');
    expect(typed.selection.$from.parentOffset).toBe(1);
  });

  it('adds a line when the next one has text, or there is none', () => {
    const before = select(stateOf(para('a'), { type: 'gate' }, para('b')), 3);
    expect(texts(before.apply(typeAfterSelectedBlock(before, 'x')!))).toEqual([
      'a',
      'gate',
      'x',
      'b',
    ]);
    const last = select(stateOf(para('a'), { type: 'horizontalRule' }), 3);
    expect(texts(last.apply(typeAfterSelectedBlock(last, 'x')!))).toEqual([
      'a',
      'horizontalRule',
      'x',
    ]);
  });

  it('leaves ordinary typing alone', () => {
    const state = stateOf(para('a'));
    expect(typeAfterSelectedBlock(state, 'x')).toBeNull();
  });
});

describe('the cursor after a block is inserted', () => {
  /** Inserts a paywall break after "a" and selects it, as the editor's insert does. */
  const insertSelected = (state: EditorState) => {
    const tr = state.tr.insert(3, schema.nodes.gate!.create());
    tr.setSelection(NodeSelection.create(tr.doc, 3));
    return { tr, next: state.apply(tr) };
  };

  it('moves into the line after the block', () => {
    const state = stateOf(para('a'), { type: 'paragraph' });
    const { tr, next } = insertSelected(state);
    const moved = next.apply(cursorAfterInsertedBlock([tr], state, next)!);
    expect(texts(moved)).toEqual(['a', 'gate', 'paragraph']);
    expect(moved.selection).toBeInstanceOf(TextSelection);
    expect(moved.selection.$from.index(0)).toBe(2);
  });

  it('adds a line when the block is the last thing in the post', () => {
    const state = stateOf(para('a'));
    const { tr, next } = insertSelected(state);
    const moved = next.apply(cursorAfterInsertedBlock([tr], state, next)!);
    expect(texts(moved)).toEqual(['a', 'gate', 'paragraph']);
    expect(moved.selection.$from.index(0)).toBe(2);
  });

  it('leaves a block alone that was picked, changed or moved while selected', () => {
    const state = stateOf(para('a'), { type: 'gate' }, para('b'));
    const pick = state.tr.setSelection(NodeSelection.create(state.doc, 3));
    const picked = state.apply(pick);
    expect(cursorAfterInsertedBlock([pick], state, picked)).toBeNull();
    const move = moveBlockBy(picked, 1, 1)!;
    expect(cursorAfterInsertedBlock([move], picked, picked.apply(move))).toBeNull();
    // A cursor inside a paragraph that is moved stays a cursor.
    const text = stateOf(para('a'), para('b'));
    const moveText = moveBlockBy(text, 0, 1)!;
    expect(cursorAfterInsertedBlock([moveText], text, text.apply(moveText))).toBeNull();
  });
});
