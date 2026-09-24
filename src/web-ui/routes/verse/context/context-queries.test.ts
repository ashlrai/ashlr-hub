/**
 * context-queries.test.ts — the wire contract of every V3.9 context call:
 * path, method, body, which header proves what, and what a refusal becomes.
 *
 * Pinned at fetch so a route-shape drift between this file and verse-api.ts
 * fails here, with the exact request, rather than as a vague UI error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { ApiError, DispatchDisabledError } from '../../../data/client.js';
import { VerseMutationLockedError } from '../verse-queries.js';
import { describeContextError } from './use-token-gate.js';
import { getVerseSessionState, resetVerseStore } from '../verse-store.js';
import {
  contextFitPath,
  createHandoffSession,
  fetchContextFit,
  fetchHandoffPreview,
  fetchPreferences,
  fetchProjectMemory,
  HANDOFF_FOCUS_MAX_CHARS,
  searchSessions,
  setSessionContextMode,
  updatePreferences,
  verseContextFitQuery,
  versePreferencesQuery,
  verseProjectMemoryQuery,
  writeProjectMemory,
} from './context-queries.js';
import { contextSession, installFetch, json, memoryRecord, preferences, TEST_TOKEN } from './context-fixtures.test-support.js';

beforeEach(() => {
  setMutationToken(TEST_TOKEN);
  resetVerseStore();
});

afterEach(() => {
  clearMutationToken();
  vi.unstubAllGlobals();
});

describe('writes carry the mutation token and refuse without one', () => {
  it('switches the context mode, and the store moves on the response', async () => {
    const updated = contextSession({ contextMode: 'expansive' });
    const { calls } = installFetch(() => json(updated));
    const result = await setSessionContextMode('vs_src', 'expansive');
    expect(result.contextMode).toBe('expansive');
    expect(calls[0]).toMatchObject({ path: '/api/verse/sessions/vs_src/context-mode', method: 'POST', body: { mode: 'expansive' } });
    expect(calls[0]!.headers['x-ashlr-token']).toBe(TEST_TOKEN);
    expect(getVerseSessionState('vs_src').session?.contextMode).toBe('expansive');
  });

  it('encodes a session id that is not path-safe', async () => {
    const { calls } = installFetch(() => json(contextSession({ id: 'a/b' })));
    await setSessionContextMode('a/b', 'standard');
    expect(calls[0]!.path).toBe('/api/verse/sessions/a%2Fb/context-mode');
  });

  it('throws the SAME locked error ChatSection recognises, without a request', async () => {
    clearMutationToken();
    const { calls } = installFetch(() => json({}));
    await expect(setSessionContextMode('vs_src', 'standard')).rejects.toBeInstanceOf(VerseMutationLockedError);
    await expect(writeProjectMemory('/p', 'x')).rejects.toBeInstanceOf(VerseMutationLockedError);
    await expect(fetchHandoffPreview('vs_src')).rejects.toBeInstanceOf(VerseMutationLockedError);
    expect(calls).toHaveLength(0);
  });

  it('turns the dispatch gate’s codeless 404 on a write into the dispatch-disabled error', async () => {
    installFetch(() => json({ error: 'not found' }, 404));
    const err = await updatePreferences({ memoryEnabled: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DispatchDisabledError);
    expect(describeContextError(err)).toBe('This server is read-only (started without dispatch — run `ashlr verse`), or older than this console.');
  });

  it('keeps "session not found" a coded ApiError — a deleted chat is not a read-only server', async () => {
    installFetch(() => json({ code: 'VERSE_SESSION_NOT_FOUND', error: 'session not found: vs_gone' }, 404));
    for (const call of [() => setSessionContextMode('vs_gone', 'expansive'), () => fetchHandoffPreview('vs_gone')]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err).not.toBeInstanceOf(DispatchDisabledError);
      expect(err).toMatchObject({ status: 404, code: 'VERSE_SESSION_NOT_FOUND' });
      expect(describeContextError(err)).toBe('This chat no longer exists on the server — it may have been deleted. Refresh the chat list.');
    }
  });
});

describe('handoff', () => {
  it('sends an empty body for the default preview', async () => {
    const { calls } = installFetch(() => json({ sourceSessionId: 'vs_src', sourceTitle: 't', text: 'x', stats: { chars: 1, estTokens: 1, turnsCovered: 1, filesTouched: 0, truncated: [] } }));
    await fetchHandoffPreview('vs_src');
    await fetchHandoffPreview('vs_src', { includeLastAssistant: false, focus: '   ' });
    expect(calls.map((c) => c.body)).toEqual([{}, {}]);
    expect(calls[0]).toMatchObject({ path: '/api/verse/sessions/vs_src/handoff-preview', method: 'POST' });
  });

  it('sends only the keys that carry a value, focus trimmed and capped', async () => {
    const { calls } = installFetch(() => json({}));
    await fetchHandoffPreview('vs_src', { includeLastAssistant: true, focus: `  ${'f'.repeat(900)}  ` });
    const body = calls[0]!.body as { includeLastAssistant: boolean; focus: string };
    expect(Object.keys(body).sort()).toEqual(['focus', 'includeLastAssistant']);
    expect(body.includeLastAssistant).toBe(true);
    expect(body.focus).toHaveLength(HANDOFF_FOCUS_MAX_CHARS);
  });

  it('creates the continuation on the PINNED roots, never the workspace id', async () => {
    const source = contextSession({
      extraRoots: ['/Users/mason/dev/lib', '/Users/mason/dev/hub'],
      workspaceId: 'w1',
      workspaceName: 'Hub + lib',
    });
    const { calls } = installFetch(() => json(contextSession({ id: 'vs_new' }), 201));
    const created = await createHandoffSession({ source, seatId: 'codex-b', model: 'gpt-6-astra', contextMode: 'expansive', title: '  Part 2  ' });
    expect(created.id).toBe('vs_new');
    expect(calls[0]).toMatchObject({ path: '/api/verse/sessions', method: 'POST' });
    expect(calls[0]!.body).toEqual({
      projectPath: '/Users/mason/dev/hub',
      extraRoots: ['/Users/mason/dev/lib'],
      seatId: 'codex-b',
      model: 'gpt-6-astra',
      contextMode: 'expansive',
      title: 'Part 2',
      handoffFromSessionId: 'vs_src',
    });
  });

  it('omits every optional field it was not given', async () => {
    const { calls } = installFetch(() => json(contextSession({ id: 'vs_new' }), 201));
    await createHandoffSession({ source: contextSession(), seatId: 'claude-a' });
    expect(calls[0]!.body).toEqual({ projectPath: '/Users/mason/dev/hub', seatId: 'claude-a', handoffFromSessionId: 'vs_src' });
  });
});

describe('reads carry the read proof and keep the server’s refusal sentence', () => {
  it('reads preferences with the read-client proof, not the mutation token', async () => {
    const { calls } = installFetch(() => json(preferences()));
    const prefs = await fetchPreferences();
    expect(prefs.memory.enabled).toBe(true);
    expect(calls[0]).toMatchObject({ path: '/api/verse/preferences', method: 'GET' });
    expect(calls[0]!.headers['x-ashlr-read-client']).toEqual(expect.any(String));
    expect(calls[0]!.headers['x-ashlr-token']).toBeUndefined();
  });

  it('surfaces a refusal as ApiError.detail', async () => {
    installFetch(() => json({ code: 'VERSE_INVALID', error: 'projectPath must be an existing directory' }, 400));
    const err = await fetchProjectMemory('/nope').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).detail).toBe('projectPath must be an existing directory');
  });

  it('keeps the status when the body is not JSON', async () => {
    installFetch(() => new Response('boom', { status: 502 }));
    const err = (await searchSessions('retry').catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(502);
    expect(err.detail).toBeNull();
  });

  it('reports an expired read session as 401', async () => {
    installFetch(() => new Response(null, { status: 401 }));
    const err = (await fetchPreferences().catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
  });

  it('encodes the memory project path as a query parameter', async () => {
    const { calls } = installFetch(() => json(memoryRecord()));
    await fetchProjectMemory('/Users/mason/dev/my repo & co');
    expect(calls[0]!.path).toBe('/api/verse/memory?projectPath=%2FUsers%2Fmason%2Fdev%2Fmy+repo+%26+co');
  });

  it('writes memory with the exact body the route validates', async () => {
    const { calls } = installFetch(() => json(memoryRecord({ content: '' })));
    await writeProjectMemory('/Users/mason/dev/hub', '');
    expect(calls[0]).toMatchObject({ path: '/api/verse/memory', method: 'POST', body: { projectPath: '/Users/mason/dev/hub', content: '' } });
  });

  it('sends each preference form verbatim', async () => {
    const { calls } = installFetch(() => json(preferences()));
    await updatePreferences({ seatId: 'claude-a', contextMode: 'expansive' });
    await updatePreferences({ projectPath: '/p', memoryEnabled: false });
    await updatePreferences({ memoryEnabled: true });
    expect(calls.map((c) => c.body)).toEqual([
      { seatId: 'claude-a', contextMode: 'expansive' },
      { projectPath: '/p', memoryEnabled: false },
      { memoryEnabled: true },
    ]);
  });
});

describe('search', () => {
  it('encodes the query and clamps the limit to the server cap', async () => {
    const { calls } = installFetch(() => json({ query: 'q', hits: [], scannedSessions: 0, truncated: false }));
    await searchSessions('retry policy');
    await searchSessions('a&b', 500);
    await searchSessions('x y', 0);
    expect(calls.map((c) => c.path)).toEqual([
      '/api/verse/search?q=retry+policy',
      '/api/verse/search?q=a%26b&limit=50',
      '/api/verse/search?q=x+y&limit=1',
    ]);
  });

  it('passes the abort signal through', async () => {
    const { fetch } = installFetch(() => json({ query: 'q', hits: [], scannedSessions: 0, truncated: false }));
    const controller = new AbortController();
    await searchSessions('retry', 10, controller.signal);
    expect((fetch.mock.calls[0]![1] as RequestInit).signal).toBe(controller.signal);
  });
});

describe('context fit', () => {
  it('asks by workspace id alone', () => {
    expect(contextFitPath({ workspaceId: 'w 1' })).toBe('/api/verse/context-fit?workspaceId=w+1');
  });

  it('repeats extraRoots so a path with a comma survives', () => {
    expect(contextFitPath({ projectPath: '/a', extraRoots: ['/b,c', ' ', '/d'] }))
      .toBe('/api/verse/context-fit?projectPath=%2Fa&extraRoots=%2Fb%2Cc&extraRoots=%2Fd');
    const params = new URL(`http://x${contextFitPath({ projectPath: '/a', extraRoots: ['/b,c', '/d'] })}`).searchParams;
    expect(params.getAll('extraRoots')).toEqual(['/b,c', '/d']);
  });

  it('refuses the two spellings mixed, and neither', () => {
    expect(() => contextFitPath({ workspaceId: 'w', projectPath: '/a' })).toThrow(/not both/);
    expect(() => contextFitPath({ workspaceId: 'w', extraRoots: ['/b'] })).toThrow(/not both/);
    expect(() => contextFitPath({})).toThrow(/Pick a project/);
  });

  it('fetches through the same path, and keys the cache by it', async () => {
    const fit = { roots: [], totalEstTokens: 0, estimator: 'bytes/4', sampledAt: '2026-09-23T00:00:00.000Z' };
    const { calls } = installFetch(() => json(fit));
    await fetchContextFit({ projectPath: '/a' });
    expect(calls[0]!.path).toBe('/api/verse/context-fit?projectPath=%2Fa');
    expect(verseContextFitQuery({ projectPath: '/a' }).key).toBe('verse-context-fit:/api/verse/context-fit?projectPath=%2Fa');
  });
});

describe('query definitions', () => {
  it('keys memory per project and preferences once', () => {
    expect(verseProjectMemoryQuery('/a').key).toBe('verse-memory:/a');
    expect(verseProjectMemoryQuery('/b').key).not.toBe(verseProjectMemoryQuery('/a').key);
    expect(versePreferencesQuery.key).toBe('verse-preferences');
  });
});
