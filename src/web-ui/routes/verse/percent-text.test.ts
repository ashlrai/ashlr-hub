import { describe, expect, it } from 'vitest';
import { usedPercentText } from './percent-text.js';
import { percentText } from './autonomy/format.js';

describe('usedPercentText — the one percent rule', () => {
  it('never rounds a real reading to 0% or to a spent-looking 100%', () => {
    expect(usedPercentText(0)).toBe('0%');
    expect(usedPercentText(0.4)).toBe('<1%');
    expect(usedPercentText(42.5)).toBe('43%');
    expect(usedPercentText(99.6)).toBe('99%');
    expect(usedPercentText(100)).toBe('100%');
  });
  it('clamps out-of-range and prints — for unknown', () => {
    expect(usedPercentText(-5)).toBe('0%');
    expect(usedPercentText(140)).toBe('100%');
    expect(usedPercentText(Number.NaN)).toBe('—');
    expect(usedPercentText(null)).toBe('—');
  });
  it('is the same rule the panels use', () => {
    for (const v of [0, 0.4, 1, 42.5, 99.2, 99.99, 100, Number.NaN]) expect(percentText(v)).toBe(usedPercentText(v));
  });
});
