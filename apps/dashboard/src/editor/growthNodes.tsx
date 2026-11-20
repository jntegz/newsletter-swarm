/**
 * Phase 6 editor blocks, named as the renderers in @swarm/mail know them:
 * - `smartBlock` (flag smart_blocks): top-level wrapper whose content is shown only to Members
 *   matching its condition (a Circle rule). attrs { condition, label?, anonymous: hide | show }.
 * - `askPoll`: a one-tap poll, attrs { askId, questionId } of a choice question of this Channel.
 * Both sit in the `topBlock` group, which only the document accepts, so they can never end up
 * inside a list, a quote or each other. Their editor views are React components that read the
 * page's helpers (names, dialogs) from GrowthEditorContext.
 */
import type { CircleRule, SmartBlockAttrs } from '@swarm/domain';
import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import { Fragment, NodeRange } from '@tiptap/pm/model';
import { findWrapping } from '@tiptap/pm/transform';
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type ReactNodeViewProps,
} from '@tiptap/react';
import { useQuery } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { askQuery } from '../api/growth';

const SMART_BLOCK = 'smartBlock';
export const ASK_POLL = 'askPoll';

export interface GrowthEditorValue {
  /** A plain-language summary of a condition, with Circle and level names. */
  describe: (rule: CircleRule) => string;
  /** Opens the Smart Block dialog for the block at `pos`. */
  editSmartBlock?: (pos: number) => void;
  /** Opens the poll picker for the poll at `pos`. */
  editAskPoll?: (pos: number) => void;
}

export const GrowthEditorContext = createContext<GrowthEditorValue>({
  describe: () => 'a condition',
});

const jsonAttr = (name: string) => ({
  parseHTML: (el: HTMLElement) => {
    const raw = el.getAttribute(name);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  },
  renderHTML: (attrs: Record<string, unknown>) => {
    const key = name.replace(/^data-/, '');
    return attrs[key] ? { [name]: JSON.stringify(attrs[key]) } : {};
  },
});

function SmartBlockView({ node, editor, getPos }: ReactNodeViewProps) {
  const { describe, editSmartBlock } = useContext(GrowthEditorContext);
  const attrs = node.attrs as Partial<SmartBlockAttrs>;
  const condition = attrs.condition as CircleRule | null | undefined;
  return (
    <NodeViewWrapper className="editor-smart-block" data-smart-block="">
      <div contentEditable={false} className="editor-smart-block-head">
        <span className="editor-smart-block-tag">Smart block</span>
        <span className="min-w-0 flex-1">
          {attrs.label && <strong>{attrs.label}: </strong>}
          {condition ? `Shown to subscribers where ${describe(condition)}` : 'No condition yet'}
          {attrs.anonymous === 'show' ? '; shown on the web to everyone' : '; hidden on the web'}
        </span>
        {editor.isEditable && editSmartBlock && (
          <button
            type="button"
            className="editor-smart-block-edit"
            onClick={() => {
              const pos = getPos();
              if (typeof pos === 'number') editSmartBlock(pos);
            }}
          >
            Edit condition
          </button>
        )}
      </div>
      <NodeViewContent className="editor-smart-block-body" />
    </NodeViewWrapper>
  );
}

export const SmartBlockNode = Node.create({
  name: SMART_BLOCK,
  group: 'topBlock',
  content: 'block+',
  defining: true,
  isolating: true,
  draggable: true,
  addAttributes() {
    return {
      condition: { default: null, ...jsonAttr('data-condition') },
      label: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-label'),
        renderHTML: (a) => (a.label ? { 'data-label': a.label } : {}),
      },
      anonymous: {
        default: 'hide',
        parseHTML: (el) => (el.getAttribute('data-anonymous') === 'show' ? 'show' : 'hide'),
        renderHTML: (a) => ({ 'data-anonymous': a.anonymous }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-smart-block]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-smart-block': '' }), 0];
  },
  addNodeView() {
    return ReactNodeViewRenderer(SmartBlockView);
  },
});

function AskPollView({ node, editor, getPos, selected }: ReactNodeViewProps) {
  const { editAskPoll } = useContext(GrowthEditorContext);
  const askId = String(node.attrs.askId ?? '');
  const questionId = String(node.attrs.questionId ?? '');
  const ask = useQuery({ ...askQuery(askId), enabled: !!askId });
  const question = ask.data?.questions.find((q) => q.id === questionId);
  return (
    <NodeViewWrapper
      className={`editor-ask-poll ${selected ? 'is-selected' : ''}`}
      data-ask-poll=""
      contentEditable={false}
    >
      <div className="editor-smart-block-head">
        <span className="editor-smart-block-tag">Poll</span>
        <span className="min-w-0 flex-1">
          {ask.isPending && askId ? 'Loading the poll…' : (ask.data?.title ?? 'Poll not found')}
          {ask.data && ask.data.status !== 'open' && ` (${ask.data.status})`}
        </span>
        {editor.isEditable && editAskPoll && (
          <button
            type="button"
            className="editor-smart-block-edit"
            onClick={() => {
              const pos = getPos();
              if (typeof pos === 'number') editAskPoll(pos);
            }}
          >
            Change
          </button>
        )}
      </div>
      {question ? (
        <div className="editor-ask-poll-body">
          <p>{question.prompt}</p>
          <ul>
            {question.options.map((o) => (
              <li key={o.id}>{o.label}</li>
            ))}
          </ul>
        </div>
      ) : (
        ask.data && (
          <p className="editor-ask-poll-body">
            This question is no longer in the poll. Choose another.
          </p>
        )
      )}
    </NodeViewWrapper>
  );
}

export const AskPollNode = Node.create({
  name: ASK_POLL,
  group: 'topBlock',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      askId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-ask-id'),
        renderHTML: (a) => (a.askId ? { 'data-ask-id': a.askId } : {}),
      },
      questionId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-question-id'),
        renderHTML: (a) => (a.questionId ? { 'data-question-id': a.questionId } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-ask-poll]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-ask-poll': '' }), 'Poll'];
  },
  addNodeView() {
    return ReactNodeViewRenderer(AskPollView);
  },
});

// ---- Commands ------------------------------------------------------------------------------

/** The Smart Block holding the cursor, if any. */
export function currentSmartBlock(editor: Editor) {
  const { $from } = editor.state.selection;
  if ($from.depth === 0) {
    const node = editor.state.doc.nodeAt($from.pos);
    return node?.type.name === SMART_BLOCK ? { node, pos: $from.pos } : null;
  }
  const node = $from.node(1);
  return node.type.name === SMART_BLOCK ? { node, pos: $from.before(1) } : null;
}

/**
 * Wraps the top-level blocks the selection touches in a Smart Block. False when they can't go
 * inside one (a gate divider, a poll or another Smart Block among them).
 */
export function wrapInSmartBlock(editor: Editor, attrs: SmartBlockAttrs): boolean {
  const { state, view } = editor;
  const { $from, $to } = state.selection;
  const type = state.schema.nodes[SMART_BLOCK];
  if (!type) return false;
  const tr = state.tr;
  if ($from.depth === 0) {
    const paragraph = state.schema.nodes.paragraph?.create();
    if (!paragraph) return false;
    tr.insert($from.pos, type.create(attrs, Fragment.from(paragraph)));
    view.dispatch(tr);
    return true;
  }
  const start = state.doc.resolve($from.before(1));
  const end = state.doc.resolve($to.depth === 0 ? $to.pos : $to.after(1));
  const range = new NodeRange(start, end, 0);
  const wrapping = findWrapping(range, type, attrs);
  if (!wrapping) return false;
  tr.wrap(range, wrapping);
  view.dispatch(tr.scrollIntoView());
  editor.commands.focus();
  return true;
}

export function updateNodeAttrs(editor: Editor, pos: number, attrs: Record<string, unknown>) {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }));
}

/** Removes the Smart Block at `pos` and keeps its content in place. */
export function unwrapSmartBlock(editor: Editor, pos: number) {
  const node = editor.state.doc.nodeAt(pos);
  if (node?.type.name !== SMART_BLOCK) return;
  editor.view.dispatch(editor.state.tr.replaceWith(pos, pos + node.nodeSize, node.content));
  editor.commands.focus();
}

/** Inserts a poll after the top-level block holding the cursor. */
export function insertAskPoll(editor: Editor, attrs: { askId: string; questionId: string }) {
  const { $from } = editor.state.selection;
  const at = $from.depth === 0 ? $from.pos : $from.after(1);
  editor.chain().focus().insertContentAt(at, { type: ASK_POLL, attrs }).run();
}

/** Counts the document's top-level Smart Blocks. */
export function countSmartBlocks(editor: Editor): number {
  let count = 0;
  editor.state.doc.forEach((node) => {
    if (node.type.name === SMART_BLOCK) count += 1;
  });
  return count;
}
