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
 * Four icons stay drawn here because the shared set has no equivalent and
 * they are Verse-specific chrome, not general console vocabulary:
 * `PanelIcon` / `SidebarIcon` (the two pane toggles, which must read as
 * mirror images of each other), `VerseMark` (the brand mark in the rail
 * head, which is 32px and never takes a color state) and `McpIcon` (a plug —
 * the shared set has no connector glyph, and every candidate in it already
 * means another rail section).
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

export const SECTION_ICON: Record<VerseSectionId, ComponentType<IconProps>> = {
  chat: ChatIcon,
  autonomy: AutonomyIcon,
  approvals: ApprovalsIcon,
  usage: UsageIcon,
  settings: SettingsIcon,
  mcp: McpIcon,
};
