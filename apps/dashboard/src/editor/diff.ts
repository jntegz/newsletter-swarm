/**
 * Revision comparison: flattens a Dispatch document into one line per block, then diffs the lines.
 * Good enough for prose; it compares what a reader sees, not the document structure.
 */

interface DocNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
}

const inlineText = (node: DocNode): string =>
  node.type === 'text'
    ? (node.text ?? '')
    : node.type === 'hardBreak'
      ? ' '
      : (node.content ?? []).map(inlineText).join('');

const attr = (node: DocNode, key: string) => String(node.attrs?.[key] ?? '');

function blockLines(node: DocNode, prefix = ''): string[] {
  switch (node.type) {
    case 'heading':
      return [`${'#'.repeat(Number(node.attrs?.level) || 2)} ${inlineText(node)}`];
    case 'paragraph': {
      const text = inlineText(node);
      return text.trim() ? [prefix + text] : [];
    }
    case 'bulletList':
    case 'orderedList':
      return (node.content ?? []).flatMap((item, index) =>
        (item.content ?? []).flatMap((child) =>
          blockLines(child, node.type === 'orderedList' ? `${index + 1}. ` : '• '),
        ),
      );
    case 'blockquote':
      return (node.content ?? []).flatMap((child) => blockLines(child, '> '));
    case 'codeBlock':
      return inlineText(node).split('\n');
    case 'horizontalRule':
      return ['———'];
    case 'image':
      return [`[Image: ${attr(node, 'alt') || 'no alt text'}]`];
    case 'button':
      return [`[Button: ${attr(node, 'label')} → ${attr(node, 'href')}]`];
    case 'linkCard':
      return [`[Link card: ${attr(node, 'title') || attr(node, 'href')}]`];
    case 'attachment':
      return [`[File: ${attr(node, 'name')}]`];
    case 'gate':
      return ['[Paywall break]'];
    case 'htmlBlock':
      return attr(node, 'html')
        .split('\n')
        .map((line) => `[HTML] ${line}`);
    default:
      return (node.content ?? []).flatMap((child) => blockLines(child, prefix));
  }
}

export function documentLines(doc: unknown): string[] {
  return blockLines((doc ?? {}) as DocNode);
}

type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string };

/** Line diff by longest common subsequence. Inputs are capped so a huge paste can't hang the tab. */
export function diffLines(before: string[], after: string[], cap = 2000): DiffLine[] {
  const a = before.slice(0, cap);
  const b = after.slice(0, cap);
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: 'removed', text: a[i++]! });
    } else {
      out.push({ kind: 'added', text: b[j++]! });
    }
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++]! });
  while (j < b.length) out.push({ kind: 'added', text: b[j++]! });
  return out;
}
