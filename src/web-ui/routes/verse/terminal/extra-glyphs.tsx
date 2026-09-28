/**
 * terminal/extra-glyphs.tsx — the few 3.15 block-action glyphs the shared
 * icon set does not have (same 16px grammar: 1.5 stroke, round caps).
 */
import type { ReactNode } from 'react';

function Svg({ size = 14, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

/** Bookmark: a star, filled when set. */
export function StarGlyph({ filled = false, size }: { filled?: boolean; size?: number }) {
  return (
    <Svg {...(size ? { size } : {})}>
      <path d="M8 2.2l1.75 3.55 3.9.57-2.82 2.75.67 3.88L8 11.12l-3.5 1.83.67-3.88L2.35 6.32l3.9-.57z" fill={filled ? 'currentColor' : 'none'} />
    </Svg>
  );
}

/** Ask a seat: a speech bubble with a question mark. */
export function AskGlyph({ size }: { size?: number }) {
  return (
    <Svg {...(size ? { size } : {})}>
      <path d="M2.75 3.75h10.5v7h-5.5l-3 2.5v-2.5h-2z" />
      <path d="M6.6 5.9a1.45 1.45 0 1 1 1.9 1.38c-.35.12-.5.36-.5.72" /><path d="M8 9.35v.05" />
    </Svg>
  );
}

/** A link (copy the block's verse:// link). */
export function LinkGlyph({ size }: { size?: number }) {
  return (
    <Svg {...(size ? { size } : {})}>
      <path d="M6.75 9.25l2.5-2.5" />
      <path d="M7.5 4.75l1-1a2.47 2.47 0 0 1 3.5 3.5l-1 1" />
      <path d="M8.5 11.25l-1 1a2.47 2.47 0 0 1-3.5-3.5l1-1" />
    </Svg>
  );
}

/** Filter the output's lines. */
export function FilterGlyph({ size }: { size?: number }) {
  return (
    <Svg {...(size ? { size } : {})}>
      <path d="M2.5 3.5h11l-4.25 5v4l-2.5-1.25V8.5z" />
    </Svg>
  );
}

/** Re-run the command. */
export function RerunGlyph({ size }: { size?: number }) {
  return (
    <Svg {...(size ? { size } : {})}>
      <path d="M12.75 8a4.75 4.75 0 1 1-1.4-3.36" /><path d="M12.25 2.5v2.5h-2.5" />
    </Svg>
  );
}

/** Open in the Browser pane. */
export function BrowserGlyph({ size }: { size?: number }) {
  return (
    <Svg {...(size ? { size } : {})}>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" /><path d="M1.75 5.75h12.5" />
    </Svg>
  );
}
