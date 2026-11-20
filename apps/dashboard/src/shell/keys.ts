// Single-key page shortcuts (the posts list's / and c, the toasts' Ctrl/⌘ Z) must never take a key
// someone is typing.

/** Whether a key press belongs to a text field, a select or an editor, not to the page. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'].includes(
      target.type,
    );
  }
  return false;
}

/** A page shortcut is a plain key: no Ctrl, ⌘ or Alt, not while typing, not over a dialog. */
export function isPlainShortcut(
  event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing' | 'target'> & {
    defaultPrevented?: boolean;
  },
): boolean {
  if (event.defaultPrevented) return false;
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return false;
  if (isTypingTarget(event.target)) return false;
  return !document.querySelector('dialog[open]');
}
