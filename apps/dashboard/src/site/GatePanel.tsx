// The Gate part of the Dispatch editor's Website panel, for a Dispatch only paid Members read:
// which Membership levels read past the gate, whether the meter can admit others, and the copy.
import type { Gate } from '@swarm/domain';
import { Button, Checkbox, ErrorNotice, LoadingRows } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import { gateQuery, gateSettingsQuery, levelsQuery, usePutGate } from '../api/money';
import { GateDesignFields } from '../money/GateDesignFields';
import { designDraft, designInput, designProblems, type GateDesignDraft } from '../money/helpers';
import { ChoiceCards } from './controls';

export function GatePanel({
  dispatchId,
  channelId,
  canEdit,
}: {
  dispatchId: string;
  channelId: string;
  canEdit: boolean;
}) {
  const gate = useQuery(gateQuery(dispatchId));
  if (gate.isPending) return <LoadingRows label="Loading the paywall" rows={2} />;
  if (gate.error) return <ErrorNotice message={gate.error.message} />;
  return (
    <GateForm key={gate.data.dispatchId} gate={gate.data} channelId={channelId} canEdit={canEdit} />
  );
}

function GateForm({
  gate,
  channelId,
  canEdit,
}: {
  gate: Gate;
  channelId: string;
  canEdit: boolean;
}) {
  const levels = useQuery(levelsQuery(channelId));
  const settings = useQuery(gateSettingsQuery(channelId));
  const put = usePutGate(gate.dispatchId);
  const [who, setWho] = useState<'any' | 'some'>(gate.levelIds.length ? 'some' : 'any');
  const [levelIds, setLevelIds] = useState(gate.levelIds);
  const [metered, setMetered] = useState(gate.metered);
  const [design, setDesign] = useState<GateDesignDraft>(designDraft(gate.design));
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const apiError = put.error instanceof ApiError ? put.error : null;
  const errors = designProblems(design);
  const active = levels.data?.items.filter((l) => l.status === 'active') ?? [];
  const meterLimit = settings.data?.meterLimit ?? 0;
  const disabled = !canEdit;
  const touch = () => setSaved(false);

  const save = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    setProblem(null);
    if (Object.keys(errors).length) return;
    if (who === 'some' && levelIds.length === 0) {
      setProblem('Pick at least one paid plan, or let any paid plan read it.');
      return;
    }
    put.mutate(
      { levelIds: who === 'some' ? levelIds : [], metered, design: designInput(design) },
      { onSuccess: () => setSaved(true) },
    );
  };

  return (
    <form
      onSubmit={save}
      noValidate
      aria-labelledby="gate-heading"
      className="grid gap-4 border-t border-line pt-4"
    >
      <div>
        <h3 id="gate-heading" className="text-[14px] font-semibold">
          Paywall
        </h3>
        <p className="text-[12.5px] text-sub">
          {gate.saved ? 'Saved for this post.' : 'Using the publication defaults until you save.'}
        </p>
      </div>
      <ChoiceCards
        legend="Who reads past the paywall"
        value={who}
        disabled={disabled}
        onChange={(value) => {
          touch();
          setWho(value);
        }}
        options={[
          { value: 'any', title: 'Any paid plan', description: 'Every paid subscriber.' },
          { value: 'some', title: 'Chosen plans', description: 'Only the plans you tick.' },
        ]}
      />
      {who === 'some' && (
        <fieldset className="grid gap-2">
          <legend className="sr-only">Paid plans that read past the paywall</legend>
          {levels.isPending && <LoadingRows label="Loading paid plans" rows={1} />}
          {active.length === 0 && levels.data && (
            <p className="text-[12.5px] text-sub">
              No paid plans yet.{' '}
              <Link
                to="/memberships/$channelId/levels"
                params={{ channelId }}
                className="text-purple-deep"
              >
                Create one
              </Link>
              .
            </p>
          )}
          {active.map((level) => (
            <Checkbox
              key={level.id}
              label={level.name}
              checked={levelIds.includes(level.id)}
              disabled={disabled}
              onChange={(checked) => {
                touch();
                setLevelIds(
                  checked ? [...levelIds, level.id] : levelIds.filter((id) => id !== level.id),
                );
              }}
            />
          ))}
        </fieldset>
      )}
      <Checkbox
        label="Count it on the meter"
        hint={
          meterLimit > 0
            ? `Readers without access can read ${meterLimit} paywalled post${meterLimit === 1 ? '' : 's'} each ${settings.data?.meterPeriod ?? 'month'} for free; this can be one of them.`
            : 'The meter is off for this publication, so this has no effect until it is turned on.'
        }
        checked={metered}
        disabled={disabled}
        onChange={(value) => {
          touch();
          setMetered(value);
        }}
      />
      <details className="grid gap-3">
        <summary className="cursor-pointer text-[13px] font-semibold text-purple-deep">
          Custom paywall copy
        </summary>
        <div className="mt-3">
          <GateDesignFields
            draft={design}
            fallback={settings.data?.design ?? {}}
            disabled={disabled}
            errors={errors}
            onChange={(next) => {
              touch();
              setDesign((d) => ({ ...d, ...next }));
            }}
          />
        </div>
      </details>
      {problem && (
        <p role="alert" className="text-[12.5px] font-semibold text-danger">
          {problem}
        </p>
      )}
      {apiError && <ErrorNotice message={apiError.field('levelIds') ?? apiError.message} />}
      {canEdit && (
        <div className="flex items-center gap-3">
          <Button type="submit" variant="ghost" size="sm" loading={put.isPending}>
            Save paywall
          </Button>
          <p role="status" className="text-[12.5px] text-success">
            {saved ? 'Paywall saved.' : ''}
          </p>
        </div>
      )}
      <Link
        to="/memberships/$channelId/gates"
        params={{ channelId }}
        className="text-[13px] text-purple-deep"
      >
        Meter and default paywall
      </Link>
    </form>
  );
}
