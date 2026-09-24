/**
 * chat/ChapterRail.test.tsx — one tick per ask, red/amber by status,
 * markers for compaction / recovery / handoff, one tab stop with arrow keys,
 * click to jump; and the signature that keeps it still while tokens stream.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TurnBlock } from './turn-model.js';
import { buildChapters, chaptersSignature } from './chapter-model.js';
import { ChapterRail } from './ChapterRail.js';

function turn(key: string, status: TurnBlock['status'], prompt: string | null, extra: TurnBlock['items'] = []): TurnBlock {
  return {
    key, turnId: key, prompt, at: '2026-09-24T10:00:00.000Z', files: [], toolCount: 0, commandCount: 0, errorCount: 0,
    firstErrorAnchor: null, status, durationMs: null,
    items: [
      ...(prompt === null ? [] : [{ kind: 'user' as const, key: `${key}-u`, turnId: key, at: '2026-09-24T10:00:00.000Z', text: prompt }]),
      ...extra,
    ],
  };
}
const compaction = { kind: 'compaction' as const, key: 'c1', turnId: null, at: '2026-09-24T10:00:00.000Z', trigger: 'auto' as const, preTokens: 900, postTokens: 40, durationMs: 1 };

const TURNS = [
  turn('t1', 'ok', 'Fix the login test'),
  turn('t2', 'error', 'Run the build', [compaction]),
  turn('t3', 'running', 'Ship it'),
];

describe('buildChapters', () => {
  it('ticks each ask with its status and position, and counts what happened', () => {
    const model = buildChapters(TURNS, { handoff: true });
    expect(model.ticks.map((t) => [t.turnKey, t.status, t.position])).toEqual([['t1', 'ok', 0], ['t2', 'error', 0.5], ['t3', 'running', 1]]);
    expect(model.ticks[1]!.markers).toEqual(['compaction']);
    expect(model.counts).toEqual({ failed: 1, running: 1, compactions: 1, recoveries: 0 });
    expect(model.handoff).toBe(true);
  });

  it('carries a prompt-less turn\'s markers onto the next ask', () => {
    const model = buildChapters([turn('t0', 'ok', null, [compaction]), turn('t1', 'ok', 'go')]);
    expect(model.ticks).toHaveLength(1);
    expect(model.ticks[0]!.markers).toEqual(['compaction']);
  });

  it('keeps one signature while only text streams, and moves it when status does', () => {
    const a = chaptersSignature(TURNS, false);
    // A streamed token makes a NEW live TurnBlock with the same facts.
    const again = [TURNS[0]!, TURNS[1]!, { ...TURNS[2]!, items: [...TURNS[2]!.items] }];
    expect(chaptersSignature(again, false)).toBe(a);
    const done = [TURNS[0]!, TURNS[1]!, { ...TURNS[2]!, status: 'ok' as const }];
    expect(chaptersSignature(done, false)).not.toBe(a);
  });
});

describe('ChapterRail', () => {
  it('names every tick, jumps on click, and is ONE tab stop with arrow keys between ticks', async () => {
    const user = userEvent.setup();
    const onJumpTurn = vi.fn();
    render(
      <>
        <button type="button">before</button>
        <ChapterRail model={buildChapters(TURNS, { handoff: true })} onJumpTurn={onJumpTurn} />
      </>,
    );
    const rail = screen.getByRole('toolbar', { name: 'Chapters' });
    expect(rail).toHaveAttribute('aria-orientation', 'vertical');
    const ticks = screen.getAllByRole('button', { name: /^Turn \d of 3/ });
    expect(ticks.map((t) => t.getAttribute('aria-label'))).toEqual([
      'Turn 1 of 3, done: Fix the login test',
      'Turn 2 of 3, failed: Run the build (context compacted)',
      'Turn 3 of 3, running: Ship it',
    ]);
    expect(ticks[1]).toHaveAttribute('data-status', 'error');
    expect(screen.getByRole('img', { name: 'Continued from another chat' })).toBeInTheDocument();

    // Tab lands on the newest turn only.
    screen.getByRole('button', { name: 'before' }).focus();
    await user.tab();
    expect(ticks[2]).toHaveFocus();
    // Its ask is shown while focused.
    expect(screen.getByRole('tooltip')).toHaveTextContent('Ship it');
    await user.keyboard('{ArrowUp}');
    expect(ticks[1]).toHaveFocus();
    expect(screen.getByRole('tooltip')).toHaveTextContent('Turn 2 of 3 · failed');
    await user.keyboard('{Home}');
    expect(ticks[0]).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onJumpTurn).toHaveBeenCalledWith('t1');
    await user.click(ticks[1]!);
    expect(onJumpTurn).toHaveBeenLastCalledWith('t2');
  });
});
