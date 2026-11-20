/**
 * Linked snippets: `{ type: 'snippet', attrs: { snippetId, showOn? } }`, a top-level block that
 * stands for a saved snippet of the same Channel. No renderer reads the table: whoever holds a
 * database replaces the block with the snippet's blocks first (expandSnippets), and the renderers
 * see an ordinary document, with everything that depends on the top-level blocks (the gate, the
 * table of contents, footnotes, media and poll lookups, the free share of a post) working as usual.
 *
 * A block that is still there when a renderer reaches it points at a snippet that is gone: it
 * renders nothing and says so in the warnings.
 *
 * A send expands once, when it starts, and freezes the result, so a sent email never changes. The
 * website expands on every render.
 *
 * No imports: the dashboard uses this file too.
 */
export const SNIPPET_NODE = 'snippet';

/** How many snippet blocks one document may use; the API refuses more, and renderers skip them. */
export const MAX_SNIPPET_BLOCKS = 50;

/** The largest snippet the API accepts, as stored. */
export const MAX_SNIPPET_BYTES = 128 * 1024;

export const SNIPPET_GONE_WARNING = 'A snippet in this post was deleted, so it is left out.';

/** Blocks that change how the whole post behaves, so a snippet can't carry them. */
const NOT_IN_A_SNIPPET: Record<string, string> = {
  [SNIPPET_NODE]: 'A snippet can’t hold another snippet.',
  gate: 'A snippet can’t hold a paywall break.',
  smartBlock: 'A snippet can’t hold a Smart block.',
};

type Block = { type?: unknown; attrs?: Record<string, unknown>; content?: unknown };

/** What a document's snippets resolve to: a saved document, or null when it is gone. */
type SnippetLookup = (snippetId: string) => unknown;

const blocksOf = (document: unknown): Block[] => {
  const content = (document as { content?: unknown } | null)?.content;
  return Array.isArray(content) ? (content as Block[]) : [];
};

const isSnippetBlock = (node: Block | null | undefined) => node?.type === SNIPPET_NODE;

const snippetIdOf = (node: Block): string | null => {
  const id = node.attrs?.snippetId;
  return typeof id === 'string' && id && id.length <= 64 ? id : null;
};

/** Cheap test on a stored document, so a post without snippets costs no parse and no query. */
export const mayUseSnippets = (json: string) => json.includes(`"type":"${SNIPPET_NODE}"`);

/** How many snippet blocks sit at the top level of a document. */
export const countSnippetBlocks = (document: unknown) =>
  blocksOf(document).filter(isSnippetBlock).length;

/** The distinct snippets a document's top-level blocks point at. */
export function snippetIdsOf(document: unknown): string[] {
  const ids = new Set<string>();
  for (const node of blocksOf(document).filter(isSnippetBlock).slice(0, MAX_SNIPPET_BLOCKS)) {
    const id = snippetIdOf(node);
    if (id) ids.add(id);
  }
  return [...ids];
}

/** Why this content can't be a snippet, at any depth; null when it can. */
export function snippetContentProblem(node: unknown, depth = 0): string | null {
  if (depth > 30 || typeof node !== 'object' || node === null) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const problem = snippetContentProblem(child, depth + 1);
      if (problem) return problem;
    }
    return null;
  }
  const { type, content } = node as Block;
  if (typeof type === 'string' && Object.hasOwn(NOT_IN_A_SNIPPET, type)) {
    return NOT_IN_A_SNIPPET[type]!;
  }
  return snippetContentProblem(content, depth + 1);
}

const isSurface = (value: unknown) => value === 'email' || value === 'web';

/**
 * A snippet's block inside a snippet block with this `showOn`: a block shows only where both allow
 * it, so kept to the other surface it shows nowhere (null). A value that is neither stays on the
 * block, for the renderer to refuse.
 */
function withShowOn(block: Block, showOn: unknown): Block | null {
  if (showOn === undefined || showOn === null) return block;
  const own = block?.attrs?.showOn;
  if (own === undefined || own === null || !isSurface(showOn)) {
    return { ...block, attrs: { ...block?.attrs, showOn } };
  }
  return !isSurface(own) || own === showOn ? block : null;
}

/**
 * The blocks a snippet adds to a document, or a detached copy of them. Blocks a snippet can't carry
 * are left out: a snippet saved before they were refused can't change a post's paywall or its
 * Smart Blocks.
 */
export function snippetBlocks(document: unknown, showOn?: unknown): unknown[] {
  const out: unknown[] = [];
  for (const block of blocksOf(document)) {
    if (typeof block?.type === 'string' && Object.hasOwn(NOT_IN_A_SNIPPET, block.type)) continue;
    const shown = withShowOn(block, showOn);
    if (shown) out.push(shown);
  }
  return out;
}

/**
 * The document with its snippet blocks replaced by the snippets' blocks. A block whose snippet is
 * gone, or past the limit, stays for the renderer to warn about; `dropMissing` removes it, for a
 * reader's page, where it must not count as one of the post's blocks. A document without snippet
 * blocks comes back as it is, the same object.
 */
export function expandSnippets<T>(
  document: T,
  lookup: SnippetLookup,
  { dropMissing = false }: { dropMissing?: boolean } = {},
): T {
  const nodes = blocksOf(document);
  if (!nodes.some(isSnippetBlock)) return document;
  const content: unknown[] = [];
  let used = 0;
  for (const node of nodes) {
    if (!isSnippetBlock(node)) {
      content.push(node);
      continue;
    }
    used += 1;
    const id = snippetIdOf(node);
    const saved = id && used <= MAX_SNIPPET_BLOCKS ? lookup(id) : null;
    if (saved) content.push(...snippetBlocks(saved, node.attrs?.showOn));
    else if (!dropMissing) content.push(node);
  }
  return { ...document, content };
}
