/**
 * Editor schema. Node and mark names match the server renderer in @swarm/mail exactly; anything
 * else would be refused on save. The editor never produces email HTML itself.
 */
import { Node, mergeAttributes } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import StarterKit from '@tiptap/starter-kit';
import { BlockVisibility } from './blockCommands';
import { CodeHighlight, TableOfContentsNode } from './codeEmbeds';
import { AskPollNode, SmartBlockNode } from './growthNodes';
import { SnippetNode } from './snippetNode';

/** An image from the media library: mediaId is what the server resolves; src is only for display. */
const MediaImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      /** 25, 50 or 75: its share of the column. Null is the full width. */
      widthPercent: {
        default: null,
        parseHTML: (el) => {
          const value = Number(el.getAttribute('data-width-percent'));
          return value === 25 || value === 50 || value === 75 ? value : null;
        },
        renderHTML: (a) =>
          a.widthPercent
            ? { 'data-width-percent': a.widthPercent, style: `width:${a.widthPercent}%` }
            : {},
      },
      mediaId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-media-id'),
        renderHTML: (a) => (a.mediaId ? { 'data-media-id': a.mediaId } : {}),
      },
      href: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-href'),
        renderHTML: (a) => (a.href ? { 'data-href': a.href } : {}),
      },
      caption: { default: null, renderHTML: () => ({}) },
    };
  },
}).configure({ inline: false, allowBase64: false });

/** A call-to-action button, rendered as a bulletproof table button in email. */
const EmailButton = Node.create({
  name: 'button',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      href: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-href') ?? '',
        renderHTML: () => ({}),
      },
      label: { default: '', parseHTML: (el) => el.textContent ?? '', renderHTML: () => ({}) },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-email-button]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-email-button': '',
        'data-href': node.attrs.href,
        class: 'editor-button',
      }),
      ['span', {}, node.attrs.label || 'Button'],
    ];
  },
});

/** A bordered preview card for a link. */
const LinkCard = Node.create({
  name: 'linkCard',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      href: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-href') ?? '',
        renderHTML: () => ({}),
      },
      title: { default: '', renderHTML: () => ({}) },
      description: { default: '', renderHTML: () => ({}) },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-link-card]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    let host = '';
    try {
      host = new URL(String(node.attrs.href)).hostname;
    } catch {
      host = String(node.attrs.href);
    }
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-link-card': '',
        'data-href': node.attrs.href,
        class: 'editor-link-card',
      }),
      ['strong', {}, node.attrs.title || host || 'Link'],
      ...(node.attrs.description ? [['span', {}, node.attrs.description] as const] : []),
      ['small', {}, host],
    ];
  },
});

/** A file from the media library, sent as a download link (never a MIME attachment). */
const Attachment = Node.create({
  name: 'attachment',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      mediaId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-media-id'),
        renderHTML: () => ({}),
      },
      name: { default: '', renderHTML: () => ({}) },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-attachment]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-attachment': '',
        'data-media-id': node.attrs.mediaId,
        class: 'editor-attachment',
      }),
      ['strong', {}, node.attrs.name || 'Attachment'],
      ['small', {}, 'Download link'],
    ];
  },
});

/**
 * Raw HTML (raw_html_mode flag only). The editor shows the source as text, never as live
 * markup; the sandboxed preview and the server renderer are the only places it is rendered.
 */
const HtmlBlock = Node.create({
  name: 'htmlBlock',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      html: {
        default: '',
        parseHTML: (el) => el.querySelector('pre')?.textContent ?? '',
        renderHTML: () => ({}),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-html-block]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-html-block': '', class: 'editor-html' }),
      ['small', {}, 'Raw HTML'],
      ['pre', {}, String(node.attrs.html ?? '')],
    ];
  },
});

/** The gate divider's node name, as the renderers in @swarm/mail know it. */
const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  parseHTML() {
    return [{ tag: 'aside[data-callout]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'aside',
      mergeAttributes(HTMLAttributes, { 'data-callout': '', class: 'editor-callout' }),
      0,
    ];
  },
});

const Column = Node.create({
  name: 'column',
  content: 'block+',
  isolating: true,
  parseHTML() {
    return [{ tag: 'div[data-column]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-column': '', class: 'editor-column' }),
      0,
    ];
  },
});

const Columns = Node.create({
  name: 'columns',
  group: 'block',
  content: 'column column',
  isolating: true,
  parseHTML() {
    return [{ tag: 'div[data-columns]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-columns': '', class: 'editor-columns' }),
      0,
    ];
  },
});

/** A video or post from another service. Shown as a card in email and on the website. */
const Embed = Node.create({
  name: 'embed',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      url: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-url') ?? '',
        renderHTML: (a) => ({ 'data-url': a.url }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-embed]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-embed': '', class: 'editor-html' }),
      ['small', {}, 'Embed'],
      ['pre', {}, String(node.attrs.url ?? '')],
    ];
  },
});

/** A numbered note. Its text goes in a list at the end of the post. */
const Footnote = Node.create({
  name: 'footnote',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      text: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-text') ?? '',
        renderHTML: (a) => ({ 'data-text': a.text }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'sup[data-footnote]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'sup',
      mergeAttributes(HTMLAttributes, {
        'data-footnote': '',
        class: 'editor-footnote',
        title: String(node.attrs.text ?? ''),
      }),
      '*',
    ];
  },
});

export const GATE_NODE = 'gate';

/**
 * The gate divider: on the website, what follows the first one is only for readers the
 * Dispatch's web visibility allows. It sits in its own group that only the document accepts, so
 * it can never end up inside a list or a quote (the renderers refuse that).
 */
const GateDivider = Node.create({
  name: GATE_NODE,
  group: 'gateBlock',
  atom: true,
  draggable: true,
  selectable: true,
  parseHTML() {
    return [{ tag: 'div[data-gate]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-gate': '',
        class: 'editor-gate',
        role: 'separator',
        'aria-label': 'Paywall break: only subscribers with access read past this point',
      }),
      ['span', {}, 'Paywall break'],
    ];
  },
});

/**
 * The top node, allowing the gate divider, Smart Blocks and polls (`topBlock`) between blocks
 * and nowhere else.
 */
const GatedDocument = Node.create({
  name: 'doc',
  topNode: true,
  content: '(block | gateBlock | topBlock)+',
});

/** Website pages have no gate, Smart Blocks or polls; linked snippets sit between their blocks. */
const PageDocument = Node.create({
  name: 'doc',
  topNode: true,
  content: '(block | topBlock)+',
});

/**
 * Editor extensions. `gate` adds the gate divider (Dispatches only: custom pages and the About
 * page are public and have no gated part). `placeholder` is the empty-editor hint.
 */
export function dispatchExtensions(options: { gate?: boolean; placeholder?: string } = {}) {
  const gate = options.gate ?? true;
  return [
    StarterKit.configure({
      document: false,
      heading: { levels: [1, 2, 3] },
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: 'https',
        protocols: ['http', 'https', 'mailto'],
        // Anything else is dropped here, and again by the server renderer.
        isAllowedUri: (url) => /^(https?:|mailto:)/i.test(url),
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null },
      },
    }),
    // Smart Blocks and polls are Dispatch-only too. They are always known to the schema, so a
    // document that has them still opens when the Smart Blocks flag is later turned off.
    ...(gate
      ? [GatedDocument, GateDivider, SmartBlockNode, AskPollNode, TableOfContentsNode]
      : [PageDocument]),
    SnippetNode,
    // Highlighting stays off until the Channel's code_embeds flag is known (useCodeEmbeds).
    CodeHighlight,
    MediaImage,
    EmailButton,
    LinkCard,
    Attachment,
    HtmlBlock,
    Callout,
    Column,
    Columns,
    Embed,
    Footnote,
    BlockVisibility,
    // The empty post gets the writing hint; any later empty line, how to insert a block.
    Placeholder.configure({
      placeholder: ({ editor, node }) =>
        editor.isEmpty
          ? (options.placeholder ?? 'Write your post, or type / to insert a block…')
          : node.type.name === 'paragraph'
            ? 'Type / to insert a block'
            : '',
    }),
  ];
}

export const MERGE_TAGS = [
  { tag: '{{ first_name | there }}', label: 'First name' },
  { tag: '{{ last_name }}', label: 'Last name' },
  { tag: '{{ email }}', label: 'Email address' },
] as const;
