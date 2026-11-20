import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Base({ size = 18, children, ...props }: IconProps) {
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
      {...props}
    >
      {children}
    </svg>
  );
}

export const Send = (p: IconProps) => (
  <Base {...p}>
    <path d="M21 3 10 14M21 3l-7 18-4-7-7-4z" />
  </Base>
);
export const Members = (p: IconProps) => (
  <Base {...p}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c1.8.7 3 2.4 3.5 5.2" />
  </Base>
);
export const Flows = (p: IconProps) => (
  <Base {...p}>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="12" r="2.5" />
    <path d="M8.5 6h3a3 3 0 0 1 3 3v.5M8.5 18h3a3 3 0 0 0 3-3v-.5" />
  </Base>
);
export const Globe = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5S9.7 5.9 12 3.5z" />
  </Base>
);
export const Membership = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="6" width="18" height="13" rx="2.5" />
    <path d="M3 10.5h18M7 15h4" />
    <path d="m15.5 3 1.2 2.1M8.5 3 7.3 5.1" />
  </Base>
);
export const Settings = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.5v3M12 18.5v3M4.2 6.5l2.2 1.6M17.6 15.9l2.2 1.6M4.2 17.5l2.2-1.6M17.6 8.1l2.2-1.6" />
  </Base>
);
export const Search = (p: IconProps) => (
  <Base {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </Base>
);
export const Plus = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 5v14M5 12h14" />
  </Base>
);
export const Check = (p: IconProps) => (
  <Base {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Base>
);
export const Copy = (p: IconProps) => (
  <Base {...p}>
    <rect x="8" y="8" width="12" height="12" rx="2.5" />
    <path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8" />
  </Base>
);
export const Menu = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Base>
);
export const Close = (p: IconProps) => (
  <Base {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Base>
);
export const Templates = (p: IconProps) => (
  <Base {...p}>
    <rect x="4" y="3.5" width="16" height="17" rx="2.5" />
    <path d="M4 9h16M10 9v11.5" />
  </Base>
);

/** Growth: a rising line with an arrow head. */
export const Growth = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 17l5-5 4 4 7-7" />
    <path d="M15 9h5v5" />
  </Base>
);
// ---- Line (Nov 2026): shell, Home and editor icons. 24 viewBox, stroke 2, round caps. ----------

/** The Swarm line mark: a route with one station, for the dark rail. */
export function LineMark({ size = 24 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24">
      <path d="M2.5 12h19" stroke="var(--route-rail)" strokeWidth="3" strokeLinecap="round" />
      <circle cx="12" cy="12" r="4.6" fill="var(--rail)" stroke="#fff" strokeWidth="2.6" />
    </svg>
  );
}
export const ChevronDown = (p: IconProps) => (
  <Base {...p}>
    <path d="M6.5 9.5l5.5 5.5 5.5-5.5" />
  </Base>
);
export const ChevronRight = (p: IconProps) => (
  <Base {...p}>
    <path d="M9.5 6.5l5.5 5.5-5.5 5.5" />
  </Base>
);
export const ChevronLeft = (p: IconProps) => (
  <Base {...p}>
    <path d="M14.5 6.5L9 12l5.5 5.5" />
  </Base>
);
export const Sliders = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  </Base>
);
export const Refresh = (p: IconProps) => (
  <Base {...p}>
    <path d="M19.5 12.5a7.5 7.5 0 1 1-2.2-6.1" />
    <path d="M19.5 4.5v4h-4" />
  </Base>
);
export const Doc = (p: IconProps) => (
  <Base {...p}>
    <path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z" />
    <path d="M14 3.5V8h4.5" />
  </Base>
);
export const Layout = (p: IconProps) => (
  <Base {...p}>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <path d="M4 9.5h16M10 9.5V20" />
  </Base>
);
export const Duplicate = (p: IconProps) => (
  <Base {...p}>
    <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2" />
    <path d="M4 15.5V6a2 2 0 0 1 2-2h9.5M14.2 11.5v5.5M11.5 14.2H17" />
  </Base>
);
export const Upload = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 15V4.5M7.5 9L12 4.5 16.5 9M4.5 15v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15" />
  </Base>
);
export const Filter = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 5.5h16l-6.2 7.3v5.7l-3.6 1.8v-7.5z" />
  </Base>
);
export const Clock = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Base>
);
export const Alert = (p: IconProps) => (
  <Base {...p}>
    <path d="M10.3 4.6L3.1 17.5A2 2 0 0 0 4.8 20.5h14.4a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0z" />
    <path d="M12 9.5v4M12 17h.01" />
  </Base>
);
export const Blocked = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5.5M12 16.5h.01" />
  </Base>
);
export const SignOut = (p: IconProps) => (
  <Base {...p}>
    <path d="M14 4.5h3.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14M10 16l4-4-4-4M14 12H4.5" />
  </Base>
);
export const Bold = (p: IconProps) => (
  <Base {...p}>
    <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7.5a3.5 3.5 0 0 1 0 7H7z" />
  </Base>
);
export const Italic = (p: IconProps) => (
  <Base {...p}>
    <path d="M10.5 5H18M6 19h7.5M14.5 5l-5 14" />
  </Base>
);
export const Link = (p: IconProps) => (
  <Base {...p}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </Base>
);
export const BulletList = (p: IconProps) => (
  <Base {...p}>
    <path d="M9.5 6.5H20M9.5 12H20M9.5 17.5H20M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" />
  </Base>
);
export const NumberList = (p: IconProps) => (
  <Base {...p}>
    <path d="M10.5 6.5H20M10.5 12H20M10.5 17.5H20M4 4.8l1.5-.8v5M4 14.3c.3-.6.9-1 1.6-1 .9 0 1.5.6 1.5 1.3 0 1.4-3 2.2-3 4h3" />
  </Base>
);
export const Quote = (p: IconProps) => (
  <Base {...p}>
    <path d="M9 11H5.5V7.5A1.5 1.5 0 0 1 7 6h.5A1.5 1.5 0 0 1 9 7.5V12c0 2.6-1.4 4.6-4 5.5M19 11h-3.5V7.5A1.5 1.5 0 0 1 17 6h.5A1.5 1.5 0 0 1 19 7.5V12c0 2.6-1.4 4.6-4 5.5" />
  </Base>
);
export const Divider = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 12h16M9 6.5h6M9 17.5h6" />
  </Base>
);
export const Undo = (p: IconProps) => (
  <Base {...p}>
    <path d="M9 14L4.5 9.5 9 5" />
    <path d="M4.5 9.5H15a5 5 0 0 1 0 10h-3" />
  </Base>
);
export const Redo = (p: IconProps) => (
  <Base {...p}>
    <path d="M15 14l4.5-4.5L15 5" />
    <path d="M19.5 9.5H9a5 5 0 0 0 0 10h3" />
  </Base>
);
export const Heading = (p: IconProps) => (
  <Base {...p}>
    <path d="M6 5v14M18 5v14M6 12h12" />
  </Base>
);
export const Image = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9" cy="10" r="1.8" />
    <path d="M21 15.5l-5-5-9 9.5" />
  </Base>
);
export const ButtonBlock = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="7.5" width="18" height="9" rx="4.5" />
    <path d="M8.5 12h7" />
  </Base>
);
export const Card = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M7 10h6M7 14h10" />
  </Base>
);
export const Lock = (p: IconProps) => (
  <Base {...p}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Base>
);
export const Pen = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" />
    <path d="M13.5 6.5l4 4" />
  </Base>
);
export const Grip = (p: IconProps) => (
  <Base {...p}>
    <path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" />
  </Base>
);
export const Moon = (p: IconProps) => (
  <Base {...p}>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
  </Base>
);
export const Desktop = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M9 20h6M12 16v4" />
  </Base>
);
export const Phone = (p: IconProps) => (
  <Base {...p}>
    <rect x="7" y="3" width="10" height="18" rx="2" />
    <path d="M11 17.5h2" />
  </Base>
);
export const Poll = (p: IconProps) => (
  <Base {...p}>
    <path d="M5 20V12M12 20V5M19 20v-6" />
  </Base>
);
export const SmartBlock = (p: IconProps) => (
  <Base {...p}>
    <rect x="4" y="4" width="16" height="16" rx="2" strokeDasharray="3 3" />
    <path d="M8.5 12h7M12 8.5v7" />
  </Base>
);
export const Braces = (p: IconProps) => (
  <Base {...p}>
    <path d="M8 4.5c-1.7 0-2.5.8-2.5 2.5v2.5c0 1.2-.7 2-2 2.5 1.3.5 2 1.3 2 2.5V17c0 1.7.8 2.5 2.5 2.5M16 4.5c1.7 0 2.5.8 2.5 2.5v2.5c0 1.2.7 2 2 2.5-1.3.5-2 1.3-2 2.5V17c0 1.7-.8 2.5-2.5 2.5" />
  </Base>
);
export const Mail = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3.5 6.5l8.5 6.5 8.5-6.5" />
  </Base>
);
/** Focus mode: the corners of a page, opening out. */
export const Expand = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </Base>
);
/** Leaving focus mode: the corners, closing in. */
export const Collapse = (p: IconProps) => (
  <Base {...p}>
    <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
  </Base>
);
export const Keyboard = (p: IconProps) => (
  <Base {...p}>
    <rect x="2.5" y="6" width="19" height="12" rx="2" />
    <path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M7.5 14h9" />
  </Base>
);
/** Shown on the page (a section the reader sees). */
export const Eye = (p: IconProps) => (
  <Base {...p}>
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
  </Base>
);
/** Hidden from the page. */
export const EyeOff = (p: IconProps) => (
  <Base {...p}>
    <path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-2.9 3.9M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18" />
  </Base>
);
/** More actions, in a menu. */
export const More = (p: IconProps) => (
  <Base {...p}>
    <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" />
  </Base>
);
export const Download = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </Base>
);
export const History = (p: IconProps) => (
  <Base {...p}>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" />
    <path d="M3 4v4.5h4.5M12 8v4l3 2" />
  </Base>
);
export const Code = (p: IconProps) => (
  <Base {...p}>
    <path d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5" />
  </Base>
);
export const Overview = (p: IconProps) => (
  <Base {...p}>
    <rect x="4" y="4" width="7" height="7" rx="2" />
    <rect x="13" y="4" width="7" height="7" rx="2" />
    <rect x="4" y="13" width="7" height="7" rx="2" />
    <rect x="13" y="13" width="7" height="7" rx="2" />
  </Base>
);
