/**
 * data/appearance-store.ts — the operator's appearance preferences: the
 * "Linux for agentic engineering" part of the design language
 * (docs/VERSE-DESIGN-V2.md §3). Theme, accent, density, display face,
 * radius, and motion, applied live by writing custom properties and
 * data-attributes on <html>.
 *
 * Same shape as ./theme-store.ts on purpose — module-level state + a
 * listener set, zero React — so it is unit-testable without a DOM renderer
 * and usable from non-component code (the command palette's closures, the
 * rail's quick-toggle). data/hooks.ts binds it into React via
 * `useAppearance()`, exactly as it does for the theme.
 *
 * THEME IS NOT FORKED. `theme-store.ts` remains the single authority for the
 * light/dark/system preference (key `ashlr.theme.v1`, already read by the
 * topbar and the command palette); this module re-exposes it as one field of
 * the appearance snapshot and delegates writes to `setTheme`. Two stores
 * writing `data-theme` would race; one store that owns it does not.
 *
 * Everything is applied at MODULE LOAD (before React's first render, since
 * hooks.ts imports this and every view imports hooks.ts), so the app never
 * paints the default accent for a frame before swapping to the chosen one.
 */
import {
  getTheme,
  setTheme,
  subscribeTheme,
  type ThemePreference,
} from './theme-store.js';

export type { ThemePreference };

export type Density = 'comfortable' | 'compact';
/**
 * The operator's motion choice. Tri-state ON PURPOSE.
 *
 * A boolean cannot distinguish "I want full motion" from "I never touched
 * this", and `persist()` writes the whole snapshot on every appearance change
 * — so dragging the accent hue once used to store `reduceMotion: false` and
 * permanently override the OS `prefers-reduced-motion` preference, because
 * `applyAppearance` then wrote `data-motion="full"`, which is exactly the
 * value every `:root:not([data-motion="full"])` guard exists to defer to.
 *
 * 'system' removes the attribute entirely and lets the media queries decide,
 * which is what DESIGN-V2 §3 and §6 ask for by default.
 */
export type MotionPreference = 'system' | 'reduce' | 'full';
export type DisplayFont = 'grotesk' | 'ui' | 'mono';
export type RadiusScale = 'sharp' | 'default' | 'soft';

export interface Appearance {
  /** Delegated to theme-store.ts — persisted under its own key. */
  theme: ThemePreference;
  /** Accent hue 0-360. */
  accentH: number;
  /** Accent saturation 0-100 (%). */
  accentS: number;
  /** Accent lightness, clamped to a readable band (%). */
  accentL: number;
  density: Density;
  displayFont: DisplayFont;
  radius: RadiusScale;
  /** The stored choice: 'system' follows `prefers-reduced-motion`. */
  motion: MotionPreference;
  /**
   * DERIVED, never stored — what the Settings switch shows and what the app
   * behaves as right now. `setAppearance({ reduceMotion })` is the only call
   * that turns this back into an explicit 'reduce'/'full'.
   */
  reduceMotion: boolean;
}

/**
 * The persisted subset. `theme` lives in theme-store, and `reduceMotion` is
 * derived from `motion` — storing it is what created the override bug.
 */
type StoredAppearance = Omit<Appearance, 'theme' | 'reduceMotion'>;

const STORAGE_KEY = 'ashlr.verse.appearance.v1';

/**
 * Accent lightness band. Below ~30% the accent stops reading as a color on a
 * dark canvas; above ~78% it disappears on a light one. The hue and
 * saturation are unconstrained — this is the one axis where a free slider
 * can make the app genuinely unusable.
 */
const ACCENT_L_MIN = 30;
const ACCENT_L_MAX = 78;

/** Must match the bare `:root` values in design/tokens.css. */
export const DEFAULT_ACCENT = { h: 245, s: 72, l: 58 } as const;

export interface AccentPreset {
  id: string;
  label: string;
  h: number;
  s: number;
  l: number;
}

/**
 * Eight presets (design doc §3). Each was checked with design/contrast.ts so
 * its derived link color clears 4.5:1 in BOTH themes — the hue slider can
 * still be dragged anywhere, and the Settings panel warns when it lands
 * somewhere unreadable.
 */
export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: 'indigo', label: 'Indigo', h: 245, s: 72, l: 58 },
  { id: 'blue', label: 'Blue', h: 212, s: 80, l: 50 },
  { id: 'cyan', label: 'Cyan', h: 190, s: 80, l: 40 },
  { id: 'teal', label: 'Teal', h: 168, s: 70, l: 38 },
  { id: 'green', label: 'Green', h: 145, s: 60, l: 38 },
  { id: 'amber', label: 'Amber', h: 38, s: 80, l: 42 },
  { id: 'rose', label: 'Rose', h: 348, s: 72, l: 50 },
  { id: 'violet', label: 'Violet', h: 278, s: 66, l: 55 },
] as const;

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;
  } catch {
    // Some embedded webviews throw on an unsupported media feature.
    return false;
  }
}

export function defaultAppearance(): Appearance {
  return {
    theme: 'system',
    accentH: DEFAULT_ACCENT.h,
    accentS: DEFAULT_ACCENT.s,
    accentL: DEFAULT_ACCENT.l,
    density: 'comfortable',
    displayFont: 'grotesk',
    radius: 'default',
    motion: 'system',
    reduceMotion: prefersReducedMotion(),
  };
}

function isMotion(v: unknown): v is MotionPreference {
  return v === 'system' || v === 'reduce' || v === 'full';
}

/** What 'system' resolves to right now; an explicit choice answers itself. */
function resolveReduceMotion(motion: MotionPreference): boolean {
  return motion === 'reduce' ? true : motion === 'full' ? false : prefersReducedMotion();
}

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

function isDensity(v: unknown): v is Density {
  return v === 'comfortable' || v === 'compact';
}
function isDisplayFont(v: unknown): v is DisplayFont {
  return v === 'grotesk' || v === 'ui' || v === 'mono';
}
function isRadius(v: unknown): v is RadiusScale {
  return v === 'sharp' || v === 'default' || v === 'soft';
}

/** Coerce anything (stored JSON, a caller's patch) into a valid Appearance. */
function normalize(base: Appearance, patch: Partial<Appearance> | Partial<StoredAppearance>): Appearance {
  const merged = { ...base, ...patch } as Appearance;
  // `reduceMotion` in a PATCH is the Settings switch and is authoritative —
  // it is the one call that converts the derived boolean back into a stored
  // choice. `reduceMotion` in a stored blob is not a choice at all, which is
  // why load() strips it before it ever gets here.
  const asked = (patch as Partial<Appearance>).reduceMotion;
  const motion: MotionPreference = isMotion((patch as Partial<Appearance>).motion)
    ? ((patch as Partial<Appearance>).motion as MotionPreference)
    : typeof asked === 'boolean'
      ? (asked ? 'reduce' : 'full')
      : isMotion(base.motion)
        ? base.motion
        : 'system';
  return {
    theme: merged.theme === 'light' || merged.theme === 'dark' ? merged.theme : 'system',
    accentH: Number.isFinite(merged.accentH) ? ((Math.round(merged.accentH) % 360) + 360) % 360 : DEFAULT_ACCENT.h,
    accentS: Number.isFinite(merged.accentS) ? clamp(Math.round(merged.accentS), 0, 100) : DEFAULT_ACCENT.s,
    accentL: Number.isFinite(merged.accentL)
      ? clamp(Math.round(merged.accentL), ACCENT_L_MIN, ACCENT_L_MAX)
      : DEFAULT_ACCENT.l,
    density: isDensity(merged.density) ? merged.density : 'comfortable',
    displayFont: isDisplayFont(merged.displayFont) ? merged.displayFont : 'grotesk',
    radius: isRadius(merged.radius) ? merged.radius : 'default',
    motion,
    reduceMotion: resolveReduceMotion(motion),
  };
}

function load(): Appearance {
  const base = defaultAppearance();
  let stored: Partial<StoredAppearance> = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') stored = parsed as Partial<StoredAppearance>;
    }
  } catch {
    // Unavailable storage, quota errors, or corrupt JSON all mean the same
    // thing here: fall back to defaults rather than failing to boot.
  }
  // Drop any `reduceMotion` a pre-tri-state build left behind: it was written
  // by every unrelated appearance change, so it records nothing the operator
  // decided. Without `motion`, the media query decides — as it should.
  const { reduceMotion: _legacy, ...rest } = stored as Partial<StoredAppearance> & { reduceMotion?: unknown };
  return normalize(base, { ...rest, theme: getTheme() });
}

function persist(value: Appearance): void {
  try {
    // theme is deliberately excluded — theme-store.ts owns its own key.
    // reduceMotion is excluded because it is derived: persisting it is what
    // let an accent drag silently override the OS preference.
    const { theme: _theme, reduceMotion: _derived, ...rest } = value;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rest satisfies StoredAppearance));
  } catch {
    /* best-effort persistence only */
  }
}

const FONT_VAR: Record<DisplayFont, string | null> = {
  // null = remove the inline override and fall back to the token default.
  grotesk: null,
  ui: 'var(--font-ui)',
  mono: 'var(--font-mono)',
};

/**
 * Write the settings onto <html>. The accent is written as the three raw
 * channels tokens.css derives its whole ramp from, so one paint recolors
 * links, focus rings, primary buttons, meters and charts together.
 */
export function applyAppearance(value: Appearance): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.setProperty('--accent-h', String(value.accentH));
  root.style.setProperty('--accent-s', `${value.accentS}%`);
  root.style.setProperty('--accent-l', `${value.accentL}%`);

  const font = FONT_VAR[value.displayFont];
  if (font === null) root.style.removeProperty('--font-display');
  else root.style.setProperty('--font-display', font);

  root.setAttribute('data-density', value.density);
  root.setAttribute('data-radius', value.radius);
  // 'system' removes the attribute so the `prefers-reduced-motion` media
  // queries decide on their own. "full" is meaningful, not a no-op: it opts an
  // operator explicitly OUT of the OS preference (tokens.css and the four
  // Verse stylesheets guard their media query with :not([data-motion="full"])),
  // which is precisely why it must never be written by default.
  if (value.motion === 'system') root.removeAttribute('data-motion');
  else root.setAttribute('data-motion', value.motion);
}

let current: Appearance = load();
applyAppearance(current);

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

// The theme can also be changed from the rail's quick-toggle and the command
// palette (both go through theme-store). Mirror those into the snapshot so a
// Settings panel rendered at the same time never shows a stale radio.
subscribeTheme(() => {
  if (current.theme === getTheme()) return;
  current = { ...current, theme: getTheme() };
  emit();
});

export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable snapshot — a NEW object on every change (useSyncExternalStore uses Object.is). */
export function getAppearance(): Appearance {
  return current;
}

/** Apply and persist a partial change. Unknown/out-of-range values are coerced. */
export function setAppearance(patch: Partial<Appearance>): void {
  const next = normalize(current, patch);
  const themeChanged = next.theme !== current.theme;
  current = next;
  applyAppearance(current);
  persist(current);
  // Delegated last so theme-store's own listeners see the final snapshot.
  if (themeChanged) setTheme(current.theme);
  emit();
}

/** Back to the shipped defaults, including the theme and the stored blob. */
export function resetAppearance(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* best-effort */
  }
  current = defaultAppearance();
  applyAppearance(current);
  setTheme('system');
  emit();
}

/** True when nothing has been customized — drives the "Reset" affordance. */
export function isDefaultAppearance(value: Appearance = current): boolean {
  const base = defaultAppearance();
  return (
    value.theme === base.theme &&
    value.accentH === base.accentH &&
    value.accentS === base.accentS &&
    value.accentL === base.accentL &&
    value.density === base.density &&
    value.displayFont === base.displayFont &&
    value.radius === base.radius &&
    value.motion === base.motion
  );
}

/** The preset whose channels match the current accent, if any. */
export function matchingAccentPreset(value: Appearance = current): AccentPreset | null {
  return (
    ACCENT_PRESETS.find((p) => p.h === value.accentH && p.s === value.accentS && p.l === value.accentL) ?? null
  );
}

export const ACCENT_LIGHTNESS_RANGE = { min: ACCENT_L_MIN, max: ACCENT_L_MAX } as const;
export const APPEARANCE_STORAGE_KEY = STORAGE_KEY;
