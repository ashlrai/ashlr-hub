/**
 * components/charts/chart-test-support.ts — shared helpers for chart tests.
 * The Table twin lives behind each card's ⋯ menu (V3.10); these open it the
 * way a person does, so a test never reaches into component state.
 */
import { fireEvent, screen, within } from '@testing-library/react';
import { declsFor } from '../../design/token-probe.test-support.js';
import { labelCharPx } from './chart-math.js';
import { readTextScale } from './useTextScale.js';

/** Open `title`'s ⋯ menu and pick "Show as table" (or "Show as chart"). */
export function chooseView(view: 'table' | 'chart', title?: string, root: HTMLElement = document.body): void {
  const scope = within(root);
  const name = title ? `${title}: view options` : /view options/;
  const buttons = scope.getAllByRole('button', { name });
  fireEvent.click(buttons[0]!);
  fireEvent.click(screen.getByRole('menuitemradio', { name: view === 'table' ? /Show as table/ : /Show as chart/ }));
}

export function showTable(title?: string, root?: HTMLElement): void {
  chooseView('table', title, root);
}

/** Estimated box of a rendered axis label (same estimate the layout uses). */
export interface LabelBox {
  key: string;
  text: string;
  left: number;
  right: number;
}

/**
 * Every `[data-axis-label]` text in `root`, as the horizontal box it
 * occupies at a Display size (`textScale`, the --ui-text-scale multiplier:
 * 1 Default, 1.125 Large, 1.25 XLarge). Pass the scale the chart was
 * rendered at, so a test checks the layout against the size the labels
 * really have, not the 12 px estimate against itself.
 */
export function axisLabelBoxes(root: ParentNode, textScale = 1): LabelBox[] {
  const charPx = labelCharPx(textScale);
  return [...root.querySelectorAll('[data-axis-label]')].map((el) => {
    const text = el.textContent ?? '';
    const x = Number(el.getAttribute('x'));
    const w = text.length * charPx;
    const anchor = el.getAttribute('text-anchor');
    const left = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x;
    return { key: el.getAttribute('data-axis-label') ?? '', text, left, right: left + w };
  });
}

/** True when no two label boxes overlap. */
export function noOverlap(boxes: ReadonlyArray<LabelBox>): boolean {
  const sorted = [...boxes].sort((a, b) => a.left - b.left);
  return sorted.every((b, i) => i === 0 || sorted[i - 1]!.right <= b.left);
}

const DISPLAY_SIZE_STYLE = 'data-test-display-size';

/**
 * Switch the document to an Appearance → Display size the way the app does:
 * `data-ui-scale` on <html>, resolved by the REAL [data-ui-scale] blocks
 * from design/tokens.css (injected as a stylesheet — jsdom resolves custom
 * properties on <html> but does not inherit them, which is why charts read
 * the scale from <html>). Returns the --ui-text-scale now in force.
 */
export function setDisplaySize(size: 'default' | 'large' | 'xlarge'): number {
  if (!document.head.querySelector(`style[${DISPLAY_SIZE_STYLE}]`)) {
    const style = document.createElement('style');
    style.setAttribute(DISPLAY_SIZE_STYLE, '');
    style.textContent = (['large', 'xlarge'] as const)
      .map((step) => {
        const selector = `:root[data-ui-scale="${step}"]`;
        return `${selector} { --ui-text-scale: ${declsFor(selector).get('--ui-text-scale')}; }`;
      })
      .join('\n');
    document.head.appendChild(style);
  }
  document.documentElement.setAttribute('data-ui-scale', size);
  return readTextScale();
}

/** Undo setDisplaySize: back to Default, stylesheet removed. */
export function clearDisplaySize(): void {
  document.documentElement.removeAttribute('data-ui-scale');
  document.head.querySelector(`style[${DISPLAY_SIZE_STYLE}]`)?.remove();
}
