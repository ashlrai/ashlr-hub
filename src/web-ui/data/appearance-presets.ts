/**
 * data/appearance-presets.ts — what the Settings ▸ Appearance panel offers
 * and compares against: the accent presets, "is anything customized", "which
 * preset is this".
 *
 * Split from appearance-store.ts, which every view imports (it applies the
 * stored appearance before the first paint) — so every value exported there
 * is first-paint JS for every console, while these are read only by the
 * Settings panel.
 */
import { defaultAppearance, getAppearance, type Appearance } from './appearance-store.js';

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

/** True when nothing has been customized — drives the "Reset" affordance. */
export function isDefaultAppearance(value: Appearance = getAppearance()): boolean {
  const base = defaultAppearance();
  return (
    value.theme === base.theme &&
    value.accentH === base.accentH &&
    value.accentS === base.accentS &&
    value.accentL === base.accentL &&
    value.density === base.density &&
    value.uiScale === base.uiScale &&
    value.displayFont === base.displayFont &&
    value.radius === base.radius &&
    value.motion === base.motion
  );
}

/** The preset whose channels match the current accent, if any. */
export function matchingAccentPreset(value: Appearance = getAppearance()): AccentPreset | null {
  return (
    ACCENT_PRESETS.find((p) => p.h === value.accentH && p.s === value.accentS && p.l === value.accentL) ?? null
  );
}
