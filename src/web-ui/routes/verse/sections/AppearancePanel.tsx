/**
 * routes/verse/sections/AppearancePanel.tsx — the "Linux" part of the design
 * language: theme, accent, density, display face, radius, motion.
 *
 * Every control applies IMMEDIATELY (design doc §3: live preview, no save
 * button) because the whole app is the preview — the panel writes through
 * data/appearance-store.ts, which writes the tokens on <html>. The preview
 * block at the end exists to show type, numerals, a filled action and a
 * meter in one place, so the effect of a change is visible without leaving
 * Settings.
 *
 * The hue slider is free-range, so the panel checks the resulting link color
 * against BOTH themes with design/contrast.ts and warns when a choice drops
 * under 4.5:1 — the operator keeps the hue they asked for, but is never
 * allowed to make it unreadable without being told.
 */
import { useId } from 'react';
import { Button, Input, Meter, Segmented, Slider, StatusBadge, Switch, Tag } from '../../../components/primitives/index.js';
import { IconAlert, IconCheck, IconMonitor, IconMoon, IconSun } from '../../../components/primitives/icons.js';
import { accentHex, contrastRatio } from '../../../design/contrast.js';
import {
  ACCENT_LIGHTNESS_RANGE,
  ACCENT_PRESETS,
  isDefaultAppearance,
  matchingAccentPreset,
  type Appearance,
  type Density,
  type DisplayFont,
  type RadiusScale,
  type ThemePreference,
} from '../../../data/appearance-store.js';
import { Panel, SettingRow } from './SettingRow.js';
import styles from './SettingsSection.module.css';

/**
 * The literal `--bg-surface` of each theme (design/tokens.css). Used only to
 * score a candidate accent; design/tokens-contrast.test.ts asserts these two
 * constants still match the stylesheet, so a future retune cannot leave the
 * warning scoring against a color the app no longer paints.
 */
export const LIGHT_SURFACE = '#ffffff';
export const DARK_SURFACE = '#121214';
/** Dark raises accent lightness by --accent-l-shift; --accent-600 sits 8% below/above it. */
const DARK_L_SHIFT = 6;
const LINK_STEP = 8;

const THEME_OPTIONS = [
  { value: 'system' as ThemePreference, label: 'System', icon: <IconMonitor /> },
  { value: 'light' as ThemePreference, label: 'Light', icon: <IconSun /> },
  { value: 'dark' as ThemePreference, label: 'Dark', icon: <IconMoon /> },
];

const DENSITY_OPTIONS = [
  { value: 'comfortable' as Density, label: 'Comfortable' },
  { value: 'compact' as Density, label: 'Compact' },
];

const FONT_OPTIONS = [
  { value: 'grotesk' as DisplayFont, label: 'Space Grotesk' },
  { value: 'ui' as DisplayFont, label: 'UI sans' },
  { value: 'mono' as DisplayFont, label: 'Mono' },
];

const RADIUS_OPTIONS = [
  { value: 'sharp' as RadiusScale, label: 'Sharp' },
  { value: 'default' as RadiusScale, label: 'Default' },
  { value: 'soft' as RadiusScale, label: 'Soft' },
];

/** A 360° sweep at the current saturation/lightness, so the track shows the choice. */
function hueTrack(s: number, l: number): string {
  const stops = [0, 60, 120, 180, 240, 300, 360].map((h) => `${accentHex(h, s, l)} ${(h / 360) * 100}%`);
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

export interface AccentReadability {
  lightRatio: number | null;
  darkRatio: number | null;
  /** Themes in which the derived link color drops below 4.5:1. */
  failing: Array<'light' | 'dark'>;
}

/** Exported for the section's test: the same math the warning renders from. */
export function accentReadability(h: number, s: number, l: number): AccentReadability {
  const lightLink = accentHex(h, s, l, -LINK_STEP);
  const darkLink = accentHex(h, s, l, DARK_L_SHIFT + LINK_STEP);
  const lightRatio = contrastRatio(lightLink, LIGHT_SURFACE);
  const darkRatio = contrastRatio(darkLink, DARK_SURFACE);
  const failing: Array<'light' | 'dark'> = [];
  if (lightRatio !== null && lightRatio < 4.5) failing.push('light');
  if (darkRatio !== null && darkRatio < 4.5) failing.push('dark');
  return { lightRatio, darkRatio, failing };
}

export interface AppearancePanelProps {
  appearance: Appearance;
  onChange: (patch: Partial<Appearance>) => void;
  onReset: () => void;
}

export function AppearancePanel({ appearance, onChange, onReset }: AppearancePanelProps) {
  const accentLabelId = useId();
  const hueId = useId();
  const satId = useId();
  const lightId = useId();
  const motionId = useId();

  const preset = matchingAccentPreset(appearance);
  const readability = accentReadability(appearance.accentH, appearance.accentS, appearance.accentL);

  return (
    <Panel
      title="Appearance"
      action={
        <Button
          variant="ghost"
          size="sm"
          onClick={onReset}
          disabled={isDefaultAppearance(appearance)}
          title="Restore the shipped theme, accent, density, font, radius and motion"
        >
          Reset to defaults
        </Button>
      }
    >
      <SettingRow label="Theme" description="System follows your OS appearance setting.">
        <Segmented
          aria-label="Theme"
          options={THEME_OPTIONS}
          value={appearance.theme}
          onChange={(theme) => onChange({ theme })}
        />
      </SettingRow>

      <SettingRow
        label="Accent"
        labelId={accentLabelId}
        description={
          preset
            ? `${preset.label} — used for links, focus rings and the one primary action per surface.`
            : 'Custom hue — used for links, focus rings and the one primary action per surface.'
        }
      >
        <div className={styles.swatches} role="radiogroup" aria-labelledby={accentLabelId}>
          {ACCENT_PRESETS.map((p) => {
            const selected = preset?.id === p.id;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={p.label}
                tabIndex={selected || (!preset && p.id === ACCENT_PRESETS[0]!.id) ? 0 : -1}
                className={styles.swatch}
                style={{ background: accentHex(p.h, p.s, p.l) }}
                onClick={() => onChange({ accentH: p.h, accentS: p.s, accentL: p.l })}
              >
                {selected ? (
                  <span className={styles.swatchCheck}>
                    <IconCheck size={12} />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </SettingRow>

      <SettingRow
        label="Accent channels"
        description="Hue, saturation and lightness are written straight onto the root element — the whole app follows as you drag."
        stacked
      >
        <div className={styles.sliderStack}>
          <Slider
            id={hueId}
            label="Hue"
            min={0}
            max={359}
            value={appearance.accentH}
            valueLabel={`${appearance.accentH}°`}
            valueText={`${appearance.accentH} degrees`}
            trackImage={hueTrack(appearance.accentS, appearance.accentL)}
            onChange={(e) => onChange({ accentH: Number(e.currentTarget.value) })}
          />
          <Slider
            id={satId}
            label="Saturation"
            min={0}
            max={100}
            value={appearance.accentS}
            valueLabel={`${appearance.accentS}%`}
            valueText={`${appearance.accentS} percent`}
            onChange={(e) => onChange({ accentS: Number(e.currentTarget.value) })}
          />
          <Slider
            id={lightId}
            label="Lightness"
            min={ACCENT_LIGHTNESS_RANGE.min}
            max={ACCENT_LIGHTNESS_RANGE.max}
            value={appearance.accentL}
            valueLabel={`${appearance.accentL}%`}
            valueText={`${appearance.accentL} percent`}
            onChange={(e) => onChange({ accentL: Number(e.currentTarget.value) })}
          />
          {readability.failing.length > 0 ? (
            <p className={styles.contrastWarning} role="status">
              <IconAlert size={14} />
              <span>
                This accent falls below 4.5:1 as link text in{' '}
                {readability.failing.length === 2 ? 'both themes' : `${readability.failing[0]} mode`}. Raise or lower
                the lightness to keep it readable.
              </span>
            </p>
          ) : null}
        </div>
      </SettingRow>

      <SettingRow label="Density" description="Row height and control padding across every view.">
        <Segmented
          aria-label="Density"
          options={DENSITY_OPTIONS}
          value={appearance.density}
          onChange={(density) => onChange({ density })}
        />
      </SettingRow>

      <SettingRow label="Display font" description="Titles, seat names, metrics and numerals. Body copy stays in the UI sans.">
        <Segmented
          aria-label="Display font"
          options={FONT_OPTIONS}
          value={appearance.displayFont}
          onChange={(displayFont) => onChange({ displayFont })}
        />
      </SettingRow>

      <SettingRow label="Corner radius" description="Sharp reads like a terminal; soft reads like a consumer app.">
        <Segmented
          aria-label="Corner radius"
          options={RADIUS_OPTIONS}
          value={appearance.radius}
          onChange={(radius) => onChange({ radius })}
        />
      </SettingRow>

      <SettingRow
        label="Reduce motion"
        htmlFor={motionId}
        description="Collapses every transition to 1ms. Defaults to your system preference; turning it off here overrides that."
      >
        <Switch
          id={motionId}
          checked={appearance.reduceMotion}
          onChange={(reduceMotion) => onChange({ reduceMotion })}
          aria-label="Reduce motion"
        />
      </SettingRow>

      <SettingRow label="Preview" description="Live — these are the real primitives, not a picture of them." stacked>
        <div className={styles.preview}>
          <p className={styles.previewHeading}>Ashlr Verse</p>
          <p className={styles.previewBody}>
            Body copy stays in the UI sans at the reading measure; numerals like{' '}
            <span className={styles.previewNumerals}>18,420 / 66,000</span> use the display face.
          </p>
          <div className={styles.previewRow}>
            <Button variant="primary" size="sm">
              Primary
            </Button>
            <Button variant="subtle" size="sm">
              Subtle
            </Button>
            <Button variant="ghost" size="sm">
              Ghost
            </Button>
            <Button variant="danger" size="sm">
              Destructive
            </Button>
          </div>
          <div className={styles.previewRow}>
            <StatusBadge status="running" />
            <Tag engine="claude">Claude Max</Tag>
            <Tag engine="local" mono>
              qwen3-coder
            </Tag>
          </div>
          <Meter value={18_420} max={66_000} label="Context" />
          <Input aria-label="Preview field" placeholder="A field at the current density" size="sm" />
        </div>
      </SettingRow>
    </Panel>
  );
}
