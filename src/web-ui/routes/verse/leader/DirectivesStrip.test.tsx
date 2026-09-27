/**
 * The directive box counts against the SERVER's limit (3.15 fix): the client
 * once allowed 500 characters while leader-operator.ts keeps 300 and cuts the
 * rest with "…". One constant now (OPERATOR_DIRECTIVE_MAX in the browser-safe
 * leader-thread-types.ts), a live "n/300" counter, a warning near the limit,
 * and Add disabled over it.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OPERATOR_DIRECTIVE_MAX } from '../../../../core/vision/leader-thread-types.js';
import type { SurfaceActions } from '../command/actions.js';
import { DIRECTIVE_MAX, DirectivesStrip } from './DirectivesStrip.js';
import type { DirectiveChip } from './thread-types.js';

function renderStrip() {
  const act = vi.fn();
  const actions: SurfaceActions = { act, busy: false, error: null, clearError: () => undefined, readOnly: false, dialogs: null };
  render(
    <DirectivesStrip
      read={{ value: [] as DirectiveChip[], available: true, reason: null }}
      actions={actions}
      adding
      onAddingChange={() => undefined}
    />,
  );
  return { actions: { act }, input: screen.getByRole('textbox', { name: 'New directive' }), add: screen.getByRole('button', { name: 'Add' }) };
}

describe('DirectivesStrip — the server\'s 300-character limit', () => {
  it('uses the server\'s limit, not its own', () => {
    expect(OPERATOR_DIRECTIVE_MAX).toBe(300);
    expect(DIRECTIVE_MAX).toBe(OPERATOR_DIRECTIVE_MAX);
  });

  it('shows a live counter; warns near the limit; over it, Add is disabled and nothing is sent', () => {
    const { actions, input, add } = renderStrip();
    expect(input).not.toHaveAttribute('maxlength');

    fireEvent.change(input, { target: { value: 'Ship binshield first' } });
    const counter = screen.getByText(`20/${OPERATOR_DIRECTIVE_MAX}`);
    expect(counter).not.toHaveAttribute('data-near');
    expect(counter).not.toHaveAttribute('data-over');
    expect(add).toBeEnabled();

    fireEvent.change(input, { target: { value: 'x'.repeat(280) } });
    expect(screen.getByText('280/300')).toHaveAttribute('data-near', 'true');
    expect(add).toBeEnabled();

    fireEvent.change(input, { target: { value: 'x'.repeat(300) } });
    expect(screen.getByText('300/300')).not.toHaveAttribute('data-over');
    expect(add).toBeEnabled();

    fireEvent.change(input, { target: { value: 'x'.repeat(301) } });
    const over = screen.getByText('301/300');
    expect(over).toHaveAttribute('data-over', 'true');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(add).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(actions.act).not.toHaveBeenCalled();
  });

  it('at the limit, Enter adds', () => {
    const { actions, input } = renderStrip();
    fireEvent.change(input, { target: { value: 'y'.repeat(300) } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(actions.act).toHaveBeenCalledTimes(1);
  });
});
