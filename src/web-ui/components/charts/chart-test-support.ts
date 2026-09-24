/**
 * components/charts/chart-test-support.ts — shared helpers for chart tests.
 * The Table twin lives behind each card's ⋯ menu (V3.10); these open it the
 * way a person does, so a test never reaches into component state.
 */
import { fireEvent, screen, within } from '@testing-library/react';

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

/** Every `[data-axis-label]` text in `root`, as the horizontal box it occupies. */
export function axisLabelBoxes(root: ParentNode, charPx = 12 * 0.6): LabelBox[] {
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
