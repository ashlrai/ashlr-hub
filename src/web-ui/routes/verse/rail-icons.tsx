/**
 * routes/verse/rail-icons.tsx — the icons the shell rail draws at first
 * paint: the rail sections' glyphs, Needs you, the gear and the Verse mark.
 * The gear tray's glyphs (Settings, Apps, Usage) are drawn only once the
 * tray opens, so they live in verse-icons.tsx with SECTION_ICON.
 *
 * Split from verse-icons.tsx (which re-exports all of these) because the
 * rail is on the chat first-paint path: importing verse-icons there pulled
 * every Verse glyph and the whole shared icon set into the chat first-paint
 * critical JS (SPEC-310A §1). This module imports only icon-base.tsx, the
 * shared set's first-paint subset. See verse-icons.tsx for why each glyph is
 * drawn here or aliased onto the shared set.
 */
import type { ComponentType, ReactNode } from 'react';
import { IconChat, IconInbox, type IconProps } from '../../components/primitives/icon-base.js';
import type { VerseSectionId } from './verse-ui-store.js';

export const ChatIcon = IconChat;

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

/** Phantom ghost geometry from the first-party MIT asset; see docs/PHANTOM-BRAND.md. */
export function VerseMark(props: IconProps) {
  const { size = 20, ...rest } = props;
  return (
    <svg viewBox="4 0 24 27" width={size} height={size} aria-hidden="true" focusable="false" {...rest}>
      <path fill="currentColor" d="M16 2C10.5 2 6 6.5 6 12v10.5c0 .8.7 1.5 1.5 1.5H10c0-2 1.3-3.5 2.5-3.5S15 22 15 24h2c0-2 1.3-3.5 2.5-3.5S22 22 22 24h2.5c.8 0 1.5-.7 1.5-1.5V12c0-5.5-4.5-10-10-10z" />
      <path d="M8 12a8 8 0 0 1 8-8" fill="none" stroke="#fff" strokeOpacity=".28" strokeWidth="1.5" strokeLinecap="round" />
      <ellipse cx="12.5" cy="13.5" rx="2.2" ry="2.6" fill="#f7faff" />
      <ellipse cx="19.5" cy="13.5" rx="2.2" ry="2.6" fill="#f7faff" />
      <ellipse cx="13" cy="13.8" rx=".9" ry="1.3" fill="#172442" />
      <ellipse cx="20" cy="13.8" rx=".9" ry="1.3" fill="#172442" />
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

/** Agents — a board of cards in columns (the attention board, ⌘6). */
export function AgentsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2" y="2.5" width="3.4" height="11" rx="1" />
      <rect x="6.3" y="2.5" width="3.4" height="7" rx="1" />
      <rect x="10.6" y="2.5" width="3.4" height="9" rx="1" />
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

/** The rail sections' glyphs (SECTION_ICON in verse-icons.tsx adds the tray's). */
export const RAIL_ICON: Readonly<Partial<Record<VerseSectionId, ComponentType<IconProps>>>> = {
  command: CommandIcon,
  fleet: FleetIcon,
  growth: GrowthIcon,
  mind: MindIcon,
  chat: ChatIcon,
  agents: AgentsIcon,
};
