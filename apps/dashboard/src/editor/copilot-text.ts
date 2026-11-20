// Copilot results are plain text. They become editor nodes here, never through an HTML parser,
// so a result that contains markup is inserted as the literal characters.

type CopilotNode =
  { type: 'text'; text: string } | { type: 'paragraph'; content: { type: 'text'; text: string }[] };

/** Blank lines separate paragraphs; one paragraph is inserted inline (into the current block). */
export function textNodes(text: string): CopilotNode[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
  if (paragraphs.length === 1) return [{ type: 'text', text: paragraphs[0] as string }];
  return paragraphs.map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] }));
}
