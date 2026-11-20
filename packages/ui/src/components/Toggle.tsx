import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Spinner } from './Button';

interface CheckboxProps {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  checked: boolean;
  /** Shown as "some selected"; the native control still reports `checked`. */
  indeterminate?: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

/** A native checkbox with its label, hint and error wired together. */
export function Checkbox({
  label,
  hint,
  error,
  checked,
  indeterminate = false,
  disabled,
  onChange,
}: CheckboxProps) {
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="flex items-start gap-2.5 text-[13.5px]">
      <input
        ref={ref}
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
        aria-invalid={error ? true : undefined}
        className="mt-1 size-4 accent-purple disabled:cursor-not-allowed"
      />
      <div>
        <label
          htmlFor={id}
          className={`font-semibold ${disabled ? 'cursor-not-allowed text-sub' : ''}`}
        >
          {label}
        </label>
        {hint && (
          <p id={hintId} className="text-[12.5px] text-sub">
            {hint}
          </p>
        )}
        {error && (
          <p id={errorId} role="alert" className="text-[12.5px] font-semibold text-danger">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

interface SwitchProps {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  checked: boolean;
  disabled?: boolean;
  /** While a change is being saved: stays focusable, ignores presses. */
  loading?: boolean;
  onChange: (checked: boolean) => void;
}

/**
 * An on/off control that takes effect at once (role="switch"). Space and Enter toggle it, as for
 * any button. Use a Checkbox instead when the choice is saved with the rest of a form.
 */
export function Switch({
  label,
  hint,
  error,
  checked,
  disabled = false,
  loading = false,
  onChange,
}: SwitchProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const inert = disabled || loading;
  return (
    <div className="flex items-start justify-between gap-4 text-[13.5px]">
      <div>
        <label
          htmlFor={id}
          className={`font-semibold ${disabled ? 'cursor-not-allowed text-sub' : ''}`}
        >
          {label}
        </label>
        {hint && (
          <p id={hintId} className="text-[12.5px] text-sub">
            {hint}
          </p>
        )}
        {error && (
          <p id={errorId} role="alert" className="text-[12.5px] font-semibold text-danger">
            {error}
          </p>
        )}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
        aria-busy={loading || undefined}
        aria-disabled={inert || undefined}
        disabled={disabled}
        onClick={() => {
          if (!inert) onChange(!checked);
        }}
        className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-pill border transition-colors focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-purple disabled:cursor-not-allowed disabled:opacity-55 ${
          checked
            ? 'border-purple bg-purple hover:bg-purple-deep'
            : 'border-line-control bg-surface-alt hover:border-line-control-hover'
        } ${error ? 'border-danger' : ''}`}
      >
        <span
          aria-hidden="true"
          className={`grid size-[18px] place-items-center rounded-pill bg-surface text-purple shadow-soft transition-transform ${
            checked ? 'translate-x-[19px]' : 'translate-x-[2px]'
          }`}
        >
          {loading && <Spinner />}
        </span>
      </button>
    </div>
  );
}
