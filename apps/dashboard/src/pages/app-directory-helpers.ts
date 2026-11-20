// Pure helpers for the App Directory pages: status copy, the text of a recipe email for the
// review screen, and reading a pasted or uploaded manifest.
import type { DispatchDocument, ReviewStatus } from '@swarm/domain';

export const STATUS_LABEL: Record<ReviewStatus, string> = {
  draft: 'Draft',
  submitted: 'In review',
  approved: 'Listed',
  rejected: 'Not approved',
  delisted: 'Delisted',
};

export const STATUS_TONE: Record<ReviewStatus, 'neutral' | 'scheduled' | 'success' | 'danger'> = {
  draft: 'neutral',
  submitted: 'scheduled',
  approved: 'success',
  rejected: 'danger',
  delisted: 'neutral',
};

export const canSubmit = (status: ReviewStatus) =>
  status === 'draft' || status === 'rejected' || status === 'delisted';
export const canWithdraw = (status: ReviewStatus) =>
  status === 'submitted' || status === 'approved';

type Node = { type?: unknown; text?: unknown; content?: unknown; attrs?: Record<string, unknown> };

/**
 * The readable text of a document, one entry per block, with link and button addresses shown
 * in brackets, so a reviewer reads everything a recipe would put in an email.
 */
export function documentText(doc: DispatchDocument): string[] {
  const lines: string[] = [];
  const inline = (nodes: unknown): string =>
    Array.isArray(nodes)
      ? (nodes as Node[])
          .map((n) => {
            if (n.type === 'hardBreak') return '\n';
            if (typeof n.text !== 'string') return '';
            const link = Array.isArray((n as { marks?: unknown }).marks)
              ? ((n as { marks: Node[] }).marks.find((m) => m.type === 'link')?.attrs?.href as
                  string | undefined)
              : undefined;
            return link ? `${n.text} [${link}]` : n.text;
          })
          .join('')
      : '';
  const walk = (nodes: unknown, prefix: string) => {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes as Node[]) {
      switch (n.type) {
        case 'paragraph':
        case 'heading': {
          const text = inline(n.content);
          if (text.trim()) lines.push(`${prefix}${text}`);
          break;
        }
        case 'button':
          lines.push(
            `${prefix}[Button: ${String(n.attrs?.label ?? '')} → ${String(n.attrs?.href ?? '')}]`,
          );
          break;
        case 'horizontalRule':
          lines.push('---');
          break;
        case 'bulletList':
        case 'orderedList':
          walk(n.content, `${prefix}• `);
          break;
        case 'blockquote':
          walk(n.content, `${prefix}> `);
          break;
        case 'listItem':
          walk(n.content, prefix);
          break;
        default:
          break;
      }
    }
  };
  walk(doc.content, '');
  return lines;
}

/** A manifest from pasted text: the parsed JSON, or a message saying why it can't be read. */
export function parseManifestText(text: string): { manifest: unknown } | { error: string } {
  if (!text.trim()) return { error: 'Paste the manifest or choose its file.' };
  try {
    const manifest = JSON.parse(text) as unknown;
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
      return { error: 'A manifest is a JSON object.' };
    }
    return { manifest };
  } catch {
    return { error: 'This is not valid JSON.' };
  }
}
