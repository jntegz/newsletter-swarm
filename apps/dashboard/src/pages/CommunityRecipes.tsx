// Community Flow Recipes (Phase 8, App Directory): the approved recipes offered in the New Flow
// dialog next to the built-in ones, and "Share as recipe" in the Flow builder, which shows what
// was removed before the operator submits it for review. Contract: docs/app-directory.md.
import type { Flow } from '@swarm/domain';
import {
  Button,
  Dialog,
  ErrorNotice,
  LoadingRows,
  Pill,
  TextAreaField,
  TextField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../api/client';
import {
  communityRecipesQuery,
  recipeSubmissionsQuery,
  useRecipeAction,
  useShareRecipe,
} from '../api/appDirectory';
import { useChannelFlag } from '../api/queries';
import { StepIcon } from '../flows/StepIcon';
import { STATUS_LABEL, STATUS_TONE, canSubmit, canWithdraw } from './app-directory-helpers';

/** Approved community recipes as radio options; nothing at all while the flag is off. */
export function CommunityRecipeOptions({
  channelId,
  name,
  selected,
  onSelect,
  triggerLabel,
}: {
  channelId: string;
  name: string;
  selected: string;
  onSelect: (recipeId: string) => void;
  triggerLabel: (type: string) => string;
}) {
  const on = useChannelFlag(channelId, 'app_directory');
  const recipes = useQuery({ ...communityRecipesQuery(channelId), enabled: on === true });
  if (on !== true) return null;
  if (recipes.isPending) {
    return (
      <li>
        <LoadingRows label="Loading community recipes" rows={1} />
      </li>
    );
  }
  if (recipes.error) {
    return (
      <li>
        <ErrorNotice message={recipes.error.message} />
      </li>
    );
  }
  if (!recipes.data.length) return null;
  return (
    <>
      <li className="pt-2 text-[13px] font-semibold">From the community</li>
      {recipes.data.map((r) => (
        <li key={r.id}>
          <label
            className={`flex cursor-pointer gap-3 rounded-card-app border p-3 ${
              selected === r.id
                ? 'border-purple bg-lavender'
                : 'border-line-app hover:bg-surface-alt'
            }`}
          >
            <input
              type="radio"
              name={name}
              value={r.id}
              checked={selected === r.id}
              onChange={() => onSelect(r.id)}
              className="mt-1 accent-purple"
            />
            <span className="min-w-0 text-[14px] font-semibold">
              {r.name} <Pill>Community</Pill>
              <span className="block text-[13px] font-normal text-sub">{r.description}</span>
              <span className="mt-1 flex items-center gap-1.5 text-[12px] font-normal text-sub">
                <StepIcon type="trigger" size={13} />
                {triggerLabel(r.triggerType)}
                {' · '}
                {r.emailCount === 1 ? '1 email' : `${r.emailCount} emails`}
                {r.setupSteps > 0 &&
                  ` · ${r.setupSteps} ${r.setupSteps === 1 ? 'step' : 'steps'} to set up`}
              </span>
            </span>
          </label>
        </li>
      ))}
    </>
  );
}

/** "Share as recipe" in the Flow builder; hidden while the flag is off for the Channel. */
export function ShareRecipeButton({ flow }: { flow: Flow }) {
  const on = useChannelFlag(flow.channelId, 'app_directory');
  const [open, setOpen] = useState(false);
  if (on !== true) return null;
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Share as recipe
      </Button>
      {open && <ShareDialog flow={flow} onClose={() => setOpen(false)} />}
    </>
  );
}

function ShareDialog({ flow, onClose }: { flow: Flow; onClose: () => void }) {
  const submissions = useQuery(recipeSubmissionsQuery(flow.channelId));
  const share = useShareRecipe(flow.channelId);
  const action = useRecipeAction(flow.channelId);
  const [name, setName] = useState(flow.name);
  const [description, setDescription] = useState(flow.description ?? '');
  const error = share.error instanceof ApiError ? share.error : null;
  const mine = (submissions.data ?? []).filter((s) => s.flowId === flow.id);

  return (
    <Dialog
      open
      onClose={onClose}
      title="Share as a community recipe"
      description="Other publications can start from a copy of this automation. Swarm removes anything specific to your publication (tags, segments, fields, levels, webhook addresses, email addresses, images and tracking parameters) and reviews it before it is shared. The copy does not change when you edit the automation."
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            loading={share.isPending}
            disabled={!name.trim() || !description.trim()}
            onClick={() =>
              share.mutate({ flowId: flow.id, name: name.trim(), description: description.trim() })
            }
          >
            Prepare a copy
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <TextField
          label="Recipe name"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={error?.field('name')}
        />
        <TextAreaField
          label="What it does"
          rows={2}
          maxLength={500}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          error={error?.field('description')}
        />
        {error && !error.details.length && <ErrorNotice message={error.message} />}
        {action.error && <ErrorNotice message={action.error.message} />}
        {submissions.isPending && <LoadingRows label="Loading shared copies" rows={1} />}
        {mine.map((s) => (
          <section key={s.id} className="rounded-card-app border border-line-app p-3 text-[13.5px]">
            <p className="flex flex-wrap items-center gap-2">
              <b>{s.name}</b> <Pill tone={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</Pill>
            </p>
            {s.reviewNote && (
              <p className="mt-1">
                <b>Note from Swarm:</b> {s.reviewNote}
              </p>
            )}
            {s.removed.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-[13px]">
                  {s.removed.length} {s.removed.length === 1 ? 'thing was' : 'things were'} removed
                </summary>
                <ul className="mt-1 grid list-disc gap-0.5 pl-5 text-[12.5px] text-sub">
                  {s.removed.map((r, i) => (
                    <li key={i}>
                      {r.emailKey ? 'An email' : `Step ${r.nodeId ?? ''}`}: {r.what}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {canSubmit(s.status) && (
                <Button
                  size="sm"
                  loading={action.isPending && action.variables?.id === s.id}
                  onClick={() => action.mutate({ id: s.id, action: 'submit' })}
                >
                  Submit for review
                </Button>
              )}
              {canWithdraw(s.status) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => action.mutate({ id: s.id, action: 'withdraw' })}
                >
                  Withdraw
                </Button>
              )}
              <Button
                variant="quiet"
                size="sm"
                onClick={() => action.mutate({ id: s.id, action: 'delete' })}
              >
                Delete copy
              </Button>
            </div>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
