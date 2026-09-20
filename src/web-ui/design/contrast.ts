/**
 * design/contrast.ts — WCAG 2.1 contrast math over CSS color strings.
 *
 * Two callers, one implementation:
 *   - routes/verse/sections/AppearancePanel.tsx warns, live, when a
 *     hand-dragged accent stops being readable as link/button text in the
 *     active theme. The design language allows any hue; it does not allow an
 *     unreadable one to ship silently.
 *   - design/tokens-contrast.test.ts asserts the whole palette in BOTH
 *     themes (design doc §6: >= 4.5:1 body text, >= 3:1 meaningful borders).
 *
 * Deliberately dependency-free and DOM-free: parse -> linearize -> ratio.
 * Supports the subset of CSS color syntax tokens.css actually uses —
 * #rgb / #rrggbb / #rrggbbaa, rgb()/rgba(), hsl()/hsla(), both the legacy
 * comma form and the modern space form. Anything else returns null rather
 * than guessing a color.
 */

export interface Rgba {
  /** 0-255 */
  r: number;
  /** 0-255 */
  g: number;
  /** 0-255 */
  b: number;
  /** 0-1 */
  a: number;
}

const HEX_RE = /^#([0-9a-f]{3,8})$/i;
const FN_RE = /^(rgba?|hsla?)\(([^)]*)\)$/i;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** "50%" -> 0.5, "0.5" -> 0.5, "128" (of 255) handled by the caller. */
function unitValue(raw: string, scale: number): number {
  const text = raw.trim();
  if (text.endsWith('%')) return (Number.parseFloat(text) / 100) * scale;
  return Number.parseFloat(text);
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number];
  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return {
    r: Math.round((rgb[0] + m) * 255),
    g: Math.round((rgb[1] + m) * 255),
    b: Math.round((rgb[2] + m) * 255),
  };
}

/** Parse a CSS color string. Returns null for anything unrecognized. */
export function parseColor(input: string): Rgba | null {
  const text = input.trim().toLowerCase();
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

  const hex = HEX_RE.exec(text);
  if (hex) {
    const body = hex[1]!;
    const expand = (s: string) => Number.parseInt(s.length === 1 ? s + s : s, 16);
    if (body.length === 3 || body.length === 4) {
      return {
        r: expand(body[0]!),
        g: expand(body[1]!),
        b: expand(body[2]!),
        a: body.length === 4 ? expand(body[3]!) / 255 : 1,
      };
    }
    if (body.length === 6 || body.length === 8) {
      return {
        r: expand(body.slice(0, 2)),
        g: expand(body.slice(2, 4)),
        b: expand(body.slice(4, 6)),
        a: body.length === 8 ? expand(body.slice(6, 8)) / 255 : 1,
      };
    }
    return null;
  }

  const fn = FN_RE.exec(text);
  if (!fn) return null;
  const name = fn[1]!;
  // Both syntaxes: `a, b, c, d` and `a b c / d`.
  const parts = fn[2]!
    .replace(/\//g, ' ')
    .split(/[\s,]+/)
    .filter(Boolean);
  if (parts.length < 3) return null;
  const alpha = parts.length >= 4 ? clamp(unitValue(parts[3]!, 1), 0, 1) : 1;

  if (name.startsWith('rgb')) {
    return {
      r: clamp(Math.round(unitValue(parts[0]!, 255)), 0, 255),
      g: clamp(Math.round(unitValue(parts[1]!, 255)), 0, 255),
      b: clamp(Math.round(unitValue(parts[2]!, 255)), 0, 255),
      a: alpha,
    };
  }

  const hue = Number.parseFloat(parts[0]!);
  const sat = clamp(unitValue(parts[1]!, 1), 0, 1);
  const light = clamp(unitValue(parts[2]!, 1), 0, 1);
  if (!Number.isFinite(hue)) return null;
  return { ...hslToRgb(hue, sat, light), a: alpha };
}

/** Composite a (possibly translucent) color over an opaque backdrop. */
export function flatten(color: Rgba, backdrop: Rgba): Rgba {
  if (color.a >= 1) return color;
  const a = color.a;
  return {
    r: Math.round(color.r * a + backdrop.r * (1 - a)),
    g: Math.round(color.g * a + backdrop.g * (1 - a)),
    b: Math.round(color.b * a + backdrop.b * (1 - a)),
    a: 1,
  };
}

/** WCAG relative luminance of an opaque color. */
export function relativeLuminance(color: Rgba): number {
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/**
 * WCAG contrast ratio (1-21) between two CSS colors. A translucent color is
 * composited over `backdrop` first (default white) — asking for the contrast
 * of a 14%-alpha status background is otherwise meaningless.
 * Returns null when either color cannot be parsed, so a caller can say
 * "unknown" instead of asserting on a guess.
 */
export function contrastRatio(foreground: string, background: string, backdrop = '#ffffff'): number | null {
  const bgRaw = parseColor(background);
  const fgRaw = parseColor(foreground);
  const base = parseColor(backdrop);
  if (!bgRaw || !fgRaw || !base) return null;
  const bg = flatten(bgRaw, base);
  const fg = flatten(fgRaw, bg);
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Convenience for the appearance panel: does this pair clear body-text contrast? */
export function meetsTextContrast(foreground: string, background: string, backdrop?: string): boolean {
  const ratio = contrastRatio(foreground, background, backdrop);
  return ratio !== null && ratio >= 4.5;
}

/**
 * The accent, resolved to a hex the same way tokens.css derives its ramp
 * (hsl channels + a per-step lightness offset). Used by the appearance panel
 * to preview and contrast-check a hue the operator is dragging, without
 * reading computed styles mid-drag.
 */
export function accentHex(h: number, s: number, l: number, lightnessOffset = 0): string {
  const rgb = hslToRgb(h, clamp(s, 0, 100) / 100, clamp(l + lightnessOffset, 0, 100) / 100);
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(rgb.r)}${hex(rgb.g)}${hex(rgb.b)}`;
}
