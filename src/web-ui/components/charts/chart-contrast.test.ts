/**
 * chart-contrast.test.ts — the chart kit's own colour pairs, measured in BOTH
 * themes through the same token probe and WCAG math as
 * design/tokens-contrast.test.ts (8-bit channels, as the browser paints).
 *
 * Two V3.10.1 review findings lived in pairs no suite measured:
 *   - a digit on a quantity heat cell: --text-primary on dark --chart-seq-4
 *     was 4.49:1, just under AA for 12 px text;
 *   - the Funnel's empty track (.trackEmpty): the hairline gray it borrowed
 *     was 1.18:1 / 1.14:1 on the card, so a zero stage was blank space.
 * Each pair is resolved from the code that paints it (colors.ts,
 * chart-tokens.css, plot.module.css), so the number in a comment and the
 * number on screen cannot drift apart.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../../design/contrast.js';
import { oklch } from '../../design/palette-math.test-support.js';
import { darkScope, lightScope, moduleDeclaration, resolveValue, type TokenScope } from '../../design/token-probe.test-support.js';
import { CHART_SEQUENTIAL, SEQ_STEP_COUNT, quantityColor, quantityInk, quantityStep } from './colors.js';

const CHART_TOKENS = readFileSync(resolve(process.cwd(), 'src/web-ui/components/charts/chart-tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const PLOT = 'components/charts/plot.module.css';

/** A theme scope with chart-tokens.css's aliases layered on top, as the browser sees it. */
function withCharts(scope: TokenScope): TokenScope {
  const out = new Map(scope);
  for (const m of CHART_TOKENS.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}

const THEMES: Array<[string, TokenScope]> = [
  ['light', withCharts(lightScope())],
  ['dark', withCharts(darkScope())],
];

function literal(scope: TokenScope, value: string): string {
  const out = resolveValue(scope, value);
  expect(out, `${value} should resolve to a literal colour`).not.toBeNull();
  return out!;
}

function ratio(scope: TokenScope, fg: string, bg: string): number {
  const ground = literal(scope, 'var(--bg-surface)');
  const value = contrastRatio(literal(scope, fg), literal(scope, bg), ground);
  expect(value, `${fg} on ${bg} should be measurable`).not.toBeNull();
  return value!;
}

describe.each(THEMES)('chart colour pairs — %s theme', (_name, scope) => {
  // One fraction per step, through the same rounding the heatmap uses.
  const fractions = Array.from({ length: SEQ_STEP_COUNT }, (_, i) => i / (SEQ_STEP_COUNT - 1));

  it('covers every quantity step once', () => {
    expect(fractions.map(quantityStep)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it.each(fractions.map((f) => [quantityStep(f), f]))('prints a number on quantity step %i at AA (4.5:1) for 12 px text', (_step, f) => {
    expect(ratio(scope, quantityInk(f), quantityColor(f))).toBeGreaterThanOrEqual(4.5);
  });

  const card = 'var(--bg-surface)'; // ChartFrame's card ground
  const track = (): string => {
    const fill = moduleDeclaration(PLOT, '.trackEmpty', 'fill');
    expect(fill, '.trackEmpty should declare a fill').not.toBeNull();
    return fill!;
  };

  // The empty track is a filled shape carrying the scale every bar is a
  // share of: tokens.css holds an empty meter to 1.8:1, and so is this.
  it('keeps the Funnel\'s empty track visible on the card', () => {
    expect(ratio(scope, track(), card)).toBeGreaterThanOrEqual(1.8);
  });

  // …without swallowing the data: a bar's END is read against its own
  // track, so the fill must stay clearly apart from it.
  it('keeps a Funnel bar distinct from the track it sits on', () => {
    const ground = literal(scope, card);
    const value = contrastRatio(literal(scope, CHART_SEQUENTIAL), literal(scope, track()), ground);
    expect(value).not.toBeNull();
    expect(value!).toBeGreaterThanOrEqual(2);
  });

  // Neutral, never azure: an empty track on the quantity hue read as "a little".
  it('draws the Funnel\'s empty track in a neutral gray, not on the quantity hue', () => {
    const [, chroma] = oklch(literal(scope, track()));
    expect(chroma).toBeLessThan(0.02);
  });
});
