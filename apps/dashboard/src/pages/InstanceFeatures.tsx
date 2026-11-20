import { ErrorNotice, LoadingRows, Switch } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { instanceFeaturesQuery, useSaveInstanceFeature } from '../api/instance';
import {
  arrangeFeatures,
  FEATURE_SAVED,
  FEATURE_SAVING,
  featureSaveError,
  FEATURES_INTRO,
  type FeatureRow,
} from './instance-features';

interface FeatureSwitchViewProps {
  row: FeatureRow;
  /** The state being saved, while a save is under way. */
  saving?: boolean | undefined;
  saved?: boolean;
  error?: string | undefined;
  onChange: (enabled: boolean) => void;
}

/** One feature: its switch, and in words whether the last change is saving, saved or failed. */
export function FeatureSwitchView({ row, saving, saved, error, onChange }: FeatureSwitchViewProps) {
  const isSaving = saving !== undefined;
  return (
    <li className="border-t border-line py-3.5">
      <Switch
        label={row.label}
        hint={row.help}
        checked={saving ?? row.enabled}
        loading={isSaving}
        error={error ? featureSaveError(row.enabled, error) : undefined}
        onChange={onChange}
      />
      <p
        role="status"
        className={`mt-1 text-[12.5px] empty:hidden ${isSaving ? 'text-sub' : 'text-success'}`}
      >
        {isSaving ? FEATURE_SAVING : saved ? FEATURE_SAVED : ''}
      </p>
    </li>
  );
}

function FeatureSwitch({ row }: { row: FeatureRow }) {
  const save = useSaveInstanceFeature();
  return (
    <FeatureSwitchView
      row={row}
      saving={save.isPending ? save.variables.enabled : undefined}
      saved={save.isSuccess}
      error={save.error?.message}
      onChange={(enabled) => save.mutate({ key: row.key, enabled })}
    />
  );
}

/** Settings → Instance: the switches for the whole Swarm. The page shows this to its owners only. */
export function InstanceFeatures() {
  const features = useQuery(instanceFeaturesQuery);
  return (
    <section aria-labelledby="features-title" className="grid max-w-[560px] gap-6">
      <div>
        <h2 id="features-title" className="text-[16px] font-semibold">
          Features
        </h2>
        <p className="mt-1 text-[13px] text-sub">{FEATURES_INTRO}</p>
      </div>
      {features.isPending && <LoadingRows label="Loading features" rows={4} />}
      {features.error && <ErrorNotice message={features.error.message} />}
      {features.data &&
        arrangeFeatures(features.data).map((group) => (
          <div key={group.title}>
            <h3 className="text-[14px] font-semibold">{group.title}</h3>
            {group.note && <p className="mt-0.5 text-[13px] text-sub">{group.note}</p>}
            <ul className="mt-2.5 border-b border-line">
              {group.rows.map((row) => (
                <FeatureSwitch key={row.key} row={row} />
              ))}
            </ul>
          </div>
        ))}
    </section>
  );
}
