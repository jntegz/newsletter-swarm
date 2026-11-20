// Where and when the website shows a Smart Prompt (a Capture Form of kind 'prompt', flag
// smart_prompts): the trigger, the pages, who sees it and how long it stays away after a
// dismissal. Saved straight to the form; like the rest of a prompt, it goes live on publish.
import type { CaptureForm, SmartPromptPlacement } from '@swarm/domain';
import { Button, ErrorNotice, SelectField, TextAreaField, TextField } from '@swarm/ui/components';
import { useState } from 'react';
import { useSaveCaptureForm } from '../api/capture';
import { ApiError } from '../api/client';
import { isFeatureDisabled } from '../api/growth';
import {
  DEFAULT_PLACEMENT,
  describePlacement,
  normalizePlacement,
  placementProblems,
  problemAt,
} from '../growth/helpers';
import { Section } from '../pages/common';

const TRIGGERS: { value: SmartPromptPlacement['trigger']; label: string }[] = [
  { value: 'scroll', label: 'After scrolling part of a page' },
  { value: 'delay', label: 'After some time on a page' },
  { value: 'exit_intent', label: 'When the reader is about to leave' },
  { value: 'dispatch_end', label: 'At the end of a post' },
  { value: 'gate_hit', label: 'When the reader meets a paywall' },
];

const READERS: { value: SmartPromptPlacement['readers']; label: string }[] = [
  { value: 'anonymous', label: 'Readers who are not subscribers' },
  { value: 'free', label: 'Readers who are not subscribers, and free subscribers' },
  { value: 'everyone', label: 'Everyone' },
];

export function PlacementSection({ form, canWrite }: { form: CaptureForm; canWrite: boolean }) {
  const save = useSaveCaptureForm(form.id);
  const initial = form.placement ?? DEFAULT_PLACEMENT;
  const [placement, setPlacement] = useState<SmartPromptPlacement>(initial);
  const [paths, setPaths] = useState(initial.paths.join('\n'));
  const [submitted, setSubmitted] = useState(false);
  const [saved, setSaved] = useState(false);
  const current = normalizePlacement({ ...placement, paths: paths.split('\n') });
  const local = placementProblems(current);
  const server =
    save.error instanceof ApiError
      ? save.error.details.map((d) => ({ path: d.path, message: d.message }))
      : [];
  const problems = [...(submitted ? local : []), ...server];

  const set = (patch: Partial<SmartPromptPlacement>) => {
    setSaved(false);
    setPlacement((p) => ({ ...p, ...patch }));
  };

  const valueField =
    placement.trigger === 'scroll' || placement.trigger === 'delay' ? (
      <TextField
        label={placement.trigger === 'scroll' ? 'Scrolled (%)' : 'Seconds on the page'}
        type="number"
        inputMode="numeric"
        min={placement.trigger === 'scroll' ? 1 : 0}
        max={placement.trigger === 'scroll' ? 100 : 3600}
        readOnly={!canWrite}
        value={placement.value === undefined ? '' : String(placement.value)}
        onChange={(e) => {
          const text = e.target.value.trim();
          const next = Number(text);
          setSaved(false);
          setPlacement((p) => {
            const rest = { ...p };
            delete rest.value;
            return text === '' || !Number.isFinite(next) ? rest : { ...rest, value: next };
          });
        }}
        error={problemAt(problems, 'placement.value')}
      />
    ) : null;

  return (
    <Section
      title="Where it shows"
      description="Smart Prompts appear on your publication's website. Changes go live when you publish."
    >
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
          if (local.length) return;
          save.mutate({ placement: current }, { onSuccess: () => setSaved(true) });
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Show it"
            value={placement.trigger}
            disabled={!canWrite}
            onChange={(e) => {
              const trigger = e.target.value as SmartPromptPlacement['trigger'];
              set({
                trigger,
                ...(trigger === 'scroll' ? { value: placement.value ?? 50 } : {}),
                ...(trigger === 'delay' ? { value: placement.value ?? 10 } : {}),
                ...(trigger === 'gate_hit' && placement.readers === 'everyone'
                  ? { readers: 'anonymous' as const }
                  : {}),
              });
            }}
            options={TRIGGERS}
          />
          {valueField}
        </div>
        <TextAreaField
          label="Pages (optional)"
          rows={3}
          readOnly={!canWrite}
          value={paths}
          placeholder={'/p/*\n/about'}
          onChange={(e) => {
            setSaved(false);
            setPaths(e.target.value);
          }}
          hint="One path per line, starting with /. Use * as a wildcard. Empty means every page."
          error={problemAt(problems, 'placement.paths')}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Who sees it"
            value={placement.readers}
            disabled={!canWrite}
            onChange={(e) => set({ readers: e.target.value as SmartPromptPlacement['readers'] })}
            options={READERS.filter(
              (r) => placement.trigger !== 'gate_hit' || r.value !== 'everyone',
            )}
            error={problemAt(problems, 'placement.readers')}
          />
          <TextField
            label="After a reader closes it, wait (days)"
            type="number"
            inputMode="numeric"
            min={0}
            max={365}
            readOnly={!canWrite}
            value={String(placement.cooldownDays)}
            onChange={(e) => set({ cooldownDays: Number(e.target.value) })}
            error={problemAt(problems, 'placement.cooldownDays')}
          />
        </div>
        <p className="rounded-card-app bg-surface-alt px-3 py-2 text-[13px] text-sub">
          {describePlacement(current)}
        </p>
        {save.error && (isFeatureDisabled(save.error) || !server.length) && (
          <ErrorNotice title="Not saved" message={save.error.message} />
        )}
        {canWrite && (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm" loading={save.isPending}>
              Save placement
            </Button>
            {saved && (
              <span role="status" className="text-[13px] text-success">
                Saved. Publish to put it live.
              </span>
            )}
          </div>
        )}
      </form>
    </Section>
  );
}
