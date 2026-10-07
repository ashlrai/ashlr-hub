import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { pendingManagerMessage, submitManagerMessage, validManagerRead, validManagerProjection } from './manager-queries.js';

const healthy = (sessionId: string, outcomeId: string) => ({ sourceState: 'healthy', association: {
  outcomeId, revision: 3, scopeRevision: 1, paused: false, terminalStageIds: [],
  manager: { sourceState: 'healthy', enabled: true, mode: 'interactive', sessionId, conversationRevision: 1, running: null, next: null, latest: null },
} });
beforeEach(() => { localStorage.clear(); setMutationToken('a'.repeat(64)); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });

describe('manager request identities', () => {
  it('retries an uncertain message with the same identities and preserves a later draft', async () => {
    const sessionId = 'manager-retry'; let fail = true;
    const posts: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('/session/')) return Response.json({ sourceState: 'unlinked', association: null });
      const input = JSON.parse(String(init?.body)); posts.push(input);
      if (fail) throw new Error('Connection lost after save');
      return Response.json(healthy(sessionId, input.outcomeId), { status: 202 });
    }));
    await expect(submitManagerMessage(sessionId, 'Original draft')).rejects.toThrow();
    const original = pendingManagerMessage(sessionId)!;
    expect(original.text).toBe('Original draft');
    await expect(submitManagerMessage(sessionId, 'Later draft')).rejects.toThrow('Retry the unconfirmed');
    expect(posts).toHaveLength(1);
    fail = false;
    await expect(submitManagerMessage(sessionId, original.text)).resolves.toMatchObject({ sourceState: 'healthy' });
    expect(posts).toEqual([original, original]);
    expect(pendingManagerMessage(sessionId)).toBeNull();
  });
  it('reuses a persisted private pending request after a new module lifetime', async () => {
    const sessionId = 'manager-persisted'; const saved = { sessionId, outcomeId: 'chat-saved', commandId: 'command-saved', messageId: 'message-saved', text: 'Saved before restart' };
    localStorage.setItem(`ashlr.verse.manager.pending.${sessionId}`, JSON.stringify(saved));
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual(saved);
      return Response.json(healthy(sessionId, saved.outcomeId), { status: 202 });
    }); vi.stubGlobal('fetch', fetch);
    await submitManagerMessage(sessionId, saved.text);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(`ashlr.verse.manager.pending.${sessionId}`)).toBeNull();
  });
  it('does not resurrect a confirmed message when storage refuses its removal', async () => {
    const sessionId = 'manager-storage-refused'; const saved = { sessionId, outcomeId: 'chat-saved', commandId: 'old-command', messageId: 'old-message', text: 'Confirmed original' };
    localStorage.setItem(`ashlr.verse.manager.pending.${sessionId}`, JSON.stringify(saved));
    const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new DOMException('blocked'); });
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('/session/')) return Response.json(healthy(sessionId, saved.outcomeId));
      const input = JSON.parse(String(init?.body)); return Response.json(healthy(sessionId, input.outcomeId), { status: 202 });
    }));
    try {
      await submitManagerMessage(sessionId, saved.text);
      expect(pendingManagerMessage(sessionId)).toBeNull();
      await expect(submitManagerMessage(sessionId, 'A new request')).resolves.toMatchObject({ sourceState: 'healthy' });
      expect(pendingManagerMessage(sessionId)).toBeNull();
    } finally { remove.mockRestore(); }
  });
  it('does not contact the host without current mutation authority', async () => {
    clearMutationToken(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(submitManagerMessage('manager-locked', 'Request')).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('refuses unknown or mismatched acceptance rather than dropping the saved request', async () => {
    const id = 'manager-unconfirmed';
    const fetch = vi.fn(async (url: RequestInfo | URL) => String(url).includes('/session/')
      ? Response.json({ sourceState: 'unlinked', association: null }) : Response.json(healthy('different-chat', 'another-outcome'), { status: 202 }));
    vi.stubGlobal('fetch', fetch);
    await expect(submitManagerMessage(id, 'Keep this')).rejects.toThrow('acceptance');
    expect(pendingManagerMessage(id)?.text).toBe('Keep this');
  });
  it.each([
    { running: {} }, { running: [] }, { running: { intent: 'plan', state: 'running', route: null } },
    { running: { intent: 'plan', state: 'running', route: { tier: 'frontier', engine: 'codex', seatId: 'seat', model: 4 } } },
    { next: {} }, { next: { intent: 'invented' } }, { latest: { intent: 'review', state: 'finished' } },
    { sourceState: 'degraded' }, { enabled: false }, { conversationRevision: -1 },
  ])('rejects malformed status data without treating it as a healthy manager: %j', patch => {
    const value = healthy('chat', 'outcome');
    expect(validManagerRead({ ...value, association: { ...value.association, manager: { ...value.association.manager, ...patch } } })).toBe(false);
  });
  it('requires paused provenance so idle never implies paused or running', () => {
    expect(validManagerRead(healthy('chat', 'outcome'))).toBe(true);
    expect(validManagerRead({ ...healthy('chat', 'outcome'), association: { ...healthy('chat', 'outcome').association, paused: undefined } })).toBe(false);
    expect(validManagerRead({ sourceState: 'degraded', association: null })).toBe(true);
  });
});


describe('shared browser manager projection', () => {
  it('admits actual resident metadata while keeping the interactive session wrapper strict', () => {
    const resident = { ...healthy('chat-1', 'work').association.manager, mode: 'resident', sessionId: null, conversationRevision: 0 };
    expect(validManagerProjection(resident)).toBe(true);
    // The core permits resident mode to retain an existing conversation association.
    expect(validManagerProjection({ ...resident, sessionId: 'chat-1' })).toBe(true);
    expect(validManagerRead({ ...healthy('chat-1', 'work'), association: { ...healthy('chat-1', 'work').association, manager: resident } })).toBe(false);
    expect(validManagerRead(healthy('chat-1', 'work'))).toBe(true);
  });
  it.each([
    { mode: 'interactive', sessionId: null }, { mode: 'unknown' }, { conversationRevision: -1 },
    { running: { intent: 'plan', state: 'succeeded', route: { engine: 'codex', tier: 'frontier', seatId: 'personal', model: 'gpt-6.1-sol' } } },
    { latest: { intent: 'review', state: 'succeeded', route: { engine: 'codex', tier: 'local', seatId: 'personal', model: 'gpt-6.1-sol' } } },
    { next: { intent: 'publish' } },
  ])('refuses a malformed consumed projection %j', changed => {
    expect(validManagerProjection({ ...healthy('chat-1', 'work').association.manager, ...changed })).toBe(false);
  });
  it('preserves unknown source state without treating it as enabled', () => {
    const degraded = { sourceState: 'degraded', enabled: false, mode: null, sessionId: null, conversationRevision: null, running: null, next: null, latest: null };
    expect(validManagerProjection(degraded)).toBe(true);
    expect(validManagerProjection({ ...degraded, enabled: true })).toBe(false);
  });
});
