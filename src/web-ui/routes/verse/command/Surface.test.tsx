/**
 * The shared surface grid (audit 15): at medium a pair that fills a 12-column
 * row stays a pair (6 | 6), never half + full with a blank half-row between.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { mockViewport, mockWideViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { Cell, Surface, layoutSpans, spanFor } from './Surface.js';

describe('layoutSpans', () => {
  it('wide keeps every span as written; compact is one column', () => {
    expect(layoutSpans('wide', [5, 7, 12, 3])).toEqual([5, 7, 12, 3]);
    expect(layoutSpans('compact', [5, 7, 12, 3])).toEqual([12, 12, 12, 12]);
  });

  it('medium: Command\'s Needs you 5 | Leader 7 is one row of halves, not half + full', () => {
    // spanFor alone would give [6, 12]: a blank half beside Needs you.
    expect([spanFor('medium', 5), spanFor('medium', 7)]).toEqual([6, 12]);
    expect(layoutSpans('medium', [5, 7, 12, 12, 12, 12])).toEqual([6, 6, 12, 12, 12, 12]);
  });

  it('medium: every pair that fills its row is halved, wherever it sits (Fleet, Mind, Growth)', () => {
    expect(layoutSpans('medium', [12, 7, 5, 7, 5, 12])).toEqual([12, 6, 6, 6, 6, 12]);
    expect(layoutSpans('medium', [8, 4, 12, 8, 4, 12])).toEqual([6, 6, 12, 6, 6, 12]);
  });

  it('medium: a full trio is halves with the odd one out full-width — no blank half', () => {
    expect(layoutSpans('medium', [4, 4, 4])).toEqual([6, 6, 12]);
    expect(layoutSpans('medium', [8, 4, 4, 4, 4, 8, 4])).toEqual([6, 6, 6, 6, 12, 6, 6]);
  });

  it('medium: a row the layout leaves open folds cell by cell, as before', () => {
    expect(layoutSpans('medium', [4, 4])).toEqual([6, 6]);
    expect(layoutSpans('medium', [9, 9])).toEqual([12, 12]);
    // Out-of-range spans are clamped before the rows are read.
    expect(layoutSpans('medium', [0, 20])).toEqual([6, 12]);
  });
});

describe('Surface', () => {
  let vp: ViewportMock | null = null;
  afterEach(() => {
    vp?.restore();
    vp = null;
  });

  it('hands each Cell its row-aware span and leaves other children alone', () => {
    vp = mockWideViewport();
    render(
      <Surface title="Test">
        <Cell span={5}><p>a</p></Cell>
        <Cell span={7}><p>b</p></Cell>
        {null}
        <p>dialogs</p>
        <Cell span={12}><p>c</p></Cell>
      </Surface>,
    );
    const cells = ['a', 'b', 'c'].map((t) => screen.getByText(t).parentElement!);
    expect(cells.map((c) => c.style.gridColumn)).toEqual(['span 5', 'span 7', 'span 12']);
    expect(screen.getByText('dialogs')).toBeInTheDocument();
  });

  it('at ~900px the 5 | 7 pair renders as 6 | 6', () => {
    vp = mockViewport(900);
    render(
      <Surface title="Test">
        <Cell span={5}><p>needs</p></Cell>
        <Cell span={7}><p>leader</p></Cell>
        <Cell span={12}><p>kpis</p></Cell>
      </Surface>,
    );
    expect(['needs', 'leader', 'kpis'].map((t) => screen.getByText(t).parentElement!.style.gridColumn)).toEqual(['span 6', 'span 6', 'span 12']);
  });
});
