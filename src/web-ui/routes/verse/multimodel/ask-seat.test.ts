import { describe, expect, it, vi } from 'vitest';
import type { VerseSeat } from '../../../data/api-types.js';
import { CLAUDE_SEAT, CODEX_SEAT, LOCAL_SEAT, session } from '../fixtures.test-support.js';
import { askableSeats, askSeat, firstSeatPerEngine } from './ask-seat.js';

const CODEX_READY: VerseSeat = { ...CODEX_SEAT, id: 'codex-b', label: 'Work Codex', health: { state: 'ready', summary: null, windows: [], observedAt: null } };

function api() {
  return {
    createSession: vi.fn(async (req: { seatId: string }) => session({ id: `new-${req.seatId}`, seatId: req.seatId })),
    sendTurn: vi.fn(async () => ({})),
    link: vi.fn(async () => true),
  };
}

describe('ask-seat', () => {
  it('lists every seat that can answer, marking the ready ones', () => {
    const seats = askableSeats([CLAUDE_SEAT, CODEX_SEAT, CODEX_READY, LOCAL_SEAT]);
    // The unavailable Codex seat is left out; the unknown-health local one stays (not "ready").
    expect(seats.map((s) => [s.seatId, s.ready])).toEqual([['claude-main', true], ['codex-b', true], ['local:qwen3-coder', false]]);
    expect(firstSeatPerEngine([CLAUDE_SEAT, CODEX_READY, LOCAL_SEAT], ['codex', 'devin', 'claude']).map((s) => s.seatId)).toEqual(['codex-b', 'claude-main']);
  });

  it('the chat\'s own seat: a turn in this chat', async () => {
    const a = api();
    const source = session({ id: 's-1', seatId: 'claude-main' });
    const res = await askSeat(a, { source, target: { seatId: 'claude-main', model: 'claude-opus-5', label: 'Claude Max', engine: 'claude' }, text: 'why?' });
    expect(res).toEqual({ sessionId: 's-1', created: false, label: 'Claude Max' });
    expect(a.sendTurn).toHaveBeenCalledWith('s-1', 'why?');
    expect(a.createSession).not.toHaveBeenCalled();
  });

  it('another seat: a new chat on the same folders, linked, then the turn — a failed link never loses it', async () => {
    const a = api();
    a.link.mockRejectedValueOnce(new Error('offline'));
    const source = session({ id: 's-1', seatId: 'claude-main', projectPath: '/p', extraRoots: ['/q'], title: 'Build' });
    const res = await askSeat(a, { source, target: { seatId: 'codex-b', model: 'gpt-5.5', label: 'Work Codex', engine: 'codex' }, text: 'fix?', relation: 'review' });
    expect(res).toEqual({ sessionId: 'new-codex-b', created: true, label: 'Work Codex' });
    expect(a.createSession).toHaveBeenCalledWith({ projectPath: '/p', seatId: 'codex-b', extraRoots: ['/q'], model: 'gpt-5.5', title: 'Build · Work Codex' });
    expect(a.link).toHaveBeenCalledWith({ parentSessionId: 's-1', childSessionId: 'new-codex-b', relation: 'review' });
    expect(a.sendTurn).toHaveBeenCalledWith('new-codex-b', 'fix?');
  });
});
