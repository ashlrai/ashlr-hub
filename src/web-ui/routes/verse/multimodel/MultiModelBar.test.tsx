/**
 * multimodel/MultiModelBar.test.tsx — the line above the composer: the Auto
 * choice in one line (only after the privacy check answered), the local
 * badge, the override, and the send interceptor's promises — Auto off sends
 * here, staying sends here, and a once-per-send label that CHANGES the seat
 * continues through the ordinary handoff flow without a second Send.
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
import { saveAutoPref, loadAutoPref, toAdvisorSeats } from './useAutoSeat.js';
import { DEFAULT_FLOW_API } from './multimodel-flows.js';

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

/** Exercise the real routeMessage composition with in-memory ordinary routes. */
function stubFlow(seat = CLAUDE_SEAT) {
  const created = session({ id: 'vs_auto', seatId: seat.id, engine: seat.engine, model: seat.models[0]!.id, turnCount: 0 });
  return {
    create: vi.spyOn(DEFAULT_FLOW_API, 'createSession').mockResolvedValue(created),
    handoff: vi.spyOn(DEFAULT_FLOW_API, 'createHandoffSession').mockResolvedValue(created),
    preview: vi.spyOn(DEFAULT_FLOW_API, 'fetchHandoffPreview').mockResolvedValue({
      sourceSessionId: 'vs_1', sourceTitle: 'Existing chat', text: 'CONTEXT NOTE',
      stats: { chars: 12, estTokens: 3, turnsCovered: 3, filesTouched: 2, truncated: [] },
    }),
    send: vi.spyOn(DEFAULT_FLOW_API, 'sendTurn').mockResolvedValue({}),
    outcome: vi.spyOn(DEFAULT_FLOW_API, 'outcome').mockResolvedValue(true),
    open: vi.spyOn(DEFAULT_FLOW_API, 'open').mockImplementation(() => {}),
  };
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
    expect(screen.getByText(/On this Mac · private · 66k ctx · 43 tok\/s · age unavailable/)).toBeInTheDocument();
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

  it('a changed Auto label sends once on its final seat without pinning or a second Send', async () => {
    stubFetch();
    const flow = stubFlow();
    seedVerseSession('vs_1', session({ id: 'vs_1', seatId: LOCAL_SEAT.id, engine: 'local', model: 'qwen3-coder', turnCount: 0 }), []);
    let interceptor: SendInterceptor | null = null;
    render(<MultiModelBar sessionId="vs_1" seats={[CLAUDE_SEAT, LOCAL_SEAT]} text="what does this regex match?" running={false}
      registerInterceptor={(fn) => { interceptor = fn; }} onConsumeDraft={vi.fn()} />);
    await screen.findByText(/^Staying on Qwen3 Coder \(local\)/);
    label = HARD;
    let route: string | undefined;
    await act(async () => { route = await interceptor!('what does this regex match?'); });
    expect(route).toBe('handled');
    expect(flow.create).toHaveBeenCalledTimes(1);
    expect(flow.create).toHaveBeenCalledWith(expect.objectContaining({ seatId: CLAUDE_SEAT.id, model: 'claude-opus-5' }));
    expect(flow.preview).not.toHaveBeenCalled();
    expect(flow.handoff).not.toHaveBeenCalled();
    expect(flow.send).toHaveBeenCalledExactlyOnceWith('vs_auto', 'what does this regex match?');
    expect(flow.open).toHaveBeenCalledExactlyOnceWith('vs_auto');
    expect(flow.outcome).toHaveBeenCalledWith(expect.objectContaining({ signal: 'auto-followed' }));
    expect(flow.outcome).not.toHaveBeenCalledWith(expect.objectContaining({ signal: 'auto-overridden' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Sending to Claude Max…');
    expect(screen.getByRole('combobox', { name: 'Send this message to' })).toHaveValue('auto');
    expect(loadAutoPref('vs_auto')).toBe('auto');
    const labels = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => String(url).includes('/multimodel/label'));
    expect(labels).toHaveLength(1);
  });

  it('a changed Auto label mid-thread carries context through one handoff and one turn', async () => {
    stubFetch();
    const flow = stubFlow();
    const source = session({ id: 'vs_1', seatId: LOCAL_SEAT.id, engine: 'local', model: 'qwen3-coder',
      turnCount: 3, projectPath: '/repo', extraRoots: ['/repo', '/lib'] });
    seedVerseSession('vs_1', source, []);
    let interceptor: SendInterceptor | null = null;
    render(<MultiModelBar sessionId="vs_1" seats={[CLAUDE_SEAT, LOCAL_SEAT]} text="what does this regex match?" running={false}
      registerInterceptor={(fn) => { interceptor = fn; }} onConsumeDraft={vi.fn()} />);
    await screen.findByText(/^Staying on Qwen3 Coder/);
    // The final label needs more context than this local model can hold.
    label = { ...HARD, estTokens: 80_000 };
    await act(async () => { expect(await interceptor!('what does this regex match?')).toBe('handled'); });
    expect(flow.create).not.toHaveBeenCalled();
    expect(flow.preview).toHaveBeenCalledExactlyOnceWith('vs_1');
    expect(flow.handoff).toHaveBeenCalledExactlyOnceWith({ source, seatId: CLAUDE_SEAT.id, model: 'claude-opus-5' });
    expect(flow.send).toHaveBeenCalledExactlyOnceWith('vs_auto', 'CONTEXT NOTE\n\n---\n\nThe request to answer now:\n\nwhat does this regex match?');
    expect(flow.open).toHaveBeenCalledExactlyOnceWith('vs_auto');
  });

  it('unavailable labelling uses the rules choice in the same send', async () => {
    stubFetch(); // label endpoint fails; no second send and no provider fallback.
    const flow = stubFlow(LOCAL_SEAT);
    const { intercept } = renderBar('what does this regex match?');
    await screen.findByText(/free and private on this Mac/);
    await act(async () => { expect(await intercept('what does this regex match?')).toBe('handled'); });
    expect(flow.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ seatId: LOCAL_SEAT.id, model: 'qwen3-coder' }));
    expect(flow.send).toHaveBeenCalledExactlyOnceWith('vs_auto', 'what does this regex match?');
  });

  it('a local Auto reroute preserves Cheap-first on the created chat', async () => {
    stubFetch();
    const flow = stubFlow(LOCAL_SEAT);
    saveAutoPref('vs_1', 'cheap-first');
    const { intercept } = renderBar('what does this regex match?');
    await screen.findByText(/local drafts first/);
    await act(async () => { expect(await intercept('what does this regex match?')).toBe('handled'); });
    expect(flow.create).toHaveBeenCalledTimes(1);
    expect(flow.send).toHaveBeenCalledTimes(1);
    expect(loadAutoPref('vs_auto')).toBe('cheap-first');
  });

  it('an explicit local pin remains on the current seat when Jev recommends a frontier seat', async () => {
    stubFetch();
    const flow = stubFlow();
    const user = userEvent.setup();
    seedVerseSession('vs_1', session({ id: 'vs_1', seatId: LOCAL_SEAT.id, engine: 'local', model: 'qwen3-coder' }), []);
    let interceptor: SendInterceptor | null = null;
    render(<MultiModelBar sessionId="vs_1" seats={[CLAUDE_SEAT, LOCAL_SEAT]} text="what does this regex match?" running={false}
      registerInterceptor={(fn) => { interceptor = fn; }} onConsumeDraft={vi.fn()} />);
    await screen.findByText(/^Staying on Qwen3 Coder/);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Send this message to' }), LOCAL_SEAT.id);
    label = HARD;
    await act(async () => { expect(await interceptor!('what does this regex match?')).toBe('send-here'); });
    expect(screen.getByRole('combobox', { name: 'Send this message to' })).toHaveValue(LOCAL_SEAT.id);
    expect(flow.create).not.toHaveBeenCalled();
    expect(flow.handoff).not.toHaveBeenCalled();
    expect(flow.send).not.toHaveBeenCalled();
  });

  it('a local-only chat never reroutes off this Mac when Jev recommends frontier work', async () => {
    stubFetch({ ...CONTEXT, localOnly: { on: true, reason: 'This repo stays on this Mac.' } });
    const flow = stubFlow();
    seedVerseSession('vs_1', session({ id: 'vs_1', seatId: LOCAL_SEAT.id, engine: 'local', model: 'qwen3-coder' }), []);
    let interceptor: SendInterceptor | null = null;
    render(<MultiModelBar sessionId="vs_1" seats={[CLAUDE_SEAT, LOCAL_SEAT]} text="what does this regex match?" running={false}
      registerInterceptor={(fn) => { interceptor = fn; }} onConsumeDraft={vi.fn()} />);
    await screen.findByText('Local-only repo');
    label = HARD;
    await act(async () => { expect(await interceptor!('what does this regex match?')).toBe('send-here'); });
    expect(flow.create).not.toHaveBeenCalled();
    expect(flow.handoff).not.toHaveBeenCalled();
    expect(flow.send).not.toHaveBeenCalled();
    const remote = screen.getAllByRole('option').find((option) => (option as HTMLOptionElement).value === CLAUDE_SEAT.id);
    expect(remote).toBeUndefined();
  });

  it('a failed Auto handoff holds the draft instead of sending on the original seat', async () => {
    stubFetch();
    const flow = stubFlow(LOCAL_SEAT);
    flow.send.mockRejectedValueOnce(new Error('seat-not-ready'));
    const consume = vi.fn();
    seedVerseSession('vs_1', session({ id: 'vs_1', turnCount: 0 }), []);
    let interceptor: SendInterceptor | null = null;
    render(<MultiModelBar sessionId="vs_1" seats={[CLAUDE_SEAT, LOCAL_SEAT]} text="what does this regex match?" running={false}
      registerInterceptor={(fn) => { interceptor = fn; }} onConsumeDraft={consume} />);
    await screen.findByText(/free and private on this Mac/);
    await act(async () => { expect(await interceptor!('what does this regex match?')).toBe('held'); });
    expect(flow.send).toHaveBeenCalledTimes(1);
    expect(flow.open).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent('Your message is still here.');
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


describe('explicit Manager mode', () => {
  it('opts in without a model choice, saves the message once, and never calls native routing or classification', async () => {
    saveAutoPref('vs_1', 'manager'); const flow = stubFlow();
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('/outcomes/session/')) return Response.json({ sourceState: 'unlinked', association: null });
      if (String(url).includes('/outcomes/interactive')) {
        const input = JSON.parse(String(init?.body)); posts.push(input);
        return Response.json({ sourceState: 'healthy', association: { outcomeId: input.outcomeId, revision: 3, scopeRevision: 1, paused: false, terminalStageIds: [], manager: { sourceState: 'healthy', enabled: true, mode: 'interactive', sessionId: 'vs_1', conversationRevision: 1, running: null, next: null, latest: null } } }, { status: 202 });
      }
      return new Response('unused', { status: 404 });
    }));
    const { intercept } = renderBar('Improve this work');
    expect(screen.getByRole('combobox', { name: 'Auto seat' })).toHaveDisplayValue('Manager');
    await act(async () => { expect(await intercept('Improve this work')).toBe('handled'); });
    expect(posts).toHaveLength(1); expect(posts[0]?.text).toBe('Improve this work');
    expect(flow.send).not.toHaveBeenCalled(); expect(flow.handoff).not.toHaveBeenCalled(); expect(flow.create).not.toHaveBeenCalled();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some(([url]) => String(url).includes('/multimodel/label'))).toBe(false);
  });
  it('keeps a failed manager send held with a retry control instead of native fallback', async () => {
    saveAutoPref('vs_1', 'manager');
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => String(url).includes('/outcomes/session/')
      ? Response.json({ sourceState: 'unlinked', association: null }) : new Response('unavailable', { status: 503 })));
    const { intercept } = renderBar('Preserve this draft');
    await act(async () => { expect(await intercept('Preserve this draft')).toBe('held'); });
    expect(await screen.findByRole('button', { name: 'Retry saved message' })).toBeInTheDocument();
  });
});


describe('local speed evidence readout', () => {
  it('uses two significant figures and original age/scope without displaying runtime readiness', async () => {
    const { localSpeedReadout, localSpeedCompactReadout, localWarmReadout } = await import('./local-speed-readout.js');
    const badge = { ...CONTEXT.local[0]!, tokPerSec: 41.234567, tokPerSecObservedAt: '2026-10-07T00:00:00Z', tokPerSecScope: 'turn-end-to-end' as const };
    expect(localSpeedCompactReadout(badge, '2026-10-07T02:00:00Z')).toBe('41 tok/s · 2 h ago');
    expect(localSpeedReadout(badge, '2026-10-07T02:00:00Z')).toBe('41 tok/s · last turn, end to end · 2 h ago');
    expect(localSpeedReadout({ ...badge, tokPerSecObservedAt: null }, '2026-10-07T02:00:00Z')).toContain('age unavailable');
    expect(localSpeedReadout({ ...badge, tokPerSec: Infinity }, '2026-10-07T02:00:00Z')).toBe('speed not measured yet');
    expect(localSpeedReadout({ ...badge, tokPerSecScope: 'warm-decode' }, '2026-10-07T00:00:20Z')).toContain('warm-up decode · just measured');
    expect(localSpeedReadout({ ...badge, tokPerSecScope: 'warm-end-to-end' }, '2026-10-07T00:00:20Z')).toContain('warm-up, end to end');
    expect(localWarmReadout({ seatId: 'local', ok: true, ms: 2000, loadMs: 1234.567, tokPerSec: 123.456, tokPerSecScope: 'warm-end-to-end', error: null })).toBe('Warm — 120 tok/s (end to end), loaded in 1.2 s.');
  });
});


it('renders the new-chat local badge with the measured age and scope', async () => {
  const { LocalSeatBadge } = await import('./LocalSeatBadge.js');
  stubFetch({ ...CONTEXT, sampledAt: '2026-10-07T02:00:00Z', local: [{ ...CONTEXT.local[0]!, tokPerSec: 41.234567,
    tokPerSecObservedAt: '2026-10-07T00:00:00Z', tokPerSecScope: 'warm-end-to-end' }] });
  render(<LocalSeatBadge seatId={LOCAL_SEAT.id} projectPath="/repo" />);
  expect(await screen.findByText('41 tok/s · warm-up, end to end · 2 h ago')).toBeInTheDocument();
});
