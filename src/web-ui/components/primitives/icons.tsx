/**
 * components/primitives/icons.tsx — the console's icon set.
 *
 * Hand-drawn inline SVG rather than an icon package: the design language
 * fixes one geometry (16px box, 1.5px stroke, round caps/joins, currentColor)
 * and the app ships zero runtime dependencies for presentation. Adding a
 * library here would import hundreds of icons drawn to someone else's stroke
 * weight for the six we actually need per section.
 *
 * Every icon is decorative by default (`aria-hidden`), because it sits next
 * to a label or inside a control that already has an accessible name. Pass
 * `title` ONLY when the icon is the sole carrier of meaning; it then becomes
 * `role="img"` with an accessible name.
 */
import type { ReactNode, SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children' | 'viewBox'> {
  /** Edge length in px. Defaults to 16 — the design language's icon size. */
  size?: number;
  /** Accessible name. Omit for decorative icons (the default). */
  title?: string;
}

function Icon({ size = 16, title, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...(title ? { role: 'img' } : { 'aria-hidden': true })}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

/** Chat — the transcript section. */
export const IconChat = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 11.5V4.25A1.75 1.75 0 0 1 4.25 2.5h7.5a1.75 1.75 0 0 1 1.75 1.75v4.5a1.75 1.75 0 0 1-1.75 1.75H5.5L2.5 13.5v-2Z" />
  </Icon>
);

/** CPU — autonomy / the daemon loop. */
export const IconCpu = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" />
    <path d="M6.5 1.5v3M9.5 1.5v3M6.5 11.5v3M9.5 11.5v3M1.5 6.5h3M1.5 9.5h3M11.5 6.5h3M11.5 9.5h3" />
  </Icon>
);

/** Inbox — approvals. */
export const IconInbox = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2 9.5 3.6 3.4A1.5 1.5 0 0 1 5.05 2.3h5.9a1.5 1.5 0 0 1 1.45 1.1L14 9.5" />
    <path d="M2 9.5h3l.8 1.6h4.4l.8-1.6h3v2.6A1.9 1.9 0 0 1 12.1 14H3.9A1.9 1.9 0 0 1 2 12.1V9.5Z" />
  </Icon>
);

export const IconCheck = (p: IconProps) => (
  <Icon {...p}>
    <path d="m3 8.5 3.2 3.2L13 5" />
  </Icon>
);

export const IconCheckCircle = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="m5.2 8.2 1.9 1.9 3.7-4" />
  </Icon>
);

export const IconX = (p: IconProps) => (
  <Icon {...p}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Icon>
);

/** Gauge — usage / spend. */
export const IconGauge = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.2 11.5a6.4 6.4 0 1 1 11.6 0" />
    <path d="M8 11 10.8 6.6" />
    <circle cx="8" cy="11.6" r="0.9" fill="currentColor" stroke="none" />
  </Icon>
);

/** Sliders — settings. */
export const IconSliders = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 4.5h4M9.5 4.5h4M2.5 11.5h2M7.5 11.5h6" />
    <circle cx="8" cy="4.5" r="1.6" />
    <circle cx="6" cy="11.5" r="1.6" />
  </Icon>
);

export const IconPlay = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5.5 3.4 12 8l-6.5 4.6V3.4Z" />
  </Icon>
);

export const IconStop = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4" y="4" width="8" height="8" rx="1.2" />
  </Icon>
);

export const IconPause = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 3.5v9M10 3.5v9" />
  </Icon>
);

/** Alert — a warning that is paired with text, never used alone for state. */
export const IconAlert = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2.6 14.2 13H1.8L8 2.6Z" />
    <path d="M8 6.6v3" />
    <circle cx="8" cy="11.3" r="0.75" fill="currentColor" stroke="none" />
  </Icon>
);

export const IconInfo = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 7.4v3.4" />
    <circle cx="8" cy="5.4" r="0.75" fill="currentColor" stroke="none" />
  </Icon>
);

export const IconPlus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 3.2v9.6M3.2 8h9.6" />
  </Icon>
);

export const IconSearch = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="7.2" cy="7.2" r="4.2" />
    <path d="m10.4 10.4 3.1 3.1" />
  </Icon>
);

export const IconCopy = (p: IconProps) => (
  <Icon {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 3.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3.5v5A1.5 1.5 0 0 0 4 10" />
  </Icon>
);

export const IconChevronDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="m4 6.2 4 4 4-4" />
  </Icon>
);

export const IconChevronUp = (p: IconProps) => (
  <Icon {...p}>
    <path d="m4 9.8 4-4 4 4" />
  </Icon>
);

export const IconChevronRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6.2 4 4 4-4 4" />
  </Icon>
);

export const IconChevronLeft = (p: IconProps) => (
  <Icon {...p}>
    <path d="m9.8 4-4 4 4 4" />
  </Icon>
);

export const IconMic = (p: IconProps) => (
  <Icon {...p}>
    <rect x="6" y="1.8" width="4" height="7.4" rx="2" />
    <path d="M3.6 7.6a4.4 4.4 0 0 0 8.8 0M8 11.9v2.3" />
  </Icon>
);

export const IconSend = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 2 7.2 8.8M14 2l-4.4 12-2.4-5.2L2 6.4 14 2Z" />
  </Icon>
);

export const IconTrash = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.8 4.2h10.4M6.4 4.2V2.8h3.2v1.4M4.2 4.2l.6 8.2a1.3 1.3 0 0 0 1.3 1.2h3.8a1.3 1.3 0 0 0 1.3-1.2l.6-8.2" />
  </Icon>
);

export const IconExternalLink = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9.5 2.5H13.5v4M13.5 2.5 7.8 8.2" />
    <path d="M12.5 9.6v2.9a1.5 1.5 0 0 1-1.5 1.5H3.5A1.5 1.5 0 0 1 2 12.5V5a1.5 1.5 0 0 1 1.5-1.5h2.9" />
  </Icon>
);

export const IconFolder = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2 4.6A1.6 1.6 0 0 1 3.6 3h2.3l1.4 1.8h5.1A1.6 1.6 0 0 1 14 6.4v5A1.6 1.6 0 0 1 12.4 13H3.6A1.6 1.6 0 0 1 2 11.4V4.6Z" />
  </Icon>
);

export const IconRefresh = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13.2 7.2a5.2 5.2 0 1 0-.7 3.5" />
    <path d="M13.5 3.4v3.9h-3.9" />
  </Icon>
);

export const IconLock = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="7" width="10" height="6.5" rx="1.5" />
    <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
  </Icon>
);

export const IconKey = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="5.4" cy="10.6" r="2.6" />
    <path d="m7.4 8.7 5.3-5.3M10.6 5.5l1.4 1.4M12.2 3.9l1.4 1.4" />
  </Icon>
);

export const IconSun = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="3.1" />
    <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1" />
  </Icon>
);

export const IconMoon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13 9.8A5.6 5.6 0 0 1 6.2 3a5.6 5.6 0 1 0 6.8 6.8Z" />
  </Icon>
);

export const IconMonitor = (p: IconProps) => (
  <Icon {...p}>
    <rect x="1.8" y="2.8" width="12.4" height="8.4" rx="1.5" />
    <path d="M5.8 14h4.4M8 11.2V14" />
  </Icon>
);

export const IconDrag = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="6" cy="4" r="1" fill="currentColor" stroke="none" />
    <circle cx="10" cy="4" r="1" fill="currentColor" stroke="none" />
    <circle cx="6" cy="8" r="1" fill="currentColor" stroke="none" />
    <circle cx="10" cy="8" r="1" fill="currentColor" stroke="none" />
    <circle cx="6" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="10" cy="12" r="1" fill="currentColor" stroke="none" />
  </Icon>
);

export const IconKeyboard = (p: IconProps) => (
  <Icon {...p}>
    <rect x="1.5" y="4" width="13" height="8" rx="1.5" />
    <path d="M4.2 6.6h.01M6.8 6.6h.01M9.4 6.6h.01M12 6.6h.01M4.2 9.4h.01M12 9.4h.01M6.4 9.4h3.2" />
  </Icon>
);
