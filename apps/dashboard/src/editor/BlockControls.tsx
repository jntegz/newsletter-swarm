// The handle in the post editor's left gutter, for the top-level block under the mouse or else the
// one holding the cursor. Drag it to move the block between other top-level blocks, or open its menu
// to move the block without a mouse and to choose where it shows. The drag is the browser's own
// drag and drop, handled here so a block always lands between top-level blocks, never inside one.
import { useEditorState, type Editor } from '@tiptap/react';
import { useEffect, useRef, useState, type DragEvent, type RefObject } from 'react';
import { useChannelFlag } from '../api/queries';
import * as Icon from '../icons';
import { useDisclosure } from '../shell/useDisclosure';
import {
  BLOCK_MOVED,
  SHOW_ON_CHOICES,
  blockPos,
  canChooseShowOn,
  dropGap,
  moveBlockBy,
  moveBlockTo,
  readShowOn,
  setBlockShowOn,
} from './blockCommands';

/** The element of each top-level block, in order. */
function blockElements(editor: Editor): (HTMLElement | null)[] {
  const { doc } = editor.state;
  const elements: (HTMLElement | null)[] = [];
  doc.forEach((_node, offset) => {
    const dom = editor.view.nodeDOM(offset);
    elements.push(dom instanceof HTMLElement ? dom : null);
  });
  return elements;
}

const middleOf = (dom: HTMLElement | null) => {
  if (!dom) return 0;
  const box = dom.getBoundingClientRect();
  return box.top + box.height / 2;
};

/** The offsetTop of the line showing where a block will land. */
function gapTop(elements: (HTMLElement | null)[], gap: number): number {
  const next = elements[gap];
  if (next) return next.offsetTop - 2;
  const last = elements[elements.length - 1];
  return last ? last.offsetTop + last.offsetHeight : 0;
}

export function BlockControls({
  editor,
  channelId,
  bodyRef,
}: {
  editor: Editor;
  channelId: string;
  bodyRef: RefObject<HTMLDivElement | null>;
}) {
  const flagOn = useChannelFlag(channelId, 'block_visibility') === true;
  const menu = useDisclosure();
  const { open: menuOpen, setOpen: setMenuOpen } = menu;
  const [hovered, setHovered] = useState<number | null>(null);
  /** The block the open menu is about. It follows the block as it moves. */
  const [pinned, setPinned] = useState(0);
  const [drop, setDrop] = useState<{ gap: number; top: number } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const dragging = useRef<number | null>(null);

  const facts = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const { doc, selection } = e.state;
      const count = doc.childCount;
      const wanted = menuOpen ? pinned : (hovered ?? selection.$from.index(0));
      const index = Math.min(wanted, count - 1);
      const node = doc.child(index);
      const dom = e.view.nodeDOM(blockPos(doc, index));
      return {
        count,
        index,
        top: dom instanceof HTMLElement ? dom.offsetTop : 0,
        showOn: readShowOn(node.attrs.showOn),
        canChoose: canChooseShowOn(node),
      };
    },
  });

  // Moves from the keyboard shortcut and from the menu, said aloud.
  useEffect(() => {
    const onTransaction = ({
      transaction,
    }: {
      transaction: { getMeta: (k: string) => unknown };
    }) => {
      const moved = transaction.getMeta(BLOCK_MOVED) as { to: number } | undefined;
      if (!moved) return;
      setPinned(moved.to);
      setAnnouncement(`Block moved to place ${moved.to + 1} of ${editor.state.doc.childCount}.`);
    };
    editor.on('transaction', onTransaction);
    return () => {
      editor.off('transaction', onTransaction);
    };
  }, [editor]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let frame = 0;
    // Only with room for the handle beside the "+": on a phone it stays with the cursor.
    const onMove = (event: MouseEvent) => {
      if (!window.matchMedia('(min-width: 640px)').matches) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const { clientY } = event;
        const at = blockElements(editor).findIndex(
          (dom) => dom && clientY < dom.getBoundingClientRect().bottom,
        );
        setHovered(at === -1 ? null : at);
      });
    };
    // Typing or leaving hands the handle back to the block holding the cursor.
    const onLeave = () => {
      cancelAnimationFrame(frame);
      setHovered(null);
    };
    // These stop before the editor sees them, so a handle drag never reaches its own drop handling.
    const onDragOver = (event: globalThis.DragEvent) => {
      if (dragging.current === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      const elements = blockElements(editor);
      const gap = dropGap(elements.map(middleOf), event.clientY);
      setDrop({ gap, top: gapTop(elements, gap) });
    };
    const onDrop = (event: globalThis.DragEvent) => {
      const from = dragging.current;
      if (from === null) return;
      event.preventDefault();
      event.stopPropagation();
      dragging.current = null;
      setDrop(null);
      const gap = dropGap(blockElements(editor).map(middleOf), event.clientY);
      const tr = moveBlockTo(editor.state, from, gap);
      if (tr) editor.view.dispatch(tr);
      editor.view.focus();
    };
    // A click on a block's label opens the same menu as its handle.
    const onLabel = (event: MouseEvent) => {
      const label = (event.target as HTMLElement).closest?.('.editor-show-on');
      if (!label) return;
      setPinned(editor.state.doc.resolve(editor.view.posAtDOM(label, 0)).index(0));
      setMenuOpen(true);
    };
    body.addEventListener('mousemove', onMove);
    body.addEventListener('mouseleave', onLeave);
    body.addEventListener('keydown', onLeave);
    body.addEventListener('dragover', onDragOver, true);
    body.addEventListener('drop', onDrop, true);
    body.addEventListener('click', onLabel);
    return () => {
      cancelAnimationFrame(frame);
      body.removeEventListener('mousemove', onMove);
      body.removeEventListener('mouseleave', onLeave);
      body.removeEventListener('keydown', onLeave);
      body.removeEventListener('dragover', onDragOver, true);
      body.removeEventListener('drop', onDrop, true);
      body.removeEventListener('click', onLabel);
    };
  }, [editor, bodyRef, setMenuOpen]);

  const index = facts?.index ?? 0;
  const count = facts?.count ?? 1;

  const toggleMenu = () => {
    setPinned(index);
    menu.buttonProps.onClick();
  };
  const startDrag = (event: DragEvent<HTMLDivElement>) => {
    menu.close();
    dragging.current = index;
    const dom = blockElements(editor)[index];
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', editor.state.doc.child(index).textContent);
    if (dom) event.dataTransfer.setDragImage(dom, 0, 0);
  };
  const endDrag = () => {
    dragging.current = null;
    setDrop(null);
  };
  const move = (step: -1 | 1) => {
    const tr = moveBlockBy(editor.state, index, step);
    if (tr) editor.view.dispatch(tr);
  };
  const choose = (value: (typeof SHOW_ON_CHOICES)[number]['value']) => {
    const tr = setBlockShowOn(editor.state, index, value);
    if (!tr) return;
    editor.view.dispatch(tr);
    const label = SHOW_ON_CHOICES.find((choice) => choice.value === value)?.label;
    setAnnouncement(`This block now shows: ${label}.`);
  };

  // With the feature off a block that already has a setting can only go back to the default.
  const choices = !facts?.canChoose
    ? []
    : flagOn
      ? SHOW_ON_CHOICES
      : facts.showOn
        ? SHOW_ON_CHOICES.filter((choice) => !choice.value || choice.value === facts.showOn)
        : [];

  return (
    <>
      <div
        className="absolute left-0 z-[5] mt-[34px] sm:-left-[70px] sm:mt-0"
        style={{ top: facts?.top ?? 0 }}
      >
        {/* A div: Firefox won't start a drag from a button. */}
        <div
          role="button"
          tabIndex={0}
          draggable
          {...menu.buttonProps}
          onClick={toggleMenu}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            toggleMenu();
          }}
          onDragStart={startDrag}
          onDragEnd={endDrag}
          aria-label="Move this block or choose where it shows"
          title="Drag to move. Click to move by keyboard or choose where it shows."
          className="grid h-[30px] w-[26px] cursor-grab place-items-center rounded-control text-sub transition-colors hover:bg-surface-alt hover:text-ink aria-expanded:bg-surface-alt aria-expanded:text-ink"
        >
          <Icon.Grip size={18} />
        </div>
        <div
          {...menu.panelProps}
          className="line-menu absolute top-9 left-0 grid w-[240px] gap-0.5"
        >
          <button
            type="button"
            className="line-menu-item w-full aria-disabled:cursor-not-allowed aria-disabled:text-muted"
            // Not `disabled`: focus has to stay here when a move reaches the top.
            aria-disabled={index === 0}
            onClick={() => move(-1)}
          >
            Move up
          </button>
          <button
            type="button"
            className="line-menu-item w-full aria-disabled:cursor-not-allowed aria-disabled:text-muted"
            aria-disabled={index >= count - 1}
            onClick={() => move(1)}
          >
            Move down
          </button>
          {choices.length > 0 && (
            <div role="group" aria-labelledby="block-show-on" className="grid gap-0.5">
              <p id="block-show-on" className="mt-1.5 px-2.5 text-[13px] font-semibold text-sub">
                Show this block in
              </p>
              {choices.map((choice) => {
                const current = facts?.showOn === choice.value;
                return (
                  <button
                    key={choice.label}
                    type="button"
                    className="line-menu-item w-full justify-between"
                    aria-pressed={current}
                    onClick={() => choose(choice.value)}
                  >
                    {choice.label}
                    {current && <Icon.Check size={16} className="shrink-0" />}
                  </button>
                );
              })}
            </div>
          )}
          <p className="mt-1.5 px-2.5 text-[13px] text-sub">
            While writing, Alt with an arrow key moves the block you are in.
          </p>
        </div>
      </div>
      {drop && (
        <div
          aria-hidden
          data-testid="block-drop-line"
          className="pointer-events-none absolute right-0 left-10 z-[4] h-0.5 rounded-full bg-purple sm:left-0"
          style={{ top: drop.top }}
        />
      )}
      <span role="status" className="sr-only">
        {announcement}
      </span>
    </>
  );
}
