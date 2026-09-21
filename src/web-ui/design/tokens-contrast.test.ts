/**
 * design/tokens-contrast.test.ts — the design language's accessibility
 * clause (docs/VERSE-DESIGN-V2.md §6) as an executable assertion:
 *
 *   "Contrast >= 4.5:1 for body text and >= 3:1 for borders carrying
 *    meaning, verified in BOTH themes."
 *
 * Plus the two structural rules the token file's header states, which have
 * so far only been enforced by review:
 *   1. No token is defined ONLY inside a media query or a theme block.
 *   2. The OS-preference dark block and the explicit-toggle dark block do
 *      not drift apart.
 *
 * Everything here is derived from tokens.css itself, so a future retune that
 * breaks readability fails the suite instead of shipping.
 */
import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast.js';
import {
  allDeclarations,
  darkScope,
  lightScope,
  mediaDarkDecls,
  moduleColor,
  moduleDeclaration,
  resolveToken,
  toggleDarkDecls,
  type TokenScope,
} from './token-probe.test-support.js';

const light = lightScope();
const dark = darkScope();

function color(scope: TokenScope, token: string): string {
  const value = resolveToken(scope, token);
  expect(value, `${token} should resolve to a literal color`).not.toBeNull();
  return value!;
}

function ratio(scope: TokenScope, fg: string, bg: string, backdropToken = '--bg-surface'): number {
  const backdrop = color(scope, backdropToken);
  const value = contrastRatio(color(scope, fg), color(scope, bg), backdrop);
  expect(value, `${fg} on ${bg} should be measurable`).not.toBeNull();
  return value!;
}

const THEMES: Array<[string, TokenScope]> = [
  ['light', light],
  ['dark', dark],
];

const TEXT_PAIRS: Array<[string, string]> = [
  ['--text-primary', '--bg-canvas'],
  ['--text-primary', '--bg-surface'],
  ['--text-primary', '--bg-surface-raised'],
  ['--text-primary', '--bg-input'],
  ['--text-primary', '--bg-hover'],
  ['--text-primary', '--bg-selected'],
  ['--text-primary', '--bg-code'],
  ['--text-secondary', '--bg-canvas'],
  ['--text-secondary', '--bg-surface'],
  ['--text-tertiary', '--bg-canvas'],
  ['--text-tertiary', '--bg-surface'],
  // The three grounds a row's own child lands on: --bg-hover and
  // --bg-selected (a child that declares its own colour is NOT recoloured by
  // the row's :hover/[aria-current] rule — only the ground under it moves) and
  // --bg-code (the code block's language label and copy button).
  //
  // --text-tertiary is DELIBERATELY not paired with these three: it measures
  // 3.95:1 on light --bg-selected, 4.40:1 on light --bg-hover and light
  // --bg-code, and 4.40:1 on dark --bg-selected — all under the floor. The
  // ramp itself is fixed by DESIGN-V2 §2, so the rule is not "retune the
  // token", it is "secondary is the tertiary of a raised ground". These pairs
  // assert that the replacement actually clears the bar in both themes.
  ['--text-secondary', '--bg-hover'],
  ['--text-secondary', '--bg-selected'],
  // Also the diff gutter's line numbers (chat.module.css .diffNo): real
  // content — the number an operator reads to locate a change in their editor
  // — so they owe the body floor on the code ground. They were painted with
  // --text-disabled (2.33:1 light / 2.48:1 dark), borrowing WCAG's
  // disabled-text exemption for content that is not disabled. --text-tertiary
  // does NOT fix that: it measures 4.40:1 on light --bg-code, under the floor
  // (the 4.83:1 figure is against --bg-surface, a different ground).
  ['--text-secondary', '--bg-code'],
  // --bg-active is the PRESS ground. Every chrome control now steps to it on
  // :active, so a tertiary child of a pressed row lands here: --text-tertiary
  // measures 3.95:1 on light --bg-active, under the floor, which is why
  // Transcript.toolLine and ResourcesPanel.runningOpen promote their tertiary
  // children to secondary on :hover AND :active.
  ['--text-secondary', '--bg-active'],
  ['--text-link', '--bg-surface'],
  ['--text-link', '--bg-canvas'],
  ['--status-neutral-fg', '--status-neutral-bg'],
  ['--status-info-fg', '--status-info-bg'],
  ['--status-running-fg', '--status-running-bg'],
  ['--status-success-fg', '--status-success-bg'],
  ['--status-warning-fg', '--status-warning-bg'],
  ['--status-danger-fg', '--status-danger-bg'],
  ['--status-unknown-fg', '--status-unknown-bg'],
  ['--text-on-accent', '--accent-600'],
  // The readable half of the warning/danger pair, on the plain surface. The
  // chat header's context-meter PERCENTAGE is painted with these: it used to
  // use --status-warning-solid / --status-danger-solid, which measure 2.52:1
  // and 3.97:1 on light --bg-surface, and at <=760px it is the only visible
  // numeral in the strip. The solids stay on the 2px fill (SOLID_TOKENS
  // below); these are the tokens any status TEXT must use.
  ['--status-warning-fg', '--bg-surface'],
  ['--status-danger-fg', '--bg-surface'],
];

/**
 * Borders that CARRY MEANING: the 3:1 non-text floor. The focus ring is the
 * sole indicator of keyboard focus and the accent is the sole indicator of
 * an active/selected control, so both genuinely have to clear it.
 *
 * Structural hairlines (--border-subtle/default/strong) are deliberately NOT
 * in this list: the design language separates with "1px borders at low
 * contrast" (§1.2) and pairs every one of them with a surface change or
 * text. They get a visibility floor instead, below.
 */
const NON_TEXT_PAIRS: Array<[string, string]> = [
  ['--border-focus', '--bg-surface'],
  ['--border-focus', '--bg-canvas'],
  ['--accent-500', '--bg-surface'],
  ['--accent-500', '--bg-canvas'],
  // --text-tertiary as a MEANING-CARRYING non-text mark on the surface. Three
  // usages depend on this pin, all of which owe 3:1 and none of which may use
  // a structural hairline:
  //   - the dashed "unknown" rule in Usage (usage.module.css .unknownRule),
  //     the designed representation of ABSENCE;
  //   - chart gridlines and axes (usage.module.css .charts sets --chart-axis
  //     to this token and --chart-grid to a mix of it), which are what an eye
  //     reads a value against;
  //   - the in-chat search-hit gutter rule (Transcript.module.css
  //     .turn[data-match]), the only indication that a turn matched a query.
  // The structural hairlines below are deliberately exempt; these are not.
  ['--text-tertiary', '--bg-surface'],
];

/** Hairlines still have to be SEEN, just not shouted. */
const HAIRLINE_PAIRS: Array<[string, string]> = [
  ['--border-subtle', '--bg-surface'],
  ['--border-default', '--bg-surface'],
  ['--border-strong', '--bg-surface'],
  ['--border-default', '--bg-canvas'],
];

/**
 * Status solids are dots and 2px rules, never the only carrier of state
 * (§6: "never communicate state by color alone" — StatusBadge always pairs
 * the dot with its label). They only have to be visible on the surface.
 */
const SOLID_TOKENS = [
  '--status-neutral-solid',
  '--status-info-solid',
  '--status-running-solid',
  '--status-success-solid',
  '--status-warning-solid',
  '--status-danger-solid',
  '--status-unknown-solid',
  '--engine-claude',
  '--engine-codex',
  '--engine-grok',
  '--engine-local',
];

describe('design tokens — contrast', () => {
  describe.each(THEMES)('%s theme', (_name, scope) => {
    it.each(TEXT_PAIRS)('%s on %s clears 4.5:1', (fg, bg) => {
      expect(ratio(scope, fg, bg, bg.startsWith('--status') ? '--bg-surface' : bg)).toBeGreaterThanOrEqual(4.5);
    });

    it.each(NON_TEXT_PAIRS)('%s on %s clears 3:1', (fg, bg) => {
      expect(ratio(scope, fg, bg, bg)).toBeGreaterThanOrEqual(3);
    });

    // 1.10 is the "not invisible" floor, not a WCAG number: at 1.0 the
    // hairline IS the surface and the layout loses its structure. The
    // faintest token (--border-subtle in dark) sits at ~1.14 by design.
    it.each(HAIRLINE_PAIRS)('%s stays visible against %s', (fg, bg) => {
      expect(ratio(scope, fg, bg, bg)).toBeGreaterThanOrEqual(1.1);
    });

    it.each(SOLID_TOKENS)('%s is a visible marker on the surface', (token) => {
      expect(ratio(scope, token, '--bg-surface')).toBeGreaterThanOrEqual(1.8);
    });

    it('never leaves the disabled text color indistinguishable from the surface', () => {
      // Disabled text is exempt from 4.5:1 by WCAG, but it still has to be
      // visible: an operator must be able to read a disabled control's label.
      expect(ratio(scope, '--text-disabled', '--bg-surface')).toBeGreaterThanOrEqual(2.2);
    });
  });
});

/**
 * The palette an operator actually sees is not only tokens.css. A component
 * may override a chart token locally, paint a meter with a `color-mix`, or
 * pick the token a gutter rule uses — and every contrast defect the four-lens
 * review found in Verse lived in exactly those declarations, under comments
 * asserting floors that nothing measured. `--chart-grid` is the case in
 * point: it was retuned to a 45% share of a token pinned at 4.83:1 and
 * shipped at 1.83:1, because the suite could only see the token.
 *
 * These read the declaration out of the CSS module and resolve it against
 * each theme, so the number in the comment and the number in the file cannot
 * drift apart again.
 */
const USAGE = 'routes/verse/usage/usage.module.css';
const CHAT = 'routes/verse/chat/chat.module.css';
const TRANSCRIPT = 'routes/verse/Transcript.module.css';

function moduleRatio(
  scope: TokenScope,
  path: string,
  selector: string,
  prop: string,
  groundToken: string,
): number {
  const fg = moduleColor(scope, path, selector, prop);
  expect(fg, `${path} ${selector} { ${prop} } should resolve to a literal color`).not.toBeNull();
  const ground = color(scope, groundToken);
  const value = contrastRatio(fg!, ground, ground);
  expect(value, `${selector} { ${prop} } on ${groundToken} should be measurable`).not.toBeNull();
  return value!;
}

describe('component colour overrides — contrast', () => {
  describe.each(THEMES)('%s theme', (_name, scope) => {
    // A gridline is what an eye reads a value against: DESIGN-V2 §6's 3:1
    // non-text floor, the same argument .unknownRule and the search-hit rule
    // make. The axis is the full token; the grid is a share of it, and the
    // share is what has to be asserted.
    it('draws chart gridlines at or above the 3:1 non-text floor', () => {
      expect(moduleRatio(scope, USAGE, '.charts', '--chart-grid', '--bg-surface')).toBeGreaterThanOrEqual(3);
    });

    it('draws chart axes at or above the 3:1 non-text floor', () => {
      expect(moduleRatio(scope, USAGE, '.charts', '--chart-axis', '--bg-surface')).toBeGreaterThanOrEqual(3);
    });

    // The EMPTY half of a meter is a filled shape carrying the scale, not a
    // hairline: at --bg-active it measured 1.22:1 / 1.20:1 and the remaining
    // capacity simply was not there. 1.8 is the same floor the status solids
    // are held to above. Both grounds, because Usage draws meters on a card
    // (--bg-surface) and the resources panel draws them on --bg-canvas.
    it.each(['--bg-surface', '--bg-canvas'])('keeps the meter track visible on %s', (ground) => {
      expect(ratio(scope, '--meter-track', ground, ground)).toBeGreaterThanOrEqual(1.8);
    });

    it('keeps the window meter track on the shared token', () => {
      expect(moduleDeclaration(USAGE, '.track', 'background')).toBe('var(--meter-track)');
    });

    // The diff's +/− column is the NON-COLOUR channel distinguishing an
    // addition from a deletion — the tints themselves are only 1.06:1 apart in
    // light and 1.10:1 in dark, which is by design (see chat.module.css). So
    // the glyph owes the body floor on BOTH tinted rows, not just on the
    // untinted context row.
    it.each(['--diff-add', '--diff-del'])('reads the diff +/- glyph against %s', (tint) => {
      const glyph = moduleColor(scope, CHAT, '.diffMarker', 'color');
      const row = moduleColor(scope, CHAT, '.diff', tint);
      expect(glyph, '.diffMarker should declare a colour').not.toBeNull();
      expect(row, `${tint} should resolve`).not.toBeNull();
      expect(contrastRatio(glyph!, row!, color(scope, '--bg-code'))!).toBeGreaterThanOrEqual(4.5);
    });

    // Line numbers are content an operator reads to find a change in their
    // editor, on the code ground — not a disabled-control label, so they
    // cannot borrow WCAG's disabled-text exemption. --text-disabled measured
    // 2.33:1 / 2.48:1 here.
    it('reads diff line numbers against the code ground', () => {
      expect(moduleRatio(scope, CHAT, '.diffNo', 'color', '--bg-code')).toBeGreaterThanOrEqual(4.5);
    });

    // Selection has to be visible in BOTH themes. The previous treatment set
    // background to --bg-surface-raised, which IS --bg-surface in light, so
    // half the cue was a literal no-op there.
    it('marks a selected account card with a border above the 3:1 floor', () => {
      expect(moduleRatio(scope, USAGE, ".card[data-selected='true']", 'border-color', '--bg-surface')).toBeGreaterThanOrEqual(3);
    });

    it('gives a selected account card a ground that differs from an unselected one', () => {
      expect(moduleRatio(scope, USAGE, ".card[data-selected='true']", 'background', '--bg-surface')).toBeGreaterThanOrEqual(1.1);
    });
  });

  // Structural, not per-theme: the search-hit rule is drawn with box-shadow,
  // so what matters is WHICH token it spends. --border-strong is a hairline,
  // exempt from 3:1 and measured at 1.45:1 / 1.66:1 — invisible for the one
  // mark telling an operator that a turn matched their query.
  it('draws the in-chat search-hit marker with a meaning-carrying token', () => {
    expect(moduleDeclaration(TRANSCRIPT, '.turn[data-match]', 'box-shadow')).toContain('var(--text-tertiary)');
    expect(moduleDeclaration(TRANSCRIPT, ".turn[data-match='active']", 'box-shadow')).toContain('var(--accent-500)');
  });
});

describe('design tokens — structure', () => {
  it('defines every token on bare :root before any theme or media block', () => {
    const missing = allDeclarations()
      .filter((d) => d.selector !== ':root')
      .filter((d) => !light.has(d.prop))
      .map((d) => `${d.prop} (only in ${d.selector})`);
    expect(missing).toEqual([]);
  });

  it('keeps the two dark blocks byte-identical', () => {
    const media = mediaDarkDecls();
    const toggle = toggleDarkDecls();
    expect([...toggle.keys()].sort()).toEqual([...media.keys()].sort());
    for (const [prop, value] of media) {
      expect(toggle.get(prop), `${prop} drifted between the two dark blocks`).toBe(value);
    }
  });

  it('resolves the accent ramp from the three user-editable channels', () => {
    // The appearance store writes only --accent-h/s/l; if a step ever stops
    // deriving from them, dragging the hue would half-recolor the app.
    for (const step of ['--accent-300', '--accent-500', '--accent-600', '--accent-700']) {
      expect(light.get(step)).toMatch(/var\(--accent-h\)/);
      expect(dark.get(step) ?? light.get(step)).toMatch(/var\(--accent-h\)/);
    }
  });

  it('raises accent lightness in dark without overwriting the user channel', () => {
    // --accent-l stays whatever the operator chose; the dark correction lives
    // in --accent-l-shift so an inline style cannot defeat it.
    expect(light.get('--accent-l-shift')).toBe('0%');
    expect(dark.get('--accent-l-shift')).toBe('6%');
    expect(dark.get('--accent-l')).toBe(light.get('--accent-l'));
  });
});
