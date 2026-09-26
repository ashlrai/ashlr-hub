/**
 * BarChart (horizontal) fills its card instead of drawing a fixed 588 px svg
 * that the global `svg { max-width: 100% }` scaled — labels and all — down in
 * any narrower card.
 */
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BarChart } from './BarChart.js';

function atWidth(w: number): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, bottom: 0, right: w, width: w, height: 0, toJSON: () => ({}),
  } as DOMRect);
}

const data = [
  { label: 'qwen3:32b', value: 20 },
  { label: 'llama3.1:8b', value: 5 },
];

describe('BarChart horizontal sizing', () => {
  for (const w of [1834, 420, 300]) {
    it(`draws ${w} px wide, one user unit per pixel, with every bar inside`, () => {
      atWidth(w);
      const view = render(<BarChart orientation="horizontal" data={data} ariaLabel="bars" height={120} />);
      const svg = view.container.querySelector('svg')!;
      expect(svg.getAttribute('width')).toBe(String(w));
      expect(svg.getAttribute('viewBox')).toBe(`0 0 ${w} ${svg.getAttribute('height')}`);
      for (const bar of svg.querySelectorAll('rect[rx]')) {
        expect(Number(bar.getAttribute('x')) + Number(bar.getAttribute('width'))).toBeLessThanOrEqual(w);
      }
    });
  }

  it('keeps the old 588 px layout until the card is measured', () => {
    const view = render(<BarChart orientation="horizontal" data={data} ariaLabel="bars" />);
    expect(view.container.querySelector('svg')!.getAttribute('width')).toBe('588');
  });
});
