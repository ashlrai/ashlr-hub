import { describe, expect, it } from 'vitest';
import {
  formatCompact, formatDayLabel, formatPercent, formatSignedCompact, formatTimeLabel, formatUsd,
} from './format';

describe('formatDayLabel', () => {
  it.each([
    ['2024-01-01', 'Jan 1'], ['2024-12-31', 'Dec 31'], ['2024-02-29', 'Feb 29'],
    ['2000-02-29', 'Feb 29'], ['1900-02-28', 'Feb 28'], ['0000-02-29', 'Feb 29'],
    ['0004-02-29', 'Feb 29'], ['0099-02-28', 'Feb 28'], ['0099-12-31', 'Dec 31'],
    ['9999-12-31', 'Dec 31'],
  ])('formats valid exact UTC calendar date %s as %s', (day, label) => {
    expect(formatDayLabel(day)).toBe(label);
  });

  it.each([
    '', 'not-a-date', '2024-2-09', '2024-02-9', '24-02-09', '+002024-02-29',
    '2024-02-29T00:00:00Z', '2024/02/29', ' 2024-02-29', '2024-02-29 ', '2024-02-29\n',
    '2024-00-01', '2024-13-01', '2024-01-00', '2024-01-32', '2024-04-31',
    '2023-02-29', '2024-02-30', '2024-02-31', '1900-02-29', '2100-02-29',
    '0099-02-29', '0100-02-29',
  ])('preserves malformed or impossible calendar input %j', (day) => {
    expect(formatDayLabel(day)).toBe(day);
  });

  it('matches independent Gregorian month-length arithmetic across 6732 calendar boundaries', () => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const years = [0, 4, 99, 100, 400, 1582, 1600, 1700, 1800, 1900, 1999, 2000, 2023, 2024, 2100, 2400, 9999];
    const failures: Array<{ date: string; expected: string; actual: string }> = [];
    for (const year of years) {
      // Deliberately do not use Date to generate the expected calendar: that is
      // the API whose silent overflow normalization this regression catches.
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      for (let month = 1; month <= 12; month++) {
        for (let day = 0; day <= 32; day++) {
          const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const expected = day >= 1 && day <= lengths[month - 1] ? `${months[month - 1]} ${day}` : date;
          const actual = formatDayLabel(date);
          if (actual !== expected) failures.push({ date, expected, actual });
        }
      }
    }
    expect({ count: failures.length, examples: failures.slice(0, 5) }).toEqual({ count: 0, examples: [] });
  });
});

describe('shared chart number and timestamp formatting', () => {
  it.each([
    [0, '0'], [1.25, '1.3'], [1284, '1,284'], [12_900, '13K'],
    [4_200_000, '4.2M'], [12_900_000, '13M'], [-12_900, '-13K'],
  ])('formats count %s as %s', (value, label) => {
    expect(formatCompact(value)).toBe(label);
  });

  it.each([[4.2, '$4.20'], [1200, '$1.2K'], [4_200_000, '$4.2M'], [-4.2, '-$4.20'], [0, '$0.00']])(
    'formats USD %s as %s', (value, label) => { expect(formatUsd(value)).toBe(label); },
  );

  it('preserves percentage precision and signed compact conventions', () => {
    expect(formatPercent(0.125)).toBe('13%');
    expect(formatPercent(0.125, 1)).toBe('12.5%');
    expect(formatPercent(-0.05)).toBe('-5%');
    expect(formatSignedCompact(12)).toBe('+12');
    expect(formatSignedCompact(-3)).toBe('-3');
    expect(formatSignedCompact(0)).toBe('0');
    expect(formatSignedCompact(12_900)).toBe('+13K');
  });

  it.each([NaN, Infinity, -Infinity])('does not manufacture numeric labels for %s', (value) => {
    for (const format of [formatCompact, formatUsd, formatPercent, formatSignedCompact]) {
      expect(format(value)).toBe('—');
    }
    expect(formatTimeLabel(value)).toBe('');
  });

  it('keeps epoch timestamp labels in the local calendar', () => {
    const localNoon = new Date(2024, 0, 2, 12, 0, 0).getTime();
    expect(formatTimeLabel(localNoon)).toBe('Jan 2');
  });
});
