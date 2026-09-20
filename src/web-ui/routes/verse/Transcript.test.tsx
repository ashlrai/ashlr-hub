import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ev } from './fixtures.test-support.js';
import { Transcript } from './Transcript.js';
import { buildTranscript } from './verse-store.js';

describe('Transcript', () => {
  it('renders exactly one quiet note after Stop, not a red failure line', () => {
    const transcript = buildTranscript([
      ev(1, 'user-message', { turnId: 't1', text: 'do the thing' }),
      ev(2, 'turn-started', { turnId: 't1', pid: 1 }),
      ev(3, 'text-delta', { turnId: 't1', text: 'Starting' }),
      ev(4, 'cancelled', { turnId: 't1' }),
      ev(5, 'turn-done', { turnId: 't1', ok: false, nativeSessionId: null, durationMs: 2300 }),
    ]);
    render(<Transcript transcript={transcript} loaded loadError={null} />);
    const log = screen.getByRole('log');
    expect(within(log).getByText('Stopped.')).toBeInTheDocument();
    expect(within(log).queryByText(/Turn ended without a result/)).not.toBeInTheDocument();
    expect(log.querySelectorAll('[data-kind="cancelled"], [data-kind="turn-done"] [role="alert"]')).toHaveLength(1);
    // The duration meta still shows.
    expect(within(log).getByText('2.3s')).toBeInTheDocument();
  });

  it('keeps the failure line when a turn ends without any explanation', () => {
    const transcript = buildTranscript([
      ev(1, 'user-message', { turnId: 't1', text: 'hi' }),
      ev(2, 'turn-done', { turnId: 't1', ok: false, nativeSessionId: null, durationMs: 10 }),
    ]);
    render(<Transcript transcript={transcript} loaded loadError={null} />);
    expect(screen.getByText(/Turn ended without a result/)).toBeInTheDocument();
  });

  it('folds a burst of tool calls into one disclosure that expands to the individual cards', () => {
    const transcript = buildTranscript([
      ev(1, 'user-message', { turnId: 't1', text: 'refactor' }),
      ev(2, 'tool-use', { turnId: 't1', toolUseId: 'a', name: 'Read', input: { file_path: '/a.ts' } }),
      ev(3, 'tool-result', { turnId: 't1', toolUseId: 'a', output: 'ok', isError: false }),
      ev(4, 'tool-use', { turnId: 't1', toolUseId: 'b', name: 'Read', input: { file_path: '/b.ts' } }),
      ev(5, 'tool-result', { turnId: 't1', toolUseId: 'b', output: 'ok', isError: false }),
      ev(6, 'tool-use', { turnId: 't1', toolUseId: 'c', name: 'Edit', input: { file_path: '/b.ts' } }),
      ev(7, 'tool-result', { turnId: 't1', toolUseId: 'c', output: 'boom', isError: true }),
      ev(8, 'assistant-message', { turnId: 't1', text: 'Done.' }),
    ]);
    render(<Transcript transcript={transcript} loaded loadError={null} />);
    const log = screen.getByRole('log');
    expect(log.querySelectorAll('[data-kind="tool"]')).toHaveLength(0);
    const group = log.querySelector('[data-kind="tool-group"] details') as HTMLDetailsElement;
    expect(group.open).toBe(false);
    const summary = group.querySelector('summary')!;
    // DESIGN §5 wording: `3 tools · Read ×2, Edit · 1 failed` — the count is a
    // noun, not a sentence, so the row stays one dense line.
    expect(summary).toHaveTextContent('3 tools');
    expect(summary).toHaveTextContent('Read ×2, Edit');
    expect(summary).toHaveTextContent('1 failed');
    // Every card is still there inside the group.
    expect(group.querySelectorAll('details details')).toHaveLength(3);
    expect(within(group).getByText('/a.ts')).toBeInTheDocument();
  });
});
