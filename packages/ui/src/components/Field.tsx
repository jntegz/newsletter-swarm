import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

interface FieldShellProps {
  label: string;
  /** Keeps the label for assistive technology only: for a toolbar field whose placeholder and
   *  neighbours already say what it is (a search box over a list). */
  hideLabel?: boolean | undefined;
  hint?: ReactNode;
  error?: string | undefined;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

/**
 * Label, control, hint and error, wired together with ids so screen readers announce all of them.
 * Packed to the top (content-start): in a grid row where a neighbour has a hint or an error and
 * this field has none, the row stretches this field, and its label and control stay put.
 */
export function FieldShell({ label, hideLabel = false, hint, error, children }: FieldShellProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="grid content-start gap-1.5">
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'text-[13px] font-semibold'}>
        {label}
      </label>
      {children({ id, describedBy, invalid: !!error })}
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
  );
}

const CONTROL =
  'w-full rounded-control border bg-surface px-3.5 text-[14px] text-ink outline-none transition-colors placeholder:text-sub focus-visible:border-purple focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-purple disabled:bg-surface-alt disabled:text-sub';

const border = (invalid: boolean) =>
  invalid ? 'border-danger' : 'border-line-control hover:border-line-control-hover';

/**
 * Control height. `md` is 40px, the form default; `sm` is 36px, the height of a default Button,
 * for a toolbar row where fields, selects and buttons sit side by side. In px, because buttons are.
 */
export type FieldSize = 'md' | 'sm';
const HEIGHT: Record<FieldSize, string> = { md: 'min-h-[40px]', sm: 'min-h-[36px]' };

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'size'> {
  label: string;
  hideLabel?: boolean | undefined;
  hint?: ReactNode;
  error?: string | undefined;
  size?: FieldSize;
}

export function TextField({
  label,
  hideLabel,
  hint,
  error,
  size = 'md',
  className = '',
  ...props
}: TextFieldProps) {
  return (
    <FieldShell label={label} hideLabel={hideLabel} hint={hint} error={error}>
      {({ id, describedBy, invalid }) => (
        <input
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          className={`${CONTROL} ${HEIGHT[size]} ${border(invalid)} ${className}`}
          {...props}
        />
      )}
    </FieldShell>
  );
}

interface TextAreaFieldProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
}

export function TextAreaField({
  label,
  hint,
  error,
  className = '',
  ...props
}: TextAreaFieldProps) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      {({ id, describedBy, invalid }) => (
        <textarea
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          className={`${CONTROL} min-h-24 py-2.5 leading-[1.5] ${border(invalid)} ${className}`}
          {...props}
        />
      )}
    </FieldShell>
  );
}

export interface SelectFieldProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'id' | 'size'
> {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  options: { value: string; label: string }[];
  size?: FieldSize;
  hideLabel?: boolean | undefined;
}

export function SelectField({
  label,
  hideLabel,
  hint,
  error,
  options,
  size = 'md',
  className = '',
  ...props
}: SelectFieldProps) {
  return (
    <FieldShell label={label} hideLabel={hideLabel} hint={hint} error={error}>
      {({ id, describedBy, invalid }) => (
        <select
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          className={`${CONTROL} ${HEIGHT[size]} ${border(invalid)} ${className}`}
          {...props}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </FieldShell>
  );
}
