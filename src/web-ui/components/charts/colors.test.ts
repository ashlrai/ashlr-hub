/**
 * colors.ts (unit C0): every colour a chart asks for is a token reference
 * that exists, identity never cycles, and unknown / queued / engine have
 * their own entry points.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as colors from './colors.js';

const WEB = resolve(process.cwd(), 'src/web-ui');
const DEFINED = new Set(
  [readFileSync(resolve(WEB, 'design/tokens.css'), 'utf8'), readFileSync(resolve(WEB, 'components/charts/chart-tokens.css'), 'utf8')].flatMap((css) =>
    [...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!),
  ),
);

function referenced(value: string): string[] {
  return [...value.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]!);
}

describe('chart colours', () => {
  it('gives six identity slots, then the neutral "Other" — never a repeated colour', () => {
    expect(colors.SERIES_SLOT_COUNT).toBe(6);
    expect([0, 1, 2, 3, 4, 5].map(colors.seriesColor)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `var(--chart-series-${n})`));
    for (const slot of [6, 7, 100, -1, 1.5, Number.NaN]) expect(colors.seriesColor(slot), String(slot)).toBe(colors.CHART_NEUTRAL);
  });

  it('steps the quantity ramp 1..7, clamped', () => {
    expect(colors.seqColor(1)).toBe('var(--chart-seq-1)');
    expect(colors.seqColor(7)).toBe('var(--chart-seq-7)');
    expect(colors.seqColor(0)).toBe('var(--chart-seq-1)');
    expect(colors.seqColor(99)).toBe('var(--chart-seq-7)');
    expect(colors.quantityColor(0)).toBe('var(--chart-seq-1)');
    expect(colors.quantityColor(0.5)).toBe('var(--chart-seq-4)');
    expect(colors.quantityColor(1)).toBe('var(--chart-seq-7)');
  });

  it('passes engine colours by name, never by index', () => {
    expect(colors.engineColor('codex')).toBe('var(--engine-codex)');
    expect(colors.engineColor('grok')).toBe('var(--engine-grok)');
  });

  it('describes the unknown hatch for SVG and gives each chart its own pattern id', () => {
    expect(colors.UNKNOWN_HATCH).toEqual({ size: 6, angle: 45, strokeWidth: 1.5, stroke: 'var(--chart-unknown)' });
    expect(colors.hatchPatternId(':r1a:')).toBe('chart-hatch-r1a');
    expect(Object.isFrozen(colors.UNKNOWN_HATCH)).toBe(true);
  });

  it('only ever references tokens that tokens.css or chart-tokens.css define', () => {
    const outputs: string[] = [
      ...[0, 1, 2, 3, 4, 5, 6].map(colors.seriesColor),
      ...[1, 2, 3, 4, 5, 6, 7].map(colors.seqColor),
      ...[0, 1, 2, 3, 4].map(colors.heatColor),
      ...(['neutral', 'info', 'running', 'success', 'warning', 'danger', 'unknown'] as const).map(colors.toneColor),
      ...(['claude', 'codex', 'grok', 'local'] as const).map(colors.engineColor),
      ...(Object.values(colors) as unknown[]).filter((v): v is string => typeof v === 'string'),
      colors.UNKNOWN_HATCH.stroke,
    ];
    for (const output of outputs) {
      for (const token of referenced(output)) expect(DEFINED.has(token), `${output} → ${token}`).toBe(true);
    }
  });
});
