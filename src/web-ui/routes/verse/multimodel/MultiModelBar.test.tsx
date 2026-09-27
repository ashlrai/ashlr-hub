/**
 * multimodel/MultiModelBar.test.tsx — the line above the composer: the Auto
 * choice in one line (only after the privacy check answered), the local
 * badge, the override, and the send interceptor's promises — Auto off sends
 * here, staying sends here, and a once-per-send label that CHANGES the seat
 * holds the message and says so instead of sending it somewhere unseen.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MultimodelContext, PromptClassification } from '../../../../core/verse/multimodel/types.js';
import { setMutationToken, clearMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { CLAUDE_SEAT, LOCAL_SEAT, session } from '../fixtures.test-support.js';
import { resetVerseStore, seedVerseSession } from '../verse-store.js';
import { MultiModelBar, resetPendingDraftsForTest, type SendInterceptor } from './MultiModelBar.js';
import { saveAutoPref, toAdvisorSeats } from './useAutoSeat.js';

const CONTEXT: MultimodelContext = {
  learned: {},
  roi: {},
  localOnly: { on: false, reason: null },
  local: [{ seatId: LOCAL_SEAT.id, model: 'qwen3-coder', state: 'unknown', contextWindow: 65_536, tokPerSec: 42.5, tokPerSecSource: 'warm', private: true, supportsTools: null }],
  sampledAt: '',
};

let label: PromptClassification | null = null;

function stubFetch(context: MultimodelContext | null = CONTEXT) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/verse/multimodel/context')) return context ? Response.json(context) : new Response('down', { status: 503 });
    if (url.includes('/api/verse/multimodel/label')) {
      return label ? Response.json({ classification: label, fallbackReason: null }) : new Response('no', { status: 500 });
    }
    if (url.includes('/api/verse/multimodel/meter')) return new Response('not found', { status: 404 });
    return new Response('not found', { status: 404 });
  }));
}

function renderBar(text: string, turnCount = 0) {
  seedVerseSession('vs_1', session({ id: 'vs_1', turnCount }), []);
  let interceptor: SendInterceptor | null = null;
  const utils = render(<MultiModelBar sessionId="vs_1" seats={[CLAUDE_SEAT, LOCAL_SEAT]} text={text} running={false}
    registerInterceptor={(fn) => { interceptor = fn; }} onConsumeDraft={vi.fn()} />);
  return { ...utils, intercept: (t: string) => interceptor!(t) };
}

beforeEach(() => {
  evictAll();
  resetVerseStore();
  resetPendingDraftsForTest();
  localStorage.clear();
  label = null;
  setMutationToken('a'.repeat(64));
  vi.stubGlobal('EventSource', class { close() {} addEventListener() {} removeEventListener() {} } as unknown as typeof EventSource);
});
afterEach(() => {
  clearMutationToken();
  vi.unstubAllGlobals();
});

describe('MultiModelBar', () => {
  it('names the seat for this message in one line, with the local badge', async () => {
    stubFetch();
    renderBar('what does this regex match?');
    expect(await screen.findByText('Qwen3 Coder (local) — quick explanation — free and private on this Mac.')).toBeInTheDocument();
    expect(screen.getByText(/On this Mac · private · 66k ctx · 42.5 tok\/s/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Warm up' })).toBeInTheDocument();
    // Override: every other eligible seat is offered, with its note.
    const select = screen.getByRole('combobox', { name: 'Send this message to' });
    expect(select).toHaveDisplayValue('Auto: Qwen3 Coder (local)');
    expect(screen.getByRole('option', { name: 'Claude Max — no usage reading' })).toBeInTheDocument();
  });

  it('gives no advice until the privacy check has answered', async () => {
    stubFetch(null);
    renderBar('what does this regex match?');
    expect(await screen.findByText('Checking whether this repo may leave this Mac…')).toBeInTheDocument();
  });

  it('Auto off: every message is sent where the chat is', async () => {
    stubFetch();
    saveAutoPref('vs_1', 'off');
    const { intercept } = renderBar('anything');
    expect(screen.getByRole('combobox', { name: 'Auto seat' })).toHaveDisplayValue('Auto off');
    await expect(intercept('anything')).resolves.toBe('send-here');
  });

  const HARD: PromptClassification = { kind: 'plan', task: 'plan', difficulty: 'high', size: 'small', estTokens: 7, label: 'architecture planning', signals: [], decidedBy: 'jev', confidence: 0.93, needsFrontier: 0.9 };

  it('a label that would MOVE the message somewhere not on screen holds it and says where', async () => {
    stubFetch();
    seedVerseSession('vs_1', session({ id: 'vs_1', seatId: LOCAL_SEAT.id, engine: 'local', model: 'qwen3-coder', turnCount: 0 }), []);
    let interceptor: SendInterceptor | null = null;
    render(<MultiModelBar sessionId="vs_1" seats={[CLAUDE_SEAT, LOCAL_SEAT]} text="what does this regex match?" running={false}
      registerInterceptor={(fn) => { interceptor = fn; }} onConsumeDraft={vi.fn()} />);
    await screen.findByText(/^Staying on Qwen3 Coder \(local\)/);
    label = HARD;
    let route: string | undefined;
    await act(async () => { route = await interceptor!('what does this regex match?'); });
    expect(route).toBe('held');
    expect(await screen.findByRole('status')).toHaveTextContent('Claude Max — architecture planning needs the strongest model; no usage reading. Press Send again to go there, or pick another seat.');
    expect(screen.getByRole('combobox', { name: 'Send this message to' })).toHaveDisplayValue('Claude Max — no usage reading');
  });

  it('a label that says "stay" is the safe direction: said, then sent here', async () => {
    stubFetch();
    const { intercept } = renderBar('what does this regex match?');
    await screen.findByText(/free and private on this Mac/);
    label = HARD;
    let route: string | undefined;
    await act(async () => { route = await intercept('what does this regex match?'); });
    expect(route).toBe('send-here');
    expect(await screen.findByRole('status')).toHaveTextContent('Read as architecture planning (Jev), so it stays on Claude Max.');
  });

  it('staying on the chat seat sends here; the override select pins a seat for this message', async () => {
    stubFetch();
    const user = userEvent.setup();
    const { intercept } = renderBar('refactor the concurrency model across @a.ts and @b.ts', 3);
    await screen.findByText(/^Staying on Claude Max — hard refactor needs the strongest model/);
    await expect(intercept('refactor the concurrency model across @a.ts and @b.ts')).resolves.toBe('send-here');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Send this message to' }), LOCAL_SEAT.id);
    await waitFor(() => expect(screen.getByText(/you picked it for this message/)).toBeInTheDocument());
  });
});

describe('toAdvisorSeats', () => {
  it('drops unavailable and model-less seats; "private" only when the server said loopback', () => {
    const noModel = { ...LOCAL_SEAT, id: 'local:none', models: [{ id: 'x', label: 'x', contextWindow: null, unavailableReason: 'too old' }] };
    const down = { ...CLAUDE_SEAT, id: 'down', health: { ...CLAUDE_SEAT.health, state: 'unavailable' as const } };
    const seats = toAdvisorSeats([CLAUDE_SEAT, LOCAL_SEAT, noModel, down], CONTEXT.local);
    expect(seats.map((s) => [s.seatId, s.local, s.private])).toEqual([['claude-main', false, false], [LOCAL_SEAT.id, true, true]]);
    expect(toAdvisorSeats([LOCAL_SEAT], []).map((s) => s.private)).toEqual([false]);
  });
});
