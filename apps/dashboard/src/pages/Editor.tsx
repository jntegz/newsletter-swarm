import type {
  CoverImage,
  Dispatch,
  DispatchDocument,
  DispatchRevision,
  Good,
  MediaAsset,
  SponsorBooking,
  UpdateDispatch,
} from '@swarm/domain';
import {
  Button,
  Dialog,
  ErrorNotice,
  LoadingRows,
  Pill,
  TextAreaField,
  TextField,
  SelectField,
} from '@swarm/ui/components';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import type { JSONContent } from '@tiptap/core';
import { Selection } from '@tiptap/pm/state';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { embedInfo } from '@swarm/mail/embeds';
import { snippetContentProblem } from '@swarm/mail/snippets';
import {
  CurrentPost,
  SavePost,
  ShortenAllLinks,
  ShortenLinkButton,
} from '../editor/TrackableLinks';
import { goodsQuery } from '../api/goods';
import { sponsorBookingsQuery } from '../api/partners';
import { channelQuery, mediaQuery, useChannelFlag, useUploadMedia } from '../api/queries';
import { api, ApiError } from '../api/client';
import { memberFieldsQuery } from '../api/members';
import { filterSlash, slashQuery } from '../editor/slash';
import { formatMoney } from '../money/helpers';
import { productButton } from './goods-helpers';
import { sponsorCard } from './partners-helpers';
import {
  dispatchQuery,
  preflightQuery,
  revisionQuery,
  revisionsQuery,
  saveDispatchOnLeave,
  sendKeys,
  sendersQuery,
  useArchivePosts,
  useDeleteDispatch,
  useNameRevision,
  useRestoreRevision,
  useSaveDispatch,
  useSetPlannedDate,
} from '../api/send';
import { useCurrentChannel } from '../channel';
import { CopilotPanel } from '../editor/CopilotPanel';
import { CodeTools, useCodeEmbeds } from '../editor/codeEmbeds';
import { coverCompareLine, coverPayload, inboxFirstLine } from '../editor/coverImage';
import { diffLines, documentLines } from '../editor/diff';
import {
  NOTHING_TO_SAVE,
  createSaveQueue,
  type SaveState,
  type SaveStatus,
} from '../editor/saveQueue';
import { BlockControls } from '../editor/BlockControls';
import { GATE_NODE, MERGE_TAGS, dispatchExtensions } from '../editor/extensions';
import {
  SnippetEditorContext,
  insertSnippet,
  snippetQuery,
  usageSentence,
  type SnippetDetail,
} from '../editor/snippetNode';
import { GrowthEditorProvider, SmartBlocksPanel, useGrowthEditor } from '../editor/GrowthTools';
import { PostHeader } from '../editor/PostHeader';
import { SelectionBar } from '../editor/SelectionBar';
import {
  MOD,
  ShortcutsDialog,
  readingTime,
  useEditorShortcuts,
  useStickyBarHeight,
} from '../editor/shortcuts';
import { PreviewPane, twoEmails, type PreviewMode, type ViewAs } from '../editor/PreviewPane';
import { FlowEmailPanel } from '../flows/FlowEmailPanel';
import * as Icon from '../icons';
import { HoldBackPanel } from '../send/HoldBack';
import { ARCHIVE_NOTE, canArchive, showsSendRoute } from '../send/send-helpers';
import { SendRoute } from '../send/SendRoute';
import { setWritingFocus, useWritingFocus } from '../shell/focusMode';
import { usePageTitle } from '../shell/pageTitle';
import { useTabStatus } from '../shell/tabStatus';
import { useDisclosure } from '../shell/useDisclosure';
import { WebsitePanel } from '../site/WebsitePanel';
import { MediaPicker } from './MediaPicker';
import { SaveAsTemplateDialog } from './Templates';
import {
  DispatchPill,
  FlatSectionsProvider,
  Section,
  formatDateTime,
  numberFormat,
} from './common';

const AUTOSAVE_MS = 1200;
const EDITABLE = new Set(['draft', 'scheduled']);
const SUBJECT_MAX = 200;
const PREVIEW_MAX = 200;

type IconComponent = ComponentType<{ size?: number; className?: string }>;

export function EditorPage({ dispatchId, flowId }: { dispatchId: string; flowId?: string }) {
  const dispatch = useQuery(dispatchQuery(dispatchId));
  // Bumped when the document is replaced on the server (a restored revision).
  const [generation, setGeneration] = useState(0);
  if (dispatch.isPending) return <LoadingRows label="Loading the post" rows={6} />;
  if (dispatch.error) {
    return (
      <ErrorNotice
        title="This post isn’t available"
        message={dispatch.error.message}
        action={
          <Link to="/dispatches" className="btn-ghost">
            Back to posts
          </Link>
        }
      />
    );
  }
  // Re-mount only when the post changes identity or leaves the editable states, never on
  // our own saves, so the cursor stays put.
  const editable = EDITABLE.has(dispatch.data.status);
  // A Flow email says so itself, so opening it from anywhere (not only its Flow) is safe.
  const ownerFlowId = dispatch.data.kind === 'flow' ? (dispatch.data.flowId ?? flowId) : undefined;
  return (
    <CurrentPost.Provider value={dispatchId}>
      <DispatchEditor
        key={`${dispatchId}-${editable}-${generation}`}
        initial={dispatch.data}
        onReplaced={() => setGeneration((n) => n + 1)}
        {...(ownerFlowId ? { flowId: ownerFlowId } : {})}
      />
    </CurrentPost.Provider>
  );
}

const PREVIEW_MODES: { id: PreviewMode; label: string; icon: IconComponent }[] = [
  { id: 'edit', label: 'Edit', icon: Icon.Pen },
  { id: 'desktop', label: 'Email · desktop', icon: Icon.Desktop },
  { id: 'mobile', label: 'Email · mobile', icon: Icon.Phone },
  { id: 'dark', label: 'Email · dark', icon: Icon.Moon },
  { id: 'web', label: 'Web', icon: Icon.Globe },
];

/**
 * Puts the cursor at the start of the body right away. TipTap's focus() waits a frame, and a key
 * typed straight after Enter in the preview text would land in the wrong field.
 */
function focusBodyStart(editor: Editor | null) {
  if (!editor || editor.isDestroyed) return;
  const { state, view } = editor;
  view.dispatch(state.tr.setSelection(Selection.atStart(state.doc)).scrollIntoView());
  view.focus();
}

/** Word count, the first line (what inboxes show without preview text) and the paywall break. */
function useDocumentFacts(editor: Editor | null) {
  return (
    useEditorState({
      editor,
      selector: ({ editor: e }) => {
        if (!e) return { words: 0, firstLine: '', gate: false };
        let firstLine = '';
        e.state.doc.descendants((node) => {
          if (firstLine) return false;
          // Inboxes never get a website-only block, so it can't be their first line.
          if (node.attrs.showOn === 'web') return false;
          if (node.isTextblock && node.textContent.trim()) {
            firstLine = node.textContent.trim();
            return false;
          }
          return true;
        });
        const text = e.getText({ blockSeparator: ' ' });
        return {
          words: text.split(/\s+/).filter(Boolean).length,
          firstLine,
          gate: topLevelGate(e),
        };
      },
    }) ?? { words: 0, firstLine: '', gate: false }
  );
}

function DispatchEditor({
  initial,
  onReplaced,
  flowId,
}: {
  initial: Dispatch;
  onReplaced: () => void;
  /** Set for a Flow email: the side panel links back to the Flow instead of sending. */
  flowId?: string;
}) {
  const id = initial.id;
  const live = useQuery(dispatchQuery(id)).data ?? initial;
  const channel = useQuery(channelQuery(initial.channelId));
  const role = channel.data?.role ?? 'viewer';
  const canWrite = role !== 'viewer' && EDITABLE.has(live.status);
  const canSend = ['editor', 'admin', 'owner'].includes(role);
  const { remember } = useCurrentChannel();

  const [subject, setSubject] = useState(initial.subject);
  const [preheader, setPreheader] = useState(initial.preheader);
  const [cover, setCover] = useState(initial.coverImage);
  const [{ state: saveState, savedAt, error: saveError }, setSaveStatus] =
    useState<SaveStatus>(NOTHING_TO_SAVE);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [mode, setMode] = useState<PreviewMode>('edit');
  const [viewAs, setViewAs] = useState<ViewAs>('free');
  const fields = useRef({
    subject: initial.subject,
    preheader: initial.preheader,
    coverImage: coverPayload(initial.coverImage),
  });
  const latestDocument = useRef<DispatchDocument | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const preheaderRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const focus = useWritingFocus();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  useStickyBarHeight(rootRef, barRef);
  // Focus mode belongs to this editor: leaving the post brings the rail back.
  useEffect(() => () => setWritingFocus(false), []);

  usePageTitle(live.subject.trim() || 'Untitled post');
  // A post that didn't save says so in the tab too.
  useTabStatus(saveState === 'error' ? 'Not saved' : null);
  // The publication in the rail follows the post being edited.
  useEffect(() => remember(initial.channelId), [remember, initial.channelId]);

  /** The post as it is now. A closing editor can't be read, so the last reading stands in. */
  const readPost = useCallback((): UpdateDispatch => {
    const current = editorRef.current;
    if (current && !current.isDestroyed) {
      latestDocument.current = current.getJSON() as DispatchDocument;
    }
    return {
      ...fields.current,
      ...(latestDocument.current ? { content: latestDocument.current } : {}),
    };
  }, []);
  // mutateAsync stays the same across renders, so the queue lives as long as the editor.
  const { mutateAsync: writePost } = useSaveDispatch(id);
  // The queue only calls readPost later, from timers and events, never during this render.
  // eslint-disable-next-line react-hooks/refs
  const [saves] = useState(() =>
    createSaveQueue<UpdateDispatch>({
      debounceMs: AUTOSAVE_MS,
      read: readPost,
      write: writePost,
      onChange: setSaveStatus,
    }),
  );
  const { changed, flush } = saves;
  /** For saves nothing waits on. A failure shows on the page, and the queue tries again. */
  const saveSoon = () => void flush().catch(() => undefined);
  useEditorShortcuts({
    onSave: canWrite ? saveSoon : undefined,
    onFocus: () => setWritingFocus(!focus),
    onShortcuts: () => setShortcutsOpen((open) => !open),
    onLeaveFocus: focus ? () => setWritingFocus(false) : undefined,
  });

  const uploadMedia = useUploadMedia(live.channelId);
  const placeImages = async (files: File[], at?: number) => {
    for (const file of files) {
      const asset = await uploadMedia.mutateAsync(file);
      const node = {
        type: 'image',
        attrs: { mediaId: asset.id, src: asset.url, alt: '' },
      };
      const chain = editorRef.current?.chain().focus();
      if (at === undefined) chain?.insertContent(node).run();
      else chain?.insertContentAt(at, node).run();
    }
  };
  const editor = useEditor({
    extensions: dispatchExtensions(),
    content: initial.content,
    editable: canWrite,
    immediatelyRender: false,
    // setEditable also emits an update, with nothing written. Only a changed document is an edit:
    // saving on the bare event made every sent post open with "changes are not saved".
    onUpdate: ({ transaction }) => {
      if (transaction.docChanged) changed();
    },
    editorProps: {
      attributes: {
        class: 'dispatch-prose',
        'aria-label': 'Post body',
        'aria-multiline': 'true',
        role: 'textbox',
      },
      // An image dropped or pasted in is uploaded to the media library and placed where it landed.
      handleDrop: (view, event) => {
        const files = imageFiles(event.dataTransfer);
        if (!files.length) return false;
        event.preventDefault();
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        // Landing on a line of text, the image goes after that line instead of splitting it.
        const $pos = pos === undefined ? null : view.state.doc.resolve(pos);
        const onText = $pos?.parent.isTextblock && $pos.parent.content.size > 0;
        void placeImages(files, onText ? $pos?.after() : pos);
        return true;
      },
      handlePaste: (_view, event) => {
        const files = imageFiles(event.clipboardData);
        if (!files.length) return false;
        event.preventDefault();
        void placeImages(files);
        return true;
      },
    },
  });
  useEffect(() => {
    editorRef.current = editor;
    // What's read from the document (word count, the paywall break, the toolbar's state) updates
    // on each transaction. One that changes nothing gives it a first reading as the editor opens,
    // and it is not an edit: onUpdate only counts transactions that change the document.
    if (editor && !editor.isDestroyed) {
      editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false));
    }
  }, [editor]);

  useEffect(() => {
    // false: becoming editable once the role loads is not an edit.
    editor?.setEditable(canWrite, false);
  }, [editor, canWrite]);

  // Phase 6: Smart Blocks, polls, Split Tests and Cohort Sampling (see ../editor/GrowthTools).
  const growth = useGrowthEditor(editor, live, canWrite);
  // Code embeds: highlighting for readers too, not only when the toolbar is shown.
  useCodeEmbeds(editor, live.channelId);
  const facts = useDocumentFacts(editor);
  const senders = useQuery(sendersQuery(live.channelId));
  const preflight = useQuery({
    ...preflightQuery(id),
    enabled: EDITABLE.has(live.status) && !flowId,
  });
  const sender =
    senders.data?.find((s) => s.id === live.senderIdentityId) ??
    senders.data?.find((s) => s.isDefault);
  const from =
    preflight.data?.from ??
    (sender ? { name: sender.fromName, address: sender.fromAddress } : null);
  const fromName = from?.name ?? channel.data?.name ?? 'Your publication';

  // Warn before leaving with unsaved work, and send what we have as the tab closes. Leaving the
  // editor inside the app saves it, and the warning stays until that save is done.
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (saves.pending()) event.preventDefault();
    };
    const pageHide = () => {
      if (saves.pending()) saveDispatchOnLeave(id, readPost());
    };
    saves.open();
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('pagehide', pageHide);
    return () => {
      readPost();
      saves.close(() => {
        window.removeEventListener('beforeunload', beforeUnload);
        window.removeEventListener('pagehide', pageHide);
      });
    };
  }, [saves, id, readPost]);

  const setField = (name: 'subject' | 'preheader', value: string) => {
    fields.current = { ...fields.current, [name]: value };
    if (name === 'subject') setSubject(value);
    else setPreheader(value);
    changed();
  };

  const changeCover = (next: CoverImage | null) => {
    fields.current = { ...fields.current, coverImage: coverPayload(next) };
    setCover(next);
    changed();
  };

  const switchMode = (next: PreviewMode) => {
    // The preview shows the saved version, so save first.
    if (next !== 'edit') saveSoon();
    setMode(next);
  };

  const focusPreheader = () => {
    setMode('edit');
    requestAnimationFrame(() => preheaderRef.current?.focus());
  };

  const time = (d: Date) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const status: Record<SaveState, string> = {
    saved: savedAt ? `Saved ${time(savedAt)}` : 'All changes saved',
    unsaved: 'Unsaved changes',
    saving: 'Saving…',
    error: 'Not saved',
  };
  const split = twoEmails(live);

  return (
    <SavePost.Provider value={flush}>
      <div ref={rootRef} className="-mx-4 -mt-6 -mb-12 sm:-mx-8">
        <div
          ref={barRef}
          className={`z-20 flex flex-wrap items-center gap-x-4 gap-y-2.5 border-b border-line bg-surface px-4 py-2.5 sm:px-6 min-[1020px]:sticky ${
            focus ? 'min-[1020px]:top-0' : 'min-[1020px]:top-14'
          }`}
        >
          <div className="flex items-center gap-2.5 text-[13px] whitespace-nowrap text-sub">
            <DispatchPill status={live.status} imported={!!live.importedAt} />
            {live.archivedAt && <Pill tone="neutral">Archived</Pill>}
            {canWrite && (
              <span
                role="status"
                className={`inline-flex items-center gap-1 ${
                  saveState === 'error' ? 'font-semibold text-danger' : ''
                }`}
              >
                {saveState === 'saved' && <Icon.Check size={14} className="text-route" />}
                {status[saveState]}
              </span>
            )}
            <span
              className={`max-sm:hidden ${editor ? '' : 'invisible'}`}
              title="Reading time at about 230 words a minute"
            >
              · {numberFormat.format(facts.words)} {facts.words === 1 ? 'word' : 'words'} ·{' '}
              {readingTime(facts.words)}
            </span>
          </div>
          {/* On a phone the bar is two rows: the state and Save as template, then the preview
              modes across the full width. */}
          <div className="flex flex-1 flex-wrap items-center justify-end gap-x-2.5 gap-y-2 max-sm:contents">
            <fieldset className="inline-flex min-w-0 rounded-control border border-line bg-surface-alt p-[3px] max-sm:order-last max-sm:w-full">
              <legend className="sr-only">Preview</legend>
              {PREVIEW_MODES.map((m) => {
                const ModeIcon = m.icon;
                const checked = mode === m.id;
                return (
                  <label
                    key={m.id}
                    title={m.label}
                    className={`inline-flex h-[30px] cursor-pointer items-center justify-center gap-1.5 rounded-[6px] px-2 text-[13px] whitespace-nowrap transition-colors max-sm:flex-1 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-purple ${
                      checked
                        ? 'bg-surface font-semibold text-ink shadow-[0_0_0_1px_var(--line-control)]'
                        : 'text-sub hover:text-ink'
                    }`}
                  >
                    <input
                      type="radio"
                      name="editor-preview"
                      className="sr-only"
                      checked={checked}
                      onChange={() => switchMode(m.id)}
                    />
                    <ModeIcon size={16} />
                    <span className="max-[1535px]:sr-only">{m.label}</span>
                  </label>
                );
              })}
            </fieldset>
            {/* Who the preview is for; while writing, the preview buttons are the way in. */}
            <label
              hidden={mode === 'edit'}
              className="flex items-center gap-2 text-[13px] whitespace-nowrap text-sub max-sm:order-last"
            >
              View as
              <select
                className="line-input min-h-[34px]! w-[150px] text-[13px]"
                value={viewAs}
                onChange={(e) => {
                  setViewAs(e.target.value as ViewAs);
                  if (mode === 'edit') switchMode('desktop');
                }}
                title={
                  split
                    ? undefined
                    : 'Everyone gets the same email until a paid post has a paywall break'
                }
              >
                <option value="free">Free subscriber</option>
                <option value="paid">Paid subscriber</option>
              </select>
            </label>
            {role !== 'viewer' && (
              <Button
                variant="quiet"
                size="sm"
                className="max-sm:ml-auto"
                // After the save, so the dialog starts from the subject just typed.
                onClick={() =>
                  // A failed save shows on the page; the dialog waits until it works.
                  void flush().then(
                    () => setSavingTemplate(true),
                    () => undefined,
                  )
                }
              >
                Save as template
              </Button>
            )}
            <span aria-hidden="true" className="h-5 w-px bg-line max-sm:hidden" />
            <button
              type="button"
              onClick={() => setShortcutsOpen(true)}
              aria-label="Keyboard shortcuts"
              title={`Keyboard shortcuts (${MOD} /)`}
              className="grid size-8 place-items-center rounded-[6px] text-sub transition-colors hover:bg-surface-alt hover:text-ink max-sm:hidden"
            >
              <Icon.Keyboard size={18} />
            </button>
            <button
              type="button"
              onClick={() => setWritingFocus(!focus)}
              aria-pressed={focus}
              title={`${focus ? 'Leave focus mode' : 'Focus mode: only the post on screen'} (${MOD} \\)`}
              className={`inline-flex h-8 items-center gap-1.5 rounded-[6px] px-2 text-[13px] font-semibold transition-colors ${
                focus
                  ? 'bg-purple text-white hover:bg-purple-deep'
                  : 'text-sub hover:bg-surface-alt hover:text-ink max-sm:hidden'
              }`}
            >
              {focus ? <Icon.Collapse size={16} /> : <Icon.Expand size={16} />}
              {focus ? 'Leave focus' : 'Focus'}
            </button>
          </div>
        </div>
        {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
        {savingTemplate && (
          <SaveAsTemplateDialog dispatch={live} onClose={() => setSavingTemplate(false)} />
        )}

        <div
          className={
            focus
              ? ''
              : 'min-[1100px]:grid min-[1100px]:grid-cols-[minmax(0,1fr)_360px] min-[1100px]:items-start'
          }
        >
          <div className="min-w-0">
            {mode !== 'edit' && (
              <PreviewPane dispatch={live} mode={mode} viewAs={viewAs} from={from} />
            )}
            <div
              hidden={mode !== 'edit'}
              className="mx-auto max-w-[800px] px-4 pt-7 pb-24 sm:pr-8 sm:pl-[76px]"
            >
              <h1 className="sr-only">{subject.trim() || 'Untitled post'}</h1>
              {saveError && (
                <div className="mb-5">
                  <ErrorNotice
                    title="Your latest changes are not saved"
                    message={saveError}
                    action={
                      <Button variant="ghost" size="sm" onClick={saveSoon}>
                        Try again
                      </Button>
                    }
                  />
                </div>
              )}
              {!EDITABLE.has(live.status) && (
                <div className="mb-5 rounded-card bg-surface-alt px-4 py-3 text-[15px]">
                  This post is {live.status} and can no longer be edited.{' '}
                  {live.latestBroadcastId && (
                    <Link
                      to="/broadcasts/$broadcastId"
                      params={{ broadcastId: live.latestBroadcastId }}
                      className="font-semibold text-purple"
                    >
                      See the send report
                    </Link>
                  )}
                </div>
              )}

              <PostHeader
                subject={subject}
                preheader={preheader}
                subjectMax={SUBJECT_MAX}
                preheaderMax={PREVIEW_MAX}
                canWrite={canWrite}
                kind={flowId ? 'Automation email' : 'Post'}
                publication={channel.data?.name ?? 'Loading…'}
                cover={cover}
                channelId={live.channelId}
                fromName={fromName}
                firstLine={inboxFirstLine(cover, facts.firstLine)}
                preheaderRef={preheaderRef}
                onSubject={(v) => setField('subject', v)}
                onPreheader={(v) => setField('preheader', v)}
                onCover={changeCover}
                onDone={() => focusBodyStart(editor)}
              />

              {canWrite && editor && (
                <div
                  className={`sticky z-10 mt-7 ${
                    focus
                      ? 'top-0 min-[1020px]:top-[var(--editor-bar,0px)]'
                      : 'top-[108px] min-[1020px]:top-[calc(56px+var(--editor-bar,0px))]'
                  }`}
                >
                  <Toolbar
                    editor={editor}
                    channelId={live.channelId}
                    htmlAllowed={live.htmlBlocksAllowed}
                    insertExtras={growthInsertItems(growth, canWrite)}
                    extra={
                      <ShortenAllLinks editor={editor} channelId={live.channelId} flush={flush} />
                    }
                  />
                </div>
              )}
              <div ref={bodyRef} className="relative mt-6 pl-10 sm:pl-0">
                {canWrite && editor && (
                  <BlockControls editor={editor} channelId={live.channelId} bodyRef={bodyRef} />
                )}
                {canWrite && editor && (
                  <SelectionBar
                    editor={editor}
                    bodyRef={bodyRef}
                    onLink={() => setLinkOpen(true)}
                  />
                )}
                {linkOpen && editor && (
                  <LinkDialog
                    editor={editor}
                    channelId={live.channelId}
                    open
                    onClose={() => setLinkOpen(false)}
                  />
                )}
                {canWrite && editor && (
                  <BodyGutter
                    editor={editor}
                    channelId={live.channelId}
                    htmlAllowed={live.htmlBlocksAllowed}
                    insertExtras={growthInsertItems(growth, canWrite)}
                  />
                )}
                <GrowthEditorProvider value={growth.context}>
                  <SnippetTools channelId={live.channelId}>
                    <EditorContent editor={editor} />
                  </SnippetTools>
                </GrowthEditorProvider>
              </div>
            </div>
          </div>

          <aside
            aria-label="Post settings"
            hidden={focus}
            className="border-t border-line bg-surface-alt px-4 pt-[22px] pb-10 sm:px-[22px] min-[1100px]:sticky min-[1100px]:top-[calc(56px+var(--editor-bar,0px))] min-[1100px]:h-[calc(100vh-56px-var(--editor-bar,0px))] min-[1100px]:overflow-y-auto min-[1100px]:border-t-0 min-[1100px]:border-l min-[1100px]:pb-[72px]"
          >
            {flowId ? (
              <FlowEmailPanel flowId={flowId} />
            ) : (
              <>
                {live.importedAt && live.status === 'draft' && <PastIssueNote />}
                {showsSendRoute(live.status) && !live.importedAt && (
                  <SendRoute
                    dispatch={live}
                    canWrite={canWrite}
                    canSend={canSend}
                    flush={flush}
                    words={facts.words}
                    hasPaywall={facts.gate}
                    onAddPreviewText={focusPreheader}
                  />
                )}
                {live.latestBroadcastId && (
                  <Link
                    to="/broadcasts/$broadcastId"
                    params={{ broadcastId: live.latestBroadcastId }}
                    className={`btn-ghost btn-sm ${showsSendRoute(live.status) ? 'mt-4' : ''}`}
                  >
                    Send report
                  </Link>
                )}
                <MoreOptions
                  dispatch={live}
                  editor={editor}
                  canWrite={canWrite}
                  canSend={canSend}
                  flush={flush}
                  onReplaced={onReplaced}
                  smartBlocksOn={growth.smartBlocksOn}
                  // The preview shows the saved post, so save first, and open it either way.
                  onPreviewAsMember={() =>
                    void flush().then(growth.openPreview, growth.openPreview)
                  }
                  copilot={
                    canWrite && (
                      <CopilotPanel
                        editor={editor}
                        dispatchId={id}
                        channelId={live.channelId}
                        subject={subject}
                        onUseSubject={(value) => setField('subject', value)}
                        onUsePreheader={(value) => setField('preheader', value)}
                      />
                    )
                  }
                />
              </>
            )}
          </aside>
        </div>
        {growth.dialogs}
      </div>
    </SavePost.Provider>
  );
}

/** The Phase 6 blocks in the insert menu: Smart Block (when its flag is on) and a poll. */
function growthInsertItems(
  growth: ReturnType<typeof useGrowthEditor>,
  canWrite: boolean,
): InsertItem[] {
  if (!canWrite) return [];
  return [
    ...(growth.smartBlocksOn
      ? [{ id: 'smart', label: 'Smart block', icon: Icon.SmartBlock, run: growth.insertSmartBlock }]
      : []),
    { id: 'poll', label: 'Poll', icon: Icon.Poll, run: growth.insertPoll },
  ];
}

// ---- More options ------------------------------------------------------------------------------

/** A note for the team. Saved when the field loses focus, and editable after sending too. */
function InternalNote({ dispatch, canWrite }: { dispatch: Dispatch; canWrite: boolean }) {
  const save = useSaveDispatch(dispatch.id);
  const [note, setNote] = useState(dispatch.internalNote);
  return (
    <div className="border-t border-line py-4">
      <TextAreaField
        label="Note for your team"
        hint="Only people working in this publication see it. It never goes out."
        rows={3}
        maxLength={2000}
        value={note}
        disabled={!canWrite}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => {
          if (note !== dispatch.internalNote) save.mutate({ internalNote: note });
        }}
        error={save.error?.message}
      />
    </div>
  );
}

/** An imported issue has no send route: its readers already had it. */
function PastIssueNote() {
  return (
    <div className="grid gap-1.5">
      <h2 className="text-[15px] font-semibold">Past issue</h2>
      <p className="text-[13px] leading-[1.55] text-sub">
        This issue came from another platform and is on your website. Your readers already had it,
        so Swarm won’t email it. To send something like it, start a new post.
      </p>
    </div>
  );
}

/** The day a writer aims for (flag content_calendar). Saved at once; it never affects sending. */
function PlannedDateField({ dispatch, canWrite }: { dispatch: Dispatch; canWrite: boolean }) {
  const on = useChannelFlag(dispatch.channelId, 'content_calendar') === true;
  const plan = useSetPlannedDate(dispatch.channelId);
  const [date, setDate] = useState(dispatch.plannedDate ?? '');
  if (!on || dispatch.status !== 'draft' || dispatch.importedAt) return null;
  return (
    <div className="border-t border-line py-4">
      <TextField
        label="Planned date"
        type="date"
        hint="A date you’re aiming for, shown on the calendar. It doesn’t schedule or send anything."
        value={date}
        disabled={!canWrite}
        onChange={(e) => {
          setDate(e.target.value);
          plan.mutate({ id: dispatch.id, plannedDate: e.target.value || null });
        }}
        error={plan.error?.message}
      />
    </div>
  );
}

/** Files a finished post away (flag post_archive). The post stays on the website. */
function ArchivePanel({ dispatch }: { dispatch: Dispatch }) {
  const on = useChannelFlag(dispatch.channelId, 'post_archive') === true;
  const archive = useArchivePosts(dispatch.channelId);
  const refusal = archive.data?.refused[0]?.message;
  if (!on || !canArchive(dispatch)) return null;
  const action = dispatch.archivedAt ? 'restore' : 'archive';
  return (
    <div className="border-t border-line py-4">
      <Button
        variant="ghost"
        size="sm"
        loading={archive.isPending}
        onClick={() => archive.mutate({ action, ids: [dispatch.id] })}
      >
        {dispatch.archivedAt ? 'Restore post' : 'Archive post'}
      </Button>
      <p className="mt-2 text-[13px] leading-[1.55] text-sub">{ARCHIVE_NOTE}</p>
      {(archive.error || refusal) && (
        <ErrorNotice message={archive.error?.message ?? refusal ?? ''} />
      )}
    </div>
  );
}

function MoreOptions({
  dispatch,
  editor,
  canWrite,
  canSend,
  flush,
  onReplaced,
  smartBlocksOn,
  onPreviewAsMember,
  copilot,
}: {
  dispatch: Dispatch;
  editor: Editor | null;
  canWrite: boolean;
  canSend: boolean;
  flush: () => Promise<unknown>;
  onReplaced: () => void;
  smartBlocksOn: boolean;
  onPreviewAsMember: () => void;
  /** The writing assistant (flag copilot). */
  copilot: ReactNode;
}) {
  const remove = useDeleteDispatch(dispatch.id);
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const editable = EDITABLE.has(dispatch.status);
  return (
    <details className="group mt-[18px] border-t border-line-control">
      <summary className="flex cursor-pointer list-none items-center justify-between rounded-[6px] px-1.5 pt-3.5 pb-1.5 font-[650] [&::-webkit-details-marker]:hidden">
        More options
        <Icon.ChevronDown className="text-sub transition-transform group-open:rotate-180" />
      </summary>
      <div className="min-w-0 px-1.5 pt-2 [overflow-wrap:anywhere]">
        <FlatSectionsProvider>
          {copilot}
          <SnippetTools channelId={dispatch.channelId}>
            <HoldBackPanel
              dispatch={dispatch}
              canWrite={canWrite}
              flush={flush}
              renderToolbar={(variantEditor) => (
                <Toolbar
                  editor={variantEditor}
                  channelId={dispatch.channelId}
                  htmlAllowed={dispatch.htmlBlocksAllowed}
                  variant="page"
                  {...(editable
                    ? {
                        extra: (
                          <ShortenAllLinks
                            editor={variantEditor}
                            channelId={dispatch.channelId}
                            flush={flush}
                          />
                        ),
                      }
                    : {})}
                />
              )}
            />
          </SnippetTools>
          <PlannedDateField dispatch={dispatch} canWrite={canWrite} />
          <InternalNote dispatch={dispatch} canWrite={canWrite} />
          {/* Web fields change at any time, sent or not, with the editor role. */}
          <WebsitePanel dispatch={dispatch} canEdit={canSend} flush={flush} />
          {canSend && <ArchivePanel dispatch={dispatch} />}
          {smartBlocksOn && <SmartBlocksPanel editor={editor} onPreview={onPreviewAsMember} />}
          <Revisions
            dispatch={dispatch}
            canWrite={canWrite}
            flush={flush}
            onReplaced={onReplaced}
          />
        </FlatSectionsProvider>
        {canSend && editable && !dispatch.latestBroadcastId && (
          <div className="border-t border-line py-4">
            {confirmDelete ? (
              <div role="group" aria-labelledby="delete-q" className="grid gap-3">
                <p id="delete-q" className="font-semibold">
                  {dispatch.importedAt
                    ? 'Delete this past issue? It leaves your website too. This can’t be undone.'
                    : 'Delete this draft? This can’t be undone.'}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="danger"
                    size="sm"
                    loading={remove.isPending}
                    onClick={() =>
                      remove.mutate(undefined, {
                        onSuccess: () =>
                          void navigate({
                            to: '/dispatches',
                            search: { channel: dispatch.channelId },
                          }),
                      })
                    }
                  >
                    {dispatch.importedAt ? 'Delete past issue' : 'Delete draft'}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                    Keep it
                  </Button>
                </div>
              </div>
            ) : (
              <Button variant="quiet" size="sm" onClick={() => setConfirmDelete(true)}>
                {dispatch.importedAt ? 'Delete past issue' : 'Delete draft'}
              </Button>
            )}
            {remove.error && <ErrorNotice message={remove.error.message} />}
          </div>
        )}
      </div>
    </details>
  );
}

// ---- Toolbar and insert menu -------------------------------------------------------------------

function ToolButton({
  label,
  shortcut,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`grid size-8 shrink-0 place-items-center rounded-[6px] transition-colors disabled:text-muted ${
        active
          ? 'bg-lavender text-ink'
          : 'text-sub hover:bg-surface-alt hover:text-ink disabled:hover:bg-transparent'
      }`}
    >
      {children}
    </button>
  );
}

function Separator() {
  return <span aria-hidden="true" className="mx-1 h-5 w-px bg-line" />;
}

type DialogKind =
  | 'link'
  | 'image'
  | 'button'
  | 'card'
  | 'file'
  | 'product'
  | 'sponsor'
  | 'html'
  | null
  | 'embed'
  | 'footnote'
  | 'snippet';

export interface InsertItem {
  id: string;
  label: string;
  icon: IconComponent;
  run: () => void;
  disabled?: boolean;
}

/** Whether the document already has its paywall break (the first one is the one that counts). */
function topLevelGate(editor: Editor): boolean {
  let found = false;
  editor.state.doc.forEach((node) => {
    if (node.type.name === GATE_NODE) found = true;
  });
  return found;
}

/**
 * What the insert menu offers, and the dialogs for the blocks that need details (image, file,
 * button, link card, raw HTML). Posts get the paywall break; website pages don't.
 */
function useInsertActions(
  editor: Editor,
  {
    channelId,
    htmlAllowed,
    variant,
    extras = [],
    snippets = true,
  }: {
    channelId: string;
    htmlAllowed: boolean;
    variant: 'dispatch' | 'page';
    extras?: InsertItem[];
    /** Off while editing a snippet: one can't hold another. */
    snippets?: boolean;
  },
) {
  const [dialog, setDialog] = useState<DialogKind>(null);
  const goodsOn = useChannelFlag(channelId, 'goods') === true;
  const sponsorsOn = useChannelFlag(channelId, 'sponsor_match') === true;
  const snippetsOn = useChannelFlag(channelId, 'snippets') === true;
  const gate = useEditorState({
    editor,
    selector: ({ editor: e }) => variant === 'dispatch' && topLevelGate(e),
  });
  const run = () => editor.chain().focus();

  /** New blocks go after the block holding the cursor, or replace it when it is empty. */
  const after = () => {
    const { $from } = editor.state.selection;
    return $from.depth === 0 ? $from.pos : $from.after(1);
  };
  const emptyLine = () => {
    const { $from } = editor.state.selection;
    return $from.parent.isTextblock && $from.parent.content.size === 0;
  };

  const items: InsertItem[] = [
    {
      id: 'heading',
      label: 'Heading',
      icon: Icon.Heading,
      run: () => {
        if (emptyLine()) run().setHeading({ level: 2 }).run();
        else {
          const at = after();
          run()
            .insertContentAt(at, { type: 'heading', attrs: { level: 2 } })
            .setTextSelection(at + 1)
            .run();
        }
      },
    },
    { id: 'image', label: 'Image', icon: Icon.Image, run: () => setDialog('image') },
    { id: 'button', label: 'Button', icon: Icon.ButtonBlock, run: () => setDialog('button') },
    { id: 'quote', label: 'Quote', icon: Icon.Quote, run: () => run().toggleBlockquote().run() },
    {
      id: 'divider',
      label: 'Divider',
      icon: Icon.Divider,
      run: () => run().setHorizontalRule().run(),
    },
    { id: 'card', label: 'Link card', icon: Icon.Card, run: () => setDialog('card') },
    {
      id: 'callout',
      label: 'Callout',
      icon: Icon.Quote,
      run: () =>
        run()
          .insertContent({ type: 'callout', content: [{ type: 'paragraph' }] })
          .run(),
    },
    {
      id: 'columns',
      label: 'Two columns',
      icon: Icon.Card,
      run: () => {
        run()
          .insertContent({
            type: 'columns',
            content: [
              { type: 'column', content: [{ type: 'paragraph' }] },
              { type: 'column', content: [{ type: 'paragraph' }] },
            ],
          })
          .run();
        // The insert leaves the cursor in the last column. Writing starts in the first: past the
        // openings of the columns, the column and its paragraph.
        const { $from } = editor.state.selection;
        if ($from.depth >= 3)
          run()
            .setTextSelection($from.before($from.depth - 2) + 3)
            .run();
      },
    },
    { id: 'embed', label: 'Embed', icon: Icon.Globe, run: () => setDialog('embed') },
    ...(snippets && snippetsOn
      ? [{ id: 'snippet', label: 'Snippet', icon: Icon.Doc, run: () => setDialog('snippet') }]
      : []),
    { id: 'footnote', label: 'Footnote', icon: Icon.Doc, run: () => setDialog('footnote') },
    { id: 'file', label: 'File', icon: Icon.Doc, run: () => setDialog('file') },
    ...(goodsOn
      ? [
          {
            id: 'product',
            label: 'Product',
            icon: Icon.ButtonBlock,
            run: () => setDialog('product'),
          },
        ]
      : []),
    ...(sponsorsOn
      ? [{ id: 'sponsor', label: 'Sponsor', icon: Icon.Card, run: () => setDialog('sponsor') }]
      : []),
    ...(variant === 'dispatch'
      ? [
          {
            id: 'gate',
            label: gate ? 'Paywall break added' : 'Paywall break',
            icon: Icon.Lock,
            disabled: !!gate,
            run: () => run().insertContentAt(after(), { type: GATE_NODE }).run(),
          },
        ]
      : []),
    ...(htmlAllowed
      ? [{ id: 'html', label: 'Raw HTML', icon: Icon.Braces, run: () => setDialog('html') }]
      : []),
    ...extras,
  ];

  const close = () => setDialog(null);
  const dialogs = (
    <>
      {/* Each dialog mounts only while open, so its fields start from the current selection. */}
      {dialog === 'link' && (
        <LinkDialog editor={editor} channelId={channelId} open onClose={close} />
      )}
      {dialog === 'image' && (
        <ImageDialog editor={editor} channelId={channelId} open onClose={close} />
      )}
      {dialog === 'button' && (
        <BlockDialog editor={editor} channelId={channelId} kind="button" open onClose={close} />
      )}
      {dialog === 'card' && (
        <BlockDialog editor={editor} channelId={channelId} kind="linkCard" open onClose={close} />
      )}
      {dialog === 'file' && (
        <AttachmentDialog editor={editor} channelId={channelId} open onClose={close} />
      )}
      {dialog === 'product' && (
        <ProductDialog editor={editor} channelId={channelId} onClose={close} />
      )}
      {dialog === 'sponsor' && (
        <SponsorDialog editor={editor} channelId={channelId} onClose={close} />
      )}
      {dialog === 'html' && <HtmlDialog editor={editor} open onClose={close} />}
      {dialog === 'embed' && <EmbedDialog editor={editor} onClose={close} />}
      {dialog === 'snippet' && (
        <SnippetDialog editor={editor} channelId={channelId} onClose={close} />
      )}
      {dialog === 'footnote' && <FootnoteDialog editor={editor} onClose={close} />}
    </>
  );
  return { items, dialogs, openLink: () => setDialog('link') };
}

const imageFiles = (data: DataTransfer | null) =>
  [...(data?.files ?? [])].filter((file) => file.type.startsWith('image/'));

/**
 * The insert menu, the same wherever it opens (the toolbar's Insert, the gutter's "+"): a search
 * field first, so typing narrows the list as the "/" menu does, then every block. Enter takes the
 * first match; the arrow keys move between the field and the blocks.
 */
function InsertPanel({ items, onPick }: { items: InsertItem[]; onPick: () => void }) {
  const [query, setQuery] = useState('');
  const searchId = useId();
  const shown = query.trim() ? filterSlash(items, query) : items;
  const choose = (item: InsertItem) => {
    onPick();
    item.run();
  };
  return (
    <>
      <div className="col-span-full px-1 pt-1 pb-1.5">
        <label htmlFor={searchId} className="sr-only">
          Find a block
        </label>
        <input
          id={searchId}
          type="search"
          value={query}
          placeholder="Find a block"
          autoComplete="off"
          className="line-input min-h-9! text-[13.5px]"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const first = shown.find((item) => !item.disabled);
            if (first) choose(first);
          }}
        />
      </div>
      {shown.map((item) => {
        const ItemIcon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            className="line-menu-item"
            disabled={item.disabled}
            onClick={() => choose(item)}
          >
            <ItemIcon size={18} className="shrink-0 text-sub" />
            <span className="min-w-0">{item.label}</span>
          </button>
        );
      })}
      {shown.length === 0 && (
        <p className="col-span-full px-2.5 py-2 text-[13px] text-sub">
          No block called “{query.trim()}”.
        </p>
      )}
      <p className="col-span-full border-t border-line px-2.5 pt-2 pb-1 text-[12.5px] text-sub">
        Or type <kbd className="font-mono">/</kbd> on an empty line.
      </p>
    </>
  );
}

/**
 * The formatting toolbar. Underline (Ctrl/⌘ U), strikethrough (Ctrl/⌘ Shift S) and inline code
 * (Ctrl/⌘ E) stay on their keyboard shortcuts to keep the bar on one line. Posts get the paywall break and merge tags; website pages (custom
 * pages, About) and split-test variants are the same editor without them.
 */
export function Toolbar({
  editor,
  channelId,
  htmlAllowed,
  variant = 'dispatch',
  extra,
  insertExtras,
  snippets = true,
}: {
  editor: Editor;
  channelId: string;
  htmlAllowed: boolean;
  variant?: 'dispatch' | 'page';
  /** More tools at the end of the bar. */
  extra?: ReactNode;
  /** More blocks for the insert menu (the post editor's Smart Block and poll). */
  insertExtras?: InsertItem[];
  /** Off while editing a snippet: one can't hold another. */
  snippets?: boolean;
}) {
  const insert = useInsertActions(editor, {
    channelId,
    htmlAllowed,
    variant,
    snippets,
    ...(insertExtras ? { extras: insertExtras } : {}),
  });
  const menu = useDisclosure();
  const styleId = useId();
  const codeEmbeds = useCodeEmbeds(editor, channelId);
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      quote: e.isActive('blockquote'),
      link: e.isActive('link'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const run = () => editor.chain().focus();
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = mac ? '⌘' : 'Ctrl';

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="relative flex flex-wrap items-center gap-0.5 border-y border-line bg-surface py-1.5"
    >
      <label htmlFor={styleId} className="sr-only">
        Text style
      </label>
      <select
        id={styleId}
        className="line-input mr-1 min-h-8! w-[116px] text-[13px]"
        value={state.h2 ? 'h2' : state.h3 ? 'h3' : 'p'}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'p') run().setParagraph().run();
          else
            run()
              .setHeading({ level: v === 'h2' ? 2 : 3 })
              .run();
        }}
      >
        <option value="p">Paragraph</option>
        <option value="h2">Heading</option>
        <option value="h3">Subheading</option>
      </select>
      <ToolButton
        label="Bold"
        shortcut={`${mod} B`}
        active={state.bold}
        onClick={() => run().toggleBold().run()}
      >
        <Icon.Bold size={18} />
      </ToolButton>
      <ToolButton
        label="Italic"
        shortcut={`${mod} I`}
        active={state.italic}
        onClick={() => run().toggleItalic().run()}
      >
        <Icon.Italic size={18} />
      </ToolButton>
      <ToolButton
        label={state.link ? 'Edit link' : 'Add link'}
        active={state.link}
        onClick={insert.openLink}
      >
        <Icon.Link size={18} />
      </ToolButton>
      <Separator />
      <ToolButton
        label="Bulleted list"
        active={state.bullet}
        onClick={() => run().toggleBulletList().run()}
      >
        <Icon.BulletList size={18} />
      </ToolButton>
      <ToolButton
        label="Numbered list"
        active={state.ordered}
        onClick={() => run().toggleOrderedList().run()}
      >
        <Icon.NumberList size={18} />
      </ToolButton>
      <ToolButton label="Quote" active={state.quote} onClick={() => run().toggleBlockquote().run()}>
        <Icon.Quote size={18} />
      </ToolButton>
      <ToolButton label="Divider" onClick={() => run().setHorizontalRule().run()}>
        <Icon.Divider size={18} />
      </ToolButton>
      {variant === 'dispatch' && (
        <>
          <Separator />
          <MergeTagMenu editor={editor} channelId={channelId} />
        </>
      )}
      <Separator />
      <ToolButton
        label="Undo"
        shortcut={`${mod} Z`}
        disabled={!state.canUndo}
        onClick={() => run().undo().run()}
      >
        <Icon.Undo size={18} />
      </ToolButton>
      <ToolButton
        label="Redo"
        shortcut={mac ? '⇧⌘ Z' : 'Ctrl Y'}
        disabled={!state.canRedo}
        onClick={() => run().redo().run()}
      >
        <Icon.Redo size={18} />
      </ToolButton>
      {codeEmbeds && <CodeTools editor={editor} contents={variant === 'dispatch'} />}
      {extra}
      <div className="relative ml-auto">
        <button
          type="button"
          {...menu.buttonProps}
          title="Insert a block"
          onMouseDown={(e) => e.preventDefault()}
          className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-line-control pr-2.5 pl-[7px] text-[13px] font-semibold text-ink transition-colors hover:bg-surface-alt aria-expanded:border-purple aria-expanded:bg-purple aria-expanded:text-white"
        >
          <Icon.Plus size={16} />
          Insert
        </button>
        <div
          {...menu.panelProps}
          className="line-menu absolute top-[calc(100%+6px)] right-0 grid max-h-[min(460px,70vh)] w-[min(300px,calc(100vw-32px))] grid-cols-2 gap-0.5 overflow-y-auto"
        >
          {menu.open && <InsertPanel items={insert.items} onPick={() => menu.close()} />}
        </div>
      </div>
      {insert.dialogs}
    </div>
  );
}

/**
 * The "+" in the left gutter, level with the block holding the cursor (the first block until
 * the editor is used). It opens the same insert menu inline, next to where the block goes.
 */
function BodyGutter({
  editor,
  channelId,
  htmlAllowed,
  insertExtras,
}: {
  editor: Editor;
  channelId: string;
  htmlAllowed: boolean;
  insertExtras: InsertItem[];
}) {
  const insert = useInsertActions(editor, {
    channelId,
    htmlAllowed,
    variant: 'dispatch',
    extras: insertExtras,
  });
  const menu = useDisclosure();
  const slash = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const { $from, empty } = e.state.selection;
      if (!empty || $from.parent.type.name !== 'paragraph') return null;
      const line = $from.parent.textContent;
      return slashQuery(line, $from.parentOffset === line.length);
    },
  });
  const [picked, setPicked] = useState({ query: '', index: 0 });
  // Escape closes the menu for what's typed now; typing more, or a new "/", opens it again.
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (slash === null && dismissed !== null) setDismissed(null);
  const matches =
    slash === null || slash === dismissed ? [] : filterSlash(insert.items, slash ?? '');
  const slashOpen = slash !== null && matches.length > 0;
  const activeOption = useRef<HTMLLIElement>(null);
  // The highlight goes back to the top whenever the search changes.
  const slashIndex = picked.query === slash ? picked.index : 0;
  const pick = (item: InsertItem) => {
    // The typed command goes, then the block goes where it was.
    const { $from } = editor.state.selection;
    editor.chain().deleteRange({ from: $from.start(), to: $from.end() }).run();
    item.run();
  };
  useEffect(() => {
    activeOption.current?.scrollIntoView({ block: 'nearest' });
  }, [slashIndex, slashOpen]);
  useEffect(() => {
    if (slash === null || !matches.length) return;
    const dom = editor.view.dom;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setPicked({
          query: slash,
          index: (slashIndex + step + matches.length) % matches.length,
        });
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setDismissed(slash);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        const item = matches[slashIndex];
        if (item) pick(item);
      }
    };
    dom.addEventListener('keydown', onKey, true);
    return () => dom.removeEventListener('keydown', onKey, true);
  });
  const top = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const { $from } = e.state.selection;
      if ($from.depth < 1) return 0;
      const dom = e.view.nodeDOM($from.before(1));
      return dom instanceof HTMLElement ? dom.offsetTop : 0;
    },
  });
  return (
    <div className="absolute left-0 z-[5] sm:-left-[42px]" style={{ top: top ?? 0 }}>
      <button
        type="button"
        {...menu.buttonProps}
        aria-label="Insert a block"
        title="Insert a block"
        onMouseDown={(e) => e.preventDefault()}
        className="grid size-[30px] place-items-center rounded-full border border-line-control bg-surface text-sub transition-colors hover:border-purple hover:bg-purple hover:text-white aria-expanded:border-purple aria-expanded:bg-purple aria-expanded:text-white"
      >
        <Icon.Plus size={18} />
      </button>
      <div
        {...menu.panelProps}
        className="line-menu absolute top-9 left-0 grid max-h-[min(460px,70vh)] w-[min(300px,calc(100vw-32px))] grid-cols-2 gap-0.5 overflow-y-auto"
      >
        {menu.open && <InsertPanel items={insert.items} onPick={() => menu.close()} />}
      </div>
      {slashOpen && (
        <ul
          role="listbox"
          aria-label="Insert a block"
          // It scrolls, so the keyboard has to be able to reach it.
          tabIndex={0}
          className="line-menu absolute top-9 left-0 z-10 grid max-h-[320px] w-[min(260px,calc(100vw-32px))] gap-0.5 overflow-y-auto"
        >
          {matches.map((item, index) => {
            const ItemIcon = item.icon;
            return (
              // No button inside: an option can't hold another control. The keyboard stays in the
              // editor, which handles the arrows and Enter.
              <li
                key={item.id}
                ref={index === slashIndex ? activeOption : undefined}
                role="option"
                aria-selected={index === slashIndex}
                className={`line-menu-item w-full cursor-pointer ${index === slashIndex ? 'bg-lavender' : ''}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(item);
                }}
              >
                <ItemIcon size={18} className="shrink-0 text-sub" />
                <span className="min-w-0">{item.label}</span>
              </li>
            );
          })}
        </ul>
      )}
      {insert.dialogs}
    </div>
  );
}

function MergeTagMenu({ editor, channelId }: { editor: Editor; channelId: string }) {
  const fields = useQuery(memberFieldsQuery(channelId));
  return (
    <>
      <label htmlFor="merge-tag" className="sr-only">
        Insert a merge tag
      </label>
      <select
        id="merge-tag"
        value=""
        onChange={(event) => {
          if (event.target.value) editor.chain().focus().insertContent(event.target.value).run();
        }}
        className="line-input min-h-8! w-auto text-[13px]"
      >
        <option value="">Merge tag</option>
        {MERGE_TAGS.map((m) => (
          <option key={m.tag} value={m.tag}>
            {m.label}
          </option>
        ))}
        {fields.data
          ?.filter((field) => !field.encrypted)
          .map((field) => (
            <option key={field.key} value={`{{ field.${field.key} | }}`}>
              {field.label}
            </option>
          ))}
      </select>
    </>
  );
}

const isWebUrl = (value: string) => /^https?:\/\/[^\s]+\.[^\s]+/i.test(value.trim());
const isLinkUrl = (value: string) =>
  isWebUrl(value) || /^mailto:[^\s@]+@[^\s@]+$/i.test(value.trim());

function LinkDialog({
  editor,
  channelId,
  open,
  onClose,
}: {
  editor: Editor;
  channelId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [href, setHref] = useState(
    () => (editor.getAttributes('link').href as string | undefined) ?? '',
  );
  const [error, setError] = useState<string | undefined>();

  const apply = () => {
    const value = href.trim();
    if (!isLinkUrl(value)) {
      setError('Use a full web address starting with https://, or mailto:.');
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: value }).run();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Link"
      description="Links are rewritten to your link domain so clicks can be counted. The address is never exposed in the tracking link."
      actions={
        <>
          {editor.isActive('link') && (
            <Button
              variant="quiet"
              onClick={() => {
                editor.chain().focus().extendMarkRange('link').unsetLink().run();
                onClose();
              }}
            >
              Remove link
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="link-form">
            Apply
          </Button>
        </>
      }
    >
      <form
        id="link-form"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <TextField
          label="Web address"
          type="url"
          inputMode="url"
          value={href}
          placeholder="https://"
          onChange={(e) => setHref(e.target.value)}
          error={error}
        />
        <ShortenLinkButton channelId={channelId} href={href} onLink={setHref} />
      </form>
    </Dialog>
  );
}

function ImageDialog({
  editor,
  channelId,
  open,
  onClose,
}: {
  editor: Editor;
  channelId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState<MediaAsset | null>(null);
  const [alt, setAlt] = useState('');
  const [href, setHref] = useState('');
  const [widthPercent, setWidthPercent] = useState('');

  const close = () => {
    setChosen(null);
    setAlt('');
    setHref('');
    onClose();
  };

  const insert = () => {
    if (!chosen) return;
    editor
      .chain()
      .focus()
      .insertContent({
        type: 'image',
        attrs: {
          mediaId: chosen.id,
          src: chosen.url,
          alt: alt.trim(),
          href: isWebUrl(href) ? href.trim() : null,
          widthPercent: widthPercent ? Number(widthPercent) : null,
        },
      })
      .run();
    close();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add an image"
      description="Pick from this publication's media library or upload a new image."
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button disabled={!chosen} onClick={insert}>
            Insert image
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <MediaPicker
          channelId={channelId}
          enabled={open}
          chosen={chosen}
          onChoose={(asset) => {
            setChosen(asset);
            setAlt(asset.altText ?? '');
          }}
        />
        {chosen && (
          <>
            <TextField
              label="Alt text"
              value={alt}
              onChange={(e) => setAlt(e.target.value)}
              hint="Describe the image for people who can't see it. Required for accessible email."
            />
            <TextField
              label="Link (optional)"
              type="url"
              value={href}
              placeholder="https://"
              onChange={(e) => setHref(e.target.value)}
            />
            <SelectField
              label="Width"
              value={widthPercent}
              onChange={(e) => setWidthPercent(e.target.value)}
              options={[
                { value: '', label: 'Full width' },
                { value: '75', label: 'Three quarters' },
                { value: '50', label: 'Half' },
                { value: '25', label: 'A quarter' },
              ]}
            />
          </>
        )}
      </div>
    </Dialog>
  );
}

const fileName = (asset: MediaAsset) =>
  asset.altText || `File uploaded ${formatDateTime(asset.createdAt)}`;

/** A product goes into a post as an ordinary button, so it works in any mail client. */
function ProductDialog({
  editor,
  channelId,
  onClose,
}: {
  editor: Editor;
  channelId: string;
  onClose: () => void;
}) {
  const goods = useQuery(goodsQuery(channelId));
  const onSale = (goods.data ?? []).filter((g) => g.status === 'published');
  const insert = (good: Good) => {
    const price = good.prices[0];
    editor
      .chain()
      .focus()
      .insertContent({
        type: 'button',
        attrs: productButton(good, price ? formatMoney(price.amount, price.currency) : null),
      })
      .run();
    onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Add a product"
      description="Adds a button that leads to the product’s page."
      actions={
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      {goods.isPending && <LoadingRows label="Loading products" rows={2} />}
      {goods.error && <ErrorNotice message={goods.error.message} />}
      {goods.data && onSale.length === 0 && <p>You have no products on sale yet.</p>}
      <div className="grid gap-1">
        {onSale.map((good) => (
          <button
            key={good.id}
            type="button"
            onClick={() => insert(good)}
            className="rounded-[10px] border border-line-app px-3 py-2 text-left text-[13.5px] hover:bg-surface-alt"
          >
            {good.name}
          </button>
        ))}
      </div>
    </Dialog>
  );
}

/** An accepted sponsor goes in as a labelled link card, through the link that counts their clicks. */
function SponsorDialog({
  editor,
  channelId,
  onClose,
}: {
  editor: Editor;
  channelId: string;
  onClose: () => void;
}) {
  const bookings = useQuery(sponsorBookingsQuery(channelId));
  const accepted = (bookings.data?.items ?? []).filter((b) => b.status === 'accepted');
  const insert = (booking: SponsorBooking) => {
    editor
      .chain()
      .focus()
      .insertContent({ type: 'linkCard', attrs: sponsorCard(booking) })
      .run();
    onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Add a sponsor"
      description="Adds their ad as a link card marked Sponsored. Clicks count toward their report."
      actions={
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      {bookings.isPending && <LoadingRows label="Loading bookings" rows={2} />}
      {bookings.error && <ErrorNotice message={bookings.error.message} />}
      {bookings.data && accepted.length === 0 && <p>You have no accepted bookings.</p>}
      <div className="grid gap-1">
        {accepted.map((booking) => (
          <button
            key={booking.id}
            type="button"
            onClick={() => insert(booking)}
            className="rounded-[10px] border border-line-app px-3 py-2 text-left text-[13.5px] hover:bg-surface-alt"
          >
            {booking.sponsorName}: {booking.adTitle} ({booking.runOn})
          </button>
        ))}
      </div>
    </Dialog>
  );
}

function AttachmentDialog({
  editor,
  channelId,
  open,
  onClose,
}: {
  editor: Editor;
  channelId: string;
  open: boolean;
  onClose: () => void;
}) {
  const files = useQuery({ ...mediaQuery(channelId, '', 'file'), enabled: open });
  const upload = useUploadMedia(channelId);
  const [chosen, setChosen] = useState<MediaAsset | null>(null);
  const [name, setName] = useState('');

  const insert = () => {
    if (!chosen) return;
    editor
      .chain()
      .focus()
      .insertContent({
        type: 'attachment',
        attrs: { mediaId: chosen.id, name: name.trim() || fileName(chosen) },
      })
      .run();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Attach a file"
      description="Subscribers get a download link, not an attachment, so the email stays small and lands in the inbox. Deleting the file from the media library turns the link off."
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!chosen} onClick={insert}>
            Insert file
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <label className="btn-ghost btn-sm w-fit cursor-pointer">
          {upload.isPending ? 'Uploading…' : 'Upload a PDF'}
          <input
            type="file"
            accept="application/pdf"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                upload.mutate(file, {
                  onSuccess: (asset) => {
                    setChosen(asset);
                    setName(file.name.replace(/\.[a-z0-9]+$/i, ''));
                  },
                });
              }
              event.target.value = '';
            }}
          />
        </label>
        {upload.error && <ErrorNotice title="Upload failed" message={upload.error.message} />}
        {files.isPending && <LoadingRows label="Loading files" rows={1} />}
        {files.error && <ErrorNotice message={files.error.message} />}
        {files.data && files.data.length > 0 && (
          <div role="radiogroup" aria-label="Files" className="grid max-h-48 gap-1 overflow-y-auto">
            {files.data.map((asset) => (
              <button
                key={asset.id}
                type="button"
                role="radio"
                aria-checked={chosen?.id === asset.id}
                onClick={() => {
                  setChosen(asset);
                  setName(asset.altText ?? '');
                }}
                className={`rounded-[10px] border px-3 py-2 text-left text-[13.5px] ${chosen?.id === asset.id ? 'border-purple bg-lavender' : 'border-line-app'}`}
              >
                {fileName(asset)}{' '}
                <span className="text-sub">
                  · {numberFormat.format(Math.max(1, Math.round(asset.bytes / 1024)))} KB
                </span>
              </button>
            ))}
          </div>
        )}
        {files.data && files.data.length === 0 && !upload.isPending && !chosen && (
          <p className="text-[13px] text-sub">No files yet. Upload a PDF to attach it.</p>
        )}
        {chosen && (
          <TextField
            label="Link text"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            hint="What subscribers see, for example “May report”."
          />
        )}
      </div>
    </Dialog>
  );
}

const HTML_LIMIT = 50_000;

interface Snippet {
  id: string;
  name: string;
  content: DispatchDocument;
  updatedAt: string;
}

/**
 * Lets the snippet blocks of an editor open the snippet dialog. The dialog sits outside the editor
 * it belongs to, so typing in it never reaches the post.
 */
export function SnippetTools({ channelId, children }: { channelId: string; children: ReactNode }) {
  const [editing, setEditing] = useState<string | null>(null);
  const value = useMemo(() => ({ channelId, editSnippet: setEditing }), [channelId]);
  return (
    <SnippetEditorContext.Provider value={value}>
      {children}
      {editing && (
        <SnippetEditDialog
          channelId={channelId}
          snippetId={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </SnippetEditorContext.Provider>
  );
}

const SNIPPET_EDIT_NOTE =
  'Saving changes every post that uses this snippet on your website, past posts included, and every email that starts sending after this. Emails already sent stay as they were. Automation emails change the next time you publish the automation.';

/** Changes a snippet's name and content, and says what that changes. */
function SnippetEditDialog({
  channelId,
  snippetId,
  onClose,
}: {
  channelId: string;
  snippetId: string;
  onClose: () => void;
}) {
  const detail = useQuery(snippetQuery(channelId, snippetId));
  if (detail.data) {
    return <SnippetEditForm channelId={channelId} snippet={detail.data} onClose={onClose} />;
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title="Edit snippet"
      description={SNIPPET_EDIT_NOTE}
      actions={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      {detail.isPending && <LoadingRows label="Loading the snippet" />}
      {detail.error && <p className="text-[13px] text-danger-ink">{detail.error.message}</p>}
    </Dialog>
  );
}

function SnippetEditForm({
  channelId,
  snippet,
  onClose,
}: {
  channelId: string;
  snippet: SnippetDetail;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [name, setName] = useState(snippet.name);
  const htmlAllowed = useChannelFlag(channelId, 'raw_html_mode') === true;
  const editor = useEditor({
    extensions: dispatchExtensions({ placeholder: 'Write the snippet…' }),
    content: snippet.content,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'dispatch-prose',
        'aria-label': 'Snippet content',
        'aria-multiline': 'true',
        role: 'textbox',
      },
    },
  });
  const save = useMutation({
    mutationFn: () =>
      api.put<Snippet>(`/api/v1/channels/${channelId}/snippets/${snippet.id}`, {
        name: name.trim(),
        content: editor?.getJSON(),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['snippets', channelId] });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Edit snippet"
      description={SNIPPET_EDIT_NOTE}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim() || !editor}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            Save snippet
          </Button>
        </>
      }
    >
      <div className="grid gap-3 pt-2">
        <p className="text-[13px] font-semibold">{usageSentence(snippet.usage)}</p>
        <TextField
          label="Name"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {editor && (
          <div className="overflow-hidden rounded-card-app border border-line-app">
            <Toolbar
              editor={editor}
              channelId={channelId}
              htmlAllowed={htmlAllowed}
              variant="page"
              snippets={false}
            />
            <div className="px-3 py-2">
              <EditorContent editor={editor} />
            </div>
          </div>
        )}
        {save.error && <p className="text-[13px] text-danger-ink">{save.error.message}</p>}
      </div>
    </Dialog>
  );
}

/** Asks before deleting a snippet, with what that does to the posts using it. */
function SnippetDeleteRow({
  channelId,
  snippet,
  onCancel,
  onDeleted,
}: {
  channelId: string;
  snippet: Snippet;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const detail = useQuery(snippetQuery(channelId, snippet.id));
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/v1/channels/${channelId}/snippets/${snippet.id}`),
    onSuccess: onDeleted,
  });
  return (
    <li className="grid gap-2 rounded-control bg-warn-soft p-3 text-[13px] text-warn">
      <p>
        Delete {snippet.name}? {detail.data ? `${usageSentence(detail.data.usage)} ` : ''}Those
        posts will show nothing in its place. Emails already sent and copies stay as they are.
      </p>
      {remove.error && <p className="text-danger-ink">{remove.error.message}</p>}
      <span className="flex gap-1">
        <Button size="sm" variant="danger" onClick={() => remove.mutate()}>
          Delete snippet
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Keep it
        </Button>
      </span>
    </li>
  );
}

/** Inserts a saved block, linked or as a copy, or saves what's selected as a new one. */
function SnippetDialog({
  editor,
  channelId,
  onClose,
}: {
  editor: Editor;
  channelId: string;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const base = `/api/v1/channels/${channelId}/snippets`;
  const queryKey = ['snippets', channelId];
  const list = useQuery({
    queryKey,
    queryFn: ({ signal }) => api.get<Snippet[]>(base, signal),
  });
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const hasSelection = !editor.state.selection.empty;
  const save = useMutation({
    mutationFn: () => {
      const slice = editor.state.selection.content().toJSON() as { content?: unknown[] };
      return api.post<Snippet>(base, {
        name: name.trim(),
        content: { type: 'doc', content: slice.content ?? [] },
      });
    },
    onSuccess: async () => {
      setName('');
      await client.invalidateQueries({ queryKey });
    },
  });
  const insertCopy = (snippet: Snippet) => {
    editor
      .chain()
      .focus()
      .insertContent((snippet.content.content ?? []) as JSONContent[])
      .run();
    onClose();
  };
  const insertLinked = (snippet: Snippet) => {
    insertSnippet(editor, snippet.id);
    onClose();
  };
  if (editing) {
    return (
      <SnippetEditDialog
        channelId={channelId}
        snippetId={editing}
        onClose={() => setEditing(null)}
      />
    );
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title="Snippets"
      description="Blocks you reuse, such as a sign-off. Insert links the post to the snippet, so editing the snippet updates the post. Insert a copy gives this post its own version."
      actions={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="grid gap-4">
        {list.isPending && <LoadingRows label="Loading snippets" />}
        {list.error && <ErrorNotice message={list.error.message} />}
        {list.data?.length === 0 && (
          <p className="text-[13px] text-sub">
            No snippets yet. Select some of your post, then save it here.
          </p>
        )}
        <ul className="grid gap-2">
          {list.data?.map((snippet) =>
            deleting === snippet.id ? (
              <SnippetDeleteRow
                key={snippet.id}
                channelId={channelId}
                snippet={snippet}
                onCancel={() => setDeleting(null)}
                onDeleted={() => {
                  setDeleting(null);
                  void client.invalidateQueries({ queryKey });
                }}
              />
            ) : (
              <li key={snippet.id} className="grid gap-1 text-[13.5px]">
                <span className="min-w-0 truncate font-semibold">{snippet.name}</span>
                <span className="flex flex-wrap gap-1">
                  {/* A snippet saved before these rules can hold what a link can't carry. */}
                  {!snippetContentProblem(snippet.content) && editor.schema.nodes.snippet && (
                    <Button
                      size="sm"
                      onClick={() => insertLinked(snippet)}
                      aria-label={`Insert ${snippet.name}`}
                    >
                      Insert
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => insertCopy(snippet)}
                    aria-label={`Insert a copy of ${snippet.name}`}
                  >
                    Insert a copy
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditing(snippet.id)}
                    aria-label={`Edit ${snippet.name}`}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDeleting(snippet.id)}
                    aria-label={`Delete ${snippet.name}`}
                  >
                    Delete
                  </Button>
                </span>
              </li>
            ),
          )}
        </ul>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (hasSelection && name.trim()) save.mutate();
          }}
        >
          <div className="min-w-[200px] flex-1">
            <TextField
              label="Save the selected text as"
              maxLength={80}
              value={name}
              disabled={!hasSelection}
              onChange={(e) => setName(e.target.value)}
              hint={hasSelection ? undefined : 'Select part of your post first.'}
              error={save.error instanceof ApiError ? save.error.message : undefined}
            />
          </div>
          <Button type="submit" variant="ghost" disabled={!hasSelection || !name.trim()}>
            Save
          </Button>
        </form>
      </div>
    </Dialog>
  );
}

function EmbedDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [url, setUrl] = useState('');
  const info = embedInfo(url.trim());
  const apply = () => {
    if (!info) return;
    editor
      .chain()
      .focus()
      .insertContent({ type: 'embed', attrs: { url: url.trim() } })
      .run();
    onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Embed"
      description="Paste a link from YouTube, X, Spotify, Bluesky or Vimeo. It shows as a card that opens there. On your website, readers can also play YouTube, Vimeo and Spotify links in the page."
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!info} onClick={apply}>
            Insert
          </Button>
        </>
      }
    >
      <TextField
        label="Link"
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        hint={info ? info.action : undefined}
        error={url.trim() && !info ? 'That link isn’t from one of these services.' : undefined}
      />
    </Dialog>
  );
}

function FootnoteDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [text, setText] = useState('');
  const apply = () => {
    if (!text.trim()) return;
    editor
      .chain()
      .focus()
      .insertContent({ type: 'footnote', attrs: { text: text.trim() } })
      .run();
    onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Footnote"
      description="Adds a number here and lists the note at the end of the post."
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!text.trim()} onClick={apply}>
            Insert
          </Button>
        </>
      }
    >
      <TextAreaField
        label="Note"
        rows={3}
        maxLength={1000}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </Dialog>
  );
}

function HtmlDialog({
  editor,
  open,
  onClose,
}: {
  editor: Editor;
  open: boolean;
  onClose: () => void;
}) {
  const editing = editor.isActive('htmlBlock');
  const [html, setHtml] = useState(() =>
    editing ? String(editor.getAttributes('htmlBlock').html ?? '') : '',
  );
  const tooLong = html.length > HTML_LIMIT;

  const apply = () => {
    if (!html.trim() || tooLong) return;
    const chain = editor.chain().focus();
    if (editing) chain.updateAttributes('htmlBlock', { html }).run();
    else chain.insertContent({ type: 'htmlBlock', attrs: { html } }).run();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Raw HTML"
      description="Sent exactly as written, so check it in the preview. Links in raw HTML aren't counted. The checks in the side panel flag broken links, missing alt text and dark-mode problems."
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!html.trim() || tooLong} onClick={apply}>
            {editing ? 'Update' : 'Insert'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <TextAreaField
          label="HTML"
          rows={8}
          value={html}
          onChange={(e) => setHtml(e.target.value)}
          className="font-mono text-[12.5px]"
          error={
            tooLong ? `Keep it under ${numberFormat.format(HTML_LIMIT)} characters.` : undefined
          }
        />
        <div>
          <p className="mb-1.5 text-[13px] font-semibold text-ink">Preview</p>
          {/* No scripts, no same-origin access, no forms: the preview can only paint. */}
          <iframe
            title="Raw HTML preview"
            sandbox=""
            srcDoc={html}
            className="h-48 w-full rounded-[10px] border border-line-app bg-white"
          />
        </div>
      </div>
    </Dialog>
  );
}

function BlockDialog({
  editor,
  channelId,
  kind,
  open,
  onClose,
}: {
  editor: Editor;
  channelId: string;
  kind: 'button' | 'linkCard';
  open: boolean;
  onClose: () => void;
}) {
  const editing = editor.isActive(kind);
  const [attrs] = useState(() =>
    editing ? (editor.getAttributes(kind) as Record<string, string>) : {},
  );
  const [href, setHref] = useState(attrs.href ?? '');
  const [text, setText] = useState((kind === 'button' ? attrs.label : attrs.title) ?? '');
  const [description, setDescription] = useState(attrs.description ?? '');
  const [error, setError] = useState<string | undefined>();

  const apply = () => {
    if (!isWebUrl(href)) {
      setError('Use a full web address starting with https://.');
      return;
    }
    if (kind === 'button' && !text.trim()) {
      setError('Give the button a label.');
      return;
    }
    const attrs =
      kind === 'button'
        ? { href: href.trim(), label: text.trim() }
        : { href: href.trim(), title: text.trim(), description: description.trim() };
    if (editing) editor.chain().focus().updateAttributes(kind, attrs).run();
    else editor.chain().focus().insertContent({ type: kind, attrs }).run();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={kind === 'button' ? 'Button' : 'Link card'}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={`${kind}-form`}>
            {editing ? 'Update' : 'Insert'}
          </Button>
        </>
      }
    >
      <form
        id={`${kind}-form`}
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <TextField
          label={kind === 'button' ? 'Label' : 'Title (optional)'}
          maxLength={80}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <TextField
          label="Web address"
          type="url"
          value={href}
          placeholder="https://"
          onChange={(e) => setHref(e.target.value)}
          error={error}
        />
        <ShortenLinkButton channelId={channelId} href={href} onLink={setHref} />
        {kind === 'linkCard' && (
          <TextAreaField
            label="Description (optional)"
            maxLength={200}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        )}
      </form>
    </Dialog>
  );
}

// ---- History --------------------------------------------------------------------------------

function Revisions({
  dispatch,
  canWrite,
  flush,
  onReplaced,
}: {
  dispatch: Dispatch;
  canWrite: boolean;
  flush: () => Promise<unknown>;
  onReplaced: () => void;
}) {
  const client = useQueryClient();
  const revisions = useQuery(revisionsQuery(dispatch.id));
  const name = useNameRevision(dispatch.id);
  const restore = useRestoreRevision(dispatch.id);
  const [label, setLabel] = useState('');
  const [comparing, setComparing] = useState<DispatchRevision | null>(null);
  return (
    <Section
      title="History"
      description="Every save is kept. Quick saves in a row count as one version."
    >
      {canWrite && (
        <form
          className="mb-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (label.trim()) name.mutate(label.trim(), { onSuccess: () => setLabel('') });
          }}
        >
          <label htmlFor="snapshot-name" className="sr-only">
            Name this version
          </label>
          <input
            id="snapshot-name"
            value={label}
            maxLength={80}
            placeholder="Name this version"
            onChange={(e) => setLabel(e.target.value)}
            className="h-9 min-w-0 flex-1 rounded-control border border-line-control bg-surface px-3 text-[13px] focus-visible:outline-2 focus-visible:outline-purple"
          />
          <Button type="submit" variant="ghost" size="sm" loading={name.isPending}>
            Save
          </Button>
        </form>
      )}
      {revisions.isPending && <LoadingRows label="Loading history" rows={2} />}
      <ul className="grid max-h-72 gap-1 overflow-y-auto text-[13px]">
        {revisions.data?.map((revision, index) => (
          <li
            key={revision.id}
            className="flex items-center justify-between gap-2 rounded-[10px] px-2 py-1.5 hover:bg-surface-alt"
          >
            <span className="min-w-0">
              <span className="block truncate font-semibold">
                {revision.name ??
                  (index === 0 ? 'Current version' : formatDateTime(revision.updatedAt))}
              </span>
              <span className="block truncate text-[12px] text-sub">
                {revision.name && `${formatDateTime(revision.updatedAt)} · `}
                {revision.createdBy?.email ?? 'Unknown'}
              </span>
            </span>
            {revision.name && <Pill tone="brand">Named</Pill>}
            {index > 0 && (
              <Button variant="quiet" size="sm" onClick={() => setComparing(revision)}>
                Compare
              </Button>
            )}
            {canWrite && index > 0 && (
              <Button
                variant="quiet"
                size="sm"
                loading={restore.isPending && restore.variables === revision.id}
                onClick={() =>
                  // Save pending edits first, so they can't overwrite the restored version.
                  void flush().then(
                    () =>
                      restore.mutate(revision.id, {
                        onSuccess: (restored) => {
                          client.setQueryData(sendKeys.dispatch(dispatch.id), restored);
                          onReplaced();
                        },
                      }),
                    // A failed save shows on the page. Restoring now could lose those edits.
                    () => undefined,
                  )
                }
              >
                Restore
              </Button>
            )}
          </li>
        ))}
      </ul>
      {restore.error && <ErrorNotice message={restore.error.message} />}
      {comparing && (
        <CompareDialog
          dispatch={dispatch}
          revision={comparing}
          onClose={() => setComparing(null)}
        />
      )}
    </Section>
  );
}

const DIFF_STYLE = {
  same: 'text-sub',
  added: 'bg-success-soft text-ink',
  removed: 'bg-danger-soft text-ink line-through decoration-danger/60',
} as const;
const DIFF_MARK = { same: ' ', added: '+', removed: '−' } as const;

function CompareDialog({
  dispatch,
  revision,
  onClose,
}: {
  dispatch: Dispatch;
  revision: DispatchRevision;
  onClose: () => void;
}) {
  const detail = useQuery(revisionQuery(dispatch.id, revision.id));
  const lines = detail.data
    ? diffLines(
        [
          `Subject: ${detail.data.subject}`,
          `Preview text: ${detail.data.preheader}`,
          coverCompareLine(detail.data.coverImage),
          ...documentLines(detail.data.content),
        ],
        [
          `Subject: ${dispatch.subject}`,
          `Preview text: ${dispatch.preheader}`,
          coverCompareLine(dispatch.coverImage),
          ...documentLines(dispatch.content),
        ],
      )
    : [];
  const changes = lines.filter((line) => line.kind !== 'same').length;
  return (
    <Dialog
      open
      onClose={onClose}
      title="Compare with the current version"
      description={`${revision.name ?? formatDateTime(revision.updatedAt)} on the left of each change, the current version after it.`}
      actions={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      {detail.isPending && <LoadingRows label="Loading version" rows={3} />}
      {detail.error && <ErrorNotice message={detail.error.message} />}
      {detail.data && changes === 0 && (
        <p className="text-[13.5px] text-sub">No differences in the text.</p>
      )}
      {detail.data && changes > 0 && (
        <ol
          aria-label={`${changes} changed lines`}
          className="grid max-h-96 gap-px overflow-y-auto rounded-[10px] border border-line-app font-mono text-[12.5px]"
        >
          {lines.map((line, index) => (
            <li key={index} className={`flex gap-2 px-3 py-1 ${DIFF_STYLE[line.kind]}`}>
              <span aria-hidden="true" className="w-3 shrink-0 select-none">
                {DIFF_MARK[line.kind]}
              </span>
              <span className="sr-only">
                {line.kind === 'added' ? 'Added: ' : line.kind === 'removed' ? 'Removed: ' : ''}
              </span>
              <span className="min-w-0 break-words whitespace-pre-wrap">{line.text || ' '}</span>
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}
