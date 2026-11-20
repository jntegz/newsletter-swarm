// A labelled <select> that takes <option> children (the shared SelectField takes an options list),
// for pickers with an empty choice and computed labels.
import { FieldShell } from '@swarm/ui/components';
import type { ReactNode, SelectHTMLAttributes } from 'react';

const CONTROL =
  'min-h-11 w-full rounded-control border bg-surface px-3.5 text-[14px] text-ink outline-none transition-colors focus-visible:border-purple focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-purple disabled:bg-surface-alt disabled:text-sub';

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  children: ReactNode;
}

export function SelectField({
  label,
  hint,
  error,
  className = '',
  children,
  ...props
}: SelectProps) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      {({ id, describedBy, invalid }) => (
        <select
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          className={`${CONTROL} ${
            invalid ? 'border-danger' : 'border-line-control hover:border-line-control-hover'
          } ${className}`}
          {...props}
        >
          {children}
        </select>
      )}
    </FieldShell>
  );
}
