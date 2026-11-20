// The save model's pieces, as first drawn: the Unsaved changes bar, the inline add form's button,
// and the note beside a control that saves on change.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InlineAdd } from './InlineAdd';
import { SavedNote } from './SavedNote';
import { UnsavedBar } from './UnsavedBar';

const noop = () => {};

describe('UnsavedBar', () => {
  it('shows nothing to press while nothing changed', () => {
    const html = renderToStaticMarkup(
      <UnsavedBar dirty={false} pending={false} form="f" onDiscard={noop} />,
    );
    expect(html).toContain('hidden=""');
    expect(html).not.toContain('Discard');
    expect(html).not.toContain('type="submit"');
    expect(html).toContain('role="status"');
  });

  it('offers Discard and Save once something changed', () => {
    const html = renderToStaticMarkup(
      <UnsavedBar
        dirty
        pending={false}
        form="f"
        onDiscard={noop}
        label="Unsaved changes to the branding"
        error="Not saved: the network dropped."
      />,
    );
    expect(html).not.toContain('hidden=""');
    expect(html).toContain('Unsaved changes to the branding');
    expect(html).toContain('Discard');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*form="f"[^>]*>.*Save<\/button>/);
    expect(html).toContain('role="alert"');
  });
});

describe('InlineAdd', () => {
  it('starts as a button, with the form closed and a quiet status line', () => {
    const html = renderToStaticMarkup(
      <InlineAdd label="Add sender" onSubmit={noop}>
        <input aria-label="Sender name" />
      </InlineAdd>,
    );
    expect(html).toMatch(/<button[^>]*>Add sender<\/button>/);
    expect(html).not.toContain('<form');
    expect(html).not.toContain('Sender name');
    expect(html).toContain('role="status"');
  });
});

describe('SavedNote', () => {
  it('says Saved with Undo, and keeps its status line when idle', () => {
    const saved = renderToStaticMarkup(<SavedNote state="saved" onUndo={noop} />);
    expect(saved).toContain('Saved');
    expect(saved).toContain('Undo');
    const idle = renderToStaticMarkup(<SavedNote state="idle" onUndo={noop} />);
    expect(idle).toContain('role="status"');
    expect(idle).not.toContain('Undo');
  });
});
