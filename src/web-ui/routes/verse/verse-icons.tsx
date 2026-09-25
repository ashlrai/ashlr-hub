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
 * a color state; drawn in rail-icons.tsx with the other rail glyphs) and `McpIcon` (a plug — the shared set has no connector
 * glyph, and every candidate in it already means another rail section).
 */
import {
  IconChevronDown,
  IconChevronRight,
  IconCpu,
  IconInbox,
  IconMoon,
  IconPlus,
  IconSearch,
  IconTrash,
  type IconProps,
} from '../../components/primitives/icons.js';
import { Icon } from './rail-icons.js';

export type { IconProps };
// The rail's icons (the section glyphs, the gear, the mark) live in
// rail-icons.tsx so the shell's first paint does not pull this module and the
// shared icon set in with them; re-exported so the names stay importable here.
export {
  AppsIcon,
  ChatIcon,
  CommandIcon,
  FleetIcon,
  GearIcon,
  GrowthIcon,
  MindIcon,
  NeedsYouIcon,
  SECTION_ICON,
  SettingsIcon,
  UsageIcon,
  VerseMark,
} from './rail-icons.js';

/**
 * Aliases onto the shared set. The names are the ones the Verse rail, sidebar
 * and composer already import — keeping them means this reconciliation
 * touched no call site.
 */
export const AutonomyIcon = IconCpu;
export const ApprovalsIcon = IconInbox;
export const SearchIcon = IconSearch;
export const PlusIcon = IconPlus;
export const TrashIcon = IconTrash;
export const ArrowDownIcon = IconChevronDown;
export const ChevronIcon = IconChevronRight;
/** The rail's theme quick-toggle. One glyph for the control, not per-theme. */
export const ThemeIcon = IconMoon;

export function PanelIcon(props: IconProps) {
  return <Icon {...props}><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M10 3v10" /></Icon>;
}

export function SidebarIcon(props: IconProps) {
  return <Icon {...props}><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M6 3v10" /></Icon>;
}

/**
 * The Return key (↩) as a key-legend glyph, 1em and inline so it sits in a
 * <kbd> like the letters around it. WHY drawn: of the fonts the console
 * serves, only the 230 KB full Plex face has U+21A9, so typing it into the
 * palette's or the drawer's key legend fetched that face each time one opened
 * (3.10 first-paint review; global.css scopes the full faces).
 */
export function ReturnKeyIcon(props: IconProps) {
  return (
    <Icon width="1em" height="1em" style={{ display: 'inline-block', verticalAlign: '-0.125em' }} {...props}>
      <path d="M13 3.5v5a2 2 0 0 1-2 2H3.5" /><path d="M6 8 3.5 10.5 6 13" />
    </Icon>
  );
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
