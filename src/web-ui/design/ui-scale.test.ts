/**
 * design/ui-scale.test.ts — the display-size setting, as executable rules.
 *
 * The feature is "make the whole interface bigger", and it has exactly two
 * ways to go wrong, both of which are invisible in a diff:
 *
 *   1. It scales TYPE BUT NOT SPACING. Big text in unchanged boxes reads
 *      WORSE than the default — the cramping is what makes an interface hard
 *      to read, not the glyph size. Every type token and every spacing token
 *      must move at every step, together.
 *
 *   2. It scales `--rail-width`. Five stylesheets inset their header strip by
 *      `calc(var(--app-traffic-light-inset) - var(--rail-width))`, where the
 *      inset is a FIXED 92px the Tauri shell writes for the macOS traffic
 *      lights (desktop/README.md "Desktop shell contract"). Multiply the rail
 *      and that subtraction stops clearing them — the traffic-light overlap
 *      this repo has already regressed on once, caused this time by a display
 *      preference nobody would think to connect to it.
 *
 * Everything below is read out of tokens.css itself, resolved through
 * ./token-probe.test-support.ts, so the assertions are about the values a
 * browser would compute and not about the text of the file.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  declsFor,
  declsForAt,
  lightScope,
  resolveToken,
  scopeWith,
  type TokenScope,
} from './token-probe.test-support.js';

/** The three steps, smallest first — the order every "grows" check reads in. */
const STEPS = ['default', 'large', 'xlarge'] as const;
type Step = (typeof STEPS)[number];

const SELECTOR: Record<Step, string[]> = {
  default: [],
  large: [':root[data-ui-scale="large"]'],
  xlarge: [':root[data-ui-scale="xlarge"]'],
};

const scopeFor = (step: Step, extra: string[] = []): TokenScope =>
  scopeWith([...SELECTOR[step], ...extra]);

/** Resolve a token to a number of px, failing loudly if it does not resolve. */
function px(scope: TokenScope, token: string): number {
  const raw = resolveToken(scope, token);
  expect(raw, `${token} should resolve to a literal length`).not.toBeNull();
  expect(raw, `${token} resolved to "${raw}", which is not a plain px length`).toMatch(
    /^-?\d+(\.\d+)?px$/,
  );
  return Number.parseFloat(raw!);
}

const TYPE_TOKENS = [
  '--text-2xs-size',
  '--text-2xs-line',
  '--text-xs-size',
  '--text-xs-line',
  '--text-sm-size',
  '--text-sm-line',
  '--text-base-size',
  '--text-base-line',
  '--text-md-size',
  '--text-md-line',
  '--text-lg-size',
  '--text-lg-line',
  '--text-xl-size',
  '--text-xl-line',
  '--text-2xl-size',
  '--text-2xl-line',
  '--text-3xl-size',
  '--text-3xl-line',
  '--text-xs-line-relaxed',
  '--text-sm-line-relaxed',
  '--text-base-line-relaxed',
];

/** The spacing ramp, minus the two steps that are not lengths to scale. */
const SPACE_TOKENS = [
  '--space-1',
  '--space-2',
  '--space-3',
  '--space-4',
  '--space-5',
  '--space-6',
  '--space-8',
  '--space-10',
  '--space-12',
  '--space-16',
  '--space-20',
  '--space-24',
];

const GEOMETRY_TOKENS = [
  '--density-row',
  '--density-row-sm',
  '--density-pad',
  '--control-h',
  '--control-h-sm',
  '--control-h-xs',
  '--engine-marker-h',
];

describe('display size — type and spacing move together', () => {
  it.each(STEPS)('%s resolves every type token to a real length', (step) => {
    const scope = scopeFor(step);
    for (const token of TYPE_TOKENS) expect(px(scope, token)).toBeGreaterThan(0);
  });

  it('grows every TYPE token at every step', () => {
    for (const token of TYPE_TOKENS) {
      const values = STEPS.map((step) => px(scopeFor(step), token));
      expect(values[1], `${token} must grow from default to large`).toBeGreaterThan(values[0]!);
      expect(values[2], `${token} must grow from large to extra large`).toBeGreaterThan(values[1]!);
    }
  });

  it('grows every SPACING token at every step', () => {
    for (const token of SPACE_TOKENS) {
      const values = STEPS.map((step) => px(scopeFor(step), token));
      expect(values[1], `${token} must grow from default to large`).toBeGreaterThan(values[0]!);
      expect(values[2], `${token} must grow from large to extra large`).toBeGreaterThan(values[1]!);
    }
  });

  it('grows every DENSITY/CONTROL token at every step', () => {
    for (const token of GEOMETRY_TOKENS) {
      const values = STEPS.map((step) => px(scopeFor(step), token));
      expect(values[1], `${token} must grow from default to large`).toBeGreaterThan(values[0]!);
      expect(values[2], `${token} must grow from large to extra large`).toBeGreaterThan(values[1]!);
    }
  });

  /**
   * The specific failure mode this setting exists to avoid. If a future
   * retune bumps the type multiplier and forgets the spacing one, every
   * assertion above still passes as long as spacing moved at all — so pin
   * the RATIO: spacing must keep up with type, never lag it.
   */
  it('never lets type outrun spacing', () => {
    const base = lightScope();
    const baseText = px(base, '--text-base-size');
    const basePad = px(base, '--space-4');
    for (const step of STEPS) {
      const scope = scopeFor(step);
      const textGrowth = px(scope, '--text-base-size') / baseText;
      const padGrowth = px(scope, '--space-4') / basePad;
      expect(
        padGrowth,
        `at "${step}" text grew ${textGrowth}x but padding only ${padGrowth}x — big text in cramped boxes`,
      ).toBeGreaterThanOrEqual(textGrowth);
    }
  });

  /** A hairline is one pixel in every setting; 1.375px is a blurred border. */
  it('leaves the hairline and zero steps alone', () => {
    for (const step of STEPS) {
      const scope = scopeFor(step);
      expect(px(scope, '--space-px')).toBe(1);
      expect(px(scope, '--space-0')).toBe(0);
    }
  });

  /**
   * tokens.css's own type rule: "no body text below 12px anywhere in the
   * system", with --text-2xs the single exception. The steps only multiply
   * UP, so this holds trivially today — the test is here so that adding a
   * step BELOW default is a deliberate decision that has to argue with the
   * rule rather than quietly breaking it.
   */
  it('never drops a body size below the 12px floor', () => {
    for (const step of STEPS) {
      expect(px(scopeFor(step), '--text-xs-size')).toBeGreaterThanOrEqual(12);
    }
  });
});

/**
 * The macOS traffic lights. This block is the reason --rail-width is the one
 * shell measure the display size does not touch.
 */
describe('display size — desktop traffic-light clearance', () => {
  /** What desktop/README.md pins the Tauri shell to write on :root. */
  const TRAFFIC_LIGHT_INSET = 92;

  /**
   * The five stylesheets that subtract --rail-width from that inset.
   *
   * 3.10: ApprovalsSection.module.css is gone (Approvals folded into Command's
   * Needs-you drawer), and the four new surfaces — Command, Fleet, Growth,
   * Mind — share ONE header strip in command/surface.module.css (Surface.tsx),
   * so that single file carries the clearance for all four. Listing it here is
   * what stops a new surface strip from sliding under the traffic lights.
   */
  const CLEARANCE_FILES = [
    'routes/verse/Workspace.module.css',
    'routes/verse/sections/SettingsSection.module.css',
    'routes/verse/sections/AutonomySection.module.css',
    'routes/verse/command/surface.module.css',
    'routes/verse/usage/usage.module.css',
  ];

  const read = (relative: string): string =>
    readFileSync(resolve(process.cwd(), 'src/web-ui', relative), 'utf8');

  it('still agrees with the desktop shell contract about the inset', () => {
    // If the shell ever changes the 92px, this test's arithmetic is stale and
    // should fail here rather than silently pass against the wrong number.
    const readme = readFileSync(resolve(process.cwd(), 'desktop/README.md'), 'utf8');
    expect(readme).toContain('`--app-traffic-light-inset` | `92px`');
  });

  it.each(STEPS)('keeps --rail-width at 56px in the %s step', (step) => {
    expect(px(scopeFor(step), '--rail-width')).toBe(56);
  });

  it.each(STEPS)('keeps --strip-height at 48px in the %s step', (step) => {
    // Pinned equal to --app-titlebar-height: the header strip IS the title
    // bar, so moving it desynchronises the window drag region.
    expect(px(scopeFor(step), '--strip-height')).toBe(48);
  });

  it('leaves the clearance expression numerically identical at every step', () => {
    const clearances = STEPS.map((step) => TRAFFIC_LIGHT_INSET - px(scopeFor(step), '--rail-width'));
    expect(new Set(clearances).size, `clearance drifted across steps: ${clearances.join(', ')}`).toBe(1);
    expect(clearances[0]).toBe(36);
  });

  it('declares neither shell measure inside a display-size block', () => {
    for (const step of ['large', 'xlarge'] as const) {
      const decls = declsFor(SELECTOR[step][0]!);
      expect([...decls.keys()], `${step} must not redeclare a shell measure`).not.toContain('--rail-width');
      expect([...decls.keys()], `${step} must not redeclare a shell measure`).not.toContain('--strip-height');
    }
  });

  it('keeps the shell measures free of the scale multipliers', () => {
    const base = lightScope();
    for (const token of ['--rail-width', '--strip-height']) {
      expect(base.get(token), `${token} must be a literal, not a scaled calc()`).not.toMatch(/--ui-(text-)?scale/);
    }
  });

  it.each(CLEARANCE_FILES)('%s still subtracts the rail from the inset', (relative) => {
    const css = read(relative);
    expect(css).toContain('var(--app-traffic-light-inset, 0px) - var(--rail-width, 56px)');
  });

  /**
   * The inline `56px` fallback in those five expressions is a SECOND copy of
   * the rail width. It only fires when the token is missing, but if the token
   * ever moved and the fallback did not, the two would disagree — so pin them
   * to each other.
   */
  it('keeps the inline 56px fallback equal to the token', () => {
    expect(px(lightScope(), '--rail-width')).toBe(56);
  });

  /**
   * The rail is fixed but its CONTENT scales: VerseApp.module.css sizes
   * .railButton as calc(--control-h + --space-1). That is the invariant that
   * actually constrains how far the largest step can go — at a 1.5x geometry
   * scale it lands at 54px inside 56px, with a hover ground touching the
   * rail's hairline. Checked in both densities, because compact picks a
   * smaller base and must not be the only reason it fits.
   */
  it.each(STEPS)('fits the scaled rail button inside the fixed rail at %s', (step) => {
    for (const density of [[], [':root[data-density="compact"]']]) {
      const scope = scopeFor(step, density);
      const button = px(scope, '--control-h') + px(scope, '--space-1');
      const rail = px(scope, '--rail-width');
      expect(
        button,
        `.railButton is ${button}px inside a ${rail}px rail at "${step}" — no room for its hover ground`,
      ).toBeLessThanOrEqual(rail - 4);
    }
  });
});

describe('display size — composition and mechanism', () => {
  /**
   * Density and display size are separate axes with IDENTICAL CSS
   * specificity. Expressing the scale as a multiplier is what stops them
   * colliding; a literal height in a [data-ui-scale] block would mean
   * whichever block came last in the file silently won.
   */
  it('changes only the two multipliers, never a literal', () => {
    for (const step of ['large', 'xlarge'] as const) {
      const decls = declsFor(SELECTOR[step][0]!);
      expect([...decls.keys()].sort()).toEqual(['--ui-scale', '--ui-text-scale']);
      for (const [prop, value] of decls) {
        expect(value, `${prop} must be a unitless multiplier`).toMatch(/^\d+(\.\d+)?$/);
      }
    }
  });

  it('composes with compact density instead of overriding it', () => {
    for (const step of STEPS) {
      const comfortable = px(scopeFor(step), '--control-h');
      const compact = px(scopeFor(step, [':root[data-density="compact"]']), '--control-h');
      expect(compact, `compact must stay tighter than comfortable at "${step}"`).toBeLessThan(comfortable);
    }
    // ...and the display size must still be felt inside compact.
    const compactDefault = px(scopeFor('default', [':root[data-density="compact"]']), '--control-h');
    const compactLargest = px(scopeFor('xlarge', [':root[data-density="compact"]']), '--control-h');
    expect(compactLargest).toBeGreaterThan(compactDefault);
  });

  it('defines both multipliers on bare :root at 1', () => {
    const base = lightScope();
    expect(base.get('--ui-scale')).toBe('1');
    expect(base.get('--ui-text-scale')).toBe('1');
  });

  /**
   * The narrow-window clamp. It exists so the largest step cannot be the
   * reason a 900px window overflows, and it must NOT be a way for the app to
   * silently forget the operator's choice — it only lowers the multipliers,
   * never the stored attribute.
   */
  it('damps the largest step back to Large on a narrow window', () => {
    const damped = declsForAt('max-width: 1100px', ':root[data-ui-scale="xlarge"]');
    const large = declsFor(':root[data-ui-scale="large"]');
    expect([...damped.keys()].sort()).toEqual(['--ui-scale', '--ui-text-scale']);
    expect(damped.get('--ui-scale')).toBe(large.get('--ui-scale'));
    expect(damped.get('--ui-text-scale')).toBe(large.get('--ui-text-scale'));
  });

  /**
   * The setting must reach the app through the SAME mechanism as the theme,
   * density and radius — one attribute on <html>, written by the one store
   * that owns <html>. A second theming path is how data-theme races began.
   */
  it('is applied by the existing appearance store, on the existing element', () => {
    const store = readFileSync(resolve(process.cwd(), 'src/web-ui/data/appearance-store.ts'), 'utf8');
    expect(store).toContain("root.setAttribute('data-ui-scale'");
    expect(store).toContain("root.setAttribute('data-density'");
  });
});
