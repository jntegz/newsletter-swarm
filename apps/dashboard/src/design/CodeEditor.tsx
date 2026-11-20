// The theme code editor (CodeMirror 6), loaded only when the Code panel opens. One editor, with a
// state per file so each keeps its own undo history and cursor. Tab indents; Esc and then Tab
// moves on, so the keyboard is never trapped. Problems show inline, under the text they concern.
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { json } from '@codemirror/lang-json';
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import type { Problem } from '@swarm/site-themes';
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { languageOf, offsetAt } from './files';

export interface CodeEditorHandle {
  /** Puts text at the cursor (replacing a selection) and focuses the editor. */
  insert: (text: string) => void;
  /** Moves the cursor to a 1-based line and column, scrolls there and focuses the editor. */
  reveal: (line: number, column: number) => void;
}

export interface CodeEditorProps {
  path: string;
  value: string;
  readOnly: boolean;
  problems: readonly Problem[];
  onChange: (path: string, text: string) => void;
  handleRef: RefObject<CodeEditorHandle | null>;
  /** Called once the editor can take `handle` calls. */
  onReady?: () => void;
  /** The id of the element that names the editor, for assistive technology. */
  labelledBy: string;
}

const LANGUAGES: Record<ReturnType<typeof languageOf>, () => Extension> = {
  html: () => html({ selfClosingTags: true, autoCloseTags: false }),
  css: () => css(),
  json: () => json(),
};

const theme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '12.5px',
    backgroundColor: 'var(--surface)',
    color: 'var(--ink)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: "'Atkinson Hyperlegible Mono Variable', ui-monospace, monospace",
    lineHeight: '1.6',
  },
  '.cm-content': { padding: '10px 0', caretColor: 'var(--ink)' },
  '.cm-gutters': {
    backgroundColor: 'var(--surface-alt)',
    color: 'var(--text-sub)',
    border: 'none',
    borderRight: '1px solid var(--line)',
  },
  '.cm-activeLine': { backgroundColor: 'rgba(20, 32, 58, 0.04)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(20, 32, 58, 0.07)', color: 'var(--ink)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--signal-soft) !important',
  },
  '.cm-cursor': { borderLeftColor: 'var(--ink)' },
  '.cm-tooltip': {
    border: '1px solid var(--line)',
    borderRadius: '8px',
    backgroundColor: 'var(--surface)',
    boxShadow: 'var(--shadow-card)',
  },
  '.cm-diagnostic': { fontFamily: 'inherit', fontSize: '13px', padding: '6px 10px' },
  '.cm-diagnostic-error': { borderLeft: '3px solid var(--danger)' },
  '.cm-diagnostic-warning': { borderLeft: '3px solid var(--warn)' },
  '.cm-lintRange-error': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--danger)',
    textUnderlineOffset: '3px',
  },
  '.cm-lintRange-warning': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--warn)',
    textUnderlineOffset: '3px',
  },
});

/**
 * A locked editor (a built-in theme's files, or someone who can't edit) still takes focus and a
 * cursor, so the code can be read and scrolled from the keyboard; it just doesn't change.
 */
const lockedExtensions = (locked: boolean): Extension => [
  EditorState.readOnly.of(locked),
  EditorView.contentAttributes.of({ 'aria-readonly': locked ? 'true' : 'false' }),
];

function diagnostics(text: string, problems: readonly Problem[]): Diagnostic[] {
  return problems.map((problem) => {
    const from = offsetAt(text, problem.line, problem.column);
    // Underline the word or tag it starts at, else one character.
    const rest = text.slice(from, from + 80);
    const word = /^[^\s<>{}"']+/.exec(rest)?.[0].length ?? 1;
    const to = Math.min(text.length, from + Math.max(1, word));
    return {
      from: Math.min(from, Math.max(0, text.length - 1)),
      to: Math.max(to, Math.min(from + 1, text.length)),
      severity: problem.severity,
      message: problem.message,
    };
  });
}

export default function CodeEditor({
  path,
  value,
  readOnly,
  problems,
  onChange,
  handleRef,
  onReady,
  labelledBy,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, EditorState>());
  const scrolls = useRef(new Map<string, { top: number; left: number }>());
  const current = useRef(path);
  const latest = useRef({ onChange, readOnly, labelledBy, onReady });
  useLayoutEffect(() => {
    latest.current = { onChange, readOnly, labelledBy, onReady };
  });
  const language = useRef(new Compartment());
  const editable = useRef(new Compartment());

  const stateFor = (file: string, text: string, locked: boolean) =>
    EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        drawSelection(),
        history(),
        indentOnInput(),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        language.current.of(LANGUAGES[languageOf(file)]()),
        editable.current.of(lockedExtensions(locked)),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        lintGutter(),
        EditorState.tabSize.of(2),
        EditorView.contentAttributes.of({
          'aria-labelledby': latest.current.labelledBy,
          'aria-describedby': 'code-editor-keys',
          tabindex: '0',
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) latest.current.onChange(current.current, update.state.doc.toString());
        }),
        theme,
      ],
    });

  // One view for the life of the editor.
  useEffect(() => {
    if (!host.current) return;
    const created = new EditorView({
      state: stateFor(current.current, value, readOnly),
      parent: host.current,
    });
    view.current = created;
    return () => {
      created.destroy();
      view.current = null;
    };
    // Created once; the effects below keep it in step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Another file: keep this one's state (undo, cursor) and where it was scrolled, and bring that
  // one's back. Only the editor's own box scrolls, never the page.
  useEffect(() => {
    const v = view.current;
    if (!v || current.current === path) return;
    states.current.set(current.current, v.state);
    scrolls.current.set(current.current, {
      top: v.scrollDOM.scrollTop,
      left: v.scrollDOM.scrollLeft,
    });
    current.current = path;
    const kept = states.current.get(path);
    v.setState(kept && kept.doc.toString() === value ? kept : stateFor(path, value, readOnly));
    const to = (kept && scrolls.current.get(path)) ?? { top: 0, left: 0 };
    requestAnimationFrame(() => v.scrollDOM.scrollTo(to));
    // Only a new path swaps the state; value and readOnly have their own effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // A change from outside (Undo, Reset, an import): the text follows, keeping undo history.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const text = v.state.doc.toString();
    if (text !== value) {
      v.dispatch({ changes: { from: 0, to: text.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure(lockedExtensions(readOnly)),
    });
  }, [readOnly, path]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch(setDiagnostics(v.state, diagnostics(v.state.doc.toString(), problems)));
  }, [problems, path, value]);

  useLayoutEffect(() => {
    handleRef.current = {
      insert: (text) => {
        const v = view.current;
        if (!v || latest.current.readOnly) return;
        v.dispatch(v.state.replaceSelection(text), { scrollIntoView: true });
        v.focus();
      },
      reveal: (line, column) => {
        const v = view.current;
        if (!v) return;
        const at = offsetAt(v.state.doc.toString(), line, column);
        v.dispatch({
          selection: EditorSelection.cursor(at),
          effects: EditorView.scrollIntoView(at, { y: 'center' }),
        });
        v.focus();
      },
    };
    latest.current.onReady?.();
    return () => {
      handleRef.current = null;
    };
  }, [handleRef]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
}
