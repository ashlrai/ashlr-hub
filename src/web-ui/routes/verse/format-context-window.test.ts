import { describe, expect, it } from 'vitest';
import { formatContextWindow } from './verse-model.js';

describe('formatContextWindow — one spelling of a window everywhere', () => {
  it('quotes an exact multiple of 1024 in binary k, the way the model card and ctx64k tag do', () => {
    expect(formatContextWindow(65_536)).toBe('64k');
    expect(formatContextWindow(262_144)).toBe('256k');
    expect(formatContextWindow(16_384)).toBe('16k');
    expect(formatContextWindow(131_072)).toBe('128k');
    expect(formatContextWindow(1_048_576)).toBe('1M');
  });

  it('keeps a decimal window decimal', () => {
    expect(formatContextWindow(200_000)).toBe('200k');
    expect(formatContextWindow(272_000)).toBe('272k');
    expect(formatContextWindow(500_000)).toBe('500k');
    expect(formatContextWindow(1_000_000)).toBe('1M');
    expect(formatContextWindow(258_400)).toBe('258k');
    // Rounded before the unit is chosen: never "1000k".
    expect(formatContextWindow(999_700)).toBe('1M');
  });

  it('says a small or missing window plainly', () => {
    expect(formatContextWindow(512)).toBe('512');
    expect(formatContextWindow(null)).toBe('—');
    expect(formatContextWindow(undefined)).toBe('—');
    expect(formatContextWindow(Number.NaN)).toBe('—');
  });
});
