/**
 * dock/terminal/terminal-icons.tsx — the Terminal / Preview panes' own 16px
 * glyphs (unit C4). Same grammar as components/primitives/icons.tsx (16-unit
 * box, 1.5 stroke, round caps, currentColor, decorative) so they sit beside
 * the shared set; kept here because the shared set is not this unit's file.
 */
import type { ReactNode, SVGProps } from 'react';

export interface GlyphProps extends Omit<SVGProps<SVGSVGElement>, 'children' | 'viewBox'> {
  size?: number;
}

function Glyph({ size = 16, children, ...rest }: GlyphProps & { children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

export function TerminalGlyph(p: GlyphProps) {
  return <Glyph {...p}><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" /><path d="m4.5 6.25 2 1.75-2 1.75M8.25 10h3" /></Glyph>;
}

export function PreviewGlyph(p: GlyphProps) {
  return <Glyph {...p}><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" /><path d="M1.75 5.75h12.5M4 4.25h.01M5.75 4.25h.01" /></Glyph>;
}

export function ChevronDownGlyph(p: GlyphProps) {
  return <Glyph {...p}><path d="m4.5 6.5 3.5 3.5 3.5-3.5" /></Glyph>;
}

/** Screen-reader mode: a speaker with sound lines. */
export function ScreenReaderGlyph(p: GlyphProps) {
  return <Glyph {...p}><path d="M2.5 6v4h2.5l3.5 3V3L5 6H2.5Z" /><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.75 3.75a6 6 0 0 1 0 8.5" /></Glyph>;
}

export function ArrowLeftGlyph(p: GlyphProps) {
  return <Glyph {...p}><path d="M13 8H3.5M7.5 4 3.5 8l4 4" /></Glyph>;
}

export function ArrowRightGlyph(p: GlyphProps) {
  return <Glyph {...p}><path d="M3 8h9.5M8.5 4l4 4-4 4" /></Glyph>;
}

export function ReloadGlyph(p: GlyphProps) {
  return <Glyph {...p}><path d="M13 8a5 5 0 1 1-1.46-3.54" /><path d="M13 2.75v2.5h-2.5" /></Glyph>;
}

export function DesktopGlyph(p: GlyphProps) {
  return <Glyph {...p}><rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1.25" /><path d="M6 13.75h4M8 11.25v2.5" /></Glyph>;
}

export function PhoneGlyph(p: GlyphProps) {
  return <Glyph {...p}><rect x="4.75" y="1.75" width="6.5" height="12.5" rx="1.5" /><path d="M7.25 12h1.5" /></Glyph>;
}

export function PlayGlyph(p: GlyphProps) {
  return <Glyph {...p}><path d="M5 3.5v9l7-4.5-7-4.5Z" /></Glyph>;
}

export function FileGlyph(p: GlyphProps) {
  return <Glyph {...p}><path d="M9 1.75H4.25a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V5.5L9 1.75Z" /><path d="M9 1.75V5.5h3.75" /></Glyph>;
}

export function ServerGlyph(p: GlyphProps) {
  return <Glyph {...p}><rect x="2.25" y="2.25" width="11.5" height="4.5" rx="1" /><rect x="2.25" y="9.25" width="11.5" height="4.5" rx="1" /><path d="M4.75 4.5h.01M4.75 11.5h.01" /></Glyph>;
}
