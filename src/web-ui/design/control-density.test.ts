/**
 * design/control-density.test.ts — DESIGN-V2 §2 ("Density") as an executable
 * assertion for the Verse chrome and the shared primitives:
 *
 *   "Every list row and control height derives from these, never a hardcoded px."
 *
 * Why this needs a test rather than review. Before the elevation pass the rule
 * held for list rows and for the shared primitives, but every Verse chrome
 * surface hardcoded its own control heights (28/30/32/36/38px). The visible
 * failure was silent and only showed up in one setting: switching Appearance →
 * Density → compact shrank the rows and the primitives while every button,
 * icon button, search field and pill in the chrome stayed comfortable, so the
 * baselines stopped lining up exactly where the two met. Nothing looked broken
 * in the default setting, which is precisely why it survived.
 *
 * The check: no `height`/`min-height` in the files below may be a literal px
 * at or above CONTROL_FLOOR. Below that floor the value is a glyph, a dot, a
 * hairline or a marker — intrinsic geometry that is not a control height and
 * does not scale with density.
 *
 * Genuine exceptions are listed by file and value with the reason, so adding
 * one is a deliberate edit and not an oversight.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const webUi = resolve(here, '..');

/** At or above this, a height is a CONTROL and must derive from a token. */
const CONTROL_FLOOR = 18;

/**
 * The surfaces this pass owns: the Verse shared chrome and the primitive set.
 * Section bodies owned by other builders are deliberately out of scope.
 */
const FILES = [
  'routes/verse/VerseApp.module.css',
  'routes/verse/Sidebar.module.css',
  'routes/verse/Workspace.module.css',
  'routes/verse/Transcript.module.css',
  'routes/verse/Composer.module.css',
  'routes/verse/QuickSwitcher.module.css',
  'routes/verse/NewChatDialog.module.css',
  'routes/verse/ResourcesPanel.module.css',
  'routes/verse/sections/ChatSection.module.css',
  // Section bodies, added at V2.1 integration: the density switch reached the
  // chrome but stopped at the section boundary, so a compact operator saw
  // comfortable buttons inside compact panels.
  'routes/verse/sections/AutonomySection.module.css',
  'routes/verse/sections/SettingsSection.module.css',
  'routes/verse/usage/usage.module.css',
  // The two stylesheets added in the V2.1 chat/onboarding run. They were
  // outside the contract while it was being written, which is exactly how the
  // drift this test describes gets in: onboarding.module.css was already
  // sizing its section icons with a 22px literal.
  'routes/verse/chat/chat.module.css',
  'routes/verse/onboarding/onboarding.module.css',
  'components/primitives/Button.module.css',
  'components/primitives/Input.module.css',
  'components/primitives/Select.module.css',
  'components/primitives/Segmented.module.css',
  'components/primitives/Tag.module.css',
  'components/primitives/StatusBadge.module.css',
  'components/primitives/Skeleton.module.css',
  'components/primitives/Sheet.module.css',
  'components/primitives/Switch.module.css',
];

/**
 * Intrinsic geometry that is NOT a control height. Keyed by file, then by the
 * literal value, with the reason it does not scale with density.
 */
const ALLOWED: Record<string, Record<string, string>> = {
  'routes/verse/VerseApp.module.css': {
    '32px': 'the brand mark in the rail head — a fixed 32px logo, never a control',
  },
  'components/primitives/Switch.module.css': {
    '18px': 'switch track — an intrinsic toggle shape, not a text-bearing control',
  },
  'routes/verse/sections/SettingsSection.module.css': {
    '22px': 'accent-hue swatch — a square colour chip sized with its own width, not a text-bearing control',
  },
};

/** `height: 40px` / `min-height: 40px`, ignoring line-height and max-height. */
const DECL = /(?:^|[\s;{])(min-height|height)\s*:\s*([0-9.]+)px\s*(?:;|})/g;

describe('control heights derive from the density tokens', () => {
  it.each(FILES)('%s hardcodes no control height', (relative) => {
    const css = readFileSync(resolve(webUi, relative), 'utf8');
    const allowed = ALLOWED[relative] ?? {};
    const offenders: string[] = [];
    for (const match of css.matchAll(DECL)) {
      const value = `${match[2]}px`;
      if (Number.parseFloat(match[2]!) < CONTROL_FLOOR) continue;
      if (allowed[value]) continue;
      offenders.push(`${match[1]}: ${value}`);
    }
    expect(
      offenders,
      `${relative} should express control heights as var(--control-h*) / var(--density-row*), not literal px`,
    ).toEqual([]);
  });

  it('scales every control step when density goes compact', () => {
    const tokens = readFileSync(resolve(here, 'tokens.css'), 'utf8');
    const compact = /:root\[data-density="compact"\]\s*{([^}]*)}/.exec(tokens)?.[1] ?? '';
    // A step that exists on :root but is not re-stated here would freeze at its
    // comfortable value and re-open exactly the half-applied density bug.
    for (const step of ['--control-h', '--control-h-sm', '--control-h-xs', '--engine-marker-h']) {
      expect(tokens, `${step} must have a comfortable value on bare :root`).toMatch(
        new RegExp(`^\\s*${step}:`, 'm'),
      );
      expect(compact, `${step} must also be restated for compact density`).toContain(`${step}:`);
    }
  });
});
