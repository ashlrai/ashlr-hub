/**
 * LineChart — the direct end-of-line labels and the gutter they need.
 *
 * Regression: the label was drawn at `xScale(last.x) + 4`, and because the last
 * point sits at the right edge of the plot that put it at `VBOX_W - PAD_R + 4`
 * with only PAD_R (12 user units) of room before the viewBox ended. The svg
 * clips (`overflow: hidden`), so "Estimated spend" rendered on the Usage page as
 * a single green "E". These tests pin the reserved gutter, which is what keeps
 * the label inside the box at every rendered width.
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LineChart } from './LineChart.js';
import type { Series } from './types.js';

const VBOX_W = 640;
const PAD_R = 12;
/** Must match LineChart's own constant: the per-character advance it reserves. */
const END_LABEL_CH = 6.4;

function series(label: string, id = 'a'): Series {
  return { id, label, points: [{ x: 0, y: 1 }, { x: 1, y: 4 }, { x: 2, y: 2 }] };
}

function chart(list: Series[]) {
  const view = render(<LineChart series={list} ariaLabel="test chart" height={200} />);
  const svg = view.container.querySelector('svg')!;
  return { view, svg };
}

/** The end label for a series, if the chart drew one. */
function endLabel(svg: SVGSVGElement, label: string): SVGTextElement | undefined {
  return [...svg.querySelectorAll('text')].find((t) => t.textContent === label) as
    | SVGTextElement
    | undefined;
}

describe('LineChart end labels', () => {
  it('keeps a long single-series label inside the viewBox instead of clipping it', () => {
    const label = 'Estimated spend';
    const { svg } = chart([series(label)]);
    const text = endLabel(svg, label);
    expect(text, 'the end label should be drawn').toBeTruthy();

    const x = Number(text!.getAttribute('x'));
    const needed = label.length * END_LABEL_CH;
    // The whole label has to fit before the viewBox's right padding edge.
    expect(x + needed).toBeLessThanOrEqual(VBOX_W - PAD_R + 0.01);
  });

  it('stops the gridlines and the x-axis at the reserved edge, not over the label', () => {
    const label = 'Estimated spend';
    const { svg } = chart([series(label)]);
    const text = endLabel(svg, label)!;
    const labelX = Number(text.getAttribute('x'));

    const horizontals = [...svg.querySelectorAll('line')];
    expect(horizontals.length).toBeGreaterThan(0);
    for (const line of horizontals) {
      // Every rule ends before the label starts, or it would strike through it.
      expect(Number(line.getAttribute('x2'))).toBeLessThanOrEqual(labelX);
    }
  });

  it('reserves no gutter when there are no end labels to place', () => {
    // Five series is past the end-label cap, so the plot keeps its full width.
    const many = Array.from({ length: 5 }, (_, i) => series(`S${i}`, `s${i}`));
    const { svg } = chart(many);
    expect(endLabel(svg, 'S0')).toBeUndefined();
    const widest = Math.max(...[...svg.querySelectorAll('line')].map((l) => Number(l.getAttribute('x2'))));
    expect(widest).toBe(VBOX_W - PAD_R);
  });

  it('drops a label too long to afford rather than clipping it or eating the plot', () => {
    // Past END_LABEL_MAX (150u at 6.4u per char) the gutter would cost more plot
    // than the label is worth, so no label and no gutter — the panel heading
    // already names a lone series. What must never happen is the old behaviour:
    // a label drawn anyway and cropped to its first glyph.
    const huge = 'x'.repeat(40);
    const { svg } = chart([series(huge)]);
    expect(endLabel(svg, huge)).toBeUndefined();
    const widest = Math.max(...[...svg.querySelectorAll('line')].map((l) => Number(l.getAttribute('x2'))));
    expect(widest).toBe(VBOX_W - PAD_R);
  });
});
