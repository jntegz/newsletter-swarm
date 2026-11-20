/**
 * The linked snippet block: `{ type: 'snippet', attrs: { snippetId } }`, named as the renderers in
 * @swarm/mail know it. It stands for a saved snippet, shown here read-only: the server puts the
 * snippet's current content in its place when it renders. It sits in the `topBlock` group, which
 * only the document accepts, so it can't end up inside a list, a quote or a Smart Block.
 */
import { snippetBlocks } from '@swarm/mail/snippets';
import type { DispatchDocument } from '@swarm/domain';
import { useQuery } from '@tanstack/react-query';
import { Node, mergeAttributes, type Editor, type JSONContent } from '@tiptap/core';
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  type ReactNodeViewProps,
} from '@tiptap/react';
import { createContext, useContext } from 'react';
import { ApiError, api } from '../api/client';
import { dispatchExtensions } from './extensions';

export const SNIPPET = 'snippet';

interface SnippetUsage {
  posts: number;
  sentPosts: number;
  flowEmails: number;
  pages: number;
  templates: number;
}

export interface SnippetDetail {
  id: string;
  name: string;
  content: DispatchDocument;
  updatedAt: string;
  usage: SnippetUsage;
}

export const snippetQuery = (channelId: string, snippetId: string) => ({
  queryKey: ['snippets', channelId, snippetId],
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api.get<SnippetDetail>(`/api/v1/channels/${channelId}/snippets/${snippetId}`, signal),
  retry: false,
});

const some = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;

/** "Used in 3 posts (2 already sent) and 1 website page." */
export function usageSentence(usage: SnippetUsage): string {
  const posts = some(usage.posts, 'post');
  const parts = [
    usage.sentPosts ? `${posts} (${usage.sentPosts.toLocaleString('en-US')} already sent)` : posts,
  ];
  if (usage.flowEmails) parts.push(some(usage.flowEmails, 'automation email'));
  if (usage.pages) parts.push(some(usage.pages, 'website page'));
  if (usage.templates) parts.push(some(usage.templates, 'template'));
  const last = parts.pop();
  return `Used in ${parts.length ? `${parts.join(', ')} and ${last}` : last}.`;
}

interface SnippetEditorValue {
  channelId: string;
  /** Opens the dialog that changes a snippet. */
  editSnippet: (snippetId: string) => void;
}

export const SnippetEditorContext = createContext<SnippetEditorValue | null>(null);

/** Inserts a linked snippet after the top-level block holding the cursor. */
export function insertSnippet(editor: Editor, snippetId: string) {
  const { $from } = editor.state.selection;
  const at = $from.depth === 0 ? $from.pos : $from.after(1);
  editor.chain().focus().insertContentAt(at, { type: SNIPPET, attrs: { snippetId } }).run();
}

/** The snippet's content, read-only, exactly as the post editor would draw it. */
function SnippetContent({ content }: { content: DispatchDocument }) {
  const editor = useEditor({
    extensions: dispatchExtensions(),
    content,
    editable: false,
    immediatelyRender: false,
    // Read-only, and not a place to type: the post's body is the only textbox here.
    editorProps: {
      attributes: { class: 'dispatch-prose', role: 'group', 'aria-label': 'Snippet content' },
    },
  });
  return <EditorContent editor={editor} />;
}

function SnippetView({ node, editor, getPos, selected }: ReactNodeViewProps) {
  const context = useContext(SnippetEditorContext);
  const snippetId = String(node.attrs.snippetId ?? '');
  const channelId = context?.channelId ?? '';
  const detail = useQuery({
    ...snippetQuery(channelId, snippetId),
    enabled: !!channelId && !!snippetId,
  });
  const gone = detail.error instanceof ApiError && detail.error.code === 'not_found';

  /** Puts these blocks where the snippet block is; nothing removes it. */
  const replaceWith = (blocks: unknown[]) => {
    const from = getPos();
    if (typeof from !== 'number') return;
    const range = { from, to: from + node.nodeSize };
    if (blocks.length) {
      editor
        .chain()
        .focus()
        .insertContentAt(range, blocks as JSONContent[])
        .run();
    } else editor.chain().focus().deleteRange(range).run();
  };

  return (
    <NodeViewWrapper
      className={`editor-snippet ${selected ? 'is-selected' : ''}`}
      data-snippet=""
      contentEditable={false}
    >
      <div className="editor-smart-block-head">
        <span className="editor-smart-block-tag">Snippet</span>
        <span className="min-w-0 flex-1 font-semibold">
          {detail.data?.name ?? (gone ? 'Deleted snippet' : 'Loading the snippet…')}
        </span>
        {editor.isEditable && detail.data && (
          <>
            <button
              type="button"
              className="editor-smart-block-edit"
              onClick={() => context?.editSnippet(snippetId)}
            >
              Edit snippet
            </button>
            <button
              type="button"
              className="editor-smart-block-edit"
              onClick={() =>
                replaceWith(snippetBlocks(detail.data.content, node.attrs.showOn as unknown))
              }
            >
              Detach
            </button>
          </>
        )}
        {editor.isEditable && gone && (
          <button type="button" className="editor-smart-block-edit" onClick={() => replaceWith([])}>
            Remove block
          </button>
        )}
      </div>
      {detail.data && (
        <div className="editor-snippet-body">
          <SnippetContent key={detail.data.updatedAt} content={detail.data.content} />
        </div>
      )}
      {gone && (
        <p className="editor-snippet-note text-warn">
          This snippet was deleted, so this block shows nothing in emails or on your website.
        </p>
      )}
      {detail.isError && !gone && (
        <p className="editor-snippet-note text-warn">
          The snippet can’t be shown right now: {detail.error.message}
        </p>
      )}
    </NodeViewWrapper>
  );
}

export const SnippetNode = Node.create({
  name: SNIPPET,
  group: 'topBlock',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      snippetId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-snippet-id'),
        renderHTML: (a) => (a.snippetId ? { 'data-snippet-id': a.snippetId } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-snippet]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-snippet': '' }), 'Snippet'];
  },
  addNodeView() {
    return ReactNodeViewRenderer(SnippetView);
  },
});
