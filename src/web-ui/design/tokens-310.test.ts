/**
 * design/tokens-310.test.ts — the V3.10 colour roles (SPEC-310C §6) as
 * executable assertions, in BOTH themes (unit C0).
 *
 *   ACCENT      interaction only — no data colour may resolve through it.
 *   QUANTITY    a fixed azure ramp at 214°, moving away from the surface.
 *   CATEGORICAL six inks that pass every validate_palette.js gate and stay
 *               clear of each engine, status and quantity colour.
 *   UNKNOWN     gray, not violet.
 *   ENGINES     identity-distinct; Codex off success green, Grok as ink.
 *
 * The palette was DERIVED offline (tokens.css "Data encoding" records how);
 * this file re-measures the properties it was derived for, so a later retune
 * that breaks one fails here instead of shipping. Everything is read from
 * tokens.css and chart-tokens.css themselves, through the same probe the
 * contrast suite uses.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio, parseColor } from './contrast.js';
import { cvdDeltaE, deltaE, oklch } from './palette-math.test-support.js';
import {
  darkScope,
  declsFor,
  declsForAt,
  lightScope,
  resolveToken,
  resolveValue,
  scopeWith,
  type TokenScope,
} from './token-probe.test-support.js';

const WEB = resolve(process.cwd(), 'src/web-ui');
const CHART_TOKENS = readFileSync(resolve(WEB, 'components/charts/chart-tokens.css'), 'utf8');
const COLORS_TS = readFileSync(resolve(WEB, 'components/charts/colors.ts'), 'utf8');

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** chart-tokens.css's `:root` declarations, in order. */
const CHART_DECLS: Array<[string, string]> = [...stripComments(CHART_TOKENS).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(
  (m) => [m[1]!, m[2]!.trim()],
);

/** A theme scope with the chart aliases layered on top, as the browser sees it. */
function withCharts(scope: TokenScope): TokenScope {
  const out = new Map(scope);
  for (const [prop, value] of CHART_DECLS) out.set(prop, value);
  return out;
}

/** Every custom-property name a value passes through on its way to a literal. */
function varChain(scope: TokenScope, value: string, seen = new Set<string>()): Set<string> {
  for (const m of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
    const name = m[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    const next = scope.get(name);
    if (next !== undefined) varChain(scope, next, seen);
  }
  return seen;
}

const THEMES: Array<[string, TokenScope]> = [
  ['light', withCharts(lightScope())],
  ['dark', withCharts(darkScope())],
];

function literal(scope: TokenScope, token: string): string {
  const value = resolveToken(scope, token);
  expect(value, `${token} should resolve`).not.toBeNull();
  expect(parseColor(value!), `${token} = ${value} should be a colour`).not.toBeNull();
  return value!;
}

const SEQ = [1, 2, 3, 4, 5, 6, 7].map((i) => `--data-seq-${i}`);
const CAT = [1, 2, 3, 4, 5, 6].map((i) => `--data-cat-${i}`);
const ENGINES = ['--engine-claude', '--engine-codex', '--engine-grok', '--engine-local'];

/** What a categorical ink must never be mistaken for (the search's reserved set). */
const RESERVED = [
  ...ENGINES,
  '--status-info-solid',
  '--status-running-solid',
  '--status-success-solid',
  '--status-warning-solid',
  '--status-danger-solid',
  '--status-unknown-solid',
  '--data-seq-3',
  '--data-seq-5',
];

/** validate_palette.js lightness bands (OKLCH L) per mode. */
const BAND: Record<string, [number, number]> = { light: [0.43, 0.77], dark: [0.48, 0.67] };

describe('V3.10 colour roles', () => {
  describe.each(THEMES)('%s theme', (name, scope) => {
    const surface = literal(scope, '--bg-surface');

    it('draws quantity with a FIXED azure ramp at 214°, never derived from the accent', () => {
      for (const token of SEQ) {
        const raw = scope.get(token);
        expect(raw, token).toMatch(/^hsl\(214 \d+% \d+%\)$/);
        expect([...varChain(scope, raw!)], token).toEqual([]);
      }
    });

    it('moves the quantity ramp AWAY from the surface, step by step', () => {
      const lightness = SEQ.map((token) => oklch(literal(scope, token))[0]);
      for (let i = 1; i < lightness.length; i += 1) {
        if (name === 'light') expect(lightness[i]!, SEQ[i]).toBeLessThan(lightness[i - 1]!);
        else expect(lightness[i]!, SEQ[i]).toBeGreaterThan(lightness[i - 1]!);
      }
      // The single-hue default for a mark (--chart-sequential) is a visible mark.
      expect(contrastRatio(literal(scope, '--chart-sequential'), surface)!).toBeGreaterThanOrEqual(3);
    });

    it('passes every validate_palette.js gate for the six categorical inks', () => {
      const inks = CAT.map((token) => literal(scope, token));
      const [lo, hi] = BAND[name]!;
      for (const [i, ink] of inks.entries()) {
        const [L, C] = oklch(ink);
        expect(L, `${CAT[i]} lightness band`).toBeGreaterThanOrEqual(lo);
        expect(L, `${CAT[i]} lightness band`).toBeLessThanOrEqual(hi);
        expect(C, `${CAT[i]} chroma floor`).toBeGreaterThanOrEqual(0.1);
        expect(contrastRatio(ink, surface)!, `${CAT[i]} on the surface`).toBeGreaterThanOrEqual(3);
      }
      for (let i = 0; i + 1 < inks.length; i += 1) {
        expect(deltaE(inks[i]!, inks[i + 1]!), `${CAT[i]}↔${CAT[i + 1]} normal vision`).toBeGreaterThanOrEqual(15);
        expect(cvdDeltaE(inks[i]!, inks[i + 1]!), `${CAT[i]}↔${CAT[i + 1]} protan/deutan`).toBeGreaterThanOrEqual(8);
      }
      // The first three carry most charts: they must separate ALL-pairs.
      for (let i = 0; i < 3; i += 1) {
        for (let j = i + 1; j < 3; j += 1) {
          expect(deltaE(inks[i]!, inks[j]!)).toBeGreaterThanOrEqual(15);
          expect(cvdDeltaE(inks[i]!, inks[j]!)).toBeGreaterThanOrEqual(8);
        }
      }
    });

    it('keeps every categorical ink clear of each engine, status and quantity colour', () => {
      for (const token of CAT) {
        const ink = literal(scope, token);
        for (const reserved of RESERVED) {
          expect(deltaE(ink, literal(scope, reserved)), `${token} vs ${reserved}`).toBeGreaterThanOrEqual(11);
        }
      }
    });

    it('aliases --chart-series-1..6 onto the inks, in order', () => {
      for (const [i, token] of CAT.entries()) {
        expect(literal(scope, `--chart-series-${i + 1}`)).toBe(literal(scope, token));
      }
      expect(scope.has('--chart-series-7')).toBe(false);
    });

    it('draws unknown in gray — not the violet it shared with the local engine', () => {
      const unknown = literal(scope, '--status-unknown-solid');
      expect(oklch(unknown)[1], 'unknown chroma').toBeLessThan(0.04);
      expect(deltaE(unknown, literal(scope, '--engine-local'))).toBeGreaterThanOrEqual(15);
      expect(literal(scope, '--chart-unknown')).toBe(unknown);
    });

    it('keeps the four engines distinct, Codex off success green and Grok as ink', () => {
      const engines = ENGINES.map((token) => literal(scope, token));
      for (let i = 0; i < engines.length; i += 1) {
        for (let j = i + 1; j < engines.length; j += 1) {
          expect(deltaE(engines[i]!, engines[j]!), `${ENGINES[i]} vs ${ENGINES[j]}`).toBeGreaterThanOrEqual(15);
        }
      }
      // SPEC-310C fixes Codex at cyan #0e9aa7 (dark lifted to #32adba): 11.6 / 12.1 from success
      // green, where the 3.9 #10a37f / #19c79b sat under 6 — a near-twin. Engines never share a
      // chart with status colour (they switch to position + monogram), so 10 is the honest floor.
      expect(deltaE(literal(scope, '--engine-codex'), literal(scope, '--status-success-solid'))).toBeGreaterThanOrEqual(10);
      const grok = literal(scope, '--engine-grok');
      expect(oklch(grok)[1], 'grok is achromatic ink').toBeLessThan(0.02);
      expect(contrastRatio(grok, surface)!, 'ink, not the mid gray that meant neutral').toBeGreaterThanOrEqual(7);
    });

    it('resolves every chart colour token in this theme', () => {
      for (const [prop] of CHART_DECLS) {
        if (prop === '--chart-unknown-hatch') continue; // a gradient, checked below
        literal(scope, prop);
      }
      const hatch = resolveValue(scope, scope.get('--chart-unknown-hatch')!);
      expect(hatch).toMatch(/^repeating-linear-gradient\(135deg, #[0-9a-f]{6} 0 1px, transparent 1px 5px\)$/);
    });
  });

  it('never lets a data colour resolve through the accent (accent is interaction-only)', () => {
    for (const [, scope] of THEMES) {
      for (const [prop, value] of CHART_DECLS) {
        const chain = [...varChain(scope, value)];
        expect(chain.filter((n) => n.startsWith('--accent')), `${prop} → ${chain.join(' → ')}`).toEqual([]);
      }
      for (const token of [...SEQ, ...CAT]) expect(scope.get(token)!.includes('accent'), token).toBe(false);
    }
    expect(stripComments(CHART_TOKENS)).not.toMatch(/accent/);
    expect(COLORS_TS.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')).not.toMatch(/accent/);
  });

  it('keeps chart-tokens.css to aliases — no raw colour of its own', () => {
    expect(stripComments(CHART_TOKENS)).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i);
  });
});

describe('V3.10 workbench layout + motion tokens', () => {
  const px = (scope: TokenScope, token: string) => resolveToken(scope, token);

  it('lays surfaces on a 12-column grid with 16px gaps and 16px card padding', () => {
    const light = lightScope();
    expect(px(light, '--surface-columns')).toBe('12');
    expect(px(light, '--surface-gap')).toBe('16px');
    expect(px(light, '--card-pad')).toBe('16px');
  });

  it('tightens card padding to 12px in compact density', () => {
    expect(px(scopeWith([':root[data-density="compact"]']), '--card-pad')).toBe('12px');
  });

  it('lifts dark KPI cards with a 4% white top hairline, and adds none in light', () => {
    expect(px(lightScope(), '--hairline-lift')).toBe('transparent');
    expect(px(darkScope(), '--hairline-lift')).toBe('rgba(255, 255, 255, 0.04)');
  });

  it('breathes the running pulse over 1.6s — and stops it (0s, not a 1ms strobe) under reduced motion', () => {
    expect(px(lightScope(), '--duration-pulse')).toBe('1600ms');
    expect(declsForAt('prefers-reduced-motion: reduce', ':root:not([data-motion="full"])').get('--duration-pulse')).toBe('0s');
    expect(declsFor(':root[data-motion="reduce"]').get('--duration-pulse')).toBe('0s');
  });
});
