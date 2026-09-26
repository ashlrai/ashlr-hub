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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { moduleDeclaration } from '../../design/token-probe.test-support.js';
import { LineChart } from './LineChart.js';
import { clearDisplaySize, setDisplaySize } from './chart-test-support.js';
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

describe('LineChart V3.10.1', () => {
  const T = Date.parse('2026-09-01T00:00:00Z');
  const DAY = 86_400_000;
  const yTicks = (svg: SVGSVGElement) =>
    [...svg.querySelectorAll('text')].filter((t) => t.getAttribute('text-anchor') === 'end' && !t.hasAttribute('data-axis-label') && !t.hasAttribute('data-end-label')).map((t) => t.textContent);

  it('dodges end labels of lines ending on the same value, and names both', () => {
    const a: Series = { id: 'a', label: 'Struggles', points: [{ x: 0, y: 1 }, { x: 1, y: 3 }] };
    const b: Series = { id: 'b', label: 'Wins', points: [{ x: 0, y: 2 }, { x: 1, y: 3 }] };
    const { svg } = chart([a, b]);
    const ya = Number(svg.querySelector('[data-end-label="a"]')!.getAttribute('y'));
    const yb = Number(svg.querySelector('[data-end-label="b"]')!.getAttribute('y'));
    expect(Math.abs(ya - yb)).toBeGreaterThanOrEqual(14);
  });

  it('falls back to the legend alone when the end labels cannot be dodged apart', () => {
    const flat = (id: string, label: string): Series => ({ id, label, points: [{ x: 0, y: 1 }, { x: 1, y: 1 }] });
    const view = render(<LineChart series={[flat('a', 'A'), flat('b', 'B'), flat('c', 'C'), flat('d', 'D')]} ariaLabel="t" height={60} />);
    expect(view.container.querySelector('[data-end-label]')).toBeNull();
    expect(view.container.textContent).toContain('D'); // legend
  });

  it('puts integer data on whole-number ticks and fractions at their step precision', () => {
    const { svg } = chart([{ id: 'a', label: 'Runs', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }]);
    expect(yTicks(svg)).toEqual(['0', '1']);
    const { svg: svg2 } = chart([{ id: 'b', label: 'Rate', points: [{ x: 0, y: 0.1 }, { x: 1, y: 0.9 }] }]);
    expect(yTicks(svg2)).toEqual(['0', '0.2', '0.4', '0.6', '0.8', '1.0']);
  });

  it('never prints a rounded label on a precise tick through the caller\'s formatter', () => {
    // Whole-number formatter over 0–1.5: 0.5 steps would print 0 / 1 / 1 / 2.
    const view = render(
      <LineChart series={[{ id: 'a', label: 'Seats', points: [{ x: 0, y: 0.2 }, { x: 1, y: 1.5 }] }]} ariaLabel="t" formatY={(y) => String(Math.round(y))} />,
    );
    expect(yTicks(view.container.querySelector('svg')!)).toEqual(['0', '1', '2']);
  });

  it('ignores a 0 / pre-2000 x on a time axis', () => {
    const utc = (x: number) => new Date(x).toISOString().slice(0, 10);
    const view = render(
      <LineChart
        series={[{ id: 'a', label: 'Spend', points: [{ x: 0, y: 9 }, { x: T, y: 1 }, { x: T + DAY, y: 2 }] }]}
        formatX={utc}
        ariaLabel="t"
      />,
    );
    const labels = [...view.container.querySelectorAll('[data-axis-label]')].map((t) => t.textContent);
    expect(labels).toEqual(['2026-09-01', '2026-09-02']);
  });

  it('widens a degenerate time domain instead of stacking identical labels', () => {
    const view = render(
      <LineChart series={[{ id: 'a', label: 'x', points: [{ x: T, y: 1 }, { x: T + 30_000, y: 2 }] }]} formatX={(x) => new Date(x).toISOString()} ariaLabel="t" />,
    );
    const labels = [...view.container.querySelectorAll('[data-axis-label]')];
    for (const l of labels) expect(l.textContent).toMatch(/^\d{1,2}:\d{2} [AP]M$/);
    expect(new Set(labels.map((l) => l.textContent)).size).toBe(labels.length);
  });
});

describe('LineChart V3.10.1 review — text measures at the Display size', () => {
  afterEach(clearDisplaySize);
  const AXIS_CH = 12 * 0.6;
  const yTickTexts = (root: ParentNode) =>
    [...root.querySelectorAll('text')].filter((t) => t.getAttribute('text-anchor') === 'end' && !t.hasAttribute('data-axis-label') && !t.hasAttribute('data-end-label'));

  it('dodges end labels a full line apart at XLarge, where they are 15 units tall', () => {
    const scale = setDisplaySize('xlarge');
    const a: Series = { id: 'a', label: 'Struggles', points: [{ x: 0, y: 1 }, { x: 1, y: 3 }] };
    const b: Series = { id: 'b', label: 'Wins', points: [{ x: 0, y: 2 }, { x: 1, y: 3 }] };
    const { svg } = chart([a, b]);
    const ya = Number(svg.querySelector('[data-end-label="a"]')!.getAttribute('y'));
    const yb = Number(svg.querySelector('[data-end-label="b"]')!.getAttribute('y'));
    expect(Math.abs(ya - yb)).toBeGreaterThanOrEqual(14 * scale - 1e-9);
  });

  it('reserves the end-label gutter at the size the label renders', () => {
    const scale = setDisplaySize('xlarge');
    const label = 'Estimated spend';
    const { svg } = chart([series(label)]);
    const x = Number(endLabel(svg, label)!.getAttribute('x'));
    expect(x + label.length * END_LABEL_CH * scale).toBeLessThanOrEqual(VBOX_W - PAD_R + 0.01);
  });

  it('widens the y gutter so XLarge tick labels are not clipped at the svg edge', () => {
    const scale = setDisplaySize('xlarge');
    const view = render(
      <LineChart series={[{ id: 'a', label: 'Tokens', points: [{ x: 0, y: 0 }, { x: 1, y: 1400 }] }]} ariaLabel="t" formatY={(y) => y.toLocaleString('en-US')} />,
    );
    const ticks = yTickTexts(view.container);
    expect(ticks.length).toBeGreaterThan(1);
    for (const t of ticks) expect(Number(t.getAttribute('x')) - (t.textContent ?? '').length * AXIS_CH * scale, t.textContent ?? '').toBeGreaterThanOrEqual(0);
  });

  it('keeps the Default layout exactly as it was (a 44-unit gutter fits five characters)', () => {
    const view = render(
      <LineChart series={[{ id: 'a', label: 'Tokens', points: [{ x: 0, y: 0 }, { x: 1, y: 1400 }] }]} ariaLabel="t" formatY={(y) => y.toLocaleString('en-US')} />,
    );
    const xs = yTickTexts(view.container).map((t) => Number(t.getAttribute('x')));
    expect(new Set(xs)).toEqual(new Set([44 - 6]));
  });
});

/**
 * After 3.11.3 — the chart keeps its size at any width. It used to draw a fixed
 * 640-unit viewBox stretched by `width: 100%; height: auto`, so in a 1834 px
 * card on a 1900 px window everything scaled 2.87×: the 200 px chart stood
 * 573 px tall and 12 px tick labels ("60M") rendered at ~34 px. Now the
 * viewBox IS the measured pixel box: one user unit per CSS pixel.
 */
describe('LineChart sizing — scale the coordinates, never the text', () => {
  /** Lay every element out `w` px wide, as a real card of that width would be. */
  function atWidth(w: number): void {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, bottom: 0, right: w, width: w, height: 0, toJSON: () => ({}),
    } as DOMRect);
  }
  const tokens: Series[] = [
    { id: 'tokensIn', label: 'Tokens in', points: [0, 1, 2, 3, 4, 5, 6].map((i) => ({ x: Date.parse('2026-09-20T04:00:00Z') + i * 86_400_000, y: [12e6, 48e6, 30e6, 61e6, 22e6, 40e6, 9e6][i]! })) },
    { id: 'tokensOut', label: 'Tokens out', points: [0, 1, 2, 3, 4, 5, 6].map((i) => ({ x: Date.parse('2026-09-20T04:00:00Z') + i * 86_400_000, y: [1e6, 3e6, 2e6, 4e6, 1.5e6, 2.4e6, 0.6e6][i]! })) },
  ];

  for (const w of [1834, 834, 360]) {
    it(`draws at ${w} px wide and a fixed 200 px tall, one user unit per pixel`, () => {
      atWidth(w);
      const view = render(<LineChart series={tokens} ariaLabel="Tokens per day" height={200} />);
      const svg = view.container.querySelector('svg')!;
      expect(svg.getAttribute('width')).toBe(String(w));
      expect(svg.getAttribute('height')).toBe('200');
      expect(svg.getAttribute('viewBox')).toBe(`0 0 ${w} 200`);
    });

    it(`keeps every line, rule and end label inside the ${w} px box`, () => {
      atWidth(w);
      const view = render(<LineChart series={tokens} ariaLabel="Tokens per day" height={200} />);
      const svg = view.container.querySelector('svg')!;
      for (const line of svg.querySelectorAll('line')) expect(Number(line.getAttribute('x2'))).toBeLessThanOrEqual(w - PAD_R);
      for (const path of svg.querySelectorAll('path')) {
        const xs = [...(path.getAttribute('d') ?? '').matchAll(/[ML]([\d.]+),/g)].map((m) => Number(m[1]));
        expect(Math.max(...xs)).toBeLessThanOrEqual(w - PAD_R);
      }
      for (const label of svg.querySelectorAll('[data-end-label]')) {
        const x = Number(label.getAttribute('x'));
        expect(x + (label.textContent ?? '').length * END_LABEL_CH).toBeLessThanOrEqual(w - PAD_R + 0.01);
      }
    });
  }

  it('honours a fixed width over the measured one', () => {
    atWidth(1834);
    const view = render(<LineChart series={tokens} ariaLabel="t" width={500} />);
    expect(view.container.querySelector('svg')!.getAttribute('viewBox')).toBe('0 0 500 200');
  });

  it('never stretches the svg with CSS (that is what scaled the text)', () => {
    expect(moduleDeclaration('components/charts/LineChart.module.css', '.svg', 'width')).toBeNull();
    expect(moduleDeclaration('components/charts/LineChart.module.css', '.svg', 'height')).toBeNull();
  });
});
