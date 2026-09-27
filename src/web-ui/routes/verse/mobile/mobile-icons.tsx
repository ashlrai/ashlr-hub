/**
 * routes/verse/mobile/mobile-icons.tsx — the phone app's glyphs, on the
 * console's icon geometry (components/primitives/icon-base.tsx: 16 box,
 * 1.5 stroke, currentColor, decorative unless titled). Only what the tab bar
 * and first-paint screens draw lives here, so the first paint does not load
 * the console's whole icon set.
 */
import { Icon, type IconProps } from '../../../components/primitives/icon-base.js';

export function HomeGlyph(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 7.2 8 2.8l5.5 4.4V13a.5.5 0 0 1-.5.5H9.6V10H6.4v3.5H3a.5.5 0 0 1-.5-.5Z" />
    </Icon>
  );
}

export function AgentsGlyph(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2" y="2.5" width="12" height="4" rx="1.2" />
      <rect x="2" y="9.5" width="12" height="4" rx="1.2" />
      <path d="M4.5 4.5h.01M4.5 11.5h.01" />
    </Icon>
  );
}

export function NeedsGlyph(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 6.5a4 4 0 0 1 8 0c0 3 1.2 4.2 1.5 4.5h-11C2.8 10.7 4 9.5 4 6.5Z" />
      <path d="M6.5 13.2a1.6 1.6 0 0 0 3 0" />
    </Icon>
  );
}

export function LeaderGlyph(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11a1.5 1.5 0 0 1-1.5-1.5Z" />
    </Icon>
  );
}

export function MoreGlyph(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="3.5" cy="8" r="0.9" />
      <circle cx="8" cy="8" r="0.9" />
      <circle cx="12.5" cy="8" r="0.9" />
    </Icon>
  );
}

export function PlusGlyph(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 3v10M3 8h10" />
    </Icon>
  );
}

export function BackGlyph(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 3 5 8l5 5" />
    </Icon>
  );
}

export function ChevronGlyph(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </Icon>
  );
}

export function MicGlyph(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25" />
      <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.25" />
    </Icon>
  );
}

export function LockGlyph(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </Icon>
  );
}

export function FleetGlyph(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2.5v11M2.5 8h11" />
      <circle cx="8" cy="8" r="5.5" />
    </Icon>
  );
}
