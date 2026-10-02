import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { CLAUDE_SEAT, verseFetch } from '../fixtures.test-support.js';
import { loadAutoPref } from '../multimodel/useAutoSeat.js';
import { VerseMutationLockedError } from '../verse-queries.js';
import { resetVerseStore } from '../verse-store.js';
import { resetVerseUi } from '../verse-ui-store.js';
import { forgetComposerMemory, loadDraft, loadHistory } from './composer-memory.js';
import { startChat } from './start-chat.js';

const request = { seatId: CLAUDE_SEAT.id, model: 'claude-sonnet-5', projectPath: '/repo' };
const createdIds = new Set<string>();
beforeEach(() => {
  localStorage.clear();
  evictAll();
  resetVerseStore();
  resetVerseUi();
  setMutationToken('b'.repeat(64));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const id of createdIds) forgetComposerMemory(id);
  createdIds.clear();
  clearMutationToken();
  vi.unstubAllGlobals();
});

describe('on-demand initial chat orchestration against the ordinary API', () => {
  it('cannot create a session or send a prompt without the mutation token', async () => {
    const { fetch } = verseFetch();
    vi.stubGlobal('fetch', fetch);
    clearMutationToken();
    await expect(startChat(request, 'Explain this code', { automatic: true })).rejects.toBeInstanceOf(VerseMutationLockedError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('creates a blank manual chat without issuing a turn or privacy read', async () => {
    const { fetch, state } = verseFetch();
    vi.stubGlobal('fetch', fetch);
    const result = await startChat(request, undefined, { automatic: false });
    createdIds.add(result.session.id);
    expect(result.firstTurn.ok).toBe(true);
    expect(loadAutoPref(result.session.id)).toBe('off');
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]).toMatchObject({ path: '/api/verse/sessions', method: 'POST', body: request });
  });

  it('records a successful first turn once and clears its draft', async () => {
    const { fetch, state } = verseFetch();
    vi.stubGlobal('fetch', fetch);
    const message = 'Explain the navigation';
    const result = await startChat(request, message, { automatic: false });
    createdIds.add(result.session.id);
    expect(result.firstTurn.ok).toBe(true);
    expect(loadDraft(result.session.id)).toBe('');
    expect(loadHistory(result.session.id)).toEqual([message]);
    expect(state.calls.filter((call) => call.path.endsWith('/turns'))).toHaveLength(1);
  });

  it('retains a failed turn in memory when browser storage rejects writes, without retrying', async () => {
    const base = verseFetch();
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/turns')) return Response.json({ error: 'Provider unavailable' }, { status: 503 });
      return (base.fetch as unknown as typeof globalThis.fetch)(input, init);
    });
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    const message = 'Preserve this first message';
    const result = await startChat(request, message, { automatic: false });
    createdIds.add(result.session.id);
    expect(result.firstTurn.ok).toBe(false);
    expect(loadDraft(result.session.id)).toBe(message);
    expect(loadHistory(result.session.id)).toEqual([]);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/turns'))).toHaveLength(1);
    expect(base.state.calls.filter((call) => call.path === '/api/verse/sessions')).toHaveLength(1);
  });
});
