/**
 * components/primitives/icon-base.tsx — the icon geometry (16px box, 1.5px
 * stroke, round caps/joins, currentColor) and the few glyphs the Verse rail
 * draws at first paint. Everything here is re-exported by icons.tsx, which
 * remains the console's icon set and the import site for everyone else.
 *
 * WHY SPLIT: icons.tsx holds every glyph any surface uses, and the rail is on
 * the chat first-paint path; importing it there put the whole set (~4 KB) in
 * the chat first-paint critical JS (SPEC-310A §1). Add a glyph here only when
 * a first-paint module draws it.
 *
 * Every icon is decorative by default (`aria-hidden`); pass `title` only when
 * the icon is the sole carrier of meaning (it then becomes `role="img"`).
 */
import type { ReactNode, SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children' | 'viewBox'> {
  /** Edge length in px. Defaults to 16 — the design language's icon size. */
  size?: number;
  /** Accessible name. Omit for decorative icons (the default). */
  title?: string;
}

export function Icon({ size = 16, title, children, ...rest }: IconProps & { children: ReactNode }) {
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

/** Inbox — approvals. */
export const IconInbox = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2 9.5 3.6 3.4A1.5 1.5 0 0 1 5.05 2.3h5.9a1.5 1.5 0 0 1 1.45 1.1L14 9.5" />
    <path d="M2 9.5h3l.8 1.6h4.4l.8-1.6h3v2.6A1.9 1.9 0 0 1 12.1 14H3.9A1.9 1.9 0 0 1 2 12.1V9.5Z" />
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
