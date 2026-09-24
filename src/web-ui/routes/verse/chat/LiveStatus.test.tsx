import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ev } from '../fixtures.test-support.js';
import { buildTranscript, type VerseLiveState } from '../verse-store.js';
import { derivePhaseFromTranscript, formatLiveElapsed, liveStatusLine } from './LiveStatus.js';
import { formatThinkingTokens, thinkingLabel, thinkingTokenFigure, ThinkingBlock } from './ThinkingBlock.js';

const LIVE: VerseLiveState = { turnId: 't1', startedAt: 1_000_000, progress: null, thinking: null, notice: null, settledTurnId: null };

describe('LiveStatus line', () => {
  it('reads the phase from the transcript when the server sends no progress frames', () => {
    const pending = buildTranscript([
      ev(1, 'user-message', { turnId: 't1', text: 'go' }),
      ev(2, 'turn-started', { turnId: 't1', pid: 1 }),
      ev(3, 'tool-use', { turnId: 't1', toolUseId: 'a', name: 'Bash', input: { command: 'npm test' } }),
    ]).items;
    expect(derivePhaseFromTranscript(pending, LIVE)).toEqual({ phase: 'tool', detail: 'npm test' });
    const writing = buildTranscript([ev(1, 'turn-started', { turnId: 't1', pid: 1 }), ev(2, 'text-delta', { turnId: 't1', text: 'Hi' })]).items;
    expect(derivePhaseFromTranscript(writing, LIVE).phase).toBe('writing');
    expect(derivePhaseFromTranscript([], { thinking: { turnId: 't1', text: '', startedAt: 0, estimatedTokens: 10 } }).phase).toBe('thinking');
    expect(derivePhaseFromTranscript([], LIVE).phase).toBe('waiting');
  });

  it('counts elapsed on from the last progress frame and states only measured figures', () => {
    const now = 2_000_000;
    const withProgress: VerseLiveState = { ...LIVE, progress: { phase: 'writing', tool: null, elapsedMs: 60_000, outTokens: 900, tokPerSec: 38.4, receivedAt: now - 3000 } };
    expect(liveStatusLine(withProgress, { phase: 'waiting', detail: null }, now)).toEqual({
      phase: 'writing', word: 'Writing', elapsedMs: 63_000, detail: null, rate: '38 tok/s',
    });
    // No progress: elapsed from the turn's start, no rate at all (not "0 tok/s").
    expect(liveStatusLine(LIVE, { phase: 'waiting', detail: null }, 1_014_000)).toEqual({
      phase: 'waiting', word: 'Waiting', elapsedMs: 14_000, detail: null, rate: null,
    });
    // The transcript's pending tool beats a stale "thinking" frame, and carries the argument.
    const stale: VerseLiveState = { ...LIVE, progress: { phase: 'thinking', tool: null, elapsedMs: 1000, outTokens: null, tokPerSec: 2.5, receivedAt: now } };
    expect(liveStatusLine(stale, { phase: 'tool', detail: 'npm test' }, now)).toMatchObject({ word: 'Running', detail: 'npm test', rate: null });
    expect(liveStatusLine(stale, { phase: 'waiting', detail: null }, now).rate).toBe('2.5 tok/s');
  });

  it('formats elapsed time compactly', () => {
    expect(formatLiveElapsed(14_200)).toBe('14s');
    expect(formatLiveElapsed(63_000)).toBe('1m 3s');
    expect(formatLiveElapsed(3_720_000)).toBe('1h 2m');
    expect(formatLiveElapsed(Number.NaN)).toBe('0s');
  });
});

describe('ThinkingBlock', () => {
  it('labels a finished block with what is known and nothing else', () => {
    expect(thinkingLabel({ streaming: false, elapsedMs: 12_000, tokens: 1840 })).toBe('Thought 12s · ~1.8k tok');
    expect(thinkingLabel({ streaming: false, elapsedMs: null, tokens: null })).toBe('Thought');
    expect(thinkingLabel({ streaming: true, elapsedMs: 3000, tokens: 40 })).toBe('Thinking · 3s · ~40 tok');
    expect(formatThinkingTokens(12_400)).toBe('~12k tok');
    expect(formatThinkingTokens(2_000_000)).toBe('~2M tok');
  });

  it('estimates tokens from the text only when the CLI gave no count', () => {
    expect(thinkingTokenFigure('x'.repeat(400), null)).toBe(100);
    expect(thinkingTokenFigure('x'.repeat(400), 900)).toBe(900);
    expect(thinkingTokenFigure('   ', null)).toBeNull();
  });

  it('keeps the operator\'s open/closed choice when its turn finishes', async () => {
    const user = userEvent.setup();
    const { rerender, container } = render(<ThinkingBlock text="step one" defaultOpen />);
    const details = container.querySelector('details')!;
    expect(details.open).toBe(true);
    // The turn finished: an untouched block folds itself.
    rerender(<ThinkingBlock text="step one" defaultOpen={false} />);
    expect(details.open).toBe(false);
    // Opened by hand, it stays open whatever the default does next.
    await user.click(screen.getByText(/^Thought/));
    expect(details.open).toBe(true);
    rerender(<ThinkingBlock text="step one" defaultOpen />);
    rerender(<ThinkingBlock text="step one" defaultOpen={false} />);
    expect(details.open).toBe(true);
  });
});
