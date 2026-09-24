/**
 * Fixtures for the context component tests: seats carrying the V3.9 model
 * fields (budgets, expansive modes, an unrunnable model), a session factory,
 * and a tiny fetch router that records every call with its headers.
 *
 * The numbers are the real ones from docs/VERSE-CONTEXT.md, computed through
 * context-math rather than typed in, so a formula change moves the fixtures
 * with it instead of leaving them silently wrong.
 */
import { vi } from 'vitest';
import type { VerseModelOption, VerseSeat, VerseSession } from '../../../data/api-types.js';
import type { VersePreferences, VerseProjectMemory } from '../../../../core/verse/types.js';
import {
  CLAUDE_STANDARD_AUTOCOMPACT_WINDOW,
  claudeAutoCompactAt,
  codexAutoCompactAt,
  codexEffectiveWindow,
} from '../../../../core/verse/context-math.js';

const HEALTHY = { state: 'ready' as const, summary: null, windows: [], observedAt: null };

export const FABLE: VerseModelOption = {
  id: 'claude-fable-5-1',
  label: 'Fable 5.1',
  contextWindow: 1_000_000,
  autoCompactAt: claudeAutoCompactAt(1_000_000, 128_000, CLAUDE_STANDARD_AUTOCOMPACT_WINDOW),
  expansive: { contextWindow: 1_000_000, autoCompactAt: claudeAutoCompactAt(1_000_000, 128_000, null) },
  maxOutputTokens: 128_000,
  windowSource: 'cli-catalog',
  minCliVersion: null,
};

export const OPUS_55: VerseModelOption = {
  id: 'claude-opus-5-5',
  label: 'Opus 5.5',
  contextWindow: 1_000_000,
  autoCompactAt: claudeAutoCompactAt(1_000_000, 128_000, CLAUDE_STANDARD_AUTOCOMPACT_WINDOW),
  expansive: { contextWindow: 1_000_000, autoCompactAt: claudeAutoCompactAt(1_000_000, 128_000, null) },
  maxOutputTokens: 128_000,
  windowSource: 'cli-catalog',
  minCliVersion: '2.1.280',
  unavailableReason: 'needs Claude Code 2.1.280; this seat runs 2.1.257',
};

export const HAIKU: VerseModelOption = {
  id: 'claude-haiku-4-5-20251001',
  label: 'Haiku 4.5',
  contextWindow: 200_000,
  autoCompactAt: claudeAutoCompactAt(200_000, 32_000),
  maxOutputTokens: 32_000,
  windowSource: 'cli-catalog',
};

export const CLAUDE_SEAT: VerseSeat = {
  id: 'claude-a',
  engine: 'claude',
  label: 'Claude Max',
  accountId: 'claude-a',
  models: [FABLE, OPUS_55, HAIKU],
  contextWindow: 1_000_000,
  health: HEALTHY,
  cliVersion: '2.1.257',
};

export const GPT6: VerseModelOption = {
  id: 'gpt-6-astra',
  label: 'GPT-6 Astra',
  contextWindow: codexEffectiveWindow(272_000),
  autoCompactAt: codexAutoCompactAt(272_000),
  expansive: {
    contextWindow: codexEffectiveWindow(872_000),
    autoCompactAt: codexAutoCompactAt(872_000),
    providerWindow: 872_000,
  },
  windowSource: 'provider-catalog',
};

export const CODEX_SEAT: VerseSeat = {
  id: 'codex-b',
  engine: 'codex',
  label: 'Personal Codex',
  accountId: 'codex-b',
  models: [GPT6],
  contextWindow: GPT6.contextWindow,
  health: HEALTHY,
};

export const LOCAL_MODEL: VerseModelOption = {
  id: 'qwen3.8:27b-ctx64k',
  label: 'Qwen3.8 27B',
  contextWindow: 65_536,
  autoCompactAt: claudeAutoCompactAt(65_536, null),
  windowSource: 'runtime',
};

export const LOCAL_SEAT: VerseSeat = {
  id: 'local:qwen3.8:27b-ctx64k',
  engine: 'local',
  label: 'Qwen3.8 27B (local)',
  accountId: 'local',
  models: [LOCAL_MODEL],
  contextWindow: 65_536,
  health: { state: 'unknown', summary: null, windows: [], observedAt: null },
};

export const SEATS: readonly VerseSeat[] = [CLAUDE_SEAT, CODEX_SEAT, LOCAL_SEAT];

export function contextSession(over: Partial<VerseSession> = {}): VerseSession {
  return {
    id: 'vs_src',
    title: 'Migrate the billing tables',
    projectPath: '/Users/mason/dev/hub',
    engine: 'claude',
    accountId: 'claude-a',
    seatId: 'claude-a',
    model: 'claude-fable-5-1',
    nativeSessionId: 'uuid-src',
    createdAt: '2026-09-23T08:00:00.000Z',
    updatedAt: '2026-09-23T09:30:00.000Z',
    status: 'idle',
    turnCount: 14,
    usage: {
      inputTokens: 40_000,
      outputTokens: 9_000,
      cacheReadTokens: 1_200_000,
      cacheCreationTokens: 80_000,
      contextTokens: 352_000,
      contextWindow: 1_000_000,
      contextWindowSource: 'runtime',
      autoCompactAt: FABLE.autoCompactAt ?? null,
    },
    lastError: null,
    ...over,
  };
}

export function preferences(over: Partial<VersePreferences> = {}): VersePreferences {
  return { version: 1, seats: {}, memory: { enabled: true, disabledProjects: [] }, ...over };
}

export function memoryRecord(over: Partial<VerseProjectMemory> = {}): VerseProjectMemory {
  const content = over.content ?? '# Hub memory\n\n- Billing migration: use batched copies (the live table is 40M rows).\n';
  return {
    projectPath: '/Users/mason/dev/hub',
    enabled: true,
    content,
    bytes: new TextEncoder().encode(content).length,
    updatedAt: '2026-09-23T09:00:00.000Z',
    files: [],
    ...over,
  };
}

export interface RecordedCall {
  path: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

export type FetchHandler = (call: RecordedCall) => Response | Promise<Response>;

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Replace global fetch with a recorder that delegates to `handler`. Returns
 * the calls, newest last. Unhandled paths answer 404 with a JSON error, which
 * is exactly what an older server does for a route it does not have.
 */
export function installFetch(handler: FetchHandler): { calls: RecordedCall[]; fetch: ReturnType<typeof vi.fn> } {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const call = { path, method, body, headers };
    calls.push(call);
    return handler(call);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetch: fetchMock };
}

export const TEST_TOKEN = 'a'.repeat(64);
