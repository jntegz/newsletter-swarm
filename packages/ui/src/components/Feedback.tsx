import type { ReactNode } from 'react';

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="grid place-items-center rounded-card-app border border-dashed border-lavender-line bg-surface-alt px-6 py-12 text-center">
      <div className="max-w-[44ch]">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {children && <div className="mt-1.5 text-[13.5px] text-sub">{children}</div>}
        {action && <div className="mt-5 flex justify-center">{action}</div>}
      </div>
    </div>
  );
}

/** Problem plus recovery, announced to assistive technology. */
export function ErrorNotice({
  title = 'Something went wrong',
  message,
  action,
}: {
  title?: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div
      role="alert"
      className="rounded-card-app border border-danger-soft bg-danger-soft px-4 py-3 text-[13.5px]"
    >
      <p className="font-semibold text-danger">{title}</p>
      <p className="mt-0.5 text-[#7a2c17]">{message}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`block animate-pulse rounded-[10px] bg-surface-alt ${className}`}
    />
  );
}

export function LoadingRows({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    // Shown after 200ms (.loading-delayed in theme.css), so quick loads don't flicker.
    <div role="status" aria-label={label} className="loading-delayed grid gap-2.5">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-12" />
      ))}
    </div>
  );
}

const PILL: Record<string, string> = {
  success: 'bg-success-soft text-success',
  neutral: 'bg-surface-alt text-sub',
  brand: 'bg-lavender text-purple-deep',
  scheduled: 'bg-scheduled-soft text-scheduled',
  danger: 'bg-danger-soft text-danger',
};

export function Pill({
  tone = 'neutral',
  children,
}: {
  tone?: keyof typeof PILL;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-pill px-2.5 py-0.5 text-[11.5px] font-semibold ${PILL[tone]}`}
    >
      {children}
    </span>
  );
}
