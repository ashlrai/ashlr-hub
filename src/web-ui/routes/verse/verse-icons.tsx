/**
 * routes/verse/verse-icons.tsx — the icons the shell rail and the chat chrome
 * use, under the names the Verse surfaces already import.
 *
 * Owner A's `components/primitives/icons.tsx` is now the drawing authority:
 * one geometry (16px box, 1.5px stroke, round caps/joins, currentColor), one
 * stroke weight, one accessibility convention. Everything below that has an
 * equivalent there is an ALIAS of it, so the rail and the inbox cannot drift
 * to two different chat glyphs.
 *
 * 3.10 adds the workbench surfaces (Command, Fleet, Growth, Mind), the gear
 * tray and Apps. They are drawn here, not in the shared set, because they
 * name Verse surfaces — a console page borrowing "Fleet" would be a lie.
 *
 * Five icons stay drawn here because the shared set has no equivalent and
 * they are Verse-specific chrome, not general console vocabulary:
 * `PanelIcon` / `SidebarIcon` (the two pane toggles, which must read as
 * mirror images of each other), `RailToggleIcon` (the rail's own expand /
 * collapse control, which has to read as the same family as those two),
 * `VerseMark` (the brand mark in the rail head, which is 32px and never takes
 * a color state) and `McpIcon` (a plug — the shared set has no connector
 * glyph, and every candidate in it already means another rail section).
 */
import type { ComponentType, ReactNode } from 'react';
import {
  IconChat,
  IconChevronDown,
  IconChevronRight,
  IconCpu,
  IconGauge,
  IconInbox,
  IconMoon,
  IconPlus,
  IconSearch,
  IconSliders,
  IconTrash,
  type IconProps,
} from '../../components/primitives/icons.js';
import type { VerseSectionId } from './verse-ui-store.js';

export type { IconProps };

/**
 * Aliases onto the shared set. The names are the ones the Verse rail, sidebar
 * and composer already import — keeping them means this reconciliation
 * touched no call site.
 */
export const ChatIcon = IconChat;
export const AutonomyIcon = IconCpu;
export const ApprovalsIcon = IconInbox;
export const UsageIcon = IconGauge;
export const SettingsIcon = IconSliders;
export const SearchIcon = IconSearch;
export const PlusIcon = IconPlus;
export const TrashIcon = IconTrash;
export const ArrowDownIcon = IconChevronDown;
export const ChevronIcon = IconChevronRight;
/** The rail's theme quick-toggle. One glyph for the control, not per-theme. */
export const ThemeIcon = IconMoon;

/** Local shell chrome — see the header note for why these three stay here. */
function Icon({ size = 16, children, ...rest }: IconProps & { children: ReactNode }) {
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

export function PanelIcon(props: IconProps) {
  return <Icon {...props}><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M10 3v10" /></Icon>;
}

export function SidebarIcon(props: IconProps) {
  return <Icon {...props}><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M6 3v10" /></Icon>;
}

/**
 * The rail's own expand/collapse control: the same framed panel as the two
 * pane toggles above, plus a chevron saying which way it is about to move.
 * ONE glyph that rotates rather than two drawings, so the control reads as a
 * single thing in two states — and so the state is carried by direction, the
 * one property a user can read without having memorised the other icon.
 */
export function RailToggleIcon({ expanded = false, ...props }: IconProps & { expanded?: boolean }) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <path d="M6 3v10" />
      {expanded ? <path d="M11.2 6.4 9.6 8l1.6 1.6" /> : <path d="M9.4 6.4 11 8l-1.6 1.6" />}
    </Icon>
  );
}

/**
 * MCP — a plug in a socket. Drawn here rather than aliased: the shared set's
 * nearest candidates (`IconCpu`, `IconSliders`, `IconKey`) are already the
 * Autonomy, Settings and credential glyphs, and two rail items that read as
 * the same picture is worse than one more 16px drawing.
 */
export function McpIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 1.8v3.2M10 1.8v3.2" />
      <path d="M3.8 5h8.4v2.6a4.2 4.2 0 0 1-4.2 4.2 4.2 4.2 0 0 1-4.2-4.2V5Z" />
      <path d="M8 11.8v2.4" />
    </Icon>
  );
}

/** The mark in the rail head. Not a section icon — it never gets a color state. */
export function VerseMark(props: IconProps) {
  const { size = 20, ...rest } = props;
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinejoin="round" strokeLinecap="round" aria-hidden="true" focusable="false" {...rest}>
      <path d="m5 11 11-6 11 6-11 6Z M5 16l11 6 11-6 M5 21l11 6 11-6" />
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
