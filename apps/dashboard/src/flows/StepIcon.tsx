// Hand-authored step icons for the Flow canvas and palette (24px grid, currentColor).
import type { FlowNodeType } from '@swarm/domain';
import type { ReactNode } from 'react';

const PATHS: Record<FlowNodeType, ReactNode> = {
  trigger: <path d="M13 3 5 14h6l-1 7 8-11h-6z" />,
  send_email: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
      <path d="m4.5 7 7.5 6 7.5-6" />
    </>
  ),
  delay: (
    <>
      <circle cx="12" cy="13" r="7.5" />
      <path d="M12 9v4l2.5 2.5M9.5 3h5" />
    </>
  ),
  wait_for_event: (
    <>
      <path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  add_tag: (
    <>
      <path d="M3.5 12.5V4.5h8l9 9-8 8z" />
      <circle cx="8" cy="9" r="1.3" />
    </>
  ),
  remove_tag: (
    <>
      <path d="M3.5 12.5V4.5h8l9 9-8 8z" />
      <path d="M10 14.5h5" />
    </>
  ),
  update_field: (
    <>
      <path d="M4 20h4L19.5 8.5a2.8 2.8 0 0 0-4-4L4 16z" />
      <path d="m13.5 6.5 4 4" />
    </>
  ),
  change_level: (
    <>
      <path d="m12 3 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8-4.3-4.1 5.9-.9z" />
    </>
  ),
  enrol_flow: (
    <>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="18" cy="18" r="2.2" />
      <path d="M8.2 6H14a4 4 0 0 1 4 4v5.8" />
    </>
  ),
  branch: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="9" r="2" />
      <path d="M6 7v10M18 11c0 4-6 3-11.5 6.5" />
    </>
  ),
  ab_split: (
    <>
      <path d="M12 3v6M12 9l-6 6v6M12 9l6 6v6" />
    </>
  ),
  webhook_call: (
    <>
      <path d="M9 7a3 3 0 1 1 4.5 2.6L16 14" />
      <circle cx="17.5" cy="16.5" r="2.5" />
      <circle cx="6.5" cy="16.5" r="2.5" />
      <path d="M9 16.5h5.5M10.5 9.5 7.5 14" />
    </>
  ),
  notify_author: (
    <>
      <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </>
  ),
  exit: (
    <>
      <path d="M14 4h4.5a1.5 1.5 0 0 1 1.5 1.5v13a1.5 1.5 0 0 1-1.5 1.5H14" />
      <path d="M10 8l-4 4 4 4M6 12h9" />
    </>
  ),
};

export function StepIcon({ type, size = 16 }: { type: FlowNodeType; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[type]}
    </svg>
  );
}
