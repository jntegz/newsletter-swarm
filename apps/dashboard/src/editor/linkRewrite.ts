// Finding and replacing the links of a post, for "shorten all links".
import { sponsorClickPath } from '@swarm/domain';
import type { Node as ProseNode } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/react';

/** The blocks that carry a link in an `href` attribute. */
const LINK_BLOCKS = new Set(['button', 'linkCard', 'image']);

const SPONSOR_PATH = sponsorClickPath('');

/** A sponsor's link counts its own clicks, so shortening it would only add a hop. */
const isSponsorLink = (href: string) => {
  try {
    return new URL(href).pathname.startsWith(SPONSOR_PATH);
  } catch {
    return false;
  }
};

const isWeb = (href: unknown): href is string =>
  typeof href === 'string' && /^https?:\/\//i.test(href) && !isSponsorLink(href);

/** Every distinct web address in a document: links in text, buttons, link cards and images. */
export function linksIn(doc: ProseNode): string[] {
  const found = new Set<string>();
  doc.descendants((node) => {
    if (LINK_BLOCKS.has(node.type.name) && isWeb(node.attrs.href)) found.add(node.attrs.href);
    for (const mark of node.marks) {
      if (mark.type.name === 'link' && isWeb(mark.attrs.href)) found.add(mark.attrs.href);
    }
  });
  return [...found];
}

/** Replaces addresses in one undoable step, keeping each link's other attributes. */
export function replaceLinks(editor: Editor, replacements: ReadonlyMap<string, string>): void {
  const { state, view } = editor;
  const { tr, doc } = state;
  doc.descendants((node, pos) => {
    if (LINK_BLOCKS.has(node.type.name)) {
      const next = replacements.get(node.attrs.href as string);
      if (next) tr.setNodeMarkup(pos, undefined, { ...node.attrs, href: next });
    }
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type.name !== 'link') continue;
      const next = replacements.get(mark.attrs.href as string);
      if (!next) continue;
      const end = pos + node.nodeSize;
      tr.removeMark(pos, end, mark.type);
      tr.addMark(pos, end, mark.type.create({ ...mark.attrs, href: next }));
    }
  });
  if (tr.docChanged) view.dispatch(tr);
}
