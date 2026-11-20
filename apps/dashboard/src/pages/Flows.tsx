// Flows: the list per Channel and "New Flow", blank or from the Flow Recipes gallery.
import type { Channel, FlowRecipe, FlowSummary, FlowTriggerConfig } from '@swarm/domain';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  TextField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useId, useState, type ReactNode } from 'react';
import { SelectField } from '../flows/Select';
import { ApiError } from '../api/client';
import { flowRecipesQuery, flowsQuery, useCreateFlow } from '../api/flows';
import { TRIGGER_LABEL } from '../flows/graph';
import { FlowPill, openRuns } from '../flows/status';
import { StepIcon } from '../flows/StepIcon';
import * as Icon from '../icons';
import { PageHeader } from './Channels';
import { useFlowFromCommunityRecipe } from '../api/appDirectory';
import { CommunityRecipeOptions } from './CommunityRecipes';
import { WithChannel, formatDay, numberFormat } from './common';

export function FlowsPage({
  channelId,
  recipe,
}: {
  channelId: string | undefined;
  /** Opens New automation with this recipe chosen. */
  recipe?: FlowRecipe | undefined;
}) {
  const navigate = useNavigate();
  return (
    <WithChannel
      channelId={channelId}
      onChange={(id) => void navigate({ to: '/flows', search: { channel: id } })}
    >
      {(channel, picker) => (
        <FlowList key={channel.id} channel={channel} picker={picker} recipe={recipe} />
      )}
    </WithChannel>
  );
}

const canEdit = (channel: Channel) => ['editor', 'admin', 'owner'].includes(channel.role);

function FlowList({
  channel,
  picker,
  recipe,
}: {
  channel: Channel;
  picker: ReactNode;
  recipe: FlowRecipe | undefined;
}) {
  const navigate = useNavigate();
  const flows = useQuery(flowsQuery(channel.id));
  const writable = canEdit(channel);
  const [creating, setCreating] = useState(writable && !!recipe);
  const closeNew = () => {
    setCreating(false);
    // A recipe from a link opens the dialog once; Back or a reload shouldn't open it again.
    if (recipe) void navigate({ to: '/flows', search: { channel: channel.id }, replace: true });
  };

  const create = writable && (
    <Button size="sm" icon={<Icon.Plus size={16} />} onClick={() => setCreating(true)}>
      New automation
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Automations"
        subtitle={`Emails and steps that run on their own for ${channel.name} subscribers.`}
        action={
          <div className="flex flex-wrap items-center gap-3">
            {picker}
            <Link to="/flows/inbox-rules" search={{ channel: channel.id }} className="btn-ghost">
              Inbox rules
            </Link>
            <Link to="/templates" search={{ channel: channel.id }} className="btn-ghost">
              Templates
            </Link>
            {create}
          </div>
        }
      />
      {flows.isPending && <LoadingRows label="Loading automations" />}
      {flows.error && (
        <ErrorNotice
          message={flows.error.message}
          action={
            <Button variant="ghost" onClick={() => void flows.refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {flows.data?.length === 0 && (
        <EmptyState title="No automations yet" action={create}>
          An automation sends emails and takes steps when something happens: a subscriber confirms,
          buys a paid plan, or goes quiet. Start from a recipe such as a welcome email.
        </EmptyState>
      )}
      {!!flows.data?.length && <FlowTable flows={flows.data} />}
      {creating && <NewFlowDialog channel={channel} initialRecipe={recipe} onClose={closeNew} />}
    </>
  );
}

function FlowTable({ flows }: { flows: FlowSummary[] }) {
  return (
    <div className="card-app overflow-x-auto">
      <table className="w-full min-w-[760px] text-left text-[13.5px]">
        <caption className="sr-only">Automations</caption>
        <thead>
          <tr className="table-head">
            <th scope="col" className="px-5 py-3 font-semibold">
              Name
            </th>
            <th scope="col" className="px-3 py-3 font-semibold">
              Status
            </th>
            <th scope="col" className="px-3 py-3 font-semibold">
              Trigger
            </th>
            <th scope="col" className="px-3 py-3 text-right font-semibold">
              Live version
            </th>
            <th scope="col" className="px-3 py-3 text-right font-semibold">
              In progress
            </th>
            <th scope="col" className="px-3 py-3 text-right font-semibold">
              Completed
            </th>
            <th scope="col" className="px-3 py-3 text-right font-semibold">
              Exited or failed
            </th>
            <th scope="col" className="px-5 py-3 font-semibold">
              Updated
            </th>
          </tr>
        </thead>
        <tbody>
          {flows.map((flow) => (
            <tr key={flow.id} className="border-t border-line hover:bg-surface-alt">
              <td className="px-5 py-3.5">
                <Link
                  to="/flows/$flowId"
                  params={{ flowId: flow.id }}
                  className="font-semibold text-ink no-underline hover:underline"
                >
                  {flow.name}
                </Link>
                {flow.description && (
                  <p className="mt-0.5 line-clamp-1 max-w-[44ch] text-[12.5px] text-sub">
                    {flow.description}
                  </p>
                )}
              </td>
              <td className="px-3 py-3.5">
                <FlowPill status={flow.status} />
              </td>
              <td className="px-3 py-3.5 text-sub">
                {(flow.triggerTypes?.length ?? 0) > 1
                  ? 'Several start events'
                  : flow.triggerType
                    ? TRIGGER_LABEL[flow.triggerType]
                    : 'Not published'}
              </td>
              <td className="tabular px-3 py-3.5 text-right">
                {flow.liveVersion ? `v${flow.liveVersion}` : '—'}
              </td>
              <td className="tabular px-3 py-3.5 text-right">
                {numberFormat.format(openRuns(flow.runs))}
              </td>
              <td className="tabular px-3 py-3.5 text-right">
                {numberFormat.format(flow.runs.completed)}
              </td>
              <td className="tabular px-3 py-3.5 text-right">
                {numberFormat.format(flow.runs.exited + flow.runs.failed)}
              </td>
              <td className="tabular px-5 py-3.5 text-sub">{formatDay(flow.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Triggers a blank Flow can start with: none of them needs an id chosen first. */
const BLANK_TRIGGERS: { value: string; config: FlowTriggerConfig }[] = [
  { value: 'confirmed', config: { event: 'confirmed' } },
  { value: 'member_joined', config: { event: 'member_joined', includeImports: false } },
  { value: 'form_submitted', config: { event: 'form_submitted' } },
  { value: 'level_purchased', config: { event: 'level_purchased' } },
  { value: 'level_canceled', config: { event: 'level_canceled' } },
  { value: 'unengaged', config: { event: 'unengaged', days: 60 } },
  { value: 'link_clicked', config: { event: 'link_clicked' } },
  { value: 'gate_hit', config: { event: 'gate_hit' } },
];

function NewFlowDialog({
  channel,
  initialRecipe,
  onClose,
}: {
  channel: Channel;
  initialRecipe?: FlowRecipe | undefined;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const recipes = useQuery(flowRecipesQuery);
  const create = useCreateFlow(channel.id);
  // App Directory (Phase 8): a selected community recipe id instead of a built-in recipe.
  const fromCommunity = useFlowFromCommunityRecipe(channel.id);
  const [community, setCommunity] = useState('');
  const [mode, setMode] = useState<'recipe' | 'blank'>('recipe');
  const [recipe, setRecipe] = useState<FlowRecipe>(initialRecipe ?? 'welcome');
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState('confirmed');
  const [nameError, setNameError] = useState<string>();
  const groupId = useId();

  const submit = () => {
    if (mode === 'blank' && !name.trim()) {
      setNameError('Name the automation.');
      return;
    }
    const config = BLANK_TRIGGERS.find((t) => t.value === trigger)!.config;
    const open = (flow: { id: string }) => {
      onClose();
      void navigate({ to: '/flows/$flowId', params: { flowId: flow.id } });
    };
    if (mode === 'recipe' && community) {
      fromCommunity.mutate(community, { onSuccess: open });
      return;
    }
    create.mutate(mode === 'recipe' ? { recipe } : { name: name.trim(), trigger: config }, {
      onSuccess: (flow) => {
        onClose();
        void navigate({ to: '/flows/$flowId', params: { flowId: flow.id } });
      },
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="New automation"
      description="Start from a recipe with its emails written, or from a blank canvas."
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={create.isPending || fromCommunity.isPending}>
            Create automation
          </Button>
        </>
      }
    >
      <div role="radiogroup" aria-label="Start from" className="mb-4 flex gap-2">
        {(['recipe', 'blank'] as const).map((value) => (
          <label
            key={value}
            className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-pill border px-4 text-[13.5px] ${
              mode === value
                ? 'border-purple bg-lavender font-semibold text-purple-deep'
                : 'border-line-control'
            }`}
          >
            <input
              type="radio"
              name={`${groupId}-mode`}
              className="sr-only"
              checked={mode === value}
              onChange={() => setMode(value)}
            />
            {value === 'recipe' ? 'A recipe' : 'Blank'}
          </label>
        ))}
      </div>

      {mode === 'recipe' && (
        <fieldset>
          <legend className="mb-2 text-[13px] font-semibold">Automation recipes</legend>
          {recipes.isPending && <LoadingRows label="Loading recipes" rows={3} />}
          {recipes.error && <ErrorNotice message={recipes.error.message} />}
          <ul className="grid max-h-[46vh] gap-2 overflow-y-auto pr-1">
            {recipes.data?.map((r) => (
              <li key={r.key}>
                <label
                  className={`flex cursor-pointer gap-3 rounded-card-app border p-3 ${
                    !community && recipe === r.key
                      ? 'border-purple bg-lavender'
                      : 'border-line-app hover:bg-surface-alt'
                  }`}
                >
                  <input
                    type="radio"
                    name={`${groupId}-recipe`}
                    value={r.key}
                    checked={!community && recipe === r.key}
                    onChange={() => {
                      setRecipe(r.key);
                      setCommunity('');
                    }}
                    className="mt-1 accent-purple"
                  />
                  <span className="min-w-0 text-[14px] font-semibold">
                    {r.name}
                    {/* text-sub is just below AA on lavender: the chosen card uses darker text. */}
                    <span
                      className={`block text-[13px] font-normal ${!community && recipe === r.key ? 'text-ink/75' : 'text-sub'}`}
                    >
                      {r.description}
                    </span>
                    <span
                      className={`mt-1 flex items-center gap-1.5 text-[12px] font-normal ${!community && recipe === r.key ? 'text-ink/75' : 'text-sub'}`}
                    >
                      <StepIcon type="trigger" size={13} />
                      {TRIGGER_LABEL[r.triggerType as keyof typeof TRIGGER_LABEL] ?? r.triggerType}
                      {' · '}
                      {r.emailCount === 1 ? '1 email' : `${r.emailCount} emails`}
                    </span>
                  </span>
                </label>
              </li>
            ))}
            <CommunityRecipeOptions
              channelId={channel.id}
              name={`${groupId}-recipe`}
              selected={community}
              onSelect={setCommunity}
              triggerLabel={(type) => TRIGGER_LABEL[type as keyof typeof TRIGGER_LABEL] ?? type}
            />
          </ul>
        </fieldset>
      )}

      {mode === 'blank' && (
        <div className="grid gap-4">
          <TextField
            label="Name"
            value={name}
            maxLength={80}
            error={
              nameError ??
              (create.error instanceof ApiError ? create.error.field('name') : undefined)
            }
            onChange={(e) => {
              setName(e.target.value);
              setNameError(undefined);
            }}
          />
          <SelectField
            label="Starts when"
            value={trigger}
            hint="You can pick a segment, tag or other trigger in the builder."
            onChange={(e) => setTrigger(e.target.value)}
          >
            {BLANK_TRIGGERS.map((t) => (
              <option key={t.value} value={t.value}>
                {TRIGGER_LABEL[t.config.event]}
              </option>
            ))}
          </SelectField>
        </div>
      )}
      {(create.error ?? fromCommunity.error) && (
        <div className="mt-4">
          <ErrorNotice
            title="The automation was not created"
            message={(create.error ?? fromCommunity.error)?.message ?? ''}
          />
        </div>
      )}
    </Dialog>
  );
}
