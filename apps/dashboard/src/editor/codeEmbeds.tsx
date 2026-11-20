// Code embeds (flag code_embeds): syntax highlighting for code blocks, a language picker, and the
// table of contents block. Highlighting uses the tokenizer the email and site renderers use
// (@swarm/mail/highlight), so what the editor colours is what Members see. The editor only adds
// decorations: the document keeps plain text and a `language` attribute.
import { CODE_LANGUAGES, TOKEN_CLASS, normalizeLanguage, tokenize } from '@swarm/mail/highlight';
import { Extension, Node, mergeAttributes, type Editor } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditorState,
  type NodeViewProps,
} from '@tiptap/react';
import { useEffect } from 'react';
import { useChannelFlag } from '../api/queries';

/** The table of contents block's node name, as the renderers in @swarm/mail know it. */
export const TOC_NODE = 'tableOfContents';

const highlightKey = new PluginKey<DecorationSet>('codeHighlight');

interface HighlightStorage {
  enabled: boolean;
}

/** Inline decorations for every code block in `doc`, one per highlighted token. */
export function highlightDecorations(doc: PmNode): Decoration[] {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'codeBlock') return true;
    let at = pos + 1;
    for (const token of tokenize(node.textContent, node.attrs.language)) {
      const end = at + token.text.length;
      if (token.kind)
        decorations.push(Decoration.inline(at, end, { class: TOKEN_CLASS[token.kind] }));
      at = end;
    }
    return false;
  });
  return decorations;
}

/** Highlighting as decorations; off until setCodeHighlight turns it on for the Channel. */
export const CodeHighlight = Extension.create<object, HighlightStorage>({
  name: 'codeHighlight',
  addStorage() {
    return { enabled: false };
  },
  addProseMirrorPlugins() {
    const storage = this.storage;
    const build = (doc: PmNode) =>
      storage.enabled ? DecorationSet.create(doc, highlightDecorations(doc)) : DecorationSet.empty;
    return [
      new Plugin<DecorationSet>({
        key: highlightKey,
        state: {
          init: (_, state) => build(state.doc),
          apply: (tr, old) =>
            tr.docChanged || tr.getMeta(highlightKey) ? build(tr.doc) : old.map(tr.mapping, tr.doc),
        },
        props: {
          decorations: (state) => highlightKey.getState(state),
        },
      }),
    ];
  },
});

function highlightStorage(editor: Editor): HighlightStorage | undefined {
  return (editor.storage as unknown as Record<string, HighlightStorage | undefined>).codeHighlight;
}

/** Turns highlighting on or off in an editor and redraws it. */
function setCodeHighlight(editor: Editor, enabled: boolean): void {
  const storage = highlightStorage(editor);
  if (!storage || storage.enabled === enabled || editor.isDestroyed) return;
  storage.enabled = enabled;
  editor.view.dispatch(editor.state.tr.setMeta(highlightKey, true));
}

/** Whether code embeds are on for the Channel; keeps the editor's highlighting in step. */
export function useCodeEmbeds(editor: Editor | null, channelId: string): boolean {
  const on = useChannelFlag(channelId, 'code_embeds') === true;
  useEffect(() => {
    if (editor) setCodeHighlight(editor, on);
  }, [editor, on]);
  return on;
}

/** The top-level headings, as the table of contents lists them. */
export function documentHeadings(doc: PmNode): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  doc.forEach((node) => {
    if (node.type.name !== 'heading') return;
    const text = node.textContent.replace(/\s+/g, ' ').trim();
    if (text) out.push({ level: Number(node.attrs.level) || 2, text });
  });
  return out;
}

function TableOfContentsView({ editor, node }: NodeViewProps) {
  const headings = useEditorState({
    editor,
    selector: ({ editor: e }) => documentHeadings(e.state.doc),
    equalityFn: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });
  const title =
    typeof node.attrs.title === 'string' && node.attrs.title ? node.attrs.title : 'Contents';
  return (
    <NodeViewWrapper className="editor-toc" data-toc="">
      <div contentEditable={false}>
        <span className="editor-toc-tag">{title}</span>
        {headings.length ? (
          <ol>
            {headings.map((h, i) => (
              <li key={`${i}-${h.text}`} className={h.level === 3 ? 'editor-toc-sub' : undefined}>
                {h.text}
              </li>
            ))}
          </ol>
        ) : (
          <p className="editor-toc-empty">Add headings and they are listed here.</p>
        )}
      </div>
    </NodeViewWrapper>
  );
}

/**
 * The table of contents: between top-level blocks only. It lists the top-level headings; on the
 * website they are links to anchors, in email a plain list. Always in the schema, so a document
 * that has one still opens when the flag is later turned off.
 */
export const TableOfContentsNode = Node.create({
  name: TOC_NODE,
  group: 'topBlock',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      title: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-title'),
        renderHTML: (a) => (a.title ? { 'data-title': a.title } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-toc]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-toc': '' }), 'Contents'];
  },
  addNodeView() {
    return ReactNodeViewRenderer(TableOfContentsView);
  },
});

/** Inserts a table of contents between top-level blocks, before the block holding the cursor. */
function insertTableOfContents(editor: Editor): void {
  const { $from } = editor.state.selection;
  const at = $from.depth === 0 ? $from.pos : $from.before(1);
  editor.chain().focus().insertContentAt(at, { type: TOC_NODE }).run();
}

/** Toolbar tools: a code block, its language, and the table of contents (Dispatches only). */
export function CodeTools({ editor, contents }: { editor: Editor; contents: boolean }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      inCode: e.isActive('codeBlock'),
      language: normalizeLanguage(e.getAttributes('codeBlock').language) ?? '',
      hasToc: (() => {
        let found = false;
        e.state.doc.forEach((node) => {
          if (node.type.name === TOC_NODE) found = true;
        });
        return found;
      })(),
    }),
  });
  const button = (active: boolean) =>
    `grid h-8 min-w-8 place-items-center rounded-[8px] px-1.5 text-[13px] font-semibold disabled:opacity-40 ${
      active ? 'bg-lavender text-purple-deep' : 'text-sub hover:bg-surface-alt hover:text-ink'
    }`;
  return (
    <>
      <button
        type="button"
        aria-label="Code block"
        title="Code block"
        aria-pressed={state.inCode}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        className={button(state.inCode)}
      >
        {'{ }'}
      </button>
      {state.inCode && (
        <select
          aria-label="Code language"
          value={state.language}
          onChange={(e) =>
            editor
              .chain()
              .focus()
              .updateAttributes('codeBlock', { language: e.target.value || null })
              .run()
          }
          className="h-8 rounded-[8px] border border-line-app bg-surface px-2 text-[12.5px] text-ink"
        >
          <option value="">Plain text</option>
          {CODE_LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
      )}
      {contents && (
        <button
          type="button"
          aria-label={state.hasToc ? 'Table of contents added' : 'Add a table of contents'}
          title={state.hasToc ? 'Table of contents added' : 'Add a table of contents'}
          disabled={state.hasToc}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => insertTableOfContents(editor)}
          className={button(false)}
        >
          Contents
        </button>
      )}
    </>
  );
}
