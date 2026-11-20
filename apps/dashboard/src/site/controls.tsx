// Small form pieces shared by the Site Studio pages.
import { Button, ErrorNotice } from '@swarm/ui/components';
import { useId, type ReactNode } from 'react';
import { ApiError } from '../api/client';

/** A radio group drawn as cards: each option has a title and a line of explanation. */
export function ChoiceCards<T extends string>({
  legend,
  value,
  options,
  disabled,
  onChange,
}: {
  legend: string;
  value: T;
  options: { value: T; title: string; description: ReactNode }[];
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  const name = useId();
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1.5 text-[13px] font-semibold">{legend}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => (
          <div
            key={option.value}
            className={`flex items-start gap-3 rounded-card-app border px-4 py-3 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-purple ${
              value === option.value
                ? 'border-purple bg-lavender'
                : 'border-line-control hover:border-line-control-hover'
            }`}
          >
            <input
              id={`${name}-${option.value}`}
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              disabled={disabled}
              onChange={() => onChange(option.value)}
              className="mt-1 size-4 accent-purple disabled:cursor-not-allowed"
            />
            <label
              htmlFor={`${name}-${option.value}`}
              className={`grid flex-1 gap-0.5 ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
            >
              <span className="text-[13.5px] font-semibold">{option.title}</span>
              {/* text-sub is just below AA on lavender: the chosen option uses darker text. */}
              <span
                className={`text-[12.5px] ${value === option.value ? 'text-ink/75' : 'text-sub'}`}
              >
                {option.description}
              </span>
            </label>
          </div>
        ))}
      </div>
    </fieldset>
  );
}

/** The submit row: Save, then a polite status once saved. Errors without a field go here. */
export function SaveRow({
  label = 'Save changes',
  pending,
  saved,
  error,
  disabled,
}: {
  label?: string;
  pending: boolean;
  saved: boolean;
  error: unknown;
  disabled?: boolean;
}) {
  const apiError = error instanceof ApiError ? error : null;
  return (
    <div className="grid gap-3">
      {apiError && !apiError.details.length && <ErrorNotice message={apiError.message} />}
      {error instanceof Error && !(error instanceof ApiError) && (
        <ErrorNotice message={error.message} />
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" loading={pending} disabled={disabled}>
          {label}
        </Button>
        <p role="status" className="text-[13px] text-success">
          {saved ? 'Saved.' : ''}
        </p>
      </div>
    </div>
  );
}

/** Shown instead of controls the operator's role can't use. */
export function ReadOnlyNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-card-app bg-surface-alt px-3.5 py-2.5 text-[12.5px] text-sub">
      {children}
    </p>
  );
}
