// The Dispatch editor's Phase 6 tools: Smart Blocks (flag smart_blocks) with their condition
// dialog and "Preview as a Member", and one-tap Ask polls. Editor.tsx mounts these through
// useGrowthEditor(); the nodes themselves are in ./growthNodes.
import type {
  Ask,
  CircleGroup,
  CircleRule,
  Dispatch,
  Member,
  SmartBlockAttrs,
} from '@swarm/domain';
import { Button, Dialog, EmptyState, ErrorNotice, LoadingRows, Pill } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { useCallback, useId, useMemo, useState, type ReactNode } from 'react';
import { allCirclesQuery, memberFieldsQuery, tagsQuery, useDebounced } from '../api/circles';
import {
  asksQuery,
  dispatchPreviewQuery,
  isFeatureDisabled,
  smartBlocksProbeQuery,
} from '../api/growth';
import { membersQuery } from '../api/members';
import { useChannelFlag } from '../api/queries';
import { levelsQuery } from '../api/money';
import { RuleEditor } from '../circles/RuleEditor';
import {
  asRootGroup,
  comparatorLabel,
  choiceName,
  fieldCatalogue,
  findField,
  isGroup,
  membershipLeaves,
  newCondition,
  validateRule,
  type FieldSpec,
} from '../circles/rules';
import {
  ASK_POLL,
  GrowthEditorContext,
  countSmartBlocks,
  currentSmartBlock,
  insertAskPoll,
  unwrapSmartBlock,
  updateNodeAttrs,
  wrapInSmartBlock,
  type GrowthEditorValue,
} from './growthNodes';
import { Section } from '../pages/common';

// ---- Conditions ----------------------------------------------------------------------------

/** Every field a Smart Block condition can test: the Circle catalogue plus Circles and levels. */
function useConditionCatalogue(channelId: string): readonly FieldSpec[] {
  const fields = useQuery(memberFieldsQuery(channelId));
  const tags = useQuery(tagsQuery(channelId));
  const circles = useQuery(allCirclesQuery(channelId));
  const levels = useQuery(levelsQuery(channelId));
  const engagementScores = useChannelFlag(channelId, 'engagement_scores') === true;
  return useMemo(
    () => [
      ...fieldCatalogue(fields.data ?? [], tags.data ?? [], { engagementScores }),
      ...membershipLeaves(
        circles.data ?? [],
        (levels.data?.items ?? []).map((l) => ({ id: l.id, name: l.name })),
      ),
    ],
    [fields.data, tags.data, circles.data, levels.data, engagementScores],
  );
}

const OP_WORD: Record<CircleGroup['op'], string> = { and: ' and ', or: ' or ', not: '' };

/** "Status is Active and In Circle is Readers": short, for the editor and the preview. */
function describeRule(rule: CircleRule, catalogue: readonly FieldSpec[], depth = 0): string {
  if (isGroup(rule)) {
    const parts = rule.children.map((child) => describeRule(child, catalogue, depth + 1));
    if (rule.op === 'not') return `not (${parts.join('')})`;
    const joined = parts.join(OP_WORD[rule.op]);
    return depth > 0 && parts.length > 1 ? `(${joined})` : joined || 'no conditions';
  }
  const spec = findField(catalogue, rule.field);
  const label = spec?.label ?? rule.field;
  const cmp = comparatorLabel(spec, rule.cmp);
  const value = rule.value;
  const text = Array.isArray(value)
    ? value.map((v) => choiceName(spec, String(v))).join(', ')
    : value === undefined || value === null
      ? ''
      : typeof value === 'boolean'
        ? value
          ? 'yes'
          : 'no'
        : choiceName(spec, String(value));
  return `${label} ${cmp}${text ? ` ${text}` : ''}`;
}

// ---- Hook used by the editor ---------------------------------------------------------------

type Open =
  | { kind: 'smart-block'; pos: number | null }
  | { kind: 'poll'; pos: number | null }
  | { kind: 'preview' }
  | null;

/**
 * Wires the Phase 6 tools into a Dispatch editor. Returns the context for the editor's node views,
 * the toolbar buttons, and the dialogs to render.
 */
export function useGrowthEditor(editor: Editor | null, dispatch: Dispatch, canWrite: boolean) {
  const catalogue = useConditionCatalogue(dispatch.channelId);
  const flag = useChannelFlag(dispatch.channelId, 'smart_blocks');
  // Without the flags, fall back to probing: only feature_disabled means off, and a render
  // problem in the draft doesn't hide the tools.
  const probe = useQuery({ ...smartBlocksProbeQuery(dispatch.id), enabled: flag === null });
  const smartBlocksOn =
    typeof flag === 'boolean'
      ? flag
      : probe.isSuccess || (!!probe.error && !isFeatureDisabled(probe.error));
  const [open, setOpen] = useState<Open>(null);

  const describe = useCallback((rule: CircleRule) => describeRule(rule, catalogue), [catalogue]);
  const context = useMemo<GrowthEditorValue>(
    () => ({
      describe,
      ...(canWrite
        ? {
            editSmartBlock: (pos: number) => setOpen({ kind: 'smart-block', pos }),
            editAskPoll: (pos: number) => setOpen({ kind: 'poll', pos }),
          }
        : {}),
    }),
    [describe, canWrite],
  );

  const tools =
    editor && canWrite ? (
      <GrowthToolButtons
        editor={editor}
        smartBlocks={smartBlocksOn}
        onSmartBlock={() => {
          const current = currentSmartBlock(editor);
          setOpen({ kind: 'smart-block', pos: current?.pos ?? null });
        }}
        onPoll={() => setOpen({ kind: 'poll', pos: null })}
      />
    ) : null;

  const dialogs = (
    <>
      {editor && open?.kind === 'smart-block' && (
        <SmartBlockDialog
          editor={editor}
          pos={open.pos}
          catalogue={catalogue}
          onClose={() => setOpen(null)}
        />
      )}
      {editor && open?.kind === 'poll' && (
        <AskPollDialog
          editor={editor}
          channelId={dispatch.channelId}
          pos={open.pos}
          onClose={() => setOpen(null)}
        />
      )}
      {open?.kind === 'preview' && (
        <PreviewAsMemberDialog
          dispatch={dispatch}
          describe={describe}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );

  return {
    context,
    tools,
    dialogs,
    smartBlocksOn,
    openPreview: () => setOpen({ kind: 'preview' }),
    /** For the editor's insert menu: wrap the current blocks in a Smart Block (or edit it). */
    insertSmartBlock: () => {
      if (!editor) return;
      const current = currentSmartBlock(editor);
      setOpen({ kind: 'smart-block', pos: current?.pos ?? null });
    },
    insertPoll: () => setOpen({ kind: 'poll', pos: null }),
  };
}

/** Wraps the editor so its node views can describe conditions and open the dialogs. */
export function GrowthEditorProvider({
  value,
  children,
}: {
  value: GrowthEditorValue;
  children: ReactNode;
}) {
  return <GrowthEditorContext.Provider value={value}>{children}</GrowthEditorContext.Provider>;
}

function GrowthToolButtons({
  editor,
  smartBlocks,
  onSmartBlock,
  onPoll,
}: {
  editor: Editor;
  smartBlocks: boolean;
  onSmartBlock: () => void;
  onPoll: () => void;
}) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      inSmartBlock: !!currentSmartBlock(e),
      poll: e.isActive(ASK_POLL),
    }),
  });
  const cls = (active: boolean) =>
    `grid h-8 min-w-8 place-items-center rounded-[8px] px-1.5 text-[13px] font-semibold ${
      active ? 'bg-lavender text-purple-deep' : 'text-sub hover:bg-surface-alt hover:text-ink'
    }`;
  return (
    <>
      {smartBlocks && (
        <button
          type="button"
          title={state.inSmartBlock ? 'Edit smart block' : 'Smart block'}
          aria-pressed={state.inSmartBlock}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onSmartBlock}
          className={cls(state.inSmartBlock)}
        >
          {state.inSmartBlock ? 'Edit smart block' : 'Smart block'}
        </button>
      )}
      <button
        type="button"
        title="Insert a poll"
        aria-pressed={state.poll}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onPoll}
        className={cls(state.poll)}
      >
        Poll
      </button>
    </>
  );
}

// ---- Smart Block dialog --------------------------------------------------------------------

function SmartBlockDialog({
  editor,
  pos,
  catalogue,
  onClose,
}: {
  editor: Editor;
  pos: number | null;
  catalogue: readonly FieldSpec[];
  onClose: () => void;
}) {
  const existing = pos === null ? null : editor.state.doc.nodeAt(pos);
  const attrs = (existing?.attrs ?? {}) as Partial<SmartBlockAttrs>;
  const [label, setLabel] = useState(attrs.label ?? '');
  const [anonymous, setAnonymous] = useState<'hide' | 'show'>(attrs.anonymous ?? 'hide');
  const [rule, setRule] = useState<CircleGroup>(() =>
    attrs.condition
      ? asRootGroup(attrs.condition as CircleRule)
      : { op: 'and', children: [newCondition(catalogue, 'circle')] },
  );
  const [submitted, setSubmitted] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const errors = useMemo(() => validateRule(rule, catalogue), [rule, catalogue]);
  const invalid = Object.keys(errors).length > 0;
  const labelId = useId();
  const anonymousName = useId();

  const save = () => {
    setSubmitted(true);
    if (invalid) return;
    const next: SmartBlockAttrs = {
      condition: rule,
      anonymous,
      ...(label.trim() ? { label: label.trim() } : {}),
    };
    if (existing && pos !== null) {
      updateNodeAttrs(editor, pos, { ...next, label: label.trim() || null });
      onClose();
      return;
    }
    if (countSmartBlocks(editor) >= 20) {
      setProblem('A post can have up to 20 smart blocks.');
      return;
    }
    if (!wrapInSmartBlock(editor, next)) {
      setProblem(
        'The selection holds a paywall break, a poll or another smart block, which can’t go inside one. Put the cursor in a paragraph and try again.',
      );
      return;
    }
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={existing ? 'Edit smart block' : 'Add a smart block'}
      description={
        existing
          ? 'Subscribers who match the condition when the send starts see this block; everyone else gets the post without it.'
          : 'The blocks around the cursor (or the selected ones) go inside. Only subscribers who match the condition when the send starts see them.'
      }
      actions={
        <>
          {existing && pos !== null && (
            <Button
              variant="quiet"
              onClick={() => {
                unwrapSmartBlock(editor, pos);
                onClose();
              }}
            >
              Remove smart block, keep its content
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save}>{existing ? 'Update' : 'Add smart block'}</Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-1.5">
          <label htmlFor={labelId} className="text-[13px] font-semibold">
            Label (optional)
          </label>
          <input
            id={labelId}
            value={label}
            maxLength={80}
            placeholder="For example “Paid subscribers only”"
            onChange={(e) => setLabel(e.target.value)}
            className="min-h-11 rounded-control border border-line-control px-3.5 text-[14px] hover:border-line-control-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-purple"
          />
          <p className="text-[12.5px] text-sub">Only your team sees it, in the editor.</p>
        </div>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-[13px] font-semibold">Show it to subscribers where</legend>
          <RuleEditor
            root={rule}
            onChange={setRule}
            catalogue={catalogue}
            errors={submitted ? errors : {}}
          />
        </fieldset>
        <fieldset className="grid gap-1.5">
          <legend className="mb-1 text-[13px] font-semibold">
            On the website, readers who aren’t signed in
          </legend>
          {(
            [
              ['hide', 'Don’t see it'],
              ['show', 'See it'],
            ] as const
          ).map(([value, text]) => (
            <label key={value} className="flex min-h-9 items-center gap-2 text-[13.5px]">
              <input
                type="radio"
                name={anonymousName}
                className="size-4 accent-purple"
                checked={anonymous === value}
                onChange={() => setAnonymous(value)}
              />
              {text}
            </label>
          ))}
        </fieldset>
        {problem && <ErrorNotice title="Not added" message={problem} />}
      </div>
    </Dialog>
  );
}

// ---- Poll picker ---------------------------------------------------------------------------

/** Open Asks' choice questions, the ones a one-tap poll can point at. */
function pollChoices(asks: readonly Ask[]) {
  return asks
    .filter((ask) => ask.status === 'open')
    .flatMap((ask) =>
      ask.questions
        .filter((q) => q.kind === 'choice' && q.options.length >= 2)
        .map((q) => ({ ask, question: q })),
    );
}

function AskPollDialog({
  editor,
  channelId,
  pos,
  onClose,
}: {
  editor: Editor;
  channelId: string;
  pos: number | null;
  onClose: () => void;
}) {
  const asks = useQuery(asksQuery(channelId));
  const existing = pos === null ? null : editor.state.doc.nodeAt(pos);
  const [chosen, setChosen] = useState<string>(
    existing ? `${String(existing.attrs.askId)}:${String(existing.attrs.questionId)}` : '',
  );
  const choices = pollChoices(asks.data ?? []);
  const drafts = (asks.data ?? []).filter((a) => a.status === 'draft').length;
  const groupName = useId();

  const insert = () => {
    const [askId, questionId] = chosen.split(':');
    if (!askId || !questionId) return;
    if (existing && pos !== null) updateNodeAttrs(editor, pos, { askId, questionId });
    else insertAskPoll(editor, { askId, questionId });
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={existing ? 'Change the poll' : 'Insert a poll'}
      description="Each option becomes a one-tap link in the email. Answers are recorded on the page the link opens, one per subscriber."
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!chosen} onClick={insert}>
            {existing ? 'Update' : 'Insert poll'}
          </Button>
        </>
      }
    >
      {asks.isPending && <LoadingRows label="Loading polls and surveys" rows={2} />}
      {asks.error && <ErrorNotice message={asks.error.message} />}
      {asks.data && choices.length === 0 && (
        <EmptyState
          title="No open polls"
          action={
            <Link to="/growth/$channelId/ask" params={{ channelId }} className="btn-ghost btn-sm">
              Go to polls & surveys
            </Link>
          }
        >
          A poll uses a choice question from an open poll or survey.
          {drafts > 0 && ` ${drafts} ${drafts === 1 ? 'draft is' : 'drafts are'} waiting to open.`}
        </EmptyState>
      )}
      {choices.length > 0 && (
        <fieldset className="grid max-h-72 gap-1.5 overflow-y-auto">
          <legend className="sr-only">Question</legend>
          {choices.map(({ ask, question }) => {
            const value = `${ask.id}:${question.id}`;
            return (
              <label
                key={value}
                className={`flex cursor-pointer items-start gap-2.5 rounded-card-app border px-3 py-2.5 text-[13.5px] ${
                  chosen === value ? 'border-purple bg-lavender' : 'border-line-app'
                }`}
              >
                <input
                  type="radio"
                  name={groupName}
                  className="mt-0.5 size-4 accent-purple"
                  checked={chosen === value}
                  onChange={() => setChosen(value)}
                />
                <span className="min-w-0 font-semibold">
                  {question.prompt}
                  <span className="block text-[12.5px] font-normal text-sub">
                    {ask.title} · {question.options.map((o) => o.label).join(', ')}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>
      )}
    </Dialog>
  );
}

// ---- Side panel: Smart Blocks and preview as a Member ---------------------------------------

export function SmartBlocksPanel({
  editor,
  onPreview,
}: {
  editor: Editor | null;
  onPreview: () => void;
}) {
  const count = useEditorState({
    editor,
    selector: ({ editor: e }) => (e ? countSmartBlocks(e) : 0),
  });
  return (
    <Section
      title="Smart blocks"
      description="Parts of the post shown only to subscribers who match a condition."
    >
      <p className="mb-3 text-[13.5px]">
        {count === 0
          ? 'None yet. Put the cursor in a paragraph and choose Smart block in the toolbar.'
          : `${count} smart block${count === 1 ? '' : 's'} in this post.`}
      </p>
      <Button variant="ghost" size="sm" onClick={onPreview}>
        Preview as a subscriber
      </Button>
    </Section>
  );
}

function PreviewAsMemberDialog({
  dispatch,
  describe,
  onClose,
}: {
  dispatch: Dispatch;
  describe: (rule: CircleRule) => string;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const query = useDebounced(q, 250);
  const [member, setMember] = useState<Member | null>(null);
  const members = useQuery({
    ...membersQuery(dispatch.channelId, { q: query }),
    enabled: !member,
  });
  const preview = useQuery(dispatchPreviewQuery(dispatch.id, member?.id ?? null));
  const searchId = useId();
  const conditions = useMemo(
    () =>
      dispatch.content.content
        .filter((node) => node.type === 'smartBlock')
        .map((node) => (node.attrs as { condition?: CircleRule } | undefined)?.condition),
    [dispatch.content],
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title="Preview as a subscriber"
      description="The saved version as this subscriber would get it right now. Links are not tracked."
      actions={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="grid gap-3">
        {member ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-card-app bg-surface-alt px-3 py-2 text-[13.5px]">
            <span className="min-w-0 truncate">
              As <b className="font-mono text-[12.5px]">{member.email}</b>
            </span>
            <Button variant="quiet" size="sm" onClick={() => setMember(null)}>
              Choose another subscriber
            </Button>
          </div>
        ) : (
          <div className="grid gap-1.5">
            <label htmlFor={searchId} className="text-[13px] font-semibold">
              Find a subscriber
            </label>
            <input
              id={searchId}
              type="search"
              value={q}
              placeholder="Email or name"
              onChange={(e) => setQ(e.target.value)}
              className="min-h-11 rounded-control border border-line-control px-3.5 text-[14px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-purple"
            />
            {members.isPending && <LoadingRows label="Finding subscribers" rows={1} />}
            {members.error && <ErrorNotice message={members.error.message} />}
            {members.data && members.data.items.length === 0 && (
              <p className="text-[13px] text-sub">No subscribers match.</p>
            )}
            {members.data && members.data.items.length > 0 && (
              <ul className="grid max-h-40 gap-1 overflow-y-auto" aria-label="Subscribers">
                {members.data.items.slice(0, 8).map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => setMember(m)}
                      className="w-full rounded-[10px] border border-line-app px-3 py-2 text-left text-[13px] hover:bg-surface-alt focus-visible:outline-2 focus-visible:outline-purple"
                    >
                      <span className="font-mono text-[12.5px]">{m.email}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {preview.isPending && <LoadingRows label="Rendering the preview" rows={3} />}
        {preview.error && <ErrorNotice title="No preview" message={preview.error.message} />}
        {preview.data && (
          <>
            {preview.data.smartBlocks.length > 0 && (
              <ul className="grid gap-1.5 text-[13px]" aria-label="Smart blocks">
                {preview.data.smartBlocks.map((block) => {
                  const condition = conditions[block.index];
                  return (
                    <li key={block.index} className="flex items-start gap-2">
                      <Pill tone={block.visible ? 'success' : 'neutral'}>
                        {block.visible ? 'Shown' : 'Hidden'}
                      </Pill>
                      <span className="min-w-0">
                        <b>{block.label ?? `Smart block ${block.index + 1}`}</b>
                        {condition && <span className="text-sub"> · {describe(condition)}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-[13px]">
              Subject: <b>{preview.data.subject}</b>
            </p>
            {/* No scripts, forms or same-origin access: the preview can never act on the page. */}
            <iframe
              title={member ? `Email preview as ${member.email}` : 'Email preview'}
              sandbox=""
              srcDoc={preview.data.html}
              className="h-[45vh] w-full rounded-card-app border border-line-app bg-white"
            />
          </>
        )}
      </div>
    </Dialog>
  );
}
