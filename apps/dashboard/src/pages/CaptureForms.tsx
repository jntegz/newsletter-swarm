// Capture forms of a Channel: the list, and creating a form.
import type { CaptureForm, Channel } from '@swarm/domain';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  Pill,
  TextField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { captureFormsQuery, captureStatsQuery, useCreateCaptureForm } from '../api/capture';
import { isFeatureDisabled } from '../api/growth';
import { DEFAULT_PLACEMENT, describePlacement } from '../growth/helpers';
import * as Icon from '../icons';
import { PageHeader } from './Channels';
import { WithChannel, formatDateTime, numberFormat } from './common';

const STATUS: Record<
  CaptureForm['status'],
  { tone: 'brand' | 'success' | 'neutral'; label: string }
> = {
  draft: { tone: 'brand', label: 'Draft' },
  published: { tone: 'success', label: 'Published' },
  archived: { tone: 'neutral', label: 'Archived' },
};

export function FormStatusPill({ form }: { form: CaptureForm }) {
  const pill = STATUS[form.status];
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Pill tone={pill.tone}>{pill.label}</Pill>
      {form.status === 'published' && form.hasUnpublishedChanges && (
        <Pill tone="scheduled">Unpublished changes</Pill>
      )}
    </span>
  );
}

export function CaptureFormsPage({ channelId }: { channelId: string | undefined }) {
  const navigate = useNavigate();
  return (
    <WithChannel
      channelId={channelId}
      onChange={(id) => void navigate({ to: '/forms', search: { channel: id } })}
    >
      {(channel, picker) => <FormList channel={channel} picker={picker} />}
    </WithChannel>
  );
}

type Kind = CaptureForm['kind'];

const KIND_TEXT: Record<Kind, { tab: string; create: string; empty: string; body: string }> = {
  form: {
    tab: 'Signup forms',
    create: 'New signup form',
    empty: 'No signup forms yet',
    body: 'A signup form turns visitors of your own site into subscribers. Build it here, publish it, then paste one line of code into your site. Your publication’s website already has a signup box, so you only need a form for other sites.',
  },
  prompt: {
    tab: 'Smart Prompts',
    create: 'New Smart Prompt',
    empty: 'No Smart Prompts yet',
    body: "A Smart Prompt is a signup form your publication's website shows by itself: at the end of a post, at a paywall, after some scrolling or when a reader is about to leave.",
  },
};

function FormList({ channel, picker }: { channel: Channel; picker: ReactNode }) {
  const all = useQuery(captureFormsQuery(channel.id));
  const [kind, setKind] = useState<Kind>('form');
  const [promptsOff, setPromptsOff] = useState(false);
  const forms = { ...all, data: all.data?.filter((f) => f.kind === kind) };
  const [creating, setCreating] = useState(false);
  const canWrite = channel.role !== 'viewer';

  const newButton = (label: string) =>
    canWrite && (
      <Button size="sm" onClick={() => setCreating(true)}>
        <Icon.Plus size={16} />
        {label}
      </Button>
    );

  return (
    <>
      <PageHeader
        title="Signup forms"
        subtitle={`Sign-up forms for ${channel.name}, embedded on your own site or shown by your publication's website.`}
        action={
          <div className="flex flex-wrap items-center gap-3">
            {picker}
            {!!forms.data?.length && newButton(KIND_TEXT[kind].create)}
          </div>
        }
      />
      <div role="group" aria-label="Kind" className="mb-4 flex gap-1">
        {(['form', 'prompt'] as const).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={kind === k}
            onClick={() => setKind(k)}
            className={`min-h-9 rounded-pill px-4 text-[13px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple ${
              kind === k
                ? 'bg-lavender text-purple-deep'
                : 'text-sub hover:bg-surface-alt hover:text-ink'
            }`}
          >
            {KIND_TEXT[k].tab}
          </button>
        ))}
      </div>
      {forms.isPending && <LoadingRows label="Loading signup forms" />}
      {forms.error && (
        <ErrorNotice
          message={forms.error.message}
          action={
            <Button variant="ghost" onClick={() => void forms.refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {forms.data?.length === 0 &&
        (kind === 'prompt' && promptsOff ? (
          <EmptyState title="Smart Prompts are off">
            Smart Prompts are an optional feature that is off for this publication. Whoever runs
            this Swarm installation can turn it on.
          </EmptyState>
        ) : (
          <EmptyState
            title={KIND_TEXT[kind].empty}
            action={newButton(kind === 'form' ? 'Create a signup form' : 'Create a Smart Prompt')}
          >
            {KIND_TEXT[kind].body}
          </EmptyState>
        ))}
      {!!forms.data?.length && (
        <div className="card-app overflow-x-auto">
          <table className="w-full min-w-[680px] text-left text-[13.5px]">
            <thead>
              <tr className="table-head">
                <th scope="col" className="px-5 py-3 font-semibold">
                  Name
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  Status
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  {kind === 'prompt' ? 'Shows' : 'Version'}
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  Last published
                </th>
                <th scope="col" className="px-5 py-3 text-right font-semibold">
                  Submissions, 7 days
                </th>
              </tr>
            </thead>
            <tbody>
              {forms.data.map((form) => (
                <tr key={form.id} className="border-t border-line hover:bg-surface-alt">
                  <td className="px-5 py-3.5">
                    <Link
                      to="/forms/$formId"
                      params={{ formId: form.id }}
                      className="font-semibold text-ink no-underline hover:underline"
                    >
                      {form.name}
                    </Link>
                  </td>
                  <td className="px-3 py-3.5">
                    <FormStatusPill form={form} />
                  </td>
                  <td className="tabular px-3 py-3.5 text-sub">
                    {form.kind === 'prompt'
                      ? describePlacement(form.placement ?? DEFAULT_PLACEMENT)
                      : form.version > 0
                        ? `v${form.version}`
                        : '—'}
                  </td>
                  <td className="tabular px-3 py-3.5 text-sub">
                    {formatDateTime(form.publishedAt)}
                  </td>
                  <td className="tabular px-5 py-3.5 text-right">
                    <WeekSubmissions formId={form.id} published={form.version > 0} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <CreateDialog
          channel={channel}
          kind={kind}
          onClose={() => setCreating(false)}
          onOff={() => {
            setPromptsOff(true);
            setCreating(false);
          }}
        />
      )}
    </>
  );
}

function WeekSubmissions({ formId, published }: { formId: string; published: boolean }) {
  // The list endpoint carries no stats, so each published row asks for its own week.
  const stats = useQuery({ ...captureStatsQuery(formId, 7), enabled: published });
  if (!published) return <span className="text-sub">—</span>;
  if (stats.isPending) return <span className="text-sub">…</span>;
  if (stats.error) return <span className="text-sub">Not available</span>;
  return <>{numberFormat.format(stats.data.totals.submissions)}</>;
}

function CreateDialog({
  channel,
  kind,
  onClose,
  onOff,
}: {
  channel: Channel;
  kind: Kind;
  onClose: () => void;
  /** The API said Smart Prompts are off for this Channel. */
  onOff: () => void;
}) {
  const navigate = useNavigate();
  const create = useCreateCaptureForm(channel.id);
  const [name, setName] = useState('');
  const error = create.error instanceof ApiError ? create.error : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      kind === 'prompt'
        ? { name: name.trim(), kind, placement: DEFAULT_PLACEMENT }
        : { name: name.trim() },
      {
        onSuccess: (form) => void navigate({ to: '/forms/$formId', params: { formId: form.id } }),
        onError: (err) => {
          if (isFeatureDisabled(err)) onOff();
        },
      },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={kind === 'prompt' ? 'Create a Smart Prompt' : 'Create a signup form'}
      description={
        kind === 'prompt'
          ? 'It starts as a draft with just an email field, shown at 50% scroll. Nothing goes live until you publish.'
          : 'It starts as a draft with just an email field. Nothing goes live until you publish.'
      }
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="create-capture-form" loading={create.isPending}>
            {kind === 'prompt' ? 'Create Smart Prompt' : 'Create form'}
          </Button>
        </>
      }
    >
      <form id="create-capture-form" onSubmit={submit}>
        <TextField
          label="Name"
          hint="Only your team sees this, for example “Footer form” or “Essay popup”."
          required
          maxLength={80}
          value={name}
          // The dialog opens on request, so moving focus to its only field is expected.
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          onChange={(e) => setName(e.target.value)}
          error={error?.field('name')}
        />
        {error && !error.details.length && (
          <div className="mt-3">
            <ErrorNotice message={error.message} />
          </div>
        )}
      </form>
    </Dialog>
  );
}
