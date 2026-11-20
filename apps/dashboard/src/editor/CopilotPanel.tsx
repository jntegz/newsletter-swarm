// Copilot in the Dispatch editor (Phase 8, flag copilot): subject lines, preview text, rewrite,
// grammar, translation, teasers and Share Kit social posts. Results stream into this panel and
// change nothing until the operator accepts one (social posts are copied, never posted). With
// copilot_actions on, the panel also takes requests for Copilot to do (CopilotActions.tsx).
// Contract: docs/copilot.md.
import {
  COPILOT_STYLES,
  type CopilotFeature,
  type CopilotRun,
  type CopilotSocialPosts,
  type CopilotStyle,
} from '@swarm/domain';
import { Button, ErrorNotice, Pill, SelectField, TextField } from '@swarm/ui/components';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { CopilotStreamError, streamCopilot } from '../api/copilot';
import { useChannelFlag } from '../api/queries';
import { Section } from '../pages/common';
import { CopilotActions } from './CopilotActions';
import { textNodes } from './copilot-text';

const STYLE_LABEL: Record<CopilotStyle, string> = {
  shorter: 'Shorter',
  longer: 'Longer',
  friendly: 'Friendlier',
  formal: 'More formal',
  confident: 'More confident',
  plain: 'Plainer',
};

const FEATURE_LABEL: Record<CopilotFeature, string> = {
  subject_lines: 'Subject lines',
  preview_text: 'Preview text',
  rewrite: 'Rewrite',
  fix_grammar: 'Grammar fixes',
  translate: 'Translation',
  teaser: 'Teaser',
  social_posts: 'Social posts',
};

/** Where an accepted result goes. */
type Target =
  | { kind: 'subject' }
  | { kind: 'preheader' }
  | { kind: 'selection'; from: number; to: number; original: string }
  | { kind: 'insert' }
  | { kind: 'social' };

interface Job {
  feature: CopilotFeature;
  target: Target;
  status: 'streaming' | 'done' | 'error' | 'stopped';
  text: string;
  suggestions: string[];
  social: CopilotSocialPosts | null;
  error: string | null;
  remaining: number | null;
  applied: string | null;
}

const BLOCK = '\n\n';

function selectionText(editor: Editor): { from: number; to: number; text: string } | null {
  const { from, to, empty } = editor.state.selection;
  if (empty) return null;
  const text = editor.state.doc.textBetween(from, to, BLOCK, ' ').trim();
  return text ? { from, to, text } : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'rate_limited') {
      return error.field('quota') === 'month'
        ? 'This workspace has used this month’s Copilot requests. Admins can add their own model key in Settings → Copilot.'
        : error.message;
    }
    if (error.code === 'feature_disabled') return 'Copilot is not available for this publication.';
    return error.message;
  }
  if (error instanceof CopilotStreamError) return error.message;
  return 'Something went wrong. Try again.';
}

export function CopilotPanel({
  editor,
  dispatchId,
  channelId,
  subject,
  onUseSubject,
  onUsePreheader,
}: {
  editor: Editor | null;
  dispatchId: string;
  channelId: string;
  subject: string;
  onUseSubject: (value: string) => void;
  onUsePreheader: (value: string) => void;
}) {
  const on = useChannelFlag(channelId, 'copilot');
  const actionsOn = useChannelFlag(channelId, 'copilot_actions');
  const [job, setJob] = useState<Job | null>(null);
  const [style, setStyle] = useState<CopilotStyle>('shorter');
  const [language, setLanguage] = useState('');
  const abort = useRef<AbortController | null>(null);
  const hasSelection = useEditorState({
    editor,
    selector: ({ editor: e }) => (e ? !e.state.selection.empty : false),
  });

  useEffect(() => () => abort.current?.abort(), []);

  if (on !== true || !editor) return null;

  const streaming = job?.status === 'streaming';

  const start = async (input: CopilotRun, target: Target) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setJob({
      feature: input.feature,
      target,
      status: 'streaming',
      text: '',
      suggestions: [],
      social: null,
      error: null,
      remaining: null,
      applied: null,
    });
    try {
      const done = await streamCopilot(dispatchId, input, {
        signal: controller.signal,
        onDelta: (text) =>
          setJob((current) => (current ? { ...current, text: current.text + text } : current)),
      });
      setJob((current) =>
        current
          ? {
              ...current,
              status: 'done',
              text: done.text,
              suggestions: done.suggestions,
              social: done.social ?? null,
              remaining: done.remaining,
            }
          : current,
      );
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      setJob((current) =>
        current ? { ...current, status: 'error', error: errorMessage(error) } : current,
      );
    }
  };

  const wholeDispatch = (feature: CopilotFeature, target: Target) => {
    const text = editor.getText({ blockSeparator: BLOCK }).trim();
    if (!text) {
      setJob({
        feature,
        target,
        status: 'error',
        text: '',
        suggestions: [],
        social: null,
        error: 'Write something in the post first.',
        remaining: null,
        applied: null,
      });
      return;
    }
    void start({ feature, text, ...(subject.trim() ? { subject } : {}) }, target);
  };

  const onSelection = (feature: CopilotFeature, extra: Partial<CopilotRun> = {}) => {
    const selected = selectionText(editor);
    if (!selected) return;
    void start(
      { feature, text: selected.text, ...extra },
      { kind: 'selection', from: selected.from, to: selected.to, original: selected.text },
    );
  };

  const stop = () => {
    abort.current?.abort();
    setJob((current) => (current ? { ...current, status: 'stopped' } : current));
  };

  // ---- Accepting a result -------------------------------------------------------------------

  const selectionStillMatches = (target: Extract<Target, { kind: 'selection' }>) =>
    target.to <= editor.state.doc.content.size &&
    editor.state.doc.textBetween(target.from, target.to, BLOCK, ' ').trim() === target.original;

  const replaceSelection = (target: Extract<Target, { kind: 'selection' }>, text: string) => {
    editor
      .chain()
      .focus()
      .insertContentAt({ from: target.from, to: target.to }, textNodes(text))
      .run();
    setJob((current) => (current ? { ...current, applied: text } : current));
  };

  const insertAtCursor = (text: string) => {
    editor.chain().focus().insertContentAt(editor.state.selection.to, textNodes(text)).run();
    setJob((current) => (current ? { ...current, applied: text } : current));
  };

  const useOption = (value: string) => {
    if (job?.target.kind === 'subject') onUseSubject(value);
    else onUsePreheader(value);
    setJob((current) => (current ? { ...current, applied: value } : current));
  };

  return (
    <Section
      title="Copilot"
      description="Suggestions for this post. Only the text you pick is sent, and nothing changes until you accept it."
    >
      <div className="grid gap-4">
        <div className="grid gap-2">
          <h3 className="text-[14px] font-semibold">Whole post</h3>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={streaming}
              onClick={() => wholeDispatch('subject_lines', { kind: 'subject' })}
            >
              Subject lines
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={streaming}
              onClick={() => wholeDispatch('preview_text', { kind: 'preheader' })}
            >
              Preview text
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={streaming}
              onClick={() => wholeDispatch('teaser', { kind: 'insert' })}
            >
              Teaser
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={streaming}
              onClick={() => wholeDispatch('social_posts', { kind: 'social' })}
            >
              Social posts
            </Button>
          </div>
        </div>

        <div className="grid gap-2">
          <h3 className="text-[14px] font-semibold">Selected text</h3>
          {!hasSelection && (
            <p className="text-[12.5px] text-sub">Select text in the post to use these.</p>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[140px] flex-1">
              <SelectField
                label="Style"
                value={style}
                options={COPILOT_STYLES.map((s) => ({ value: s, label: STYLE_LABEL[s] }))}
                onChange={(e) => setStyle(e.target.value as CopilotStyle)}
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={streaming || !hasSelection}
              onClick={() => onSelection('rewrite', { style })}
            >
              Rewrite
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={streaming || !hasSelection}
              onClick={() => onSelection('fix_grammar')}
            >
              Fix grammar
            </Button>
          </div>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (language.trim()) onSelection('translate', { language: language.trim() });
            }}
          >
            <div className="min-w-[140px] flex-1">
              <TextField
                label="Translate to"
                placeholder="e.g. German"
                value={language}
                maxLength={40}
                onChange={(e) => setLanguage(e.target.value)}
              />
            </div>
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              disabled={streaming || !hasSelection || !language.trim()}
            >
              Translate
            </Button>
          </form>
        </div>

        {job && (
          <CopilotResult
            job={job}
            onStop={stop}
            onDismiss={() => setJob(null)}
            onUseOption={useOption}
            onReplace={(target) => replaceSelection(target, job.text)}
            onInsert={() => insertAtCursor(job.text)}
            selectionMatches={
              job.target.kind === 'selection' ? selectionStillMatches(job.target) : true
            }
          />
        )}

        {actionsOn === true && <CopilotActions channelId={channelId} dispatchId={dispatchId} />}
      </div>
    </Section>
  );
}

function CopilotResult({
  job,
  onStop,
  onDismiss,
  onUseOption,
  onReplace,
  onInsert,
  selectionMatches,
}: {
  job: Job;
  onStop: () => void;
  onDismiss: () => void;
  onUseOption: (value: string) => void;
  onReplace: (target: Extract<Target, { kind: 'selection' }>) => void;
  onInsert: () => void;
  selectionMatches: boolean;
}) {
  const list = job.target.kind === 'subject' || job.target.kind === 'preheader';
  // An empty result is never offered: replacing with nothing would delete the selection.
  const acceptable = job.status === 'done' && job.applied === null && job.text.trim() !== '';
  return (
    <div className="grid gap-3 rounded-card-app border border-line-app bg-surface-alt p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-semibold">{FEATURE_LABEL[job.feature]}</p>
        {job.status === 'streaming' ? (
          <Pill tone="scheduled">Writing…</Pill>
        ) : job.status === 'stopped' ? (
          <Pill tone="neutral">Stopped</Pill>
        ) : job.applied !== null ? (
          <Pill tone="success">Applied</Pill>
        ) : null}
      </div>

      {job.status === 'error' && job.error && <ErrorNotice message={job.error} />}

      {job.status !== 'error' && (
        <div aria-live="polite" aria-busy={job.status === 'streaming'}>
          {job.target.kind === 'social' && job.status === 'done' && job.social ? (
            <SocialPosts posts={job.social} />
          ) : list && job.status === 'done' ? (
            <ul className="grid gap-2">
              {job.suggestions.map((option) => (
                <li
                  key={option}
                  className="flex items-start justify-between gap-2 rounded-[10px] bg-surface px-3 py-2 text-[13.5px]"
                >
                  <span className="min-w-0 break-words">{option}</span>
                  <Button
                    variant={job.applied === option ? 'quiet' : 'ghost'}
                    size="sm"
                    disabled={job.applied === option}
                    onClick={() => onUseOption(option)}
                  >
                    {job.applied === option ? 'Used' : 'Use'}
                  </Button>
                </li>
              ))}
              {job.suggestions.length === 0 && (
                <li className="text-[13px] text-sub">No suggestions came back. Try again.</li>
              )}
            </ul>
          ) : (
            <p className="text-[13.5px] leading-[1.55] break-words whitespace-pre-wrap">
              {job.text || (job.status === 'streaming' ? 'Thinking…' : '')}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {job.status === 'streaming' && (
          <Button variant="ghost" size="sm" onClick={onStop}>
            Stop
          </Button>
        )}
        {acceptable && job.target.kind === 'selection' && (
          <>
            {selectionMatches ? (
              <Button
                size="sm"
                onClick={() => onReplace(job.target as Extract<Target, { kind: 'selection' }>)}
              >
                Replace selection
              </Button>
            ) : (
              <Button size="sm" onClick={onInsert}>
                Insert at cursor
              </Button>
            )}
          </>
        )}
        {acceptable && job.target.kind === 'insert' && (
          <Button size="sm" onClick={onInsert}>
            Insert at cursor
          </Button>
        )}
        {job.status !== 'streaming' && (
          <Button variant="quiet" size="sm" onClick={onDismiss}>
            {job.applied === null && job.status === 'done' ? 'Discard' : 'Close'}
          </Button>
        )}
      </div>
      {acceptable && job.target.kind === 'selection' && (
        <p className="text-[12px] text-sub">
          {selectionMatches
            ? 'Replacing keeps the text only: bold, links and other formatting in the selection are removed.'
            : 'The selected text has changed since you asked, so this can only be inserted at the cursor.'}
        </p>
      )}
      {job.remaining !== null && job.status === 'done' && (
        <p className="text-[12px] text-sub">
          {job.remaining} Copilot request{job.remaining === 1 ? '' : 's'} left this month.
        </p>
      )}
    </div>
  );
}

/** Copies text to the clipboard on click; says so for a moment, or that it failed. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={label}
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => setState('copied'),
          () => setState('failed'),
        );
      }}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
    </Button>
  );
}

/** Share Kit: plain-text posts to copy; Swarm never posts them anywhere. */
function SocialPosts({ posts }: { posts: CopilotSocialPosts }) {
  const block = (title: string, text: string) => (
    <div className="grid gap-1.5 rounded-[10px] bg-surface px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px] font-semibold text-sub">{title}</p>
        <CopyButton text={text} label={`Copy the ${title.toLowerCase()}`} />
      </div>
      <p className="text-[13.5px] leading-[1.55] break-words whitespace-pre-wrap">{text}</p>
    </div>
  );
  return (
    <div className="grid gap-2">
      {block('Short post', posts.short)}
      {block('Long post', posts.long)}
      <div className="grid gap-1.5 rounded-[10px] bg-surface px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[12px] font-semibold text-sub">Thread ({posts.thread.length} posts)</p>
          <CopyButton text={posts.thread.join('\n\n')} label="Copy the whole thread" />
        </div>
        <ol className="grid gap-2">
          {posts.thread.map((post, index) => (
            <li key={index} className="flex items-start justify-between gap-2 text-[13.5px]">
              <span className="min-w-0 break-words whitespace-pre-wrap">{post}</span>
              <CopyButton text={post} label={`Copy post ${index + 1} of the thread`} />
            </li>
          ))}
        </ol>
      </div>
      <p className="text-[12px] text-sub">
        {posts.link
          ? 'Each social post links to the post on your website. Copy one and share it yourself.'
          : 'This publication has no website yet, so the posts carry no link.'}
      </p>
    </div>
  );
}
