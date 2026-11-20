import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'ghost' | 'danger' | 'quiet';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'md' | 'sm';
  loading?: boolean;
  icon?: ReactNode;
}

const VARIANT: Record<Variant, string> = {
  primary: 'btn-primary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
  quiet: 'btn-quiet',
};

/**
 * Defaults to type="button": a button only submits a form when it says so.
 * While loading it stays focusable, announces its state and ignores clicks.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  type = 'button',
  className = '',
  children,
  disabled,
  onClick,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`${VARIANT[variant]} ${size === 'sm' ? 'btn-sm' : ''} ${className}`}
      aria-busy={loading || undefined}
      aria-disabled={disabled || loading || undefined}
      disabled={disabled}
      onClick={(event) => {
        if (loading) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      {...props}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className="inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent"
    />
  );
}
