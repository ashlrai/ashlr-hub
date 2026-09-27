/**
 * routes/verse/dock/dock-icons.tsx — the chat surface's own 16px glyphs
 * (unit C2): the dock's pane tabs and the header's pane toggles, the ⋯
 * menu, pin and archive. Same drawing grammar as components/primitives/icons
 * (16-unit box, 1.5 stroke, round caps, currentColor) so they sit beside the
 * shared set without looking borrowed; kept here because verse-icons.tsx is
 * the shell's file.
 */
import type { ReactNode, SVGProps } from 'react';
import type { BuiltinPaneId } from '../shell/dock-catalog.js';

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

export function ReviewGlyph(p: GlyphProps) {
  return <Glyph {...p}><path d="M5 2.5v5M2.5 5h5M9 11h4.5" /><path d="M11.5 2.5 4.5 13.5" /></Glyph>;
}

export function TasksGlyph(p: GlyphProps) {
  return <Glyph {...p}><path d="M6.5 4h7M6.5 8h7M6.5 12h7" /><path d="m2.25 4 1 1 1.5-2M2.5 8h1.75M2.5 12h1.75" /></Glyph>;
}

export function ContextGlyph(p: GlyphProps) {
  return <Glyph {...p}><path d="m8 2 6 3-6 3-6-3 6-3Z" /><path d="m2 8 6 3 6-3M2 11l6 3 6-3" /></Glyph>;
}

export function SplitGlyph(p: GlyphProps) {
  return <Glyph {...p}><rect x="2.25" y="2.25" width="11.5" height="11.5" rx="1.5" /><path d="M2.25 8h11.5" /></Glyph>;
}

export function CloseGlyph(p: GlyphProps) {
  return <Glyph {...p}><path d="m4 4 8 8M12 4l-8 8" /></Glyph>;
}

export function MoreGlyph(p: GlyphProps) {
  return (
    <Glyph {...p}>
      <circle cx="3.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

export function PinGlyph(p: GlyphProps) {
  return <Glyph {...p}><path d="M9.75 2.25 13.75 6.25 11 7.5 8.5 10l.25 2.75-5-5L6.5 8 9 5.25Z" /><path d="m5 11-2.75 2.75" /></Glyph>;
}

export function ArchiveGlyph(p: GlyphProps) {
  return <Glyph {...p}><rect x="1.75" y="2.75" width="12.5" height="3" rx="1" /><path d="M2.75 5.75v6.5a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1v-6.5M6.5 8.5h3" /></Glyph>;
}

export function RenameGlyph(p: GlyphProps) {
  return <Glyph {...p}><path d="M10.5 2.75 13.25 5.5 6 12.75H3.25V10Z" /></Glyph>;
}

export function HandoffGlyph(p: GlyphProps) {
  return <Glyph {...p}><path d="M2.5 8h9M8.5 4.5 12 8l-3.5 3.5" /><path d="M13.75 3v10" /></Glyph>;
}

export function CopyGlyph(p: GlyphProps) {
  return <Glyph {...p}><rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.5" /><path d="M10.75 5.25V3.75a1.5 1.5 0 0 0-1.5-1.5h-5.5a1.5 1.5 0 0 0-1.5 1.5v5.5a1.5 1.5 0 0 0 1.5 1.5h1.5" /></Glyph>;
}

export function TrashGlyph(p: GlyphProps) {
  return <Glyph {...p}><path d="M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5M4.25 4.25l.6 9h6.3l.6-9" /></Glyph>;
}

export function FilesGlyph(p: GlyphProps) {
  return <Glyph {...p}><path d="M2.25 4.25a1.5 1.5 0 0 1 1.5-1.5h2.5l1.5 1.75h4.5a1.5 1.5 0 0 1 1.5 1.5v5.75a1.5 1.5 0 0 1-1.5 1.5h-8.5a1.5 1.5 0 0 1-1.5-1.5Z" /></Glyph>;
}

export function SourcesGlyph(p: GlyphProps) {
  return <Glyph {...p}><path d="M3.25 2.75h6l3.5 3.5v7a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1v-9.5a1 1 0 0 1 1-1Z" /><path d="M9 2.75v3.5h3.75M5 9h6M5 11.5h4" /></Glyph>;
}

export function ReasoningGlyph(p: GlyphProps) {
  return <Glyph {...p}><path d="M6 13.25h4M6.5 11.25h3M8 1.75a4.25 4.25 0 0 0-2.4 7.76c.3.2.5.55.5.92v.82h3.8v-.82c0-.37.2-.72.5-.92A4.25 4.25 0 0 0 8 1.75Z" /></Glyph>;
}

/** Focus mode: four corners closing in on the conversation. */
export function FocusGlyph(p: GlyphProps) {
  return <Glyph {...p}><path d="M2.25 5.5V3.25a1 1 0 0 1 1-1H5.5M10.5 2.25h2.25a1 1 0 0 1 1 1V5.5M13.75 10.5v2.25a1 1 0 0 1-1 1H10.5M5.5 13.75H3.25a1 1 0 0 1-1-1V10.5" /></Glyph>;
}

/** The panel docked beside the chat. */
export function PanelRightGlyph(p: GlyphProps) {
  return <Glyph {...p}><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" /><path d="M9.75 2.75v10.5" /></Glyph>;
}

/** The panel docked under the chat. */
export function PanelBottomGlyph(p: GlyphProps) {
  return <Glyph {...p}><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" /><path d="M1.75 9.5h12.5" /></Glyph>;
}

export const DOCK_PANE_GLYPH: Readonly<Record<BuiltinPaneId, (p: GlyphProps) => ReactNode>> = {
  terminal: TerminalGlyph,
  browser: PreviewGlyph,
  diff: ReviewGlyph,
  files: FilesGlyph,
  sources: SourcesGlyph,
  reasoning: ReasoningGlyph,
  tasks: TasksGlyph,
  context: ContextGlyph,
};
