/**
 * test/verse-session-search.test.ts — keyword search over past sessions
 * (GET /api/verse/search). Zero spend: pure function over the event log.
 *
 * Defended here:
 *  1. MATCHING. Terms are AND-ed within ONE message, case-insensitive; quoted
 *     phrases are one term; only user and assistant messages are searched.
 *  2. RANKING. Deterministic given `now`: more occurrences and a matching
 *     title help, recency decays with a floor, ties never shuffle.
 *  3. BOUNDS. ≤ 200 sessions (newest first), ≤ 20 MB of text, ≤ 50 hits,
 *     ≤ 3 hits per session — and `truncated` is honest about any cut.
 *  4. SNIPPETS. ≤ 240 chars around the match, whitespace-collapsed, scrubbed.
 */
import { describe, expect, it } from 'vitest';

import {
  VERSE_SEARCH_MAX_HITS_PER_SESSION,
  VERSE_SEARCH_MAX_LIMIT,
  VERSE_SEARCH_MAX_SESSIONS,
  VERSE_SEARCH_SNIPPET_CHARS,
  buildSnippet,
  parseSearchQuery,
  searchSessions,
} from '../src/core/verse/session-search.js';
import { VerseServiceError } from '../src/core/verse/preferences.js';
import type { VerseEvent, VerseSession } from '../src/core/verse/types.js';

const NOW = new Date('2026-09-23T12:00:00.000Z');
const now = (): Date => NOW;

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function session(id: string, overrides: Partial<VerseSession> = {}): VerseSession {
  return {
    id,
    title: `Session ${id}`,
    projectPath: `/work/${id}`,
    engine: 'claude',
    accountId: 'claude-a',
    seatId: 'claude-a',
    model: 'claude-opus-5',
    nativeSessionId: null,
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    status: 'idle',
    turnCount: 1,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      contextTokens: 0,
      contextWindow: null,
    },
    lastError: null,
    ...overrides,
  };
}

let seqCounter = 0;
function user(text: string, at = daysAgo(1)): VerseEvent {
  seqCounter += 1;
  return { seq: seqCounter, at, type: 'user-message', turnId: 't', text };
}
function assistant(text: string, at = daysAgo(1)): VerseEvent {
  seqCounter += 1;
  return { seq: seqCounter, at, type: 'assistant-message', turnId: 't', text };
}

function run(logs: Record<string, VerseEvent[]>, query: string, extra: { sessions?: VerseSession[]; limit?: number } = {}) {
  const sessions = extra.sessions ?? Object.keys(logs).map((id) => session(id));
  return searchSessions({
    sessions,
    readEvents: (id) => logs[id] ?? [],
    query,
    ...(extra.limit === undefined ? {} : { limit: extra.limit }),
    now,
  });
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(VerseServiceError);
    return (err as VerseServiceError).code;
  }
}

describe('parseSearchQuery', () => {
  it('lower-cases, splits on whitespace, keeps quoted phrases, dedupes', () => {
    expect(parseSearchQuery('  Auth   "Token Refresh"  auth BUG ')).toEqual(['auth', 'token refresh', 'bug']);
  });

  it('rejects empty, oversized and over-termed queries', () => {
    expect(codeOf(() => parseSearchQuery('   '))).toBe('VERSE_INVALID');
    expect(codeOf(() => parseSearchQuery('""'))).toBe('VERSE_INVALID');
    expect(codeOf(() => parseSearchQuery('x'.repeat(201)))).toBe('VERSE_INVALID');
    expect(codeOf(() => parseSearchQuery('a b c d e f g h i'))).toBe('VERSE_INVALID');
    expect(parseSearchQuery('a b c d e f g h')).toHaveLength(8);
  });
});

describe('matching', () => {
  it('ANDs terms within one message, case-insensitively', () => {
    const result = run({
      a: [user('Fix the MIGRATION for postgres'), assistant('The migration is done')],
      b: [user('postgres only'), user('migration only')],
    }, 'migration Postgres');
    expect(result.hits.map((h) => [h.sessionId, h.kind])).toEqual([['a', 'user']]);
    expect(result.query).toBe('migration Postgres');
    expect(result.scannedSessions).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('matches a quoted phrase only as a phrase', () => {
    const result = run({
      a: [user('the token refresh path is broken')],
      b: [user('refresh the token later')],
    }, '"token refresh"');
    expect(result.hits.map((h) => h.sessionId)).toEqual(['a']);
  });

  it('searches only user and assistant messages', () => {
    const logs: Record<string, VerseEvent[]> = {
      a: [
        { seq: 1, at: daysAgo(1), type: 'tool-result', turnId: 't', toolUseId: 'x', output: 'needle in tool output', isError: false },
        { seq: 2, at: daysAgo(1), type: 'text-delta', turnId: 't', text: 'needle delta' },
        { seq: 3, at: daysAgo(1), type: 'thinking', turnId: 't', text: 'needle thought' },
        { seq: 4, at: daysAgo(1), type: 'tool-use', turnId: 't', toolUseId: 'x', name: 'Bash', input: { command: 'grep needle' } },
        { seq: 5, at: daysAgo(1), type: 'error', turnId: 't', message: 'needle error' },
      ],
    };
    expect(run(logs, 'needle').hits).toEqual([]);
  });

  it('carries the hit identity the UI needs to open the message', () => {
    const s = session('abc', { title: 'Billing', projectPath: '/work/billing', engine: 'codex' });
    const at = daysAgo(2);
    const result = searchSessions({
      sessions: [s],
      readEvents: () => [{ seq: 42, at, type: 'assistant-message', turnId: 't', text: 'invoice totals fixed' }],
      query: 'invoice',
      now,
    });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({
      sessionId: 'abc',
      title: 'Billing',
      projectPath: '/work/billing',
      engine: 'codex',
      seq: 42,
      at,
      kind: 'assistant',
      snippet: 'invoice totals fixed',
    });
    expect(result.hits[0].score).toBeGreaterThan(0);
  });
});

describe('ranking', () => {
  it('prefers recent messages, but an old exact match is never zeroed', () => {
    const result = run({
      recent: [user('cache invalidation bug', daysAgo(0))],
      old: [user('cache invalidation bug', daysAgo(365))],
    }, 'cache invalidation');
    expect(result.hits.map((h) => h.sessionId)).toEqual(['recent', 'old']);
    expect(result.hits[1].score).toBeGreaterThan(0);
    expect(result.hits[1].score).toBeGreaterThanOrEqual(result.hits[0].score * 0.34);
  });

  it('rewards repetition with diminishing returns and a matching title', () => {
    const once = run({ a: [user('flaky test')] }, 'flaky').hits[0].score;
    const many = run({ a: [user('flaky '.repeat(40))] }, 'flaky').hits[0].score;
    expect(many).toBeGreaterThan(once);
    expect(many).toBeLessThan(once * 6);
    const titled = run({ a: [user('flaky test')] }, 'flaky', { sessions: [session('a', { title: 'Flaky CI' })] }).hits[0].score;
    expect(titled).toBeGreaterThan(once);
  });

  it('weights the operator\'s own words slightly above the agent\'s', () => {
    const result = run({ a: [assistant('deploy plan'), user('deploy plan')] }, 'deploy');
    expect(result.hits.map((h) => h.kind)).toEqual(['user', 'assistant']);
  });

  it('is deterministic for equal scores', () => {
    const logs = { b: [user('same words')], a: [user('same words')], c: [user('same words')] };
    const first = run(logs, 'same');
    const second = run(logs, 'same');
    expect(first).toEqual(second);
    expect(first.hits.map((h) => h.sessionId)).toEqual(['a', 'b', 'c']);
  });
});

describe('bounds', () => {
  it('caps hits per session so one long chat cannot fill the list', () => {
    const events = Array.from({ length: 10 }, (_, i) => user(`retry ${i}`));
    const result = run({ long: events, short: [user('retry once')] }, 'retry');
    expect(result.hits.filter((h) => h.sessionId === 'long')).toHaveLength(VERSE_SEARCH_MAX_HITS_PER_SESSION);
    expect(result.hits.some((h) => h.sessionId === 'short')).toBe(true);
  });

  it('clamps the limit to [1, 50] and defaults to 20', () => {
    const logs: Record<string, VerseEvent[]> = {};
    for (let i = 0; i < 30; i += 1) logs[`s${String(i).padStart(2, '0')}`] = [user('alpha one'), user('alpha two')];
    expect(run(logs, 'alpha').hits).toHaveLength(20);
    expect(run(logs, 'alpha', { limit: 5 }).hits).toHaveLength(5);
    expect(run(logs, 'alpha', { limit: 0 }).hits).toHaveLength(1);
    expect(run(logs, 'alpha', { limit: 999 }).hits).toHaveLength(VERSE_SEARCH_MAX_LIMIT);
    expect(run(logs, 'alpha', { limit: Number.NaN }).hits).toHaveLength(20);
  });

  it('scans only the newest 200 sessions and says so', () => {
    const sessions: VerseSession[] = [];
    const logs: Record<string, VerseEvent[]> = {};
    for (let i = 0; i < VERSE_SEARCH_MAX_SESSIONS + 5; i += 1) {
      const id = `s${i}`;
      // s0 is the OLDEST, so s0..s4 fall outside the scan.
      sessions.push(session(id, { updatedAt: new Date(NOW.getTime() - (1000 - i) * 60_000).toISOString() }));
      logs[id] = [user(`needle ${id}`)];
    }
    const result = run(logs, 'needle', { sessions, limit: 50 });
    expect(result.scannedSessions).toBe(VERSE_SEARCH_MAX_SESSIONS);
    expect(result.truncated).toBe(true);
    const ids = new Set(result.hits.map((h) => h.sessionId));
    for (let i = 0; i < 5; i += 1) expect(ids.has(`s${i}`)).toBe(false);
  });

  it('stops at the text budget and says so', () => {
    const big = 'x'.repeat(11 * 1024 * 1024);
    const sessions = ['a', 'b', 'c'].map((id, i) => session(id, { updatedAt: daysAgo(i) }));
    const result = run({ a: [user(big)], b: [user(big)], c: [user('needle')] }, 'needle', { sessions });
    expect(result.truncated).toBe(true);
    expect(result.scannedSessions).toBe(2);
    expect(result.hits).toEqual([]);
  });

  it('survives an unreadable event log', () => {
    const result = searchSessions({
      sessions: [session('bad'), session('good')],
      readEvents: (id) => {
        if (id === 'bad') throw new Error('EACCES');
        return [user('present')];
      },
      query: 'present',
      now,
    });
    expect(result.hits.map((h) => h.sessionId)).toEqual(['good']);
  });
});

describe('snippets', () => {
  it('collapses whitespace and keeps short messages whole', () => {
    expect(buildSnippet('a\n\n  b\tc', 'b')).toBe('a b c');
  });

  it('windows long messages around the first match with ellipses, ≤ 240 chars', () => {
    const text = `${'lead '.repeat(200)}THE NEEDLE HERE ${'tail '.repeat(200)}`;
    const snippet = buildSnippet(text, 'needle');
    expect(snippet.length).toBeLessThanOrEqual(VERSE_SEARCH_SNIPPET_CHARS);
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).toContain('THE NEEDLE HERE');
  });

  it('does not add a leading ellipsis for a match at the start, or trailing at the end', () => {
    const start = buildSnippet(`needle ${'x '.repeat(300)}`, 'needle');
    expect(start.startsWith('needle')).toBe(true);
    expect(start.endsWith('…')).toBe(true);
    const end = buildSnippet(`${'x '.repeat(300)}needle`, 'needle');
    expect(end.startsWith('…')).toBe(true);
    expect(end.endsWith('needle')).toBe(true);
    expect(end.length).toBeLessThanOrEqual(VERSE_SEARCH_SNIPPET_CHARS);
  });

  it('scrubs secrets from snippets', () => {
    const result = run({ a: [user('rotate the key sk-ant-api03-SECRETSECRETSECRETSECRET now')] }, 'rotate');
    expect(result.hits[0].snippet).not.toContain('SECRETSECRET');
    expect(result.hits[0].snippet).toContain('[REDACTED]');
  });
});
