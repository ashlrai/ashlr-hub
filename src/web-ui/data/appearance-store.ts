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
 * How large the whole interface is drawn. Scales TYPE AND SPACING TOGETHER
 * (design/tokens.css multiplies its type ramp by --ui-text-scale and its
 * spacing/geometry ramp by --ui-scale), because scaling type alone produces
 * big text in cramped boxes — worse to read than the default, not better.
 *
 * ORTHOGONAL TO `density`, not a replacement for it: display size answers
 * "how big is this interface", density answers "how tightly are its rows
 * packed". They compose, which is why tokens.css expresses the scale as a
 * multiplier rather than a second table of literal heights.
 *
 * There is no step below 'default' on purpose — see the [data-ui-scale]
 * block in tokens.css for why (the 12px body floor, and Density already
 * being the tightening control).
 */
export type UiScale = 'default' | 'large' | 'xlarge';

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
  /** How large the whole interface is drawn. Type and spacing together. */
  uiScale: UiScale;
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
    uiScale: 'default',
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
function isUiScale(v: unknown): v is UiScale {
  return v === 'default' || v === 'large' || v === 'xlarge';
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
    uiScale: isUiScale(merged.uiScale) ? merged.uiScale : 'default',
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
  // The display size is an ATTRIBUTE, not an inline custom property, for the
  // same reason the theme is: tokens.css owns the numbers, and a
  // `[data-ui-scale]` block can be read, tested and retuned in the stylesheet
  // that every other token lives in. Writing `--ui-scale` inline here would
  // put half the design system in a TypeScript file.
  root.setAttribute('data-ui-scale', value.uiScale);
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

export const ACCENT_LIGHTNESS_RANGE = { min: ACCENT_L_MIN, max: ACCENT_L_MAX } as const;
export const APPEARANCE_STORAGE_KEY = STORAGE_KEY;
