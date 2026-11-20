// The slash menu: typing "/" on an empty line offers the same blocks as the insert menu.

/** What's been typed after a "/" that starts the line, or null when this isn't a slash command. */
export function slashQuery(lineText: string, cursorAtEnd: boolean): string | null {
  if (!cursorAtEnd) return null;
  const match = /^\/([\p{L}\p{N} ]{0,24})$/u.exec(lineText);
  return match ? (match[1] ?? '') : null;
}

/** The blocks matching what's typed: names that start with it first, then ones containing it. */
export function filterSlash<T extends { label: string; disabled?: boolean }>(
  items: T[],
  query: string,
): T[] {
  const wanted = query.trim().toLowerCase();
  const usable = items.filter((item) => !item.disabled);
  if (!wanted) return usable;
  const named = usable.filter((item) => item.label.toLowerCase().includes(wanted));
  return [
    ...named.filter((item) => item.label.toLowerCase().startsWith(wanted)),
    ...named.filter((item) => !item.label.toLowerCase().startsWith(wanted)),
  ];
}
