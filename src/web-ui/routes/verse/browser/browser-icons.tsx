/**
 * routes/verse/browser/browser-icons.tsx — the Browser pane's 16px glyphs.
 * Same grammar as components/primitives/icons.tsx (16-unit box, 1.5 stroke,
 * round caps, currentColor, decorative), kept local so the pane owns them.
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

export const BackGlyph = (p: GlyphProps) => <Glyph {...p}><path d="M13 8H3.5M7.5 4 3.5 8l4 4" /></Glyph>;
export const ForwardGlyph = (p: GlyphProps) => <Glyph {...p}><path d="M3 8h9.5M8.5 4l4 4-4 4" /></Glyph>;
export const ReloadGlyph = (p: GlyphProps) => <Glyph {...p}><path d="M13 3.5v3h-3" /><path d="M12.6 6.5A5 5 0 1 0 13 9" /></Glyph>;
export const GlobeGlyph = (p: GlyphProps) => (
  <Glyph {...p}><circle cx="8" cy="8" r="5.75" /><path d="M2.25 8h11.5M8 2.25c1.6 1.7 2.4 3.6 2.4 5.75S9.6 12.05 8 13.75C6.4 12.05 5.6 10.15 5.6 8S6.4 3.95 8 2.25Z" /></Glyph>
);
export const CameraGlyph = (p: GlyphProps) => (
  <Glyph {...p}><path d="M2.25 5.25h2.5l1.25-1.75h4l1.25 1.75h2.5v7.25H2.25Z" /><circle cx="8" cy="8.75" r="2.25" /></Glyph>
);
export const PickGlyph = (p: GlyphProps) => (
  <Glyph {...p}><path d="M2.75 2.75h4M2.75 2.75v4M13.25 6.75v-4h-4M2.75 9.25v4h4" /><path d="m8.5 8.5 5 1.9-2.1.9-.9 2.1Z" /></Glyph>
);
export const ConsoleGlyph = (p: GlyphProps) => (
  <Glyph {...p}><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" /><path d="m4.5 6.25 2 1.75-2 1.75M8.25 10h3" /></Glyph>
);
export const SendGlyph = (p: GlyphProps) => <Glyph {...p}><path d="M13.75 2.25 6.9 9.1M13.75 2.25 9.5 13.75 6.9 9.1 2.25 6.5Z" /></Glyph>;
export const ExternalGlyph = (p: GlyphProps) => <Glyph {...p}><path d="M9.5 2.75h3.75V6.5M13.25 2.75 7.5 8.5M11.25 9.5v3.75h-8.5v-8.5H6.5" /></Glyph>;
export const DesktopGlyph = (p: GlyphProps) => <Glyph {...p}><rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1" /><path d="M5.5 13.75h5M8 11.25v2.5" /></Glyph>;
export const TabletGlyph = (p: GlyphProps) => <Glyph {...p}><rect x="3.25" y="1.75" width="9.5" height="12.5" rx="1.25" /><path d="M7.25 12h1.5" /></Glyph>;
export const PhoneGlyph = (p: GlyphProps) => <Glyph {...p}><rect x="4.75" y="1.75" width="6.5" height="12.5" rx="1.25" /><path d="M7.25 12h1.5" /></Glyph>;
export const FillGlyph = (p: GlyphProps) => <Glyph {...p}><path d="M2.75 6V2.75H6M10 2.75h3.25V6M13.25 10v3.25H10M6 13.25H2.75V10" /></Glyph>;
export const ServerGlyph = (p: GlyphProps) => (
  <Glyph {...p}><rect x="2.25" y="2.75" width="11.5" height="4.25" rx="1" /><rect x="2.25" y="9" width="11.5" height="4.25" rx="1" /><path d="M4.75 4.9h.01M4.75 11.1h.01" /></Glyph>
);
export const ShieldGlyph = (p: GlyphProps) => <Glyph {...p}><path d="M8 1.75 13 3.75v4c0 3-2.1 5.3-5 6.5-2.9-1.2-5-3.5-5-6.5v-4Z" /></Glyph>;
