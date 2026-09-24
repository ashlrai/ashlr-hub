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
  'routes/verse/NewChatDialog.module.css',
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
  // 3.10 workbench (SPEC-310C). QuickSwitcher and ResourcesPanel were deleted
  // (the command palette and Apps & Accounts replace them), so they left this
  // list. Every new chrome stylesheet joins it the day it lands — the drift
  // this test exists for enters exactly through files nobody listed yet.
  // CommandPalette and the Preview/Terminal panes were held off this list
  // while they hardcoded real control heights (.input 52px, .item 40px, the
  // 20px .tabClose buttons); R3d moved those onto the density tokens, so they
  // are listed now. The palette's remaining literals are glyphs and a phone
  // touch target — see ALLOWED.
  'routes/verse/shell/CommandPalette.module.css',
  'routes/verse/dock/preview/PreviewPane.module.css',
  'routes/verse/dock/terminal/TerminalPane.module.css',
  // Chart stylesheets (components/charts/**) are plot geometry, not controls,
  // and stay out of scope.
  'routes/verse/SeatCapacity.module.css',
  'routes/verse/budget/BudgetControl.module.css',
  'routes/verse/shell/GearTray.module.css',
  'routes/verse/shell/NeedsYouDrawer.module.css',
  'routes/verse/shell/RailStatus.module.css',
  'routes/verse/shell/ShortcutsOverlay.module.css',
  'routes/verse/shell/skeletons.module.css',
  'routes/verse/chat/ActionMenu.module.css',
  'routes/verse/chat/ActivityGroup.module.css',
  'routes/verse/chat/ChapterRail.module.css',
  'routes/verse/chat/LiveStatus.module.css',
  'routes/verse/chat/NoticeSlot.module.css',
  'routes/verse/chat/TasksTray.module.css',
  'routes/verse/chat/ThinkingBlock.module.css',
  'routes/verse/composer/composer.module.css',
  'routes/verse/context/ChatUsage.module.css',
  'routes/verse/dock/Dock.module.css',
  'routes/verse/dock/panes.module.css',
  'routes/verse/git/BranchBar.module.css',
  'routes/verse/git/DiffPane.module.css',
  'routes/verse/git/GitDialogs.module.css',
  'routes/verse/git/PrChip.module.css',
  'routes/verse/git/WorktreeOption.module.css',
  'routes/verse/apps/Apps.module.css',
  'routes/verse/usage/CapacityStrip.module.css',
  'routes/verse/command/command.module.css',
  'routes/verse/command/surface.module.css',
  'routes/verse/fleet/fleet.module.css',
  'routes/verse/mind/mind.module.css',
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
    // 3.10 phone layout (`.shell[data-compact]`): the rail becomes a bottom tab
    // bar whose items stack an icon over a label. That is a touch target, and a
    // touch target must not shrink when the DESKTOP density switch goes compact.
    '56px': 'phone bottom-bar item (icon over label) — a touch target, independent of desktop density',
  },
  'routes/verse/shell/NeedsYouDrawer.module.css': {
    '18px': '<kbd> keycap hint (A/R/V/J/K) — a non-interactive glyph sized to its letter',
    '40px': 'the empty-inbox check mark — an aria-hidden icon, not a control',
  },
  'routes/verse/shell/ShortcutsOverlay.module.css': {
    '22px': '<kbd> keycap in the shortcuts sheet — a non-interactive glyph sized to its chord',
  },
  'routes/verse/composer/composer.module.css': {
    '36px': 'attachment thumbnail / extension tile — a square image preview, not a control',
  },
  'routes/verse/apps/Apps.module.css': {
    '32px': 'app monogram tile — a square identity mark, not a control',
    '24px': 'app monogram tile, small size — a square identity mark, not a control',
  },
  'routes/verse/shell/CommandPalette.module.css': {
    '20px': 'engine monogram tile and <kbd> keycap — square glyphs sized to their letter/chord, not controls',
    // `@media` phone block: `.item { min-height: 48px }`. Same rule as the
    // VerseApp bottom bar — the DESKTOP density switch must not shrink a
    // finger target.
    '48px': 'phone palette row — a touch target, independent of desktop density',
  },
  'routes/verse/command/command.module.css': {
    '20px': 'Leader action class badge (A/B/C) — a square marker, not a control',
  },
  'routes/verse/mind/mind.module.css': {
    '20px': 'outcome mark on a Mind card — an aria-hidden square glyph, not a control',
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
