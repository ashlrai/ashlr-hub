/**
 * composer-memory.ts was split out of composer-state.ts so the chat
 * first-paint path (Chat section delete, auth-store logout) can forget and
 * clear the composer's memory without the cost estimator and context-math.
 * composer-state re-exports it: both entry points must be the same functions
 * over the same storage.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as memory from './composer-memory.js';
import * as state from './composer-state.js';

beforeEach(() => localStorage.clear());

describe('composer memory split', () => {
  it('composer-state re-exports the very same memory functions and keys', () => {
    expect(state.loadDraft).toBe(memory.loadDraft);
    expect(state.saveDraft).toBe(memory.saveDraft);
    expect(state.loadHistory).toBe(memory.loadHistory);
    expect(state.pushHistory).toBe(memory.pushHistory);
    expect(state.forgetComposerMemory).toBe(memory.forgetComposerMemory);
    expect(state.clearComposerMemory).toBe(memory.clearComposerMemory);
    expect(state.VERSE_DRAFT_STORAGE_KEY).toBe(memory.VERSE_DRAFT_STORAGE_KEY);
    expect(state.VERSE_SENT_STORAGE_KEY).toBe(memory.VERSE_SENT_STORAGE_KEY);
  });

  it('forgetting through composer-memory forgets what composer-state saved', () => {
    state.saveDraft('vs_1', 'half a thought');
    state.pushHistory('vs_1', 'sent');
    memory.forgetComposerMemory('vs_1');
    expect(state.loadDraft('vs_1')).toBe('');
    expect(state.loadHistory('vs_1')).toEqual([]);
  });
});
