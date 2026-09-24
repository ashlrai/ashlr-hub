/**
 * chat/reasoning-pref.test.tsx — Settings ▸ Chat's reasoning display
 * (Collapsed / Expanded / Hidden) as the transcript honours it.
 */
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ev } from '../fixtures.test-support.js';
import { Transcript } from '../Transcript.js';
import { buildTranscript } from '../verse-store.js';
import {
  getReasoningDisplay,
  REASONING_DISPLAY_KEY,
  resetReasoningDisplay,
  setReasoningDisplay,
} from './reasoning-pref.js';

const LOG = buildTranscript([
  ev(1, 'user-message', { turnId: 't1', text: 'why' }),
  { ...ev(2, 'thinking', { turnId: 't1', text: 'Because the pager is off by one.' }), durationMs: 12_000 } as never,
  ev(3, 'assistant-message', { turnId: 't1', text: 'Fixed.' }),
  ev(4, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 13_000 }),
]);

beforeEach(() => {
  localStorage.clear();
  resetReasoningDisplay();
});

describe('reasoning display preference', () => {
  it('defaults to Collapsed, persists a choice, and ignores garbage', () => {
    expect(getReasoningDisplay()).toBe('collapsed');
    setReasoningDisplay('hidden');
    expect(localStorage.getItem(REASONING_DISPLAY_KEY)).toBe('hidden');
    localStorage.setItem(REASONING_DISPLAY_KEY, 'loud');
    resetReasoningDisplay();
    expect(getReasoningDisplay()).toBe('collapsed');
  });

  it('Collapsed folds a finished block; Expanded opens it; Hidden removes reasoning entirely', () => {
    render(<Transcript transcript={LOG} loaded loadError={null} />);
    const block = () => document.querySelector('[data-kind="thinking"] details') as HTMLDetailsElement | null;
    expect(block()!.open).toBe(false);
    expect(block()!.querySelector('summary')).toHaveTextContent('Thought 12s');
    act(() => setReasoningDisplay('expanded'));
    expect(block()!.open).toBe(true);
    act(() => setReasoningDisplay('hidden'));
    expect(document.querySelector('[data-kind="thinking"]')).toBeNull();
    // The answer itself is untouched.
    expect(document.querySelector('[data-kind="assistant"]')).toHaveTextContent('Fixed.');
  });
});
