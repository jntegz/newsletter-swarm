/**
 * A deliberately small XML reader: elements, attributes, text, CDATA, comments and the five
 * predefined entities plus character references. A DOCTYPE (and so any DTD or entity declaration)
 * is refused outright, so there is no entity expansion.
 */

/** The document is malformed; `message` names it. */
export class XmlInputError extends Error {
  override name = 'XmlInputError';
}

export interface XmlElement {
  /** Local name: any namespace prefix is dropped. */
  name: string;
  children: XmlElement[];
  text: string;
  /** Attributes by local name, entities decoded (Feed Sync reads Atom links and enclosures). */
  attrs: Record<string, string>;
  /** Offsets of the element's content in the source: Atom xhtml content is read from there. */
  inner: [number, number];
}

const XML_LIMITS = { depth: 32, elements: 400_000 };

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,6});/g, (whole, ref: string) => {
    if (ref.startsWith('#x')) return safeCodePoint(Number.parseInt(ref.slice(2), 16), whole);
    if (ref.startsWith('#')) return safeCodePoint(Number.parseInt(ref.slice(1), 10), whole);
    return ENTITIES[ref] ?? whole;
  });
}

function safeCodePoint(code: number, fallback: string): string {
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
}

const localName = (qname: string) => qname.slice(qname.indexOf(':') + 1);

// A name starts only after whitespace (XML requires it), so a long run with no '=' is scanned once
// instead of from every position, which made parsing quadratic.
const ATTRIBUTE = /(?<!\S)([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attributesOf(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(ATTRIBUTE)) {
    const name = localName(match[1]!);
    if (!(name in attrs)) attrs[name] = decodeEntities(match[2] ?? match[3] ?? '');
  }
  return attrs;
}

/**
 * Parses an XML document into elements. Throws XmlInputError on anything malformed; `label`
 * names the document in the message.
 */
export function parseXml(xml: string, label = 'report XML'): XmlElement {
  const root: XmlElement = { name: '#document', children: [], text: '', attrs: {}, inner: [0, 0] };
  const stack: XmlElement[] = [root];
  let count = 0;
  let i = 0;
  const fail = (why: string): never => {
    throw new XmlInputError(`${label}: ${why}`);
  };
  const skipTo = (marker: string, from: number) => {
    const end = xml.indexOf(marker, from);
    if (end < 0) fail(`unterminated ${marker}`);
    return end + marker.length;
  };

  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    const top = stack[stack.length - 1]!;
    if (lt < 0 || lt > i) {
      const text = xml.slice(i, lt < 0 ? xml.length : lt);
      if (stack.length > 1) top.text += decodeEntities(text);
      else if (text.trim()) fail('text outside the root element');
      if (lt < 0) break;
      i = lt;
    }
    if (xml.startsWith('<?', i)) {
      i = skipTo('?>', i + 2);
    } else if (xml.startsWith('<!--', i)) {
      i = skipTo('-->', i + 4);
    } else if (xml.startsWith('<![CDATA[', i)) {
      const end = xml.indexOf(']]>', i + 9);
      if (end < 0) fail('unterminated CDATA');
      if (stack.length > 1) top.text += xml.slice(i + 9, end);
      i = end + 3;
    } else if (xml.startsWith('<!', i)) {
      fail('DOCTYPE and DTDs are not allowed');
    } else if (xml.startsWith('</', i)) {
      const end = xml.indexOf('>', i);
      if (end < 0) fail('unterminated end tag');
      const name = localName(xml.slice(i + 2, end).trim());
      if (stack.length < 2 || top.name !== name) fail(`unexpected </${name}>`);
      top.inner[1] = i;
      stack.pop();
      i = end + 1;
    } else {
      // A start tag. Attribute values may contain '>', so walk quotes.
      let j = i + 1;
      let quote = '';
      while (j < xml.length) {
        const ch = xml[j]!;
        if (quote) {
          if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '>') break;
        j++;
      }
      if (j >= xml.length) fail('unterminated start tag');
      const inner = xml.slice(i + 1, j);
      const selfClosing = inner.endsWith('/');
      const qname = /^[^\s/>]+/.exec(inner)?.[0];
      if (!qname) fail('start tag without a name');
      if (stack.length === 1 && root.children.length) fail('more than one root element');
      if (++count > XML_LIMITS.elements) fail('too many elements');
      const element: XmlElement = {
        name: localName(qname!),
        children: [],
        text: '',
        attrs: attributesOf(inner.slice(qname!.length, selfClosing ? -1 : undefined)),
        inner: [j + 1, j + 1],
      };
      top.children.push(element);
      if (!selfClosing) {
        if (stack.length > XML_LIMITS.depth) fail('nesting is too deep');
        stack.push(element);
      }
      i = j + 1;
    }
  }
  if (stack.length !== 1) fail('unclosed elements');
  const document = root.children[0];
  if (!document) fail('no root element');
  return document!;
}
