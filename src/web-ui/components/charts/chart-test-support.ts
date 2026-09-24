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
