import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MultimodelContext } from '../../../../core/verse/multimodel/types.js';
import { classifyPrompt } from '../../../../core/verse/multimodel/classify.js';
import { CLAUDE_SEAT, LOCAL_SEAT } from '../fixtures.test-support.js';
import { initialAutoSeat } from './initial-auto-seat.js';

const reads = vi.hoisted(() => ({ context: vi.fn(), budget: vi.fn() }));
vi.mock('./multimodel-queries.js', () => ({
  multimodelContextQuery: (scope: { projectPath: string }) => ({ fetch: (signal: AbortSignal) => reads.context(scope.projectPath, signal) }),
}));
vi.mock('../budget/budget-queries.js', () => ({ budgetQuery: { fetch: reads.budget } }));
const context: MultimodelContext = {
  learned: {}, roi: {}, localOnly: { on: false, reason: null }, sampledAt: '',
  local: [{ seatId: LOCAL_SEAT.id, model: 'qwen3-coder', state: 'unknown', contextWindow: 65_536, tokPerSec: null, tokPerSecSource: null, private: true, supportsTools: true }],
};
beforeEach(() => {
  reads.context.mockReset().mockResolvedValue(context);
  reads.budget.mockReset().mockRejectedValue(new Error('offline'));
});
function input() {
  return { text: 'Fix the login bug and add tests', roots: ['/repo', '/other'], seats: [CLAUDE_SEAT, LOCAL_SEAT], signal: new AbortController().signal,
    label: vi.fn().mockResolvedValue({ classification: classifyPrompt('Review the security diff'), fallbackReason: null }) };
}

describe('initial Automatic resource choice', () => {
  it('checks every root and uses the existing decision label/adviser despite unavailable budget metadata', async () => {
    const request = input();
    const choice = await initialAutoSeat(request);
    expect(reads.context.mock.calls.map((call) => call[0])).toEqual(['/repo', '/other']);
    expect(request.label).toHaveBeenCalledExactlyOnceWith({ text: request.text, projectPath: '/repo', contextTokens: 0 });
    expect(choice?.seatId).toBeTruthy();
    expect(choice?.model).toBeTruthy();
  });
  it('uses deterministic classification when Jev is unavailable', async () => {
    const request = input();
    request.label.mockRejectedValue(new Error('Jev unavailable'));
    expect((await initialAutoSeat(request))?.seatId).toBeTruthy();
  });
  it('keeps the prompt on this Mac when an extra root is local-only', async () => {
    reads.context.mockImplementation(async (root: string) => root === '/other'
      ? { ...context, localOnly: { on: true, reason: 'Private extra folder' } } : context);
    const request = input();
    expect((await initialAutoSeat(request))?.seatId).toBe(LOCAL_SEAT.id);
    expect(request.label).not.toHaveBeenCalled();
  });
  it('refuses routing when one folder privacy read failed', async () => {
    reads.context.mockImplementation(async (root: string) => {
      if (root === '/other') throw new Error('Privacy read unavailable');
      return context;
    });
    const request = input();
    await expect(initialAutoSeat(request)).rejects.toThrow('Privacy read unavailable');
    expect(request.label).not.toHaveBeenCalled();
  });
  it('does not claim private local capability without the server badge', async () => {
    reads.context.mockResolvedValue({ ...context, local: [], localOnly: { on: true, reason: 'Private' } });
    const request = input();
    await expect(initialAutoSeat(request)).rejects.toThrow();
    expect(request.label).not.toHaveBeenCalled();
  });
  it('starts nothing when the decision unlock was dismissed or the dialog was cancelled', async () => {
    const request = input();
    request.label.mockResolvedValue(null);
    expect(await initialAutoSeat(request)).toBeNull();
    const controller = new AbortController();
    controller.abort();
    await expect(initialAutoSeat({ ...request, signal: controller.signal })).rejects.toThrow();
    expect(request.label).toHaveBeenCalledTimes(1);
  });
});
