// Code (admins): the theme's files, an editor, the problems with their file, line and column, and
// the placeholder reference. A built-in theme's files can be read here; Edit code copies them into
// the design, which then no longer gets Swarm's updates to that theme until Reset brings it back.
import type { Design, Problem, ThemeFiles } from '@swarm/site-themes';
import { REFERENCE } from '@swarm/site-themes';
import { Button, ErrorNotice, LoadingRows, TabPanel, Tabs } from '@swarm/ui/components';
import { useQueryClient } from '@tanstack/react-query';
import {
  Suspense,
  lazy,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { designApi, designQuery } from '../api/design';
import { MOD } from '../editor/shortcuts';
import * as Icon from '../icons';
import { useToast } from '../shell/toast';
import type { CodeEditorHandle } from './CodeEditor';
import { copyThemeFiles, filesOf, resetCode } from './draft';
import {
  addFile,
  baseName,
  deleteFile,
  exportFileName,
  fileNameProblem,
  fileTree,
  folderOf,
  parseThemeFile,
  pathFor,
  renameFile,
  sortProblems,
  starterFile,
  toBaseName,
  type FileFolder,
} from './files';
import { renameSectionType } from './sections';
import { useStudio } from './studio';

const CodeEditor = lazy(() => import('./CodeEditor'));

export function CodePanel() {
  const { canAdmin } = useStudio();
  if (!canAdmin) {
    return (
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
        <h2 className="text-[17px] font-[650]">Code</h2>
        <p className="text-[13.5px] leading-[1.55] text-sub">
          The theme’s code is for admins: changing it changes what every part of the home page can
          do. Ask an admin of this publication if you need a new section or a change to the layout.
          Everything else (template, style and sections) is yours to change here.
        </p>
      </div>
    );
  }
  return <CodeWorkspace />;
}

function CodeWorkspace() {
  const studio = useStudio();
  const { draft, themes, channelId, file, setFile, codeTarget, canEdit } = studio;
  const { design } = draft;
  const toast = useToast();
  const client = useQueryClient();
  const builtIn = themes.find((t) => t.id === design.theme);
  const own = design.files !== null;
  const files = useMemo(() => filesOf(design, themes) ?? {}, [design, themes]);
  const tree = fileTree(files);
  const path = file && file in files ? file : 'theme.json' in files ? 'theme.json' : (Object.keys(files)[0] ?? null);
  const editor = useRef<CodeEditorHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<'problems' | 'reference'>('problems');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const editorLabel = useId();
  const tabsId = useId();
  const themeName = builtIn?.name ?? design.theme;

  // A jump to a problem: the file opens (the studio sets it), then the cursor goes to the spot.
  useEffect(() => {
    if (!codeTarget || !ready) return;
    editor.current?.reveal(codeTarget.line, codeTarget.column);
  }, [codeTarget, ready]);

  const changeFiles = (update: (files: ThemeFiles) => ThemeFiles, also?: (d: Design) => Design) =>
    draft.change((d) => {
      const base = d.files ?? filesOf(d, themes) ?? {};
      const next = { ...d, files: update(base) };
      return also ? also(next) : next;
    });

  const editCode = () => {
    if (!builtIn) return;
    draft.change((d) => copyThemeFiles(d, builtIn.files));
    toast.show({
      message: `${builtIn.name}’s files are now this design’s own. Swarm’s updates to ${builtIn.name} won’t reach them.`,
    });
  };

  const reset = () => {
    const before: Design = design;
    draft.change((d) => resetCode(d));
    toast.show({
      message: `Back to ${themeName}’s own files.`,
      action: { label: 'Undo', onAction: () => draft.change(() => before) },
    });
  };

  const exportTheme = async () => {
    setBusy('export');
    setProblem(null);
    try {
      await draft.flush();
      const theme = await designApi.exportTheme(channelId);
      const blob = new Blob([JSON.stringify(theme, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = exportFileName(theme.name);
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setProblem(error instanceof Error ? `Not exported: ${error.message}` : 'Not exported.');
    } finally {
      setBusy(null);
    }
  };

  const importTheme = async (picked: File) => {
    setProblem(null);
    const parsed = parseThemeFile(await picked.text());
    if ('problem' in parsed) {
      setProblem(parsed.problem);
      return;
    }
    setBusy('import');
    const before: Design = design;
    try {
      await draft.flush();
      const answer = await designApi.importTheme(channelId, parsed.theme);
      const fresh = await client.fetchQuery({ ...designQuery(channelId), staleTime: 0 });
      draft.adopt(fresh.draft, answer?.problems ?? fresh.problems);
      setFile('theme.json');
      toast.show({
        message: `Imported ${parsed.theme.name}. It replaced this design’s code.`,
        action: { label: 'Undo', onAction: () => draft.change(() => before) },
      });
    } catch (error) {
      setProblem(error instanceof Error ? `Not imported: ${error.message}` : 'Not imported.');
    } finally {
      setBusy(null);
    }
  };

  const allProblems = sortProblems(draft.problems);
  const fileProblems = path ? allProblems.filter((p) => p.file === path) : [];

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[17px] font-[650]">Code</h2>
          <p className="mt-1 max-w-[60ch] text-[13px] leading-[1.55] text-sub">
            {own
              ? `This design has its own code, started from ${themeName}. Swarm’s updates to ${themeName} don’t reach it.`
              : `${themeName}’s files, as Swarm keeps them. They get Swarm’s improvements until you edit them.`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            loading={busy === 'import'}
            disabled={!canEdit || !!busy}
            onClick={() => importInput.current?.click()}
          >
            <Icon.Upload size={16} /> Import
          </Button>
          <input
            ref={importInput}
            type="file"
            accept=".json,application/json"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              const picked = e.target.files?.[0];
              e.target.value = '';
              if (picked) void importTheme(picked);
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            loading={busy === 'export'}
            disabled={!!busy}
            onClick={() => void exportTheme()}
          >
            <Icon.Download size={16} /> Export
          </Button>
          {own && builtIn && (
            <Button variant="ghost" size="sm" disabled={!canEdit} onClick={reset}>
              Reset to {builtIn.name}
            </Button>
          )}
        </div>
      </div>

      {problem && <ErrorNotice title="That didn’t work" message={problem} />}

      {!own && (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3 rounded-card border border-line bg-surface-alt p-4 sm:flex sm:items-center sm:justify-between">
          <p className="text-[13.5px] leading-[1.55]">
            <span className="font-semibold">Edit code</span> copies {themeName}’s files into this
            design. From then on they’re yours: Swarm’s updates to {themeName} won’t reach them,
            and Reset to {themeName} brings them back.
          </p>
          <Button className="shrink-0" disabled={!canEdit || !builtIn} onClick={editCode}>
            <Icon.Code size={16} /> Edit code
          </Button>
        </div>
      )}

      <div className="grid min-w-0 gap-3 min-[640px]:grid-cols-[176px_minmax(0,1fr)]">
        <FileTree
          tree={tree}
          files={files}
          current={path}
          problems={allProblems}
          editable={own && canEdit}
          onOpen={setFile}
          onAdd={(folder, base) => {
            const target = pathFor(folder, base);
            changeFiles((f) => addFile(f, target, starterFile(folder, base)));
            setFile(target);
            toast.show({
              message:
                folder === 'sections'
                  ? `Added ${target}. Put it on the page from Sections, with Add section.`
                  : `Added ${target}. Use it with {% render '${base}' %}.`,
            });
          }}
        />
        <div className="grid min-w-0 content-start gap-2">
          {path && (
            <FileHeader
              path={path}
              labelId={editorLabel}
              editable={own && canEdit}
              files={files}
              onRename={(to) => {
                const folder = folderOf(path);
                changeFiles(
                  (f) => renameFile(f, path, to),
                  folder === 'sections'
                    ? (d) => ({ ...d, sections: renameSectionType(d.sections, baseName(path), baseName(to)) })
                    : undefined,
                );
                setFile(to);
              }}
              onDelete={() => {
                const before: Design = design;
                const used =
                  folderOf(path) === 'sections'
                    ? studio.sections.filter((s) => s.type === baseName(path)).length
                    : 0;
                changeFiles((f) => deleteFile(f, path));
                setFile('theme.json');
                toast.show({
                  message: `${path} deleted.${used ? ` ${used} section${used === 1 ? '' : 's'} on the page used it.` : ''}`,
                  action: { label: 'Undo', onAction: () => draft.change(() => before) },
                });
              }}
            />
          )}
          <div className="h-[min(52vh,560px)] min-h-[300px] overflow-hidden rounded-control border border-line-control focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-purple">
            {path ? (
              <Suspense fallback={<LoadingRows label="Loading the code editor" rows={4} />}>
                <CodeEditor
                  path={path}
                  value={files[path] ?? ''}
                  readOnly={!own || !canEdit}
                  problems={fileProblems}
                  handleRef={editor}
                  onReady={() => setReady(true)}
                  labelledBy={editorLabel}
                  onChange={(changed, text) =>
                    draft.change((d) => {
                      if (!d.files || d.files[changed] === text) return d;
                      return { ...d, files: { ...d.files, [changed]: text } };
                    })
                  }
                />
              </Suspense>
            ) : (
              <p className="p-4 text-[13px] text-sub">This theme has no files.</p>
            )}
          </div>
          <p id="code-editor-keys" className="text-[12.5px] text-sub">
            Tab indents. Press Esc, then Tab, to move on. {MOD} S saves the draft now; it also saves
            by itself as you type.
          </p>
        </div>
      </div>

      <div>
        <Tabs
          label="Problems and placeholders"
          tabs={[
            { id: 'problems', label: `Problems${allProblems.length ? ` (${allProblems.length})` : ''}` },
            { id: 'reference', label: 'Placeholders' },
          ]}
          value={tab}
          onChange={setTab}
          idFor={(id) => `${tabsId}-${id}`}
          panelFor={(id) => `${tabsId}-${id}-panel`}
          compact
          className="border-line"
        />
        <TabPanel id={`${tabsId}-${tab}-panel`} labelledBy={`${tabsId}-${tab}`} className="pt-3 focus-visible:outline-none">
          {tab === 'problems' ? (
            <ProblemList problems={allProblems} files={files} />
          ) : (
            <Reference
              disabled={!own || !canEdit}
              onInsert={(text) => editor.current?.insert(text)}
            />
          )}
        </TabPanel>
      </div>
    </div>
  );
}

function FileTree({
  tree,
  files,
  current,
  problems,
  editable,
  onOpen,
  onAdd,
}: {
  tree: ReturnType<typeof fileTree>;
  files: ThemeFiles;
  current: string | null;
  problems: Problem[];
  editable: boolean;
  onOpen: (path: string) => void;
  onAdd: (folder: FileFolder, base: string) => void;
}) {
  const count = (path: string) => problems.filter((p) => p.file === path && p.severity === 'error').length;
  const item = (path: string, label: string) => {
    const errors = count(path);
    return (
      <li key={path}>
        <button
          type="button"
          onClick={() => onOpen(path)}
          aria-current={current === path ? 'true' : undefined}
          className={`flex min-h-8 w-full items-center justify-between gap-2 rounded-[6px] px-2 text-left font-mono text-[12.5px] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-purple ${
            current === path ? 'bg-lavender font-semibold text-ink' : 'text-sub hover:bg-surface-alt hover:text-ink'
          }`}
        >
          <span className="truncate">{label}</span>
          {errors > 0 && (
            <span className="shrink-0 font-sans text-[12px] font-semibold text-danger">
              {errors}
              <span className="sr-only"> {errors === 1 ? 'problem' : 'problems'}</span>
            </span>
          )}
        </button>
      </li>
    );
  };
  return (
    <nav aria-label="Theme files" className="grid min-w-0 content-start gap-3 text-[13px]">
      <ul className="grid grid-cols-[minmax(0,1fr)] gap-0.5">{tree.root.map((p) => item(p, p))}</ul>
      {(['sections', 'snippets'] as const).map((folder) => (
        <div key={folder} className="grid grid-cols-[minmax(0,1fr)] gap-1">
          <p className="px-2 text-[13px] font-semibold text-sub">{folder}/</p>
          {tree[folder].length === 0 ? (
            <p className="px-2 text-[12.5px] text-sub">None yet</p>
          ) : (
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-0.5">{tree[folder].map((p) => item(p, baseName(p)))}</ul>
          )}
        </div>
      ))}
      {editable && <AddFile files={files} onAdd={onAdd} />}
    </nav>
  );
}

function AddFile({
  files,
  onAdd,
}: {
  files: ThemeFiles;
  onAdd: (folder: FileFolder, base: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [folder, setFolder] = useState<FileFolder>('sections');
  const [name, setName] = useState('');
  const [tried, setTried] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const base = toBaseName(name);
  const problem = fileNameProblem(files, folder, base);
  const id = useId();

  const close = () => {
    setOpen(false);
    setName('');
    setTried(false);
    requestAnimationFrame(() => button.current?.focus());
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (problem) return;
    onAdd(folder, base);
    setOpen(false);
    setName('');
    setTried(false);
  };

  if (!open) {
    return (
      <button ref={button} type="button" className="btn-ghost btn-sm w-fit" onClick={() => setOpen(true)}>
        <Icon.Plus size={16} /> Add file
      </button>
    );
  }
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Esc closes the form, as InlineAdd does
    <form
      aria-label="Add a file"
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      }}
      className="grid grid-cols-[minmax(0,1fr)] gap-2 rounded-control border border-line p-2"
    >
      <label className="grid grid-cols-[minmax(0,1fr)] gap-1 text-[13px] font-semibold" htmlFor={`${id}-kind`}>
        Kind
        <select
          id={`${id}-kind`}
          className="line-input min-h-[36px]! text-[13px]"
          value={folder}
          onChange={(e) => setFolder(e.target.value as FileFolder)}
        >
          <option value="sections">Section</option>
          <option value="snippets">Snippet</option>
        </select>
      </label>
      <label className="grid grid-cols-[minmax(0,1fr)] gap-1 text-[13px] font-semibold" htmlFor={`${id}-name`}>
        Name
        <input
          id={`${id}-name`}
          // The form opens because someone asked for it: the name is what they type next.
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          className="line-input min-h-[36px]! font-mono text-[13px]"
          value={name}
          placeholder="pull_quote"
          spellCheck={false}
          aria-invalid={tried && !!problem}
          aria-describedby={`${id}-hint`}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <p id={`${id}-hint`} className={`text-[12.5px] ${tried && problem ? 'font-semibold text-danger' : 'text-sub'}`}>
        {tried && problem ? problem : base ? pathFor(folder, base) : 'Lower case, with - or _.'}
      </p>
      <div className="flex gap-1.5">
        <Button type="submit" size="sm">
          Add
        </Button>
        <Button variant="ghost" size="sm" onClick={close}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function FileHeader({
  path,
  labelId,
  editable,
  files,
  onRename,
  onDelete,
}: {
  path: string;
  labelId: string;
  editable: boolean;
  files: ThemeFiles;
  onRename: (to: string) => void;
  onDelete: () => void;
}) {
  const folder = folderOf(path);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const problem = folder ? fileNameProblem(files, folder, toBaseName(name), path) : null;
  const id = useId();
  const renameButton = useRef<HTMLButtonElement>(null);

  if (renaming && folder) {
    const close = () => {
      setRenaming(false);
      requestAnimationFrame(() => renameButton.current?.focus());
    };
    return (
      // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Esc closes the form
      <form
        aria-label={`Rename ${path}`}
        className="flex flex-wrap items-start gap-2"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
        onSubmit={(e) => {
          e.preventDefault();
          if (problem) return;
          onRename(pathFor(folder, toBaseName(name)));
          setRenaming(false);
        }}
      >
        <label htmlFor={id} className="sr-only">
          New name for {path}
        </label>
        <div className="grid min-w-[160px] flex-1 gap-1">
          <input
            id={id}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            value={name}
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={!!problem && name !== baseName(path)}
            aria-describedby={`${id}-hint`}
            className="line-input min-h-[32px]! font-mono text-[13px]"
          />
          <p id={`${id}-hint`} className={`text-[12.5px] ${problem ? 'text-danger' : 'text-sub'}`}>
            {problem ??
              (folder === 'sections'
                ? 'Sections of this kind on the page follow the new name.'
                : 'The {% render %} tags that use it follow the new name.')}
          </p>
        </div>
        <Button type="submit" size="sm">
          Rename
        </Button>
        <Button variant="ghost" size="sm" onClick={close}>
          Cancel
        </Button>
      </form>
    );
  }
  return (
    <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
      <p id={labelId} className="font-mono text-[13px] font-semibold">
        {path}
        <span className="sr-only">, code</span>
      </p>
      {editable && folder && (
        <div className="flex gap-1">
          <button
            ref={renameButton}
            type="button"
            className="btn-quiet btn-sm"
            onClick={() => {
              setName(baseName(path));
              setRenaming(true);
            }}
          >
            Rename
          </button>
          <Button variant="quiet" size="sm" onClick={onDelete}>
            Delete
          </Button>
        </div>
      )}
    </div>
  );
}

function ProblemList({ problems, files }: { problems: Problem[]; files: ThemeFiles }) {
  const { openProblem } = useStudio();
  if (!problems.length) {
    return (
      <p className="flex items-center gap-1.5 text-[13px] text-route">
        <Icon.Check size={16} />
        <span>No problems. The theme’s files and the page check out.</span>
      </p>
    );
  }
  return (
    <ul className="grid max-h-[300px] gap-0.5 overflow-y-auto">
      {problems.map((problem, i) => {
        const inFile = problem.file in files;
        const where = inFile ? `${problem.file}:${problem.line}:${problem.column}` : 'The page';
        const body = (
          <>
            <span
              className={`mt-0.5 shrink-0 text-[12px] font-semibold ${problem.severity === 'error' ? 'text-danger' : 'text-warn'}`}
            >
              {problem.severity === 'error' ? 'Error' : 'Warning'}
            </span>
            <span className="min-w-0">
              <span className="block font-mono text-[12.5px] text-sub">{where}</span>
              <span className="block text-[13px]">{problem.message}</span>
            </span>
          </>
        );
        return (
          <li key={`${where}-${i}`}>
            <button
              type="button"
              onClick={() => openProblem(problem)}
              className="flex w-full items-start gap-3 rounded-[6px] px-2 py-1.5 text-left hover:bg-surface-alt focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-purple"
            >
              {body}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Reference({ disabled, onInsert }: { disabled: boolean; onInsert: (text: string) => void }) {
  const [query, setQuery] = useState('');
  const id = useId();
  const q = query.trim().toLowerCase();
  const groups = REFERENCE.map((g) => ({
    ...g,
    items: g.items.filter(
      (item) =>
        !q || item.insert.toLowerCase().includes(q) || item.description.toLowerCase().includes(q),
    ),
  })).filter((g) => g.items.length);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
        <label htmlFor={id} className="text-[13px] font-semibold">
          Find a placeholder
        </label>
        <input
          id={id}
          type="search"
          className="line-input min-h-[36px]!"
          value={query}
          placeholder="post.title, date, subscribe…"
          onChange={(e) => setQuery(e.target.value)}
        />
        <p className="text-[12.5px] text-sub">
          {disabled
            ? 'Edit code first, then choose one to put it at the cursor.'
            : 'Choose one to put it at the cursor.'}
        </p>
      </div>
      {groups.length === 0 && <p className="text-[13px] text-sub">Nothing matches “{query}”.</p>}
      <div className="grid max-h-[360px] gap-4 overflow-y-auto pr-1">
        {groups.map((group) => (
          <section key={group.title} aria-label={group.title} className="grid grid-cols-[minmax(0,1fr)] gap-1">
            <h3 className="text-[13px] font-semibold text-sub">{group.title}</h3>
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
              {group.items.map((item) => (
                <li key={item.insert}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onInsert(item.insert)}
                    className="grid w-full gap-0.5 rounded-[6px] px-2 py-1.5 text-left hover:bg-surface-alt focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-purple disabled:cursor-default disabled:hover:bg-transparent"
                  >
                    <code className="font-mono text-[12.5px] break-all whitespace-pre-wrap text-ink">
                      {item.insert.trim()}
                    </code>
                    <span className="text-[12.5px] text-sub">{item.description}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
