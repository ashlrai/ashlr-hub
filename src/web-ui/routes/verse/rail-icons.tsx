/**
 * routes/verse/rail-icons.tsx — the icons the shell rail draws at first
 * paint: the section glyphs, Needs you, the gear and the Verse mark.
 *
 * Split from verse-icons.tsx (which re-exports all of these) because the
 * rail is on the chat first-paint path: importing verse-icons there pulled
 * every Verse glyph and the whole shared icon set into the chat first-paint
 * critical JS (SPEC-310A §1). This module imports only icon-base.tsx, the
 * shared set's first-paint subset. See verse-icons.tsx for why each glyph is
 * drawn here or aliased onto the shared set.
 */
import type { ComponentType, ReactNode } from 'react';
import { IconChat, IconGauge, IconInbox, IconSliders, type IconProps } from '../../components/primitives/icon-base.js';
import type { VerseSectionId } from './verse-ui-store.js';

export const ChatIcon = IconChat;
export const UsageIcon = IconGauge;
export const SettingsIcon = IconSliders;

/** The Verse chrome geometry (verse-icons.tsx draws its local glyphs with it too). */
export function Icon({ size = 16, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/**
 * The mark in the rail head: the Ashlr.AI keystone "A" (traced from the brand
 * mark, ashlar-landing public/logos/ashlar-mark.png). The legs take the ink
 * colour so it reads in light and dark themes; the core keeps the brand blue
 * (#2563EB). Not a section icon — it never gets a color state.
 */
export function VerseMark(props: IconProps) {
  const { size = 20, ...rest } = props;
  return (
    <svg viewBox="54 67 146 124" width={size} height={size} aria-hidden="true" focusable="false" {...rest}>
      <path fill="currentColor" d="M106 76H123V115H100L113 154L99 179H72L59 156Z M130 76H147L194 156L181 179H154L140 154L153 115H130Z" />
      <path fill="#2563EB" d="M110 121H143L133 152H120Z" />
    </svg>
  );
}

/** Command — the morning read: a dashboard of unequal panes. */
export function CommandIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="2.5" width="5" height="6" rx="1" />
      <rect x="8.5" y="2.5" width="5" height="3.5" rx="1" />
      <rect x="8.5" y="7.5" width="5" height="6" rx="1" />
      <rect x="2.5" y="10" width="5" height="3.5" rx="1" />
    </Icon>
  );
}

/** Fleet — lanes of work, each with its runner (the live swimlane). */
export function FleetIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 4.5h5M2.5 8h9M2.5 11.5h3.5" />
      <circle cx="10" cy="4.5" r="1.3" />
      <circle cx="13.2" cy="8" r="1.3" />
      <circle cx="8.5" cy="11.5" r="1.3" />
    </Icon>
  );
}

/** Growth — a trend that climbs. */
export function GrowthIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 12.5 6.5 8.5l2.5 2.5 4.5-5" />
      <path d="M10.5 6h3v3" />
    </Icon>
  );
}

/** Mind — the Leader's thinking: a lit bulb. */
export function MindIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2.5a4 4 0 0 0-2.4 7.2c.3.25.4.6.4 1v.8h4v-.8c0-.4.1-.75.4-1A4 4 0 0 0 8 2.5Z" />
      <path d="M6.5 13.5h3" />
    </Icon>
  );
}

/** Apps & Accounts — a grid of tiles. */
export function AppsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
    </Icon>
  );
}

/** The gear tray (Settings, Apps, Usage, Shortcuts). */
export function GearIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.8v1.7M8 12.5v1.7M14.2 8h-1.7M3.5 8H1.8M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2M12.4 12.4l-1.2-1.2M4.8 4.8 3.6 3.6" />
      <circle cx="8" cy="8" r="4.4" />
    </Icon>
  );
}

/** Needs you — the one inbox (⌘J). */
export const NeedsYouIcon = IconInbox;

export const SECTION_ICON: Record<VerseSectionId, ComponentType<IconProps>> = {
  command: CommandIcon,
  fleet: FleetIcon,
  growth: GrowthIcon,
  mind: MindIcon,
  chat: ChatIcon,
  settings: SettingsIcon,
  apps: AppsIcon,
  usage: UsageIcon,
};
