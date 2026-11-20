// A small bar over selected text: bold, italic, link, heading and quote, where the eye already is.
// It only appears for a text selection while the post has focus, never steals focus (buttons act
// on mouse down), and stays out of the way on phones, which have their own selection menu.
import { NodeSelection } from '@tiptap/pm/state';
import { useEditorState, type Editor } from '@tiptap/react';
import type { ReactNode, RefObject } from 'react';
import * as Icon from '../icons';
import { MOD } from './shortcuts';

const BAR_WIDTH = 236;
const BAR_HEIGHT = 40;

export function SelectionBar({
  editor,
  bodyRef,
  onLink,
}: {
  editor: Editor;
  bodyRef: RefObject<HTMLDivElement | null>;
  onLink: () => void;
}) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const { from, to, empty } = e.state.selection;
      const body = bodyRef.current;
      if (empty || !e.isEditable || !e.isFocused || !body) return null;
      if (e.state.selection instanceof NodeSelection) return null;
      if (!e.state.doc.textBetween(from, to, ' ').trim()) return null;
      const start = e.view.coordsAtPos(from);
      const end = e.view.coordsAtPos(to);
      const frame = body.getBoundingClientRect();
      const middle = (start.left + end.left) / 2 - frame.left;
      const left = Math.min(
        Math.max(middle, BAR_WIDTH / 2),
        Math.max(frame.width - BAR_WIDTH / 2, BAR_WIDTH / 2),
      );
      const above = start.top - frame.top - BAR_HEIGHT - 8;
      return {
        top: above >= 0 ? above : end.bottom - frame.top + 8,
        left,
        bold: e.isActive('bold'),
        italic: e.isActive('italic'),
        link: e.isActive('link'),
        heading: e.isActive('heading', { level: 2 }),
        quote: e.isActive('blockquote'),
      };
    },
  });
  if (!state) return null;
  const run = () => editor.chain().focus();
  return (
    <div
      role="toolbar"
      aria-label="Format the selection"
      className="absolute z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-[10px] bg-rail p-1 text-rail-text shadow-[var(--shadow-card)] max-sm:hidden"
      style={{ top: state.top, left: state.left, height: BAR_HEIGHT }}
    >
      <BarButton
        label="Bold"
        shortcut={`${MOD} B`}
        active={state.bold}
        onPress={() => run().toggleBold().run()}
      >
        <Icon.Bold size={17} />
      </BarButton>
      <BarButton
        label="Italic"
        shortcut={`${MOD} I`}
        active={state.italic}
        onPress={() => run().toggleItalic().run()}
      >
        <Icon.Italic size={17} />
      </BarButton>
      <BarButton label={state.link ? 'Edit link' : 'Add link'} active={state.link} onPress={onLink}>
        <Icon.Link size={17} />
      </BarButton>
      <span aria-hidden="true" className="mx-1 h-5 w-px bg-rail-line" />
      <BarButton
        label="Heading"
        active={state.heading}
        onPress={() => run().toggleHeading({ level: 2 }).run()}
      >
        <Icon.Heading size={17} />
      </BarButton>
      <BarButton label="Quote" active={state.quote} onPress={() => run().toggleBlockquote().run()}>
        <Icon.Quote size={17} />
      </BarButton>
    </div>
  );
}

function BarButton({
  label,
  shortcut,
  active,
  onPress,
  children,
}: {
  label: string;
  shortcut?: string;
  active: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={shortcut ? `${label} (${shortcut})` : label}
      // Acting on mouse down keeps the selection and the editor's focus.
      onMouseDown={(event) => {
        event.preventDefault();
        onPress();
      }}
      // The keyboard path (Tab to the bar, then Enter or Space) still works.
      onClick={(event) => {
        if (event.detail === 0) onPress();
      }}
      className={`grid size-8 place-items-center rounded-[6px] transition-colors ${
        active ? 'bg-rail-3 text-white' : 'hover:bg-rail-2 hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}
