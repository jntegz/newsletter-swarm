/**
 * What the post editor adds around top-level blocks, all without a new dependency:
 * - `attrs.showOn`, a node attribute on every kind of block: null shows it in the email and on the
 *   website, 'email' or 'web' keeps it to one. The renderers in @swarm/mail act on it, and refuse
 *   any other value. Older documents have no such attribute and read as null.
 * - A small label above each block kept to one place, drawn as a decoration so it works for every
 *   kind of block, including images, rules and React node views.
 * - Moving a whole top-level block, by Alt + arrow keys here and by the handle in ./BlockControls.
 * - A block inserted from the menu (an image, button or paywall break) leaves the cursor after it,
 *   and typing while a whole block is selected writes on the line after it. Neither the next
 *   keystroke nor the next insert replaces the block.
 *
 * Only top-level blocks choose where they show. A kept block that ends up inside another (wrapped
 * in a list or a quote) hands its setting to the outer block, so its text never starts showing on
 * the other surface without the writer seeing a label change.
 */
import { Extension } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import {
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

type ShowOn = 'email' | 'web' | null;

export const SHOW_ON_CHOICES: { value: ShowOn; label: string }[] = [
  { value: null, label: 'Email and website' },
  { value: 'email', label: 'Email only' },
  { value: 'web', label: 'Website only' },
];

/** Blocks that can choose. The paywall break is left out: it has to cut both surfaces. */
export const SHOW_ON_BLOCKS = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'image',
  'button',
  'linkCard',
  'attachment',
  'htmlBlock',
  'callout',
  'columns',
  'embed',
  'smartBlock',
  'askPoll',
  'tableOfContents',
  'snippet',
];

/** Anything that isn't one of the two settings reads as the default. */
export const readShowOn = (value: unknown): ShowOn =>
  value === 'email' || value === 'web' ? value : null;

export const canChooseShowOn = (node: PmNode) => SHOW_ON_BLOCKS.includes(node.type.name);

/** Where a top-level block starts in the document. */
export function blockPos(doc: PmNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos;
}

/** The transaction's mark on a block move, for whoever announces it. */
export const BLOCK_MOVED = 'blockMoved';

/**
 * Moves top-level block `from` into gap `gap` (0 is before the first block, childCount after the
 * last). Returns null when that leaves it where it is. A cursor inside the block moves with it.
 */
export function moveBlockTo(state: EditorState, from: number, gap: number): Transaction | null {
  const { doc, selection } = state;
  if (from < 0 || from >= doc.childCount || gap < 0 || gap > doc.childCount) return null;
  if (gap === from || gap === from + 1) return null;
  const node = doc.child(from);
  const start = blockPos(doc, from);
  const end = start + node.nodeSize;
  const target = gap > from ? blockPos(doc, gap) - node.nodeSize : blockPos(doc, gap);
  const tr = state.tr.delete(start, end).insert(target, node);
  if (selection.from >= start && selection.to <= end) {
    const shift = target - start;
    tr.setSelection(
      selection instanceof NodeSelection
        ? NodeSelection.create(tr.doc, selection.from + shift)
        : selection instanceof TextSelection
          ? TextSelection.create(tr.doc, selection.anchor + shift, selection.head + shift)
          : Selection.near(tr.doc.resolve(target + 1)),
    );
  }
  return tr.setMeta(BLOCK_MOVED, { to: gap > from ? gap - 1 : gap }).scrollIntoView();
}

/** One place up (-1) or down (1). */
export const moveBlockBy = (state: EditorState, index: number, step: -1 | 1) =>
  moveBlockTo(state, index, step === -1 ? index - 1 : index + 2);

/** The gap a drop at height `y` lands in, given each block's vertical middle, top to bottom. */
export function dropGap(middles: number[], y: number): number {
  const at = middles.findIndex((middle) => y < middle);
  return at === -1 ? middles.length : at;
}

/**
 * Text typed while a whole block is selected goes on the line after the block: into the empty line
 * that follows it, or into a new paragraph. Without this the keystroke replaces the block, and a
 * block inserted from the menu stays selected. Null when the selection is not a whole block.
 */
export function typeAfterSelectedBlock(state: EditorState, text: string): Transaction | null {
  const { selection, schema } = state;
  if (!(selection instanceof NodeSelection) || !selection.node.isBlock) return null;
  const paragraph = schema.nodes.paragraph;
  const after = selection.to;
  const parent = selection.$to.parent;
  const next = parent.maybeChild(selection.$to.index());
  const tr = state.tr;
  if (next?.isTextblock && next.content.size === 0) {
    tr.insertText(text, after + 1);
  } else {
    if (
      !paragraph ||
      !parent.canReplaceWith(selection.$to.index(), selection.$to.index(), paragraph)
    )
      return null;
    tr.insert(after, paragraph.create(null, schema.text(text)));
  }
  return tr.setSelection(TextSelection.create(tr.doc, after + 1 + text.length)).scrollIntoView();
}

/**
 * After a change that leaves a whole block selected where none was before (an image, button or
 * paywall break inserted from the menu), moves the cursor to the text after the block, adding a
 * line when there is none. A selected block is replaced by whatever is inserted next, so leaving
 * it selected loses it. Null when there is nothing to move: a block that was already selected, or
 * one moved or dropped on purpose.
 */
export function cursorAfterInsertedBlock(
  transactions: readonly Transaction[],
  old: EditorState,
  state: EditorState,
): Transaction | null {
  const { selection, schema } = state;
  if (!(selection instanceof NodeSelection) || !selection.node.isBlock) return null;
  if (old.selection instanceof NodeSelection) return null;
  if (!transactions.some((tr) => tr.docChanged)) return null;
  if (transactions.some((tr) => tr.getMeta(BLOCK_MOVED) || tr.getMeta('uiEvent') === 'drop')) {
    return null;
  }
  const tr = state.tr;
  const next = Selection.findFrom(state.doc.resolve(selection.to), 1, true);
  if (next) return tr.setSelection(next);
  const paragraph = schema.nodes.paragraph;
  const index = selection.$to.index();
  if (!paragraph || !selection.$to.parent.canReplaceWith(index, index, paragraph)) return null;
  tr.insert(selection.to, paragraph.create());
  return tr.setSelection(TextSelection.create(tr.doc, selection.to + 1));
}

/** Sets where the top-level block at `index` shows. Null when it can't choose. */
export function setBlockShowOn(
  state: EditorState,
  index: number,
  showOn: ShowOn,
): Transaction | null {
  if (index < 0 || index >= state.doc.childCount) return null;
  if (!canChooseShowOn(state.doc.child(index))) return null;
  return state.tr.setNodeAttribute(blockPos(state.doc, index), 'showOn', showOn);
}

/** Clears the setting from nested blocks, keeping it on their top-level block. Null if none. */
export function liftNestedShowOn(state: EditorState): Transaction | null {
  const tr = state.tr;
  state.doc.forEach((top, offset) => {
    let lifted: ShowOn = readShowOn(top.attrs.showOn);
    top.descendants((node, pos) => {
      const nested = readShowOn(node.attrs.showOn);
      if (!nested) return;
      tr.setNodeAttribute(offset + 1 + pos, 'showOn', null);
      lifted ??= nested;
    });
    if (lifted !== readShowOn(top.attrs.showOn) && canChooseShowOn(top)) {
      tr.setNodeAttribute(offset, 'showOn', lifted);
    }
  });
  return tr.docChanged ? tr : null;
}

/** A label before each top-level block kept to one place. */
export function showOnDecorations(doc: PmNode): DecorationSet {
  const labels: Decoration[] = [];
  doc.forEach((node, offset) => {
    const showOn = readShowOn(node.attrs.showOn);
    if (!showOn) return;
    const label = SHOW_ON_CHOICES.find((choice) => choice.value === showOn)?.label ?? '';
    labels.push(
      Decoration.widget(
        offset,
        () => {
          const dom = document.createElement('span');
          dom.className = 'editor-show-on';
          dom.contentEditable = 'false';
          dom.textContent = label;
          return dom;
        },
        { side: -1, key: `show-on-${showOn}-${offset}`, stopEvent: () => true },
      ),
    );
  });
  return labels.length ? DecorationSet.create(doc, labels) : DecorationSet.empty;
}

const showOnKey = new PluginKey('blockVisibility');

export const BlockVisibility = Extension.create({
  name: 'blockVisibility',
  addGlobalAttributes() {
    return [
      {
        types: SHOW_ON_BLOCKS,
        attributes: {
          showOn: {
            default: null,
            parseHTML: (el) => readShowOn(el.getAttribute('data-show-on')),
            renderHTML: (attrs) => (attrs.showOn ? { 'data-show-on': attrs.showOn } : {}),
          },
        },
      },
    ];
  },
  addKeyboardShortcuts() {
    const move = (step: -1 | 1) => () => {
      if (!this.editor.isEditable) return false;
      const { state, view } = this.editor;
      const tr = moveBlockBy(state, state.selection.$from.index(0), step);
      if (tr) view.dispatch(tr);
      // Handled either way, so the first block doesn't move the cursor instead.
      return true;
    };
    return { 'Alt-ArrowUp': move(-1), 'Alt-ArrowDown': move(1) };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: showOnKey,
        appendTransaction: (transactions, _old, state) =>
          transactions.some((tr) => tr.docChanged) ? liftNestedShowOn(state) : null,
        props: { decorations: (state) => showOnDecorations(state.doc) },
      }),
      new Plugin({
        key: new PluginKey('typeAfterBlock'),
        appendTransaction: cursorAfterInsertedBlock,
        props: {
          handleTextInput: (view, _from, _to, text) => {
            const tr = typeAfterSelectedBlock(view.state, text);
            if (tr) view.dispatch(tr);
            return !!tr;
          },
        },
      }),
    ];
  },
});
